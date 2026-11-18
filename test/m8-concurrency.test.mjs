// M8 测试：宿主运行中导入的三项保障
//   1. WorkBuddy 索引表写入（UI 可见性）+ skip 自愈
//   2. 目标级跨进程锁（挡住我们自己的并发）
//   3. 宿主并发改动后的写前重校验 / 原子追加重试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { acquireLock, listLocks, lockPathFor } from '../src/lock.mjs';
import { appendJsonlRebuild, appendFileAtomic, writeFileAtomic } from '../src/writers/base.mjs';
import { getWriter } from '../src/writers/index.mjs';

const SRC_ID = 'eeeeeeee-1111-2222-3333-444444444444';

// 本文件默认也走独立锁目录；需要验证锁本身时再显式覆盖
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-conc-${name}-`));
}

function ctxFor(root, env = {}) {
  // 目标宿主（workbuddy-intl / pi）垫出配置根，否则被写门按 ghost 拦下
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } }),
    ['workbuddy-intl', 'pi'],
  );
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function makeClaudeSource(home) {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  writeJsonl(file, [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '第一轮回答' }] }, uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'u2', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:04.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
  ]);
  return file;
}

// 造一个与真实 WorkBuddy 同形的索引库（含一条既有会话，用于校验 user_id 继承）
function makeWorkbuddyDb(root) {
  const file = path.join(root, '.workbuddy-ai', 'workbuddy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT, custom_title TEXT,
    status TEXT NOT NULL DEFAULT 'Pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0,
    source_mode TEXT, is_background_automation INTEGER, mode TEXT, model TEXT,
    expert_id TEXT, expert_locale TEXT, expert_runtime_identity TEXT, expert_marketplace TEXT,
    permission_mode TEXT, use_sandbox_cli INTEGER, project_id TEXT, plugin_context_json TEXT,
    addon_selection TEXT, session_settings TEXT, last_user_prompt_expert_selection TEXT,
    context_window INTEGER, buddy_snapshot_id TEXT, buddy_binding_json TEXT, thought_level TEXT,
    transport TEXT NOT NULL DEFAULT 'local', conversation_origin TEXT, visibility TEXT, group_id TEXT,
    group_title TEXT, agent_dirty INTEGER, agent_dirty_at INTEGER, agent_last_synced INTEGER,
    verified_at INTEGER, unread INTEGER NOT NULL DEFAULT 0)`);
  db.prepare(
    `INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground, transport, unread)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('existing-1', 'C:/Users/x/WorkBuddy AI/p1', 'user-current-1234', '既有会话', 'Completed', 1790000000000, 1790000001000, 1, 'local', 0);
  db.close();
  return file;
}

test('WorkBuddy：导入后索引行存在（UI 可见），append 更新索引，skip 自愈缺失索引', () => {
  const home = tmpHome('wb-idx');
  makeClaudeSource(home);
  const dbFile = makeWorkbuddyDb(home);
  const ctx = ctxFor(home);

  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] }), { apply: true });
  const r = first[0];
  assert.equal(r.ok, true, JSON.stringify({ error: r.error, hint: r.hint }));
  assert.equal(r.index?.created, true, '应新建索引行');

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.targetId);
  assert.ok(row, '索引行必须存在');
  assert.equal(row.cwd, 'D:/work/demo');
  assert.equal(row.title, '第一轮问题');
  assert.equal(row.status, 'Completed');
  assert.equal(row.transport, 'local');
  assert.equal(row.unread, 0);
  // D3：uid 只认 account-snapshot；本 fixture 没有快照 → 落目标默认账号并明确告知
  assert.equal(row.user_id, 'local', '无 account-snapshot 时落目标默认账号，不再继承库里已有的 uid');
  assert.ok((r.warnings ?? []).some((w) => /account-snapshot-missing/.test(String(w))), JSON.stringify(r.warnings));
  assert.equal(row.is_playground, 0, '非 WorkBuddy 工作区应为 0');
  assert.ok(row.updated_at > 0);
  db.close();

  // 源新增一轮 → append，索引 updated_at 应前进
  const srcFile = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  const rows = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ parentUuid: 'a2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:09.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' });
  writeJsonl(srcFile, rows);

  const second = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] }), { apply: true });
  assert.equal(second[0].action, 'append');
  assert.equal(second[0].ok, true, JSON.stringify(second[0].error));

  // 删掉索引行，再跑一次（应 skip）→ 索引自愈
  const rw = new DatabaseSync(dbFile);
  rw.prepare('DELETE FROM sessions WHERE id = ?').run(r.targetId);
  rw.close();

  const third = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] }), { apply: true });
  assert.equal(third[0].action, 'skip');
  assert.equal(third[0].executed, false);

  const db2 = new DatabaseSync(dbFile, { readOnly: true });
  const healed = db2.prepare('SELECT id FROM sessions WHERE id = ?').get(r.targetId);
  assert.ok(healed, 'skip 分支应自愈索引行');
  db2.close();
});

test('WorkBuddy：uid 只认 account-snapshot，不再拿「最近改动的用户目录」推断（D3）', () => {
  const home = tmpHome('wb-uid');
  makeClaudeSource(home);
  const dbFile = makeWorkbuddyDb(home);
  const ctx = ctxFor(home);

  const USER_OLD = '11111111-1111-1111-1111-111111111111';
  const USER_NEW = '22222222-2222-2222-2222-222222222222';
  const SNAPSHOT_UID = '33333333-3333-3333-3333-333333333333';

  // 普通写入走 indexDbFile 指向的库（intl 变体）
  const rw = new DatabaseSync(dbFile);
  for (const [id, uid, ts] of [
    ['old-session', USER_OLD, 1780000000000],
    ['new-session', USER_NEW, 1785000000000],
  ]) {
    rw.prepare(
      `INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, is_playground, transport, unread)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, 'C:/old', uid, '既有会话', 'Completed', ts, ts + 1000, 0, 'local', 0);
  }
  rw.close();

  // 宿主的用户运行时目录：NEW 更晚 —— 旧的推断链会选它，但那套已被 D3 废弃
  const root = path.join(home, '.workbuddy-ai');
  fs.mkdirSync(path.join(root, USER_OLD), { recursive: true });
  fs.mkdirSync(path.join(root, USER_NEW), { recursive: true });
  fs.writeFileSync(path.join(root, USER_OLD, 'startup-route.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, USER_NEW, 'startup-route.json'), '{}', 'utf8');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(root, USER_OLD), past, past);

  // 1) 有 account-snapshot → 只认它（哪怕最近改动的目录是别人）
  const snap = path.join(root, 'storage', 'skeleton', 'account-snapshot.json');
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.writeFileSync(snap, JSON.stringify({ primary: { uid: SNAPSHOT_UID } }), 'utf8');
  const res = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] }), { apply: true, lock: false });
  assert.equal(res[0].ok, true, JSON.stringify(res[0].error));
  let db = new DatabaseSync(dbFile, { readOnly: true });
  let row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(res[0].targetId);
  db.close();
  assert.equal(row.user_id, SNAPSHOT_UID, '必须只认 account-snapshot 的 primary.uid');

  // 2) 快照缺失 → 落目标宿主默认账号并明说，绝不回头猜「最近用户目录」
  fs.unlinkSync(snap);
  const ir = readSession('claude', ctx, SRC_ID).session;
  const w = getWriter('workbuddy-intl');
  const w2 = w.write(ctx, { session: ir, targetId: 'fresh-target-1', mode: 'create', provenance: null });
  assert.equal(w2.ok, true, JSON.stringify(w2));
  db = new DatabaseSync(dbFile, { readOnly: true });
  row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('fresh-target-1');
  db.close();
  assert.equal(row.user_id, 'local', `无快照时用目标默认账号，实际 ${row.user_id}`);
  assert.notEqual(row.user_id, USER_NEW, '不得退回「最近改动的用户目录」那套推断');
  assert.ok((w2.warnings ?? []).some((w2w) => /account-snapshot-missing/.test(String(w2w))), JSON.stringify(w2.warnings));
});

