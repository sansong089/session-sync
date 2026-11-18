// opencode-id.mjs — OpenCode 新版（session_v2）的会话 ID 形态
//
// 本地 schema 约束（packages/schema/src/session-id.ts）：
//   Session.ID = Schema.String.check(Schema.isStartingWith("ses"))
// 只校验前缀，所以 `ses_<32hex>` 能过本地校验、会话列表也显示。
//
// 但 Zen 网关（opencode.ai/inference）另有一道隐性契约：会话 ID 必须能按宿主
// 原生 Identifier 解析 —— `ses_` + 12 hex（降序时间戳）+ 14 base62，共 26 位，
// 且前缀解出的时间戳必须 sane（全 0 解出 epoch 0 会被拒）。不满足时网关回
// FreeUsageLimitError(429)「Free usage limit reached」，与真实配额无关：
// 同一时刻原生格式 ID 成功、`ses_<32hex>` 失败，与历史体量/provenance/model 均无关
// （真机交叉实验取证，见 test/m87）。宿主 Identifier 算法（二进制实证）：
//   r = BigInt(now)*0x1000n + counter; a = descending ? ~r : r;
//   prefix = 6 字节 (a>>40..a>>0) 各 toString(16).padStart(2); suffix = 14 个 base62。
//
// 本工具历史上派生裸 uuid → /api/session 整页 500；改 `ses_<32hex>` 后列表正常
// 但续写被网关 429。现统一为原生 26 位形态：前缀取源会话 createdAt（确定性且
// sane），后缀取 originKey 哈希（确定性 → 去重不变量保留）。

import { sha256hex } from './util.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const NATIVE_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function isOpencodeSessionId(id) {
  return /^ses/.test(String(id ?? ''));
}

// 宿主原生 Identifier 形态（网关唯一接受的续写 ID 形态）
export function isNativeOpencodeId(id) {
  return NATIVE_RE.test(String(id ?? ''));
}

// 降序时间戳前缀 12 hex：复刻宿主 Dee(descending=true)，counter 固定 1（低 12 位 = 0xffe）
function descendingPrefix(ts, counter = 1) {
  const r = BigInt(Math.floor(Number(ts))) * 0x1000n + BigInt(counter);
  const a = ~r;
  let c = '';
  for (let d = 0; d < 6; d++) c += Number((a >> BigInt(40 - 8 * d)) & 0xffn).toString(16).padStart(2, '0');
  return c;
}

// 确定性原生 ID：前缀 = 源 createdAt 的降序编码，后缀 = key 哈希的 14 位 base62。
// 同一 (key, ts) 恒定复现 → 跨次导入去重；ts 缺省回退 updatedAt / 固定 sane 常量。
export function mintNativeOpencodeId(key, ts) {
  let t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) t = Date.UTC(2026, 0, 1);
  const hex = sha256hex(String(key));
  let suffix = '';
  for (let i = 0; i < 14; i++) suffix += BASE62[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 62];
  return `ses_${descendingPrefix(t)}${suffix}`;
}

// 存量导入行（裸 uuid / ses_<32hex>）→ 原生确定性 ID。
// key 取 provenance origin（与 identity.mintTargetId 同口径），ts 取该行 time_created
// （写入时即源 createdAt）→ 迁移后的 id 与未来重新派生的 id 完全一致，skip/append 收敛。
export function importedNativeId(row) {
  let origin = null;
  try {
    origin = JSON.parse(row?.metadata ?? 'null')?.['session-sync']?.origin ?? null;
  } catch {
    origin = null;
  }
  const key = origin?.variant ? `${origin.variant}:${origin.sessionId}` : String(row?.id ?? '');
  return mintNativeOpencodeId(key, row?.time_created);
}

// 旧导入行（裸 uuid / 32 位 hex）→ 符合当前 schema 的会话 ID
export function canonicalOpencodeId(id) {
  const value = String(id ?? '');
  if (isOpencodeSessionId(value)) return value;
  if (UUID_RE.test(value)) return `ses_${value.replace(/-/g, '').toLowerCase()}`;
  if (HEX32_RE.test(value)) return `ses_${value.toLowerCase()}`;
  return null;
}

// 新会话 ID → 旧导入行的裸 uuid（仅用于读取迁移前的存量行）
export function legacyOpencodeId(id) {
  const value = String(id ?? '');
  if (!value.startsWith('ses_')) return null;
  const hex = value.slice(4);
  if (!HEX32_RE.test(hex)) return null;
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
