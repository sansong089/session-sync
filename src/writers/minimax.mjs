// writers/minimax.mjs — 写 MiniMax Code（只写 DB，不碰 revision 算法）
//
// 为什么可以只写 DB（本机 app.asar 取证）：
//   - 正文源选择链：messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows → sqliteBlob，
//     文件缺失时回退到 DB 行；
//   - canonical-history-materializer 会自己把 DB 行物化成 messages.jsonl 并计算 revision，
//     所以我们不需要复现 revisionOfNormalized()。
// 列表可见性的 6 个硬门（缺一项就完全不可见，出自 repo/drizzle.js + repo/list-predicates.js）：
//   columnar_version=3、agent_name IN ('mavis','main')、archived=0、visibility<>'hidden'、
//   session_kind NOT IN ('peek','cron')、parent_session_id IS NULL。
// 枚举严格（违规即 SQLITE_CONSTRAINT）：runtime ∈ {pi-agent, opencode}、session_type ∈ {root, branch}、
//   status ∈ {idle, started, error, aborted, interrupted}。
// local_runtime_projects 不用我们写：AFTER INSERT 触发器（columnar_version=3 时）自动建行并回填 project_id。
//
// **一行 = 一条消息**（真机原生行口径）：行的 role 就是这条消息自己的角色，
// 同一轮的所有消息共享一个 turn_id。整轮压成一行会让助手正文在宿主里消失，
// 详见 turnToMessageGroups 的注释。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS, configRoot } from '../hosts.mjs';
import { tableExists, tableColumns } from '../readers/base.mjs';
import { ensureDir, isFile, cmpPath, canonicalDirPath } from '../util.mjs';
import { writeRootOf, roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { insertRowFiltered, newNodeId, updateRowFiltered, appendFileAtomic } from './base.mjs';
import { firstExisting } from '../readers/base.mjs';
import { toNativeBlock, toolResultRowOfBlock } from '../pi-agent-blocks.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';
import { compactionInjectionKind } from '../text.mjs';

function dbFile(ctx) {
  return firstExisting(roleRoots('minimax', ctx, 'db').filter((x) => x.kind === 'file'))?.path ?? null;
}

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

// 宿主自己的历史文件（reader 的首选正文源）。它存在时追加必须写进文件 ——
// 取数链是 messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows，
// 只写 DB 行会被文件遮蔽（真机实测：append 返回成功但读回轮次不变）。
function historyFileOf(ctx, db, targetId) {
  // 历史根按 role 取（声明层已登记 MINIMAX_HOME）：根被搬走时写侧跟着走
  const root = writeRootOf('minimax', ctx, 'history')?.path ?? path.join(configRoot(ctx, 'minimax'), 'v2', 'sessions');
  if (!tableColumns(db, 'local_runtime_sessions').includes('history_relative_dir')) return null;
  const rel = db.prepare('SELECT history_relative_dir AS rel FROM local_runtime_sessions WHERE session_id = ?').get(targetId)?.rel;
  if (!rel) return null;
  const f = path.join(root, String(rel), 'messages.jsonl');
  return isFile(f) ? f : null;
}

// 一轮 IR → 宿主消息帧（**唯一实现**，两条写入路径共用）。
//
// 帧 = 宿主的一个「模型响应」：一段思考 + 若干 (工具调用 + 工具回执) + 可选的正文。
// 依据是宿主真机原生行的形状：一轮里模型会多次发言，宿主把**每次发言**写成一行，
//   reasoning → tool_call → tool_result →（下一次发言）reasoning → 正文 → …
//   收到工具回执即表示模型要重新发言（帧断），正文也断一帧。
//
// 为什么不能按 role 归组（原先的做法）：
//   一轮里可能有几十段助手正文（真机样本：一轮 126 条 item、59 段正文），
//   按 role 归组会把它们全并进一条消息 → 宿主渲染成一个巨大气泡，模型回复读不出来；
//   而且「一行 = 一条消息」的宿主契约也被破坏（行的 role 只能有一个）。
//
// 为什么 user 消息单独成帧：用户提问与宿主注入的压缩摘要都是 user 侧消息，
//   各自独立成行，不能和助手内容混在一行里。
//   同一轮里的**连续** user 文本块算同一条消息（Anthropic 存成多块），必须并进同一帧 ——
//   拆成两帧会变成两条 user 消息，读回时 assembleTurns 会多开一轮（轮次口径就变了）。
function turnToMessageFrames(turn) {
  const turnRole = turn.role === 'user' ? 'user' : 'assistant';
  const frames = [];
  let cur = null;
  let hasResult = false; // 当前帧里已经收到过工具回执 → 模型要重新发言了
  const newFrame = (role) => {
    cur = { role, blocks: [] };
    frames.push(cur);
    return cur;
  };

  for (const it of turn.items ?? []) {
    const block = itemToBlock(it, turnRole);
    if (!block) continue;
    const { role: roleMark, ...rest } = block;
    const role = roleMark === 'user' || roleMark === 'assistant' ? roleMark : turnRole;
    if (role === 'user') {
      if (cur && cur.role === 'user') cur.blocks.push(rest);
      else newFrame('user').blocks.push(rest);
      hasResult = false;
      continue;
    }
    // 助手侧：当前帧不是助手帧（user 帧或已结束）→ 另起一帧
    if (!cur || cur.role !== 'assistant') newFrame('assistant');
    // 收到回执之后模型又开口（思考/正文）或又发起新调用 → 上一帧结束
    if (hasResult && (rest.type === 'thinking' || rest.type === 'text' || rest.type === 'tool_use')) {
      newFrame('assistant');
      hasResult = false;
    }
    cur.blocks.push(rest);
    if (rest.type === 'tool_result') hasResult = true;
    else if (rest.type === 'text') {
      // 正文结束一帧
      cur = null;
      hasResult = false;
    }
  }
  return frames;
}

// 消息帧 → 宿主 messages.jsonl 的行（**文件型原生形状**，见 src/pi-agent-blocks.mjs）。
//
// 与 DB 行路径的关键差别：原生把工具回执写成**独立一行**（`role='toolResult'`，带
// toolCallId/toolName/isError），不塞进助手行的块里 —— 塞进去宿主解不出回执，它自己界面里
// 那次调用只剩「发起」没有「结果」。同理块类型必须是 `toolCall`；`tool_use` / `tool_result`
// 是 π 词表，宿主一个都不认（写进去那几次调用在它界面上直接消失）。
function frameToHistoryLines(frame, turnId, ts) {
  const blocks = [];
  const results = [];
  for (const b of frame.blocks) (b.type === 'tool_result' ? results : blocks).push(b);
  const lines = [];
  const push = (role, message) =>
    lines.push({ message_id: `msg-${role}-v1-${newNodeId()}`, turn_id: turnId, message: { ...message, timestamp: ts } });
  const nativeBlocks = blocks.map((b) => toNativeBlock(b)).filter(Boolean);
  if (nativeBlocks.length) push(frame.role, { role: frame.role, content: nativeBlocks });
  for (const r of results) push('toolResult', toolResultRowOfBlock(r));
  return lines;
}

/**
 * 宿主的历史目录相对路径，纯函数（实测 4/4 可由 (session_id, created_at_ms) 还原）：
 *   `2026-09-08/05-47-43-992-session_<base64url(sessionId)>`
 * 我们只写 DB、把该列留 NULL，物化交给宿主；这个函数只用于「宿主会把它放哪」的提示与校验。
 */
export function historyRelativeDir(sessionId, createdAtMs) {
  const d = new Date(Number(createdAtMs) || 0);
  const stamp = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}/${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}-${p3(d.getUTCMilliseconds())}`;
  return `${stamp}-session_${Buffer.from(String(sessionId), 'utf8').toString('base64url')}`;
}

// IR item → π content 块（宿主 messages.jsonl 用的块结构）。
// 块上带 role：读侧按块级 role 重新分组，才能把「user 提问 + assistant 回答」
// 还原成同一轮里的两个条目（否则全部按行 role 归一成 user，核心指纹就变了
// → 下一次导入判成 fork 而不是 append）。
function itemToBlock(it, turnRole) {
  const role = it.role === 'user' || it.role === 'assistant' ? it.role : it.kind === 'message' ? turnRole : 'assistant';
  switch (it.kind) {
    case 'message':
      // 携带 compact 语义位：minimax 无独立压缩语义列，写侧据此标 SystemEvent 并补回 <cb_summary> 壳，
      // 让读侧（靠内容标签认压缩）+ 宿主都能认出，正文一字不丢。
      return { type: 'text', text: it.text ?? '', role, ...(it.compact ? { compact: true } : {}) };
    case 'reasoning':
      return { type: 'thinking', thinking: it.text ?? '', role };
    case 'tool_call':
      return { type: 'tool_use', id: it.callId ?? null, name: it.name ?? 'tool', input: it.input ?? null, role };
    case 'tool_result':
      // 带 name：文件型历史把回执写成独立行，原生行里有 toolName（缺了就只能落 'tool'，工具名丢失）
      return { type: 'tool_result', tool_use_id: it.callId ?? null, name: it.name ?? 'tool', content: it.output ?? '', is_error: it.status === 'error', role };
    case 'attachment':
      return { type: 'image', path: it.ref ?? '', role };
    default:
      return null;
  }
}

// π 块 → 宿主 tool_calls 结构（真机原生行口径，见 app.asar 取证）：
//   {tool_name, tool_call_id, tool_call_status(1 Start/2 Finished/3 Failed),
//    tool_call_args: JSON 串, tool_call_result_data: JSON 串}
//
// IR 的「调用」与「回执」是两件，宿主的一条 tool_call 自带入参与结果 —— 这里合成一件。
// 读回时靠 session-sync-content 里的 π 块还原成两件，所以这里只负责宿主渲染，不负责无损。
function hostToolCalls(blocks) {
  const out = [];
  const byId = new Map();
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      const id = b.id ?? null;
      const entry = {
        tool_name: b.name ?? 'tool',
        tool_call_id: id ?? newNodeId(),
        tool_call_status: 2,
        tool_call_args: JSON.stringify(b.input ?? null),
      };
      if (id) byId.set(id, entry);
      out.push(entry);
    } else if (b.type === 'tool_result') {
      const id = b.tool_use_id ?? null;
      const payload = JSON.stringify({ content: [{ type: 'text', text: String(b.content ?? '') }] });
      const entry = id ? byId.get(id) : null;
      if (entry) {
        entry.tool_call_status = b.is_error ? 3 : 2;
        entry.tool_call_result_data = payload;
      } else {
        out.push({ tool_name: 'tool', tool_call_id: id ?? newNodeId(), tool_call_status: b.is_error ? 3 : 2, tool_call_result_data: payload });
      }
    }
  }
  return out;
}

// π 块 → 宿主 attachments 结构（toAttachmentView 的容错口径：filePath / fileName / type）
function hostAttachments(blocks) {
  return blocks
    .filter((b) => b.type === 'image')
    .map((b) => {
      const p = String(b.path ?? '');
      return { type: 'image', filePath: p, fileName: p.split(/[\\/]/).pop() ?? '' };
    });
}

// 一个消息帧 → 一行宿主 display message。
//
// 字段口径全部照宿主真机原生行：
//   col.msg_id === data.msg_id —— 不相等时 decodeDisplayMessage 直接抛 MessageDataCorruptionError
//   col.turn_id === data.turn_id === data.turnId —— 一轮的所有消息共享同一个 turn_id
//   col.role === data.role —— 这条消息自己的角色
//   data.msg_type：1=AgentContent / 2=AgentToolCall / 3=SystemEvent
//   data.msg_content / thinking_content / tool_calls —— 宿主的解码链只看这三个
//   data['session-sync-content'] —— 本工具的私有键，存全量 π 块（含块级 role）：
//     宿主不读它，但自己必须能靠它无损读回 tool_call / tool_result / 附件。
//     （少了它，读回只剩正文，工具调用会在核心指纹里消失 → 往返被判成 fork。）
function messageRowOf(frame, { turnId, ts, targetId }) {
  const msgId = newNodeId();
  const text = frame.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const thinking = frame.blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
  const toolCalls = hostToolCalls(frame.blocks);
  const attachments = hostAttachments(frame.blocks);
  // 宿主注入的压缩摘要是「系统事件」，不是用户提问：标 SystemEvent，宿主才不会把它显示成用户气泡。
  // minimax 无独立压缩语义列，读侧靠内容标签认 → 写侧两件事都要做：
  //   ① isSystemEvent 认 compact 位（归一化新口径）或内容标签（旧 reader / 兼容回退）；
  //   ② 正文是归一化裸正文（compact 位）时补回 <cb_summary> 壳，让宿主/读侧认得出。
  // 'session-sync-content' 里保留裸正文，读侧据此无损还原（不丢字）。
  const compactBlock = frame.blocks.find((b) => b.type === 'text' && b.compact === true);
  const isSystemEvent = !!compactBlock || frame.blocks.some((b) => b.type === 'text' && compactionInjectionKind(b.text));
  const msgType = isSystemEvent ? 3 : toolCalls.length ? 2 : 1;
  const msgContent = compactBlock && !compactionInjectionKind(text) ? `<cb_summary>${text}</cb_summary>` : text;
  return [
    ['session_id', String(targetId)],
    ['msg_id', msgId],
    ['role', frame.role],
    ['turn_id', turnId],
    ['created_at_ms', ts],
    ['data_json', JSON.stringify({
      msg_id: msgId,
      turn_id: turnId,
      turnId,
      timestamp: ts,
      role: frame.role,
      msg_type: msgType,
      msg_content: msgContent,
      ...(thinking ? { thinking_content: thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(attachments.length ? { attachments } : {}),
      'session-sync-content': frame.blocks.map((b) => ({ ...b, role: frame.role })),
    })],
    ['source', 'session-sync'],
  ];
}

const LISTABLE = {
  columnar_version: 3,
  agent_name: 'mavis',
  runtime: 'pi-agent',
  session_type: 'root',
  status: 'idle',
  visibility: 'visible',
  session_kind: 'conversation',
};

/**
 * 盘上已有的标题：先看 title 列（宿主列表读它），列空再退回 record_json 快照。
 * 两个都是标题落点，只认一个会在另一半丢名字。
 */
function existingTitleOf(row) {
  const col = String(row?.title ?? '').trim();
  if (col) return col;
  try {
    return String(JSON.parse(String(row?.record_json ?? '{}'))?.title ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * append 不会触发宿主那条 AFTER INSERT 触发器，所以项目行/回填要自己补：
 * 与 trg_local_runtime_project_session_insert_v5 同语义（default 唯一、workspace 按目录）。
 */
function ensureProjectRow(db, { workspace, isDefault, createdAt, updatedAt }) {
  if (!tableExists(db, 'local_runtime_projects')) return null;
  const find = () => {
    const row = db
      .prepare(
        `SELECT project_id FROM local_runtime_projects
         WHERE (project_kind = 'default' AND ? = 1)
            OR (project_kind = 'workspace' AND ? = 0 AND workspace_dir = ?)
         ORDER BY project_id LIMIT 1`,
      )
      .get(isDefault, isDefault, workspace);
    return row ? Number(row.project_id) : null;
  };
  try {
    const found = find();
    if (found != null) return found;
    const projAll = [
      ['project_kind', isDefault ? 'default' : 'workspace'],
      ['workspace_dir', isDefault ? null : workspace],
      ['latest_activity_at_ms', updatedAt],
      ['created_at_ms', createdAt],
      ['updated_at_ms', updatedAt],
    ];
    const projHave = tableColumns(db, 'local_runtime_projects');
    if (!projHave.length) return null;
    // INSERT OR IGNORE：宿主库在 workspace_dir 上有 UNIQUE 索引，
    // 裸 INSERT 撞重复会抛约束错误、把整条写入带崩
    const info = insertRowFiltered(db, 'local_runtime_projects', projAll, { verb: 'INSERT OR IGNORE', returnRowId: true, ifEmpty: 'skip' });
    if (!info.ok) return null;
    // 冲突时（OR IGNORE 什么都没插）回查已有行，保证拿到的是真实 project_id
    return find() ?? (Number(info.changes) > 0 ? Number(info.lastInsertRowid) : null);
  } catch {
    return null;
  }
}

// ---- 项目键（workspace_dir）的落库形态 ----
//
// 宿主的项目键是**字节级**目录串，两处都按等值比较：
//   - `local_runtime_projects.workspace_dir` 上有 UNIQUE 索引（仅 workspace 类）
//   - 宿主触发器回填 project_id 用 `p.workspace_dir = NEW.project_workspace_dir`
// 同一个目录的两种写法（Windows 上 `d:\work` 与 `D:\work` 是同一个目录）在宿主眼里是两行
// → 侧栏两个同名分组。真机样本：源 agent 记的是小写盘符，宿主自己记的是大写，
// 导入后 local_runtime_projects 出现同一目录的两行。

/**
 * 落库形态的目录串：宿主已有的那一串优先（精确命中直接用；忽略大小写/分隔符命中则用宿主那串）
 * —— 只有宿主自己的串能和它的 UNIQUE 索引、触发器等值比较对上；
 * 宿主没有对应行时取**盘符大写 + 原生分隔符**的形态（与宿主 process.cwd() 同形，见 util.mjs）。
 * @param {string} input 源侧记的 cwd
 * @returns {string} 规范形态（非空时）
 */
export function canonicalWorkspaceDir(input) {
  return canonicalDirPath(input);
}

function workspaceProjectRows(db) {
  try {
    return db.prepare("SELECT project_id, workspace_dir FROM local_runtime_projects WHERE project_kind = 'workspace'").all();
  } catch {
    return [];
  }
}

/** 权威行的计数重算（照宿主触发器的口径：列式版本 3、未归档、可见、非 peek/cron） */
function refreshProjectCounters(db, projectId) {
  try {
    db.prepare(
      `UPDATE local_runtime_projects SET
         latest_activity_at_ms = COALESCE((SELECT MAX(s.updated_at_ms) FROM local_runtime_sessions s
            WHERE s.project_id = ? AND s.columnar_version = 3 AND s.archived = 0
              AND s.visibility <> 'hidden' AND s.session_kind NOT IN ('peek','cron')), 0),
         session_count = (SELECT COUNT(*) FROM local_runtime_sessions s
            WHERE s.project_id = ? AND s.columnar_version = 3 AND s.archived = 0
              AND s.visibility <> 'hidden' AND s.session_kind NOT IN ('peek','cron')
              AND s.parent_session_id IS NULL)
       WHERE project_id = ?`,
    ).run(projectId, projectId, projectId);
  } catch {
    /* 计数只是显示口径，拿不到就算了 */
  }
}

/**
 * 合并同一个目录的重复项目行。
 * 只并 cmpPath 相同的目录 —— 那是同一个目录的不同写法，合并只是把分组归位，不丢会话。
 * 权威行 = 与规范形态精确命中的那行；没有就取最早建的那行。
 * @returns {Array<{kept:number, dropped:number, dir:string, droppedDir:string}>}
 */
export function mergeDuplicateProjects(db, { onlyDir = null } = {}) {
  if (!tableExists(db, 'local_runtime_projects')) return [];
  const want = onlyDir ? cmpPath(onlyDir) : null;
  const groups = new Map();
  for (const r of workspaceProjectRows(db)) {
    const key = cmpPath(r.workspace_dir);
    if (!key) continue;
    if (want && key !== want) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const merged = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Number(a.project_id) - Number(b.project_id));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      // 会话改挂到权威行，目录串一并对齐（读侧读回的 cwd 跟着归位）
      db.prepare('UPDATE local_runtime_sessions SET workspace_dir = ?, project_workspace_dir = ?, project_id = ? WHERE project_id = ?')
        .run(keep.workspace_dir, keep.workspace_dir, keep.project_id, dup.project_id);
      db.prepare('DELETE FROM local_runtime_projects WHERE project_id = ?').run(dup.project_id);
      merged.push({ kept: Number(keep.project_id), dropped: Number(dup.project_id), dir: String(keep.workspace_dir), droppedDir: String(dup.workspace_dir) });
    }
    refreshProjectCounters(db, keep.project_id);
  }
  return merged;
}

/**
 * 把落点目录对齐到宿主已有的项目行。
 * @returns {{dir: string, projectId: number|null, merged: Array}}
 */
export function resolveWorkspaceDir(db, raw) {
  const canonical = canonicalWorkspaceDir(raw);
  if (!canonical) return { dir: '', projectId: null, merged: [] };
  if (!tableExists(db, 'local_runtime_projects')) return { dir: canonical, projectId: null, merged: [] };
  // 先把同一个目录的重复行并掉（大小写不同写法各建了一行的历史残留）
  const merged = mergeDuplicateProjects(db, { onlyDir: canonical });
  const hit = workspaceProjectRows(db).filter((r) => cmpPath(r.workspace_dir) === cmpPath(canonical));
  if (!hit.length) return { dir: canonical, projectId: null, merged };
  // 精确命中优先（那就是宿主自己记的那一串），否则取最早建的那行
  const exact = hit.find((r) => String(r.workspace_dir) === canonical);
  const row = exact ?? hit.sort((a, b) => Number(a.project_id) - Number(b.project_id))[0];
  return { dir: String(row.workspace_dir), projectId: Number(row.project_id), merged };
}


export const minimaxWriter = {
  variant: 'minimax',
  label: 'MiniMax Code',

  canWrite(ctx) {
    const f = dbFile(ctx);
    return f && isFile(f) ? { ok: true } : { ok: false, reason: 'db-not-found' };
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
   * minimax 的标题住在 local_runtime_sessions.title 列。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'db-column', db: (c) => dbFile(c), table: 'local_runtime_sessions', idCol: 'session_id', col: 'title', maxLen: TITLE_MAX.minimax },
  ], 'minimax'),

  targetPath(ctx, session, targetId) {
    const f = dbFile(ctx);
    return f ? `${f}#${targetId}` : null;
  },

  /**
   * 索引自愈（供 import 的 skip 分支调用）：minimax 的索引行就是 sessions 表的那一行，
   * 这里只做一件事 —— 把归属对齐到**宿主已有的项目行**。
   *
   * 为什么必须做：项目键是字节级目录串，同一个目录的大小写写法不同 = 两个项目行
   * = 侧栏两个同名分组。落库时对齐过一次，但历史残留（老版本写进去的）只有自愈能收拾。
   * 行不在 → 交给 write 建，这里不越权。
   */
  ensureIndex(ctx, { targetId, cwd, scope = null } = {}) {
    const warnings = [];
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found', warnings };
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      if (!tableExists(db, 'local_runtime_sessions')) return { ok: false, error: 'sessions-table-absent', warnings };
      const row = db
        .prepare('SELECT workspace_dir, project_workspace_dir, is_default_workspace, project_id FROM local_runtime_sessions WHERE session_id = ?')
        .get(String(targetId));
      if (!row) return { ok: false, error: 'target-missing', warnings };
      const isDefault = Number(row.is_default_workspace) === 1 || scope === 'none';
      const want = String(cwd ?? row.workspace_dir ?? '').trim();
      if (!want || isDefault) return { ok: true, changed: false, warnings };
      db.exec('BEGIN IMMEDIATE');
      try {
        const resolved = resolveWorkspaceDir(db, want);
        const dir = resolved.dir || want;
        for (const m of resolved.merged) {
          warnings.push(`project-merged: 同一个目录的重复项目行已合并（${m.droppedDir} → ${m.kept}）`);
        }
        const changed =
          String(row.workspace_dir ?? '') !== dir ||
          String(row.project_workspace_dir ?? '') !== dir ||
          (resolved.projectId != null && Number(row.project_id ?? 0) !== Number(resolved.projectId));
        if (changed) {
          const sets = [['workspace_dir', dir], ['project_workspace_dir', dir]];
          if (resolved.projectId != null) sets.push(['project_id', resolved.projectId]);
          updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
        }
        db.exec('COMMIT');
        return { ok: true, changed, dir, projectId: resolved.projectId, warnings };
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, warnings };
      }
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, scope = null }) {
    const warnings = [];
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found' };

    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const now = Date.now();
    const createdAt = Number(session.createdAt) || now;
    const updatedAt = Number(session.updatedAt) || createdAt;
    let workspace = String(session.cwd ?? '');
    let isDefault = (scope ?? session.scope) === 'none' ? 1 : 0;
    if (!workspace && mode === 'append') {
      // 追加进原生非项目会话：那行本来就落在宿主自生成的 default 桶里（workspace_dir 为空），
      // 没有理由因为「调用方没给 cwd」就拒写 —— 沿用行上已有的落点
      const cur = new DatabaseSync(file, { readOnly: true });
      try {
        const row = cur.prepare('SELECT workspace_dir, is_default_workspace FROM local_runtime_sessions WHERE session_id = ?').get(String(targetId));
        if (row) {
          workspace = String(row.workspace_dir ?? '');
          isDefault = Number(row.is_default_workspace) === 1 || !workspace ? 1 : 0;
        }
      } catch {
        /* 读不到就仍按缺 cwd 处理 */
      } finally {
        cur.close();
      }
    }
    if (!workspace && !isDefault) return { ok: false, error: 'cwd-required: minimax 的行必须有 workspace_dir' };

    const db = new DatabaseSync(file);
    let inserted = 0;
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      if (!tableExists(db, 'local_runtime_sessions') || !tableExists(db, 'local_runtime_message_rows')) {
        return { ok: false, error: 'sessions-or-message-rows-missing' };
      }
      db.exec('BEGIN IMMEDIATE');
      // 落点目录对齐到宿主已有的项目行：项目键是字节级目录串，
      // 源 agent 记的大小写与宿主自己记的不一致时，照抄会多出一个项目行
      // → 侧栏两个同名分组。这里换成宿主那一串，触发器的等值比较才命中同一行。
      if (workspace && !isDefault) {
        const resolved = resolveWorkspaceDir(db, workspace);
        if (resolved.dir) workspace = resolved.dir;
        if (resolved.merged.length) {
          warnings.push(`project-merged: 同一个目录的重复项目行已合并（${resolved.merged.map((m) => `${m.droppedDir} → ${m.kept}`).join('；')}）`);
        }
      }
      try {
        if (workspace) ensureDir(workspace);
      } catch (err) {
        warnings.push(`mkdir-failed: ${String(err?.message ?? err)}`);
      }
      // 连标题一起读回来：append 时要保留宿主/用户已有的名字（见下面 record.title 的判定）
      let existing = db.prepare('SELECT session_id, title, record_json FROM local_runtime_sessions WHERE session_id = ?').get(targetId);

      if (existing && mode !== 'append') {
        if (!force) {
          db.exec('ROLLBACK');
          return { ok: false, error: 'target-exists', targetId, warnings };
        }
        db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(targetId);
        db.prepare('DELETE FROM local_runtime_sessions WHERE session_id = ?').run(targetId);
        // 整份重建后按「没有行」走：`!existing || force` 在 append+force 时会重复插主键
        existing = null;
      }

      // append 到已有会话时沿用盘上已有的标题：源侧读回来的标题是首条用户文本推的，
      // 拿它覆盖会把宿主生成/用户改过的名字降级（record_json 是宿主的列表快照，同样算标题落点）
      const keptTitle = existing && mode === 'append' ? existingTitleOf(existing) : '';
      const record = {
        sessionId: String(targetId),
        agentName: LISTABLE.agent_name,
        workspaceDir: workspace,
        runtime: LISTABLE.runtime,
        sessionType: LISTABLE.session_type,
        status: LISTABLE.status,
        title: fitTitleFor('minimax', keptTitle || session.title).value,
        createdAt: createdAt,
        updatedAt: updatedAt,
        ...(session.model ? { model: session.model } : {}),
      };
      const extra = provenance ? { 'session-sync': provenance } : {};

      if (!existing) {
        // 显式列表 + 等长占位符：手写 ? 数很容易与列数错位（SQLite 只报「N values for M columns」）
        // 列名与值一一对应；按库里**实际存在**的列过滤（与 workbuddy 索引同一口径）——
        // 宿主换版本增删列时，硬编码列名会整条 INSERT 失败（行写不进去）。
        const all = [
          ['session_id', String(targetId)],
          ['record_json', JSON.stringify(record)],
          ['updated_at_ms', updatedAt],
          ['columnar_version', LISTABLE.columnar_version],
          ['agent_name', LISTABLE.agent_name],
          ['runtime', LISTABLE.runtime],
          ['session_type', LISTABLE.session_type],
          ['status', LISTABLE.status],
          ['archived', 0],
          ['visibility', LISTABLE.visibility],
          ['session_kind', LISTABLE.session_kind],
          ['purpose', ''],
          ['purpose_kind', ''],
          ['origin_cron_id', null],
          ['parent_session_id', null],
          ['workspace_dir', workspace],
          ['project_workspace_dir', workspace],
          ['is_default_workspace', isDefault],
          ['title', fitTitleFor('minimax', record.title).value],
          ['created_at_ms', createdAt],
          ['error_message', null],
          ['error_code', null],
          ['extra_data_json', JSON.stringify(extra)],
          ['history_relative_dir', null],
        ];
        const ins = insertRowFiltered(db, 'local_runtime_sessions', all, { ifEmpty: 'skip' });
        if (!ins.ok || !ins.inserted) return { ok: false, error: 'local_runtime_sessions-table-absent', targetId, warnings };
      } else {
        // append 也要跟着落点走：workspace / is_default_workspace 变了，行不能还钉在旧桶/旧项目
        const scols = tableColumns(db, 'local_runtime_sessions');
        // append **不动标题**：读回来的 session.title 是从首条用户文本推的，
        // 拿它覆盖会把宿主自己生成的更好的名字降级成半句话（标题同步走 syncTitle 专用通道）。
        // 连「把旧值写回去」都不做：用户改名可能只落在 record_json 里，写回 title 列
        // 等于用另一个落点的值顶掉他的决定（zcode 栽过同一个坑，m69 抓到）。
        const sets = [
          ['updated_at_ms', updatedAt],
          ['record_json', JSON.stringify(record)],
          ['extra_data_json', JSON.stringify(extra)],
        ];
        if (scols.includes('workspace_dir')) {
          sets.push(['workspace_dir', workspace], ['project_workspace_dir', workspace], ['is_default_workspace', isDefault]);
          const pid = ensureProjectRow(db, { workspace, isDefault, createdAt, updatedAt });
          if (pid != null && scols.includes('project_id')) sets.push(['project_id', pid]);
        }
        updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
      }

      // 宿主已有 messages.jsonl → 追加写进文件（reader 首选源），不再插 DB 行避免双份
      const histFile = mode === 'append' ? historyFileOf(ctx, db, targetId) : null;
      const histLines = [];
      let turnSeq = 0;

      for (const turn of turns) {
        const frames = turnToMessageFrames(turn);
        if (!frames.length) continue;
        // 一轮一个 turn_id，这一轮的所有消息共享它（宿主原生行就是这个形状）
        const turnId = `turn_${String(turnSeq).padStart(4, '0')}_${newNodeId()}`;
        turnSeq += 1;
        const ts = Number(turn.startedAt) || updatedAt;
        if (histFile) {
          const lines = frames.flatMap((f) => frameToHistoryLines(f, turnId, ts));
          histLines.push(...lines);
          inserted += lines.length;
          continue;
        }
        for (const f of frames) {
          const rowAll = messageRowOf(f, { turnId, ts, targetId });
          const rowIns = insertRowFiltered(db, 'local_runtime_message_rows', rowAll, { ifEmpty: 'skip' });
          if (!rowIns.ok || !rowIns.inserted) continue;
          inserted++;
        }
      }
      db.exec('COMMIT');
      if (histFile && histLines.length) {
        // 走 base 的单次 O_APPEND 原子追加：裸 appendFileSync 在多行时可能被宿主读到半截 JSON 行，
        // 而这一行正是宿主下一轮的上下文输入
        appendFileAtomic(histFile, `${histLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
        warnings.push(`append-history-file: ${histFile}`);
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, targetId, warnings };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    if (isDefault) {
      warnings.push(`history-dir-for-host: ${historyRelativeDir(targetId, createdAt)}（该列留 NULL，由宿主物化时绑定）`);
    }
    return { ok: true, targetId, path: file, lines: inserted, mode, warnings, directory: workspace };
  },
};
