// readers/minimax.mjs — MiniMax Code
//
// 两套存储（新库优先）：
//  1) 文件型 v2 历史：<MINIMAX_HOME>/v2/sessions/<history_relative_dir>/messages.jsonl
//     （local_runtime_sessions.history_relative_dir 指向它；manifest.json 给时间戳）
//     行的 role 有五种（user / assistant / toolResult / custom / compactionSummary），
//     块与回执行的字段见 src/pi-agent-blocks.mjs —— 原生是 camelCase，不是 Anthropic 形状
//  2) 列式回退：local_runtime_message_rows.data_json {msg_content, thinking_content, usage}
// provenance 槽位：local_runtime_sessions.extra_data_json["session-sync"]（+ sidecar 兜底）
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS, configRoot, userDataDirsOf } from '../hosts.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, attachmentItem, metaItem, noteItem, finalizeSession, turnCoreFingerprint } from '../ir.mjs';
import { toPiBlock, toolResultItemOfRow } from '../pi-agent-blocks.mjs';
import { compactionInjectionKind, compactionSummaryText } from '../text.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { openDb, safeJson, tableExists, tableColumns, firstExisting, assembleTurns, deriveTitle, stripSystemInjections, parseJsonl, toMs, fileMtime, inTimeRange,
  parseArgs, outputText,
} from './base.mjs';
import { isFile, isDir, cmpPath } from '../util.mjs';
import { writeRootOf, roleRoots } from '../roots.mjs';
import { readLocalStorage } from '../leveldb.mjs';
import { previewTitle } from '../titles.mjs';

/**
 * 宿主主列表的谓词（实测本机 4 行里只有 1 行会出现在宿主列表：另外 3 行是
 * worker/explore/verifier 子代理）。缺列的老库自动跳过对应谓词，不能因此整表读空。
 * D3：这里绝不出现按账户的谓词。
 */
function hostVisibleSessions(db) {
  const cols = tableColumns(db, 'local_runtime_sessions');
  const has = (c) => cols.includes(c);
  const preds = [];
  if (has('columnar_version')) preds.push('columnar_version = 3');
  // 注意：**不**按 archived 过滤 —— 宿主主列表会滤掉归档行，但我们故意列出来（带 archived:true），
  // 否则「目标已存在」判定看不见归档行，重导会撞主键/重复创建（D1：归档只作存在性判定）
  if (has('visibility')) preds.push("(visibility IS NULL OR visibility <> 'hidden')");
  if (has('session_kind')) preds.push("(session_kind IS NULL OR session_kind NOT IN ('peek', 'cron'))");
  if (has('agent_name')) preds.push("(agent_name IS NULL OR agent_name IN ('mavis', 'main'))");
  if (has('parent_session_id')) preds.push('parent_session_id IS NULL');
  const where = preds.length ? `WHERE ${preds.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM local_runtime_sessions ${where}`).all();
}

// project_id → project_kind（实测本机只有 1 行 {project_id:1, project_kind:'default'}）
function projectKinds(db) {
  const map = new Map();
  if (!tableExists(db, 'local_runtime_projects')) return map;
  for (const p of db.prepare('SELECT project_id, project_kind FROM local_runtime_projects').all()) {
    map.set(Number(p.project_id), String(p.project_kind ?? ''));
  }
  return map;
}

/**
 * 默认工作区 = 宿主的非项目桶 `~/.minimax/sessions/<session_id>/workspace`（实测 4/4）。
 * 内部路径不能当 cwd 往外传，否则下游一律按项目目录分类 → 幽灵项目。
 */
function workspaceOf(row, kinds) {
  const internalPath = row.workspace_dir || '';
  const isDefault = Number(row.is_default_workspace) === 1 || kinds.get(Number(row.project_id)) === 'default';
  if (isDefault) return { cwd: '', scope: 'none', internalPath };
  return { cwd: row.project_workspace_dir || internalPath, scope: null, internalPath };
}

function dbFile(ctx) {
  return firstExisting(roleRoots('minimax', ctx, 'db').filter((x) => x.kind === 'file'))?.path ?? null;
}

