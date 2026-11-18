// M32 测试：源侧合并的唯一策略
//
// 三条不变量：
//   1) 正文副本按代际顺序选（sessions / db / cli-jsonl 先于 tasks / local-db），与各 reader 的 read() 一致；
//   2) provenance / account 是会话属性：选中的副本没有时，从同 id 的其它副本补齐（list 与 read 必须一致）；
//   3) 多份副本带不同 origin → 不静默合并，list/import 输出冲突（保留谁、未采用谁）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen, sandboxEnv } from './matrix-home.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { mergeSessions } from '../src/readers/base.mjs';
import { planImport, executePlan } from '../src/import.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m32-${name}-`));
}
function ctxFor(root, env = {}) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { ...env } }),
    ['pi', 'cline'],
  );
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function provenance(variant, sessionId, placed = null) {
  const p = { tool: 'session-sync', v: 1, origin: { variant, sessionId }, chain: [{ variant, sessionId, at: 1 }] };
  if (placed) p.placed = placed;
  return p;
}

// ---------- 策略本身 ----------

test('mergeSessions：正文按代际选，provenance/placed 从同 id 的其它副本补齐', () => {
  const p = provenance('codex', 'c-1', { directory: 'D:/proj', scope: 'project' });
  const { sessions, conflicts } = mergeSessions([
    { id: 'dup', variant: 'cline', source: 'sessions', sourcePath: 'store-dir', updatedAt: 100 },
    { id: 'dup', variant: 'cline', source: 'tasks', sourcePath: 'task-dir', updatedAt: 900, provenance: p },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, 'sessions', '正文 / 元数据取现行代际，不因旧的 provenance 副本换正文');
  assert.equal(sessions[0].provenance.origin.sessionId, 'c-1', '身份从任务目录副本补齐');
  assert.deepEqual(sessions[0].placed, { directory: 'D:/proj', scope: 'project' }, 'placed 跟着补齐的 provenance 走');
  assert.equal(conflicts.length, 0, '只有一份带标记不算冲突');
});

test('mergeSessions：同 id 两份副本 origin 不同 → 保留选中副本的，并返回冲突', () => {
  const { sessions, conflicts } = mergeSessions([
    { id: 'dup', variant: 'cline', source: 'sessions', sourcePath: 'store-dir', provenance: provenance('codex', 'c-1') },
    { id: 'dup', variant: 'cline', source: 'tasks', sourcePath: 'task-dir', provenance: provenance('codex', 'c-2') },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provenance.origin.sessionId, 'c-1');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].origins.sort(), ['codex:c-1', 'codex:c-2']);
  assert.equal(conflicts[0].kept, 'store-dir');
  assert.deepEqual(conflicts[0].dropped, ['task-dir']);
});

// ---------- cline：宿主迁移没带上 session-sync 标记 ----------

function mkClineStore(root, id, text) {
  const dir = path.join(root, '.cline', 'data', 'sessions', id);
  writeJson(path.join(dir, `${id}.json`), {
    version: 1,
    session_id: id,
    source: 'vscode',
    started_at: '2026-10-08T18:38:21.000Z',
    ended_at: '2026-10-08T18:38:30.000Z',
    cwd: 'D:/work/x',
    workspace_root: 'D:/work/x',
    metadata: { title: '会话库里的标题' },
    messages_path: path.join(dir, `${id}.messages.json`),
  });
  writeJson(path.join(dir, `${id}.messages.json`), {
    version: 1,
    sessionId: id,
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text }], ts: 1791484221000 },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '回答' }], ts: 1791484230000 },
    ],
  });
}

function mkClineTask(root, ide, id, meta) {
  const dir = path.join(root, 'AppData', 'Roaming', ide, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', id);
  writeJson(path.join(dir, 'api_conversation_history.json'), [
    { role: 'user', content: [{ type: 'text', text: '老任务目录正文' }], ts: 1791484221000 },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }], ts: 1791484230000 },
  ]);
  writeJson(path.join(dir, 'task_metadata.json'), meta);
  return dir;
}

