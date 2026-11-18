// identity.mjs — 零登记表身份模型：originKey → 各家目标会话 ID 确定性派生
//
// 核心不变量（按用户要求，不建登记表）：
//   1. originKey = `<变体>:<原生会话ID>`，同一原始会话无论经哪条链路到达，
//      originKey 相同 → 在同一目标变体上派生出同一会话 ID → 天然去重
//   2. origin 变体 === 目标变体（round-trip 导回）→ 目标 ID = 原生会话 ID 本身
//   3. fork ID = uuid5(NS, originKey + "#fork:" + 分歧内容哈希)：同一分歧内容
//      经不同路径到达 → 同一 fork；不同分歧 → 不同 fork
import { uuid5, sha256hex, stableStringify, NAMESPACE_DNS } from './util.mjs';
import { turnCore } from './ir.mjs';
import { mintNativeOpencodeId } from './opencode-id.mjs';

// 固定命名空间：由标准 DNS namespace + 项目名确定性引导，换会话/机器不变
export const NS = uuid5('session-sync/identity/v1', NAMESPACE_DNS);

// 原生 ID 为 uuid 形态的家族
export const UUID_FAMILY = new Set([
  'workbuddy-cn', 'workbuddy-intl', 'claude', 'codebuddy', 'pi', 'codex', 'dsh', 'cursor', 'kilo',
]);

export function rootOf(session) {
  // IR 用 `.origin`；列表摘要只有 `.provenance.origin` —— 两种形态在这里统一，调用方不必各写一份
  const origin = session?.origin ?? session?.provenance?.origin ?? null;
  if (origin?.variant) {
    return { variant: origin.variant, sessionId: String(origin.sessionId) };
  }
  return { variant: session?.variant, sessionId: String(session?.id) };
}

export function originKeyOf(session) {
  const root = rootOf(session);
  return `${root.variant}:${root.sessionId}`;
}

// 13 位十进制毫秒级时间戳形态（Cline 用时间戳做任务 ID，非数字会打乱排序）
function mintTimestampLike(key) {
  const n = BigInt(`0x${sha256hex(key).slice(0, 16)}`);
  // 落在 [1.0e12, 1.0e13) → 合法 13 位 ms 时间戳区间
  return String(n % 9000000000000n + 1000000000000n);
}

function mintByFamily(variant, key, ts) {
  if (UUID_FAMILY.has(variant)) return uuid5(key, NS);
  const hex = sha256hex(key);
  switch (variant) {
    // OpenCode v2 本地 schema 只要求 `ses` 前缀，但 Zen 网关续写时另要求宿主原生
    // Identifier 形态（12hex 降序时间戳 + 14base62，共 26 位）且前缀时间戳 sane；
    // `ses_<32hex>` 列表可见却续写 429。前缀取源 createdAt、后缀取 key 哈希，确定性保留。
    case 'opencode':
      return mintNativeOpencodeId(key, ts);
    case 'mimo':
      return `ses_${hex.slice(0, 22)}`;
    case 'zcode':
      // SessionId = sess_<uuid>（contracts/src/interfaces/shared.ts:31），
      // 工具层还校验 /^(?:current|sess_[A-Za-z0-9._-]+)$/；裸 32 hex 与原生形态不符
      return `sess_${uuid5(key, NS)}`;
    case 'minimax':
      return `mvs_${hex.slice(0, 32)}`;
    case 'freebuff':
      return `sync-${hex.slice(0, 16)}`;
    case 'qoder-cn':
    case 'qoder-intl':
      return hex.slice(0, 20);
    case 'cline':
    case 'roo': // Roo 任务 ID 与 Cline 一样是时间戳形态
      return mintTimestampLike(key);
    default:
      return hex.slice(0, 32);
  }
}

// 普通导入目标 ID（ts = 源会话 createdAt，供 opencode 原生降序时间戳前缀；其余变体忽略）
export function mintTargetId(targetVariant, originKey, ts) {
  return mintByFamily(targetVariant, originKey, ts);
}

/**
 * fork 的分支坐标：父基准本地 ID + 分歧点 k + **第 k 轮**的核心指纹。
 *
 * 只取第 k 轮，不取「从 k 开始的整段后缀」：后缀哈希下，同一分支每续一轮尾巴就变，
 * fork ID 跟着变 —— 同一个分支在不同时刻导入会累积出多条近似副本。
 * 这条曾经有两份实现（diff.divergenceHash 用整段后缀、import 用第 k 轮），
 * 两份都在跑，测试还按后缀语义断言过。现在只有这一份，diff 与 import 都走它。
 */
export function forkBranchKey(parentId, at, turn) {
  return sha256hex(stableStringify({ parent: String(parentId), at, turn: turn ? turnCore(turn) : null }));
}

// 分叉会话 ID：同一分支坐标（forkBranchKey 相同）→ 同一 fork
export function mintForkId(targetVariant, originKey, branchKey, ts) {
  return mintByFamily(targetVariant, `${originKey}#fork:${branchKey}`, ts);
}

// 源会话 → 目标会话 ID（含 round-trip 特判）
export function targetSessionId(targetVariant, sourceSession) {
  const root = rootOf(sourceSession);
  if (root.variant === targetVariant) return root.sessionId; // 导回原生变体 → 收敛到原生会话
  return mintTargetId(targetVariant, originKeyOf(sourceSession), sourceSession?.createdAt ?? sourceSession?.updatedAt);
}

// 分叉场景的源会话 → fork 会话 ID（branchKey 由 forkBranchKey 算出）
export function forkSessionId(targetVariant, sourceSession, branchKey) {
  return mintForkId(targetVariant, originKeyOf(sourceSession), branchKey, sourceSession?.createdAt ?? sourceSession?.updatedAt);
}
