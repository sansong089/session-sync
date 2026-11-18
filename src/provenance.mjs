// provenance.mjs — 会话内嵌来源标记（origin + chain），随会话传播
//
// 结构：{origin:{variant,sessionId}, chain:[{variant,sessionId,at}], tool:"session-sync", v:1}
// - origin = 最上游原始会话（root）；chain = 经过的每一跳（含当前持有者）
// - 多路径收敛的依据：任何路径读到的 origin 相同 → originKey 相同
// - 本模块只管结构与通用槽位助手；各家具体落点由 reader/writer 实现
import fs from 'node:fs';
import path from 'node:path';
import { nowMs, writeFileAtomic } from './util.mjs';
import { normalizeTitle } from './titles.mjs';
import { rootOf } from './identity.mjs';

export const PROVENANCE_VERSION = 1;
export const TOOL_NAME = 'session-sync';

// root（原生 → 自身；导入 → 其内嵌 origin）只有一份实现，见 identity.mjs
export { rootOf as rootOfSession } from './identity.mjs';

// 构造要写入目标会话的 provenance：chain 末尾追加源会话自己这一跳
// placed = {directory, scope}：本次落点。reader 见到 session-sync 行时按它分类，
// 不按「当前目录像不像项目」猜（规则 4），否则搬过一次就会换分类、再搬一次。
export function buildProvenance(sourceSession, at = nowMs(), placed = null) {
  const chain = Array.isArray(sourceSession.chain) ? sourceSession.chain.slice() : [];
  const last = chain[chain.length - 1];
  if (!last || last.variant !== sourceSession.variant || String(last.sessionId) !== String(sourceSession.id)) {
    chain.push({ variant: sourceSession.variant, sessionId: String(sourceSession.id), at });
  }
  const out = {
    origin: rootOf(sourceSession),
    chain,
    tool: TOOL_NAME,
    v: PROVENANCE_VERSION,
  };
  if (placed && (placed.directory || placed.scope || placed.from)) {
    out.placed = { directory: String(placed.directory ?? ''), scope: placed.scope === 'project' ? 'project' : 'none' };
    if (placed.from) out.placed.from = String(placed.from);
  }
  return out;
}

// 从任意对象中解析 provenance（宽松校验，非法返回 null）
export function provenanceFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.tool !== TOOL_NAME || obj.v !== PROVENANCE_VERSION) return null;
  const origin = obj.origin;
  if (!origin || typeof origin.variant !== 'string' || origin.sessionId == null) return null;
  const chain = Array.isArray(obj.chain)
    ? obj.chain
        .filter((h) => h && typeof h.variant === 'string' && h.sessionId != null)
        .map((h) => ({ variant: h.variant, sessionId: String(h.sessionId), at: Number(h.at) || 0 }))
    : [];
  const out = {
    origin: { variant: origin.variant, sessionId: String(origin.sessionId) },
    chain,
    tool: TOOL_NAME,
    v: PROVENANCE_VERSION,
  };
  // placed 是落点记账：目录不参与身份判定，只用于分类（规则 4）与按源目录检索
  if (obj.placed && typeof obj.placed === 'object') {
    out.placed = { directory: String(obj.placed.directory ?? ''), scope: obj.placed.scope === 'project' ? 'project' : 'none' };
    if (obj.placed.from) out.placed.from = String(obj.placed.from);
  }
  return out;
}

// 把解析出的 provenance 应用到 IR（reader 用）
export function applyProvenanceToIR(session, provenance) {
  if (!provenance) return session;
  session.origin = provenance.origin;
  session.chain = provenance.chain;
  session.placed = provenance.placed ?? null;
  return session;
}

// ---- 通用槽位助手 ----

// JSON 对象载体（blob / JSON 列 / sidecar 文件）：挂自定义字段
export function embedInJsonObject(obj, provenance) {
  return { ...obj, [TOOL_NAME]: provenance };
}

export function extractFromJsonObject(obj) {
  return provenanceFromObject(obj && obj[TOOL_NAME]);
}

// JSONL 事件行载体：挂自定义字段（宿主解析器忽略未知字段）
export function embedInJsonlLine(lineObj, provenance) {
  return { ...lineObj, [TOOL_NAME]: provenance };
}

export function extractFromJsonlLine(lineObj) {
  return provenanceFromObject(lineObj && lineObj[TOOL_NAME]);
}

// 标题来源标签（仅展示用；权威判定靠 ID + 内嵌 origin）
export function originTag(provenance) {
  return `[${provenance.origin.variant}]`;
}

export function tagTitle(baseTitle, provenance) {
  const tag = originTag(provenance);
  // 归一化走 titles.mjs 的唯一出口：这里只 trim 的话，带换行的标题会拼出一个
  // 「前缀 + 折行」的名字，写进目标宿主后读回来又被折叠 ⇒ 每次导入都判漂移
  const base = normalizeTitle(baseTitle) || 'imported session';
  return base.startsWith(tag) ? base : `${tag} ${base}`;
}

// 链路摘要，如 "codex:abc → pi:def → opencode:xyz"
export function provenanceSummary(provenance) {
  const hops = [
    `${provenance.origin.variant}:${provenance.origin.sessionId}`,
    ...provenance.chain.map((h) => `${h.variant}:${h.sessionId}`),
  ];
  return hops.join(' → ');
}

// ---- sidecar 槽位（对无法安全内嵌的宿主：二进制 db / 严格 schema 的 jsonl）----
//
// 命名：<会话文件>.session-sync.json（不匹配宿主 *.jsonl 扫描规则，不会被误读为会话）
// 目录型会话（DSH）由 writer 传目录下的 provenance.json
export const SIDECAR_SUFFIX = '.session-sync.json';

export function sidecarPathFor(targetFile) {
  return `${targetFile}${SIDECAR_SUFFIX}`;
}

export function writeSidecarProvenance(targetFile, provenance) {
  const file = sidecarPathFor(targetFile);
  // 原子写：sidecar 只写一半时进程被杀，下一次读到的就是坏 JSON —— 读侧退回「没有 origin」，
  // 同一条会话会被当成新会话再导一份（重复副本）。与正文共用同一个原子写出口。
  writeFileAtomic(file, `${JSON.stringify(provenance, null, 2)}\n`);
  return file;
}

export function readSidecarProvenance(targetFile) {
  const file = sidecarPathFor(targetFile);
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return provenanceFromObject(obj);
  } catch {
    return null;
  }
}