// 宿主是 Electron：userData 在 %APPDATA%/MiniMax（本机实测），Local Storage 是 LevelDB
function leveldbDir(ctx) {
  const cands = [
    ...userDataDirsOf(ctx, 'minimax').map((x) => x.path),
  ];
  return cands.find((d) => isDir(d)) ?? cands[0];
}

/**
 * 项目名（= 工作区名）的宿主协议：UI 支持给项目组改名，**只写 renderer localStorage**：
 *   - 本地项目组：`mavis:sidebar:projectGroupPrefs:v1` → `{aliases: {<规范化 workspaceDir>: 名字}}`
 *   - 远端项目：`mavis.remote-control.project-aliases.v1:<account>` → `{"<bindingId>:<规范化 workspaceDir>": 名字}`
 * 宿主默认标签 = workspaceDir 末段；alias 不存在（没改过名）就返回空，由展示层回退。
 * 只读：解析失败一律当作没有。
 */
function projectAliases(ctx) {
  const map = new Map();
  let entries;
  try {
    entries = readLocalStorage(leveldbDir(ctx));
  } catch {
    return map;
  }
  const add = (dir, name) => {
    const key = cmpPath(dir);
    const value = String(name ?? '').trim();
    if (key && value) map.set(key, value);
  };

  for (const [key, value] of entries) {
    if (!key.startsWith('mavis.remote-control.project-aliases.v1:')) continue;
    let obj;
    try {
      obj = JSON.parse(value);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [k, name] of Object.entries(obj)) {
      const i = k.indexOf(':');
      if (i >= 0) add(k.slice(i + 1), name);
    }
  }

  // 本地项目组最后写：同一目录以本地 alias 为准
  for (const [key, value] of entries) {
    if (key !== 'mavis:sidebar:projectGroupPrefs:v1') continue;
    let obj;
    try {
      obj = JSON.parse(value);
    } catch {
      continue;
    }
    const aliases = obj?.aliases;
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) continue;
    for (const [dir, name] of Object.entries(aliases)) add(dir, name);
  }
  return map;
}

// 文件型历史根：<home>/v2/sessions
function historyRoot(ctx) {
  // 历史根按 role 取（声明层已登记 MINIMAX_HOME）：根被搬走时读侧跟着走
  return writeRootOf('minimax', ctx, 'history')?.path ?? path.join(configRoot(ctx, 'minimax'), 'v2', 'sessions');
}

function provenanceOf(row) {
  const extra = safeJson(row?.extra_data_json, null);
  return provenanceFromObject(extra && extra['session-sync']) || null;
}

// 宿主的一条 tool_call → IR 的「调用」+「回执」两件。
// 宿主一条 tool_call 自带入参与结果（真机原生行口径）：
//   {tool_name, tool_call_id, tool_call_status(1/2/3), tool_call_args(JSON串), tool_call_result_data(JSON串)}
// IR 是两件 —— 这里按同一口径拆回去，工具名/入参/结果都不丢。
// （早先只认 Anthropic 的 {id,name,arguments} 形状，读原生行时工具名与入参全丢 ——
//  往返一次核心指纹就变了，循环导入必判成分叉。）
function toToolCallItems(call, ts) {
  if (!call || typeof call !== 'object') return [];
  const name = call.tool_name ?? call.name ?? call.function?.name ?? 'tool';
  const id = call.tool_call_id ?? call.id ?? null;
  const argsRaw = call.tool_call_args ?? call.arguments ?? call.function?.arguments;
  const out = [toolCallItem(id, name, parseArgs(argsRaw), ts)];
  const raw = call.tool_call_result_data ?? call.result;
  if (raw !== undefined && raw !== null && raw !== '') {
    const status = Number(call.tool_call_status) === 3 ? 'error' : 'ok';
    out.push(toolResultItem(id, name, status, outputText(typeof raw === 'string' ? safeParse(raw) ?? raw : raw), ts));
  }
  return out;
}

// JSON 串 → 对象；不是合法 JSON 就原样返回（交给调用方当文本处理）
function safeParse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

