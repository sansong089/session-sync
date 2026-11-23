// M77：Antigravity  Hub/CLI/IDE 读支持 + Hub 写支持（fixtures 全在临时目录）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem } from '../src/ir.mjs';
import { antigravityReader } from '../src/readers/antigravity.mjs';
import { antigravityWriter } from '../src/writers/antigravity.mjs';
import {
  encodeStep, decodeStepRow, encodeWorkspaceBlob, decodeWorkspaceBlob, workspaceUriOf,
  STEP_USER, STEP_ASSISTANT, STEP_TOOL,
} from '../src/readers/antigravity-proto.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function seedHub(root) {
  const hub = path.join(root, '.gemini', 'antigravity');
  const conv = path.join(hub, 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  const sum = path.join(hub, 'conversation_summaries.db');
  const db = new DatabaseSync(sum);
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT "", preview TEXT NOT NULL DEFAULT "",
    step_count INTEGER NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT "", source TEXT NOT NULL DEFAULT "", project_id TEXT NOT NULL DEFAULT "",
    agent_name TEXT NOT NULL DEFAULT "", parent_conversation_id TEXT NOT NULL DEFAULT "", nesting_depth INTEGER NOT NULL DEFAULT 0,
    battle_id TEXT NOT NULL DEFAULT "", winning_conversation_id TEXT NOT NULL DEFAULT "", not_fully_idle numeric NOT NULL DEFAULT false,
    killed numeric NOT NULL DEFAULT false, last_user_input_time datetime NOT NULL, last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
    app_data_dir TEXT NOT NULL DEFAULT "", raw_summary blob, group_id TEXT NOT NULL DEFAULT "")`);
  db.exec(`CREATE VIRTUAL TABLE conversations_fts USING fts5(
    conversation_id UNINDEXED, chunk_index UNINDEXED, chunk_first_step UNINDEXED, chunk_last_step UNINDEXED,
    last_modified_time UNINDEXED, step_count UNINDEXED, last_step_created_at UNINDEXED, archived UNINDEXED,
    user_step_byte_offsets UNINDEXED, agent_step_byte_offsets UNINDEXED,
    title, workspace, project, user_body, agent_body, tokenize = 'unicode61 remove_diacritics 2')`);
  db.close();
  return { hub, conv, sum };
}
function makeNativeDb(file, id, steps, { uris = ['file:///d%3A/00-lk-agent'] } = {}) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory numeric, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER)');
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)');
  db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT 'main', data BLOB, PRIMARY KEY(id))");
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?,?,?)').run('traj-1', id, 4, 1);
  db.prepare('INSERT INTO trajectory_metadata_blob (id,data) VALUES (?,?)').run('main', encodeWorkspaceBlob({ uris, cascadeId: id }));
  steps.forEach((st, idx) => {
    const enc = encodeStep({ ...st, trajectoryId: 'traj-1', cascadeId: id, userId: 'u1', ts: 1795161319587 + idx * 1000 });
    db.prepare('INSERT INTO steps (idx,step_type,status,metadata,step_payload,step_format) VALUES (?,?,?,?,?,?)')
      .run(idx, st.type, 3, enc.metadata, enc.step_payload, 0);
  });
  db.close();
}
function addSummary(sum, id, extra = {}) {
  const db = new DatabaseSync(sum);
  db.prepare(`INSERT OR REPLACE INTO conversation_summaries
    (conversation_id,title,preview,step_count,last_modified_time,workspace_uris,status,project_id,app_data_dir,last_user_input_time)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, extra.title ?? 'Host Title', extra.preview ?? '', extra.step_count ?? 1,
    '2026-11-20 07:55:19.5878871+00:00', extra.workspace_uris ?? '["file:///d%3A/00-lk-agent"]', 'CASCADE_RUN_STATUS_IDLE', 'p1', 'antigravity',
    '2026-11-20 07:55:19.5878871+00:00');
  db.close();
}

