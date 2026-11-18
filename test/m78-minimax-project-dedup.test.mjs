// M78 测试：minimax 项目键是**字节级**目录串 → 同一个目录不能建出两个项目行
//
// 真机样本（本机 runtime-state.sqlite）：
//   local_runtime_projects 有两行指向同一个目录：
//     project_id=7  workspace_dir="D:\02-mywork\session-sync"   ← 宿主自己建的（process.cwd() 形态）
//     project_id=16 workspace_dir="d:\02-mywork\session-sync"   ← 导入时照抄源 agent 的 cwd 建出来的
//   宿主的项目键两处都按字节相等比较：
//     - local_runtime_projects.workspace_dir 上有 UNIQUE 索引（仅 workspace 类）
//     - 触发器回填 project_id 用 `p.workspace_dir = NEW.project_workspace_dir`
//   → 大小写不同 = 两个项目 = 侧栏两个同名分组。
//
// 写侧的对策：落库前把目录对齐到**宿主已有的那一串**（精确命中 → 直接用；
// 忽略大小写/分隔符命中 → 用宿主那串），宿主没有对应行时才用磁盘真实大小写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { mkMinimaxDb as mkMinimaxDbAt } from './db-fixtures.mjs';
import { planImport, executePlan } from '../src/import.mjs';
// 命名空间导入：行为断言不依赖新导出（老代码上要能跑出「行为不对」而不是「导入就炸」）
import * as mmWriter from '../src/writers/minimax.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m78-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}
function mkMinimaxDb(root) {
  return mkMinimaxDbAt(path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'));
}
const all = (file, sql, ...args) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};

// 源会话（claude jsonl），cwd 由调用方给
function mkClaudeSource(root, id, cwd, texts = ['第一轮']) {
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

function importToMinimax(root) {
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['minimax'] });
  return { ctx, results: executePlan(ctx, plan, { apply: true, lock: false }) };
}

