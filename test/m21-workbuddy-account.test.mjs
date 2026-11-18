// M21 测试：workbuddy 写侧账户归属（D3 的边界全在这几条上）
//
// 现网实测（cn）：库里数百行多数属旧登录账号（uuid 形态），而宿主登录态在
// `<root>/storage/skeleton/account-snapshot.json → primary.uid 是另一个 uuid`，
// 宿主列表谓词是 `user_id = 当前登录 uid` → 导入的行挂错 uid 就永远看不到。
// 结论（已写进记忆）：uid 唯一来源是 account-snapshot 的 primary.uid；
// 「有行才算」是循环论证 —— 刚登录的新账号本来就没有行。
//
// D3 边界：只改**我们自己写过的行**（正文首行带 session-sync 标记），
// 宿主原生行、其他账号的行一律不动；绝不做整库 UPDATE。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { getWriter } from '../src/writers/index.mjs';

const OLD_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m21-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}

const SESSION_COLS = `(id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT,
  created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
  is_playground INTEGER, transport TEXT, unread INTEGER, model TEXT, mode TEXT,
  source_mode TEXT, thought_level TEXT)`;

function makeIndexDb(root, rows = []) {
  const file = path.join(root, '.workbuddy', 'workbuddy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions ${SESSION_COLS}`);
  for (const r of rows) {
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, is_playground, transport, unread) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      r.id,
      r.cwd ?? '',
      r.user_id ?? OLD_UID,
      r.title ?? 'r',
      'Completed',
      1791484221000,
      1791484230000,
      1791484230000,
      r.is_playground ?? 0,
      'local',
      0,
    );
  }
  db.close();
  return file;
}

function writeSnapshot(root, uid) {
  const file = path.join(root, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ primary: { version: 1, uid, nickname: 'x', type: 'personal' } }), 'utf8');
}

/** 正文首行：带 / 不带 session-sync 标记 */
function writeBody(root, id, { ours }) {
  const slug = `--${String(NEW_UID).slice(0, 4)}--`;
  const file = path.join(root, '.workbuddy', 'projects', slug, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const meta = {
    type: 'session-meta',
    id,
    cwd: '',
    timestamp: '2026-10-08T18:38:21.000Z',
    meta: ours ? { 'codebuddy.ai/hostKind': 'unopted', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: 'x' } } } : { 'codebuddy.ai/hostKind': 'unopted' },
  };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n', 'utf8');
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

/** claude 源会话（两行一条消息流） */
function mkClaudeSource(root, id, cwd) {
  fs.mkdirSync(path.join(root, '.claude', 'projects', id), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'projects', id, `${id}.jsonl`),
    [
      { parentUuid: null, type: 'user', sessionId: id, cwd, uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: '甲' }] } },
      { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '乙' }] } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n',
    'utf8',
  );
}

test('新行的 uid 只取 account-snapshot 的 primary.uid（不再用「有行才算」那套）', () => {
  const root = tmpRoot('uid-snapshot');
  makeIndexDb(root); // 库里只有旧 uid 的行
  writeSnapshot(root, NEW_UID);
  mkClaudeSource(root, 'sa', 'D:/work/demo');
  const file = path.join(root, '.workbuddy', 'workbuddy.db');

  const ctx = ctxFor(root);
  const imported = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'] }), { apply: true, lock: false });
  assert.equal(imported[0].ok, true, JSON.stringify(imported[0]));
  const row = rowOf(file, imported[0].targetId);
  assert.equal(row.user_id, NEW_UID, `必须落到当前登录 uid，实际 ${row.user_id}`);
});