// 一条 v2 消息 → 条目
//
// 行的 role 有五种（真机全量取证）：user / assistant / toolResult / custom / compactionSummary。
// 早先写成「不是 user 就是 assistant」—— toolResult 行于是变成助手正文：导入后每一屏文件内容
// 都显示成模型自己说的话，而真正的工具调用（toolCall 块）反而被丢掉，目标宿主里一个工具调用都不剩。
function toEntry(rec, fallbackTs) {
  const msg = rec?.message ?? rec ?? {};
  const rawRole = String(msg.role ?? '').trim().toLowerCase();
  const ts = toMs(rec?.timestamp ?? rec?.created_at_ms ?? msg.timestamp) || fallbackTs;

  // 工具回执：独立一行，带 toolCallId/toolName/isError —— 直接成 tool_result 条目
  if (rawRole === 'toolresult' || rawRole === 'tool_result') {
    return { role: 'tool', ts, items: [toolResultItemOfRow(msg, ts)] };
  }
  // 宿主注入的内部提醒（session_identity_reminder / todo_cadence_reminder …）：
  // display:false = 宿主自己都不显示，搬过去只会凭空多出 <system-reminder> 气泡
  if (rawRole === 'custom') {
    if (msg.display === false) return null;
    const t = String(msg.content ?? '');
    return t ? { role: 'system', ts, items: [noteItem(t, ts)] } : null;
  }
  // 压缩摘要是宿主上下文管理产物（{role, summary}，无 content 块）：不搬
  if (rawRole === 'compactionsummary') return null;

  const role = rawRole === 'user' ? 'user' : 'assistant';
  const items = [];
  const content = msg.content;
  if (typeof content === 'string') {
    const t = role === 'user' ? stripSystemInjections(content) : content;
    if (t) items.push(messageItem(role, t, ts));
  } else if (Array.isArray(content)) {
    // 工具名回填：块里没带 name 就按 id 从同一行的 tool_use 关联回来
    const nameById = new Map();
    for (const c of content) {
      const b = toPiBlock(c);
      if (b?.type === 'tool_use' && b.id) nameById.set(String(b.id), b.name);
    }
    for (const c of content) {
      const b = toPiBlock(c);
      if (!b) continue;
      if (b.type === 'text') {
        const t = role === 'user' ? stripSystemInjections(b.text) : b.text;
        if (t) {
          // 归一化：compact 位（新口径）或内容标签壳（旧口径）→ 剥壳裸正文 + compact 位
          const compact = (c.compact === true || b.compact === true || compactionInjectionKind(t) !== null) && role === 'user';
          const body = compact ? compactionSummaryText(t) : t;
          if (body.trim()) items.push(messageItem(role, body, ts, compact));
        }
      } else if (b.type === 'thinking') {
        if (b.thinking) items.push(reasoningItem(b.thinking, ts));
      } else if (b.type === 'tool_use') {
        items.push(toolCallItem(b.id, b.name ?? 'tool', b.input ?? null, ts));
      } else if (b.type === 'tool_result') {
        const name = b.name ?? nameById.get(String(b.tool_use_id)) ?? 'tool';
        items.push(toolResultItem(b.tool_use_id, name, b.is_error ? 'error' : 'ok', outputText(b.content) ?? '', ts));
      } else if (b.type === 'image') {
        items.push(attachmentItem(b.path || 'image', 'image', ts));
      }
    }
  }
  for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    items.push(...toToolCallItems(call, ts));
  }
  for (const att of Array.isArray(msg.attachments) ? msg.attachments : []) {
    const ref = att?.filePath ?? att?.file_path ?? att?.path ?? '';
    if (ref) items.push(attachmentItem(ref, att?.type ?? 'image', ts));
  }
  if (items.length === 0) return null;
  return { role, ts, items };
}

