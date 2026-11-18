// M2 测试：SQLite 系 reader（fixtures 在临时目录构造，不触碰真实数据）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeReader } from '../src/readers/opencode.mjs';
import { createOpencodeClassicReader } from '../src/readers/opencode-classic.mjs';
import { minimaxReader } from '../src/readers/minimax.mjs';
import { cursorReader } from '../src/readers/cursor.mjs';
import { createQoderReader } from '../src/readers/qoder.mjs';
import { createClineFamilyReader } from '../src/readers/cline-family.mjs';
import { kiloReader } from '../src/readers/kilo.mjs';
import { buildProvenance } from '../src/provenance.mjs';
import { makeSession } from '../src/ir.mjs';

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
  return dir;
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkdb(file, schema) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const sql of schema) db.exec(sql);
  return db;
}

test('opencode reader：list/read + 内联 content 解析', () => {
  const root = tmpRoot('opencode');
  const dir = path.join(root, 'opencode');
  const db = mkdb(path.join(dir, 'opencode.db'), [
    `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, metadata TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`,
    `CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)`,
  ]);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'ses_1', 'p1', null, 'slug', 'D:/work/demo', 'demo title', '2.0', null, 'build', JSON.stringify({ id: 'm1' }), 1000, 2000, null,
  );
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg1', 'ses_1', 'user', 0, 1000, JSON.stringify({ time: { created: 1000 }, text: 'hello <system-reminder>x</system-reminder> world', files: [] }));
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg2', 'ses_1', 'assistant', 1, 1100, JSON.stringify({
    time: { created: 1100 },
    content: [
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answer' },
      { type: 'tool', id: 'c1', name: 'shell', state: { status: 'completed', input: { cmd: 'ls' }, content: [{ type: 'text', text: 'out' }] } },
    ],
  }));
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg3', 'ses_1', 'system', 2, 1200, JSON.stringify({ text: 'env info' }));
  db.close();

  const ctx = ctxFor(root, { OPENCODE_DATA_DIR: dir });
  const list = opencodeReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ses_1');
  assert.equal(list[0].cwd, 'D:/work/demo');

  const s = opencodeReader.read(ctx, 'ses_1');
  assert.ok(s);
  assert.equal(s.title, 'demo title');
  assert.equal(s.turns.length, 1);
  const kinds = s.turns[0].items.map((i) => i.kind);
  assert.ok(kinds.includes('reasoning'));
  assert.ok(kinds.includes('tool_call'));
  assert.ok(kinds.includes('tool_result'));
  const userText = s.turns[0].items.find((i) => i.kind === 'message' && i.role === 'user').text;
  assert.equal(userText, 'hello  world');
  fs.rmSync(root, { recursive: true, force: true });
});