test('WorkBuddy：索引库缺失时降级为警告，正文仍写入', () => {
  const home = tmpHome('wb-nodb');
  makeClaudeSource(home);
  const ctx = ctxFor(home); // 不建 workbuddy.db

  const res = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] }), { apply: true });
  const r = res[0];
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.path && fs.existsSync(r.path), 'jsonl 应写入');
  assert.ok((r.warnings ?? []).some((w) => w.includes('索引库不可用')), `应有索引降级警告，实际 ${JSON.stringify(r.warnings)}`);
});

test('锁目录可用 SESSION_SYNC_LOCK_DIR 隔离（并行测试文件互抢同一 key 会造成偶发假失败）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-iso-'));
  const prev = process.env.SESSION_SYNC_LOCK_DIR;
  process.env.SESSION_SYNC_LOCK_DIR = dir;
  try {
    assert.equal(path.dirname(lockPathFor('target:pi')), dir);
    const lk = acquireLock('target:iso', { timeoutMs: 100 });
    assert.ok(lk?.token, '隔离目录下应能取到锁');
    assert.equal(listLocks().some((l) => l.key === 'target:iso'), true);
    lk.release();
  } finally {
    // 恢复成文件级隔离目录（不能 delete：那会让后续用例落回 os.tmpdir 的公共锁目录）
    if (prev === undefined) delete process.env.SESSION_SYNC_LOCK_DIR;
    else process.env.SESSION_SYNC_LOCK_DIR = prev;
  }
  assert.equal(path.dirname(lockPathFor('target:pi')), process.env.SESSION_SYNC_LOCK_DIR, '后续用例仍应在文件级隔离目录里取锁');
});

