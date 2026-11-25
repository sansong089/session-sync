// writers/codex.mjs — 写 Codex CLI 原生会话
//
// 产出：<root>/sessions/YYYY/MM/DD/rollout-<ISO>-<targetId>.jsonl
// 事件：session_meta / response_item / event_msg（桌面端 legacy 回放）
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
import { provenanceFromObject, readSidecarProvenance, writeSidecarProvenance } from '../provenance.mjs';
import { PROVENANCE_LINE_TYPE, threadsDbFile } from '../readers/codex.mjs';
import { tableColumns } from '../readers/base.mjs';
import { uuidv7 } from '../util.mjs';
import { resolveRoot, roleRoots } from '../roots.mjs';
import { newNodeId, isoOf, dateSegments, readJsonlFile, writeJsonlFile, appendJsonlRebuild, backupIfExists, findExistingByTargetId, writeFileAtomic,
  parseJsonlStrict, unreadableTarget, preflightOverwrite, writePreImage,
  outputText, updateRowFiltered, insertRowFiltered } from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { compactionSummaryText } from '../text.mjs';
import { fitTitleFor } from '../titles.mjs';

function sessionsRoot(ctx) {
  // 按 role 取，不再依赖「声明顺序第一个 dir」——归档目录也是 dir
  return roleRoots('codex', ctx, 'sessions')[0]?.path ?? null;
}

// 宿主会把历史 rollout 压成 `.jsonl.zst`（本机 350+ 个）：读写都要认这个后缀
const isZstFile = (f) => String(f ?? '').endsWith('.zst');

