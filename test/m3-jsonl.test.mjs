// M3 测试：JSONL / 压缩 / 二进制系 reader（fixtures 在临时目录构造，不触碰真实数据）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { claudeReader } from '../src/readers/claude.mjs';
import { piReader } from '../src/readers/pi.mjs';
import { codexReader } from '../src/readers/codex.mjs';
import { createWorkbuddyReader } from '../src/readers/workbuddy.mjs';
import { freebuffReader } from '../src/readers/freebuff.mjs';
import { dshReader, decodeZstdFrames } from '../src/readers/dsh.mjs';
import { antigravityReader, extractJsonBlobs } from '../src/readers/antigravity.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function kinds(turn) {
  return turn.items.map((i) => i.kind);
}

// ---------- Claude Code ----------
test('claude reader：thinking/text/tool_use + tool_result 归入原 turn', () => {
  const root = tmpRoot('claude');
  const id = '11111111-2222-3333-4444-555555555555';
  const file = path.join(root, '.claude', 'projects', 'proj', `${id}.jsonl`);
  writeJsonl(file, [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-01T00:00:00.000Z', sessionId: id },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:01.000Z',
      cwd: 'D:/work/demo',
      sessionId: id,
      message: { role: 'user', content: [{ type: 'text', text: '帮我看下 demo <system-reminder>noise</system-reminder>' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        model: 'claude-x',
        content: [
          { type: 'thinking', thinking: '先读文件' },
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } },
        ],
      },
    },
    // 纯 tool_result 的 user 事件：不能开新 turn
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }] },
    },
    { type: 'ai-title', aiTitle: '演示会话', sessionId: id },
    {
      type: 'user',
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'user', content: '继续' },
    },
  ]);

  const ctx = ctxFor(root);
  const list = claudeReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, '演示会话');

  const s = claudeReader.read(ctx, id);
  assert.equal(s.turns.length, 2, 'tool_result 不应单独成轮');
  assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'message', 'tool_call', 'tool_result']);
  assert.equal(s.turns[0].items[0].text, '帮我看下 demo');
  assert.equal(s.turns[0].items[3].callId, 'call_1');
  assert.equal(s.turns[0].items[4].output, 'file body');
  assert.equal(s.turns[1].items[0].text, '继续');
  assert.equal(s.model, 'claude-x');
  assert.equal(s.cwd, 'D:/work/demo');
});

// ---------- Pi ----------
test('pi reader：session 头 + toolCall + toolResult', () => {
  const root = tmpRoot('pi');
  const id = '019fea3e-4317-7747-98fb-6004a68d6f9b';
  const file = path.join(root, '.pi', 'agent', 'sessions', '--D--work--', `2026-08-10T05-56-16-791Z_${id}.jsonl`);
  writeJsonl(file, [
    { type: 'session', version: 3, id, timestamp: '2026-08-10T05:56:16.791Z', cwd: 'D:/work/2' },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-08-10T05:56:17.527Z', provider: 'p', modelId: 'model-a' },
    {
      type: 'message',
      id: 'e1',
      parentId: 'm1',
      timestamp: '2026-08-10T05:57:44.867Z',
      message: { role: 'user', content: [{ type: 'text', text: '列目录' }], timestamp: 1786341464866 },
    },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-08-10T05:57:46.829Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '执行中' },
          { type: 'toolCall', id: 'call_a', name: 'bash', arguments: { command: 'ls' } },
        ],
        model: 'model-a',
        timestamp: 1786341466829,
      },
    },
    {
      type: 'message',
      id: 'e3',
      parentId: 'e2',
      timestamp: '2026-08-10T05:57:47.012Z',
      message: { role: 'toolResult', toolCallId: 'call_a', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }], isError: false },
    },
  ]);

  const ctx = ctxFor(root);
  const list = piReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].model, 'model-a');

  const s = piReader.read(ctx, id);
  assert.equal(s.turns.length, 1);
  assert.deepEqual(kinds(s.turns[0]), ['message', 'message', 'tool_call', 'tool_result']);
  assert.deepEqual(s.turns[0].items[2].input, { command: 'ls' });
  assert.equal(s.turns[0].items[3].output, 'a.txt');
  assert.equal(s.cwd, 'D:/work/2');
});

