// ir.mjs — 中间表示（IR）：Session → Turn → Item
//
// 设计要点：
// - Item 七型：message / reasoning / tool_call / tool_result / attachment(引用) / meta / note(降级)
// - turn 边界：user 消息开新 turn；tool_result 归入其 call 所在 turn（由 reader 组装时保证）
// - 指纹只认"内容"，不认时间戳/model/id：规范化后 sha256
import { sha256hex, stableStringify } from './util.mjs';
import { previewTitle } from './titles.mjs';

export const ItemKind = {
  Message: 'message',
  Reasoning: 'reasoning',
  ToolCall: 'tool_call',
  ToolResult: 'tool_result',
  Attachment: 'attachment',
  Meta: 'meta',
  Note: 'note',
};

export function makeSession({
  id,
  variant,
  title = '',
  cwd = '',
  createdAt = 0,
  updatedAt = 0,
  model = null,
  origin = null,
  scope = null,
  account = null,
  placed = null,
  chain = [],
  turns = [],
  meta = {},
} = {}) {
  if (!id) throw new Error('makeSession: id 必填');
  if (!variant) throw new Error('makeSession: variant 必填');
  return {
    id: String(id),
    variant,
    title: title || '',
    cwd: cwd || '',
    createdAt,
    updatedAt: updatedAt || createdAt,
    model,
    origin, // {variant, sessionId} | null（null = 原生会话）
    scope, // 'project' | 'none' | null（null = reader 没给信号，由 placement 按目录猜）
    account, // {variant, id, name?, orgId?} | null —— 只作展示与写侧归属，读侧绝不按它过滤
    placed, // {directory, scope} | null = 上次迁移落点（provenance.placed 透出）
    chain, // [{variant, sessionId, at}]
    turns,
    meta,
  };
}

export function makeTurn(role, items = [], startedAt = 0) {
  return { index: 0, role, items, startedAt };
}

// ---- Item 构造 ----
export const messageItem = (role, text, ts = 0) => ({ kind: ItemKind.Message, role, text: String(text ?? ''), ts });
export const reasoningItem = (text, ts = 0) => ({ kind: ItemKind.Reasoning, text: String(text ?? ''), ts });
export const toolCallItem = (callId, name, input, ts = 0) => ({ kind: ItemKind.ToolCall, callId: callId ?? null, name: name ?? '', input: input ?? null, ts });
export const toolResultItem = (callId, name, status, output, ts = 0) => ({ kind: ItemKind.ToolResult, callId: callId ?? null, name: name ?? '', status: status ?? 'ok', output: output ?? null, ts });
export const attachmentItem = (ref, note = '', ts = 0) => ({ kind: ItemKind.Attachment, ref: ref ?? '', note: note ?? '', ts });
export const metaItem = (key, value, ts = 0) => ({ kind: ItemKind.Meta, key: key ?? '', value: value ?? null, ts });
export const noteItem = (text, ts = 0) => ({ kind: ItemKind.Note, text: String(text ?? ''), ts });

// ---- 规范化（指纹用）：去 ts/id，统一字段 ----
export function normalizeItem(item) {
  switch (item?.kind) {
    case ItemKind.Message:
      return { kind: 'message', role: item.role ?? '', text: item.text ?? '' };
    case ItemKind.Reasoning:
      return { kind: 'reasoning', text: item.text ?? '' };
    case ItemKind.ToolCall:
      return { kind: 'tool_call', name: item.name ?? '', input: item.input ?? null };
    case ItemKind.ToolResult:
      return { kind: 'tool_result', name: item.name ?? '', status: item.status ?? 'ok', output: item.output ?? null };
    case ItemKind.Attachment:
      return { kind: 'attachment', ref: item.ref ?? '' };
    case ItemKind.Meta:
      return { kind: 'meta', key: item.key ?? '', value: item.value ?? null };
    case ItemKind.Note:
      return { kind: 'note', text: item.text ?? '' };
    default:
      return { kind: 'note', text: String(item?.text ?? '') };
  }
}

export function turnFingerprint(turn) {
  return sha256hex(stableStringify({ role: turn.role ?? '', items: (turn.items ?? []).map(normalizeItem) }));
}

export function sessionFingerprints(session) {
  return (session.turns ?? []).map(turnFingerprint);
}

// ---- 核心指纹（跨格式收敛判定用）----
//
// 为什么需要它：同一会话经不同宿主时，reasoning（模型内部）常被丢弃、
// tool_result 输出常被截断或改写、attachment 表示各异。用全量指纹比对会把
// 「同一会话」判成分叉，从而反复 fork。核心指纹只取会话的语义骨架：
//   - 消息文本（角色 + 规范化文本）
//   - 工具调用（工具名 + 规范化入参）
// 这些是各宿主都保留、且用户可见的部分。

