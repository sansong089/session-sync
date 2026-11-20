// M90 测试：WorkBuddy 项目会话必须挂到宿主 spaces 表的空间上
//
// 真机故障：新版 WorkBuddy 以 spaces 表表达「项目 = 空间」，侧栏项目页按会话行的
// space_id 过滤（宿主 matchesConversationFilter 的 spaceId 判据）。我们导入的项目
// 会话正文和 sessions 行都写对了，但 space_id 留 NULL → 不在任何项目下显示。
// 修复：按 cwd 认领宿主已登记且 active 的空间（cmpPath 统一斜杠/大小写）；
// 认不到仍留 NULL，由宿主按 legacy 处理；已有非空 space_id 绝不覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { upsertSessionIndex, createWorkbuddyWriter } from '../src/writers/workbuddy.mjs';

const UID = '928b817d-ec54-4b5b-baf4-3f7f47fa1860';
const SPACE = 'bb13e26c-90a7-4cbb-b116-a41dd185bb29';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m90-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function mkDb(root, { spaces = true, sessionsSpaceCol = true } = {}) {
  const file = path.join(root, '.workbuddy', 'workbuddy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity_at INTEGER,
    deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0${sessionsSpaceCol ? ', space_id TEXT' : ''})`);
  if (spaces) {
    db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, primary_folder_path TEXT,
      create_folder_path TEXT, status TEXT, deleted_at INTEGER)`);
    db.prepare('INSERT INTO spaces VALUES (?,?,?,?,?,?)').run(SPACE, 'demo', null, 'D:\\work\\demo', 'active', -1);
  }
  db.close();
  return file;
}
function rowOf(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}
function info(over = {}) {
  return { targetId: 'wb-1', cwd: 'D:/work/demo', title: '会话', scope: 'project', account: { id: UID }, ...over };
}

test('新建项目会话：cwd 命中 active 空间（斜杠方向不同也算）→ 写 space_id', () => {
  const root = tmpRoot('create');
  const file = mkDb(root);
  const out = upsertSessionIndex(ctxFor(root), 'workbuddy-cn', info());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(rowOf(file, 'wb-1').space_id, SPACE);
});

test('索引自愈：只补我们自己缺的 space_id，宿主已挂的空间不动', () => {
  const root = tmpRoot('heal');
  const file = mkDb(root);
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground, space_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('wb-null', 'D:/work/demo', UID, '旧导入', 'Completed', 1, 2, 0, null);
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground, space_id) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('wb-native', 'D:/work/demo', UID, '宿主原生', 'completed', 1, 2, 0, 'native-space');
  db.close();
  for (const id of ['wb-null', 'wb-native']) {
    const body = path.join(root, '.workbuddy', 'projects', 'x', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(body), { recursive: true });
    fs.writeFileSync(body, JSON.stringify({ type: 'session-meta', meta: { 'session-sync': { tool: 'session-sync', v: 1 } } }) + '\n');
  }

  for (const id of ['wb-null', 'wb-native']) {
    const out = upsertSessionIndex(ctxFor(root), 'workbuddy-cn', info({ targetId: id }));
    assert.equal(out.ok, true, JSON.stringify(out));
  }
  assert.equal(rowOf(file, 'wb-null').space_id, SPACE, '旧导入行要补上空间归属');
  assert.equal(rowOf(file, 'wb-native').space_id, 'native-space', '宿主已有的空间归属不得覆盖');
});

test('找不到空间 / 老库没有 spaces 表 / 非项目会话：保持 NULL 且不报错', () => {
  const a = tmpRoot('nomatch');
  const fa = mkDb(a);
  assert.equal(upsertSessionIndex(ctxFor(a), 'workbuddy-cn', info({ cwd: 'D:/elsewhere' })).ok, true);
  assert.equal(rowOf(fa, 'wb-1').space_id, null);

  const b = tmpRoot('nospaces');
  const fb = mkDb(b, { spaces: false });
  assert.equal(upsertSessionIndex(ctxFor(b), 'workbuddy-cn', info()).ok, true);
  assert.equal(rowOf(fb, 'wb-1').space_id, null);

  const c = tmpRoot('none');
  const fc = mkDb(c);
  assert.equal(upsertSessionIndex(ctxFor(c), 'workbuddy-cn', info({ scope: 'none' })).ok, true);
  assert.equal(rowOf(fc, 'wb-1').space_id, null);
});