test('目标级锁：被占用时返回 lock-timeout，释放后恢复', () => {
  const home = tmpHome('lock');
  makeClaudeSource(home);
  const ctx = ctxFor(home);
  // 锁 key 按目标变体固定，测试文件之间并行会互抢 → 用独立锁目录隔离
  process.env.SESSION_SYNC_LOCK_DIR = tmpHome('lockdir');
  try {
    // 同进程内锁是可重入的，所以这里手工造一个「另一个活进程持有」的锁文件
    const lockFile = lockPathFor('target:pi');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-process', key: 'target:pi', at: Date.now() }), 'utf8');
    assert.ok(listLocks().some((l) => l.key === 'target:pi' && l.alive), '应能看到锁');

    const blocked = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['pi'] }), { apply: true, lockTimeoutMs: 150 });
    assert.equal(blocked[0].ok, false);
    assert.equal(blocked[0].error, 'lock-timeout');
    assert.equal(blocked[0].executed, false);
    // 未写入
    assert.equal(listSessions('pi', ctx, {}).sessions.length, 0);

    fs.unlinkSync(lockFile);
    const ok = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['pi'] }), { apply: true, lockTimeoutMs: 2000 });
    assert.equal(ok[0].ok, true, JSON.stringify(ok[0].error));
  } finally {
    delete process.env.SESSION_SYNC_LOCK_DIR;
  }
});

test('同进程内锁可重入（避免嵌套调用死等）', () => {
  const a = acquireLock('target:reentrant', { timeoutMs: 500 });
  const b = acquireLock('target:reentrant', { timeoutMs: 500 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.reentrant, true);
  b.release();
  assert.ok(listLocks().some((l) => l.key === 'target:reentrant'), '外层仍持锁');
  a.release();
  assert.ok(!listLocks().some((l) => l.key === 'target:reentrant'), '全部释放');
});

test('陈旧锁可抢占：持有者进程已不存在时立即接管', () => {
  const home = tmpHome('stale');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 手工造一个「死进程」的锁：先放掉自己的（同进程重入不会碰锁文件，测不到抢占路径），
  // 再把锁文件改成死进程持有，下一次获取才走 EEXIST → 抢占
  const holder = acquireLock('target:claude', { timeoutMs: 1000 });
  assert.equal(holder.ok, true);
  const lockFile = holder.file;
  holder.release();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'dead', key: 'target:claude', at: Date.now() }), 'utf8');

  const taken = acquireLock('target:claude', { timeoutMs: 500 });
  assert.equal(taken.ok, true, '死进程的锁应被抢占');
  assert.equal(taken.contended, true, '碰过别人的锁必须留下竞争痕迹（import 据此作废锁内索引缓存）');
  taken.release();

  const quiet = acquireLock('target:claude', { timeoutMs: 500 });
  assert.equal(quiet.contended, false, '没人抢过就不算竞争，别白白重扫全库');
  quiet.release();
});

