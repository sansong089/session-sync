// writers/cline.mjs — 写 Cline / Kilo（Cline 血统）
//
// Cline 4.x（2026-10-27 从 marketplace 4.1.26 源码取证）已把列表迁到「会话库」：
//   <data>/sessions/<id>/<id>.json（manifest v1，zod 校验）
//   <data>/sessions/<id>/<id>.messages.json（{version,messages:[{id,role,content,ts}]}）
//   <data>/db/sessions.db 的 sessions 表（NOT NULL 列很多，见 CLINE_SESSIONS_DDL）
//   <data> = CLINE_DATA_DIR || ~/.cline/data
// `state/taskHistory.json` 只剩 LegacyStateReader 迁移读取 → 写它不进主列表，本实现不写。
// Kilo 7.8.18 已改为服务端列表（/sync/history + sessionImport），本机 5.16.2 仍读
// `context.globalState.get("taskHistory")`（= 共享 state.vscdb 的 `kilocode.kilo-code` 行）→
// Kilo 侧写「任务目录 + taskHistory 索引」，并在文档里标明最新版是服务端契约。
// provenance：Cline 会话库放 manifest.metadata["session-sync"]；legacy 任务目录放 task_metadata.json。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS, clineDataRoot } from '../hosts.mjs';
import { insertRowFiltered, newNodeId, readJsonStrict, unreadableTarget, writeJsonFilePretty, backupIfExists, outputText } from './base.mjs';
import { ensureDir, isFile } from '../util.mjs';
import { candidateRoots, writeRootOf, roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';

function tasksRoots(ctx, variant = 'cline') {
  // 只认任务目录形态（显式 tasks role）；data/sessions 是另一种（三代）落点，不能当写入根
  return candidateRoots(variant, ctx).filter((x) => x.kind === 'dir' && x.role === 'tasks').map((x) => x.path);
}

function clineSessionsDir(ctx) {
  // 会话库目录按 role 取（声明层已登记 env 优先级）：根被 --data-root / env 搬走时写侧跟着走，
  // 不再在这里重抄一遍 env 链（抄一遍就等于多一套「根在哪」的答案）
  return writeRootOf('cline', ctx, 'sessions')?.path ?? path.join(clineDataRoot(ctx).path, 'sessions');
}

function clineDbPath(ctx) {
  return writeRootOf('cline', ctx, 'sessionsIndex')?.path ?? path.join(clineDataRoot(ctx).path, 'db', 'sessions.db');
}

const CLINE_SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  status TEXT NOT NULL,
  status_lock INTEGER NOT NULL DEFAULT 0,
  interactive INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  team_name TEXT,
  enable_tools INTEGER NOT NULL,
  enable_spawn INTEGER NOT NULL,
  enable_teams INTEGER NOT NULL,
  parent_session_id TEXT,
  parent_agent_id TEXT,
  agent_id TEXT,
  conversation_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  metadata_json TEXT,
  transcript_path TEXT NOT NULL DEFAULT '',
  hook_path TEXT NOT NULL,
  messages_path TEXT,
  updated_at TEXT NOT NULL
)`;

const iso = (ms) => new Date(Number(ms) > 0 ? Number(ms) : Date.now()).toISOString();

function firstUserText(session) {
  for (const turn of session.turns ?? []) {
    for (const it of turn.items ?? []) {
      if (it.kind === 'message' && it.role === 'user' && it.text) return String(it.text);
    }
  }
  return String(session.title ?? '');
}

/** 会话库里的消息：宿主格式 {id, role, content:[{type:...}], ts}（与 Anthropic 只差一层壳） */
function toStoreMessages(turn, session, seqRef) {
  const out = [];
  for (const m of turnToApiMessages(turn, session)) {
    out.push({ id: `msg_${String(seqRef.next++).padStart(6, '0')}_${newNodeId().slice(0, 8)}`, role: m.role, content: m.content, ts: m.ts });
  }
  return out;
}

function writeClineStore(ctx, variant, { session, targetId, mode, fromTurnIndex, provenance, force }) {
  const warnings = [];
  const dir = path.join(clineSessionsDir(ctx), String(targetId));
  const manifestFile = path.join(dir, `${targetId}.json`);
  const messagesFile = path.join(dir, `${targetId}.messages.json`);
  const dbFile = clineDbPath(ctx);

  const exists = isFile(manifestFile);
  if (exists && mode !== 'append' && !force) return { ok: false, error: 'target-exists', path: dir, targetId, warnings };

  const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
  // 追加要把既有 messages.json 整份重写：解不开却当成空，会把该 id 的权威正文换成只有增量
  const prevRes = mode === 'append' ? readJsonStrict(messagesFile) : { ok: true, value: null };
  if (!prevRes.ok) return { ok: false, error: unreadableTarget(messagesFile, prevRes.reason), path: messagesFile, targetId, warnings };
  const prev = prevRes.value || {};
  const prevMessages = Array.isArray(prev.messages) ? prev.messages : [];
  // 追加到「正文只在 legacy 任务目录里」的原生会话：会话库这份文档一建出来就是该 id 的权威正文
  // （读侧它排在任务目录之前），只写增量会让前面的轮次凭空消失 → 必须整份写全
  const appendIntoFreshStore = mode === 'append' && prevMessages.length === 0;
  const effTurns = appendIntoFreshStore ? (session.turns ?? []) : turns;
  if (appendIntoFreshStore) warnings.push('append-materialize: 目标正文原在 legacy 任务目录，会话库按整份会话落盘');
  const seqRef = { next: prevMessages.length };
  const messages = prevMessages.slice();
  for (const turn of effTurns) messages.push(...toStoreMessages(turn, session, seqRef));

  const startedAt = iso(session.createdAt);
  const updatedAt = iso(session.updatedAt || session.createdAt);
  const prompt = firstUserText(session);
  // 追加时保留盘上已有的 metadata：标题是宿主/用户可能改过的字段，拿推导标题覆盖
  // 等于在 UI 上把好名字换成半句话；顺带别把宿主写进去的其它键抹掉（我们是整份重写 manifest）
  const prevMetaRes = mode === 'append' && exists ? readJsonStrict(manifestFile) : { ok: true, value: null };
  const prevMeta = prevMetaRes.value?.metadata && typeof prevMetaRes.value.metadata === 'object' ? prevMetaRes.value.metadata : {};
  const keptTitle = String(prevMeta.title ?? '').trim();
  const manifest = {
    version: 1,
    session_id: String(targetId),
    source: 'vscode',
    pid: process.pid,
    started_at: startedAt,
    ended_at: updatedAt,
    status: 'completed',
    interactive: true,
    provider: 'session-sync',
    model: String(session.model || 'unknown'),
    cwd: String(session.cwd ?? ''),
    workspace_root: String(session.cwd ?? ''),
    enable_tools: true,
    enable_spawn: true,
    enable_teams: false,
    prompt,
    messages_path: messagesFile,
    metadata: {
      ...prevMeta,
      title: keptTitle || fitTitleFor(variant, session.title || prompt).value,
      totalCost: prevMeta.totalCost ?? 0,
      isFavorited: prevMeta.isFavorited ?? false,
      ...(provenance ? { 'session-sync': provenance } : {}),
    },
  };

  ensureDir(dir);
  const backup = backupIfExists(messagesFile, ctx, variant);
  writeJsonFilePretty(messagesFile, { version: 1, updated_at: updatedAt, agent: 'lead', sessionId: String(targetId), messages });
  writeJsonFilePretty(manifestFile, manifest);

  // sessions.db：没有就按宿主 DDL 自建；有就先备份再 upsert
  try {
    ensureDir(path.dirname(dbFile));
    backupIfExists(dbFile, ctx, variant);
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      // 自建表：列集由 CLINE_SESSIONS_DDL 定义（我们自己的 DDL）—— 不存在「宿主换版本增删列」
      // 的风险，所以这里可以硬编码列名（与其它 writer 的「按实际列裁剪」口径不同，原因是自建表）。
      db.exec(CLINE_SESSIONS_DDL);
      db.prepare(
        `INSERT INTO sessions (session_id, source, pid, started_at, ended_at, exit_code, status, status_lock, interactive,
           provider, model, cwd, workspace_root, team_name, enable_tools, enable_spawn, enable_teams,
           parent_session_id, parent_agent_id, agent_id, conversation_id, is_subagent, prompt, metadata_json,
           transcript_path, hook_path, messages_path, updated_at)
         VALUES (?,?,?,?,?,NULL,?,0,1,?,?,?,?,NULL,1,1,0,NULL,NULL,NULL,NULL,0,?,?, '', '', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           ended_at = excluded.ended_at, status = excluded.status, provider = excluded.provider,
           model = excluded.model, cwd = excluded.cwd, workspace_root = excluded.workspace_root,
           prompt = excluded.prompt, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
      ).run(
        String(targetId),
        manifest.source,
        process.pid,
        startedAt,
        updatedAt,
        manifest.status,
        manifest.provider,
        manifest.model,
        manifest.cwd,
        manifest.workspace_root,
        prompt.slice(0, 1000),
        JSON.stringify(manifest.metadata),
        messagesFile,
        updatedAt,
      );
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, error: `cline-index-write-failed: ${String(err?.message ?? err)}`, targetId, path: messagesFile, warnings };
  }

  return { ok: true, targetId: String(targetId), path: messagesFile, lines: messages.length, mode, backup, warnings };
}