test('repair 自愈：只给带 session-sync 标记的会话补 space_id，原生行不动', () => {
  const root = tmpRoot('repair');
  const file = mkDb(root);
  const db = new DatabaseSync(file);
  for (const id of ['ours', 'native']) {
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground, space_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, 'D:\\work\\demo', UID, id, 'completed', 1, 2, 0, null);
  }
  db.close();
  const body = path.join(root, '.workbuddy', 'projects', 'x', 'ours.jsonl');
  fs.mkdirSync(path.dirname(body), { recursive: true });
  fs.writeFileSync(body, JSON.stringify({ type: 'session-meta', meta: { 'session-sync': { tool: 'session-sync', v: 1 } } }) + '\n');
  fs.mkdirSync(path.join(root, '.workbuddy', 'storage', 'skeleton'), { recursive: true });
  fs.writeFileSync(path.join(root, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json'),
    JSON.stringify({ primary: { uid: UID } }));

  const out = createWorkbuddyWriter({ variant: 'workbuddy-cn' }).repair(ctxFor(root));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.spaceFixed, 1, JSON.stringify(out));
  assert.equal(rowOf(file, 'ours').space_id, SPACE);
  assert.equal(rowOf(file, 'native').space_id, null, '宿主原生行的 legacy NULL 不得改写');
});

test('旧版 WorkBuddy（无 spaces 表 / 无 space_id 列）端到端导入照常成功', () => {
  const root = tmpRoot('legacy-e2e');
  const wb = path.join(root, '.workbuddy');
  fs.mkdirSync(path.join(wb, 'storage', 'skeleton'), { recursive: true });
  fs.mkdirSync(path.join(wb, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(wb, 'storage', 'skeleton', 'account-snapshot.json'),
    JSON.stringify({ primary: { uid: UID, nickname: 'x' } }));
  const db = new DatabaseSync(path.join(wb, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT,
    custom_title TEXT, status TEXT NOT NULL DEFAULT 'Pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
    mode TEXT, model TEXT, transport TEXT NOT NULL DEFAULT 'local', unread INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL)');
  db.close();

  // 一条极简 claude 源会话
  const srcId = 'legacy-src-1';
  fs.mkdirSync(path.join(root, '.claude', 'projects', srcId), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'projects', srcId, `${srcId}.jsonl`),
    [{ parentUuid: null, type: 'user', sessionId: srcId, cwd: 'D:/work/demo', uuid: `${srcId}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: '旧版也要能导入' }] } }]
      .map((x) => JSON.stringify(x)).join('\n') + '\n');

  const ctx = ctxFor(root);
  const out = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'] }), { apply: true, lock: false });
  assert.equal(out[0]?.ok, true, JSON.stringify(out));

  const check = new DatabaseSync(path.join(wb, 'workbuddy.db'), { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'space_id'), false);
    assert.equal(check.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'spaces'), undefined);
    assert.ok(check.prepare('SELECT id FROM sessions WHERE id = ?').get(out[0].targetId), '索引行仍要写入');
  } finally {
    check.close();
  }
  const repaired = createWorkbuddyWriter({ variant: 'workbuddy-cn' }).repair(ctx);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.spaceFixed, 0, '旧库不该报空间自愈');
});

test('老库 sessions 表没有 space_id 列：写入照常成功（列裁剪）', () => {
  const root = tmpRoot('oldcol');
  const file = mkDb(root, { sessionsSpaceCol: false });
  const out = upsertSessionIndex(ctxFor(root), 'workbuddy-cn', info());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(rowOf(file, 'wb-1'));
});
