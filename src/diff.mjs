// diff.mjs — 差异决策：skip / append / fork
//
// 判据顺序（用户 2026-10-27 定稿）：
//   1) 身份判据：sameLineage = originKey(source) === originKey(target)。
//      目标原生时 root 就是它自己，导入会话 root 取 provenance.origin。
//      身份不同 → 绝不 append/skip（两条同内容但不同 root 的原生会话不得合并），
//      在派生 ID 上判为占位冲突 → fork + reason=identity-mismatch。
//   2) 内容判据（按轮次核心指纹求最长公共前缀 LCP）：
//      - 完全一致                              → skip
//      - 目标更长（目标已有新增）              → skip（目标在前，无需动作）
//      - 目标严格前缀，源有新增                → append（原生会话同样允许，写侧剥离 provenance）
//      - 双方都有内容                          → fork（新 fork ID + 标题标记）
//
// 默认用「核心指纹」（消息文本 + 工具调用），见 ir.mjs 的说明：reasoning 与
// tool_result 输出跨宿主不可靠，用全量指纹会把同一会话误判成分叉。
// strict=true 时退回全量指纹（更严格，用于诊断）。
import { sessionFingerprints, sessionCoreFingerprints } from './ir.mjs';

export function lcpLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** short 是否为 long 的前缀（含完全相同）—— 前缀判定只有这一处实现 */
export function isFpPrefix(short, long) {
  if (!Array.isArray(short) || !Array.isArray(long) || short.length > long.length) return false;
  return lcpLength(short, long) === short.length;
}

// 这里**不**算 fork 的分支坐标。曾经有一份「源侧 LCP 之后的整段后缀」哈希，
// 语义是错的：同一分支每续一轮后缀就变，fork ID 跟着变，会累积出多条近似副本。
// 正确坐标（父基准 ID + 分歧点 + 第 k 轮指纹）在 identity.forkBranchKey，
// 本函数只报出「在第几轮分歧」，算坐标是调用方拿着 at 去做的事。
function forkAt(sourceSession, at, reason = null) {
  return { action: 'fork', at, reason };
}

/**
 * @param source 源 IR
 * @param target 目标 IR（读回；不存在为 null）
 * @param sameLineage 源与目标是否同一身份（originKey 相等；原生目标的 root 就是它自己）
 * @param opts {strict?:boolean} strict=true 用全量指纹
 * @returns {{action:'create'|'skip'|'append'|'fork', at?:number, reason?:string}}
 */
export function decideAction(source, target, sameLineage = true, opts = {}) {
  if (!target) return { action: 'create' };

  const fp = opts.strict ? sessionFingerprints : sessionCoreFingerprints;
  const srcFp = fp(source);
  const dstFp = fp(target);

  if (srcFp.length === dstFp.length && srcFp.every((f, i) => f === dstFp[i])) {
    if (!sameLineage) return forkAt(source, srcFp.length, 'identity-mismatch');
    return { action: 'skip', reason: 'identical' };
  }

  const k = lcpLength(srcFp, dstFp);

  // 身份不同：无论内容关系如何都不合并，按占位冲突 fork
  if (!sameLineage) return forkAt(source, k, 'identity-mismatch');

  // 源是目标的前缀：目标已在前，源无新增
  if (isFpPrefix(srcFp, dstFp)) {
    return { action: 'skip', reason: 'target-ahead' };
  }

  // 目标是源的严格前缀 → 追加源新增轮次（原生会话同样允许）
  if (isFpPrefix(dstFp, srcFp)) {
    return { action: 'append', at: k };
  }

  return forkAt(source, k);
}