// ---------- Codex ----------
test('codex reader：跳过 event_msg 重复投影 + 剔除注入 + 解 reasoning', () => {
  const root = tmpRoot('codex');
  const id = '01a137b8-65de-7e61-a991-4ad993fe317e';
  const file = path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T08-03-14-${id}.jsonl`);
  const reasoningTxt = '先读一下说明';
  const enc = `ocxr1:${Buffer.from(JSON.stringify({ txt: reasoningTxt }), 'utf8').toString('base64')}`;
  writeJsonl(file, [
    { timestamp: '2026-10-14T00:03:14.687Z', type: 'session_meta', payload: { session_id: id, cwd: 'C:/work/codex', timestamp: '2026-10-14T00:03:14.017Z' } },
    { timestamp: '2026-10-14T00:03:14.742Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-x' } } },
    // developer 注入：必须丢弃
    { timestamp: '2026-10-14T00:03:20.843Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
    // AGENTS.md 注入：必须丢弃
    { timestamp: '2026-10-14T00:03:20.900Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>x</INSTRUCTIONS>' }] } },
    { timestamp: '2026-10-14T00:03:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修一下 bug' }] } },
    { timestamp: '2026-10-14T00:03:39.244Z', type: 'response_item', payload: { type: 'reasoning', summary: [], content: null, encrypted_content: enc } },
    { timestamp: '2026-10-14T00:03:39.245Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_9', name: 'exec', input: '{"cmd":"ls"}' } },
    { timestamp: '2026-10-14T00:03:40.159Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_9', output: [{ type: 'input_text', text: 'ok' }] } },
    // event_msg/item_completed 是重复投影，不应产生第二份内容
    { timestamp: '2026-10-14T00:03:40.200Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修一下 bug' }] } } },
    { timestamp: '2026-10-14T00:03:41.000Z', type: 'turn_context', payload: { model: 'gpt-x' } },
  ]);

  const ctx = ctxFor(root);
  const list = codexReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, '修一下 bug');
  assert.equal(list[0].turns, 1);

  const s = codexReader.read(ctx, id);
  assert.equal(s.turns.length, 1, 'event_msg 不应产生额外轮次');
  assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'tool_call', 'tool_result']);
  assert.equal(s.turns[0].items[0].text, '修一下 bug');
  assert.equal(s.turns[0].items[1].text, reasoningTxt, 'reasoning 应可从 encrypted_content 还原');
  assert.deepEqual(s.turns[0].items[2].input, { cmd: 'ls' });
  assert.equal(s.turns[0].items[3].output, 'ok');
  assert.equal(s.model, 'gpt-x');
});

// ---------- WorkBuddy ----------
for (const variant of ['workbuddy-cn', 'workbuddy-intl']) {
  test(`${variant} reader：message/reasoning/function_call 交错 + session-meta 携带 provenance`, () => {
    const root = tmpRoot(variant);
    const home = variant === 'workbuddy-cn' ? path.join(root, '.workbuddy') : path.join(root, '.workbuddy-ai');
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const file = path.join(home, 'projects', 'proj-1', `${id}.jsonl`);
    const prov = { origin: { variant: 'codex', sessionId: 'src-1' }, chain: [{ variant: 'codex', sessionId: 'src-1', at: 1 }], tool: 'session-sync', v: 1 };
    writeJsonl(file, [
      {
        id: 'm1',
        timestamp: 1790422866491,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<system-reminder data-role="user-context">\n<user_info>\nOS: win32\n</user_info>\n</system-reminder>\n重写笔记' }],
        cwd: 'C:/work/wb',
      },
      { id: 'r1', parentId: 'm1', timestamp: 1790422881114, type: 'reasoning', providerData: { model: 'mm' }, content: [], rawContent: [{ type: 'reasoning_text', text: '先看目录' }] },
      { id: 'f1', parentId: 'r1', timestamp: 1790422881174, type: 'function_call', callId: 'call_00_a', name: 'Bash', arguments: '{"command":"ls"}' },
      { id: 'fr1', parentId: 'f1', timestamp: 1790422882640, type: 'function_call_result', name: 'Bash', callId: 'call_00_a', status: 'completed', output: { type: 'text', text: 'a.txt' } },
      { id: 'm2', parentId: 'fr1', timestamp: 1790422943324, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] },
      { type: 'session-meta', id: 'sm1', sessionId: id, timestamp: 1790423000000, meta: { 'codebuddy.ai/hostKind': 'unopted', 'session-sync': prov } },
      { id: 't1', timestamp: 1790422875583, type: 'ai-title', aiTitle: '重写英语笔记', sessionId: id },
      { type: 'file-history-snapshot', id: 'snap', timestamp: 1790422900000, snapshot: {} },
    ]);

    const ctx = ctxFor(root);
    const reader = createWorkbuddyReader({ variant });
    const list = reader.list(ctx, {});
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '重写英语笔记');
    assert.equal(list[0].provenance?.origin.variant, 'codex');

    const s = reader.read(ctx, id);
    assert.equal(s.turns.length, 1);
    assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'tool_call', 'tool_result', 'message']);
    assert.equal(s.turns[0].items[0].text, '重写笔记', 'system-reminder（带属性）必须剥离');
    assert.equal(s.turns[0].items[1].text, '先看目录');
    assert.deepEqual(s.turns[0].items[2].input, { command: 'ls' });
    assert.equal(s.turns[0].items[3].output, 'a.txt');
    assert.equal(s.turns[0].items[4].text, '已完成');
    assert.equal(s.origin?.sessionId, 'src-1');
    assert.equal(s.meta['codebuddy.ai/hostKind'], 'unopted');
  });
}

// ---------- Freebuff ----------
test('freebuff reader：chat-messages blocks + chat-meta 携带 provenance', () => {
  const root = tmpRoot('freebuff');
  const chatDir = path.join(root, '.config', 'manicode', 'projects', 'myproj', 'chats', '2026-08-05T01-30-13.033Z');
  fs.mkdirSync(chatDir, { recursive: true });
  const prov = { origin: { variant: 'pi', sessionId: 'p-1' }, chain: [], tool: 'session-sync', v: 1 };
  fs.writeFileSync(
    path.join(chatDir, 'chat-messages.json'),
    JSON.stringify([
      { id: 'divider-1', variant: 'ai', content: '', blocks: [{ type: 'mode-divider', mode: 'LITE' }], timestamp: '17:23' },
      { id: 'user-1', variant: 'user', content: '看下 airllm', timestamp: '17:23' },
      {
        id: 'ai-1',
        variant: 'ai',
        content: '',
        blocks: [
          { type: 'text', content: '先读仓库', textType: 'reasoning' },
          { type: 'tool', toolCallId: 'T1', toolName: 'read_url', input: { url: 'u' }, output: 'body' },
          { type: 'agent', agentId: 'main-agent' },
          { type: 'text', content: '支持 A100' },
        ],
        timestamp: '17:24',
      },
    ]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(chatDir, 'chat-meta.json'),
    JSON.stringify({ messageCount: 2, firstPrompt: '看下 airllm', messagesMtimeMs: 1787000000000, 'session-sync': prov }),
    'utf8',
  );
  fs.writeFileSync(path.join(chatDir, 'run-state.json'), JSON.stringify({ sessionState: { fileContext: { projectRoot: 'D:/work/fb' } } }), 'utf8');

  const ctx = ctxFor(root);
  const id = '2026-08-05T01-30-13.033Z';
  const list = freebuffReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].cwd, 'D:/work/fb');
  assert.equal(list[0].provenance?.origin.variant, 'pi');
  assert.equal(list[0].createdAt, Date.UTC(2026, 7, 5, 1, 30, 13));

  const s = freebuffReader.read(ctx, id);
  assert.equal(s.turns.length, 1);
  assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'tool_call', 'tool_result', 'message']);
  assert.equal(s.turns[0].items[1].text, '先读仓库');
  assert.equal(s.turns[0].items[3].output, 'body');
  assert.equal(s.turns[0].items[4].text, '支持 A100');
});

// ---------- DSH ----------
test('dsh reader：多帧 zstd 解码 + 丢弃 tool/call 重复投影 + 过滤运行时注入', () => {
  const root = tmpRoot('dsh');
  const id = 'session-11111111-2222-3333-4444-555555555555';
  const sdir = path.join(root, '.dsh', 'sessions', '--D--work--', id);
  fs.mkdirSync(sdir, { recursive: true });

  const events = [
    { type: 'session', version: 4, id, createdAt: 1792143562299, cwd: 'D:/work/dsh', delegationDepth: 0 },
    { type: 'system/message', seq: 1, time: 1792143562300, data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    // 运行时注入：必须丢弃
    { type: 'user/message', seq: 2, time: 1792143562301, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }], role: 'user' } },
    { type: 'user/message', seq: 3, time: 1792143562304, data: { content: [{ type: 'text', text: '看下这个目录' }], role: 'user' } },
    { type: 'session/title', seq: 4, time: 1792143562313, data: { title: '目录检查' } },
    {
      type: 'assistant/message',
      seq: 5,
      time: 1792143564551,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先列目录' },
            { type: 'text', text: '好的' },
            { type: 'tool-call', id: 'call_00_x', name: 'pwsh', arguments: '{"command":"ls"}' },
          ],
          source: { kind: 'model', provider: 'p', model: 'deepseek-flash' },
        },
      },
    },
    // tool/call 是 assistant content 的重复投影
    { type: 'tool/call', seq: 6, time: 1792143564552, data: { callId: 'call_00_x', name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', seq: 7, time: 1792143565141, data: { message: { role: 'tool', toolCallId: 'call_00_x', content: [{ type: 'text', text: 'a.txt' }], isError: false } } },
    { type: 'step/end', seq: 8, time: 1792143565564, data: {} },
  ];

  // 一事件一帧：验证多帧拼接解压
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));

  const decoded = decodeZstdFrames(fs.readFileSync(path.join(sdir, 'session.v4.jsonl.zstd'))).trim().split('\n');
  assert.equal(decoded.length, events.length, '多帧 zstd 必须全部解出');

  const ctx = ctxFor(root);
  const list = dshReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, '目录检查');
  assert.equal(list[0].turns, 1, '运行时注入不计入轮次');

  const s = dshReader.read(ctx, id);
  assert.equal(s.turns.length, 1);
  assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'message', 'tool_call', 'tool_result']);
  assert.equal(s.turns[0].items[0].text, '看下这个目录');
  assert.equal(s.turns[0].items[3].callId, 'call_00_x');
  assert.equal(s.turns[0].items[4].output, 'a.txt');
  assert.equal(s.model, 'deepseek-flash');
});

// ---------- Antigravity ----------
// 构造「protobuf 外壳 + 内嵌 JSON」的字段：tag(0x0a) + len varint + payload
function protoWrap(payloadStr) {
  const body = Buffer.from(payloadStr, 'utf8');
  const lenBytes = [];
  let n = body.length;
  while (n > 0x7f) {
    lenBytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  lenBytes.push(n);
  return Buffer.concat([Buffer.from([0x0a]), Buffer.from(lenBytes), body]);
}

test('antigravity reader：从 protobuf 字节流提取 USER_INPUT/PLANNER_RESPONSE', () => {
  const root = tmpRoot('antigravity');
  const base = path.join(root, '.gemini', 'antigravity-cli');
  const conv = path.join(base, 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  const id = '0fa16453-7b06-4813-88e8-26e4b786114b';
  fs.writeFileSync(
    path.join(base, 'history.jsonl'),
    JSON.stringify({ display: '改英文日志为中文', timestamp: 1782283953204, workspace: 'D:/work/ag', conversationId: id }) + '\n',
    'utf8',
  );

  const db = new DatabaseSync(path.join(conv, `${id}.db`));
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)');
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?,?,?)').run('t1', id, 4, 17);

  const userBlob = protoWrap(
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-06-24T06:52:33Z',
      content: '<USER_REQUEST>\n改英文日志为中文\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
    }),
  );
  const plannerBlob = protoWrap(
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-24T06:52:34Z',
      content: '我来处理这个任务。',
      thinking: '先跑 harness 拿上下文。',
      tool_calls: [{ id: 'toolu_1', name: 'run_command', args: { CommandLine: 'python3 context.py' } }],
    }),
  );
  db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?,?,?)').run(4, 23, userBlob);
  db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?,?,?)').run(6, 21, plannerBlob);
  db.close();

  // 直接单测 blob 提取器
  const blobs = extractJsonBlobs(userBlob);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, 'USER_INPUT');

  const ctx = ctxFor(root);
  const list = antigravityReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].cwd, 'D:/work/ag');
  assert.equal(list[0].turns, 1);

  const s = antigravityReader.read(ctx, id);
  assert.equal(s.turns.length, 1);
  assert.deepEqual(kinds(s.turns[0]), ['message', 'reasoning', 'message', 'tool_call']);
  assert.equal(s.turns[0].items[0].text, '改英文日志为中文');
  assert.equal(s.turns[0].items[1].text, '先跑 harness 拿上下文。');
  assert.equal(s.turns[0].items[2].text, '我来处理这个任务。');
  assert.equal(s.turns[0].items[3].callId, 'toolu_1');
});
