// verify.mjs — 写后读回校验
//
// 用目标变体的 reader 读回刚写入的会话，与源 IR 比对：
//   - create/append：目标必须按序包含源的全部轮次（前缀一致，目标可更长）
//   - fork：目标与源在分歧点前一致，且含源的分歧后缀
//
// 默认比对「核心指纹」（消息文本 + 工具调用）：reasoning / tool_result 输出
// 跨宿主不可靠，用全量指纹会把正确写入误报成失败。strict=true 时用全量。
import { coreItem, normalizeText, sessionFingerprints, sessionCoreFingerprints } from './ir.mjs';
import { compactionInjectionKind } from './text.mjs';

const COMPACTION_TARGETS = new Set(['codex', 'minimax', 'opencode', 'workbuddy-cn', 'workbuddy-intl']);

function userTextRuns(turn, allowLegacyTags = false) {
  const runs = [];
  for (const item of turn?.items ?? []) {
    if (item.kind !== 'message' || item.role !== 'user') continue;
    const text = coreItem(item)?.t;
    if (!text) continue;
    const compact = item.compact === true || (allowLegacyTags && compactionInjectionKind(item.text) !== null);
    const previous = runs.at(-1);
    if (previous?.compact === compact) previous.text = normalizeText(previous.text + '\n\n' + text);
    else runs.push({ compact, text });
  }
  return runs;
}

export function verifyImported({ readSession, variant, sessionId, expectSource, mode = 'create', strict = false, fromTurnIndex = 0 }) {
  const target = readSession(variant, sessionId);
  if (!target) {
    return { ok: false, reason: 'not-found', variant, sessionId };
  }
  if (target.meta?.historyError || expectSource?.meta?.historyError) {
    return { ok: false, reason: 'history-incomplete', error: target.meta?.historyError ?? expectSource.meta.historyError, variant, sessionId };
  }
  const fp = strict ? sessionFingerprints : sessionCoreFingerprints;
  const got = fp(target);
  const result = { ok: true, variant, sessionId, turns: got.length, strict, mismatches: [], provenance: target.origin ?? null };

  if (!expectSource) return result;

  const want = fp(expectSource);
  if (COMPACTION_TARGETS.has(variant)) {
    const compactionMismatches = [];
    for (let i = fromTurnIndex; i < want.length; i++) {
      const sourceRuns = userTextRuns(expectSource.turns[i], true);
      const targetRuns = userTextRuns(target.turns[i]);
      if ((sourceRuns.some((run) => run.compact) || targetRuns.some((run) => run.compact)) &&
          JSON.stringify(sourceRuns) !== JSON.stringify(targetRuns)) compactionMismatches.push(i);
    }
    if (compactionMismatches.length) {
      result.ok = false;
      result.reason = 'compaction-mismatch';
      result.compactionMismatches = compactionMismatches;
    }
  }

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
