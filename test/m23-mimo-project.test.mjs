// M23 测试：mimo 的项目归属 —— 真机实测口径（2026-10-28）
//
// 宿主（MiMo Desktop）的列表是**按当前目录解析出的 project 过滤**的：
//   `mimo session list` 在 `~/.mimocode` 下只返回 37 条 global 会话；换到 `D:/00-demo-app` 只返回该项目的 1 条。
// 而 project id 的来源是宿主的 id 文件契约（二进制取证 + 现网文件对照）：
//   - 非 git 目录 → `global`（不新建项目行；只补一条 project(global, worktree='/') 以满足 FK）
//   - git 仓库   → `<gitdir>/mimocode-project-id`（没有就生成一个 uuid 写进去，宿主自己也这么做）
// 旧实现按 `worktree` 精确匹配、否则**新建一行随机 id** → 写进去的会话在宿主列表里永远不出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';
import { insertProjectRow } from '../src/writers/project.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m23-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkClassicDb(file, projects = []) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  for (const p of projects) {
    db.prepare('INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?)').run(p.id, p.worktree, p.name ?? p.id, p.time_created ?? 1, p.time_updated ?? 1, '[]');
  }
  db.close();
  return file;
}

function mkClaudeSource(root, id, cwd) {
  const rows = [
    { parentUuid: null, type: 'user', sessionId: id, cwd, uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: '甲' }] } },
    { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '乙' }] } },
  ];
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 建一个真实 git 仓库（没有 git 就返回 null，调用方 skip） */
function mkGitRepo(root, name = 'repo') {
  const dir = path.join(root, 'repos', name);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? dir : null;
}

const q = (file, sql, ...args) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};

const dbAt = (root) => path.join(root, '.local', 'share', 'mimocode', 'mimocode.db');

function importToMimo(root, ctx) {
  const plan = planImport(ctx, { from: ['claude'], into: ['mimo'] });
  const r = executePlan(ctx, plan, { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('非 git 目录：project_id = global（宿主口径），且不新建 project 行', () => {
  const root = tmpRoot('non-git');
  const dir = path.join(root, 'plain'); // 普通目录，不是仓库
  fs.mkdirSync(dir, { recursive: true });
  mkClaudeSource(root, 's1', J(dir));
  const file = mkClassicDb(dbAt(root), [{ id: 'proj-unrelated', worktree: 'D:/unrelated/repo' }]);
  const r = importToMimo(root, ctxFor(root));

  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, 'global', `非 git 目录必须挂 global，实际 ${sess.project_id}`);
  assert.equal(q(file, 'SELECT COUNT(*) AS c FROM project WHERE id = ?', 'proj-unrelated')[0].c, 1, '无关项目行不能被动');
  assert.equal(q(file, 'SELECT COUNT(*) AS c FROM project')[0].c, 2, '只允许补一条 global，不能再造项目行');
  const g = q(file, 'SELECT * FROM project WHERE id = ?', 'global')[0];
  assert.ok(g, 'global 行必须存在（FK 要求）');
  assert.equal(J(g.worktree), '/', '宿主实测：global 行的 worktree 是 "/"');
});

test('非 git 目录 + 空库：先补 global 行再挂会话（FK 不能炸）', () => {
  const root = tmpRoot('empty-db');
  const dir = path.join(root, 'plain2');
  fs.mkdirSync(dir, { recursive: true });
  mkClaudeSource(root, 's4', J(dir));
  const file = mkClassicDb(dbAt(root), []);
  const r = importToMimo(root, ctxFor(root));
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, 'global');
  assert.ok(q(file, 'SELECT 1 FROM project WHERE id = ?', 'global')[0], '空库也要把 global 行建出来');
});

test('git 仓库没有 mimocode-project-id：生成并写进 <gitdir>，project 行同 id', (t) => {
  const root = tmpRoot('git-new-id');
  const repo = mkGitRepo(root, 'repo-a');
  if (!repo) return t.skip('本机没有 git');
  mkClaudeSource(root, 's2', J(repo));
  const file = mkClassicDb(dbAt(root), []);
  const r = importToMimo(root, ctxFor(root));

  const idFile = path.join(repo, '.git', 'mimocode-project-id');
  assert.ok(fs.existsSync(idFile), '必须按宿主契约生成 <gitdir>/mimocode-project-id');
  const fileId = fs.readFileSync(idFile, 'utf8').trim();
  assert.match(fileId, /^[0-9a-f-]{36}$/i, `文件里应是 uuid：${fileId}`);
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, fileId, 'session 必须挂到 id 文件里的那个 project');
  const proj = q(file, 'SELECT * FROM project WHERE id = ?', fileId)[0];
  assert.ok(proj, 'project 行必须真实存在');
  assert.equal(J(proj.worktree), J(repo), 'worktree 是仓库根');
});