test('宿主并发改动：写前重校验识别出目标已被改写 → 分叉而非覆盖', () => {
  const home = tmpHome('revalidate');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['pi'] }), { apply: true });
  const piFile = first[0].path;

  // 源新增一轮
  const srcFile = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  const rows = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ parentUuid: 'a2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:09.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' });
  writeJsonl(srcFile, rows);

  // 先 plan（此时 action=append）
  const plan = planImport(ctx, { from: ['claude'], into: ['pi'] });
  assert.equal(plan.pairs[0].action, 'append');

  // 模拟宿主在 plan 之后改写了目标最后一轮
  const piRows = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastId = piRows[piRows.length - 1].id;
  piRows.push({ id: 'host-appended-1', parentId: lastId, type: 'message', timestamp: Date.now(), message: { role: 'assistant', content: [{ type: 'text', text: '宿主侧新增' }] } });
  writeJsonl(piFile, piRows);
  const hostLineCount = piRows.length;

  // 执行：锁内重校验发现内容已变 → fork（不覆盖宿主改动）
  const res = executePlan(ctx, plan, { apply: true });
  assert.equal(res[0].action, 'fork', `实际 ${res[0].action} (${res[0].reason})`);
  assert.notEqual(res[0].targetId, first[0].targetId);

  // 宿主改动的那份文件不被我们动过
  const after = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, hostLineCount);
});

test('陈旧计划安全：另一进程抢先完成后，旧计划执行时判为 skip 且不写入', () => {
  const home = tmpHome('target-ahead');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['pi'] }), { apply: true });
  const piFile = first[0].path;

  // 源新增一轮
  const srcFile = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  const rows = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ parentUuid: 'a2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:09.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' });
  writeJsonl(srcFile, rows);

  // 进程 A 拿到计划（此时 action=append）
  const stalePlan = planImport(ctx, { from: ['claude'], into: ['pi'] });
  assert.equal(stalePlan.pairs[0].action, 'append');

  // 进程 B 抢先完成同一件事
  const b = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['pi'] }), { apply: true });
  assert.equal(b[0].ok, true, JSON.stringify(b[0].error));
  const lineCountAfterB = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean).length;

  // 进程 A 用陈旧计划执行：锁内重校验应判 skip，不重复写
  const a = executePlan(ctx, stalePlan, { apply: true });
  assert.equal(a[0].executed, false);
  assert.equal(a[0].action, 'skip');
  assert.match(String(a[0].reason), /target-ahead|identical/);

  const after = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, lineCountAfterB, '陈旧计划不得再写入');
});

test('原子写与追加冲突重试', () => {
  const home = tmpHome('atomic');
  const file = path.join(home, 'a.jsonl');

  // 原子整写：内容完整
  writeFileAtomic(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  // 覆盖写不残留临时文件
  writeFileAtomic(file, '{"a":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n');
  assert.deepEqual(
    fs.readdirSync(home).filter((n) => n.includes('.tmp-')),
    [],
  );

  // expectSize 不匹配 → 抛 concurrent-modification
  const size = fs.statSync(file).size;
  fs.appendFileSync(file, '{"b":1}\n');
  assert.throws(() => appendFileAtomic(file, '{"c":1}\n', { expectSize: size }), /concurrent-modification/);

  // appendJsonlRebuild 自动重试并成功
  const res = appendJsonlRebuild(file, () => [{ d: 1 }]);
  assert.equal(res.lines, 1);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ a: 2 }, { b: 1 }, { d: 1 }]);
});
