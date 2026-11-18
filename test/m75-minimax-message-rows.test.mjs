// M75 测试：minimax 写入契约（一行 = 一条消息）+ 循环导入导出稳定性
//
// 背景（真机取证）：宿主的 display message 契约是「一行 = 一条消息」，
// 行的 role 就是这条消息自己的角色，同一轮的所有消息共享一个 turn_id。
// 旧实现把整轮压成一行、role 取轮的角色（恒为 user），
// 于是「只留 user 文本」的过滤条件把助手正文整段剔掉 —— 模型回复在宿主里消失。
//
// 这组测试锁三件事：
//   1) 宿主可见字段 = 真相（role / msg_content / thinking_content / tool_calls / msg_type）
//   2) 一个字都不丢（正文/思考/工具调用/工具结果/压缩摘要都在，读得回来）
//   3) 循环导入导出稳定（workbuddy → minimax → workbuddy → minimax 判 skip，绝不 fork）
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
import { sessionCoreFingerprints } from '../src/ir.mjs';

const WB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m75-${name}-`));
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

const rows = (file, sessionId) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id').all(sessionId);
  } finally {
    db.close();
  }
};

const jsonOf = (row) => JSON.parse(row.data_json);

/**
 * 一条 WorkBuddy 会话：用户提问 → 助手思考 → 工具调用 → 工具回执 → 助手回答，
 * 中间再插一条宿主注入的压缩摘要（WorkBuddy 上下文压缩就是这么写的）。
 */
function mkWorkbuddySource(root, { cwd = 'C:/work/wb' } = {}) {
  const dir = path.join(root, '.workbuddy', 'projects', 'proj-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${WB_ID}.jsonl`);
  const lines = [
    { id: 'm1', timestamp: 1790422866491, type: 'message', role: 'user', content: [{ type: 'input_text', text: '重写笔记' }], cwd },
    { id: 'r1', parentId: 'm1', timestamp: 1790422881114, type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '先看目录' }] },
    { id: 'f1', parentId: 'r1', timestamp: 1790422881174, type: 'function_call', callId: 'call_00_a', name: 'Bash', arguments: '{"command":"ls"}' },
    { id: 'fr1', parentId: 'f1', timestamp: 1790422882640, type: 'function_call_result', name: 'Bash', callId: 'call_00_a', status: 'completed', output: { type: 'text', text: 'a.txt' } },
    { id: 'm2', parentId: 'fr1', timestamp: 1790422943324, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成' }] },
    // 宿主注入的压缩摘要：role=user，但内容是 <cb_summary> 包裹的摘要，不是用户提问
    {
      id: 'm3', parentId: 'm2', timestamp: 1790422950000, type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<cb_summary>\nSummary of the conversation so far:\n重写笔记 → 已完成\n</cb_summary>' }],
      providerData: { isCompacted: true, isCompactInternal: true, compactionKind: 'auto' },
    },
    { id: 'm4', parentId: 'm3', timestamp: 1790422960000, type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    { id: 'm5', parentId: 'm4', timestamp: 1790422970000, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
    { type: 'ai-title', id: 't1', timestamp: 1790422875583, aiTitle: '重写英语笔记', sessionId: WB_ID },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

function importWBtoMM(ctx) {
  const plan = planImport(ctx, { from: ['workbuddy-cn'], into: ['minimax'] });
  // executePlan 直接返回结果数组（不是 {results}）
  return executePlan(ctx, plan, { apply: true, lock: false });
}

test('一行 = 一条消息：助手正文进 assistant 行，思考进 thinking_content，工具调用进 tool_calls', () => {
  const root = tmpHome('rows');
  const file = mkMinimaxDbAt(root);
  mkWorkbuddySource(root);
  const ctx = ctxFor(root);
  const results = importWBtoMM(ctx);
  const res = results.find((r) => r.ok);
  assert.ok(res, JSON.stringify(results));

  const rs = rows(file, res.targetId);
  const roles = rs.map((r) => r.role);
  // 3 轮 → 6 条消息：
  //   user(提问) / assistant(思考+调用+回执) / assistant(正文) / user(压缩摘要) / user(继续) / assistant(好的)
  // 一次「模型发言」= 一行：工具那一轮与最后那段正文是两次发言，不能并成一行。
  assert.deepEqual(roles, ['user', 'assistant', 'assistant', 'user', 'user', 'assistant'], JSON.stringify(roles));

  const toolRound = rs[1];
  const td = jsonOf(toolRound);
  assert.equal(td.role, 'assistant');
  assert.equal(td.msg_content, '', '只有工具调用的一轮，正文为空');
  assert.equal(td.thinking_content, '先看目录', '思考必须留在 thinking_content');
  assert.equal(td.msg_type, 2, '带工具调用的助手消息 msg_type=2（AgentToolCall）');
  assert.equal(td.tool_calls.length, 1);
  assert.equal(td.tool_calls[0].tool_name, 'Bash');
  assert.equal(td.tool_calls[0].tool_call_id, 'call_00_a');
  assert.equal(td.tool_calls[0].tool_call_status, 2);
  assert.equal(td.tool_calls[0].tool_call_args, '{"command":"ls"}', '入参必须是宿主口径的 JSON 串');
  assert.match(td.tool_calls[0].tool_call_result_data, /a\.txt/, '工具结果不能丢');

  const answer = rs[2];
  const ad = jsonOf(answer);
  assert.equal(ad.role, 'assistant');
  assert.equal(ad.msg_content, '已完成', '助手正文必须在 msg_content 里，宿主才认得出这是模型回复');
  assert.equal(ad.msg_type, 1, '纯正文 msg_type=1（AgentContent）');

  // 宿主原生行口径：col.msg_id === data.msg_id；col.turn_id === data.turn_id === data.turnId
  for (const r of rs) {
    const d2 = jsonOf(r);
    assert.equal(d2.msg_id, r.msg_id, 'msg_id 不相等时宿主 decodeDisplayMessage 直接抛 corruption');
    assert.equal(d2.turn_id, r.turn_id);
    assert.equal(d2.turnId, r.turn_id);
  }
  // 同一轮的消息共享 turn_id；不同轮不同
  assert.equal(rs[0].turn_id, rs[1].turn_id, 'user 提问与助手回答同属一轮');
  assert.equal(rs[0].turn_id, rs[2].turn_id, '同一条轮次里的多次发言共享 turn_id');
  assert.notEqual(rs[0].turn_id, rs[3].turn_id, '不同轮不能共用 turn_id');
});

test('压缩摘要：标 SystemEvent 不冒充用户提问，正文一个字不丢', () => {
  const root = tmpHome('summary');
  const file = mkMinimaxDbAt(root);
  mkWorkbuddySource(root);
  const ctx = ctxFor(root);
  const results = importWBtoMM(ctx);
  const res = results.find((r) => r.ok);

  const rs = rows(file, res.targetId);
  const sumRow = rs[3];
  const d = jsonOf(sumRow);
  assert.equal(d.msg_type, 3, '压缩摘要必须是 SystemEvent(3)，宿主才不把它显示成用户提问气泡');
  assert.equal(d.role, 'user', '角色不变：摘要是 user 侧注入，读回来仍是同一条消息');
  assert.match(d.msg_content, /^<cb_summary>/, '摘要正文一个字都不能少');
  assert.match(d.msg_content, /<\/cb_summary>$/);

  // 读回来仍在，且原文完整
  const back = readSession('minimax', ctx, res.targetId).session;
  const texts = back.turns.flatMap((t) => t.items.filter((i) => i.kind === 'message').map((i) => i.text));
  assert.ok(texts.some((t) => t.includes('<cb_summary>') && t.includes('已完成')), '摘要必须完整读回');
});

test('压缩后的「请基于摘要继续」提示（无标签）同样标 SystemEvent', () => {
  const root = tmpHome('continue');
  const file = mkMinimaxDbAt(root);
  const dir = path.join(root, '.workbuddy', 'projects', 'proj-1');
  fs.mkdirSync(dir, { recursive: true });
  const nudge = 'Please continue with the conversation based on the summarized context above. Maintain the same level of detail and helpfulness as before the summarization.';
  fs.writeFileSync(path.join(dir, `${WB_ID}.jsonl`), [
    { id: 'm1', timestamp: 1790422866491, type: 'message', role: 'user', content: [{ type: 'input_text', text: '问题' }] },
    { id: 'm2', parentId: 'm1', timestamp: 1790422870000, type: 'message', role: 'user', content: [{ type: 'input_text', text: nudge }], providerData: { isCompactInternal: true } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const ctx = ctxFor(root);
  const res = importWBtoMM(ctx).find((r) => r.ok);
  const rs = rows(file, res.targetId);
  const d = jsonOf(rs[1]);
  assert.equal(d.msg_type, 3, '续写提示也要标 SystemEvent');
  assert.equal(d.msg_content, nudge, '提示语原文保留，不丢');
});

test('往返稳定：workbuddy → minimax 读回的核心指纹逐轮一致（绝不 fork）', () => {
  const root = tmpHome('fp');
  mkMinimaxDbAt(root);
  mkWorkbuddySource(root);
  const ctx = ctxFor(root);

  const src = readSession('workbuddy-cn', ctx, WB_ID).session;
  const srcFp = sessionCoreFingerprints(src);
  assert.ok(srcFp.length >= 3, `源会话至少 3 轮，实际 ${srcFp.length}`);

  const results = importWBtoMM(ctx);
  const res = results.find((r) => r.ok);
  const dst = readSession('minimax', ctx, res.targetId).session;
  assert.deepEqual(sessionCoreFingerprints(dst), srcFp, '往返后每一轮的核心指纹都必须一致（否则下次导入判分叉）');
  assert.equal(dst.turns.length, src.turns.length);
});

test('循环导入导出稳定：workbuddy → minimax → workbuddy → minimax 全程判 skip，绝不 fork', () => {
  const root = tmpHome('cycle');
  mkMinimaxDbAt(root);
  mkWorkbuddySource(root);
  const ctx = ctxFor(root);

  // 1) workbuddy → minimax
  const first = importWBtoMM(ctx).find((r) => r.ok);
  assert.ok(first, '首次导入必须成功');

  // 2) minimax → workbuddy（导回原生变体，目标 ID = 原生会话 ID）
  const back = executePlan(ctx, planImport(ctx, { from: ['minimax'], into: ['workbuddy-cn'] }), { apply: true, lock: false });
  const backRes = back.find((r) => r.targetId === WB_ID) ?? back[0];
  assert.ok(backRes, `导回原生必须成功：${JSON.stringify(back)}`);
  assert.equal(backRes.action, 'skip', `导回原生必须判 identical（skip），实际 ${backRes.action}/${backRes.reason ?? ''}`);
  assert.equal(backRes.reason, 'identical', '往返一圈内容必须完全一致');

  // 3) 再 workbuddy → minimax：内容没变 → 必须是 skip / append，绝不是 fork
  const again = importWBtoMM(ctx).find((r) => r.ok || r.action);
  assert.ok(again, '二次导入必须成功');
  assert.notEqual(again.action, 'fork', `循环导入不得判成分叉，实际 ${again.action}（${again.reason ?? ''}）`);
  assert.equal(again.action, 'skip', `内容未变时必须判 skip，实际 ${again.action}/${again.reason ?? ''}`);
});

test('宿主原生行（source=api）读回时工具名/入参/结果不丢', () => {
  const root = tmpHome('native');
  const file = mkMinimaxDbAt(root);
  mkWorkbuddySource(root);
  const ctx = ctxFor(root);

  // 手写一条宿主原生行（app.asar 真机原生行口径）
  const db = new DatabaseSync(file);
  const sid = 'mvs_native00000000000000000000001';
  const turnId = 'turn-native-1';
  const msgId = 'msg-native-1';
  db.prepare('INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, columnar_version, agent_name, runtime, session_type, status, archived, visibility, session_kind, purpose_kind, workspace_dir, project_workspace_dir, is_default_workspace, title, created_at_ms, extra_data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid, JSON.stringify({ sessionId: sid, agentName: 'mavis', runtime: 'pi-agent', sessionType: 'root', status: 'idle', title: '原生', workspaceDir: 'C:/work/wb' }), 1790422900000, 3, 'mavis', 'pi-agent', 'root', 'idle', 0, 'visible', 'conversation', '', 'C:/work/wb', 'C:/work/wb', 0, '原生', 1790422800000, '{}');
  db.prepare('INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source) VALUES (?,?,?,?,?,?,?)')
    .run(sid, msgId, 'assistant', turnId, 1790422900000, JSON.stringify({
      msg_id: msgId, turn_id: turnId, turnId, timestamp: 1790422900000, role: 'assistant', msg_type: 2,
      msg_content: '跑完了',
      tool_calls: [{ tool_name: 'Bash', tool_call_id: 'call_00_a', tool_call_status: 2, tool_call_args: '{"command":"ls"}', tool_call_result_data: '{"content":[{"type":"text","text":"a.txt"}]}' }],
    }), 'api');
  db.close();

  const s = readSession('minimax', ctx, sid).session;
  const items = s.turns.flatMap((t) => t.items);
  const call = items.find((i) => i.kind === 'tool_call');
  const result = items.find((i) => i.kind === 'tool_result');
  assert.ok(call, '原生行的工具调用必须读出来');
  assert.equal(call.name, 'Bash', '工具名不能丢');
  assert.deepEqual(call.input, { command: 'ls' }, '工具入参不能丢');
  assert.ok(result, '原生行的工具结果必须读出来');
  assert.equal(result.output, 'a.txt');
});
