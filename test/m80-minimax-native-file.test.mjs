// M80 测试：minimax **文件型正文**（`v2/sessions/**/messages.jsonl`）的原生形状
//
// 背景（真机取证，见 references/agent-storage.md minimax V5）：同一份正文有两种载体、两套形状。
//   文件型：块是 `text` / `thinking` / `toolCall`，工具回执是**独立一行** `role='toolResult'`
//   列式：  回执并进 assistant 行的 `tool_calls[]`，正文在 `msg_content`
// 读侧曾按本工具自己的 π 词表（`tool_use` / `tool_result`）解文件型行：`toolCall` 全丢、
// `toolResult` 行被当成助手正文 —— 导入后工具回执显示成一串助手消息，工具调用一个不剩。
// 写侧则把 π 块原样写进原生文件，宿主认不出。
//
// 这组测试锁三件事：
//   1) 读：原生行的五种 role 各归各位，回执不许变成 message
//   2) 写：追加进已有 messages.jsonl 的必须是原生形状（toolCall 块 + 独立 toolResult 行）
//   3) 往返：写完再读回，工具调用与回执都还在（下一轮导入不会被判成分叉）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { mkMinimaxDb } from './db-fixtures.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m80-${name}-`));
}

function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}

function mkMinimaxDbAt(root) {
  const file = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  mkMinimaxDb(file);
  return file;
}

const historyDir = (root, rel) => path.join(root, '.minimax', 'v2', 'sessions', rel);