function readV2Messages(dir) {
  const file = path.join(dir, 'messages.jsonl');
  if (!isFile(file)) return null;
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = safeJson(isFile(manifestPath) ? fs.readFileSync(manifestPath, 'utf8').trim() || '{}' : '{}', {}) || {};
  // 全量读：list 与 read 必须同口径（m53）。早先 list 走采样（大文件读头尾），
  // 于是同一个会话 list 报 1 轮、read 报 67 轮 —— 用户按 list 挑会话，挑到的是错的。
  const text = fs.readFileSync(file, 'utf8');
  const lines = parseJsonl(text);
  const entries = [];
  // 文件里出现过的 turn_id：判「文件是不是缺了我们自己写的那几轮」要用
  const turnIds = new Set();
  let createdAt = toMs(manifest.createdAtMs) || 0;
  let updatedAt = toMs(manifest.updatedAtMs) || 0;
  for (const rec of lines) {
    if (rec?.turn_id) turnIds.add(String(rec.turn_id));
    const e = toEntry(rec, createdAt);
    if (!e) continue;
    if (e.ts) {
      if (!createdAt) createdAt = e.ts;
      if (e.ts > updatedAt) updatedAt = e.ts;
    }
    entries.push(e);
  }
  return {
    entries,
    turnIds,
    createdAt,
    updatedAt: updatedAt || fileMtime(file),
  };
}

function readRowMessages(db, sessionId) {
  if (!tableExists(db, 'local_runtime_message_rows')) return { entries: [], ourEntries: [], createdAt: 0, updatedAt: 0 };
  const rows = db.prepare('SELECT * FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id').all(sessionId);
  const entries = [];
  // **我们自己写的那几轮**：DB 行带 session-sync-content 就是我们的行。
  // 判「规范文件是不是缺了我们写的那几轮」要用它（老版本导入只写 DB 行，文件被宿主物化遮住）。
  const ourEntries = [];
  let createdAt = 0;
  let updatedAt = 0;
  for (const r of rows) {
    const d = safeJson(r.data_json, {}) || {};
    const role = (r.role || d.role) === 'user' ? 'user' : 'assistant';
    const ts = toMs(r.created_at_ms) || toMs(d.timestamp) || 0;
    if (ts) {
      if (!createdAt) createdAt = ts;
      if (ts > updatedAt) updatedAt = ts;
    }
    // 导入行把完整部件数组放在 session-sync-content（带块级 role）里：一行 = 一条消息，
    // 块内再按 role 分组（兼容旧版「一轮一行」的混合块行），assembleTurns 才能还原轮次边界。
    // 宿主原生行没这个键，走下面的宿主字段分支。
    const richBlocks = Array.isArray(d['session-sync-content']) ? d['session-sync-content'] : null;
    if (richBlocks) {
      // **不能再叠加 d.tool_calls**：那是同一批工具调用的宿主渲染副本（叠加会把每个调用数两遍
      // → 核心指纹变 → 下一次导入被判成 fork）。richBlocks 里的 π 块才是无损来源。
      const groups = [];
      for (const b of richBlocks) {
        const r2 = b?.role === 'user' || b?.role === 'assistant' ? b.role : role;
        const last = groups[groups.length - 1];
        if (last && last.role === r2) last.content.push(b);
        else groups.push({ role: r2, content: [b] });
      }
      let pushed = 0;
      for (const g of groups) {
        const e = toEntry({ message: { role: g.role, content: g.content }, timestamp: ts }, ts);
        if (!e) continue;
        entries.push({ ...e, ts });
        ourEntries.push({ ...e, ts });
        pushed++;
      }
      if (pushed) continue;
    }
    // 宿主原生行：role / msg_content / thinking_content / tool_calls
    const items = [];
    const content = role === 'user' ? stripSystemInjections(d.msg_content) : d.msg_content;
    if (content) items.push(messageItem(role, content, ts));
    if (d.thinking_content) items.push(reasoningItem(d.thinking_content, ts));
    for (const call of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      items.push(...toToolCallItems(call, ts));
    }
    for (const att of Array.isArray(d.attachments) ? d.attachments : []) {
      const ref = att?.filePath ?? att?.file_path ?? att?.path ?? '';
      if (ref) items.push(attachmentItem(ref, att?.type ?? 'image', ts));
    }
    if (d.usage?.total_tokens) items.push(metaItem('usage', d.usage, ts));
    if (items.length === 0) items.push(metaItem('msg_type', d.msg_type ?? null, ts));
    entries.push({ role, ts, items });
  }
  return { entries, ourEntries, createdAt, updatedAt };
}

