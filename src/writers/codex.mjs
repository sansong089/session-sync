// writers/codex.mjs — 写 Codex CLI 原生会话
//
// 产出：<root>/sessions/YYYY/MM/DD/rollout-<ISO>-<targetId>.jsonl
// 事件：session_meta / response_item(message|reasoning|custom_tool_call|custom_tool_call_output)
// reasoning 用 "ocxr1:<base64(JSON{txt})>" 封装回写（与 Codex 自身一致，可被读侧还原）
// provenance：专用行 type="session-sync-provenance" + sidecar 兜底
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { bucketRoot } from '../hosts.mjs';
import { accountIdOf } from '../placement.mjs';
import { currentAccount } from '../accounts.mjs';
import { isFile, cmpPath as normPath } from '../util.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import { PROVENANCE_LINE_TYPE, threadsDbFile } from '../readers/codex.mjs';
import { tableColumns } from '../readers/base.mjs';
import { uuidv7 } from '../util.mjs';
import { resolveRoot, roleRoots } from '../roots.mjs';
import { newNodeId, isoOf, dateSegments, readJsonlFile, writeJsonlFile, appendJsonlRebuild, backupIfExists, findExistingByTargetId, writeFileAtomic,
  parseJsonlStrict, unreadableTarget, preflightOverwrite, writePreImage,
  outputText, updateRowFiltered } from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';

function sessionsRoot(ctx) {
  // 按 role 取，不再依赖「声明顺序第一个 dir」——归档目录也是 dir
  return roleRoots('codex', ctx, 'sessions')[0]?.path ?? null;
}

// 宿主会把历史 rollout 压成 `.jsonl.zst`（本机 350+ 个）：读写都要认这个后缀
const isZstFile = (f) => String(f ?? '').endsWith('.zst');

// 目标名带 .zst 就必须保持压缩态：把明文写进 .zst 文件名里宿主解不开（实测 --force 覆盖时踩过）
function writeTargetLines(file, lines) {
  const body = lines.map((l) => JSON.stringify(l)).join('\n');
  if (isZstFile(file)) return writeFileAtomic(file, zlib.zstdCompressSync(Buffer.from(`${body}\n`, 'utf8')));
  return writeJsonlFile(file, lines);
}