function turnToApiMessages(turn, session) {
  const out = [];
  // 同一轮里连续同角色的块并进同一条消息：宿主就是这样存的（一条 assistant 消息带 text+tool_use 多个块），
  // 而「一条含文本的 user 消息」在读侧就是新轮次的边界。逐块各发一条会把一轮拆成多轮，
  // 于是 legacy 任务目录读出的轮次 ≠ 会话库读出的轮次，跨形态收敛全部误判成 fork。
  let cur = null;
  const push = (role, block, ts) => {
    if (cur && cur.role === role) {
      cur.content.push(block);
      if (ts) cur.ts = ts;
      return;
    }
    cur = { role, content: [block], ts };
    out.push(cur);
  };
  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    switch (it.kind) {
      case 'message':
        push(it.role === 'user' ? 'user' : 'assistant', { type: 'text', text: it.text }, ts);
        break;
      case 'reasoning':
        // reasoning 不进 api_conversation_history：Cline 该文件只有 text/tool_use/tool_result，
        // 写成 text 会被读回成普通消息，污染会话骨架。reasoning 只写 ui_messages。
        break;
      case 'tool_call':
        push('assistant', { type: 'tool_use', id: it.callId || newNodeId(), name: it.name || 'tool', input: it.input ?? {} }, ts);
        break;
      case 'tool_result':
        push('user', { type: 'tool_result', tool_use_id: it.callId || null, content: outputText(it.output) ?? '' }, ts);
        break;
      default:
        break;
    }
  }
  return out;
}