/**
 * 正文取数（list 与 read 共用这一处口径 —— 两个数必须一样）。
 *
 * 文件优先（照宿主自己的取数链：messages.jsonl → 账本快照 → DB 行 → blob），
 * **但文件不完整时以 DB 行为准**：
 *
 * 真机症状（2026-11-23）：老版本导入 minimax 时只写 DB 行、不写规范历史文件，
 * 宿主首次物化会话时只发布一个**空文件** —— 空文件就是模型上下文的唯一来源，
 * 于是导入正文在模型上下文里消失（界面消息列表仍看得到，它读 DB 行）。
 * 本机现场：4 条会话的规范文件少了 1–64 轮导入正文（其中一条少了整整 64 轮）。
 *
 * 判据用**内容**而不是 turn_id：宿主可能用自己的 turn_id 把我们的行重新物化进文件
 * （内容一样、id 不同），那种情况文件是完整的；只有内容真的不在文件里才算不完整。
 * 判据只认「我们自己写的那几轮」（DB 行带 session-sync-content 的），
 * 宿主自己写的内容一个字都不影响取数选择。
 */
function pickBody(db, row, dir) {
  const v2 = dir ? readV2Messages(dir) : null;
  const rows = readRowMessages(db, row.session_id);
  const fileEntries = v2?.entries ?? [];
  if (!fileEntries.length) {
    // 文件是空的（宿主物化出来的空文件）：有我们写的行就说明正文被遮住了
    return { entries: rows.entries, storage: 'message-rows', v2, rows, fileIncomplete: rows.ourEntries.length > 0 };
  }
  if (!rows.ourEntries.length) return { entries: fileEntries, storage: 'v2-files', v2, rows, fileIncomplete: false };
  const fileFp = new Set(assembleTurns(fileEntries).map(turnCoreFingerprint));
  const missing = assembleTurns(rows.ourEntries).some((t) => !fileFp.has(turnCoreFingerprint(t)));
  if (missing) return { entries: rows.entries, storage: 'message-rows', v2, rows, fileIncomplete: true };
  return { entries: fileEntries, storage: 'v2-files', v2, rows, fileIncomplete: false };
}

/**
 * 我们自己写的那几轮里，**文件里还没有**的那些（以 IR 轮次给出，按时间顺序）。
 *
 * 判据用**内容**（核心指纹）而不是 turn_id：宿主可能用自己的 turn_id 把我们的行
 * 重新物化进文件（内容一样、id 不同）—— 那种情况文件是完整的，
 * 按 id 判会把同一轮再补一遍，文件里就出现两次同样的内容。
 *
 * 写侧（`src/writers/minimax.mjs` 的自愈）用它决定「往文件里补哪几轮」。
 *
 * @param db 已打开的 minimax 库
 * @param sessionId 会话 id
 * @param dir 规范历史目录（可为 null —— 没有文件就等于全缺）
 * @returns {Array<object>} 缺失轮次的 IR（可直接交给写侧的 IR → 文件行转换）
 */
export function missingImportedTurns(db, sessionId, dir) {
  const rows = readRowMessages(db, sessionId);
  if (!rows.ourEntries.length) return [];
  const v2 = dir ? readV2Messages(dir) : null;
  const fileFp = new Set(assembleTurns(v2?.entries ?? []).map(turnCoreFingerprint));
  return assembleTurns(rows.ourEntries).filter((t) => !fileFp.has(turnCoreFingerprint(t)));
}

function isGenericTitle(t) {
  return !t || /^(main|new chat|untitled|新会话|新对话)$/i.test(String(t).trim());
}

// 首条用户文本；无用户发言时（如仅 greeting 的会话）退化为首条助手文本
function previewOf(entries) {
  const firstUser = entries.find((e) => e.role === 'user');
  const pick = (e) => e?.items?.find((i) => i.kind === 'message')?.text ?? '';
  const text = pick(firstUser) || pick(entries.find((e) => e.role === 'assistant')) || '';
  // greeting 会话正文以 <greeting-message /> 自闭合标签开头，去掉后才是可读标题
  return text.replace(/^<greeting-message\s*\/>\s*/i, '').trim();
}