test('git 仓库已有 mimocode-project-id：直接复用，不新增行', (t) => {
  const root = tmpRoot('git-reuse-id');
  const repo = mkGitRepo(root, 'repo-b');
  if (!repo) return t.skip('本机没有 git');
  fs.writeFileSync(path.join(repo, '.git', 'mimocode-project-id'), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n', 'utf8');
  mkClaudeSource(root, 's3', J(repo));
  const file = mkClassicDb(dbAt(root), [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', worktree: J(repo) }]);
  const r = importToMimo(root, ctxFor(root));

  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(q(file, 'SELECT COUNT(*) AS c FROM project')[0].c, 1, '不能重复插 project 行');
});

test('git 仓库：id 文件优先级高于 worktree 匹配（不能挂到旧行上）', (t) => {
  const root = tmpRoot('git-id-wins');
  const repo = mkGitRepo(root, 'repo-c');
  if (!repo) return t.skip('本机没有 git');
  fs.writeFileSync(path.join(repo, '.git', 'mimocode-project-id'), 'ffffffff-1111-2222-3333-444444444444\n', 'utf8');
  mkClaudeSource(root, 's5', J(repo));
  // 库里已有一条同 worktree 的旧行（旧实现会命中它）
  const file = mkClassicDb(dbAt(root), [{ id: 'proj-stale', worktree: J(repo) }]);
  const r = importToMimo(root, ctxFor(root));
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, 'ffffffff-1111-2222-3333-444444444444', `必须以 id 文件为准，实际 ${sess.project_id}`);
});

test('version 用宿主形态（库内已有 desktop-* 时跟着它），不再混入 session-sync/1', () => {
  const root = tmpRoot('version-shape');
  const dir = path.join(root, 'plain3');
  fs.mkdirSync(dir, { recursive: true });
  mkClaudeSource(root, 's6', J(dir));
  const file = mkClassicDb(dbAt(root), []);
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)').run(
    'ses_host',
    null,
    'h',
    'D:/work/h',
    '宿主会话',
    'desktop-3f9a1c2',
    1,
    2,
  );
  db.close();

  const r = importToMimo(root, ctxFor(root));
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.version, 'desktop-3f9a1c2', `导入行要用宿主的 version 形态，实际 ${sess.version}`);
  const back = readSession('mimo', ctxFor(root), r.targetId).session;
  assert.equal(back.origin?.variant, 'claude', JSON.stringify(back.origin));
});

test('生成的 mimocode-project-id 必须是 36 字节（uuid 原样，不带换行）', (t) => {
  const root = tmpRoot('git-id-bytes');
  const repo = mkGitRepo(root, 'repo-d');
  if (!repo) return t.skip('本机没有 git');
  mkClaudeSource(root, 's7', J(repo));
  mkClassicDb(dbAt(root), []);
  importToMimo(root, ctxFor(root));
  const idFile = path.join(repo, '.git', 'mimocode-project-id');
  const raw = fs.readFileSync(idFile);
  assert.equal(raw.length, 36, `宿主写的是 36 字节，实际 ${raw.length}：${JSON.stringify(raw.toString())}`);
  assert.match(raw.toString(), /^[0-9a-f-]{36}$/i);
});

test('目录里有 .git 但 git 读不动（safe.directory/损坏）→ 退回 global 并明写 warning', (t) => {
  const root = tmpRoot('git-broken');
  const dir = path.join(root, 'broken-repo');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true }); // 空 .git：git 会拒绝
  mkClaudeSource(root, 's8', J(dir));
  const file = mkClassicDb(dbAt(root), []);
  const plan = planImport(ctxFor(root), { from: ['claude'], into: ['mimo'] });
  const r = executePlan(ctxFor(root), plan, { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((r.warnings ?? []).some((w) => /mimo-git-unavailable/.test(String(w))), `必须明写警告：${JSON.stringify(r.warnings)}`);
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, 'global');
});

test('linked worktree：id 文件落在 common dir（宿主实测），不是 .git/worktrees/<name>', (t) => {
  const root = tmpRoot('git-worktree');
  const repo = mkGitRepo(root, 'repo-wt');
  if (!repo) return t.skip('本机没有 git');
  const commit = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, encoding: 'utf8' });
  if (commit.status !== 0) return t.skip('无法在临时仓库提交');
  const wt = path.join(root, 'repos', 'wt');
  const add = spawnSync('git', ['worktree', 'add', '-q', wt, '-b', 'feat'], { cwd: repo, encoding: 'utf8' });
  if (add.status !== 0) return t.skip('无法创建 linked worktree');

  mkClaudeSource(root, 's9', J(wt));
  const file = mkClassicDb(dbAt(root), []);
  const r = importToMimo(root, ctxFor(root));

  const commonIdFile = path.join(repo, '.git', 'mimocode-project-id');
  assert.ok(fs.existsSync(commonIdFile), `宿主把 id 文件放在 common dir：${commonIdFile}`);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'worktrees', 'wt', 'mimocode-project-id')), '不能写进 per-worktree 的 git dir（宿主不读那里）');
  const id = fs.readFileSync(commonIdFile, 'utf8').trim();
  const sess = q(file, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  assert.equal(sess.project_id, id, `会话要挂到 common dir 里的那个 project id，实际 ${sess.project_id}`);
});

test('共用插入机制：缺列的 project 表也能写（防御性，不代表任何一家的现网 schema）', () => {
  // 这条只锁 writers/project.mjs 的机械行为：按实际列集插、缺 worktree 列就放弃；
  // 现网 opencode/mimo 的 project 表都是宿主迁移建好的（实测列齐全），这里不是“修 bug”的证明。
  const root = tmpRoot('project-insert-unit');
  const file = path.join(root, 'slim.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)');
  db.exec('CREATE TABLE no_worktree (id TEXT PRIMARY KEY)');
  const okInsert = insertProjectRow(db, 'p1', 'D:/x', { name: 'x', vcs: 'git', timeActive: 1 });
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get('p1');
  db.exec('DROP TABLE project');
  db.exec('ALTER TABLE no_worktree RENAME TO project');
  const missInsert = insertProjectRow(db, 'p2', 'D:/y');
  db.close();
  assert.equal(okInsert, true);
  assert.equal(row.worktree, 'D:/x');
  assert.equal(missInsert, false, '没有 worktree 列时必须返回 false 交给调用方兜底');
});
