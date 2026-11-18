// M63 测试：索引 INSERT 按库里实际存在的列裁剪（老版本库不再整条失败）
//
// 症状：workbuddy 索引行写不进去（index-write-failed），宿主的会话列表里看不到这条会话。
// 根因：宿主的 sessions 表是「baseline 建表 + 后续 ALTER TABLE ADD COLUMN」长出来的，
// 而我们 INSERT 硬编码的列有一半是后加的 —— baseline 里没有。
//
// 取证（宿主 app.asar 内嵌的迁移 SQL，/main/database-factory.js 的 P 表）：
//   baseline（20260626034403_0000_workbuddy_sqlite_baseline）建的 sessions 列：
//     id, cwd, user_id, title, custom_title, status, created_at, updated_at,
//     last_activity_at, deleted_at, is_playground, source_mode, is_background_automation,
//     mode, model, expert_id, expert_locale, expert_runtime_identity, expert_marketplace,
//     permission_mode, use_sandbox_cli, project_id
//   我们 INSERT 用到的 transport / unread 是 0013 加的，thought_level 是 0008 加的 ——
//   老版本库的表里没有这三列，硬编码 INSERT 直接整条报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { upsertSessionIndex } from '../src/writers/workbuddy.mjs';
import { makeCtx } from '../src/hosts.mjs';
import { parseDataRoots } from '../src/roots.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m63-${name}-`));
}

/** 宿主 baseline 版的 sessions 表（逐字照抄宿主内嵌迁移 SQL 的 DDL） */
const BASELINE_DDL = `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT,
    custom_title TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER,
    deleted_at INTEGER,
    is_playground INTEGER NOT NULL DEFAULT 0,
    source_mode TEXT,
    is_background_automation INTEGER,
    mode TEXT,
    model TEXT,
    expert_id TEXT,
    expert_locale TEXT,
    expert_runtime_identity TEXT,
    expert_marketplace TEXT,
    permission_mode TEXT,
    use_sandbox_cli INTEGER,
    project_id TEXT
)`;

function makeCtxFor(home) {
  return makeCtx({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    env: {},
    dataRoots: parseDataRoots(`workbuddy-cn=${path.join(home, '.workbuddy')}`),
  });
}

test('老版本库（缺 transport/unread/thought_level）：索引行仍能新建', () => {
  const home = tmpHome('baseline');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(BASELINE_DDL);
    db.close();

    const r = upsertSessionIndex(makeCtxFor(home), 'workbuddy-cn', {
      targetId: 's1', title: '新会话', cwd: 'D:/w', scope: 'project', model: null,
      createdAt: 111, updatedAt: 222,
    });
    assert.equal(r.ok, true, `老库上也必须写成功：${r.error ?? ''}`);
    assert.equal(r.created, true);

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, is_playground FROM sessions WHERE id = ?').get('s1');
    db2.close();
    assert.equal(row.id, 's1');
    assert.equal(row.title, '新会话');
    assert.equal(row.cwd, 'D:/w');
    assert.equal(row.status, 'Completed');
    assert.equal(row.created_at, 111);
    assert.equal(row.updated_at, 222);
    assert.equal(row.is_playground, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('老版本库：缺失的列不该被写进去（也没法写）', () => {
  const home = tmpHome('baseline-cols');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(BASELINE_DDL);
    db.close();

    upsertSessionIndex(makeCtxFor(home), 'workbuddy-cn', {
      targetId: 's1', title: '新会话', cwd: 'D:/w', scope: null, model: 'gpt',
      createdAt: 1, updatedAt: 2,
    });

    const db2 = new DatabaseSync(dbFile);
    const cols = db2.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    const row = db2.prepare('SELECT model, source_mode, mode FROM sessions WHERE id = ?').get('s1');
    db2.close();
    for (const c of ['transport', 'unread', 'thought_level']) {
      assert.equal(cols.includes(c), false, `${c} 不在 baseline 表里，不该被凭空建出来`);
    }
    assert.equal(row.model, 'gpt', 'baseline 里有的列照常写');
    assert.equal(row.source_mode, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('新版本库（40 列全在）：列与值一一对应，不串位', () => {
  const home = tmpHome('full');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    // 真机库的列（app.asar 取证：40 列）—— 缺的列多一个，串位就更容易发生
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT, status TEXT,
      created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
      is_playground INTEGER, model TEXT, mode TEXT, source_mode TEXT, thought_level TEXT,
      transport TEXT, unread INTEGER, is_background_automation INTEGER, expert_id TEXT,
      expert_locale TEXT, project_id TEXT, visibility TEXT, group_title TEXT)`);
    db.close();

    const r = upsertSessionIndex(makeCtxFor(home), 'workbuddy-cn', {
      targetId: 's1', title: '新会话', cwd: 'D:/w', scope: 'none', model: 'gpt',
      createdAt: 111, updatedAt: 222,
    });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
    db2.close();
    assert.equal(row.title, '新会话');
    assert.equal(row.created_at, 111, 'created_at 不能串到别的列');
    assert.equal(row.updated_at, 222);
    assert.equal(row.last_activity_at, 222);
    assert.equal(row.deleted_at, null);
    assert.equal(row.is_playground, 1, "scope='none' → is_playground=1");
    assert.equal(row.transport, 'local');
    assert.equal(row.unread, 0);
    assert.equal(row.model, 'gpt');
    assert.equal(row.mode, null);
    assert.equal(row.source_mode, null);
    assert.equal(row.thought_level, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('已有行：索引自愈在老库上也只更新 baseline 里有的列', () => {
  const home = tmpHome('baseline-update');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec(BASELINE_DDL);
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground) VALUES (?,?,?,?,?,?,?,?)')
      .run('s1', 'D:/old', 'u1', '目标自己的标题', 'Completed', 1, 2, 0);
    db.close();

    const r = upsertSessionIndex(makeCtxFor(home), 'workbuddy-cn', {
      targetId: 's1', title: '源侧标题', cwd: 'D:/new', scope: null, model: null,
      createdAt: 1, updatedAt: 3,
    });
    assert.equal(r.ok, true, `老库上也必须成功：${r.error ?? ''}`);
    assert.equal(r.created, false);

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT cwd, title FROM sessions WHERE id = ?').get('s1');
    db2.close();
    assert.equal(row.cwd, 'D:/new', 'cwd 要更新');
    assert.equal(row.title, '目标自己的标题', '标题不由索引自愈负责（drift 通道的事）');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