export const minimaxReader = {
  variant: 'minimax',
  label: 'MiniMax Code',

  available(ctx) {
    const f = dbFile(ctx);
    return !!f && isFile(f);
  },

  list(ctx, opts = {}) {
    const file = dbFile(ctx);
    if (!file) return [];
    const db = openDb(file);
    try {
      if (!tableExists(db, 'local_runtime_sessions')) return [];
      const rows = hostVisibleSessions(db);
      const kinds = projectKinds(db);
      const aliases = projectAliases(ctx);
      const root = historyRoot(ctx);
      const out = [];
      for (const row of rows) {
        const rel = row.history_relative_dir;
        const dir = rel ? path.join(root, rel) : null;
        // 轮次口径必须与 read **完全一致**（m53 棘轮）：list 这里**不采样**。
        // 采样得到的是近似值，而 read 读的是全量 —— 同一个会话两个数，
        // 用户按 list 挑会话、按 0 轮过滤，看到的都是错的。
        // 同源同算法：同一份 entries、同一套 assembleTurns 口径，list.turns 必然等于 read 的轮次。
        const body = pickBody(db, row, dir);
        const entries = body.entries;
        const preview = previewOf(entries);
        const { cwd, scope, internalPath } = workspaceOf(row, kinds);
        out.push({
          id: row.session_id,
          variant: 'minimax',
          title: isGenericTitle(row.title) ? previewTitle(preview) || row.title || 'untitled' : row.title,
          preview: String(preview).replace(/\s+/g, ' ').slice(0, 120),
          cwd,
          projectName: cwd ? aliases.get(cmpPath(cwd)) ?? '' : '',
          scope,
          internalPath,
          createdAt: toMs(row.created_at_ms) || v2?.createdAt || 0,
          updatedAt: fileMtime(dir ?? file) || toMs(row.updated_at_ms) || v2?.updatedAt || 0,
          turns: assembleTurns(entries).length,
          turnsApprox: false,
          model: safeJson(row.record_json, null)?.model ?? null,
          provenance: provenanceOf(row) || (dir ? readSidecarProvenance(path.join(dir, 'messages.jsonl')) : null),
          sourcePath: dir ?? file,
          // 归档不当筛选条件（D1：只标记，由 planImport 拦），保证存在性判定还能看见它们
          archived: row.archived != null ? Number(row.archived) === 1 : false,
        });
      }
      return out.filter((s) => inTimeRange(s, opts));
    } finally {
      db.close();
    }
  },

  read(ctx, id) {
    const file = dbFile(ctx);
    if (!file) return null;
    const db = openDb(file);
    try {
      if (!tableExists(db, 'local_runtime_sessions')) return null;
      const row = db.prepare('SELECT * FROM local_runtime_sessions WHERE session_id = ?').get(id);
      if (!row) return null;

      const root = historyRoot(ctx);
      const dir = row.history_relative_dir ? path.join(root, row.history_relative_dir) : null;
      // 取数口径与 list 完全一致（同一处 pickBody）—— 两个数必须一样
      const body = pickBody(db, row, dir);
      const entries = body.entries;
      const v2 = body.v2;

      const turns = assembleTurns(entries);
      const prov = provenanceOf(row) || (dir ? readSidecarProvenance(path.join(dir, 'messages.jsonl')) : null);
      const ws = workspaceOf(row, projectKinds(db));
      const session = makeSession({
        id: row.session_id,
        variant: 'minimax',
        title: deriveTitle(isGenericTitle(row.title) ? previewOf(turns) : row.title, turns),
        cwd: ws.cwd,
        scope: ws.scope,
        createdAt: toMs(row.created_at_ms) || v2?.createdAt || 0,
        updatedAt: toMs(row.updated_at_ms) || v2?.updatedAt || 0,
        model: safeJson(row.record_json, null)?.model ?? null,
        turns,
        meta: {
          sourcePath: dir ?? file,
          internalPath: ws.internalPath,
          agent: row.agent_name ?? null,
          parentId: row.parent_session_id ?? null,
          sessionKind: row.session_kind ?? null,
          storage: body.storage,
          // 文件不完整（缺了我们自己写的那几轮）时正文取自 DB 行 —— 如实标出来
          fileIncomplete: body.fileIncomplete,
        },
      });
      applyProvenanceToIR(session, prov);
      return finalizeSession(session);
    } finally {
      db.close();
    }
  },
};
