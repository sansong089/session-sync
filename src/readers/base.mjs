// readers/base.mjs — reader 公共能力
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256hex } from '../util.mjs';
import { exists, isDir, isFile, baseNameOf } from '../util.mjs';
import { classifySource } from '../placement.mjs';
import { normalizeTitle, previewTitle, PREVIEW_LEN } from '../titles.mjs';

// 只读打开：带 busy_timeout，避免宿主正在写时读到 SQLITE_BUSY 直接失败
export function openDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    /* 老版本可能不支持，忽略 */
  }
  return db;
}

export function parseArgs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return String(raw);
  }
}

export function safeJson(str, fallback = null) {
  if (typeof str !== 'string' || str.length === 0) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

/**
 * 库文件到底能不能读。
 *
 * 为什么不能只靠 tableExists / tableColumns：`new DatabaseSync(file)` 对非 sqlite 文件
 * **不抛错**（延迟到第一次 prepare），而这两个函数又把异常吞成 false / []。于是
 * 「库是坏的（损坏/被锁/不是 sqlite）」与「表不存在」在调用方看来完全一样。
 * 对只读列举无伤，对 guard 判定是致命的：坏库会被当成「用户没定名」→ 覆盖掉用户
 * 自己起的标题（review 2026-11-04 P1）。
 *
 * 返回 null = 可读；否则返回错误文本（调用方拼进 fail-closed 的 reason）。
 */
export function dbReadError(db) {
  try {
    db.prepare('SELECT count(*) AS c FROM sqlite_master').get();
    return null;
  } catch (err) {
    return String(err?.message ?? err);
  }
}

export function tableColumns(db, name) {
  try {
    return db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * 某张表里有没有这一列。
 *
 * 与 tableColumns 同源（同一个 PRAGMA 口径）—— 「表里有哪些列」和「有没有某列」
 * 是同一件事的两种问法，不该各写一套 PRAGMA。
 */
export function tableHasColumn(db, name, col) {
  return tableColumns(db, name).includes(String(col));
}

/**
 * 全部存在的候选文件（按登记顺序、同一路径去重）。
 * 多库并存（env 指定库 + 默认库、旧库 + 新库）时由调用方合并，同一会话 id 在 mergeSessions 里合成一条。
 */
export function existingFiles(paths) {
  const seen = new Set();
  const out = [];
  for (const x of paths ?? []) {
    const p = typeof x === 'string' ? x : x?.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (isFile(p)) out.push(p);
  }
  return out;
}

// 取第一个存在的候选路径
export function firstExisting(paths) {
  for (const x of paths) {
    if (x.kind === 'file' && isFile(x.path)) return x;
    if (x.kind === 'dir' && isDir(x.path)) return x;
    if (!x.kind && exists(x.path)) return x;
  }
  return null;
}

/**
 * OpenCode 血统宿主 UI 的标题口径（packages/util/src/session-title-fallback.ts 原文）：
 *   title 为空 → 根会话 "New session"、子会话 "Child session"；
 *   历史标题 "New session - <ISO>" / "Child session - <ISO>" 折叠回短标签；其余原样。
 * 宿主列表显示的就是这个 label，所以读侧也必须用它，不能把 null 当「无标题」。
 */
export function opencodeSessionLabel(title, parentId) {
  const t = normalizeTitle(title);
  if (!t) return parentId ? 'Child session' : 'New session';
  return t.replace(/^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '$1');
}

/** 宿主用它标「无项目会话」（OpenCode 血统的 project_id）；读写两侧共用，别再写字面量 */
export const GLOBAL_PROJECT = 'global';

/**
 * project_id → 侧栏项目名（OpenCode 血统：opencode / mimo / kilo / zcode-cli 同构 project 表）。
 * 协议：`project.name`（用户在宿主里改过的名字）优先，否则与宿主 UI 一致取 worktree 末段
 * （本机实测 opencode 与 mimo 的 name 列全为 NULL）。
 */
export function projectNameMap(db) {
  if (!tableExists(db, 'project')) return new Map();
  const cols = tableColumns(db, 'project');
  const sel = ['id', cols.includes('worktree') ? 'worktree' : 'NULL AS worktree', cols.includes('name') ? 'name' : 'NULL AS name'].join(', ');
  const map = new Map();
  try {
    for (const r of db.prepare(`SELECT ${sel} FROM project`).all()) {
      const name = String(r.name ?? '').trim() || baseNameOf(r.worktree);
      if (name) map.set(String(r.id), name);
    }
  } catch {
    /* 坏表 → 调用方退回目录名 */
  }
  return map;
}

/** 存储形态把「调用 + 结果」塞进同一个部件、而 IR 里只有结果时，写侧打这个标记；读侧据此不补 tool_call */
export const TOOL_RESULT_ONLY = 'resultOnly';
/** 存储形态要求 input 必须是对象（opencode v2），但 IR 里原本是 null 时，写侧打这个标记，读侧还原成 null */
export const TOOL_NULL_INPUT = 'nullInput';

/**
 * 把散落的部件（推理 / 工具调用 / 工具回执 / 附件）挂进条目流。
 * 只挂到**最后一条**助手条目：向后查找更早的助手条目会把后一轮的工具件错挂进前一轮，
 * 同一会话写入再读回就换了轮次归属 → 核心指纹不等价 → 续写被误判成分叉。
 */
export function pushAssistantItem(entries, item, ts) {
  const last = entries[entries.length - 1];
  if (last && last.role === 'assistant') {
    last.items.push(item);
    return;
  }
  entries.push({ role: 'assistant', ts, items: [item] });
}

/**
 * 扁平消息条目 → turns
 * 条目形如 {role:'user'|'assistant'|'system', ts, items:[Item]}
 * 规则（各家一致，m37 定稿）：
 *   - user 开新 turn，assistant 归入当前 turn；
 *   - **开轮必须有内容**：没有条目的事件（宿主用空 content 的 user 标记「助手继续输出」）不开轮，
 *     它的后续部件并进上一轮 —— 留着就会让同一会话在不同宿主算出不同轮次数，续写误判成分叉。
 */
export function assembleTurns(entries) {
  const turns = [];
  let cur = null;
  for (const e of entries) {
    if (!e || !Array.isArray(e.items) || e.items.length === 0) continue;
    const role = e.role === 'user' ? 'user' : e.role === 'assistant' ? 'assistant' : 'system';
    if (!cur || role === 'user') {
      cur = { index: 0, role, items: [], startedAt: Number(e.ts) || 0 };
      turns.push(cur);
    }
    cur.items.push(...(e.items || []));
  }
  return turns;
}

// 从 title/首条用户文本生成会话标题
//
// 显式标题**不截断**：宿主存了多少就返回多少。截断是「落点」的事（写侧每个槽有自己的
// maxLen），读侧在这里截短就会让「写 500 字、读回 80 字」永远判定成漂移 ——
// 同步每轮都做一遍，做完还是不等于源值。
export function deriveTitle(explicitTitle, turns, fallback = 'untitled') {
  const t = normalizeTitle(explicitTitle);
  if (t) return t;
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const item of turn.items) {
      if (item.kind === 'message' && item.text) {
        // 首问预览是**显示用**的名字，与落点上限无关，固定 PREVIEW_LEN
        const text = previewTitle(item.text);
        if (text) return text;
      }
    }
  }
  return fallback;
}

// 统计 turn 数（用于 list 概览）
export function countTurns(turns) {
  return turns.length;
}

// 内容哈希（降级 reader 用：内容不可读时以密文哈希参与指纹，保证不同会话可区分）
export function contentHashOf(str) {
  return sha256hex(String(str ?? '')).slice(0, 16);
}

// 剥离系统注入块（各家 user 消息里常见的环境/提醒包裹）
// 注意：标签常带属性（<system-reminder data-role="user-context">），必须用 [^>]* 匹配
export function stripSystemInjections(text) {
  let t = String(text ?? '');
  const dropTags = ['system-reminder', 'environment_details', 'environment_context', 'user_info', 'identity_context', 'project_context',
    'git_status', 'project_layout', 'attached_files', 'additional_data', 'currently_opened_file'];
  for (const tag of dropTags) {
    t = t.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  // <user_query> / <user_input> 只是宿主给正文加的壳，保留内容
  t = t.replace(/<user_query(?:\s[^>]*)?>([\s\S]*?)<\/user_query>/g, (m, inner) => inner);
  t = t.replace(/<user_input(?:\s[^>]*)?>([\s\S]*?)<\/user_input>/g, (m, inner) => inner);
  t = t.replace(/<\/?task(?:\s[^>]*)?>/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// ---- 文件系统遍历（迭代式，避免深递归爆栈）----

/**
 * 遍历目录下符合条件的文件
 * @param {string} dir 起始目录
 * @param {object} opts {maxDepth, match(name), skipDir(name)}
 * @returns {string[]} 文件绝对路径
 */
export function walkFiles(dir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 6;
  const match = opts.match ?? (() => true);
  const skipDir = opts.skipDir ?? (() => false);
  const out = [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [cur, depth] = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !skipDir(e.name, full)) stack.push([full, depth + 1]);
      } else if (e.isFile() && match(e.name, full)) {
        out.push(full);
      }
    }
  }
  return out;
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function fileMtime(file) {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

// 只读文件头部/尾部若干字节（大文件 list 时避免全量加载）
export function readHead(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function readTail(file, bytes = 64 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// 容错 JSONL 解析：坏行跳过（截断的 head/tail 片段必然有坏行）
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * list 用的事件读取：全量解析整个文件。
 * 早先这里做 head/tail 采样（大文件只读头尾各 128KB），代价是 list 的轮次数是错的
 * ——真机 19MB 的会话 read 出 67 轮、list 只显示 1 轮，用户按 list 挑会话就是被这个数骗的。
 * 实测 250MB 全量解析约 0.6s，而采样省的只是这点 I/O，换不来正确的口径。
 */
export function listEvents(file) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

/**
 * claude 血统 jsonl 的一条 user 事件 → 该轮的用户文本（空串表示它不开新轮）。
 * 判据与 replayEntries 一致：任一 text 块去掉注入后非空即算；只有 tool_result 的属于上一轮。
 * list 与 read 共用这一份，省得两处规则各自漂移出「list 轮次 ≠ read 轮次」。
 */
export function claudeUserTurnText(ev) {
  if (ev?.type !== 'user') return '';
  const c = ev.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  for (const b of blocks) {
    if (b?.type !== 'text') continue;
    const clean = stripSystemInjections(String(b.text ?? ''));
    if (clean) return clean;
  }
  return '';
}

// 时间归一：数字（秒/毫秒）或 ISO 字符串 → 毫秒时间戳
export function toMs(v) {  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v <= 0) return 0;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v); // <1e12 视为秒
  }
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return toMs(n);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

// 内容型 list 过滤（时间范围 + 项目关键字）
export function inTimeRange(s, opts) {
  if (opts.since && s.updatedAt && s.updatedAt < opts.since) return false;
  if (opts.until && s.updatedAt && s.updatedAt > opts.until) return false;
  if (opts.project && !matchesProject(s, opts.project)) return false;
  return true;
}

// 工具输出 → 文本的唯一实现在 text.mjs（读/写两侧共用同一份，见那里的说明）。
// 这里不再保留本地副本：曾经它和 writers/base 的 outputToText 是两份，
// 数组分支逐字节相同、只在 null 上分岔，属于典型的一题多解。
export { outputText } from '../text.mjs';

/**
 * --project 关键字匹配。迁移过的会话当前目录已不是原项目目录，
 * 所以要同时搜 现 cwd / 上次落点 / 落点记录的源目录，并回标命中了哪一个（规则 4）。
 */
export function matchesProject(s, needle) {
  const want = String(needle ?? '').toLowerCase();
  if (!want) return true;
  const placed = s?.placed ?? s?.provenance?.placed ?? null;
  const cands = [
    ['cwd', s?.cwd],
    ['placed', placed?.directory],
    ['origin-dir', placed?.from],
  ];
  for (const [field, v] of cands) {
    if (v && String(v).toLowerCase().includes(want)) {
      s.matchedBy = field;
      return true;
    }
  }
  return false;
}

/**
 * 摘要/IR 统一补 scope + account（各家 reader 只在有真实库内信号时显式置位，
 * 其余由 INTERNAL_ROOTS 前缀兜底 —— 见 placement.mjs 规则 1）。
 * 目录/scope/account 只用于「写到哪、能不能被宿主列出来」，不参与会话身份判定。
 */
export function withClassification(row, ctx) {
  if (!row) return row;
  const cls = classifySource(row, ctx);
  row.scope = cls.scope;
  row.scopeReason = cls.reason;
  if (row.account === undefined) row.account = null;
  // 摘要行没有 IR 的 placed 字段，用 provenance 里的落点记账补齐（--project 的 origin-dir 匹配要用）
  if (row.placed === undefined) row.placed = row.provenance?.placed ?? null;
  return row;
}


// 源侧合并策略：同一会话 id 在多处存储出现时怎么合成一条（唯一实现，各 reader 不再自己写）
//
// 正文副本（选谁的内容/元数据）：
//   1) 按来源顺序：db / sessions / cli-jsonl 先于 tasks / local-db。
//      这个顺序必须与各 reader 的 read() 取法一致，否则 list 描述的副本和 import 真正读到的
//      副本会是两个，plan 的 targetId 与落库时算出的 targetId 也可能分叉。
//      （qoder 的 cli-jsonl 是明文、local-db 是密文库，所以明文排在前面。）
//   2) rank 相同按 reader 给出的登记顺序（registration order 是确定性的）。
//
// provenance / account 是**会话属性，不是副本属性**：宿主迁移任务目录、或同一会话同时落在
// CLI 明文库与桌面库时，只有一份副本带着 session-sync 标记。选中的正文副本若没有 provenance，
// 就从同 id 的其它副本补齐 —— 否则 originKey 会退化成「自己变体:id」，同一物理会话被当成两个身份。
//
// 冲突不静默：多份副本各自带着**不同** origin 时无法合成，保留选中副本的（没有则取登记序靠前的）
// provenance，把全部 origin 与落选来源返回给调用方（list / import 会打印）。
const SOURCE_RANK = { db: 0, sessions: 0, 'cli-jsonl': 0, tasks: 1, 'local-db': 1, registry: 1 };

export function mergeSessions(list) {
  const groups = new Map();
  (list ?? []).forEach((s, idx) => {
    const id = String(s?.id ?? '');
    if (!id) return;
    const g = groups.get(id);
    if (g) g.push({ s, idx });
    else groups.set(id, [{ s, idx }]);
  });

  const out = [];
  const conflicts = [];
  for (const [id, cands] of groups) {
    if (cands.length === 1) {
      out.push({ s: cands[0].s, first: cands[0].idx });
      continue;
    }
    const scored = cands
      .map(({ s, idx }) => ({ s, idx, rank: SOURCE_RANK[s?.source] ?? 0 }))
      .sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    const kept = scored[0];

    const withProv = scored.filter((x) => x.s?.provenance?.origin);
    const originKeyOf = (x) => `${x.s.provenance.origin.variant}:${x.s.provenance.origin.sessionId}`;
    const origins = [...new Set(withProv.map(originKeyOf))];

    let provenance = kept.s.provenance ?? null;
    if (!provenance && withProv.length) provenance = withProv[0].s.provenance;
    if (origins.length > 1) {
      const used = provenance ? withProv.find((x) => x.s.provenance === provenance) ?? kept : kept;
      conflicts.push({
        id,
        variant: kept.s?.variant ?? null,
        kept: used.s?.sourcePath ?? used.s?.source ?? null,
        dropped: withProv.filter((x) => x !== used).map((x) => x.s?.sourcePath ?? x.s?.source ?? null),
        origins,
      });
    }

    // account 同理：qoder CLI 明文副本没有 user_id，同 id 的桌面库行有
    const account = kept.s.account ?? scored.map((x) => x.s.account).find((a) => a && a.id) ?? null;

    out.push({ s: { ...kept.s, provenance: provenance ?? null, account, placed: provenance?.placed ?? null }, first: kept.idx });
  }
  out.sort((a, b) => a.first - b.first);
  return { sessions: out.map((x) => x.s), conflicts };
}

// 单个副本读取时补齐身份：首选副本没有 origin 时，用同 id 其它副本的 provenance（或已读出的 IR）覆盖；
// account 同理（qoder CLI 副本没有 user_id，桌面库行有）。
// 与 mergeSessions 的补齐规则一致，保证 list 摘要与 read 正文在身份/账户上永远说同一件事。
export function adoptSiblingIdentity(session, donors) {
  if (!session) return session;
  if (!session.origin) {
    for (const d of donors ?? []) {
      if (d?.origin) {
        session.origin = d.origin;
        session.chain = Array.isArray(d.chain) ? d.chain : [];
        session.placed = d.placed ?? null;
        break;
      }
    }
  }
  if (!session.account) {
    const a = (donors ?? []).map((d) => d?.account).find((x) => x && x.id);
    if (a) session.account = a;
  }
  return session;
}
