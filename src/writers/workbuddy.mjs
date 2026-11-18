// writers/workbuddy.mjs — 写 WorkBuddy 中文版 / 国际版原生会话
//
// 两个落点必须**同时**写，否则宿主 UI 看不到导入的会话：
//   1. <root>/projects/<slug>/<targetId>.jsonl   会话事件流（正文）
//   2. <root>/workbuddy.db 的 sessions 表         会话索引（列表/标题/时间）
// 宿主 UI 的会话列表读的是 db 索引，不是目录扫描
// （本机实测：130 条 db 记录与 130 个 jsonl 一一对应，零差集）。
//
// 并发：宿主可能在运行中写同一批数据 → db 侧用 busy_timeout + 单条语句（WAL 下写写不互斥读），
// jsonl 侧用原子追加 + 大小校验重试（见 base.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS, workbuddyRoot } from '../hosts.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import {
  newNodeId,
  readJsonlFile,
  writeJsonlFile,
  appendJsonlRebuild,
  backupIfExists,
  resolveSlugDir,
  slugForWorkbuddy,
  lastNodeId,
  findExistingByTargetId,
  insertRowFiltered,
  preflightOverwrite,
  relocateByTargetId,
  updateRowFiltered,
  writePreImage,
  outputText,
} from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';
import { accountIdOf } from '../placement.mjs';
import { currentAccount } from '../accounts.mjs';
import { isDir } from '../util.mjs';
import { roleRoots, writeRootOf } from '../roots.mjs';
import { tableColumns } from '../readers/base.mjs';

function projectsRoot(ctx, variant) {
  return writeRootOf(variant, ctx, 'projects')?.path ?? null;
}

// 索引库路径：即使文件尚不存在也返回推算路径（存在才写）
function indexDbFile(ctx, variant) {
  return roleRoots(variant, ctx, 'sessionsIndex')[0]?.path ?? null;
}