test('antigravity-proto：step 编解码往返', () => {
  const enc = encodeStep({
    type: STEP_ASSISTANT,
    ts: 1795161319587,
    trajectoryId: 't1',
    cascadeId: 'c1',
    userId: 'u1',
    content: '你好',
    thinking: '思考',
    toolCalls: [{ id: 'call_1', name: 'read_file', input: { Path: 'a.txt' } }],
  });
  const row = { idx: 0, step_type: 15, metadata: enc.metadata, step_payload: enc.step_payload };
  const d = decodeStepRow(row);
  assert.equal(d.type, STEP_ASSISTANT);
  assert.equal(d.role, 'assistant');
  assert.equal(d.content, '你好');
  assert.equal(d.thinking, '思考');
  assert.equal(d.toolCalls.length, 1);
  assert.equal(d.toolCalls[0].name, 'read_file');
  assert.deepEqual(d.toolCalls[0].input, { Path: 'a.txt' });
  assert.ok(d.ts > 0);
  const uri = workspaceUriOf('D:\\00-lk-agent');
  assert.equal(uri, 'file:///d%3A/00-lk-agent');
  assert.deepEqual(decodeWorkspaceBlob(encodeWorkspaceBlob({ uris: [uri], cascadeId: 'c1' })).includes(uri), true);
});

test('antigravity reader：从 Hub 库 native protobuf 读出正文 + 工具调用', () => {
  const root = tmpRoot('ag-read-native');
  const { conv, sum } = seedHub(root);
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  makeNativeDb(path.join(conv, `${id}.db`), id, [
    { type: STEP_USER, content: '检查这段日志' },
    { type: STEP_ASSISTANT, thinking: '先看文件', content: '我来处理', toolCalls: [{ id: 'c1', name: 'read_file', input: { Path: 'a.java' } }] },
    { type: STEP_TOOL, toolCall: { id: 'c1', name: 'read_file', input: null }, toolOutput: 'log.info("x")' },
  ]);
  addSummary(sum, id, { title: '日志检查', step_count: 3 });
  const ctx = ctxFor(root);
  const list = antigravityReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].title, '日志检查');
  assert.equal(list[0].turns, 1);
  assert.equal(list[0].readQuality, 'protobuf');
  assert.match(list[0].cwd, /00-lk-agent/);
  const s = antigravityReader.read(ctx, id);
  assert.equal(s.turns.length, 1);
  assert.deepEqual(s.turns[0].items.map((i) => i.kind), ['message', 'reasoning', 'message', 'tool_call', 'tool_result']);
  assert.equal(s.turns[0].items[0].text, '检查这段日志');
  assert.equal(s.turns[0].items[3].name, 'read_file');
});

