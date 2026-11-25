// writers/base.mjs — writer 公共能力：目录/slug 解析、JSONL 原子写与追加、备份
//
// writer 契约（各家一致）：
//   canWrite(ctx) -> {ok:boolean, reason?:string}
//   write(ctx, {session, targetId, mode:'create'|'append'|'fork', fromTurnIndex, provenance, force})
//     -> {ok, targetId, path, lines, warnings[]}
import fs from 'node:fs';
import path from 'node:path';
import { uuidv7, ensureDir, isDir, isFile, sha256hex, writeFileAtomic, canonicalDirPath } from '../util.mjs';
import { sidecarPathFor } from '../provenance.mjs';
import { tableColumns } from '../readers/base.mjs';

// ---------------------------------------------------------------------------
// db 行写入的唯一出口
//
// 为什么必须收敛：宿主 schema 会随版本加减列，写死列名就会在老库上整条 INSERT 失败
// （真机取证：WorkBuddy baseline 没有 transport / unread / thought_level）。
// 正确的做法是「声明列→值，落笔前按目标库实际列裁剪」。这段逻辑以前在 7 家 writer 里
// 各手写一份（约 27 处），口径稍有出入就是串位或半写 —— 所以只留这里一份。
// ---------------------------------------------------------------------------

/** 同一 db 实例内表结构不会变：按 db + 表名缓存列集合，避免每条 message 都跑一次 PRAGMA */
const colCache = new WeakMap();

function colInfoOf(db, table) {
  let perDb = colCache.get(db);
  if (!perDb) {
    perDb = new Map();
    colCache.set(db, perDb);
  }
  let info = perDb.get(table);
  if (!info) {
    const list = tableColumns(db, table);
    info = { list, set: new Set(list) };
    perDb.set(table, info);
  }
  return info;
}

/** [[col, val], ...] 或 {col: val} 都接受：调用方两种写法都有历史包袱 */
function rowPairsOf(row) {
  if (!row) return [];
  return Array.isArray(row) ? row : Object.entries(row);
}

/**
 * 按目标库实际列裁剪后 INSERT。
 *
 * @param opts.verb 'INSERT'（默认）| 'INSERT OR REPLACE'
 * @param opts.onConflict {conflictCols, updateCols}：DO UPDATE 的列**同样**要裁剪 ——
 *   zcode 的 tasks 就是栽在这里：INSERT 裁了，SET 子句写死列名，老库照样整条失败
 * @param opts.ifEmpty 'error'（默认）| 'skip'：一列都不剩时是报错还是让调用方自己决定
 * @param opts.returnRowId 透传 lastInsertRowid（minimax 的 projects 需要）
 * @returns {{ok:boolean, inserted?:boolean, cols:string[], changes?:number, lastInsertRowid?:any, skipped?:string, error?:string}}
 */
