// writers/title-slots.mjs — 标题落点的统一声明与更新
//
// 为什么单独一份：会话标题在各家宿主里落在**不同形状**的地方（数据库列 / 正文标题行 /
// 首问派生无处可落），但「源侧改名后要把新名同步到目标」这件事的**逻辑**完全一样。
// 拆成「槽声明 + 一份更新逻辑」后：加一家宿主 = 加一条声明，不再各写一份 syncTitle。
//
// 槽的几种形状：
//   { kind: 'db-column', db: (ctx) => path|null, table, idCol, col, maxLen? }
//     数据库里的一列（qoder 的 chat_sessions.title / opencode 的 session_v2.title …）
//   { kind: 'body-row', file: (ctx, targetId) => path|null, type, field }
//     正文里第一行匹配 type 的那个字段（workbuddy 的 ai-title 行 / codebuddy 的 custom-title 行 …）
//     field 支持点号路径（'data.title'），因为有的宿主把标题嵌在 data 里（dsh 的 session/title 行）。
//   { kind: 'json-file', file: (ctx, targetId) => path|null, field }
//     独立 JSON 文件里的一个字段（cline 4.x 的 <id>.json 的 metadata.title）。
//
// guard（可选）：标了 guard 的槽是「用户自己起的名」的落点 ——
//   它非空 = 用户在目标宿主里手动改过名 = 源侧改名不该覆盖它（用户的决定优先于源侧）。
//   真机取证 WorkBuddy：custom_title 列 + 正文 custom-title 行就是这个语义。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isFile } from '../util.mjs';
import { normalizeTitle, fitTitleFor } from '../titles.mjs';
import { rewriteFirstJsonlField, writeJsonFilePretty, backupIfExists, readFirstJsonlField, resolveFieldPath, keyWhereOf } from './base.mjs';
import { tableColumns, dbReadError } from '../readers/base.mjs';

/**
 * 读一个槽当前的值（guard 槽用它判断「用户是否已定名」）。
 *
 * 返回 `{ok:true, value}` 或 `{ok:false, reason}` —— 这个区分是硬要求：
 *   「落点不存在」（文件/表/行/列缺）→ ok:true, value:null：确认用户没定名，可以同步
 *   「读失败」（库打不开/SQL 异常/JSON 坏/解帧失败/复合键算不出来）→ ok:false：
 *      不知道用户定没定名，必须**按已定名处理**（fail-closed），否则一次锁库就能把用户
 *      自己起的名字覆盖掉（review 2026-11-04 P1）。
 */
function readSlotValue(slot, ctx, targetId) {
  if (slot.kind === 'db-column') {
    const file = slot.db?.(ctx) ?? null;
    if (!file || !fs.existsSync(file)) return { ok: true, value: null };
    let db;
    try {
      db = new DatabaseSync(file);
      try {
        db.exec('PRAGMA busy_timeout = 8000');
      } catch {
        /* 老驱动不支持就算了，下面照样读 */
      }
    } catch (err) {
      return { ok: false, reason: `db-open-failed: ${err?.message ?? err}` };
    }
    try {
      // 先证「这个库能读」再看表：坏库/被锁库的 PRAGMA 会抛，而 tableColumns 把它吞成 []，
      // 两者在这里必须区分开 —— 否则坏库 = 「列不存在」= 「用户没定名」= 覆盖用户标题
      const readErr = dbReadError(db);
      if (readErr) return { ok: false, reason: `db-read-failed: ${readErr}` };
      const cols = tableColumns(db, slot.table);
      const idCols = Array.isArray(slot.idCol) ? slot.idCol : [slot.idCol];
      // 列不存在 = 这个宿主根本没有这个槽，先于键判定：键算不出来只影响「能不能定位行」，
      // 连列都没有时谈不上定位（也省掉一次可能跨库的 idVals 反查）
      if (!idCols.every((c) => cols.includes(c)) || !cols.includes(slot.col)) return { ok: true, value: null };
      // 复合键算不出来 = 不知道自己该看哪一行 → 不能说「用户没定名」（键解析唯一出口见 base.mjs）
      const kw = keyWhereOf(slot, ctx, targetId);
      if (!kw.ok) return { ok: false, reason: kw.reason };
      const row = db.prepare(`SELECT ${slot.col} AS v FROM ${slot.table} WHERE ${kw.sql}`).get(...kw.vals);
      return { ok: true, value: row ? row.v : null };
    } catch (err) {
      return { ok: false, reason: `db-read-failed: ${err?.message ?? err}` };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (slot.kind === 'json-file') {
    const file = slot.file?.(ctx, targetId) ?? null;
    if (!file || !isFile(file)) return { ok: true, value: null };
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return { ok: false, reason: `json-parse-failed: ${err?.message ?? err}` };
    }
    const r = resolveFieldPath(obj, slot.field, { targetId });
    if (!r.ok) return { ok: true, value: null };
    return { ok: true, value: r.holder[r.key] };
  }
  // body-row
  const file = slot.file?.(ctx, targetId) ?? null;
  if (!file) return { ok: true, value: null };
  if (slot.io) {
    const r = slot.io.readFirst(file, slot.type, slot.field);
    if (r?.ok === false) return { ok: false, reason: r.reason };
    return { ok: true, value: r?.found ? r.value : null };
  }
  const r = readFirstJsonlField(file, slot.type, slot.field);
  if (!r.found && /^(read-failed|stat-failed)/.test(String(r.reason ?? ''))) return { ok: false, reason: r.reason };
  return { ok: true, value: r.found ? r.value : null };
}

/**
 * guard 的「已定名」判定。
 * 数字位要单独处理：zcode 的 title_overridden = 0 意思是「没被用户改过」，
 * 按 `String(0).trim() !== ''` 判会把 0 当成已定名 —— guard 永远成立、drift 永久失效。
 */
function isGuardSet(v) {
  if (v == null) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'boolean') return v;
  return String(v).trim() !== '';
}