test('cline：会话库副本没有标记、任务目录副本有 → list/read 都补上同一份 provenance，正文仍取会话库', () => {
  const root = tmpRoot('cline-adopt');
  const p = provenance('codex', 'c-9');
  mkClineStore(root, 'dup-c9', '会话库新正文');
  mkClineTask(root, 'Code', 'dup-c9', { 'session-sync': p });
  const ctx = ctxFor(root);

  const list = listSessions('cline', ctx, {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].source, 'sessions', '正文副本按代际');
  assert.equal(list.conflicts.length, 0);
  assert.deepEqual(list.sessions[0].provenance.origin, { variant: 'codex', sessionId: 'c-9' });

  const back = readSession('cline', ctx, 'dup-c9').session;
  assert.match(JSON.stringify(back.turns), /会话库新正文/, '正文取会话库（与 list 的 source 一致）');
  assert.deepEqual(back.origin, { variant: 'codex', sessionId: 'c-9' }, 'read 必须补上同一份 provenance');
  assert.doesNotMatch(JSON.stringify(back.turns), /老任务目录正文/, '不能退回旧任务目录正文');
});

// ---------- 身份补齐必须贯通到落库：plan 的 targetId 与实际写出的 ID 不能分叉 ----------

test('cline：只有旧任务副本带标记时，plan 的目标 ID 与实际落库 ID 一致', () => {
  const root = tmpRoot('cline-plan');
  mkClineStore(root, 'dup-c10', '会话库新正文');
  mkClineTask(root, 'Code', 'dup-c10', { 'session-sync': provenance('codex', 'c-10') });
  const ctx = ctxFor(root);

  const plan = planImport(ctx, { from: ['cline'], into: ['pi'] });
  const pair = plan.pairs.find((p) => p.sourceId === 'dup-c10');
  assert.ok(pair, JSON.stringify(plan.pairs));
  assert.equal(pair.originKey, 'codex:c-10', '计划身份来自补齐后的 summary provenance');

  const results = executePlan(ctx, plan, { apply: true, lock: false });
  const done = results.find((r) => r.sourceId === 'dup-c10');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.targetId, pair.targetId, '执行时读侧补的 provenance 必须让目标 ID 与计划一致');
  assert.deepEqual(readSession('pi', ctx, pair.targetId).session.origin, { variant: 'codex', sessionId: 'c-10' });
});

// ---------- qoder：CLI 明文与桌面库同 id ----------