function argsToString(input) {
  if (input == null) return '{}';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function turnToEvents(turn, session) {
  const events = [];
  // 同一轮的连续用户文本块并成一条 message 事件：读侧「一条含 input_text 的 user 事件 = 一轮」，
  // 逐块各发一条会把一轮拆成多轮，续写就会被误判成分叉
  let userBlocks = null;
  let userTs = 0;
  const flushUser = () => {
    if (userBlocks && userBlocks.length) events.push({ type: 'message', role: 'user', content: userBlocks, ts: userTs });
    userBlocks = null;
  };
  const push = (ev) => {
    flushUser();
    events.push(ev);
  };
  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    if (it.kind === 'message' && it.role === 'user') {
      if (!userBlocks) {
        userBlocks = [];
        userTs = ts;
      }
      userBlocks.push({ type: 'input_text', text: it.text });
      continue;
    }
    switch (it.kind) {
      case 'message':
        push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: it.text }],
          ts,
        });
        break;
      case 'reasoning':
        if (it.text) push({ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: it.text }], ts });
        break;
      case 'tool_call':
        push({ type: 'function_call', callId: it.callId || newNodeId(), name: it.name || 'tool', arguments: argsToString(it.input), ts });
        break;
      case 'tool_result':
        push({
          type: 'function_call_result',
          name: it.name || 'tool',
          callId: it.callId || null,
          status: it.status === 'error' ? 'error' : 'completed',
          output: { type: 'text', text: outputText(it.output) ?? '' },
          ts,
        });
        break;
      case 'attachment':
        if (it.ref) push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[attachment] ${it.ref}` }], ts });
        break;
      default:
        break;
    }
  }
  flushUser();
  return events;
}

function buildLines(session, turns, targetId, startParent, provenance, opts = {}) {
  const lines = [];
  let parent = startParent ?? null;
  const cwd = session.cwd || '';
  const sessionId = targetId;
  const model = session.model || null;

  const emit = (obj) => {
    const id = newNodeId();
    const line = { id, parentId: parent, ...obj, sessionId, cwd };
    lines.push(line);
    parent = id;
    return line;
  };

  if (opts.withHeader) {
    emit({
      type: 'session-meta',
      timestamp: session.createdAt || Date.now(),
      meta: { 'codebuddy.ai/hostKind': 'unopted', ...(provenance ? { 'session-sync': provenance } : {}) },
    });
    if (opts.title) emit({ type: 'ai-title', timestamp: session.createdAt || Date.now(), aiTitle: String(opts.title) });
  }

  for (const turn of turns) {
    for (const ev of turnToEvents(turn, session)) {
      const { ts, ...rest } = ev;
      emit({ ...rest, timestamp: ts, ...(model && rest.type !== 'function_call_result' ? { providerData: { model } } : {}) });
    }
  }
  return lines;
}

// ---- 索引库写入 ----

function openIndexDb(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    /* ignore */
  }
  return db;
}

// 正文首行有没有 session-sync 标记 —— 这是「只改标我们自己写过的行」的唯一判据
function isImportedBody(ctx, variant, id) {
  const root = projectsRoot(ctx, variant);
  const file = root ? findExistingByTargetId(root, id) : null;
  if (!file) return false;
  const first = readJsonlFile(file)[0];
  if (first?.meta?.['session-sync'] || first?.['session-sync']) return true;
  return fs.existsSync(`${file}.session-sync.json`);
}

// uid 取值顺序：--account → 目标宿主当前登录（accounts.mjs 的探针，实测是 account-snapshot 的 primary.uid）
// → 目标宿主默认账号 'local'。
// 绝不继承源会话的 account：那是**来源侧**的归属（跨 agent 时甚至属于另一个命名空间），
// 而宿主列表谓词是 user_id = 当前登录 uid，挂上去等于写进没人能看见的桶里，还不报错。
// 也绝不用「库里有没有这个 uid 的行」反推当前账号 —— 新登录的账号本来就没有行（D3），
// 那套 dirUser/has() 推断会把归属钉在已登出的旧账号上。
function pickUserId(ctx, variant, { account } = {}) {
  const warnings = [];
  const acctId = accountIdOf(account);
  if (acctId) return { uid: acctId, source: 'flag:account', warnings };
  if (account) warnings.push('account-unusable: 传入的账户里没有可用的 id，改用当前登录 uid（写侧已在更外层拒绝整条写入）');
  const cur = currentAccount(variant, ctx);
  if (cur?.id) return { uid: cur.id, source: 'account-snapshot', warnings };
  warnings.push('account-snapshot-missing: 读不到 primary.uid，退回目标宿主默认账号（account:target-default），宿主可能不列这条');
  return { uid: 'local', source: 'target-default', warnings };
}

function isPlaygroundCwd(cwd) {
  return /WorkBuddy/i.test(String(cwd ?? '')) ? 1 : 0;
}

/**
 * 写/更新 sessions 索引行。
 * 只更新我们负责的列；user_id / is_playground 仅在新建时给值，已有行不动。
 * @returns {{ok:boolean, created?:boolean, skipped?:string, error?:string}}
 */
export function upsertSessionIndex(ctx, variant, info) {
  const dbFile = indexDbFile(ctx, variant);
  if (!dbFile || !fs.existsSync(dbFile)) return { ok: true, skipped: 'index-db-absent' };

  let db;
  try {
    db = openIndexDb(dbFile);
  } catch (err) {
    return { ok: false, error: `index-db-open-failed: ${err?.message ?? err}` };
  }

  try {
    if (!tableColumns(db, 'sessions').includes('id')) return { ok: true, skipped: 'sessions-table-absent' };

    const id = String(info.targetId);
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    const now = Date.now();
    const createdAt = info.createdAt || now;
    const updatedAt = info.updatedAt || now;
    // 空标题就留空：不要塞 'imported session' 这类占位符 ——
    // 索引自愈（ensureIndex）不负责标题，标题由 drift 通道写；
    // 这里的 title 只是「索引行还不存在、需要新建」时的初值。
    const title = fitTitleFor(variant, info.title).value;

    if (existing) {
      // 索引自愈**不写 title**：标题有且只有一个负责人 —— drift 通道（源侧改名时同步）。
      // 这里若跟着写，就成了绕过 drift 窄判据（仅 identical）的旁路：
      // skip 分支还有 target-ahead（目标比源更新），那时源侧标题是旧名，
      // 覆盖过去等于抹掉目标侧自己的标题。
      // model 只在拿到值时写：不传 ≠ 写 null（写 null 会把宿主自己识别的模型抹掉）
      const sets = [
        ['cwd', info.cwd || ''],
        ['status', 'Completed'],
        ['updated_at', updatedAt],
        ['last_activity_at', updatedAt],
      ];
      if (info.model) sets.push(['model', info.model]);
      updateRowFiltered(db, 'sessions', sets, { id });
      return { ok: true, created: false };
    }

    const picked = pickUserId(ctx, variant, { account: info.account });
    const playground = info.scope === 'none' ? 1 : info.scope === 'project' ? 0 : isPlaygroundCwd(info.cwd);

    // 按库里**实际存在**的列裁剪 INSERT —— 与 reader 侧裁剪 SELECT 同一口径。
    // 为什么：宿主的 sessions 表是「baseline 建表 + 后续 ALTER TABLE ADD COLUMN」长出来的，
    // 而我们用的列有一半是后加的（真机取证 app.asar 内嵌的宿主迁移 SQL）：
    //   baseline（2026-06-26）= id, cwd, user_id, title, custom_title, status, created_at,
    //     updated_at, last_activity_at, deleted_at, is_playground, source_mode, mode, model, …
    //   transport/unread 是 0013 加的，thought_level 是 0008 加的。
    // 老版本库的 sessions 表没有这几列，硬编码 INSERT 会整条失败（index-write-failed），
    // 索引行写不进去 → 宿主会话列表里看不到这条会话。
    // 列裁剪交给 insertRowFiltered（唯一出口）：老版本库缺 transport/unread/thought_level 时
    // 自动跳过，不再整条 INSERT 失败（那会让宿主列表里看不到这条会话）。
    const wanted = [
      ['id', id],
      ['cwd', info.cwd || ''],
      ['user_id', picked.uid],
      ['title', title],
      ['status', 'Completed'],
      ['created_at', createdAt],
      ['updated_at', updatedAt],
      ['last_activity_at', updatedAt],
      ['deleted_at', null],
      ['is_playground', playground],
      ['transport', 'local'],
      ['unread', 0],
      ['model', info.model || null],
      ['mode', null],
      ['source_mode', null],
      ['thought_level', null],
    ];
    insertRowFiltered(db, 'sessions', wanted);

    return { ok: true, created: true, userId: picked.uid, userIdSource: picked.source, warnings: picked.warnings };
  } catch (err) {
    return { ok: false, error: `index-write-failed: ${err?.message ?? err}` };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export function createWorkbuddyWriter({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    canWrite(ctx) {
      return projectsRoot(ctx, variant) ? { ok: true } : { ok: false, reason: 'projects-dir-unresolved' };
    },

    targetPath(ctx, session, targetId) {
      const root = projectsRoot(ctx, variant);
      const found = findExistingByTargetId(root, targetId);
      if (found) return found;
      const dir = resolveSlugDir(root, slugForWorkbuddy(session.cwd));
      return path.join(dir, `${targetId}.jsonl`);
    },

    // 只搬 projects/<cwd-slug>/<id>.jsonl；桶目录是 agent 的工作产物目录，绝不动
    relocate(ctx, { targetId, directory, scope, account }) {
      const root = projectsRoot(ctx, variant);
      const slug = slugForWorkbuddy(directory);
      if (!slug) return { ok: false, warnings: ['cwd-required: 空落点无法搬迁 workbuddy 正文'] };
      // 顺序按规格：先建目标文件（复制）→ 改索引行 → 最后删旧文件；中断时旧文件仍在，重跑可自愈
      const r = relocateByTargetId(root, targetId, resolveSlugDir(root, slug), { ctx, variant, keepSource: true });
      const warnings = r.warning ? [r.warning] : [];
      let indexOk = false;
      try {
        const idx = upsertSessionIndex(ctx, variant, { targetId, cwd: directory, scope: scope ?? null, account: account ?? null });
        indexOk = idx?.ok !== false;
        if (indexOk) warnings.push(`index-cwd-updated: ${directory}`);
        else warnings.push(`index-update-failed: ${idx?.error ?? 'unknown'}`);
      } catch (err) {
        warnings.push(`index-update-failed: ${String(err?.message ?? err)}`);
      }
      if (r.source && indexOk) {
        try {
          fs.unlinkSync(r.source);
        } catch (err) {
          warnings.push(`old-file-remove-failed: ${String(err?.message ?? err)}`);
        }
      }
      return { ok: true, moved: r.moved, path: r.path, warnings };
    },

    // 供 import 在 skip 分支做「索引自愈」：正文已在，只补索引行
    ensureIndex(ctx, info) {
      return upsertSessionIndex(ctx, variant, info);
    },

    /**
     * 元数据漂移：源侧只改了标题（内容没变，指纹相同）时，把新名同步到目标。
     *
     * 标题落点声明（统一的槽机制，见 writers/title-slots.mjs）：
     *   正文 ai-title 行 —— 宿主从正文读标题（真机取证：custom-title 行 > ai-title 行 > 首问）；
     *   db sessions.title —— 索引与列表快照用。
     * **不写 custom_title 列、也不写正文 custom-title 行**：那是宿主给「用户在
     * WorkBuddy 里手动改名」用的标记（isUserDefinedTitle = customTitle 非空），
     * 我们代写等于冒充用户操作，会让宿主把导入的会话当成用户自己起的名。
     *
     * 那两个落点声明成 **guard**：它们非空 = 用户已定名 → 整个同步跳过。
     * 用户的决定优先于源侧改名 —— 否则源侧一改名，就把用户取的名字顶掉了
     * （显示层因 custom_title 优先看不出异常，但 ai-title 会被无声改写）。
     */
    syncTitle: makeTitleSyncer((ctx) => [
      { kind: 'body-row', file: (c, targetId) => {
        const root = projectsRoot(c, variant);
        return root ? findExistingByTargetId(root, String(targetId)) : null;
      }, type: 'ai-title', field: 'aiTitle' },
      { kind: 'db-column', db: (c) => indexDbFile(c, variant), table: 'sessions', idCol: 'id', col: 'title', maxLen: TITLE_MAX.workbuddy },
      // guard：用户在 WorkBuddy 里手动改的名（db 列与正文行两处都算）
      { kind: 'db-column', db: (c) => indexDbFile(c, variant), table: 'sessions', idCol: 'id', col: 'custom_title', guard: true },
      { kind: 'body-row', file: (c, targetId) => {
        const root = projectsRoot(c, variant);
        return root ? findExistingByTargetId(root, String(targetId)) : null;
      }, type: 'custom-title', field: 'customTitle', guard: true },
    ], variant),

    /**
     * 本变体的账号分区实况：库里出现过的 user_id + 各自行数，当前登录取 account-snapshot。
     * 只报有真实信号的 uid —— 「新账号本来 0 行」是实测事实，所以不能按行数筛掉任何 uid。
     */
    listAccounts(ctx) {
      const dbFile = indexDbFile(ctx, variant);
      if (!dbFile || !fs.existsSync(dbFile)) return { ok: false, error: 'index-db-absent' };
      let db;
      try {
        db = openIndexDb(dbFile);
      } catch (err) {
        return { ok: false, error: `index-db-open-failed: ${err?.message ?? err}` };
      }
      const warnings = [];
      try {
        if (!tableColumns(db, 'sessions').includes('user_id')) return { ok: false, error: 'sessions-user-id-column-absent' };
        const cur = currentAccount(variant, ctx);
        if (!cur) warnings.push('account-snapshot-missing: 读不到 primary.uid，无法判定哪个是当前登录账号');
        const rows = db.prepare("SELECT user_id, COUNT(*) n FROM sessions WHERE user_id IS NOT NULL AND user_id <> '' GROUP BY user_id ORDER BY n DESC").all();
        return {
          ok: true,
          current: cur,
          accounts: rows.map((r) => ({ id: String(r.user_id), sessions: Number(r.n), isCurrent: !!cur && String(r.user_id) === cur.id, name: cur && String(r.user_id) === cur.id ? cur.name : null })),
          warnings,
        };
      } catch (err) {
        return { ok: false, error: `list-accounts-failed: ${err?.message ?? err}` };
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    },

    /**
     * 把一条会话索引行改标到目标账号（归属列 = sessions.user_id）。
     * 与 repair() 的区别：repair 是「批量自愈我们自己写过的行」，这里是「按 id 点名、切一条」，
     * 所以宿主原生行也在可切范围内（调用方已要求 --id 并逐条审计）；deleted_at 行拒绝。
     * 不动 title/cwd：那些归 import 的索引自愈管，这里只翻归属，减少连带影响。
     */
    switchAccount(ctx, { targetId, account, onlyImported = false } = {}) {
      const warnings = [];
      const uid = accountIdOf(account);
      if (!uid) return { ok: false, action: 'refused', error: `account-unusable: 目标账户里没有可用的 id（${JSON.stringify(account ?? null).slice(0, 80)}）` };
      const dbFile = indexDbFile(ctx, variant);
      if (!dbFile || !fs.existsSync(dbFile)) return { ok: false, action: 'refused', error: 'index-db-absent' };
      const id = String(targetId);
      let db;
      try {
        db = openIndexDb(dbFile);
      } catch (err) {
        return { ok: false, action: 'refused', error: `index-db-open-failed: ${err?.message ?? err}` };
      }
      try {
        const cols = tableColumns(db, 'sessions');
        if (!cols.includes('user_id')) return { ok: false, action: 'refused', error: 'sessions-user-id-column-absent' };
        const wanted = ['id', 'user_id', 'cwd', 'title', 'deleted_at', 'updated_at'].filter((c) => cols.includes(c));
        const row = db.prepare(`SELECT ${wanted.join(',')} FROM sessions WHERE id = ?`).get(id);
        if (!row) return { ok: false, action: 'not-found', error: `row-not-found: sessions 表里没有 ${id}`, sourceAccount: null, targetAccount: uid };
        if (cols.includes('deleted_at') && row.deleted_at != null) {
          return { ok: false, action: 'refused', error: 'row-deleted: 宿主已删除该行（列表谓词含 deleted_at IS NULL），改标也不会可见', sourceAccount: row.user_id ?? null, targetAccount: uid };
        }
        const sourceAccount = row.user_id ? String(row.user_id) : null;
        if (sourceAccount === uid) return { ok: true, action: 'already', sourceAccount, targetAccount: uid, warnings };
        if (onlyImported && !isImportedBody(ctx, variant, id)) {
          return { ok: false, action: 'refused', error: 'not-imported-row: 该条正文没有 session-sync 标记，--only-imported 下不改宿主原生行', sourceAccount, targetAccount: uid };
        }
        if (!isImportedBody(ctx, variant, id)) warnings.push(`foreign-switch-authorized: 这条是宿主原生行（无 session-sync 标记），按点名授权改标 ${sourceAccount ?? '(无归属)'} → ${uid}`);

        const backup = writePreImage(ctx, variant, { targetId: id, before: Object.fromEntries(wanted.map((c) => [c, row[c] ?? null])) });
        db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(uid, id);
        const after = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id);
        if (String(after?.user_id ?? '') !== uid) return { ok: false, action: 'refused', error: 'retag-verify-failed: 改标后读回的不是目标 uid', backup, sourceAccount, targetAccount: uid };

        const cur = currentAccount(variant, ctx);
        if (cur?.id && cur.id !== uid) warnings.push(`target-not-current-login: 目标 uid 不是当前登录账号（当前 ${cur.id}）；宿主列表按 user_id = 当前登录过滤，切过去后要在宿主里登进这个账号才看得见`);
        if (!isDir(path.join(workbuddyRoot(ctx, variant).path, uid))) warnings.push('sidebar-snapshot-absent: 目标账号在本机还没有目录（宿主自管的侧栏快照缓存），我们不会替它造');
        return { ok: true, action: 'retagged', path: dbFile, backup, sourceAccount, targetAccount: uid, warnings };
      } catch (err) {
        return { ok: false, action: 'refused', error: `switch-failed: ${err?.message ?? err}` };
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    },

    /**
     * --apply 前置自愈（D3 的安全边界全在这里）：
     *   只把**我们自己写过的行**（正文首行带 session-sync 标记）改标到当前登录 uid；
     *   宿主原生行、别人账号的行一律不动；逐行按 id 更新，绝不做整库 UPDATE。
     */
    repair(ctx, { account = null } = {}) {
      const warnings = [];
      const dbFile = indexDbFile(ctx, variant);
      if (!dbFile || !fs.existsSync(dbFile)) return { ok: true, retagged: 0, nativeUntouched: 0, warnings };
      let db;
      try {
        db = openIndexDb(dbFile);
      } catch (err) {
        return { ok: false, error: `index-db-open-failed: ${err?.message ?? err}`, retagged: 0, nativeUntouched: 0, warnings };
      }
      try {
        // --account 决定改标归属（与新建行同口径）；没有就取当前登录 uid
        const picked = pickUserId(ctx, variant, { account });
        const target = picked.source === 'target-default' ? null : picked.uid;
        if (!target) {
          warnings.push('account-snapshot-missing: 读不到 primary.uid，未改标任何行');
          return { ok: true, retagged: 0, nativeUntouched: 0, warnings };
        }
        const rows = db.prepare('SELECT id, user_id FROM sessions WHERE user_id IS NOT NULL').all();
        const upd = db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?');
        let ours = 0;
        let native = 0;
        let retagged = 0;
        for (const r of rows) {
          if (r.user_id === target) continue;
          if (!isImportedBody(ctx, variant, r.id)) {
            native++;
            continue;
          }
          ours++;
          upd.run(target, String(r.id));
          retagged++;
        }
        if (ours + native > 0) {
          warnings.push(`account-mismatch: 现库有 ${ours + native} 行属另一登录态，其中我们写的 ${ours} 行已改标，宿主原生 ${native} 行未动`);
        }
        return { ok: true, retagged, nativeUntouched: native, warnings };
      } catch (err) {
        return { ok: false, error: `retag-failed: ${err?.message ?? err}`, retagged: 0, nativeUntouched: 0, warnings };
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    },

    write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, title, account = null, scope = null }) {
      const warnings = [];
      // 归属列只认标量 id：传进来的是对象又抽不出 id 时，宁可整条不写，
      // 也不能把 "[object Object]" 钉进 user_id（宿主谓词是 user_id = 当前登录 uid，那样这条永远不可见）
      if (account && !accountIdOf(account)) {
        return { ok: false, error: `account-unusable: 账户里没有可用的 id（${JSON.stringify(account).slice(0, 80)}），未写入任何内容；用 --account <uid> 或修掉源侧账户字段` };
      }
      const root = projectsRoot(ctx, variant);
      if (!root) return { ok: false, error: 'projects-dir-unresolved' };
      const dir = resolveSlugDir(root, slugForWorkbuddy(session.cwd));
      // 正文在 projects/<cwd-slug>/<id>.jsonl，桶目录只是 cwd 的取值不参与搬迁。
      // 先用「复制」把目标文件建出来，索引行更新成功后再删旧文件（崩溃时旧文件还在，重跑自愈）
      const reloc = relocateByTargetId(root, targetId, dir, { ctx, variant, keepSource: true });
      if (reloc.moved) warnings.push(reloc.warning);
      const file = reloc.path ?? path.join(dir, `${targetId}.jsonl`);
      const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);

      let lines = 0;
      let backup = null;
      let concurrentRetries = 0;

      if (mode === 'append') {
        backup = backupIfExists(file, ctx, variant);
        let warnedNoParent = false;
        const res = appendJsonlRebuild(file, () => {
          const startParent = lastNodeId(file, 'id');
          if (!startParent && !warnedNoParent) {
            warnings.push('目标文件缺少可续接的 id，将以新链写入');
            warnedNoParent = true;
          }
          return buildLines(session, turns, targetId, startParent, provenance, { withHeader: false });
        });
        lines = res.lines;
        concurrentRetries = res.concurrentRetries;
      } else {
        const pre = preflightOverwrite(file, { force });
        if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
        const built = buildLines(session, turns, targetId, null, provenance, { withHeader: true, title: title ?? session.title });
        backup = backupIfExists(file, ctx, variant);
        writeJsonlFile(file, built);
        lines = built.length;
      }

      if (provenance) writeSidecarProvenance(file, provenance);

      // 索引必须紧跟正文写入；失败要让调用方看见（否则正文在、UI 看不到）
      const idx = upsertSessionIndex(ctx, variant, {
        targetId,
        title: title ?? session.title,
        cwd: session.cwd,
        scope: scope ?? session.scope ?? null,
        account,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
      for (const w of idx.warnings ?? []) warnings.push(w);
      if (!idx.ok) {
        return {
          ok: false,
          error: idx.error,
          hint: 'jsonl 已写入，但宿主索引未更新；修复后可重跑 import（会走 skip 并自愈索引）',
          targetId,
          path: file,
          lines,
          mode,
          backup,
          warnings,
        };
      }
      if (idx.skipped) warnings.push(`索引库不可用（${idx.skipped}），宿主可能需重启后才显示该会话`);

      // 索引已指向新目录 → 这时才删旧文件；删除失败只警告（旧文件留着不会丢历史）
      if (reloc.source) {
        try {
          fs.unlinkSync(reloc.source);
        } catch (err) {
          warnings.push(`old-file-remove-failed: ${String(err?.message ?? err)}`);
        }
      }

      return { ok: true, targetId, path: file, lines, mode, backup, warnings, index: idx, concurrentRetries };
    },
  };
}