export function normalizeText(t) {
  return String(t ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 工具入参的规范化：opencode 的 state.input 必须是对象，所以写侧把裸值包成 `{value: X}`。
 * 同一个调用在两侧就长成「字符串」与「{value: 字符串}」两种样子 —— 核心指纹若直接比入参，
 * 复跑就会判成内容分叉（fork），而不是收敛。解开这层包装后两边才是同一个骨架。
 */
export function canonicalInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const keys = Object.keys(input);
    if (keys.length === 1 && keys[0] === 'value') return input.value;
  }
  return input ?? null;
}

export function coreItem(item) {
  switch (item?.kind) {
    case ItemKind.Message: {
      const t = normalizeText(item.text);
      // 装得下附件的宿主存成附件，装不下的（claude/codex/dsh/freebuff/workbuddy 五家写入侧）
      // 存成 `[attachment] <路径>` 这一行占位文本。同一会话在两侧会算出不同的消息项，
      // 所以这种纯占位行不进核心；正文里普通提到该串的不受影响（要求整行仅此占位）。
      if (/^\[attachment\] \S[^\n]*$/.test(t)) return null;
      return { k: 'm', r: item.role === 'user' ? 'u' : 'a', t };
    }
    case ItemKind.ToolCall:
      return { k: 'c', n: String(item.name ?? ''), i: canonicalInput(item.input) };
    default:
      return null; // reasoning / tool_result / attachment / meta / note 不进核心
  }
}

export function turnCore(turn) {
  const items = [];
  for (const it of turn.items ?? []) {
    const c = coreItem(it);
    if (!c) continue;
    const prev = items[items.length - 1];
    // 同角色相邻消息并成一条：各家把「一轮里的多段用户文本」存成 N 个块还是 1 段拼接文本并不一致
    // （opencode 的 user 消息只有一个 text 字段、Cline 一条消息带多个块），不归一就会把同一会话
    // 的两种表示判成分叉，从而反复 fork。工具调用不参与合并（顺序与入参本身就是骨架）。
    if (c.k === 'm' && prev && prev.k === 'm' && prev.r === c.r) {
      prev.t = normalizeText(`${prev.t}\n\n${c.t}`);
      continue;
    }
    items.push(c);
  }
  return { role: turn.role === 'user' ? 'u' : 'a', items };
}

export function turnCoreFingerprint(turn) {
  return sha256hex(stableStringify(turnCore(turn)));
}

export function sessionCoreFingerprints(session) {
  return (session.turns ?? []).map(turnCoreFingerprint);
}

/**
 * 附件属于本轮的用户消息，不得排在那轮第一条 user 消息之前。
 * 把附件降级成 assistant 侧占位文本的宿主会因此先发一条 assistant 消息，读侧 assembleTurns
 * 凭空多开一轮、核心指纹整体平移；核心指纹不含附件，挪顺序不改变会话身份。
 */
export function normalizeTurnItems(turn) {
  const items = turn?.items ?? [];
  const firstUser = items.findIndex((it) => it?.kind === ItemKind.Message && it.role === 'user');
  if (firstUser <= 0) return turn;
  const leading = items.slice(0, firstUser).filter((it) => it?.kind === ItemKind.Attachment);
  if (!leading.length) return turn;
  const kept = items.filter((it, i) => !(i < firstUser && it?.kind === ItemKind.Attachment));
  const at = kept.findIndex((it) => it?.kind === ItemKind.Message && it.role === 'user') + 1;
  kept.splice(at, 0, ...leading);
  return { ...turn, items: kept };
}

// 收尾：重排 turn.index、回填 updatedAt
export function finalizeSession(session) {
  let updatedAt = session.createdAt || 0;
  session.turns.forEach((t, i) => {
    t.index = i;
    for (const item of t.items) {
      if (typeof item.ts === 'number' && item.ts > updatedAt) updatedAt = item.ts;
    }
  });
  session.updatedAt = updatedAt || session.updatedAt || 0;
  return session;
}

// turn 序列 → 扁平文本预览（list/UI 用）
export function previewText(session, maxChars = 120) {
  const first = session.turns.find((t) => t.role === 'user');
  const item = first?.items?.find((i) => i.kind === ItemKind.Message);
  const text = item?.text ?? session.title ?? '';
  // 预览 = 我们构造的显示值，允许截断；落点标题不截断（容量只在写侧校验）。规则都在 titles.mjs
  return previewTitle(text, maxChars);
}