function mkQoderCli(root, id, prov) {
  const rows = [
    { type: 'workspace-directories', directories: ['D:/work/q'] },
    ...(prov ? [{ type: 'session-sync-provenance', 'session-sync': prov, timestamp: '2026-10-08T18:38:20.000Z' }] : []),
    { type: 'user', sessionId: id, cwd: 'D:/work/q', uuid: 'u1', parentUuid: null, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: 'CLI 明文正文' }] } },
    { type: 'assistant', sessionId: id, cwd: 'D:/work/q', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
  ];
  const file = path.join(root, '.qoder-cn', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function mkQoderDb(root, id, { prov, userId } = {}) {
  const file = path.join(root, 'AppData', 'Roaming', 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE chat_session (session_id TEXT PRIMARY KEY, session_title TEXT, project_uri TEXT, project_id TEXT, parent_session_id TEXT, gmt_create INTEGER, gmt_modified INTEGER, extra TEXT, user_id TEXT, user_name TEXT, org_id TEXT, preferred_model_info TEXT)`);
  db.prepare('INSERT INTO chat_session (session_id, session_title, project_uri, parent_session_id, gmt_create, gmt_modified, extra, user_id, user_name) VALUES (?,?,?,?,?,?,?,?,?)').run(
    id,
    '桌面库标题',
    'D:/work/q',
    null,
    1791484221000,
    1791484230000,
    JSON.stringify(prov ? { 'session-sync': prov } : {}),
    userId ?? null,
    userId ? 'tester' : null,
  );
  db.close();
}

test('qoder：CLI 明文没有标记、桌面库有 → list/read 都用桌面库补身份，账户也从库里取', () => {
  const root = tmpRoot('qoder-adopt');
  mkQoderCli(root, 'sess-q1', null);
  mkQoderDb(root, 'sess-q1', { prov: provenance('codex', 'q-1'), userId: 'u-1' });
  const ctx = ctxFor(root);

  const list = listSessions('qoder-cn', ctx, {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].source, 'cli-jsonl', 'CLI 明文是首选正文');
  assert.equal(list.sessions[0].provenance.origin.sessionId, 'q-1');
  assert.equal(list.sessions[0].account?.id, 'u-1', '账户从同 id 桌面库行补齐');
  assert.equal(list.conflicts.length, 0);

  const back = readSession('qoder-cn', ctx, 'sess-q1').session;
  assert.match(JSON.stringify(back.turns), /CLI 明文正文/);
  assert.deepEqual(back.origin, { variant: 'codex', sessionId: 'q-1' }, 'read 与 list 的身份必须一致');
  assert.equal(back.account?.id, 'u-1', 'read 与 list 的账户也必须一致（落点计算用 IR）');
});

test('qoder：CLI 与桌面库各带不同 origin → 保留首选副本的，冲突可被调用方看到', () => {
  const root = tmpRoot('qoder-conflict');
  mkQoderCli(root, 'sess-q2', provenance('codex', 'q-a'));
  mkQoderDb(root, 'sess-q2', { prov: provenance('codex', 'q-b'), userId: 'u-2' });
  const list = listSessions('qoder-cn', ctxFor(root), {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].provenance.origin.sessionId, 'q-a');
  assert.equal(list.conflicts.length, 1);
  assert.deepEqual(list.conflicts[0].origins.sort(), ['codex:q-a', 'codex:q-b']);
});

test('CLI 文本视图：冲突行带「保留 / 未采用」两个来源', () => {
  const root = tmpRoot('qoder-conflict-cli');
  mkQoderCli(root, 'sess-q3', provenance('codex', 'q-c'));
  mkQoderDb(root, 'sess-q3', { prov: provenance('codex', 'q-d'), userId: 'u-3' });
  const env = sandboxEnv(root, { APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local') });
  const text = execFileSync(process.execPath, [BIN, 'list', '--from', 'qoder-cn'], { env, encoding: 'utf8' });
  assert.match(text, /! qoder-cn: 同 id sess-q3 但 origin 不同（codex:q-c, codex:q-d）/);
  assert.match(text, /保留 .*projects[\s\S]*未采用 .*local\.db/, `冲突行要说明保留/未采用的来源：${text}`);
});

// ---------- opencode：多库并存时正文与身份各取所需 ----------

function mkOpencodeV2(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, metadata TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  for (const r of rows) {
    db.prepare('INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      r.id,
      'global',
      r.id,
      'D:/w',
      '',
      r.title ?? r.id,
      '2.0',
      r.prov ? JSON.stringify({ 'session-sync': r.prov }) : null,
      1791484221000,
      1791484230000,
    );
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(
      `${r.id}-m1`,
      r.id,
      'user',
      0,
      1791484221000,
      1791484221000,
      JSON.stringify({ text: r.text ?? 'q', time: { created: 1791484221000 } }),
    );
  }
  db.close();
  return file;
}

test('opencode：第一个库给正文、第二个库给身份 → list 摘要与 read 正文都取这一组合', () => {
  const root = tmpRoot('oc-adopt');
  const a = mkOpencodeV2(path.join(root, 'ocA', 'opencode.db'), [{ id: 'ses_e1729a950ffeDup00000000001', title: 'A 库标题', text: 'A 库正文' }]);
  mkOpencodeV2(path.join(root, 'AppData', 'Roaming', 'opencode', 'opencode.db'), [{ id: 'ses_e1729a950ffeDup00000000001', title: 'B 库标题', text: 'B 库正文', prov: provenance('codex', 'o-1') }]);
  const ctx = ctxFor(root, { OPENCODE_DATA_DIR: path.dirname(a) });

  const list = listSessions('opencode', ctx, {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].title, 'A 库标题', '正文副本按登记顺序（与 read 一致）');
  assert.equal(list.sessions[0].provenance.origin.sessionId, 'o-1', '身份从另一个库补齐');
  assert.equal(list.conflicts.length, 0);

  const back = readSession('opencode', ctx, 'ses_e1729a950ffeDup00000000001').session;
  assert.match(JSON.stringify(back.turns), /A 库正文/, 'read 取第一个库的正文');
  assert.deepEqual(back.origin, { variant: 'codex', sessionId: 'o-1' }, 'read 补上另一个库的身份');
});