test('只改标我们自己写过的行；宿主原生行与其他账号的行 uid 一律不动', () => {
  const root = tmpRoot('uid-retag');
  const file = makeIndexDb(root, [
    { id: 'row-ours', cwd: 'D:/work/old', user_id: OLD_UID },
    { id: 'row-native', cwd: 'D:/work/other', user_id: OLD_UID },
    { id: 'row-third', cwd: 'D:/work/third', user_id: '11111111-2222-3333-4444-555555555555' },
  ]);
  writeBody(root, 'row-ours', { ours: true });
  writeBody(root, 'row-native', { ours: false });
  writeSnapshot(root, NEW_UID);

  const out = getWriter('workbuddy-cn').repair(ctxFor(root));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(rowOf(file, 'row-ours').user_id, NEW_UID, '我们写的行要改到当前登录 uid');
  assert.equal(rowOf(file, 'row-native').user_id, OLD_UID, '宿主原生行绝不能改标');
  assert.equal(rowOf(file, 'row-third').user_id, '11111111-2222-3333-4444-555555555555', '别人账号的行也不许动');
  assert.ok(out.retagged >= 1, JSON.stringify(out));
});

test('--account 覆盖 snapshot（多账号机器）', () => {
  const root = tmpRoot('uid-flag');
  const file = makeIndexDb(root);
  writeSnapshot(root, NEW_UID);
  mkClaudeSource(root, 'sb', 'D:/work/demo');
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'], account: 'uid-from-flag' }), { apply: true, lock: false });
  assert.equal(r[0].ok, true, JSON.stringify(r[0]));
  assert.equal(rowOf(file, r[0].targetId).user_id, 'uid-from-flag');
});

test('is_playground 按 scope 决定，不再猜目录名', () => {
  const root = tmpRoot('playground');
  const file = makeIndexDb(root);
  writeSnapshot(root, NEW_UID);
  const bucketCwd = path.join(root, 'WorkBuddy', '2026-10-08-18-38-21');
  const mk = (id, cwd) => mkClaudeSource(root, id, cwd);
  mk('s-none', bucketCwd);
  mk('s-proj', 'D:/00-work/code/demo-app');
  const ctx = ctxFor(root);
  const rs = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'] }), { apply: true, lock: false });
  const bySrc = Object.fromEntries(rs.map((x) => [x.sourceId, x]));
  assert.equal(bySrc['s-none'].ok, true, JSON.stringify(bySrc['s-none']));
  assert.equal(rowOf(file, bySrc['s-none'].targetId).is_playground, 1, 'scope=none → is_playground=1');
  assert.equal(rowOf(file, bySrc['s-proj'].targetId).is_playground, 0, '项目会话必须是 0');
});

test('uid 与库里多数行不一致时出 account-mismatch 提示（含计数）', () => {
  const root = tmpRoot('mismatch');
  makeIndexDb(root, [
    { id: 'row-ours', user_id: OLD_UID },
    { id: 'row-native', user_id: OLD_UID },
    { id: 'row-native2', user_id: OLD_UID },
  ]);
  writeBody(root, 'row-ours', { ours: true });
  writeBody(root, 'row-native', { ours: false });
  writeBody(root, 'row-native2', { ours: false });
  writeSnapshot(root, NEW_UID);

  const out = getWriter('workbuddy-cn').repair(ctxFor(root));
  const hint = (out.warnings ?? []).find((w) => /account-mismatch/.test(String(w)));
  assert.ok(hint, JSON.stringify(out));
  assert.match(hint, /2\s*行未动/, `要写清「我们改标 1 行 / 宿主原生 2 行未动」：${hint}`);
});

test('snapshot 缺失时退回原推断并在 warnings 里说明（不能凭空造 uid）', () => {
  const root = tmpRoot('no-snapshot');
  makeIndexDb(root, [{ id: 'row-old', user_id: OLD_UID }]);
  mkClaudeSource(root, 'sc', 'D:/work/demo');
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'] }), { apply: true, lock: false });
  assert.equal(r[0].ok, true, JSON.stringify(r[0]));
  const warns = (r[0].warnings ?? []).concat(r[0].index?.warnings ?? []);
  assert.ok(warns.some((w) => /account-snapshot-missing/.test(String(w))), JSON.stringify(r[0]));
});
