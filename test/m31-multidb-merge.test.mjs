// M31 测试：多库并存时不再只认第一个（漏读修复）——全部读 + 按 id 去重
//
// 背景：opencode / mimo（以及经典三表族）的 readPaths 会同时登记「env 指定的库 + XDG / Roaming / LocalAppData 默认库」。
// 旧实现用 firstExisting 只读第一个存在的库 ⇒ 另一个库里的会话整批漏读；这类是「漏读」，不是「重复」。
// 现规则：按登记顺序全部读，同一会话 id 先到者优先；单个库损坏只跳过它自己。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m31-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { ...env } });
}

function mkOpencodeV2(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, metadata TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  for (const r of rows) {
    db.prepare('INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)').run(r.id, 'global', r.id, r.cwd ?? 'D:/w', '', r.title ?? r.id, '2.0', 1791484221000, 1791484230000);
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(`${r.id}-m1`, r.id, 'user', 0, 1791484221000, 1791484221000, JSON.stringify({ text: r.text ?? 'q', time: { created: 1791484221000 } }));
  }
  db.close();
  return file;
}

function mkOpencodeV1(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  for (const r of rows) {
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)').run(r.id, 'global', r.id, 'D:/w', r.title ?? r.id, '1.0', 1791484221000, 1791484230000);
    db.prepare('INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)').run(`${r.id}-m1`, r.id, 'main', 1791484221000, 1791484221000, JSON.stringify({ role: 'user', time: { created: 1791484221000 } }), 0);
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)').run(`${r.id}-p1`, `${r.id}-m1`, r.id, 1791484221000, 1791484221000, JSON.stringify({ type: 'text', text: '老库提问' }), 0);
  }
  db.close();
  return file;
}

function mkMimoDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.prepare('INSERT INTO project (id, worktree, name, time_created, time_updated) VALUES (?,?,?,?,?)').run('global', '/', 'global', 1, 2);
  for (const r of rows) {
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)').run(r.id, 'global', r.id, 'D:/w', r.title ?? r.id, '1.0', 1791484221000, 1791484230000);
    db.prepare('INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)').run(`${r.id}-m1`, r.id, 'main', 1791484221000, 1791484221000, JSON.stringify({ role: 'user', time: { created: 1791484221000 } }), 0);
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)').run(`${r.id}-p1`, `${r.id}-m1`, r.id, 1791484221000, 1791484221000, JSON.stringify({ type: 'text', text: r.text ?? 'q' }), 0);
  }
  db.close();
  return file;
}

test('opencode：env 库 + 默认库都读（不再只认第一个）；同 id 先到者优先', () => {
  const root = tmpRoot('oc-multi');
  const a = mkOpencodeV2(path.join(root, 'ocA', 'opencode.db'), [{ id: 'ses_a', title: '来自 A 库' }, { id: 'ses_dup', title: 'A 库版本' }]);
  const b = mkOpencodeV2(path.join(root, 'AppData', 'Roaming', 'opencode', 'opencode.db'), [{ id: 'ses_b', title: '来自 B 库' }, { id: 'ses_dup', title: 'B 库版本' }]);
  const ctx = ctxFor(root, { OPENCODE_DATA_DIR: path.dirname(a) });

  const rows = listSessions('opencode', ctx, {}).sessions;
  const byId = Object.fromEntries(rows.map((s) => [s.id, s]));
  assert.deepEqual(rows.map((s) => s.id).sort(), ['ses_a', 'ses_b', 'ses_dup'], JSON.stringify(rows.map((s) => s.id)));
  assert.equal(byId.ses_dup.title, 'A 库版本', '同 id 按登记顺序先到者（env 库）优先');
  assert.equal(readSession('opencode', ctx, 'ses_b').session.turns.length, 1);
});

test('opencode：一个库是 v2、另一个是 v1 → 两边都能读到（跨库 schema 分派）', () => {
  const root = tmpRoot('oc-mixed');
  const a = mkOpencodeV2(path.join(root, 'ocA', 'opencode.db'), [{ id: 'ses_v2' }]);
  mkOpencodeV1(path.join(root, 'AppData', 'Roaming', 'opencode', 'opencode.db'), [{ id: 'ses_v1' }]);
  const ctx = ctxFor(root, { OPENCODE_DATA_DIR: path.dirname(a) });
  const ids = listSessions('opencode', ctx, {}).sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ['ses_v1', 'ses_v2'], JSON.stringify(ids));
  assert.equal(readSession('opencode', ctx, 'ses_v1').session.turns.length, 1);
});

