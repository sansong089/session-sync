// M30 测试：多形态/多代际来源的合并去重 + 安装探测覆盖全部登记路径
//
// 背景（review 边界项）：
//   1) 同一个变体的多个来源会被 reader 直接拼接：kilo = kilo.db + 任务目录；cline = 会话库 + legacy 任务目录
//      （还可能跨多个 IDE globalStorage 根）。两代数据并存时同一 id 会列两遍 → 导入计划里出现互相覆盖的两条。
//      qoder 已经做了「同 id 以库为准」的去重，kilo/cline 没做。
//   2) 多数 detect() 只看 readPaths[0]：codex 只有 archived_sessions（没有 sessions/）时应仍算已安装。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { detectInstalled } from '../src/roots.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m30-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { ...env } });
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ---------- kilo：kilo.db 与任务目录同 id → 只列一条，库里优先 ----------

function mkKiloDbWithSession(root, id) {
  const file = path.join(root, 'AppData', 'Local', 'kilo', 'kilo.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), parent_id TEXT, slug TEXT, directory TEXT, path TEXT, workspace_id TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.prepare('INSERT INTO project (id, worktree, name, time_created, time_updated) VALUES (?,?,?,?,?)').run('proj-1', 'D:/work/x', 'x', 1, 2);
  db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)').run(id, 'proj-1', 's', 'D:/work/x', '库里的会话', '1.0', 1791484221000, 1791484230000);
  const ins = db.prepare('INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)');
  ins.run('m1', id, 'main', 1791484221000, 1791484221000, JSON.stringify({ role: 'user', time: { created: 1791484221000 } }), 0);
  insPart.run('p1', 'm1', id, 1791484221000, 1791484221000, JSON.stringify({ type: 'text', text: '库里的提问' }), 0);
  db.close();
  return file;
}

function mkKiloTask(root, ide, id) {
  const dir = path.join(root, 'AppData', 'Roaming', ide, 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks', id);
  writeJson(path.join(dir, 'api_conversation_history.json'), [
    { role: 'user', content: [{ type: 'text', text: '任务目录里的提问' }], ts: 1791484221000 },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }], ts: 1791484230000 },
  ]);
  return dir;
}

test('kilo：同 id 同时在 kilo.db 与任务目录 → list 只出 1 条，read 取库里的', () => {
  const root = tmpRoot('kilo-dedupe');
  mkKiloDbWithSession(root, 'dup-k1');
  mkKiloTask(root, 'Code', 'dup-k1');
  const ctx = ctxFor(root);

  const rows = listSessions('kilo', ctx, {}).sessions;
  assert.equal(rows.length, 1, JSON.stringify(rows.map((s) => [s.id, s.source])));
  assert.equal(rows[0].id, 'dup-k1');
  assert.equal(rows[0].source, 'db', '同一 id 以库为准（新代际）');

  const back = readSession('kilo', ctx, 'dup-k1').session;
  assert.match(JSON.stringify(back.turns), /库里的提问/, 'read 也必须取库里的正文');
});

// ---------- cline：会话库与 legacy 任务目录同 id → 只列一条，会话库优先 ----------

function mkClineStore(root, id, messages) {
  const dir = path.join(root, '.cline', 'data', 'sessions', id);
  writeJson(path.join(dir, `${id}.json`), {
    version: 1,
    session_id: id,
    source: 'vscode',
    pid: 1,
    started_at: '2026-10-08T18:38:21.000Z',
    ended_at: '2026-10-08T18:38:30.000Z',
    status: 'completed',
    interactive: true,
    provider: 'session-sync',
    model: 'm',
    cwd: 'D:/work/x',
    workspace_root: 'D:/work/x',
    enable_tools: true,
    enable_spawn: true,
    enable_teams: false,
    metadata: { title: '会话库里的会话' },
    messages_path: path.join(dir, `${id}.messages.json`),
  });
  writeJson(path.join(dir, `${id}.messages.json`), {
    version: 1,
    updated_at: '2026-10-08T18:38:30.000Z',
    agent: 'lead',
    sessionId: id,
    messages,
  });
}