// 宿主自己建的会话（它在那个目录下开过会话）：模拟它记下的项目行
function seedHostProject(file, dir) {
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  const info = db.prepare(
    `INSERT INTO local_runtime_projects(project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms)
     VALUES ('workspace', ?, ?, ?, ?)`,
  ).run(dir, 1000, 1000, 1000);
  const pid = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO local_runtime_sessions(session_id, record_json, updated_at_ms, columnar_version, agent_name, runtime, session_type, status, archived, visibility, session_kind, workspace_dir, project_workspace_dir, is_default_workspace, title, created_at_ms, extra_data_json, project_id)
     VALUES ('host-native-1', '{}', 1000, 3, 'mavis', 'pi-agent', 'root', 'idle', 0, 'visible', 'conversation', ?, ?, 0, '宿主原生会话', 1000, '{}', ?)`,
  ).run(dir, dir, pid);
  db.exec('COMMIT');
  db.close();
  return pid;
}

test('fixture 必须带上宿主的部分唯一索引（项目键是字节级目录串）', () => {
  const root = tmpHome('fixture-index');
  const file = mkMinimaxDb(root);
  const idx = all(file, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='local_runtime_projects'").map((x) => x.name);
  assert.ok(idx.includes('idx_local_runtime_projects_workspace_v1'), `fixture 缺宿主的项目唯一索引：${idx.join(',')}`);
  assert.ok(idx.includes('idx_local_runtime_projects_one_default_v1'), `fixture 缺宿主的 default 唯一索引：${idx.join(',')}`);
});

test('落点大小写与宿主记的不一致时，必须并进宿主已有的项目行，不新建第二个', () => {
  const root = tmpHome('reuse');
  const file = mkMinimaxDb(root);
  // 真实目录（存在，canonical 形态可用）
  const realDir = path.join(root, 'work', 'demo-app');
  fs.mkdirSync(realDir, { recursive: true });
  // 宿主自己记的那一串：把盘符段写成大写（Windows 上同一个目录）
  const hostDir = process.platform === 'win32'
    ? realDir.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)
    : realDir.toUpperCase();
  const hostPid = seedHostProject(file, hostDir);

  // 源 agent 记的是另一种写法（小写盘符）
  const sourceDir = process.platform === 'win32'
    ? realDir.replace(/^([a-z]):/, (_, d) => `${d.toLowerCase()}:`)
    : realDir.toLowerCase();
  mkClaudeSource(root, 's1', sourceDir);
  const { results } = importToMinimax(root);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', results[0].targetId)[0];
  assert.equal(Number(row.project_id), hostPid, '必须挂到宿主已有的项目行，不能另起一行');
  assert.equal(row.project_workspace_dir, hostDir, '落库目录串必须复用宿主那一串');

  const wsRows = all(file, "SELECT * FROM local_runtime_projects WHERE project_kind = 'workspace'");
  assert.equal(wsRows.length, 1, `同一个目录只能有一行项目，实际 ${JSON.stringify(wsRows.map((r) => r.workspace_dir))}`);
});

test('两条大小写写法不同的会话只落一个项目行（重复项目 = 侧栏两个同名分组）', () => {
  const root = tmpHome('twowrites');
  const file = mkMinimaxDb(root);
  const realDir = path.join(root, 'work', 'demo-app');
  fs.mkdirSync(realDir, { recursive: true });
  const upper = realDir.toUpperCase();
  const lower = realDir.toLowerCase();

  mkClaudeSource(root, 's1', lower);
  mkClaudeSource(root, 's2', upper);
  const { results } = importToMinimax(root);
  assert.equal(results.length, 2, JSON.stringify(results));
  for (const r of results) assert.equal(r.ok, true, JSON.stringify(r));

  const wsRows = all(file, "SELECT * FROM local_runtime_projects WHERE project_kind = 'workspace'");
  assert.equal(wsRows.length, 1, `两条会话只能落一个项目行，实际 ${wsRows.length}：${JSON.stringify(wsRows.map((r) => r.workspace_dir))}`);
  const pids = new Set(results.map((r) => all(file, 'SELECT project_id FROM local_runtime_sessions WHERE session_id = ?', r.targetId)[0].project_id));
  assert.equal(pids.size, 1, '两条会话必须挂同一个 project_id');
});

test('宿主没有对应项目行时：按磁盘真实大小写建一行，且只有一行', () => {
  const root = tmpHome('fresh');
  const file = mkMinimaxDb(root);
  const realDir = path.join(root, 'work', 'new-project');
  fs.mkdirSync(realDir, { recursive: true });
  mkClaudeSource(root, 's1', realDir);
  const { results } = importToMinimax(root);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', results[0].targetId)[0];
  assert.ok(Number(row.project_id) > 0, '宿主触发器必须回填 project_id');
  const wsRows = all(file, "SELECT * FROM local_runtime_projects WHERE project_kind = 'workspace'");
  assert.equal(wsRows.length, 1, `只能建一行项目，实际 ${wsRows.length}`);
  assert.equal(wsRows[0].project_id, Number(row.project_id));
  assert.equal(wsRows[0].workspace_dir, row.project_workspace_dir, '项目行的目录串必须与会话行一致');
});

test('历史残留的重复项目行会被合并（同一个目录的两行 → 一行，会话改挂）', () => {
  const root = tmpHome('merge');
  const file = mkMinimaxDb(root);
  const realDir = path.join(root, 'work', 'demo-app');
  fs.mkdirSync(realDir, { recursive: true });

  // 模拟历史残留：同一目录被建了两行（大小写不同写法）
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  const a = Number(db.prepare(
    `INSERT INTO local_runtime_projects(project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms) VALUES ('workspace', ?, 1, 1, 1)`,
  ).run(realDir.toUpperCase()).lastInsertRowid);
  const b = Number(db.prepare(
    `INSERT INTO local_runtime_projects(project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms) VALUES ('workspace', ?, 1, 1, 1)`,
  ).run(realDir.toLowerCase()).lastInsertRowid);
  db.prepare(
    `INSERT INTO local_runtime_sessions(session_id, record_json, updated_at_ms, columnar_version, agent_name, runtime, session_type, status, archived, visibility, session_kind, workspace_dir, project_workspace_dir, is_default_workspace, title, created_at_ms, extra_data_json, project_id)
     VALUES ('dup-1', '{}', 1, 3, 'mavis', 'pi-agent', 'root', 'idle', 0, 'visible', 'conversation', ?, ?, 0, '重复行里的会话', 1, '{}', ?)`,
  ).run(realDir.toLowerCase(), realDir.toLowerCase(), b);
  db.exec('COMMIT');
  db.close();

  // 再导一条同目录的会话 → 写侧顺带把重复行并掉
  mkClaudeSource(root, 's1', realDir);
  const { results } = importToMinimax(root);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const wsRows = all(file, "SELECT * FROM local_runtime_projects WHERE project_kind = 'workspace'");
  assert.equal(wsRows.length, 1, `重复项目行必须被合并，实际 ${JSON.stringify(wsRows.map((r) => r.workspace_dir))}`);
  const keepId = wsRows[0].project_id;
  const moved = all(file, 'SELECT project_id FROM local_runtime_sessions WHERE session_id = ?', 'dup-1')[0];
  assert.equal(Number(moved.project_id), Number(keepId), '重复行里的会话必须改挂到保留行');
  assert.ok(
    (results[0].warnings ?? []).some((w) => String(w).startsWith('project-merged')),
    `必须报告合并动作：${JSON.stringify(results[0].warnings)}`,
  );
});

test('skip 分支的索引自愈会把历史残留的重复项目行合并掉', () => {
  const root = tmpHome('skip-heal');
  const file = mkMinimaxDb(root);
  const realDir = path.join(root, 'work', 'demo-app');
  fs.mkdirSync(realDir, { recursive: true });

  // 先正常导一条 → 落在宿主自己那行（这里先没有宿主行，于是新建一行）
  mkClaudeSource(root, 's1', realDir);
  const first = importToMinimax(root);
  assert.equal(first.results[0].ok, true, JSON.stringify(first.results[0]));

  // 模拟历史残留：另建一行同目录（大小写不同写法），把会话挪过去
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE');
  const dup = Number(db.prepare(
    `INSERT INTO local_runtime_projects(project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms) VALUES ('workspace', ?, 1, 1, 1)`,
  ).run(realDir.toLowerCase()).lastInsertRowid);
  db.prepare('UPDATE local_runtime_sessions SET workspace_dir = ?, project_workspace_dir = ?, project_id = ? WHERE session_id = ?')
    .run(realDir.toLowerCase(), realDir.toLowerCase(), dup, first.results[0].targetId);
  db.exec('COMMIT');
  db.close();

  // 重跑：内容没变 → skip 分支的索引自愈负责收拾
  const again = importToMinimax(root);
  assert.equal(again.results[0].action, 'skip', JSON.stringify(again.results[0]));

  const wsRows = all(file, "SELECT * FROM local_runtime_projects WHERE project_kind = 'workspace'");
  assert.equal(wsRows.length, 1, `重复项目行必须被合并，实际 ${JSON.stringify(wsRows.map((r) => r.workspace_dir))}`);
  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', first.results[0].targetId)[0];
  assert.equal(Number(row.project_id), Number(wsRows[0].project_id), '会话必须改挂到保留的项目行');
  assert.equal(row.workspace_dir, wsRows[0].workspace_dir, '会话的目录串必须与项目行一致');
  assert.ok(
    (again.results[0].warnings ?? []).some((w) => String(w).startsWith('project-merged')),
    `必须报告合并动作：${JSON.stringify(again.results[0].warnings)}`,
  );
});

test('canonicalWorkspaceDir：目录不存在时退回盘符大写形态，不抛错', () => {
  assert.equal(typeof mmWriter.canonicalWorkspaceDir, 'function', '写侧必须导出目录形态归一函数');
  const missing = path.join(os.tmpdir(), 'ss-m78-not-exist-xyz', 'nope');
  const out = mmWriter.canonicalWorkspaceDir(missing);
  assert.ok(out, '必须有兜底形态');
  if (process.platform === 'win32') {
    assert.match(out, /^[A-Z]:/, `盘符应大写：${out}`);
  }
  assert.equal(mmWriter.canonicalWorkspaceDir(''), '');
});

test('resolveWorkspaceDir：空目录返回空串，不产生项目行', () => {
  assert.equal(typeof mmWriter.resolveWorkspaceDir, 'function', '写侧必须导出项目行解析函数');
  const root = tmpHome('empty');
  const file = mkMinimaxDb(root);
  const db = new DatabaseSync(file);
  const out = mmWriter.resolveWorkspaceDir(db, '');
  db.close();
  assert.equal(out.dir, '');
  assert.equal(out.projectId, null);
});