// 槽落值 = 写侧唯一出口的薄封装：容量取槽声明，没声明就退回该变体的原生容量
function slotValue(slot, variant, title) {
  return fitTitleFor(variant, title, slot.maxLen ?? null);
}

function updateDbColumn(slot, ctx, variant, targetId, title) {
  const sv = slotValue(slot, variant, title);
  const file = slot.db?.(ctx) ?? null;
  if (!file || !fs.existsSync(file)) return { changed: false, reason: 'db-absent' };
  let db;
  try {
    db = new DatabaseSync(file);
  } catch (err) {
    return { changed: false, reason: `db-open-failed: ${err?.message ?? err}` };
  }
  try {
    const cols = tableColumns(db, slot.table);
    // 复合主键的行按「若干列 = 若干值」定位（zcode 的 tasks 是 (workspace_key, task_id)）——
    // 键解析只有 base.mjs 的 keyWhereOf 一处，读 guard 与这里共用同一份，
    // 免得「读的判据」和「写的判据」各漂各的。
    // 列检查必须先于键判定：连列都没有时谈不上定位，也不该报成 key-unresolved
    const idCols = Array.isArray(slot.idCol) ? slot.idCol : [slot.idCol];
    if (!idCols.every((c) => cols.includes(c)) || !cols.includes(slot.col)) return { changed: false, reason: 'schema-absent' };
    const kw = keyWhereOf(slot, ctx, targetId);
    if (!kw.ok) return { changed: false, reason: kw.reason };
    const cur = db.prepare(`SELECT ${slot.col} AS v FROM ${slot.table} WHERE ${kw.sql}`).get(...kw.vals);
    if (!cur) return { changed: false, reason: 'row-absent' };
    const value = sv.value;
    if (String(cur.v ?? '') === value) return { changed: false, reason: 'already-equal' };
    db.prepare(`UPDATE ${slot.table} SET ${slot.col} = ? WHERE ${kw.sql}`).run(value, ...kw.vals);
    return { changed: true };
  } catch (err) {
    return { changed: false, reason: `db-update-failed: ${err?.message ?? err}` };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 正文行的标题改写。
 *
 * io（可选）：正文不是明文 JSONL 的宿主（dsh 是 zstd 多帧）由 writer 自己解帧/编码 ——
 * 格式知识留在 writer，这里只负责「调它 + 并发重试」。
 *
 * 重试 3 次：整份覆盖会被宿主并发追加打断（CAS 命中），重读重生一次通常就好了。
 * 用尽仍冲突 → 返回 concurrent-modification（由上层记 warning，不抛：标题没同步上
 * 远好过让整条导入失败）。
 */
function updateBodyRow(slot, ctx, variant, targetId, title) {
  const sv = slotValue(slot, variant, title);
  const file = slot.file?.(ctx, targetId) ?? null;
  if (!file) return { changed: false, reason: 'body-file-absent' };
  const value = sv.value;
  const writeOnce = slot.io
    ? () => slot.io.rewriteFirst(file, slot.type, slot.field, value, ctx)
    : () => rewriteFirstJsonlField(file, slot.type, slot.field, value, { pick: slot.pick ?? 'first', ctx, variant });
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = writeOnce();
    if (!r?.retryable) break;
  }
  if (r?.retryable) return { changed: false, reason: 'concurrent-modification' };
  return { changed: Boolean(r?.changed), reason: r?.reason };
}

function updateJsonFile(slot, ctx, variant, targetId, title) {
  const sv = slotValue(slot, variant, title);
  const file = slot.file?.(ctx, targetId) ?? null;
  if (!file || !isFile(file)) return { changed: false, reason: 'json-file-absent' };
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { changed: false, reason: `json-parse-failed: ${err?.message ?? err}` };
  }
  const r = resolveFieldPath(obj, slot.field, { targetId });
  // 元素不存在就不同步：宁可不写，也不替宿主新建一条会话索引（那会变成两个条目）
  if (!r.ok) return { changed: false, reason: r.reason };
  const value = sv.value;
  if (String(r.holder[r.key] ?? '') === value) return { changed: false, reason: 'already-equal' };
  r.holder[r.key] = value;
  // 原子写（复用 base 的 writeJsonFilePretty）：裸 writeFileSync 写中断会留下半个 JSON，
  // 宿主读到坏 manifest 时整个会话列表都可能起不来。
  try {
    backupIfExists(file, ctx, variant);
    writeJsonFilePretty(file, obj);
  } catch (err) {
    return { changed: false, reason: `json-write-failed: ${err?.message ?? err}` };
  }
  return { changed: true };
}