test('zcode reader：session/message/part + session_entry provenance', () => {
  const root = tmpRoot('zcode');
  const dir = path.join(root, '.zcode', 'cli', 'db');
  const db = mkdb(path.join(dir, 'db.sqlite'), [
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`,
    `CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)`,
    `CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)`,
    `CREATE TABLE session_entry (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)`,
  ]);
  const prov = buildProvenance(makeSession({ id: 'codex-1', variant: 'codex' }), 500);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('sess_1', 'p', null, 's', 'D:/z/demo', 'zcode demo', '0.14', null, 1000, 2000, null);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m1', 'sess_1', 1000, JSON.stringify({ role: 'user', time: { created: 1000 }, model: { modelID: 'GLM-5.2' } }), 0);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m2', 'sess_1', 1100, JSON.stringify({ role: 'assistant', time: { created: 1100 } }), 1);
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p1', 'm1', 'sess_1', 1000, JSON.stringify({ type: 'text', text: 'hi' }), 0);
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p2', 'm2', 'sess_1', 1100, JSON.stringify({ type: 'reasoning', text: 'r' }), 1);
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p3', 'm2', 'sess_1', 1100, JSON.stringify({ type: 'tool', callID: 'c1', tool: 'Bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } }), 2);
  db.prepare('INSERT INTO session_entry VALUES (?,?,?,?,?)').run('e1', 'sess_1', 'session-sync/provenance', 2000, JSON.stringify(prov));
  db.close();

  const reader = createOpencodeClassicReader({ variant: 'zcode', provenanceSlot: 'session_entry' });
  const ctx = ctxFor(root, { ZCODE_HOME: path.join(root, '.zcode') });
  assert.equal(reader.available(ctx), true);
  const list = reader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.variant, 'codex');

  const s = reader.read(ctx, 'sess_1');
  assert.equal(s.turns.length, 1);
  assert.equal(s.model, 'GLM-5.2');
  assert.equal(s.origin.variant, 'codex');
  assert.ok(s.turns[0].items.some((i) => i.kind === 'tool_call' && i.name === 'Bash'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('mimo reader：排除自动导入会话 + permission 槽位 provenance', () => {
  const root = tmpRoot('mimo');
  const dir = path.join(root, 'mimo');
  const db = mkdb(path.join(dir, 'mimocode.db'), [
    `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`,
    `CREATE TABLE message (id TEXT, session_id TEXT, agent_id TEXT, time_created INTEGER, data TEXT)`,
    `CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`,
    `CREATE TABLE external_import (source TEXT, source_key TEXT, session_id TEXT)`,
  ]);
  const prov = buildProvenance(makeSession({ id: 'pi-1', variant: 'pi' }), 500);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('ses_keep', 'p', null, 's', 'D:/m/demo', 'keep', 'v', JSON.stringify({ 'session-sync': prov }), 1000, 2000, null);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('ses_auto', 'p', null, 's', 'D:/m/demo', 'auto', 'v', null, 1000, 2000, null);
  db.prepare('INSERT INTO external_import VALUES (?,?,?)').run('claude', 'k', 'ses_auto');
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m1', 'ses_keep', 'main', 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'm1', 'ses_keep', 1000, JSON.stringify({ type: 'text', text: 'hello' }));
  db.close();

  const reader = createOpencodeClassicReader({ variant: 'mimo', provenanceSlot: 'permission' });
  const ctx = ctxFor(root, { MIMO_HOME: dir });
  const list = reader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ses_keep');
  assert.equal(list[0].provenance.origin.variant, 'pi');
  const s = reader.read(ctx, 'ses_keep');
  assert.equal(s.turns.length, 1);
  assert.equal(s.origin.sessionId, 'pi-1');
  fs.rmSync(root, { recursive: true, force: true });
});

test('minimax reader：sessions + message_rows（turn_id 归轮）', () => {
  const root = tmpRoot('minimax');
  const dir = path.join(root, 'minimax');
  const file = path.join(dir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = mkdb(file, [
    `CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT, updated_at_ms INTEGER, columnar_version INTEGER, agent_name TEXT, archived INTEGER, parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER, extra_data_json TEXT)`,
    `CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT, turn_id TEXT, created_at_ms INTEGER, data_json TEXT, source TEXT)`,
  ]);
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    'mvs_1', JSON.stringify({ model: 'MiniMax-M3' }), 3000, 3, 'mavis', 0, null, 'C:/mm/ws', 'mm title', 1000, null,
  );
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,created_at_ms,data_json,source) VALUES (?,?,?,?,?,?,?)').run(
    'mvs_1', 'u1', 'user', 'turn_1', 1000, JSON.stringify({ role: 'user', msg_content: 'hi there', timestamp: 1000 }), 'turn',
  );
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,created_at_ms,data_json,source) VALUES (?,?,?,?,?,?,?)').run(
    'mvs_1', 'a1', 'assistant', 'turn_1', 1100, JSON.stringify({ role: 'assistant', msg_content: 'hello!', thinking_content: 'think', timestamp: 1100, usage: { total_tokens: 10 } }), 'turn',
  );
  db.close();

  const ctx = ctxFor(root, { MINIMAX_HOME: dir });
  assert.equal(minimaxReader.available(ctx), true);
  const list = minimaxReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'mm title');
  const s = minimaxReader.read(ctx, 'mvs_1');
  assert.equal(s.turns.length, 1);
  assert.equal(s.model, 'MiniMax-M3');
  assert.ok(s.turns[0].items.some((i) => i.kind === 'reasoning' && i.text === 'think'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('cursor reader：cursorDiskKV composerData + workspace 索引', () => {
  const root = tmpRoot('cursor');
  const userDir = path.join(root, 'AppData', 'Roaming', 'Cursor', 'User');
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  const db = mkdb(globalDb, [
    `CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)`,
    `CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)`,
  ]);
  const composer = {
    composerId: 'comp-1',
    name: 'demo composer',
    forceMode: 'chat',
    createdAt: 1000,
    status: 'completed',
    conversation: [
      { type: 1, bubbleId: 'b1', text: 'hi <system-reminder>noise</system-reminder>', relevantFiles: ['a.js'] },
      { type: 2, bubbleId: 'b2', text: 'hello', timingInfo: { clientStartTime: 1100 } },
    ],
  };
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?,?)').run('composerData:comp-1', JSON.stringify(composer));
  db.close();

  // workspace 索引
  const wsDir = path.join(userDir, 'workspaceStorage', 'hash1');
  fs.mkdirSync(wsDir, { recursive: true });
  const wsDb = mkdb(path.join(wsDir, 'state.vscdb'), [`CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)`]);
  wsDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?,?)').run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'comp-1' }], selectedComposerId: 'comp-1' }));
  wsDb.close();
  fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///d%3A/work/demo' }));

  const ctx = ctxFor(root);
  assert.equal(cursorReader.available(ctx), true);
  const list = cursorReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'demo composer');
  assert.equal(list[0].cwd, path.normalize('d:/work/demo'));

  const s = cursorReader.read(ctx, 'comp-1');
  assert.equal(s.turns.length, 1);
  const userText = s.turns[0].items.find((i) => i.kind === 'message' && i.role === 'user').text;
  assert.equal(userText, 'hi');
  assert.ok(s.turns[0].items.some((i) => i.kind === 'attachment' && i.ref === 'a.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('qoder reader：元数据可读 + 加密内容降级（含密文哈希）', () => {
  const root = tmpRoot('qoder');
  const dbFile = path.join(root, 'AppData', 'Roaming', 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');
  const db = mkdb(dbFile, [
    `CREATE TABLE chat_session (session_id TEXT, session_title TEXT, project_id TEXT, project_uri TEXT, gmt_create INTEGER, gmt_modified INTEGER, session_type TEXT, mode TEXT, preferred_model_info TEXT, extra TEXT)`,
    `CREATE TABLE chat_message (id TEXT, session_id TEXT, role TEXT, content TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)`,
  ]);
  db.prepare('INSERT INTO chat_session VALUES (?,?,?,?,?,?,?,?,?,?)').run('task-1', 'qoder title', 'p', 'd:/q/proj', 1000, 2000, 'quest', 'agent', JSON.stringify({ preferred_model: 'qfmodel' }), null);
  const cipher = Buffer.from('x'.repeat(200)).toString('base64');
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,?,?,?,?)').run('m1', 'task-1', 'user', cipher, '', '', 1000);
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,?,?,?,?)').run('m2', 'task-1', 'assistant', cipher + 'AAA', JSON.stringify({ prompt_tokens: 10 }), JSON.stringify({ model_key: 'auto' }), 1100);
  db.close();

  const reader = createQoderReader({ variant: 'qoder-cn' });
  const ctx = ctxFor(root);
  assert.equal(reader.available(ctx), true);
  const list = reader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].degraded, 'encrypted-content');

  const s = reader.read(ctx, 'task-1');
  assert.equal(s.turns.length, 1);
  assert.ok(s.turns[0].items.some((i) => i.kind === 'note' && i.text.includes('加密')));
  assert.ok(s.turns[0].items.some((i) => i.kind === 'meta' && i.key === 'content-sha256'));
  // 不同密文 → 不同指纹
  const s2 = reader.read(ctx, 'task-1');
  assert.deepEqual(s.turns.map((t) => t.items.length), s2.turns.map((t) => t.items.length));
  fs.rmSync(root, { recursive: true, force: true });
});

test('cline-family reader：任务目录（api_conversation_history 优先）', () => {
  const root = tmpRoot('cline');
  const tasksDir = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
  const taskDir = path.join(tasksDir, '1785308000075');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '<task>do it</task><environment_details>x</environment_details>' }], ts: 1000 },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.js' } }], ts: 1100 },
  ]));
  fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify([
    { ts: 1000, type: 'say', say: 'task', text: 'do it' },
  ]));
  fs.writeFileSync(path.join(taskDir, 'task_metadata.json'), JSON.stringify({ files_in_context: [{ path: 'a.js' }] }));

  const reader = createClineFamilyReader({ variant: 'cline' });
  const ctx = ctxFor(root);
  assert.equal(reader.available(ctx), true);
  const list = reader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, '1785308000075');

  const s = reader.read(ctx, '1785308000075');
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].items.find((i) => i.kind === 'message' && i.role === 'user').text, 'do it');
  assert.ok(s.turns[0].items.some((i) => i.kind === 'tool_call' && i.name === 'read_file'));
  assert.ok(s.turns[0].items.some((i) => i.kind === 'meta' && i.key === 'files_in_context'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('kilo reader：任务目录回退（无 db）', () => {
  const root = tmpRoot('kilo');
  const tasksDir = path.join(root, 'kilotasks');
  const taskDir = path.join(tasksDir, '01a1331a');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: 'explain this' }], ts: 1000 },
  ]));
  fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify([{ ts: 1000, type: 'say', say: 'task', text: 'explain this' }]));

  const ctx = ctxFor(root, { KILO_TASKS_DIR: tasksDir });
  assert.equal(kiloReader.available(ctx), true);
  const list = kiloReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].variant, 'kilo');
  const s = kiloReader.read(ctx, '01a1331a');
  assert.equal(s.turns.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