test('antigravity reader：同 ID 多根时 Hub 优先；加密 .pb 被跳过', () => {
  const root = tmpRoot('ag-read-dedupe');
  const { conv, sum } = seedHub(root);
  const id = '12345678-1234-4234-8234-123456789abc';
  makeNativeDb(path.join(conv, `${id}.db`), id, [{ type: STEP_USER, content: '来自 Hub' }]);
  addSummary(sum, id, { title: 'Hub 版本' });
  const cli = path.join(root, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(cli, { recursive: true });
  makeNativeDb(path.join(cli, `${id}.db`), id, [{ type: STEP_USER, content: '来自 CLI' }]);
  const ide = path.join(root, '.gemini', 'antigravity-ide', 'conversations');
  fs.mkdirSync(ide, { recursive: true });
  fs.writeFileSync(path.join(ide, '99999999-9999-4999-8999-999999999999.pb'), Buffer.from([1, 2, 3]));
  const ctx = ctxFor(root);
  const list = antigravityReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Hub 版本');
  const s = antigravityReader.read(ctx, id);
  assert.equal(s.turns[0].items[0].text, '来自 Hub');
});

function sourceSession(id) {
  const t0 = Date.parse('2026-11-20T01:00:00Z');
  return makeSession({
    id,
    variant: 'claude',
    title: '导入的会话',
    cwd: 'D:\\00-lk-agent',
    createdAt: t0,
    updatedAt: t0 + 60000,
    turns: [
      { index: 0, role: 'user', startedAt: t0, items: [messageItem('user', '改成中文日志', t0)] },
      {
        index: 1,
        role: 'assistant',
        startedAt: t0 + 1000,
        items: [
          reasoningItem('先看文件', t0 + 1000),
          toolCallItem('call_1', 'read_file', { Path: 'a.java' }, t0 + 1000),
          toolResultItem('call_1', 'read_file', 'ok', 'file content', t0 + 2000),
          messageItem('assistant', '已改好', t0 + 3000),
        ],
      },
      { index: 2, role: 'user', startedAt: t0 + 10000, items: [messageItem('user', '再确认', t0 + 10000)] },
      { index: 3, role: 'assistant', startedAt: t0 + 11000, items: [messageItem('assistant', '确认无误', t0 + 11000)] },
    ],
  });
}

test('antigravity writer：create → 正文库 + 侧栏摘要库双写，读回等价', () => {
  const root = tmpRoot('ag-write');
  seedHub(root);
  const ctx = ctxFor(root);
  const id = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(antigravityWriter.canWrite(ctx), { ok: true });
  const r = antigravityWriter.write(ctx, {
    session: sourceSession(id),
    targetId: id,
    mode: 'create',
    provenance: { origin: { variant: 'claude', sessionId: 'src' } },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lines, 6);
  assert.equal(r.path, path.join(root, '.gemini', 'antigravity', 'conversations', `${id}.db`));

  const db = new DatabaseSync(r.path, { readOnly: true });
  const steps = db.prepare('select idx, step_type from steps order by idx').all();
  db.close();
  assert.deepEqual(steps.map((s) => s.step_type), [STEP_USER, STEP_ASSISTANT, STEP_TOOL, STEP_ASSISTANT, STEP_USER, STEP_ASSISTANT]);

  const sum = new DatabaseSync(path.join(root, '.gemini', 'antigravity', 'conversation_summaries.db'), { readOnly: true });
  const row = sum.prepare('select title, preview, step_count, status, workspace_uris, app_data_dir from conversation_summaries where conversation_id=?').get(id);
  sum.close();
  assert.equal(row.title, '导入的会话');
  assert.equal(row.preview, '改成中文日志');
  assert.equal(row.step_count, 6);
  assert.equal(row.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(row.app_data_dir, 'antigravity');
  assert.match(row.workspace_uris, /d%3A\/00-lk-agent/);

  const list = antigravityReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  const back = antigravityReader.read(ctx, id);
  assert.equal(back.title, '导入的会话');
  assert.equal(back.turns.length, 2);
  assert.deepEqual(back.turns[0].items.map((i) => i.kind), ['message', 'reasoning', 'tool_call', 'tool_result', 'message']);
  assert.equal(back.turns[0].items[0].text, '改成中文日志');
  assert.equal(back.cwd, 'D:\\00-lk-agent');
});

test('antigravity writer：同工作区复用已有 project_id（摘要里是百分号编码的 file URI）', () => {
  const root = tmpRoot('ag-write-project');
  const { sum } = seedHub(root);
  addSummary(sum, '99999999-0000-4000-8000-000000000001', {
    title: '宿主已有会话',
    workspace_uris: '["file:///d%3A/00-lk-agent"]',
  });
  const pdb = new DatabaseSync(sum);
  pdb.prepare('UPDATE conversation_summaries SET project_id = ? WHERE conversation_id = ?').run('existing-project', '99999999-0000-4000-8000-000000000001');
  pdb.close();

  const ctx = ctxFor(root);
  const id = '33333333-4444-4555-8666-777777777777';
  const r = antigravityWriter.write(ctx, { session: sourceSession(id), targetId: id, mode: 'create' });
  assert.equal(r.ok, true, r.error);
  const sdb = new DatabaseSync(sum, { readOnly: true });
  const row = sdb.prepare('select project_id from conversation_summaries where conversation_id = ?').get(id);
  sdb.close();
  assert.equal(row.project_id, 'existing-project');
});

test('antigravity writer：target-exists / append / force', () => {
  const root = tmpRoot('ag-write-append');
  seedHub(root);
  const ctx = ctxFor(root);
  const id = '22222222-3333-4444-8555-666666666666';
  const session = sourceSession(id);
  assert.equal(antigravityWriter.write(ctx, { session, targetId: id, mode: 'create' }).ok, true);
  const again = antigravityWriter.write(ctx, { session, targetId: id, mode: 'create' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'target-exists');

  const partial = { ...session, turns: session.turns.slice(2) };
  const app = antigravityWriter.write(ctx, { session: partial, targetId: id, mode: 'append', fromTurnIndex: 0 });
  assert.equal(app.ok, true, app.error);
  const db = new DatabaseSync(antigravityWriter.targetPath(ctx, session, id).split('#')[0], { readOnly: true });
  assert.equal(db.prepare('select count(*) c from steps').get().c, 8);
  db.close();

  const forced = antigravityWriter.write(ctx, { session, targetId: id, mode: 'create', force: true });
  assert.equal(forced.ok, true, forced.error);
  const db2 = new DatabaseSync(antigravityWriter.targetPath(ctx, session, id).split('#')[0], { readOnly: true });
  assert.equal(db2.prepare('select count(*) c from steps').get().c, 6);
  db2.close();
});