function turnToUiMessages(turn, session) {
  const out = [];
  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    if (it.kind === 'message' && it.role === 'user') out.push({ ts, type: 'say', say: 'user_feedback', text: it.text });
    else if (it.kind === 'message' && it.text) out.push({ ts, type: 'say', say: 'text', text: it.text });
    else if (it.kind === 'reasoning' && it.text) out.push({ ts, type: 'say', say: 'reasoning', text: it.text });
    else if (it.kind === 'tool_call') out.push({ ts, type: 'say', say: 'tool', text: JSON.stringify({ tool: it.name, input: it.input ?? null }) });
    else if (it.kind === 'tool_result') out.push({ ts, type: 'say', say: 'tool', text: outputText(it.output) ?? '' });
  }
  return out;
}

/**
 * Kilo（≤5.16.2 的有效契约）：列表读共享 state.vscdb 里 `kilocode.kilo-code` 这一行的
 * globalState JSON，其中 `taskHistory` 是数组。键名/条目形态来自 5.16.2 安装包 zod schema。
 * 7.8.18 已改为服务端列表（/sync/history），本地写入只对旧代生效 —— 见文首注释。
 */
function upsertKiloHistory(taskDir, ctx, variant, session, targetId, { keepTitle = false } = {}) {
  // taskDir = <globalStorage>/<扩展>/tasks/<id> → 上三级才是 globalStorage
  const gsDir = path.dirname(path.dirname(path.dirname(taskDir)));
  const dbFile = path.join(gsDir, 'state.vscdb');
  if (!isFile(dbFile)) return { skipped: 'kilo-index-absent' };
  backupIfExists(dbFile, ctx, variant);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 8000');
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'").get()) return { skipped: 'kilo-itemtable-absent' };
    db.exec('BEGIN IMMEDIATE');
    const KEY = 'kilocode.kilo-code';
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(KEY);
    let state = {};
    if (row) {
      const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value ?? '');
      try {
        state = JSON.parse(text) || {};
      } catch {
        state = {};
      }
    }
    const history = Array.isArray(state.taskHistory) ? state.taskHistory : [];
    const item = {
      id: String(targetId),
      number: 1,
      ts: Number(session.createdAt) || Date.now(),
      // 侧栏显示名的长度与标题同步口径保持一致（titles.mjs 的 TITLE_MAX），
      // 这里宽松截 2000 会让「同步改成 200 字」和「首次写入 2000 字」两处对不上
      task: fitTitleFor(variant, session.title || firstUserText(session)).value,
      tokensIn: 0,
      tokensOut: 0,
      totalCost: 0,
      size: JSON.stringify(session.turns ?? []).length,
      workspace: String(session.cwd ?? ''),
      mode: 'code',
      toolProtocol: 'native',
      apiConfigName: 'default',
      cacheWrites: 0,
      cacheReads: 0,
    };
    const idx = history.findIndex((x) => x && x.id === item.id);
    if (idx >= 0) {
      // 已有条目：`task` 是侧栏显示的名字，append 时不许被推导标题覆盖（宿主/用户可能改过名）
      const kept = keepTitle && String(history[idx]?.task ?? '').trim() ? { task: history[idx].task } : {};
      history[idx] = { ...history[idx], ...item, ...kept };
    } else {
      history.unshift(item);
    }
    state.taskHistory = history;
    const text = JSON.stringify(state);
    if (row) db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(text, KEY);
    // ItemTable 是 VS Code 的全局存储表（不是我们自建的 sessions），照同一口径走唯一出口
    else insertRowFiltered(db, 'ItemTable', [['key', KEY], ['value', text]]);
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return { error: String(err?.message ?? err) };
  } finally {
    db.close();
  }
}