/** 手写一份宿主原生 messages.jsonl（形状照真机行，见 agent-storage V5 正文行契约） */
function writeNativeHistory(root, rel, records) {
  const dir = historyDir(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'messages.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

/** 插一条 minimax 会话索引行，把 history_relative_dir 指到手写文件 */
function insertSession(file, { id, rel, cwd = 'C:\\work\\mm', title = '原生' }) {
  const db = new DatabaseSync(file);
  try {
    db.prepare(
      'INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, columnar_version, agent_name, runtime, session_type, status, archived, visibility, session_kind, purpose_kind, workspace_dir, project_workspace_dir, is_default_workspace, title, created_at_ms, history_relative_dir, extra_data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, JSON.stringify({ sessionId: id, agentName: 'mavis', runtime: 'pi-agent', sessionType: 'root', status: 'idle', title, workspaceDir: cwd }), 1790422900000, 3, 'mavis', 'pi-agent', 'root', 'idle', 0, 'visible', 'conversation', '', cwd, cwd, 0, title, 1790422800000, rel, '{}');
  } finally {
    db.close();
  }
}

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * 一条 WorkBuddy 源会话（一轮 = 提问 / 思考 / 工具调用 / 工具回执 / 回答），
 * 用来驱动 minimax 写侧。用 WorkBuddy 而不是 claude 当源：它的 function_call_result 带工具名，
 * 才能验证「写进原生 toolResult 行的 toolName 不退化成 tool」。
 */
const WB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mkWorkbuddySource(root, turns, cwd = 'C:/work/mm') {
  const dir = path.join(root, '.workbuddy', 'projects', 'proj-1');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  turns.forEach((t, i) => {
    const ts = 1791484221000 + i * 20000;
    lines.push({ id: `u${i}`, timestamp: ts, type: 'message', role: 'user', content: [{ type: 'input_text', text: t.q }], cwd });
    lines.push({ id: `r${i}`, parentId: `u${i}`, timestamp: ts + 1000, type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: t.thinking }] });
    lines.push({ id: `f${i}`, parentId: `r${i}`, timestamp: ts + 2000, type: 'function_call', callId: t.tool.id, name: t.tool.name, arguments: JSON.stringify(t.tool.input) });
    lines.push({ id: `fr${i}`, parentId: `f${i}`, timestamp: ts + 3000, type: 'function_call_result', name: t.tool.name, callId: t.tool.id, status: 'completed', output: { type: 'text', text: t.tool.output } });
    lines.push({ id: `a${i}`, parentId: `fr${i}`, timestamp: ts + 4000, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.a }] });
  });
  fs.writeFileSync(path.join(dir, `${WB_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const importWbToMinimax = (ctx) => executePlan(ctx, planImport(ctx, { from: ['workbuddy-cn'], into: ['minimax'] }), { apply: true, lock: false });

test('读原生文件：五种 role 各归各位，工具回执不许变成助手正文', () => {
  const root = tmpHome('read');
  const file = mkMinimaxDbAt(root);
  const rel = '2026/11/06/08-13-39-244-session_x';
  const callId = 'call_00_a';
  writeNativeHistory(root, rel, [
    { message_id: 'msg-u', turn_id: 'turn-1', message: { role: 'user', content: [{ type: 'text', text: '查日志' }], timestamp: 1790422866491 } },
    { message_id: 'msg-a1', turn_id: 'turn-1', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先读文件' },
      { type: 'text', text: '开始读' },
      { type: 'toolCall', id: callId, name: 'read', arguments: { path: 'a.log', limit: 120 } },
    ], timestamp: 1790422881114 } },
    { message_id: 'msg-r1', turn_id: 'turn-1', message: {
      role: 'toolResult', toolCallId: callId, toolName: 'read',
      content: [{ type: 'text', text: 'line1\nline2' }], isError: false, timestamp: 1790422882640,
    } },
    // 宿主内部注入：display:false = 宿主自己都不显示
    { message_id: 'msg-c1', turn_id: 'turn-1', message: { role: 'custom', customType: 'session_identity_reminder', content: '<system-reminder>YOUR SESSION ID: mvs_x</system-reminder>', display: false, timestamp: 1790422883000 } },
    // 压缩摘要：无 content 块
    { message_id: 'msg-cs', turn_id: 'turn-1:compaction', message: { role: 'compactionSummary', summary: '## Goal\n读日志' } },
    { message_id: 'msg-a2', turn_id: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: '日志读完' }], timestamp: 1790422943324 } },
  ]);
  insertSession(file, { id: 'mvs_read0001', rel });

  const s = readSession('minimax', ctxFor(root), 'mvs_read0001').session;
  assert.equal(s.turns.length, 1, '同一 turn_id 下的回执行不得开新轮');
  const items = s.turns.flatMap((t) => t.items);

  const assistantTexts = items.filter((i) => i.kind === 'message' && i.role === 'assistant').map((i) => i.text);
  assert.deepEqual(assistantTexts, ['开始读', '日志读完'], `回执不许混进助手正文，实际 ${JSON.stringify(assistantTexts)}`);
  assert.ok(!assistantTexts.some((t) => t.includes('line1')), '工具输出的原文不能出现在任何助手消息里');

  const calls = items.filter((i) => i.kind === 'tool_call');
  assert.equal(calls.length, 1, 'toolCall 块必须读成工具调用（π 词表只认 tool_use 会全丢）');
  assert.equal(calls[0].name, 'read');
  assert.deepEqual(calls[0].input, { path: 'a.log', limit: 120 }, '原生 arguments 是对象，要原样成 input');

  const results = items.filter((i) => i.kind === 'tool_result');
  assert.equal(results.length, 1, 'toolResult 行必须读成工具回执');
  assert.equal(results[0].callId, callId);
  assert.equal(results[0].name, 'read');
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].output, 'line1\nline2');

  assert.equal(items.filter((i) => i.kind === 'reasoning').length, 1, 'thinking 块要读成 reasoning');
  assert.ok(!items.some((i) => String(i.text ?? '').includes('YOUR SESSION ID')), 'display:false 的注入不搬');
  assert.ok(!items.some((i) => String(i.text ?? '').includes('## Goal')), '压缩摘要不搬');
});

test('append 进原生文件时按文件型形状写：toolCall 块 + 独立 toolResult 行', () => {
  const root = tmpHome('write');
  const file = mkMinimaxDbAt(root);
  const ctx = ctxFor(root);

  // 1) 先经 DB 行路径建出会话（此时没有 messages.jsonl）
  mkWorkbuddySource(root, [{ q: '第一轮提问', thinking: '先读文件', tool: { id: 'call_1', name: 'Bash', input: { command: 'ls' }, output: 'a.txt' }, a: '第一轮答' }]);
  const first = importWbToMinimax(ctx).find((r) => r.ok);
  assert.ok(first, '首次导入必须成功');
  const id = first.targetId;

  // 2) 模拟宿主把第一轮物化成**原生形状**的文件（真机行口径），并把列指过去
  const rel = '2026/11/06/09-00-00-000-session_y';
  const histFile = writeNativeHistory(root, rel, [
    { message_id: 'msg-u1', turn_id: 'turn-1', message: { role: 'user', content: [{ type: 'text', text: '第一轮提问' }] } },
    { message_id: 'msg-a1', turn_id: 'turn-1', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '先读文件' },
      { type: 'toolCall', id: 'call_1', name: 'Bash', arguments: { command: 'ls' } },
    ] } },
    { message_id: 'msg-r1', turn_id: 'turn-1', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'Bash', content: [{ type: 'text', text: 'a.txt' }], isError: false } },
    { message_id: 'msg-a2', turn_id: 'turn-1', message: { role: 'assistant', content: [{ type: 'text', text: '第一轮答' }] } },
  ]);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET history_relative_dir = ? WHERE session_id = ?').run(rel, id);
  db.close();
  assert.equal(readSession('minimax', ctx, id).session.turns.length, 1, '文件型正文读回必须是 1 轮');

  // 3) 源长出第二轮（带工具调用）→ append 写进同一文件
  mkWorkbuddySource(root, [
    { q: '第一轮提问', thinking: '先读文件', tool: { id: 'call_1', name: 'Bash', input: { command: 'ls' }, output: 'a.txt' }, a: '第一轮答' },
    { q: '第二轮提问', thinking: '再看目录', tool: { id: 'call_2', name: 'Read', input: { path: 'b.txt' }, output: 'b 的内容' }, a: '第二轮答' },
  ]);
  const grown = importWbToMinimax(ctx).find((r) => r.targetId === id);
  assert.ok(grown, '第二轮导入必须产出结果');
  assert.equal(grown.action, 'append', `源长一轮后必须是 append，实际 ${grown.action}/${grown.reason ?? ''}`);

  const recs = readJsonl(histFile);
  const roles = recs.map((r) => r.message.role);
  assert.ok(roles.includes('toolResult'), `回执必须是独立行，实际 roles=${JSON.stringify(roles)}`);
  assert.equal(roles.filter((r) => r === 'toolResult').length, 2, '两轮各一条回执行');

  // 块类型必须是原生 toolCall；π 词表（tool_use / tool_result）一个都不许出现
  const blockTypes = recs.flatMap((r) => (Array.isArray(r.message.content) ? r.message.content.map((b) => b.type) : []));
  assert.ok(blockTypes.includes('toolCall'), `方块里必须有 toolCall，实际 ${JSON.stringify(blockTypes)}`);
  assert.ok(!blockTypes.includes('tool_use'), 'π 块 tool_use 不能被写进原生文件');
  assert.ok(!blockTypes.includes('tool_result'), 'π 块 tool_result 不能被写进原生文件');

  const call2 = recs.flatMap((r) => r.message.content ?? []).find((b) => b.type === 'toolCall' && b.id === 'call_2');
  assert.ok(call2, '第二轮的调用要写成 toolCall 块');
  assert.equal(call2.name, 'Read');
  assert.deepEqual(call2.arguments, { path: 'b.txt' }, '入参原样落 arguments');

  const res2 = recs.map((r) => r.message).find((m) => m.role === 'toolResult' && m.toolCallId === 'call_2');
  assert.ok(res2, '第二轮回执要有独立行');
  assert.equal(res2.toolName, 'Read', '回执行的 toolName 不能退化成 tool');
  assert.equal(res2.isError, false);
  assert.equal(res2.content[0].text, 'b 的内容', '回执输出一个字都不能少');

  // 4) 往返：读回工具调用与回执都还在 → 下一轮导入不会被判成分叉
  const back = readSession('minimax', ctx, id).session;
  assert.equal(back.turns.length, 2);
  const backItems = back.turns.flatMap((t) => t.items);
  const backCalls = backItems.filter((i) => i.kind === 'tool_call');
  const backResults = backItems.filter((i) => i.kind === 'tool_result');
  assert.deepEqual(backCalls.map((c) => c.name), ['Bash', 'Read']);
  assert.deepEqual(backResults.map((r) => r.output), ['a.txt', 'b 的内容']);
  assert.ok(!backItems.some((i) => i.kind === 'message' && String(i.text).includes('a.txt')), '回执不许回流成助手正文');

  const again = importWbToMinimax(ctx).find((r) => r.targetId === id);
  assert.ok(again, '第三次导入必须产出结果');
  assert.equal(again.action, 'skip', `内容未变必须判 skip，实际 ${again.action}/${again.reason ?? ''}`);
});
