// M41 测试：账户归属必须是标量，写进库里的 user_id 不能是 "[object Object]"
//
// IR 里 account 是会话属性 `{variant, id, name?, orgId?}`（也可能来自 --account 的裸字符串）。
// workbuddy 的 pickUserId 以前直接 `String(account)`：源会话带对象时，
// 索引行的 user_id 就被写成 "[object Object]" —— 宿主谓词是 `user_id = 当前登录 uid`，
// 这条会话永远不会出现在列表里，而且没有任何报错。
// 规则：标量抽取只有一个地方做（accountIdOf），抽不出 id 就拒绝写索引，绝不写垃圾值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { accountIdOf } from '../src/placement.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { makeSession, messageItem } from '../src/ir.mjs';

const T0 = 1791484221000;
const SNAP_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m41-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function session(variant, account) {
  return makeSession({
    id: 's1', variant, title: '带账户的会话', cwd: 'D:/work/demo',
    createdAt: T0, updatedAt: T0 + 9000, model: 'm-1', account,
    turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '问1', T0), messageItem('assistant', '答1', T0)] }],
    meta: {},
  });
}
function makeIndexDb(root) {
  const file = path.join(root, '.workbuddy', 'workbuddy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT,
    created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
    is_playground INTEGER, transport TEXT, unread INTEGER, model TEXT, mode TEXT,
    source_mode TEXT, thought_level TEXT)`);
  db.close();
  return file;
}
function userIdOf(file, id) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id)?.user_id ?? null;
  } finally {
    db.close();
  }
}
function snapshotOf(root) {
  const file = path.join(root, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ primary: { uid: SNAP_UID } }), 'utf8');
}

test('accountIdOf：字符串 / {id} / {uid} 都降成标量，抽不出 id 就是 null', () => {
  assert.equal(accountIdOf('user-abc'), 'user-abc');
  assert.equal(accountIdOf({ variant: 'claude', id: 'u-777', name: 'n', orgId: null }), 'u-777');
  assert.equal(accountIdOf({ uid: 'snap-uid' }), 'snap-uid');
  assert.equal(accountIdOf({}), null);
  assert.equal(accountIdOf(null), null);
  assert.equal(accountIdOf(undefined), null);
  assert.equal(accountIdOf(''), null, '空串不是账户');
});

test('workbuddy：源账户是对象时，索引行 user_id 写它的 id，不是 [object Object]', () => {
  const root = tmpRoot('wb-object-account');
  snapshotOf(root);
  makeIndexDb(root);
  const ctx = ctxFor(root);
  const w = getWriter('workbuddy-cn');
  const r = w.write(ctx, {
    session: session('claude', { variant: 'claude', id: 'u-777', name: null, orgId: null }),
    targetId: 't-obj', mode: 'create', provenance: null, force: true,
    account: { variant: 'claude', id: 'u-777', name: null, orgId: null },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const uid = userIdOf(path.join(root, '.workbuddy', 'workbuddy.db'), 't-obj');
  assert.equal(uid, 'u-777', `user_id 必须是账户 id，实际：${JSON.stringify(uid)}`);
});

test('workbuddy：抽不出 id 的账户对象 → 拒绝写索引，不落垃圾值', () => {
  const root = tmpRoot('wb-bad-account');
  snapshotOf(root);
  const dbFile = makeIndexDb(root);
  const ctx = ctxFor(root);
  const w = getWriter('workbuddy-cn');
  const r = w.write(ctx, { session: session('claude', null), targetId: 't-junk', mode: 'create', provenance: null, force: true, account: { note: '没有 id 字段' } });
  assert.equal(r.ok, false, `必须拒绝，实际 ${JSON.stringify(r)}`);
  assert.match(String(r.error), /account/, `错误码要说明是账户问题：${r.error}`);
  assert.equal(userIdOf(dbFile, 't-junk'), null, '拒绝时不能留下索引行');
});
