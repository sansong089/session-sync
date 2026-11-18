// m71 — zcode 读侧的项目名索引必须按 (workspace_key, task_id) 复合主键
//
// tasks 的主键是 (workspace_key, task_id)。读侧曾只拿 task_id 当 Map 键，
// 于是同一个 task_id 落在两个 workspace 下时，后读到的行会覆盖前一行 ——
// 会话被标上**另一个项目**的名字。写侧早就按复合键定位了（keyWhereOf），
// 读侧漏了这半边，两侧口径不对称。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { mkZcodeDb } from './db-fixtures.mjs';

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m71-${tag}-`));
}

function ctxFor(home) {
  return makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: {} });
}

/**
 * 造一个 zcode 沙箱：一条会话（目录 D:/ws-a）+ 两个 workspace 下的同 id 任务行。
 * 两个 workspace 指向**不同**项目，谁被覆盖就说明索引退化成单键了。
 */
function makeFixture({ tasks }) {
  const home = tmpRoot('zcode');
  const zhome = path.join(home, 'zc');
  const cliFile = path.join(zhome, 'cli', 'db', 'db.sqlite');
  const idxFile = path.join(zhome, 'v2', 'tasks-index.sqlite');
  mkZcodeDb(cliFile, idxFile);

  const cli = new DatabaseSync(cliFile);
  cli
    .prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)')
    .run('sess_x', 'dirhash', 'a', 'D:/ws-a', '会话 X', '1', 1, 1);
  cli.close();

  const idx = new DatabaseSync(idxFile);
  const project = idx.prepare('INSERT INTO projects (project_id, host_id, name, created_at, updated_at) VALUES (?,?,?,?,?)');
  project.run('pa', 'local', 'A项目', 1, 1);
  project.run('pb', 'local', 'B项目', 1, 1);
  const task = idx.prepare('INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, project_id) VALUES (?,?,?,?,?,?,?)');
  for (const t of tasks) task.run(t.ws, t.ws, t.id, '会话 X', 1, 1, t.project);
  idx.close();

  return { home, zhome };
}

function rowOfId(home, zhome, id) {
  const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: { ZCODE_HOME: zhome } });
  const r = listSessions('zcode', ctx, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const row = r.sessions.find((s) => s.id === id);
  assert.ok(row, `会话 ${id} 必须被列出`);
  return row;
}

test('同一 task_id 出现在两个 workspace 下时，按会话自己的目录取项目名（不许被覆盖）', () => {
  // 插入顺序刻意让「别人的」那一行在后面：单键索引下它必然覆盖前一行
  const { home, zhome } = makeFixture({
    tasks: [
      { ws: 'D:/ws-a', id: 'sess_x', project: 'pa' },
      { ws: 'D:/ws-b', id: 'sess_x', project: 'pb' },
    ],
  });
  try {
    const row = rowOfId(home, zhome, 'sess_x');
    assert.equal(row.projectName, 'A项目', `会话在 D:/ws-a 下，项目名不能串成别人的：${row.projectName}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('task_id 全局唯一时，单键兜底照旧生效（不是只认复合键）', () => {
  const { home, zhome } = makeFixture({
    tasks: [{ ws: 'D:/ws-other', id: 'sess_x', project: 'pb' }],
  });
  try {
    // workspace_key 与会话目录不一致（宿主搬迁过工作区）：复合键落空，靠单键兜底
    const row = rowOfId(home, zhome, 'sess_x');
    assert.equal(row.projectName, 'B项目', '唯一命中时必须给出项目名，不能因为复合键落空就丢');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('task_id 有歧义（跨 workspace 指向不同项目）且目录对不上时，宁可不给名字也不猜', () => {
  const { home, zhome } = makeFixture({
    tasks: [
      { ws: 'D:/ws-b', id: 'sess_x', project: 'pb' },
      { ws: 'D:/ws-c', id: 'sess_x', project: 'pa' },
    ],
  });
  try {
    const row = rowOfId(home, zhome, 'sess_x');
    // 两条都不在会话目录下：单键有歧义 → 不许随便挑一个当项目名
    assert.ok(
      row.projectName === '' || row.projectName === null,
      `有歧义时不许猜项目名，实际给出：${row.projectName}`,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