export function insertRowFiltered(db, table, row, opts = {}) {
  const have = colInfoOf(db, table).set;
  const pairs = rowPairsOf(row).filter(([c]) => c && have.has(c));
  if (!pairs.length) {
    if ((opts.ifEmpty ?? 'error') === 'skip') return { ok: true, inserted: false, skipped: 'no-columns', cols: [] };
    return { ok: false, error: `no-columns: ${table} 里没有任何一列存在于目标库（宿主 schema 比预期更老？）`, cols: [] };
  }
  const cols = pairs.map(([c]) => c);
  let sql = `${opts.verb ?? 'INSERT'} INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const oc = opts.onConflict;
  if (oc?.conflictCols?.length) {
    const wanted = oc.updateCols ?? cols.filter((c) => !oc.conflictCols.includes(c));
    const upd = wanted.filter((c) => have.has(c));
    sql += upd.length
      ? ` ON CONFLICT(${oc.conflictCols.join(', ')}) DO UPDATE SET ${upd.map((c) => `${c} = excluded.${c}`).join(', ')}`
      : ` ON CONFLICT(${oc.conflictCols.join(', ')}) DO NOTHING`;
  }
  const res = db.prepare(sql).run(...pairs.map(([, v]) => v));
  const out = { ok: true, inserted: true, cols, changes: Number(res.changes ?? 0) };
  if (opts.returnRowId) out.lastInsertRowid = res.lastInsertRowid;
  return out;
}

/**
 * 按目标库实际列裁剪后 UPDATE。
 * where 接受 {col: val} 或 [[col, val], ...]（等值 AND）。
 * @returns {{ok:boolean, updated?:boolean, cols:string[], changes?:number, skipped?:string, error?:string}}
 */
export function updateRowFiltered(db, table, sets, where, opts = {}) {
  const have = colInfoOf(db, table).set;
  const pairs = rowPairsOf(sets).filter(([c]) => c && have.has(c));
  if (!pairs.length) {
    if ((opts.ifEmpty ?? 'error') === 'skip') return { ok: true, updated: false, skipped: 'no-columns', cols: [] };
    return { ok: false, error: `no-columns: ${table} 里没有任何一列存在于目标库`, cols: [] };
  }
  const wherePairs = rowPairsOf(where);
  const whereSql = whereSqlOf(wherePairs);
  const sql = `UPDATE ${table} SET ${pairs.map(([c]) => `${c} = ?`).join(', ')}${whereSql}`;
  const res = db
    .prepare(sql)
    .run(...pairs.map(([, v]) => v), ...wherePairs.map(([, v]) => v));
  return { ok: true, updated: true, cols: pairs.map(([c]) => c), changes: Number(res.changes ?? 0) };
}

/** [[col, val], ...] → 'a = ? AND b = ?'。条件拼接只有这一处，别在别处再拼一遍 */
function condOf(pairs) {
  return pairs.map(([c]) => `${c} = ?`).join(' AND ');
}

function whereSqlOf(pairs) {
  return pairs.length ? ` WHERE ${condOf(pairs)}` : '';
}

/**
 * 定位键 → WHERE 条件。**复合主键必须整键定位**。
 *
 * zcode 的 tasks 主键是 (workspace_key, task_id)：只按 task_id 查会跨 workspace
 * 命中同名的另一行（实测两个 workspace_key 下同 task_id 会被一起改）。
 *
 * 键不完整时返回 `ok:false + key-unresolved`，调用方必须当「读不出来」处理 ——
 * 当成「没有这一行 / 用户没定名」会直接覆盖用户自己起的标题。
 */
export function resolveKeyWhere(idCols, idVals) {
  const cols = Array.isArray(idCols) ? idCols : [idCols];
  const vals = (idVals ?? []).map((v) => String(v ?? ''));
  if (vals.length !== cols.length || vals.some((v) => !v)) return { ok: false, reason: 'key-unresolved' };
  const pairs = cols.map((c, i) => [c, vals[i]]);
  return { ok: true, cols, vals, pairs, sql: condOf(pairs) };
}

/**
 * 标题槽的定位键 → resolveKeyWhere。
 *
 * `slot.idVals` 允许是函数：复合键里有些列的值不是 targetId 本身，要由 writer 现算
 * （zcode 的 workspace_key 是会话目录，得从另一个库的 session 表反查）。
 */
export function keyWhereOf(slot, ctx, targetId) {
  const multi = Array.isArray(slot.idCol);
  const raw = multi
    ? (typeof slot.idVals === 'function' ? slot.idVals(ctx, targetId) : (slot.idVals ?? []))
    : [String(targetId)];
  return resolveKeyWhere(multi ? slot.idCol : [slot.idCol], raw);
}


// 取根不再由 writer 自己拼：一律读 roots.mjs 的 resolveRoot(variant, ctx).writeRoot。
// 原来的 variantDir 直接取 readPaths[0] 且不看存在性，宿主搬了根就会把正文写进一个没人看的目录。

function walkRoot(rootDir, matchName, maxDepth = 6) {
  const queue = [{ dir: rootDir, depth: 0 }];
  let dirHit = null;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (matchName(e.name) && !dirHit) dirHit = f;
        if (depth < maxDepth) queue.push({ dir: f, depth: depth + 1 });
      } else if (matchName(e.name)) {
        // 文件优先：正文比「同名空目录」更能说明这条会话在哪
        return f;
      }
    }
  }
  return dirHit;
}

/**
 * 按会话 ID 在变体根目录内找回既有正文（文件或目录）。
 * 存在性判定绝不能靠 slugFor*(cwd) 拼路径：落点一变就把同一会话当成「不存在」，
 * 于是新目录起一份增量残档、旧目录留一份完整孤儿，reader 取 mtime 最新 → 历史被截断。
 * 各家形态：<id>.jsonl（claude / workbuddy）、rollout-<ts>-<id>.jsonl（codex）、
 * <ISO>_<id>.jsonl（pi）、<id>/ 会话目录（dsh / freebuff）。
 * @returns {string|null} 命中文件或目录的绝对路径
 */
export function findExistingByTargetId(rootDir, targetId) {
  const id = String(targetId ?? '');
  if (!rootDir || !id || !isDir(rootDir)) return null;
  return walkRoot(rootDir, (n) => {
    // codex 的正文可能是 `.jsonl` 或 `.jsonl.zst`（宿主压缩过的历史）——判断 id 前先剥掉压缩后缀
    const base = n.endsWith('.zst') ? n.slice(0, -4) : n;
    return base === id || base === `${id}.jsonl` || base.endsWith(`_${id}.jsonl`) || base.endsWith(`-${id}.jsonl`);
  });
}

/**
 * 备份根的唯一出口：`~/.session-sync/backups/<变体>/`，全部在宿主扫描根之外。
 *
 * 为什么按变体分而不是按目录名（旧实现取 rootDir 的 basename，claude/codebuddy 都成了
 * `backups/projects/`）：同一个目录名下塞两家的备份，出问题时无从判断该还原给谁。
 */
// session-sync 自己的目录不是「宿主根」，这里只在 ~/.session-sync/backups 下拼路径
const backupHome = (ctx) => String(ctx?.home ?? '');

export function backupDirOf(ctx, variant) {
  const home = backupHome(ctx);
  if (!home || !variant) throw new Error('backup-unresolved: 备份落点需要主目录与 variant（宿主扫描根内不留 .bak）');
  return path.join(home, '.session-sync', 'backups', String(variant));
}

/**
 * 改归属列这类「没有文件可以备份」的写入，把改动前的原值快照到宿主扫描根之外。
 * 切账号动的是宿主原生行的可能性最高，出问题时凭这份快照能逐条还原。
 */
export function writePreImage(ctx, variant, payload) {
  const dir = backupDirOf(ctx, variant);
  ensureDir(dir);
  const file = path.join(dir, `switch-${Date.now()}-${process.pid}.json`);
  // 原子写：这份快照是切账号前唯一的原值，写一半等于「以为备份了其实没有」
  writeFileAtomic(file, `${JSON.stringify({ tool: 'session-sync', at: new Date().toISOString(), variant, ...payload }, null, 2)}\n`);
  return file;
}

function copyTree(src, dst) {
  if (isFile(src)) fs.copyFileSync(src, dst);
  else fs.cpSync(src, dst, { recursive: true });
}

// provenance 只存 sidecar 的变体（codebuddy）：正文搬走后 sidecar 必须跟着走，
// 否则下一次读不到 originKey，会把同一条会话当成新会话再导一份。
function carrySidecar(hit, target, { keepOld = false } = {}) {
  const src = sidecarPathFor(hit);
  if (!isFile(src)) return;
  try {
    fs.copyFileSync(src, sidecarPathFor(target));
    if (!keepOld) fs.unlinkSync(src);
  } catch {
    /* sidecar 复制失败不该阻断正文搬迁；下次写入会重建 */
  }
}

/**
 * 把既有正文搬到新的 slug 目录：先整份备份再 move，move 失败退回复制（宁可多一份也不丢历史）。
 * `keepSource: true` 只复制、不动旧文件 —— 给「先建目标文件 → 改索引行 → 最后删旧文件」
 * 这类需要崩溃自愈顺序的调用方用（WorkBuddy 的 db 行与 jsonl 必须分两步落地）。
 * @returns {{moved:boolean, path:string|null, source:string|null, backup:string|null, warning:string|null}}
 */
export function relocateByTargetId(rootDir, targetId, newSlugDir, { ctx, variant, keepSource = false } = {}) {
  const hit = findExistingByTargetId(rootDir, targetId);
  if (!hit) return { moved: false, path: null, source: null, backup: null, warning: null };
  const baseName = path.basename(hit);
  if (path.resolve(path.dirname(hit)) === path.resolve(newSlugDir)) {
    return { moved: false, path: hit, source: null, backup: null, warning: null };
  }
  ensureDir(newSlugDir);
  const target = path.join(newSlugDir, baseName);
  // 快照落点与写前备份同一套（backupPathFor）：搬家前先留一份，搬丢了才回得去
  const backup = backupCopy(ctx, variant, hit);
  if (keepSource) {
    copyTree(hit, target);
    carrySidecar(hit, target, { keepOld: true });
    return { moved: true, path: target, source: hit, backup, warning: `relocated(复制，旧文件待索引更新后删除): ${hit} → ${target}` };
  }
  try {
    fs.renameSync(hit, target);
    carrySidecar(hit, target);
    return { moved: true, path: target, source: null, backup, warning: `relocated: ${hit} → ${target}` };
  } catch {
    copyTree(hit, target);
    carrySidecar(hit, target, { keepOld: true });
    return { moved: true, path: target, source: null, backup, warning: `relocated（rename 失败退回复制，旧位置仍在）: ${hit} → ${target}` };
  }
}

/**
 * slug 目录解析：优先复用已存在目录（大小写不敏感），否则按规则新建。
 * 宿主是按 cwd 现算目录名的，大小写或分隔符细节不一致就会「写进去但看不见」，
 * 因此必须优先贴合已存在的目录。
 */
export function resolveSlugDir(parentDir, slug) {
  const want = String(slug ?? '').trim();
  if (!want) throw new Error('cwd-required: 空 cwd 不能落进宿主不会列出的 default 目录');
  ensureDir(parentDir);
  let entries = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    entries = [];
  }
  if (entries.includes(want)) return path.join(parentDir, want);
  const lower = want.toLowerCase();
  const ci = entries.find((n) => n.toLowerCase() === lower);
  if (ci) return path.join(parentDir, ci);
  const dir = path.join(parentDir, want);
  ensureDir(dir);
  return dir;
}

// 工具输出 → 文本的唯一实现在 text.mjs。原来这里有一份 outputToText（null→''），
// 与读侧 outputText 数组分支逐字节相同、只差 null，属于一题多解。
// 现在统一返回 `string | null`，写侧要字符串的地方用 `outputText(x) ?? ''` 表达
// 「没有输出就当空串」——策略写在调用点，实现只有一份。
export { outputText } from '../text.mjs';

// ---- 各家 cwd → 项目目录名规则 ----
// 三家都按「宿主原文 + 现网真实目录名」逐条对齐过（取证与断言见 test/m17-slug-equivalence.test.mjs）。
// 空 cwd 一律返回 null：宿主永远不会列出 `default` / `--default--` 这种目录（实测 0 命中），
// 造出来只是把会话藏起来。调用方须走 placement 的 requires-cwd。
//
// **三家都先过一遍目录形态归一**（util.mjs 的 canonicalDirPath）：宿主按自己记的 cwd
// 现算目录名，盘符大小写是**每家自己的约定**（真机实测，见 util.mjs 的注释）：
// claude / pi 记大写盘符，workbuddy 记小写盘符。不对齐就会算出另一个目录名 ——
// 写进另一个目录 = 侧栏两个同名项目。
// 另外 `resolveSlugDir` 还会优先复用**盘上已有**的同名目录（忽略大小写），
// 那是宿主已经开过这个项目时的兜底。

// Claude Code 原文 x0(e)：每个非字母数字 → '-'（不折叠、不转小写）；
// 超过 200 时截断并挂上 Math.abs(Java hashCode(原 cwd)).toString(36)
const CLAUDE_MAX = 200;

function javaHashBase36(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}

export function slugForClaude(cwd) {
  // claude 按 process.cwd() 记（大写盘符，本机 13/13 实测）
  const c = canonicalDirPath(cwd, { driveCase: 'upper' });
  if (!c) return null;
  const t = c.replace(/[^a-zA-Z0-9]/g, '-');
  if (t.length <= CLAUDE_MAX) return t;
  return `${t.slice(0, CLAUDE_MAX)}-${javaHashBase36(c)}`;
}

// WorkBuddy：仅 : \ / → "-"，折叠重复；点、下划线、空格原样保留
export function slugForWorkbuddy(cwd) {
  // workbuddy 记自己的 cwd：**小写盘符**（本机 46/47 条实测，与 claude/pi 相反）
  const c = canonicalDirPath(cwd, { driveCase: 'lower' });
  if (!c) return null;
  return c.replace(/[:\\/]/g, '-').replace(/-+/g, '-');
}

// Pi 原文（dist/core/session-manager.js:293）：
// `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
// 只动 / \ : 三个字符，其余（点、下划线、空格、中文）原样保留 —— 比 claude 窄得多
export function slugForPi(cwd) {
  // pi 按 process.cwd() 记（大写盘符，本机 4/4 实测）
  const c = canonicalDirPath(cwd, { driveCase: 'upper' });
  if (!c) return null;
  return `--${c.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// opencode 会话的 slug（opencode 与 opencode-classic 是同宿主的两个世代，规则必须一致 ——
// 否则同一条会话在两代宿主里的 slug 不同，跨代续写就找不到行）
export function slugOf(title) {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, 40) || `session-${newNodeId().slice(0, 8)}`;
}

// ---- 时间格式 ----

export function isoOf(ms) {
  const t = Number(ms) > 0 ? Number(ms) : Date.now();
  return new Date(t).toISOString();
}

// Pi 文件名的 ISO 片段：2026-08-10T05-56-16-791Z
export function isoFileStamp(ms) {
  return isoOf(ms).replace(/[:.]/g, '-');
}

// Codex 目录片段：['2026','10','14']
export function dateSegments(ms) {
  const d = new Date(Number(ms) > 0 ? Number(ms) : Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return [String(d.getUTCFullYear()), p2(d.getUTCMonth() + 1), p2(d.getUTCDate())];
}

// ---- JSONL 读写（对宿主并发友好）----

export function readJsonlFile(file) {
  if (!isFile(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 坏行忽略 */
    }
  }
  return out;
}

// 原子写曾是本文件私有实现，搬到 util 后仍然从这里导出（写侧调用点不必四处改 import）；
// 唯一的实现只有 util 那一份 —— provenance 的 sidecar 与备份快照也要用它，不能各写一套。
export { writeFileAtomic };

export function writeJsonlFile(file, objs, opts) {
  const body = objs.map((o) => JSON.stringify(o)).join('\n');
  return writeFileAtomic(file, objs.length ? `${body}\n` : '', opts);
}

/**
 * 追加写入：用 O_APPEND 打开后**一次** write 写完整个块。
 * - 单次 write 避免了「半个事件行」被宿主读到
 * - expectSize 给了就在写前校验文件大小，发现被别人改过就抛 concurrent-modification
 *   （调用方据此重建行并重试，见 appendJsonlRebuild）
 */
export function appendFileAtomic(file, content, opts = {}) {
  ensureDir(path.dirname(file));
  if (!content) return file;

  let prefix = '';
  if (isFile(file)) {
    const st = fs.statSync(file);
    if (opts.expectSize != null && st.size !== opts.expectSize) {
      const err = new Error(`concurrent-modification: ${file} (size ${st.size} != ${opts.expectSize})`);
      err.code = 'CONCURRENT_MODIFICATION';
      throw err;
    }
    if (st.size > 0) {
      const fd0 = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd0, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) prefix = '\n';
      } finally {
        fs.closeSync(fd0);
      }
    }
  }

  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, Buffer.from(`${prefix}${content}`, 'utf8'));
    try {
      fs.fsyncSync(fd);
    } catch {
      /* ignore */
    }
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

export function appendJsonlFile(file, objs, opts = {}) {
  if (!objs || objs.length === 0) return file;
  return appendFileAtomic(file, `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`, opts);
}

export function fileSizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 追加时若被并发修改则重建并重试。
 * buildLines() 必须自己重新读取「最后一个节点 id」以续接 parentId 链。
 * @returns {{lines:number, attempts:number, concurrentRetries:number}}
 */
export function appendJsonlRebuild(file, buildLines, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sizeBefore = fileSizeOf(file);
    const lines = buildLines();
    if (!lines || lines.length === 0) return { lines: 0, attempts: attempt, concurrentRetries: attempt - 1 };
    try {
      appendFileAtomic(file, `${lines.map((o) => JSON.stringify(o)).join('\n')}\n`, { expectSize: sizeBefore });
      return { lines: lines.length, attempts: attempt, concurrentRetries: attempt - 1 };
    } catch (err) {
      if (err?.code !== 'CONCURRENT_MODIFICATION') throw err;
      lastErr = err;
    }
  }
  const err = new Error(`append-conflict: ${file} 在 ${maxAttempts} 次重试后仍被并发修改`);
  err.code = 'APPEND_CONFLICT';
  err.cause = lastErr;
  throw err;
}

export function writeJsonFilePretty(file, obj) {
  return writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * 读回既有正文的统一口径：区分「不存在 / 空」「可读」「读不懂」。
 * 凡是从解析结果**整份重写**文件的 writer（codex .zst、dsh 多帧 zstd、cline 两代、freebuff），
 * 把「读不懂」当成空就会删掉用户已有历史 —— 真机实测一份含一行坏 JSON 的 .zst 被 11 行压成 2 行还报成功。
 */
export function parseJsonlStrict(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      return { ok: false, reason: `第 ${out.length + 1} 行不是合法 JSON` };
    }
  }
  return { ok: true, lines: out };
}

export function readJsonStrict(file) {
  if (!isFile(file)) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 140) };
  }
}

export function unreadableTarget(file, reason) {
  return `unreadable-target: ${file} 读不懂（${reason}）—— 已中止，一个字节都没写；修好或移走该文件再重跑`;
}

/**
 * 整份覆盖既有正文（create / fork）前的统一判定，两个结论都拒绝写入：
 *   解不开 → unreadable-target（「一行都读不出来」不等于「没有会话」，覆盖即销毁）
 *   有可读行 → target-exists
 * `read` 让压缩/多帧等非常规正文格式复用同一条规则（codex 传它的 .zst 读取器）。
 * force 是唯一显式授权的整份替换，不在这个判定里兜底。
 * @returns {{error: string} | null} null 表示可以整份写
 */
export function preflightOverwrite(file, { force = false, read = null } = {}) {
  if (force) return null;
  const res = read ? read(file) : (isFile(file) ? parseJsonlStrict(fs.readFileSync(file, 'utf8')) : { ok: true, lines: [] });
  if (!res.ok) return { error: unreadableTarget(file, res.reason) };
  return res.lines.length > 0 ? { error: 'target-exists' } : null;
}

export function readJsonFileSafe(file, fallback = null) {
  if (!isFile(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 字段路径的**唯一**解析：读、写、guard 判断都走这里。
 *
 * 两种写法：
 *   'a.b.c'                              点号路径
 *   ['conversations', {by:'id', eq:'$targetId'}, 'name']   数组里按字段值找元素
 * 第二种是 codebuddy-ide 的形态（标题挂在 conversations[] 的某个元素上）。
 * 以前读侧、写侧、槽机制各写一份点号遍历 —— 加一种形态就要改三处，必漏其一。
 *
 * @returns {{ok:true, holder:object, key:string} | {ok:false, reason:string}}
 */
export function resolveFieldPath(obj, field, vars = {}) {
  const segs = Array.isArray(field) ? field : String(field ?? '').split('.').filter(Boolean);
  if (!segs.length) return { ok: false, reason: 'field-missing' };
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (!cur || typeof cur !== 'object') return { ok: false, reason: 'field-path-absent' };
    if (typeof seg === 'string') {
      cur = cur[seg];
      continue;
    }
    if (!Array.isArray(cur)) return { ok: false, reason: 'field-path-absent' };
    const want = String(seg?.eq ?? '').startsWith('$') ? String(vars[String(seg.eq).slice(1)] ?? '') : String(seg?.eq ?? '');
    const hit = cur.find((x) => x && String(x[seg?.by] ?? '') === want);
    // 元素不存在 = 这条会话在索引里没有条目：宁可不写，也不替宿主新建（那会变成两个条目）
    if (!hit) return { ok: false, reason: 'array-entry-absent' };
    cur = hit;
  }
  const key = segs[segs.length - 1];
  if (typeof key !== 'string' || !cur || typeof cur !== 'object') return { ok: false, reason: 'field-path-absent' };
  return { ok: true, holder: cur, key };
}

/**
 * 读正文里**第一个**匹配 type 的行的某个字段（只读，不改文件）。
 *
 * 用途：判断「用户是否已在这个宿主里手动改过名」—— 真机取证 WorkBuddy：
 * 用户改名后正文里会多一条 custom-title 行，那条就是用户的决定，不能被源侧覆盖。
 *
 * field 支持点号路径（'data.title'）。
 */
export function readFirstJsonlField(file, type, field, opts = {}) {
  if (!isFile(file)) return { found: false, reason: 'file-absent' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { found: false, reason: `read-failed: ${err?.message ?? err}` };
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o?.type !== type) continue;
    const r = resolveFieldPath(o, field);
    if (!r.ok) return { found: false, reason: r.reason };
    return { found: true, value: r.holder[r.key] };
  }
  return { found: false, reason: 'row-absent' };
}

/**
 * 原地改写正文里**匹配 type 的行**的某个字段（其余行一字不动）。
 *
 * 为什么需要它：某些宿主的会话标题不在数据库列里，而在正文的标题行里
 * （真机取证 WorkBuddy：custom-title 行 > ai-title 行 > 首条用户文本）。
 * 追加一条新的标题行没用 —— 宿主只认**第一条**（`!r && ...`），追加的会被忽略；
 * 而追加路径又不重写文件头，所以「源侧改了名、复跑判内容相同」时标题永远停在旧值。
 *
 * 找不到匹配行时返回 changed=false（不凭空造一行：那会让宿主把两条标题行都留着）。
 *
 * opts.pick：
 *   'first'（默认）—— 宿主取第一条胜出（WorkBuddy 的 ai-title / custom-title）
 *   'last'         —— 宿主顺序消费、最后一条胜出（claude 的 ai-title 每会话可重复 6–23 条）
 *   'all'          —— 写全部同类型行，与宿主取值顺序解耦（dsh 的 session/title）
 *
 * 写前取快照、写时带 CAS：整份覆盖是「读整份→改一行→覆盖回去」，宿主在这期间追加的
 * 轮次会被抹掉（已行为取证）。命中并发改动时返回 retryable，由调用方重读重试。
 *
 * field 支持点号路径（'data.title'）：有的宿主把标题嵌在行对象的下一层
 * （dsh 的 session/title 行是 data.title）。
 */
export function rewriteFirstJsonlField(file, type, field, value, opts = {}) {
  if (!isFile(file)) return { changed: false, reason: 'file-absent' };
  let st0;
  try {
    st0 = fs.statSync(file);
  } catch (err) {
    return { changed: false, reason: `stat-failed: ${err?.message ?? err}` };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { changed: false, reason: `read-failed: ${err?.message ?? err}` };
  }
  const segs = Array.isArray(field) ? field : String(field ?? '').split('.').filter(Boolean);
  if (!segs.length) return { changed: false, reason: 'field-missing' };
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue; // 坏行不动它（整份重写会毁掉别人的历史）
    }
    if (o?.type === type) hits.push(i);
  }
  if (hits.length === 0) return { changed: false, reason: 'title-row-absent' };
  const pick = opts.pick ?? 'first';
  const targets = pick === 'all' ? hits : [pick === 'last' ? hits[hits.length - 1] : hits[0]];
  let updated = 0;
  for (const i of targets) {
    let row;
    try {
      row = JSON.parse(lines[i].trim());
    } catch {
      return { changed: false, reason: 'title-row-unreadable' };
    }
    const r = resolveFieldPath(row, field);
    if (!r.ok) return { changed: false, reason: r.reason };
    if (r.holder[r.key] === value) continue;
    r.holder[r.key] = value;
    lines[i] = JSON.stringify(row);
    updated++;
  }
  if (updated === 0) return { changed: false, reason: 'already-equal' };
  const backup = backupIfExists(file, opts.ctx, opts.variant);
  try {
    writeFileAtomic(file, lines.join('\n'), { expectSize: st0.size, expectMtimeMs: st0.mtimeMs });
  } catch (err) {
    if (err?.code === 'CONCURRENT_MODIFICATION') return { changed: false, reason: 'concurrent-modification', retryable: true };
    throw err;
  }
  return { changed: true, backup, updated };
}

// 追加/覆盖前的备份：宿主扫描根内**零残留**，一律落到 ~/.session-sync/backups/<变体>/。
//
// 为什么不能留在原地（原实现写 `<file>.bak-<ts>`）：dsh / freebuff 把根下任何目录都当
// 会话读，claude / workbuddy 按 mtime 取最新文件 —— 备份留在宿主目录里，轻则被判成
// 第二条会话，重则被当成更新的正本读走。落点必须唯一，所以这里不接受「不传就原地」。
//
// 目录镜像相对 home 的原路径（backups/claude/projects/<slug>/<id>.jsonl.bak-<ts>），
// 出问题时一眼就能对回是哪个文件的哪一刻；home 之外的绝对路径归到 _external/ 下。
export function backupPathFor(ctx, variant, file) {
  const dir = backupDirOf(ctx, variant);
  const abs = path.resolve(String(file));
  const rel = path.relative(path.resolve(backupHome(ctx)), abs);
  const name = `${path.basename(abs)}.bak-${Date.now()}`;
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  // 超长路径会撞 Windows 的 260 上限（claude 的 slug 本身就能有两百字符），超了就退到哈希名
  if (inside && path.join(dir, rel).length <= 200) return path.join(dir, `${rel}.bak-${Date.now()}`);
  const flat = inside ? rel : path.join('_external', ...abs.split(/[\\/]+/).filter(Boolean));
  return path.join(dir, '_long', `${sha256hex(flat).slice(0, 16)}-${name}`);
}

// 写前快照的唯一出口（文件或目录都走这条）：写入失败可回滚，且宿主扫描根内零残留。
export function backupCopy(ctx, variant, src) {
  const dst = backupPathFor(ctx, variant, src);
  ensureDir(path.dirname(dst));
  copyTree(src, dst);
  return dst;
}

// 只对已存在的普通文件做快照（不存在就没什么可备份的，返回 null 让调用方如实透出）
export function backupIfExists(file, ctx, variant) {
  return isFile(file) ? backupCopy(ctx, variant, file) : null;
}

// 已有 JSONL 的最后一个节点 id（用于续接 parentId 链）
export function lastNodeId(file, field = 'uuid') {
  if (!isFile(file)) return null;
  const lines = readJsonlFile(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.[field]) return lines[i][field];
  }
  return null;
}

// 新节点 id：优先用宿主同类 id 形态（uuid），保证 parentId 链合法
export function newNodeId() {
  return uuidv7();
}

export function relToCwd(p, cwd) {
  if (!p) return p;
  const c = String(cwd ?? '');
  if (!c) return p;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(p);
  const b = norm(c);
  return a.toLowerCase().startsWith(`${b.toLowerCase()}/`) ? a.slice(b.length + 1) : p;
}