/**
 * 把新标题同步到目标宿主声明的所有槽。
 *
 * guard 优先：标了 guard 的槽是「用户自己起的名」的落点，它非空就说明用户在
 * 目标宿主里手动改过名 —— 用户的决定优先于源侧改名，整个同步跳过。
 * （真机取证 WorkBuddy：db custom_title 列 + 正文 custom-title 行）
 *
 * @param {object} ctx
 * @param {Array} slots 各家声明的标题落点
 * @param {{targetId:string, title:string}} args
 * @returns {{ok:boolean, changed:boolean, warnings:string[], details:object[]}}
 */
export function applyTitleSlots(ctx, slots, { targetId, title, variant }) {
  const warnings = [];
  const details = [];
  let changed = false;
  // 折叠空白：宿主读侧普遍把连续空白折成一个空格，写侧不折就等于「写进去的和读回来的
  // 不是同一个字符串」，每轮都被判成漂移。容量由各槽的 maxLen 校验（装不下就报错，不截断）。
  const newTitle = normalizeTitle(title);
  if (!newTitle) return { ok: true, changed: false, warnings, details };

  // guard：用户在目标侧已定名 → 不覆盖（源侧改名不夺走用户的决定权）
  for (const slot of slots ?? []) {
    if (!slot.guard) continue;
    const r = readSlotValue(slot, ctx, targetId);
    if (!r.ok) {
      // fail-closed：读不出来就不知道用户有没有定名，按「已定名」处理。
      // 以前的写法把读失败当 null（未定名），一次锁库/SQL 异常就能把用户自己起的名字覆盖掉。
      details.push({ kind: slot.kind, table: slot.table, type: slot.type, guard: true, skipped: 'guard-unreadable', reason: r.reason });
      warnings.push(`title-guard-unreadable: ${slot.table ?? slot.type ?? slot.kind}（${r.reason}）—— 本次不同步，避免覆盖用户自己起的名字`);
      return { ok: true, changed: false, warnings, details, skipped: 'guard-unreadable' };
    }
    if (isGuardSet(r.value)) {
      details.push({ kind: slot.kind, table: slot.table, type: slot.type, guard: true, skipped: 'user-defined-title' });
      return { ok: true, changed: false, warnings, details, skipped: 'user-defined-title' };
    }
  }

  for (const slot of slots ?? []) {
    if (slot.guard) continue; // guard 槽只读，不写
    let r;
    try {
      if (slot.kind === 'db-column') r = updateDbColumn(slot, ctx, variant, targetId, newTitle);
      else if (slot.kind === 'json-file') r = updateJsonFile(slot, ctx, variant, targetId, newTitle);
      else r = updateBodyRow(slot, ctx, variant, targetId, newTitle);
    } catch (err) {
      r = { changed: false, reason: `slot-failed: ${err?.message ?? err}` };
    }
    details.push({ kind: slot.kind, table: slot.table, type: slot.type, ...r });
    if (r.changed) changed = true;
    else if (r.reason && r.reason !== 'already-equal') warnings.push(`title-slot-${slot.kind}${slot.table ? `:${slot.table}` : `:${slot.type}`}: ${r.reason}`);
  }
  return { ok: true, changed, warnings, details };
}

/**
 * 各家 writer 共用的 syncTitle 实现：只认「标题槽声明」。
 * 没有槽声明的宿主 = 它的标题是首问派生的（claude/codex/pi/freebuff…），
 * 改名无处可落，返回 changed=false（不改内容、不假装同步过）。
 *
 * 函数上带 __fromTitleSlots 标记：结构门禁（test/m61）据此断言「没有 writer 手写 syncTitle」——
 * 标题同步必须是这一份统一机制，不许再长出第二套。
 */
export function makeTitleSyncer(slotsFor, variant) {
  const fn = function syncTitle(ctx, { targetId, title }) {
    const slots = typeof slotsFor === 'function' ? slotsFor(ctx, { targetId, title }) : slotsFor;
    return applyTitleSlots(ctx, slots, { targetId, title, variant });
  };
  fn.__fromTitleSlots = true;
  fn.__slotsFor = slotsFor;
  return fn;
}