test('mimo：XDG 与 Roaming/Local 三个默认库都读；同 id 先到者优先', () => {
  const root = tmpRoot('mimo-multi');
  mkMimoDb(path.join(root, '.local', 'share', 'mimocode', 'mimocode.db'), [{ id: 'ses_x', title: 'XDG 版本' }, { id: 'ses_dup', title: 'XDG 版本' }]);
  mkMimoDb(path.join(root, 'AppData', 'Roaming', 'mimocode', 'mimocode.db'), [{ id: 'ses_y' }]);
  mkMimoDb(path.join(root, 'AppData', 'Local', 'mimocode', 'mimocode.db'), [{ id: 'ses_z' }, { id: 'ses_dup', title: 'Local 版本' }]);
  const rows = listSessions('mimo', ctxFor(root), {}).sessions;
  const byId = Object.fromEntries(rows.map((s) => [s.id, s]));
  assert.deepEqual(rows.map((s) => s.id).sort(), ['ses_dup', 'ses_x', 'ses_y', 'ses_z'], JSON.stringify(rows.map((s) => s.id)));
  assert.equal(byId.ses_dup.title, 'XDG 版本', '同 id 以登记顺序靠前的库为准');
});

test('mimo：某个候选库损坏（不是 SQLite）时只跳过它，其它库照常列出', () => {
  const root = tmpRoot('mimo-bad');
  const bad = path.join(root, '.local', 'share', 'mimocode', 'mimocode.db');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'this is not a sqlite database', 'utf8');
  mkMimoDb(path.join(root, 'AppData', 'Roaming', 'mimocode', 'mimocode.db'), [{ id: 'ses_ok' }]);
  const r = listSessions('mimo', ctxFor(root), {});
  assert.equal(r.ok, true, `list 不应整体失败：${r.error}`);
  assert.deepEqual(r.sessions.map((s) => s.id), ['ses_ok']);
});

test('qoder：只有 state.vscdb（KV 库）没有 local.db 时，不会把它当会话库；CLI jsonl 照常读', () => {
  const root = tmpRoot('qoder-kv');
  const cliProjects = path.join(root, '.qoder-cn', 'projects', 'p');
  fs.mkdirSync(cliProjects, { recursive: true });
  fs.writeFileSync(
    path.join(cliProjects, 'sess-1.jsonl'),
    [
      { type: 'workspace-directories', directories: ['D:/w'] },
      { type: 'user', sessionId: 'sess-1', cwd: 'D:/w', uuid: 'u1', parentUuid: null, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: '问' }] } },
      { type: 'assistant', sessionId: 'sess-1', cwd: 'D:/w', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答' }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  );
  const kv = path.join(root, 'AppData', 'Roaming', 'QoderCN', 'User', 'globalStorage', 'state.vscdb');
  fs.mkdirSync(path.dirname(kv), { recursive: true });
  const db = new DatabaseSync(kv);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.close();

  const r = listSessions('qoder-cn', ctxFor(root, { QODER_CONFIG_DIR: path.join(root, '.qoder-cn') }), {});
  assert.equal(r.ok, true, `list 不应整体失败：${r.error}`);
  assert.deepEqual(r.sessions.map((s) => s.id), ['sess-1']);
  assert.equal(r.sessions[0].account, null, '没有 local.db 时账户留 null（绝不按目录猜）');
});

test('minimax：大文件历史走 head/tail 采样分支也不能抛错（fileSize 别名回归）', () => {
  const root = tmpRoot('minimax-bigfile');
  const dbFile = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, columnar_version INTEGER, agent_name TEXT, archived INTEGER DEFAULT 0, visibility TEXT, session_kind TEXT, parent_session_id TEXT, is_default_workspace INTEGER, workspace_dir TEXT, project_workspace_dir TEXT, title TEXT, created_at_ms INTEGER, extra_data_json TEXT DEFAULT '{}', history_relative_dir TEXT)`);
  db.exec(`CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT, created_at_ms INTEGER, data_json TEXT)`);
  const rel = '2026/09/08/05-47-43-992-session_test';
  const histDir = path.join(root, '.minimax', 'v2', 'sessions', rel);
  fs.mkdirSync(histDir, { recursive: true });
  // > 512KB 才会走 head/tail 采样分支（list 的 sample = 256KB）
  const big = 'x'.repeat(600 * 1024);
  fs.writeFileSync(
    path.join(histDir, 'messages.jsonl'),
    JSON.stringify({ type: 'message', timestamp: '2026-09-08T05:47:43.992Z', message: { role: 'user', content: [{ type: 'text', text: '大文件会话' }] } }) + '\n' + JSON.stringify({ type: 'message', timestamp: '2026-09-08T05:47:44.992Z', message: { role: 'assistant', content: [{ type: 'text', text: big }] } }) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(histDir, 'manifest.json'), JSON.stringify({ createdAtMs: 1791484221000, updatedAtMs: 1791484230000 }), 'utf8');
  db.prepare("INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, columnar_version, agent_name, archived, visibility, session_kind, is_default_workspace, workspace_dir, project_workspace_dir, title, created_at_ms, extra_data_json, history_relative_dir) VALUES (?,?,?,3,'mavis',0,'visible','conversation',1,'C:/w','C:/w','大文件会话',1791484221000,'{}',?)").run('mvs_big', '{}', 1791484230000, rel);
  db.close();

  const r = listSessions('minimax', ctxFor(root), {});
  assert.equal(r.ok, true, `list 不应抛错：${r.error}`);
  assert.deepEqual(r.sessions.map((s) => s.id), ['mvs_big']);
  assert.ok(r.sessions[0].turns >= 1);
});