// 目标名带 .zst 就必须保持压缩态：把明文写进 .zst 文件名里宿主解不开（实测 --force 覆盖时踩过）
function writeTargetLines(file, lines, expected) {
  if (!isZstFile(file)) return writeJsonlFile(file, lines, expected);
  const body = lines.map((line) => JSON.stringify(line) + '\n').join('');
  return writeFileAtomic(file, zlib.zstdCompressSync(Buffer.from(body, 'utf8')), expected);
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

// 宿主把注册表拆成「按账户分区」的 owner 空间（【源码】app.asar 26.1111.9664.0）：
//   electron-owner-value:<key>:<ownerId>  ← thread-workspace-root-hints / thread-projectless-output-directories
//   electron-renderer-content-owner       ← 当前登录账户的 ownerId
//   electron-owner-atoms:<ownerId>        ← 该账户的其它偏好
// 宿主读这两个键时只解析 owner 分区键（storageKey → a6 → w(key)+ownerId），
// 顶层裸键读不到 —— 写顶层等于写死数据（真机实测：宿主已把顶层裸键迁空）。
// 注意 projectless-thread-ids / thread-project-assignments / local-projects 仍留在顶层。
const OWNER_VALUE_PREFIX = 'electron-owner-value:';
const OWNER_ATOMS_PREFIX = 'electron-owner-atoms:';
const CONTENT_OWNER_KEY = 'electron-renderer-content-owner';
const OWNER_SCOPED_KEYS = ['thread-workspace-root-hints', 'thread-projectless-output-directories'];

/** 扫出注册表里出现过的 owner 空间 id（owner-value 键取最后一段，owner-atoms 键取整段）。 */
function ownerIdsOf(st) {
  const ids = new Set();
  for (const key of Object.keys(st ?? {})) {
    if (key.startsWith(OWNER_VALUE_PREFIX)) {
      const id = key.slice(OWNER_VALUE_PREFIX.length).split(':').pop();
      if (id) ids.add(id);
    } else if (key.startsWith(OWNER_ATOMS_PREFIX)) {
      const id = key.slice(OWNER_ATOMS_PREFIX.length);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * 当前该往哪个 owner 空间写：宿主自己记的 content-owner 优先；
 * 只有一个 owner 空间时就是它；多个空间又没标记 → 不猜（宁可退顶层旧键并告警）。
 */
function resolveOwnerId(st) {
  const cur = st?.[CONTENT_OWNER_KEY];
  if (typeof cur === 'string' && cur) return cur;
  const ids = ownerIdsOf(st);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * 改一个 owner 分区键：只动目标条目，别的线程内容原样保留。
 * 有 owner 空间就写 owner 空间（宿主 storageKey→a6 只解析 owner 空间键，顶层裸键读不到）；
 * 没有 owner 空间才退回顶层裸键（旧宿主形态）。
 */
function applyOwnerScoped(st, key, ownerId, fn) {
  const touch = (obj) => fn(obj && typeof obj === 'object' ? obj : {});
  for (const id of ownerIdsOf(st)) {
    const k = `${OWNER_VALUE_PREFIX}${key}:${id}`;
    if (st[k] && typeof st[k] === 'object') st[k] = touch(st[k]);
  }
  if (ownerId) {
    const k = `${OWNER_VALUE_PREFIX}${key}:${ownerId}`;
    st[k] = touch(st[k]);
  } else {
    st[key] = touch(st[key]);
  }
}

/**
 * 把线程登记进宿主的注册表（读-改-写，未知键原样保留，改写前留备份）。
 * 键形按本机 .codex-global-state.json 实测抄录：
 *   非项目：projectless-thread-ids[id]（顶层）+ owner 分区的
 *          thread-workspace-root-hints[id]=桶根
 *          thread-projectless-output-directories[id]=<会话目录>/outputs，且不挂 assignments
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
  const original = JSON.stringify(st);

  const list = Array.isArray(st['projectless-thread-ids']) ? st['projectless-thread-ids'] : [];
  const ownerId = resolveOwnerId(st);
  const asg = st['thread-project-assignments'] && typeof st['thread-project-assignments'] === 'object' ? st['thread-project-assignments'] : {};
  const projects = st['local-projects'] && typeof st['local-projects'] === 'object' ? st['local-projects'] : {};
  const order = Array.isArray(st['project-order']) ? st['project-order'] : [];
  if (scope === 'none') {
    if (!list.includes(targetId)) list.push(targetId);
    delete asg[targetId];
  } else {
    st['projectless-thread-ids'] = list.filter((x) => x !== targetId);
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
  // 路径提示两键必须落在 owner 分区：宿主 storageKey→a6 只解析 owner 空间键，顶层裸键它读不到
  const setOrDel = (obj, id, val) => {
    const next = { ...obj };
    if (val === undefined) delete next[id];
    else next[id] = val;
    return next;
  };
  const values = {
    'thread-workspace-root-hints': scope === 'none' ? bucket : undefined,
    'thread-projectless-output-directories': scope === 'none' ? path.join(String(cwd || bucket), 'outputs') : undefined,
  };
  for (const key of OWNER_SCOPED_KEYS) {
    applyOwnerScoped(st, key, ownerId, (obj) => setOrDel(obj, targetId, values[key]));
  }
  if (!ownerId && ownerIdsOf(st).length > 1) {
    warnings.push('registry-owner-unresolved: 宿主注册表有多个账户 owner 空间且未标记当前账户，路径提示已退回顶层旧键（新版本体只读 owner 空间，可能不显示）');
  }
  st['thread-project-assignments'] = asg;
  if (JSON.stringify(st) === original) return warnings;
  try {
    backupIfExists(file, ctx, 'codex');
    writeFileAtomic(file, JSON.stringify(st, null, 2));
  } catch (err) {
    warnings.push(`registry-write-failed: ${String(err?.message ?? err)}`);
  }
  return warnings;
}

/** 首条用户消息正文（宿主 threads.first_user_message / preview 的取值来源）。 */
function firstUserText(session) {
  for (const turn of session?.turns ?? []) {
    for (const it of turn.items ?? []) {
      if (it.kind === 'message' && it.role === 'user' && it.text) return String(it.text);
    }
  }
  return '';
}

/**
 * 宿主线程索引：state_<N>.sqlite 的 threads 表。
 *
 * 宿主**不会**给外部 rollout 建这一行 —— 它的迁移器对没有这行的线程直接报
 * missing_sqlite_metadata（【真机】宿主 app-server 26.1111.9664.0：
 * `codex migrate-rollouts --thread <id>` 的 failure_reason），侧栏自然也列不出来。
 * 所以写侧代登记一行；宿主启动时的迁移器再把它转成分页历史（实测：补上这行后迁移
 * status=migrated，threads.history_mode 由 legacy 转 paginated，并生成 thread_history 库）。
 *
 * 只写 title，**不写 name**（name 是用户手动改名才有的列，代写等于冒充用户改名）。
 */
function registerThreadRow(ctx, { targetId, session, file, cwd, account, firstUser = firstUserText(session), updateCols = [] }) {
  const warnings = [];
  const dbFile = threadsDbFile(ctx);
  if (!dbFile) {
    warnings.push('threads-db-absent: 找不到 state_<N>.sqlite，没能登记线程索引行（宿主侧栏不会列这条）');
    return warnings;
  }
  if (!file) {
    warnings.push('threads-row-skipped: 没有 rollout 文件路径，登记不了线程索引行');
    return warnings;
  }
  const acct = resolveAccount(ctx, account);
  const created = session?.createdAt || Date.now();
  const updated = session?.updatedAt || created;
  const title = fitTitleFor('codex', session?.title).value;
  const directory = String(cwd ?? '');
  const pathPrefix = '\\\\?\\';
  const row = {
    id: String(targetId),
    rollout_path: file,
    created_at: Math.floor(created / 1000),
    updated_at: Math.floor(updated / 1000),
    source: 'vscode',
    model_provider: 'custom',
    // 宿主存 cwd 一律带 \\?\ 长路径前缀（现网原生行实测形态）
    cwd: ctx.platform === 'win32' && directory && !directory.startsWith(pathPrefix) ? pathPrefix + directory : directory,
    sandbox_policy: '{"type":"read-only"}',
    approval_mode: 'on-request',
    tokens_used: 0,
    has_user_event: firstUser ? 1 : 0,
    archived: 0,
    cli_version: HOST_CLI_VERSION,
    memory_mode: 'enabled',
    created_at_ms: created,
    updated_at_ms: updated,
    thread_source: 'user',
    recency_at: Math.floor(updated / 1000),
    recency_at_ms: updated,
    // legacy = 交给宿主迁移器分页化；已经 paginated 的行不覆盖（除非内容被重写）
    history_mode: 'legacy',
    is_pinned: 0,
    originator: HOST_ORIGINATOR,
    creator_user_id: acct.userId ?? null,
    creator_account_id: acct.accountId ?? null,
    title,
    first_user_message: firstUser,
    preview: firstUser || title,
  };
  let db;
  try {
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 15000');
    const res = insertRowFiltered(db, 'threads', row, { onConflict: { conflictCols: ['id'], updateCols } });
    if (!res.ok) warnings.push(`threads-row-write-failed: ${res.error ?? 'unknown'}`);
  } catch (err) {
    warnings.push(`threads-row-write-failed: ${String(err?.message ?? err)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
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
  const userItems = (turn.items ?? []).filter((it) => it.kind === 'message' && it.role === 'user' && it.text);
  const pureCompaction = userItems.length > 0 && userItems.every((it) => it.compact && compactionSummaryText(it.text).trim()) &&
    !(turn.items ?? []).some((it) => it.kind === 'attachment');
  const pushItem = (ts, payload) => {
    flushUser();
    out.push({ ts, payload });
  };
  // 同一轮的连续用户文本块并进同一条 user message：读侧「一条含 input_text 的 user 消息 = 一轮」，
  // 逐块各发一条会把一轮拆成多轮 → 跨落点轮次数不同 → 续写误判分叉
  let userBlocks = null;
  let compactBlocks = [];
  let userTs = 0;
  function flushUser() {
    if (userBlocks && userBlocks.length) {
      out.push({ ts: userTs, payload: { type: 'message', id: newNodeId(), role: 'user', content: userBlocks } });
      if (pureCompaction && compactBlocks.length === userItems.length) {
        const message = compactBlocks.join('\n\n');
        out.push({ ts: userTs, type: 'compacted', payload: {
          message,
          replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] }],
        } });
      }
    }
    userBlocks = null;
    compactBlocks = [];
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
          const text = it.compact ? compactionSummaryText(it.text) : it.text;
          if (it.compact) compactBlocks.push(text);
          userBlocks.push({ type: 'input_text', text: it.compact ? '<cb_summary>' + text + '</cb_summary>' : text });
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

// 宿主对 rollout 首行 session_meta 的硬要求（【源码】宿主 app-server 26.1111.9664.0 的迁移器判定）：
// payload 缺 originator 或 cli_version 任一，宿主一律判 invalid_session_metadata
// —— 既不迁移、也不列侧栏。两个值按现网原生会话抄录。
const HOST_ORIGINATOR = 'Codex Desktop';
const HOST_CLI_VERSION = '0.169.0-alpha.11.1';
const HOST_SESSION_FIELDS = {
  originator: HOST_ORIGINATOR, cli_version: HOST_CLI_VERSION, source: 'vscode',
  thread_source: 'user', model_provider: 'custom',
};

const APPEND_INDEX_COLS = ['rollout_path', 'cwd', 'updated_at', 'updated_at_ms', 'recency_at', 'recency_at_ms'];

function messageText(payload) {
  return (payload.content ?? []).filter((part) => typeof part.text === 'string' && part.text)
    .map((part) => part.text).join('\n\n');
}

// Legacy history replays text from event_msg, while the sync reader consumes response_item.
function withLegacyReplay(lines) {
  const out = [];
  let turn;
  const event = (timestamp, payload) => out.push({ timestamp, type: 'event_msg', payload });
  const closeTurn = () => {
    if (!turn) return;
    event(turn.last, {
      type: 'task_complete', turn_id: turn.id, root_turn_id: turn.id,
      started_at: turn.started, completed_at: Math.floor(Date.parse(turn.last) / 1000),
    });
    turn = null;
  };
  for (const line of lines) {
    const { type, payload, timestamp } = line;
    if (type === PROVENANCE_LINE_TYPE) closeTurn();
    if (type !== 'response_item') {
      out.push(line);
      continue;
    }
    const isUser = payload?.type === 'message' && payload.role === 'user';
    if (isUser) {
      closeTurn();
      const ms = Date.parse(timestamp);
      const id = uuidv7(ms);
      turn = { id, started: Math.floor(ms / 1000), last: timestamp };
      event(timestamp, {
        type: 'task_started', turn_id: id, root_turn_id: id, started_at: turn.started,
        collaboration_mode_kind: 'default',
      });
    }
    out.push(line);
    if (!turn) continue;
    turn.last = timestamp;
    if (payload?.type !== 'message' || (!isUser && payload.role !== 'assistant')) continue;
    const message = messageText(payload);
    if (!message) continue;
    event(timestamp, isUser
      ? { type: 'user_message', message, images: [], local_images: [], text_elements: [] }
      : { type: 'agent_message', message });
  }
  closeTurn();
  return out;
}

function completeLegacyReplay(lines) {
  const lastStamp = lines.findLastIndex((line) => line.type === PROVENANCE_LINE_TYPE);
  const limit = lastStamp < 0 ? lines.length : lastStamp;
  const starts = [];
  let pendingStart;
  for (let i = 0; i < limit; i++) {
    const { type, payload } = lines[i];
    if (type === 'event_msg' && payload?.type === 'task_started') pendingStart = i;
    if (type === PROVENANCE_LINE_TYPE || (type === 'event_msg' && payload?.type === 'task_complete')) pendingStart = undefined;
    if (type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      starts.push(pendingStart ?? i);
      pendingStart = undefined;
    }
  }
  if (!starts.length) return lines;

  const repaired = lines.slice(0, starts[0]);
  for (const [index, start] of starts.entries()) {
    const turn = lines.slice(start, starts[index + 1] ?? limit);
    const events = turn.filter((line) => line.type === 'event_msg');
    const opened = events.find((line) => line.payload?.type === 'task_started');
    const closed = events.find((line) => line.payload?.type === 'task_complete' &&
      (!opened || line.payload.turn_id === opened.payload.turn_id));
    const turnId = opened?.payload.turn_id ?? closed?.payload.turn_id;
    const canonical = withLegacyReplay(turn.filter((line) => line.type === 'response_item'));
    const inserts = new Map();
    let anchor = start;
    let completeAt = closed ? lines.indexOf(closed, start) : start;
    for (const line of canonical) {
      if (line.type === 'response_item') {
        anchor = lines.indexOf(line, anchor) + 1;
        continue;
      }
      const kind = line.payload.type;
      const match = events.findIndex((event) => event.payload?.type === kind && event.payload.message === line.payload.message);
      if (match >= 0) {
        const [existing] = events.splice(match, 1);
        if (kind !== 'task_complete') completeAt = Math.max(completeAt, lines.indexOf(existing, start) + 1);
        continue;
      }
      let at = anchor;
      if (kind === 'task_started') at = start;
      else if (kind === 'task_complete') at = Math.max(anchor, completeAt);
      else if (closed) at = Math.min(at, lines.indexOf(closed, start));
      if (turnId && line.payload.turn_id) Object.assign(line.payload, { turn_id: turnId, root_turn_id: turnId });
      if (!inserts.has(at)) inserts.set(at, []);
      inserts.get(at).push(line);
    }
    for (const [offset, line] of turn.entries()) repaired.push(...(inserts.get(start + offset) ?? []), line);
    repaired.push(...(inserts.get(start + turn.length) ?? []));
  }
  repaired.push(...lines.slice(limit));
  return repaired.length === lines.length ? lines : repaired;
}

function repairOwnedRollout(ctx, file, targetId) {
  const before = fs.statSync(file);
  const read = readTargetLines(file);
  if (!read.ok) return { warning: unreadableTarget(file, read.reason) };
  const { lines } = read;
  const head = lines[0];
  if (head?.type !== 'session_meta' || (head.payload?.id ?? head.payload?.session_id) !== targetId) return {};
  const imported = lines.some((line) => line.type === PROVENANCE_LINE_TYPE &&
    provenanceFromObject(line['session-sync'] ?? line.payload?.['session-sync'])) || readSidecarProvenance(file);
  if (!imported) return {};

  const payload = { ...head.payload };
  for (const [key, value] of Object.entries(HOST_SESSION_FIELDS)) {
    if (!payload[key]) payload[key] = value;
  }
  const headerChanged = Object.keys(HOST_SESSION_FIELDS).some((key) => payload[key] !== head.payload[key]);
  const replay = payload.history_mode === 'paginated' ? lines : completeLegacyReplay(lines);
  const needsReplay = replay !== lines;
  if (headerChanged || needsReplay) {
    const body = [{ ...head, payload }, ...replay.slice(1)];
    const repaired = needsReplay ? body.map((line, ordinal) => ({ ...line, ordinal })) : body;
    const backup = backupIfExists(file, ctx, 'codex');
    const now = fs.statSync(file);
    if (before.size !== now.size || before.mtimeMs !== now.mtimeMs || before.ino !== now.ino) {
      return { warning: 'codex-replay-repair-conflict: rollout changed during repair' };
    }
    try {
      writeTargetLines(file, repaired, { expectSize: before.size, expectMtimeMs: before.mtimeMs });
    } catch (error) {
      if (error.code !== 'CONCURRENT_MODIFICATION') throw error;
      return { warning: 'codex-replay-repair-conflict: rollout changed during repair' };
    }
    return { payload, lines: repaired, backup, repaired: true };
  }
  return { payload, lines };
}

function buildLines(session, turns, targetId, provenance, opts = {}) {
  const lines = [];
  const cwd = session.cwd || '';
  const createdAt = session.createdAt || Date.now();

  const push = (ts, type, payload) => {
    lines.push({ timestamp: isoOf(ts), type, ...(payload ? { payload } : {}) });
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
      // 这两个字段是宿主的准入条件，缺任一就判 invalid_session_metadata（整条会话不可见）
      ...HOST_SESSION_FIELDS,
      ...(acct.userId ? { creator_user_id: acct.userId } : {}),
      ...(acct.accountId ? { creator_account_id: acct.accountId } : {}),
      ...(!none && session.meta?.git ? { git: session.meta.git } : {}),
      ...(session.model ? { model: session.model } : {}),
    });
  }

  for (const turn of turns) {
    for (const { ts, type = 'response_item', payload } of turnToItems(turn, session)) {
      push(ts, type, payload);
    }
  }

  if (provenance) {
    // provenance 必须放顶层：读侧按 line['session-sync'] 取（与其它 JSONL 家一致）
    lines.push({ timestamp: isoOf(session.updatedAt), type: PROVENANCE_LINE_TYPE, 'session-sync': provenance });
  }
  const replay = opts.replay ? withLegacyReplay(lines) : lines;
  return replay.map((line, index) => ({ ...line, ordinal: (opts.startOrdinal ?? 0) + index }));
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

  ensureIndex(ctx, { targetId, title, scope, createdAt, updatedAt }) {
    const file = findExistingByTargetId(sessionsRoot(ctx), targetId);
    if (!file) return {};
    const repair = repairOwnedRollout(ctx, file, targetId);
    if (!repair.payload) return { warnings: repair.warning ? [repair.warning] : [] };

    const { payload, lines, backup, repaired } = repair;
    const cwd = payload.cwd;
    const account = payload.creator_user_id ? { id: payload.creator_user_id, accountId: payload.creator_account_id } : null;
    const firstUser = lines.find((line) => line.type === 'response_item' &&
      line.payload?.type === 'message' && line.payload.role === 'user');
    const warnings = registerThread(ctx, { targetId, scope: scope ?? (payload.git ? 'project' : 'none'), cwd, account });
    warnings.push(...registerThreadRow(ctx, {
      targetId, file, cwd, account, session: { title, createdAt, updatedAt },
      firstUser: firstUser ? messageText(firstUser.payload) : '',
    }));
    if (repaired) warnings.push('codex-replay-repaired' + (backup ? ': ' + backup : ''));
    return { warnings };
  },

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
    if (file) warnings.push(...registerThreadRow(ctx, { targetId, file, cwd: directory, account,
      updateCols: ['rollout_path', 'cwd', 'creator_user_id', 'creator_account_id'],
    }));
    return { ok: true, moved: false, path: file ?? null, warnings };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, account = null, scope = null, title = session.title }) {
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
      const repair = provenance && isFile(file) ? repairOwnedRollout(ctx, file, targetId) : null;
      if (repair?.warning) return { ok: false, error: repair.warning, path: file };
      const replay = Boolean(provenance) && repair?.payload?.history_mode !== 'paginated';
      const buildAppend = (existing) => buildLines(session, turns, targetId, provenance, {
        withHeader: false, replay, startOrdinal: existing.reduce((next, line) => Math.max(next, (line.ordinal ?? -1) + 1), 0),
      });
      const registerAppend = () => {
        if (!provenance) return;
        writeSidecarProvenance(file, provenance);
        warnings.push(...registerThread(ctx, reg));
        warnings.push(...registerThreadRow(ctx, { targetId, session, file, cwd: session.cwd, account, updateCols: APPEND_INDEX_COLS }));
      };
      if (isZstFile(file)) {
        // 目标是宿主压缩过的 `.jsonl.zst`：整帧解压 → 追加 → 重新压成一帧原子替换。
        // 绝不能另起一份 .jsonl —— 那会变成「同一会话两份 rollout」，reader 只取其中一份。
        // 也绝不能把「解不开」当空：重压会把用户已有历史真的抹掉（实测 11 行变 2 行还报成功）
        const prev = readTargetLines(file);
        if (!prev.ok) return { ok: false, error: unreadableTarget(file, prev.reason), path: file, targetId, warnings };
        const backup = repair?.backup ?? backupIfExists(file, ctx, 'codex');
        const existing = prev.lines;
        if (existing.length === 0) warnings.push('目标文件为空，追加将缺少 session_meta');
        const add = buildAppend(existing);
        writeTargetLines(file, [...existing, ...add]);
        registerAppend();
        return { ok: true, targetId, path: file, lines: add.length, mode, backup, warnings, concurrentRetries: 0 };
      }
      const backup = repair?.backup ?? backupIfExists(file, ctx, 'codex');
      let warnedEmpty = false;
      const res = appendJsonlRebuild(file, () => {
        const existing = readJsonlFile(file);
        if (existing.length === 0 && !warnedEmpty) {
          warnings.push('目标文件为空，追加将缺少 session_meta');
          warnedEmpty = true;
        }
        return buildAppend(existing);
      });
      registerAppend();
      return { ok: true, targetId, path: file, lines: res.lines, mode, backup, warnings, concurrentRetries: res.concurrentRetries };
    }

    const pre = preflightOverwrite(file, { force, read: readTargetLines });
    if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
    const lines = buildLines(session, turns, targetId, provenance, { withHeader: true, replay: true, ctx, account });
    const backup = backupIfExists(file, ctx, 'codex');
    writeTargetLines(file, lines);
    if (provenance) writeSidecarProvenance(file, provenance);
    warnings.push(...registerThread(ctx, reg));
    warnings.push(...registerThreadRow(ctx, { targetId, session: { ...session, title }, file, cwd: session.cwd, account,
      updateCols: [...APPEND_INDEX_COLS, 'title', 'first_user_message', 'preview', 'has_user_event', 'history_mode'],
    }));
    return { ok: true, targetId, path: file, lines: lines.length, mode, backup, warnings };
  },
};
