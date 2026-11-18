// pi-agent-blocks.mjs — pi-agent 系宿主（pi / minimax）正文块：原生形状 ↔ 本工具 π 块（唯一实现）
//
// 两家共用同一套正文词汇（runtime 都是 pi-agent）：块是 `text` / `thinking` / `toolCall`，
// 工具回执**独立成行**（`role='toolResult'` + `toolCallId/toolName/content[]/isError`）。
// 差别只在载体：pi 是「索引 + 会话 jsonl」；minimax 有两套 ——
//   文件型 `v2/sessions/**/messages.jsonl`：形状同上；
//   列式 `local_runtime_message_rows`：回执并进 assistant 行的 `tool_calls[]`、正文在 `msg_content`
// 本工具自己的块词汇是 Anthropic 风格（IR 与 DB 行 `data_json['session-sync-content']`）：
//   `tool_use{id,name,input}` / `tool_result{tool_use_id,content,is_error}` / `image{path}`
//
// 为什么两个方向必须同处：读侧曾按 π 词表去解 minimax 原生文件（role 二态、只认 tool_use/tool_result）——
// `toolCall` 全丢、`toolResult` 行被当成助手正文，导入后工具回执显示成一串助手消息；
// 写侧又把 π 块原样写回原生文件，宿主认不出 `tool_use`。两边各猜一份字段名 = 同一问题两份实现。
import { toolResultItem } from './ir.mjs';
import { parseArgs } from './readers/base.mjs';
import { outputText } from './text.mjs';

// π 块名（本工具自己的词汇，原样直通）
const PI_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'image']);
// 原生块名 → π 块名（toolResult 既是行级角色也是一种块写法，两边都认）
const NATIVE_TO_PI = { text: 'text', thinking: 'thinking', toolCall: 'tool_use', toolResult: 'tool_result', image: 'image' };

const piTypeOf = (raw) => (PI_TYPES.has(raw) ? raw : NATIVE_TO_PI[raw] ?? '');

/** 原生块（或已经是 π 块）→ π 块。认不出的类型返回 null —— 不猜，也不塞进正文 */
export function toPiBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const type = piTypeOf(String(b.type ?? ''));
  switch (type) {
    case 'text':
      return { type: 'text', text: String(b.text ?? '') };
    case 'thinking':
      // 原生是 {thinking}；Anthropic 风格偶见 {text}，同一件事的两种写法都认
      return { type: 'thinking', thinking: String(b.thinking ?? b.text ?? '') };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: b.id ?? b.toolCallId ?? null,
        name: b.name ?? b.toolName ?? 'tool',
        // 原生 arguments 是对象；有的 provider 存 JSON 串 —— 归一成对象，与 IR 的 input 同形
        input: b.input ?? parseArgs(b.arguments) ?? null,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id ?? b.toolCallId ?? null,
        name: b.name ?? b.toolName ?? null,
        content: b.content ?? '',
        is_error: !!(b.is_error ?? b.isError),
      };
    case 'image':
      return { type: 'image', path: b.path ?? b.source?.url ?? '' };
    default:
      return null;
  }
}

/** π 块 → 原生块（文件型 messages.jsonl 用）。tool_result 走 toolResultRowOfBlock，不是这里 */
export function toNativeBlock(b) {
  const pi = toPiBlock(b);
  if (!pi) return null;
  switch (pi.type) {
    case 'text':
      return { type: 'text', text: pi.text };
    case 'thinking':
      return { type: 'thinking', thinking: pi.thinking };
    case 'tool_use':
      return { type: 'toolCall', id: pi.id, name: pi.name, arguments: pi.input ?? null };
    case 'image':
      return { type: 'image', path: pi.path };
    default:
      return null;
  }
}

/** 原生回执行（role='toolResult'）→ IR 的 tool_result 条目 */
export function toolResultItemOfRow(msg, ts) {
  const pi = toPiBlock({ type: 'toolResult', ...msg });
  return toolResultItem(pi.tool_use_id, pi.name ?? 'tool', pi.is_error ? 'error' : 'ok', outputText(pi.content) ?? '', ts);
}

/** π 的回执块（tool_result）→ 原生回执行的一行 message，字段名与宿主真机行一致 */
export function toolResultRowOfBlock(b) {
  const pi = toPiBlock(b);
  return {
    role: 'toolResult',
    toolCallId: pi.tool_use_id ?? null,
    toolName: pi.name ?? 'tool',
    content: [{ type: 'text', text: outputText(pi.content) ?? '' }],
    isError: !!pi.is_error,
  };
}