// 追加要「整帧重写」：解不开的一律当失败，不能当成空（否则重压会抹掉用户已有历史，实测 11 行变 2 行还报成功）
function readTargetLines(file) {
  if (!isFile(file)) return { ok: true, lines: [] };
  if (!isZstFile(file)) return parseJsonlStrict(fs.readFileSync(file, 'utf8'));
  try {
    return parseJsonlStrict(zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8'));
  } catch (err) {
    return { ok: false, reason: `zstd 解帧失败：${String(err?.message ?? err).slice(0, 120)}` };
  }
}

// 宿主用这个文件做侧栏分组：只写 rollout 文件的会话它一律不列（已实测）
function registryPath(ctx) {
  return path.join(path.dirname(sessionsRoot(ctx) ?? ''), '.codex-global-state.json');
}

function classifyCodexScope(session) {
  if (session?.scope === 'none' || session?.scope === 'project') return session.scope;
  return session?.meta?.hasGit ? 'project' : 'none';
}

// --account 给的是裸 id；源侧带的是 {id, accountId} —— id 的取法与 workbuddy 共用 accountIdOf
function normalizeAccount(account) {
  if (!account) return {};
  const accountId = typeof account === 'string' ? null : account.accountId ? String(account.accountId) : null;
  return { userId: accountIdOf(account), accountId };
}

/**
 * 写侧归属的取值顺序（与 workbuddy 的 pickUserId 同一套语义）：
 *   显式 --account（或编排层给的目标既有归属）→ 本机 codex 登录态（auth.json）→ 都没有就不写 creator_*
 * 绝不沿用源会话的 account：跨 agent 时它是别人家的 id（workbuddy 的 uuid、qoder 上一代库的 user_id），
 * 写进 creator_user_id 就是一行永远不会被任何账号列出的归属。
 * 取不到登录态时留空而不是猜 —— 实测宿主自己有 314/356 行 creator_* 为 NULL。
 */
function resolveAccount(ctx, account) {
  if (account) return normalizeAccount(account);
  const cur = currentAccount('codex', ctx);
  return cur ? { userId: cur.id, accountId: cur.accountId } : {};
}

/**
 * 把线程登记进宿主的注册表（读-改-写，未知键原样保留，改写前留备份）。
 * 键形全部按本机 .codex-global-state.json 实测抄录：
 *   非项目：projectless-thread-ids[id] + thread-workspace-root-hints[id]=桶根
 *          + thread-projectless-output-directories[id]=<会话目录>/outputs，且不挂 assignments
 *   项目：  thread-project-assignments[id]={projectKind:'local',projectId}
 *          + local-projects[projectId]={id,name,rootPaths,createdAt,updatedAt} + project-order
 * @returns {string[]} warnings
 */
function registerThread(ctx, { targetId, scope, cwd, account }) {
  const warnings = [];
  const file = registryPath(ctx);
  const bucket = resolveRoot('codex', ctx).bucketRoot.path;
  let st = {};
  if (fs.existsSync(file)) {
    try {
      st = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      warnings.push(`registry-unreadable: ${String(err?.message ?? err)}（未改写注册表，会话可能不被宿主列出）`);
      return warnings;
    }
  }
  backupIfExists(file, ctx, 'codex');

  const list = Array.isArray(st['projectless-thread-ids']) ? st['projectless-thread-ids'] : [];
  const hints = st['thread-workspace-root-hints'] && typeof st['thread-workspace-root-hints'] === 'object' ? st['thread-workspace-root-hints'] : {};
  const outs = st['thread-projectless-output-directories'] && typeof st['thread-projectless-output-directories'] === 'object' ? st['thread-projectless-output-directories'] : {};
  const asg = st['thread-project-assignments'] && typeof st['thread-project-assignments'] === 'object' ? st['thread-project-assignments'] : {};
  const projects = st['local-projects'] && typeof st['local-projects'] === 'object' ? st['local-projects'] : {};
  const order = Array.isArray(st['project-order']) ? st['project-order'] : [];
  if (scope === 'none') {
    if (!list.includes(targetId)) list.push(targetId);
    hints[targetId] = bucket;
    outs[targetId] = path.join(String(cwd || bucket), 'outputs');
    delete asg[targetId];
  } else {
    st['projectless-thread-ids'] = list.filter((x) => x !== targetId);
    delete hints[targetId];
    delete outs[targetId];
    const key = normPath(cwd);
    let projectId = Object.keys(projects).find((id) => (projects[id]?.rootPaths ?? []).some((r) => normPath(r) === key));
    if (!projectId) {
      projectId = uuidv7();
      const now = Date.now();
      projects[projectId] = {
        id: projectId,
        name: path.basename(String(cwd ?? '').replace(/[\\/]+$/, '')) || 'session-sync',
        rootPaths: [cwd],
        createdAt: now,
        updatedAt: now,
      };
    }
    asg[targetId] = { projectKind: 'local', projectId };
    if (!order.includes(projectId)) order.push(projectId);
    st['local-projects'] = projects;
    st['project-order'] = order;
  }

  st['projectless-thread-ids'] = scope === 'none' ? list : st['projectless-thread-ids'];
  st['thread-workspace-root-hints'] = hints;
  st['thread-projectless-output-directories'] = outs;
  st['thread-project-assignments'] = asg;
  try {
    writeFileAtomic(file, JSON.stringify(st, null, 2));
  } catch (err) {
    warnings.push(`registry-write-failed: ${String(err?.message ?? err)}`);
  }
  return warnings;
}

function encodeReasoning(text) {
  return `ocxr1:${Buffer.from(JSON.stringify({ txt: text }), 'utf8').toString('base64')}`;
}

function inputToString(input) {
  if (input == null) return '{}';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function turnToItems(turn, session) {
  const out = [];
  const pushItem = (ts, payload) => {
    flushUser();
    out.push({ ts, payload });
  };
  // 同一轮的连续用户文本块并进同一条 user message：读侧「一条含 input_text 的 user 消息 = 一轮」，
  // 逐块各发一条会把一轮拆成多轮 → 跨落点轮次数不同 → 续写误判分叉
  let userBlocks = null;
  let userTs = 0;
  function flushUser() {
    if (userBlocks && userBlocks.length) {
      out.push({ ts: userTs, payload: { type: 'message', id: newNodeId(), role: 'user', content: userBlocks } });
    }
    userBlocks = null;
  }
  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    switch (it.kind) {
      case 'message':
        if (it.text && it.role === 'user') {
          if (!userBlocks) {
            userBlocks = [];
            userTs = ts;
          }
          userBlocks.push({ type: 'input_text', text: it.text });
        } else if (it.text) {
          pushItem(ts, { type: 'message', id: newNodeId(), role: 'assistant', content: [{ type: 'output_text', text: it.text }] });
        }
        break;
      case 'reasoning':
        if (it.text) pushItem(ts, { type: 'reasoning', id: newNodeId(), summary: [], content: null, encrypted_content: encodeReasoning(it.text) });
        break;
      case 'tool_call':
        pushItem(ts, {
          type: 'custom_tool_call',
          id: newNodeId(),
          status: 'completed',
          call_id: it.callId || newNodeId(),
          name: it.name || 'tool',
          input: inputToString(it.input),
        });
        break;
      case 'tool_result':
        pushItem(ts, {
          type: 'custom_tool_call_output',
          id: newNodeId(),
          call_id: it.callId || null,
          output: [{ type: 'input_text', text: outputText(it.output) ?? '' }],
        });
        break;
      case 'attachment':
        if (it.ref) pushItem(ts, { type: 'message', id: newNodeId(), role: 'assistant', content: [{ type: 'output_text', text: `[attachment] ${it.ref}` }] });
        break;
      default:
        break;
    }
  }
  flushUser();
  return out;
}

function buildLines(session, turns, targetId, provenance, opts = {}) {
  const lines = [];
  let ordinal = 0;
  const cwd = session.cwd || '';
  const createdAt = session.createdAt || Date.now();

  const push = (ts, type, payload) => {
    lines.push({ timestamp: isoOf(ts), ordinal: ordinal++, type, ...(payload ? { payload } : {}) });
  };

  if (opts.withHeader) {
    const none = classifyCodexScope(session) === 'none';
    const acct = resolveAccount(opts.ctx, opts.account);
    push(createdAt, 'session_meta', {
      session_id: targetId,
      id: targetId,
      timestamp: isoOf(createdAt),
      cwd,
      // 实测：非项目会话完全没有 git 键，且 workspace 根是桶根（不是桶内叶子）
      runtime_workspace_roots: [none ? resolveRoot('codex', opts.ctx).bucketRoot.path : cwd],
      ...(acct.userId ? { creator_user_id: acct.userId } : {}),
      ...(acct.accountId ? { creator_account_id: acct.accountId } : {}),
      ...(!none && session.meta?.git ? { git: session.meta.git } : {}),
      ...(session.model ? { model: session.model } : {}),
    });
  }

  for (const turn of turns) {
    for (const { ts, payload } of turnToItems(turn, session)) {
      push(ts, 'response_item', payload);
    }
  }

  if (provenance) {
    // provenance 必须放顶层：读侧按 line['session-sync'] 取（与其它 JSONL 家一致）
    lines.push({ timestamp: isoOf(session.updatedAt), ordinal: ordinal++, type: PROVENANCE_LINE_TYPE, 'session-sync': provenance });
  }
  return lines;
}

export const codexWriter = {
  variant: 'codex',
  label: 'Codex CLI',

  canWrite(ctx) {
    return sessionsRoot(ctx) ? { ok: true } : { ok: false, reason: 'sessions-dir-unresolved' };
  },

  /**
   * 账号清单 = 线程库里出现过的 creator_* 组合 + 当前登录（auth.json）。
   * creator_* 为 NULL 的行是「宿主这一代根本没写归属」，单独计入 unattributed，不当成某个账号。
   */
  listAccounts(ctx) {
    const warnings = [];
    const cur = currentAccount('codex', ctx);
    if (!cur) warnings.push('auth-json-absent: 读不到 ~/.codex/auth.json，无法判定哪个是当前登录账号');
    const file = threadsDbFile(ctx);
    if (!file) return { ok: false, error: 'threads-db-absent', cur, warnings };
    let db;
    try {
      db = new DatabaseSync(file);
    } catch (err) {
      return { ok: false, error: `threads-db-open-failed: ${err?.message ?? err}`, cur, warnings };
    }
    try {
      const cols = tableColumns(db, 'threads');
      if (!cols.includes('creator_user_id')) return { ok: false, error: 'threads-creator-columns-absent', cur, warnings };
      const rows = db
        .prepare("SELECT creator_user_id u, creator_account_id a, COUNT(*) n FROM threads WHERE creator_user_id IS NOT NULL AND creator_user_id <> '' GROUP BY 1,2 ORDER BY n DESC")
        .all();
      const unattributed = db.prepare("SELECT COUNT(*) c FROM threads WHERE creator_user_id IS NULL OR creator_user_id = ''").get().c;
      if (unattributed) warnings.push(`creator-unattributed: ${unattributed} 行没有 creator_user_id（实测本机 314/356），这些行切不到任何账号`);
      return {
        ok: true,
        current: cur,
        accounts: rows.map((r) => ({
          id: String(r.u),
          accountId: r.a ? String(r.a) : null,
          threads: Number(r.n),
          isCurrent: !!cur && (String(r.u) === String(cur.id ?? '') || (cur.accountId ? String(r.a ?? '') === String(cur.accountId) : false)),
        })),
        warnings,
      };
    } catch (err) {
      return { ok: false, error: `list-accounts-failed: ${err?.message ?? err}`, cur, warnings };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  },

  /**
   * 切账号 = 同时翻两处：rollout 首行 session_meta 的 creator_*，与线程库 threads 的两列。
   * 缺一处就会出现「库对了宿主看不到」或反之（导入路径同样要求两处一起写，见 relocate）。
   * 注册表 .codex-global-state.json 按安装共享、与账号无关 → 这里**不碰**它，
   * 免得把一个只改归属的操作顺带改写线程的项目归属。
   */
  switchAccount(ctx, { targetId, account, onlyImported = false } = {}) {
    const warnings = [];
    const acct = normalizeAccount(account);
    if (!acct.userId && !acct.accountId) {
      return { ok: false, action: 'refused', error: `account-unusable: 目标账户里没有可用的 id（${JSON.stringify(account ?? null).slice(0, 80)}）；--account <creator_user_id>，org/账户 id 用 <uid>#<account_id> 形式带上` };
    }
    const id = String(targetId);
    const root = sessionsRoot(ctx);
    const file = root ? findExistingByTargetId(root, id) : null;
    if (!file) return { ok: false, action: 'not-found', error: `rollout-not-found: 在 ${root ?? '(sessions 根未解析)'} 里找不到 ${id}` };

    const prev = readTargetLines(file);
    if (!prev.ok) return { ok: false, action: 'refused', error: unreadableTarget(file, prev.reason), path: file };
    const lines = prev.lines;
    const meta = lines.find((l) => l.type === 'session_meta');
    if (!meta?.payload) return { ok: false, action: 'refused', error: 'session_meta-missing: 目标 rollout 没有头行，无法改写归属字段', path: file };

    const before = { creator_user_id: meta.payload.creator_user_id ?? null, creator_account_id: meta.payload.creator_account_id ?? null };
    const srcId = before.creator_user_id ? String(before.creator_user_id) : null;
    if (onlyImported && !lines.some((l) => l.type === PROVENANCE_LINE_TYPE || l['session-sync'] || l?.meta?.['session-sync'])) {
      return { ok: false, action: 'refused', error: 'not-imported-row: 该 rollout 没有 session-sync 标记，--only-imported 下不改宿主原生行', sourceAccount: srcId };
    }
    if (srcId === acct.userId && (!acct.accountId || String(before.creator_account_id ?? '') === acct.accountId)) {
      return { ok: true, action: 'already', sourceAccount: srcId, targetAccount: acct.userId, path: file, warnings };
    }
    if (!srcId) warnings.push('source-unattributed: 这条本来就没有 creator_user_id，本次是首次赋归属');
    else if (!onlyImported) warnings.push(`foreign-switch-authorized: 按点名授权把 ${id} 的 creator 归属从 ${srcId} 改到 ${acct.userId ?? acct.accountId}`);

    const backup = writePreImage(ctx, 'codex', {
      targetId: id,
      rollout: file,
      before,
    });
    if (acct.userId) meta.payload.creator_user_id = acct.userId;
    if (acct.accountId) meta.payload.creator_account_id = acct.accountId;
    else warnings.push('account-id-missing: 没带 creator_account_id，只改了 creator_user_id（两列在宿主里成对出现）');
    writeTargetLines(file, lines);

    // 线程库两列：探列后再写，缺列/缺行只告警（宿主这一代的列表谓词尚未取证，不能让它在未取证路径上硬失败）
    const dbFile = threadsDbFile(ctx);
    let threadRows = 0;
    if (dbFile) {
      try {
        const db = new DatabaseSync(dbFile);
        try {
          db.exec('PRAGMA busy_timeout = 15000');
          const cols = tableColumns(db, 'threads');
          const sets = [];
          if (acct.userId && cols.includes('creator_user_id')) sets.push(['creator_user_id', acct.userId]);
          if (acct.accountId && cols.includes('creator_account_id')) sets.push(['creator_account_id', acct.accountId]);
          if (sets.length) {
            const r = updateRowFiltered(db, 'threads', sets, { id });
            threadRows = r.changes ?? 0;
            if (!threadRows) warnings.push('state5-row-absent: 线程库里没有这一行（rollout 与库本就可能不同步），只改了 rollout');
          } else {
            warnings.push('state5-columns-absent: 线程库没有 creator_* 列，只改了 rollout');
          }
        } finally {
          db.close();
        }
      } catch (err) {
        warnings.push(`state5-write-failed: ${String(err?.message ?? err)}（rollout 已改，库里两列没改）`);
      }
    } else {
      warnings.push('threads-db-absent: 找不到 state_<N>.sqlite，只改了 rollout');
    }
    warnings.push('state5-host-predicate-unmeasured: 宿主列表是否真的按 creator_* 过滤还没取证（本机 314/356 行为 NULL），这条结论不能当已验证用');

    return {
      ok: true,
      action: 'moved',
      path: file,
      backup,
      lines: lines.length,
      threadRows,
      sourceAccount: srcId,
      targetAccount: acct.userId ?? acct.accountId,
      warnings,
    };
  },

  targetPath(ctx, session, targetId) {
    const root = sessionsRoot(ctx);
    const [y, m, d] = dateSegments(session.createdAt || Date.now());
    const stamp = isoOf(session.createdAt || Date.now()).slice(0, 19).replace(/:/g, '-');
    return path.join(root, y, m, d, `rollout-${stamp}-${targetId}.jsonl`);
  },

  /**
   * 标题落点：线程库 threads 表。
   *
   * 宿主侧栏口径是 `name || title`（readers/codex.mjs threadTitles）。name 是**用户手动改名**
   * 才有的列，所以把它声明成 guard：非空 = 用户已定名 → 整条不同步。
   * 我们只写 title，**不写 name**（代写 name 等于冒充用户改名）。
   *
   * 只改现有行：槽机制是 UPDATE，行不存在就返回 row-absent，不会替宿主 INSERT 一条线程
   * （宿主自己的线程登记另有触发条件，凭空造行会让侧栏出现一条打不开的会话）。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'db-column', db: threadsDbFile, table: 'threads', idCol: 'id', col: 'name', guard: true },
    { kind: 'db-column', db: threadsDbFile, table: 'threads', idCol: 'id', col: 'title' },
  ], 'codex'),

  // 落点变了但内容没变（decide 判 skip）：rollout 的 session_meta 与注册表都要跟着翻，
  // 否则宿主继续按旧目录把它归到另一个分组（非项目 ↔ 项目的判据就写在这些字段里）。
  relocate(ctx, { targetId, directory, scope, account }) {
    const root = sessionsRoot(ctx);
    const warnings = [];
    const file = findExistingByTargetId(root, targetId);
    const none = scope !== 'project';
    if (file) {
      const prev = readTargetLines(file);
      if (!prev.ok) return { ok: false, error: unreadableTarget(file, prev.reason), path: file, warnings };
      const lines = prev.lines;
      const meta = lines.find((l) => l.type === 'session_meta');
      if (meta?.payload) {
        backupIfExists(file, ctx, 'codex');
        meta.payload.cwd = directory;
        meta.payload.runtime_workspace_roots = [none ? resolveRoot('codex', ctx).bucketRoot.path : directory];
        if (none) delete meta.payload.git;
        // 搬迁只改落点，但归属沿用与新建同一套取值（显式 → 当前登录 → 留空），
        // 绝不让它带来源会话那一侧的账号
        const acct = resolveAccount(ctx, account);
        if (acct.userId) meta.payload.creator_user_id = acct.userId;
        if (acct.accountId) meta.payload.creator_account_id = acct.accountId;
        writeTargetLines(file, lines);
        warnings.push(`session_meta-rewritten: cwd → ${directory}`);
      } else {
        warnings.push('session_meta-missing: 目标 rollout 没有头行，未改写落点字段');
      }
    }
    warnings.push(...registerThread(ctx, { targetId, scope: none ? 'none' : 'project', cwd: directory, account }));
    return { ok: true, moved: false, path: file ?? null, warnings };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, account = null, scope = null }) {
    const warnings = [];
    const root = sessionsRoot(ctx);
    if (!root) return { ok: false, error: 'sessions-dir-unresolved' };
    const [y, m, d] = dateSegments(session.createdAt || Date.now());
    const dayDir = path.join(root, y, m, d);
    const stamp = isoOf(session.createdAt || Date.now()).slice(0, 19).replace(/:/g, '-');

    const inDayDir = fs.existsSync(dayDir) ? fs.readdirSync(dayDir).find((n) => n.endsWith(`-${targetId}.jsonl`) || n.endsWith(`-${targetId}.jsonl.zst`)) : null;
    const file = findExistingByTargetId(root, targetId) ?? (inDayDir ? path.join(dayDir, inDayDir) : path.join(dayDir, `rollout-${stamp}-${targetId}.jsonl`));
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const reg = { targetId, scope: scope ?? classifyCodexScope(session), cwd: session.cwd, account };

    if (mode === 'append') {
      if (isZstFile(file)) {
        // 目标是宿主压缩过的 `.jsonl.zst`：整帧解压 → 追加 → 重新压成一帧原子替换。
        // 绝不能另起一份 .jsonl —— 那会变成「同一会话两份 rollout」，reader 只取其中一份。
        // 也绝不能把「解不开」当空：重压会把用户已有历史真的抹掉（实测 11 行变 2 行还报成功）
        const prev = readTargetLines(file);
        if (!prev.ok) return { ok: false, error: unreadableTarget(file, prev.reason), path: file, targetId, warnings };
        const backup = backupIfExists(file, ctx, 'codex');
        const existing = prev.lines;
        if (existing.length === 0) warnings.push('目标文件为空，追加将缺少 session_meta');
        const add = buildLines(session, turns, targetId, provenance, { withHeader: false, ctx, account });
        writeTargetLines(file, [...existing, ...add]);
        if (provenance) writeSidecarProvenance(file, provenance);
        warnings.push(...registerThread(ctx, reg));
        return { ok: true, targetId, path: file, lines: add.length, mode, backup, warnings, concurrentRetries: 0 };
      }
      const backup = backupIfExists(file, ctx, 'codex');
      let warnedEmpty = false;
      const res = appendJsonlRebuild(file, () => {
        if (readJsonlFile(file).length === 0 && !warnedEmpty) {
          warnings.push('目标文件为空，追加将缺少 session_meta');
          warnedEmpty = true;
        }
        return buildLines(session, turns, targetId, provenance, { withHeader: false, ctx, account });
      });
      if (provenance) writeSidecarProvenance(file, provenance);
      warnings.push(...registerThread(ctx, reg));
      return { ok: true, targetId, path: file, lines: res.lines, mode, backup, warnings, concurrentRetries: res.concurrentRetries };
    }

    const pre = preflightOverwrite(file, { force, read: readTargetLines });
    if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
    const lines = buildLines(session, turns, targetId, provenance, { withHeader: true, ctx, account });
    const backup = backupIfExists(file, ctx, 'codex');
    writeTargetLines(file, lines);
    if (provenance) writeSidecarProvenance(file, provenance);
    warnings.push(...registerThread(ctx, reg));
    return { ok: true, targetId, path: file, lines: lines.length, mode, backup, warnings };
  },
};
