// M29 测试：cline / kilo 的宿主列表源（按 2026-10-27 最新版源码取证）
//
// 取证来源（可复现）：
//   Cline 4.1.26（marketplace VSIX，dist/extension.js）
//     - 列表走任务历史服务 `taskHistory.listHistory()` → 本地会话库：
//       `<data>/sessions/<id>/<id>.json`（manifest v1，zod 校验）+ `<id>.messages.json`，
//       以及 `<data>/db/sessions.db` 的 `sessions` 表（NOT NULL 列见下）。
//       `<data>` = `CLINE_DATA_DIR || ~/.cline/data`（`CLINE_DIR` 可改根）。
//     - `state/taskHistory.json` 只有 LegacyStateReader 在读（迁移用，写它不进主列表）。
//   Kilo 7.8.18（open-vsx VSIX）
//     - 列表改为服务端（`/sync/history` + `sessionImport.*`），本地 `globalState.taskHistory`
//       只是迁移来源；本机安装的 5.16.2 仍在读 `context.globalState.get("taskHistory")`。
//     - 任务目录（tasks/<id>/{api_conversation_history,ui_messages}.json）仍是内容载体（扫描/迁移都读它）。
// 因此：cline 写「会话库」；kilo 写「任务目录 + globalState.taskHistory（≤5.16.2 的有效契约）」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { backupsOf, strayBackups } from './backup-fixture.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m29-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}
function mkClaudeSource(root, id, cwd, texts = ['第一轮问题']) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: new Date(1791484221000 + i * 9000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: new Date(1791484230000 + i * 9000).toISOString(), message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const importOnce = (ctx, into) => executePlan(ctx, planImport(ctx, { from: ['claude'], into: [into] }), { apply: true, lock: false })[0];

// ---------- Cline 4.x：会话库 ----------

const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  status TEXT NOT NULL,
  status_lock INTEGER NOT NULL DEFAULT 0,
  interactive INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  team_name TEXT,
  enable_tools INTEGER NOT NULL,
  enable_spawn INTEGER NOT NULL,
  enable_teams INTEGER NOT NULL,
  parent_session_id TEXT,
  parent_agent_id TEXT,
  agent_id TEXT,
  conversation_id TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  metadata_json TEXT,
  transcript_path TEXT NOT NULL DEFAULT '',
  hook_path TEXT NOT NULL,
  messages_path TEXT,
  updated_at TEXT NOT NULL
)`;

function mkClineStore(root, { withDb = true } = {}) {
  const data = path.join(root, '.cline', 'data');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  const dbFile = path.join(data, 'db', 'sessions.db');
  if (withDb) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(SESSIONS_DDL);
    // 一条宿主原生行 + 一条不相关的表数据（必须原样保留）
    db.prepare(
      `INSERT INTO sessions (session_id, source, pid, started_at, ended_at, status, interactive, provider, model, cwd, workspace_root,
        enable_tools, enable_spawn, enable_teams, is_subagent, prompt, metadata_json, transcript_path, hook_path, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('1785824485225_px5yk', 'cli', 37628, '2026-08-04T06:21:54.568Z', '2026-09-01T08:48:43.940Z', 'failed', 1, 'cline-pass', 'deepseek/deepseek-v4-flash', 'D:\\00-demo-app', 'D:/00-demo-app', 1, 1, 1, 0, '原生任务', JSON.stringify({ title: '原生任务' }), '', '', '2026-09-01T08:48:43.940Z');
    db.close();
  }
  return { data, dbFile };
}

const readRow = (dbFile, id) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id);
  } finally {
    db.close();
  }
};

