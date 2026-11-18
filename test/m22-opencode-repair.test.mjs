// M22 测试：opencode 自愈要把「挂错目录的历史导入行」搬到正确落点（计划改动清单 8）
//
// 现网成因（实测）：早期版本把 WorkBuddy 的沙箱目录（`~/WorkBuddy AI/<leaf>`）原样写进
// session_v2.directory，OpenCode 的 TUI 按 (project_id, path) 精确过滤 → 这些行既不在项目下、
// 也不在「无项目」视图里，等于看不见；同时在 project 表里留下幽灵项目行。
// 修法：对**我们写过的行**（version='session-sync/1' 或 metadata 带 session-sync）重算 placement，
// 目录命中宿主自管根 → 换成该目标的非项目桶；搬完不再命中谓词 → 天然幂等。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx, bucketRoot } from '../src/hosts.mjs';
import { opencodeWriter, resolveProjectID, canonicalDirectory } from '../src/writers/opencode.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m22-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.close();
  return file;
}

const TS = 1792635493378;

function insertRow(file, row) {
  const db = new DatabaseSync(file);
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?)`,
  ).run(row.id, row.project_id, row.slug ?? 'x', row.directory, row.path ?? null, row.title ?? '导入会话', row.version, row.agent ?? 'build', row.model ?? null, TS, TS);
  db.close();
}

const rowOf = (file, id) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(id);
  } finally {
    db.close();
  }
};

test('挂在工作区沙箱目录的导入行，要搬到 OpenCode 的非项目桶并可被宿主查询列出', () => {
  const home = tmpHome('ghost');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ghost = path.join(home, 'WorkBuddy AI', '2026-10-08-18-38-21');
  insertRow(file, { id: 'ses_e1729a950ffeGhost000000001', project_id: 'bogus', directory: ghost.replace(/\\/g, '/'), version: 'session-sync/1' });

  const out = opencodeWriter.repair(ctxFor(home, { OPENCODE_DATA_DIR: dataDir }));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.dirFixed >= 1, JSON.stringify(out));

  const row = rowOf(file, 'ses_e1729a950ffeGhost000000001');
  const want = canonicalDirectory(bucketRoot(ctxFor(home), 'opencode'));
  assert.equal(row.directory, want, `directory 必须换成 opencode 的非项目桶根：${row.directory}`);
  const project = resolveProjectID(want);
  assert.equal(row.project_id, project.id, 'project_id 必须随 directory 重算');
  assert.equal(row.path, project.subpath, 'path 必须是相对 worktree 的子路径');

  // 宿主可见性：TUI 的过滤谓词
  const db = new DatabaseSync(file, { readOnly: true });
  const visible = db.prepare('SELECT id FROM session_v2 WHERE project_id = ? AND path = ? AND parent_id IS NULL').all(project.id, project.subpath);
  db.close();
  assert.deepEqual(visible.map((v) => v.id), [row.id]);
});

test('搬迁幂等：第二次自愈没有可改的东西', () => {
  const home = tmpHome('idem');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  insertRow(file, {
    id: 'ses_ghost2',
    project_id: 'bogus',
    directory: path.join(home, 'Documents', 'Codex', '2026-10-15', 'abc').replace(/\\/g, '/'),
    version: 'session-sync/1',
  });
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  opencodeWriter.repair(ctx);
  const again = opencodeWriter.repair(ctx);
  assert.equal(again.dirFixed, 0, JSON.stringify(again));
  assert.equal(again.projectFixed, 0, JSON.stringify(again));
});

test('只搬我们写过的行：真实项目的导入行按原目录，宿主原生行绝不碰', () => {
  const home = tmpHome('keep');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const proj = 'D:/00-work/code/demo-app';
  insertRow(file, { id: 'ses_e1729a950ffeProj0000000001', project_id: 'p1', directory: proj, version: 'session-sync/1' });
  insertRow(file, { id: 'ses_native', project_id: 'p2', directory: path.join(home, 'WorkBuddy', 'x').replace(/\\/g, '/'), version: '2.1.4' });

  opencodeWriter.repair(ctxFor(home, { OPENCODE_DATA_DIR: dataDir }));
  assert.equal(rowOf(file, 'ses_e1729a950ffeProj0000000001').directory, proj, '项目导入行的目录不能被改判');
  assert.equal(rowOf(file, 'ses_native').directory, path.join(home, 'WorkBuddy', 'x').replace(/\\/g, '/'), '宿主原生行绝不能搬');
});
