// verify.mjs — 写后读回校验
//
// 用目标变体的 reader 读回刚写入的会话，与源 IR 比对：
//   - create/append：目标必须按序包含源的全部轮次（前缀一致，目标可更长）
//   - fork：目标与源在分歧点前一致，且含源的分歧后缀
//
// 默认比对「核心指纹」（消息文本 + 工具调用）：reasoning / tool_result 输出
// 跨宿主不可靠，用全量指纹会把正确写入误报成失败。strict=true 时用全量。
import { sessionFingerprints, sessionCoreFingerprints } from './ir.mjs';

export function verifyImported({ readSession, variant, sessionId, expectSource, mode = 'create', strict = false }) {
  const target = readSession(variant, sessionId);
  if (!target) {
    return { ok: false, reason: 'not-found', variant, sessionId };
  }
  const fp = strict ? sessionFingerprints : sessionCoreFingerprints;
  const got = fp(target);
  const result = { ok: true, variant, sessionId, turns: got.length, strict, mismatches: [], provenance: target.origin ?? null };

  if (!expectSource) return result;

  const want = fp(expectSource);

  if (mode === 'fork') {
    for (let i = 0; i < Math.min(want.length, got.length); i++) {
      if (want[i] !== got[i]) result.mismatches.push({ index: i, want: want[i], got: got[i] });
    }
    if (got.length < want.length) {
      result.ok = false;
      result.reason = 'turn-count';
    }
    if (result.mismatches.length > 0) {
      result.ok = false;
      result.reason = result.reason || 'fingerprint-mismatch';
    }
    return result;
  }

  // create / append：源全部轮次必须按序出现在目标中
  if (got.length < want.length) {
    result.ok = false;
    result.reason = 'turn-count';
  }
  for (let i = 0; i < want.length; i++) {
    if (i >= got.length || want[i] !== got[i]) {
      result.mismatches.push({ index: i, want: want[i], got: got[i] });
    }
  }
  if (result.mismatches.length > 0) {
    result.ok = false;
    result.reason = result.reason || 'fingerprint-mismatch';
  }
  return result;
}