test('cline（4.x）：写会话库三件套 —— manifest + messages + sessions 表行', () => {
  const root = tmpRoot('cline-store');
  const { data, dbFile } = mkClineStore(root);
  mkClaudeSource(root, 's1', 'D:/00-work/code/demo-app');
  const ctx = ctxFor(root);
  const r = importOnce(ctx, 'cline');
  assert.equal(r.ok, true, JSON.stringify(r));

  const dir = path.join(data, 'sessions', r.targetId);
  const manifestFile = path.join(dir, `${r.targetId}.json`);
  const messagesFile = path.join(dir, `${r.targetId}.messages.json`);
  assert.ok(fs.existsSync(manifestFile), 'manifest 必须存在（列表/迁移都认它）');
  assert.ok(fs.existsSync(messagesFile), 'messages 必须存在');

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.session_id, r.targetId);
  assert.equal(J(manifest.cwd), J('D:/00-work/code/demo-app'));
  assert.equal(J(manifest.workspace_root), J('D:/00-work/code/demo-app'));
  assert.equal(manifest.status, 'completed', 'status 必须在宿主枚举内：idle/running/pending/completed/failed/cancelled');
  assert.equal(manifest.enable_tools, true);
  assert.equal(typeof manifest.provider, 'string');
  assert.ok(manifest.provider.length > 0);
  assert.ok(manifest.prompt.includes('第一轮问题'));

  const bundle = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
  assert.equal(bundle.version, 1);
  assert.equal(bundle.sessionId, r.targetId);
  assert.ok(Array.isArray(bundle.messages) && bundle.messages.length >= 2, JSON.stringify(bundle.messages?.length));
  for (const m of bundle.messages) {
    assert.ok(m.id && (m.role === 'user' || m.role === 'assistant') && Array.isArray(m.content), JSON.stringify(m).slice(0, 200));
  }

  const row = readRow(dbFile, r.targetId);
  assert.ok(row, 'sessions 表必须有行（无 manifest fallback 时也能列出）');
  assert.equal(row.is_subagent, 0);
  assert.equal(row.parent_session_id, null);
  assert.ok(['idle', 'running', 'pending', 'completed', 'failed', 'cancelled'].includes(row.status), row.status);
  assert.equal(row.interactive, 1);
  assert.equal(J(row.cwd), J('D:/00-work/code/demo-app'));
  assert.equal(J(row.workspace_root), J('D:/00-work/code/demo-app'));
  assert.ok(row.hook_path !== null && row.transcript_path !== null, 'NOT NULL 列必须给值');
  assert.equal(JSON.parse(row.metadata_json).title, '第一轮问题');

  // 宿主原生行不能被动
  const native = readRow(dbFile, '1785824485225_px5yk');
  assert.equal(native.status, 'failed');
  assert.equal(native.provider, 'cline-pass');

  const backups = backupsOf(root, 'cline').filter((n) => n.includes('sessions.db'));
  assert.ok(backups.length >= 1, '改写库前必须备份');
  assert.deepEqual(strayBackups(path.join(data, 'db')), [], '宿主扫描根里不许留 .bak 残渣');
});

test('cline（4.x）：幂等 + append 更新同一行/同一目录；our reader 能读回（round-trip）', () => {
  const root = tmpRoot('cline-idem');
  const { data, dbFile } = mkClineStore(root);
  mkClaudeSource(root, 's2', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const first = importOnce(ctx, 'cline');
  assert.equal(first.ok, true, JSON.stringify(first));

  mkClaudeSource(root, 's2', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const second = importOnce(ctx, 'cline');
  assert.equal(second.action, 'append', JSON.stringify(second.action));
  assert.equal(second.targetId, first.targetId);

  const dirs = fs.readdirSync(path.join(data, 'sessions')).filter((n) => n === first.targetId);
  assert.equal(dirs.length, 1, '不得另起新目录');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE session_id = ?').get(first.targetId).c;
  db.close();
  assert.equal(n, 1);

  const back = readSession('cline', ctx, first.targetId).session;
  assert.equal(back.turns.length, 2, `读回必须有两轮，实际 ${back.turns.length}`);
  // 我们的 reader 按文件列会话：fixture 里那条原生行只有 db 行、没有 manifest，所以不出现（与宿主不同）
  assert.deepEqual(listSessions('cline', ctx, {}).sessions.map((s) => s.id), [first.targetId]);
});

test('cline（4.x）：sessions.db 缺失时自建表（不能因为库不存在就失败）', () => {
  const root = tmpRoot('cline-nodb');
  const { dbFile } = mkClineStore(root, { withDb: false });
  mkClaudeSource(root, 's3', 'D:/00-work/code/demo-app');
  const r = importOnce(ctxFor(root), 'cline');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(readRow(dbFile, r.targetId), '应自建 sessions 表并写入行');
});

// ---------- Kilo：任务目录 + globalState.taskHistory（≤5.16.2 的有效契约） ----------

function mkKiloHome(root) {
  const gs = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage');
  const ext = path.join(gs, 'kilocode.kilo-code');
  fs.mkdirSync(path.join(ext, 'tasks'), { recursive: true });
  const dbFile = path.join(gs, 'state.vscdb');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const value = {
    allowedCommands: ['git log', 'git status'],
    apiProvider: 'kilocode',
    mode: 'code',
    taskHistory: [
      { id: '01a1331a-b3cf-713d-9e6e-6fe3942c39f2', number: 1, ts: 1791859218905, task: '宿主原生任务', tokensIn: 100605, tokensOut: 2338, totalCost: 0, size: 39064, workspace: 'd:/00-demo-app', mode: 'code', toolProtocol: 'native', apiConfigName: 'default', cacheWrites: 0, cacheReads: 38880 },
    ],
  };
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('kilocode.kilo-code', JSON.stringify(value));
  db.close();
  return { dbFile, ext };
}

const readKiloState = (dbFile) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('kilocode.kilo-code');
    return JSON.parse(Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value));
  } finally {
    db.close();
  }
};