function mkClineTask(root, ide, id) {
  const dir = path.join(root, 'AppData', 'Roaming', ide, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', id);
  writeJson(path.join(dir, 'api_conversation_history.json'), [{ role: 'user', content: [{ type: 'text', text: 'legacy 提问' }], ts: 1791484221000 }]);
  writeJson(path.join(dir, 'task_metadata.json'), {});
  return dir;
}

test('cline：同 id 同时在会话库与 legacy 任务目录 → list 只出 1 条（会话库优先），read 取会话库', () => {
  const root = tmpRoot('cline-dedupe');
  mkClineStore(root, 'dup-c1', [
    { id: 'a1', role: 'user', content: [{ type: 'text', text: '会话库提问' }], ts: 1791484221000 },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '回答' }], ts: 1791484230000 },
    { id: 'a3', role: 'user', content: [{ type: 'text', text: '第二轮' }], ts: 1791484240000 },
    { id: 'a4', role: 'assistant', content: [{ type: 'text', text: '回答2' }], ts: 1791484250000 },
  ]);
  mkClineTask(root, 'Code', 'dup-c1');
  const ctx = ctxFor(root);

  const rows = listSessions('cline', ctx, {}).sessions;
  assert.equal(rows.length, 1, JSON.stringify(rows.map((s) => [s.id, s.source])));
  assert.equal(rows[0].source, 'sessions', '同一 id 以会话库为准（4.x 现行代际）');

  const back = readSession('cline', ctx, 'dup-c1').session;
  assert.equal(back.turns.length, 2, `read 必须取会话库（2 轮），实际 ${back.turns.length}`);
});

test('cline：同一任务 id 出现在两个 IDE globalStorage 根 → 只列 1 条', () => {
  const root = tmpRoot('cline-multiroot');
  mkClineTask(root, 'Code', 'dup-c2');
  mkClineTask(root, 'Cursor', 'dup-c2');
  const rows = listSessions('cline', ctxFor(root), {}).sessions;
  assert.equal(rows.length, 1, JSON.stringify(rows.map((s) => [s.id, s.sourcePath])));
});

// ---------- detect：覆盖全部登记路径 ----------

test('codex：只有 archived_sessions（没有 sessions/）也算已安装，且能列出归档行', () => {
  const root = tmpRoot('codex-archived-only');
  const id = '01a13f28-22a1-7f20-9adc-062faf6271c9';
  writeJsonl(path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-08T18-30-21-${id}.jsonl`), [
    { timestamp: '2026-10-08T18:38:21.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd: 'D:/work/x' } },
    { timestamp: '2026-10-08T18:38:22.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '归档会话' }] } },
  ]);
  const ctx = ctxFor(root);
  assert.ok(detectInstalled(ctx).includes('codex'), detectInstalled(ctx).join(','));
  const rows = listSessions('codex', ctx, {}).sessions;
  assert.deepEqual(rows.map((s) => s.id), [id]);
});

test('detectInstalled：每个变体的探测覆盖全部 readPaths（不只第一个）', () => {
  const root = tmpRoot('detect-all-paths');
  // antigravity / kilo / cline 等 readPaths 里有多条时，只放最后一条也要能判已安装
  const ctx = ctxFor(root);
  const cases = [
    ['kilo', path.join(root, '.kilo', 'tasks')], // kilo readPaths 的 legacy 末位
    ['cursor', path.join(root, '.cursor')], // detect 的 home 兜底
  ];
  for (const [variant, p] of cases) fs.mkdirSync(p, { recursive: true });
  // codex：仅 archived_sessions
  fs.mkdirSync(path.join(root, '.codex', 'archived_sessions'), { recursive: true });
  const installed = detectInstalled(ctx);
  for (const v of ['codex', 'kilo', 'cursor']) assert.ok(installed.includes(v), `${v} 未命中：${installed.join(',')}`);
});

test('cline：某个任务文件畸形（被写成单个对象）时，不能拖垮整个变体的 list', () => {
  const root = tmpRoot('cline-badfile');
  // 好任务
  mkClineTask(root, 'Code', 'good-1');
  // 坏任务：api 文件写成单个对象（宿主实际写数组；截断/半写会留下这种文件）
  const badDir = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', 'bad-1');
  writeJson(path.join(badDir, 'api_conversation_history.json'), { role: 'user', content: [{ type: 'text', text: '坏文件' }] });
  const r = listSessions('cline', ctxFor(root), {});
  assert.equal(r.ok, true, `list 不应整体失败：${r.error}`);
  assert.ok(r.sessions.some((s) => s.id === 'good-1'), JSON.stringify(r.sessions.map((s) => s.id)));
});