export function createClineFamilyWriter({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    canWrite(ctx) {
      // Cline 4.x 走会话库（目录可自建）；legacy 系（kilo/roo）仍要求任务根存在
      if (variant === 'cline') return { ok: true };
      return tasksRoots(ctx, variant).length > 0 ? { ok: true } : { ok: false, reason: 'tasks-dir-unresolved' };
    },

    /**
     * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
     * cline 4.x 的标题在会话库 manifest 的 metadata.title（<data>/sessions/<id>/<id>.json）。
     * legacy 任务目录（kilo/roo）那一族不接槽：它的标题散在 taskHistory 索引与
     * api_conversation_history 里，没有单一落点 —— 与其猜一个写错位置，不如不写。
     */
    syncTitle: makeTitleSyncer((ctx) => (
      variant === 'cline'
        ? [{ kind: 'json-file', file: (c, targetId) => {
            const dir = path.join(clineSessionsDir(c), String(targetId));
            return path.join(dir, `${targetId}.json`);
          }, field: 'metadata.title', maxLen: TITLE_MAX.cline }]
        : []
    ), variant),

    targetPath(ctx, session, targetId) {
      if (variant === 'cline') return path.join(clineDataRoot(ctx).path, 'sessions', String(targetId), `${targetId}.messages.json`);
      const root = tasksRoots(ctx, variant)[0];
      return root ? path.join(root, String(targetId)) : null;
    },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    // Cline 4.x：主列表只读会话库，不再写 legacy 任务目录（避免我们自己的 reader 两边都读到）
    if (variant === 'cline') return writeClineStore(ctx, variant, { session, targetId, mode, fromTurnIndex, provenance, force });
    const warnings = [];
    const roots = tasksRoots(ctx, variant);
    if (roots.length === 0) return { ok: false, error: 'tasks-dir-unresolved' };

    // 复用已存在的任务目录（多 IDE 时取第一个含该任务的）
    let dir = null;
    for (const root of roots) {
      const cand = path.join(root, String(targetId));
      if (fs.existsSync(cand)) {
        dir = cand;
        break;
      }
    }
    if (!dir) dir = path.join(roots[0], String(targetId));

    const apiFile = path.join(dir, 'api_conversation_history.json');
    const uiFile = path.join(dir, 'ui_messages.json');
    const metaFile = path.join(dir, 'task_metadata.json');

    // 任务目录三个文件都是「解析后整份重写」：解不开当成空就会抹掉宿主已有正文，必须先判定再动盘
    const prevApiRes = readJsonStrict(apiFile);
    const prevUiRes = readJsonStrict(uiFile);
    const prevMetaRes = readJsonStrict(metaFile);
    if (!force) {
      for (const [f, r] of [[apiFile, prevApiRes], [uiFile, prevUiRes], [metaFile, prevMetaRes]]) {
        if (!r.ok) return { ok: false, error: unreadableTarget(f, r.reason), path: dir, targetId, warnings };
      }
    }
    const prevApi = Array.isArray(prevApiRes.value) ? prevApiRes.value : [];
    const prevUi = Array.isArray(prevUiRes.value) ? prevUiRes.value : [];
    if (!force && prevApi.length > 0 && mode !== 'append') {
      return { ok: false, error: 'target-exists', path: dir, targetId, warnings };
    }

    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    let api = mode === 'append' ? prevApi.slice() : [];
    let ui = mode === 'append' ? prevUi.slice() : [];
    // 任务目录里还没有正文（例如宿主只写了 ui_messages）：整份写全，否则追加会把前面的轮次丢掉
    if (mode === 'append' && prevApi.length === 0) {
      api = (session.turns ?? []).flatMap((turn) => turnToApiMessages(turn, session));
      ui = (session.turns ?? []).flatMap((turn) => turnToUiMessages(turn, session));
      warnings.push('append-materialize: 任务目录没有 API 正文，按整份会话落盘');
    } else {
      for (const turn of turns) {
        api.push(...turnToApiMessages(turn, session));
        ui.push(...turnToUiMessages(turn, session));
      }
    }

    ensureDir(dir);
    const backup = backupIfExists(apiFile, ctx, variant);
    writeJsonFilePretty(apiFile, api);
    writeJsonFilePretty(uiFile, ui);

    const prevMeta = prevMetaRes.value || {};
    const files = new Set((prevMeta.files_in_context || []).map((f) => f?.path).filter(Boolean));
    for (const turn of turns) {
      for (const it of turn.items ?? []) {
        if (it.kind === 'attachment' && it.ref) files.add(it.ref);
        if (it.kind === 'tool_call' && it.input?.path) files.add(it.input.path);
      }
    }
    writeJsonFilePretty(metaFile, {
      ...prevMeta,
      files_in_context: [...files].map((p) => ({ path: p, record_state: 'active', record_source: 'read_tool' })),
      ...(provenance ? { 'session-sync': provenance } : {}),
    });

    if (variant === 'kilo') {
      const idx = upsertKiloHistory(dir, ctx, variant, session, targetId, { keepTitle: mode === 'append' });
      if (idx.error) {
        return { ok: false, error: `kilo-index-write-failed: ${idx.error}`, targetId, path: dir, lines: api.length, mode, backup, warnings };
      }
      if (idx.skipped) warnings.push(`${idx.skipped}: Kilo 侧栏不会列出这条（任务目录已写）`);
    }

    return { ok: true, targetId: String(targetId), path: dir, lines: api.length, mode, backup, warnings };
  },
  };
}

export const clineWriter = createClineFamilyWriter({ variant: 'cline' });