test('kilo：写 taskHistory（globalState）且保留其余顶层键；任务目录仍写入', () => {
  const root = tmpRoot('kilo-index');
  const { dbFile, ext } = mkKiloHome(root);
  mkClaudeSource(root, 's4', 'D:/00-work/code/demo-app');
  const ctx = ctxFor(root);
  const r = importOnce(ctx, 'kilo');
  assert.equal(r.ok, true, JSON.stringify(r));

  const state = readKiloState(dbFile);
  assert.deepEqual(state.allowedCommands, ['git log', 'git status']);
  assert.equal(state.apiProvider, 'kilocode');
  assert.equal(state.taskHistory.length, 2, JSON.stringify(state.taskHistory.map((x) => x.id)));
  const mine = state.taskHistory.find((x) => x.id === r.targetId);
  assert.ok(mine, JSON.stringify(state.taskHistory.map((x) => x.id)));
  assert.equal(mine.task, '第一轮问题');
  assert.equal(J(mine.workspace), J('D:/00-work/code/demo-app'));
  assert.equal(mine.mode, 'code');
  assert.equal(mine.toolProtocol, 'native');
  assert.equal(mine.apiConfigName, 'default');
  assert.equal(typeof mine.number, 'number');
  assert.equal(typeof mine.ts, 'number');

  assert.ok(fs.existsSync(path.join(ext, 'tasks', r.targetId, 'api_conversation_history.json')), '任务目录内容仍要写（7.8.18 扫描/迁移也读它）');
  const backups = backupsOf(root, 'kilo').filter((n) => n.includes('state.vscdb'));
  assert.ok(backups.length >= 1);
  assert.deepEqual(strayBackups(path.dirname(dbFile)), [], '宿主扫描根里不许留 .bak 残渣');
});

test('kilo：append 不重复；state.vscdb 不存在时只警告不失败', () => {
  const root = tmpRoot('kilo-idem');
  const { dbFile } = mkKiloHome(root);
  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const first = importOnce(ctx, 'kilo');
  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const second = importOnce(ctx, 'kilo');
  assert.equal(second.action, 'append', JSON.stringify(second.action));
  assert.equal(readKiloState(dbFile).taskHistory.filter((x) => x.id === first.targetId).length, 1);

  const root2 = tmpRoot('kilo-nodb');
  fs.mkdirSync(path.join(root2, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });
  mkClaudeSource(root2, 's6', 'D:/00-work/code/demo-app');
  const r2 = importOnce(ctxFor(root2), 'kilo');
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok((r2.warnings ?? []).some((w) => /kilo-index-absent/.test(String(w))), JSON.stringify(r2.warnings));
});

// ---------- Kilo 7.8.18：本地 kilo.db（OpenCode 血统） ----------

function mkKiloDb(root) {
  const file = path.join(root, 'AppData', 'Local', 'kilo', 'kilo.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), parent_id TEXT, slug TEXT, directory TEXT, path TEXT, workspace_id TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.close();
  return file;
}

test('kilo（7.8.18+）：存在 kilo.db 时写库（OpenCode 血统），不再写任务目录', () => {
  const root = tmpRoot('kilo-db');
  const dbFile = mkKiloDb(root);
  // 同时放一个任务目录，确认 writer 按代际只选库
  fs.mkdirSync(path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });
  mkClaudeSource(root, 's7', 'D:/00-work/code/demo-app');
  const ctx = ctxFor(root);
  const r = importOnce(ctx, 'kilo');
  assert.equal(r.ok, true, JSON.stringify(r));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const sess = db.prepare('SELECT * FROM session WHERE id = ?').get(r.targetId);
  const msgs = db.prepare('SELECT * FROM message WHERE session_id = ?').all(r.targetId);
  db.close();
  assert.ok(sess, 'session 行必须写进 kilo.db');
  assert.equal(J(sess.directory), J('D:/00-work/code/demo-app'));
  assert.ok(msgs.length >= 2, JSON.stringify(msgs.length));

  const taskDir = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks', r.targetId);
  assert.ok(!fs.existsSync(taskDir), '新版代际只写库，不再产出任务目录（避免双份）');

  const back = readSession('kilo', ctx, r.targetId).session;
  assert.ok(back.turns.length >= 1, JSON.stringify(back.turns.length));
});
