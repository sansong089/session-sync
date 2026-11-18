// M50 测试：CodeBuddy IDE 的跨账号切换（唯一「项目也按账号分区」的一家）
//
// 现场事实（2026-10-30 实测）：`Data/<user>/<ide>/<uid>/history/<md5(cwd)>/<convId>/`，
// 同一 `<md5>/<convId>` 坐标还出现在 `check-point/`、`file-tree/`、`plan-task/` 三个平行目录；
// 两个账号的 md5 集合几乎不相交 ⇒ 只改账号字段不够，必须像导入那样把项目目录补出来。
// 这里的工作区 key 用 crypto 独立算（不调 codebuddyWorkspaceKey），免得和实现共谋。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCtx } from '../src/hosts.mjs';
import { planSwitch, executeSwitch } from '../src/switch.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { codebuddyIdeWriter } from '../src/writers/codebuddy-ide.mjs';

const A_UID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_UID = 'bbbbbbbb-2222-4222-8222-222222222222';
const IDE = 'CodeBuddyIDE';

// 宿主公式：md5(normalize(路径))，路径取宿主自己的 URI 形态（盘符小写）—— 真机 60 个
// history 目录里 58 个逐字相等（详见 test/m49-codebuddy-ide.test.mjs 的同款转写与证据）。
// 独立转写，不用被测模块的函数。
const wsKey = (cwd) =>
  crypto
    .createHash('md5')
    .update(path.normalize(String(cwd).replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`)))
    .digest('hex');

function tmpHome(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m50-${name}-`));
  return root;
}
function ctxFor(root) {
  const data = path.join(root, 'AppData', 'Local', 'CodeBuddyExtension', 'Data');
  fs.mkdirSync(data, { recursive: true });
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: {} });
}
function dataRoot(ctx) {
  return path.join(ctx.localAppData, 'CodeBuddyExtension', 'Data');
}

/** 账号目录坐标（宿主两处同名 uid：外层 user 与内层 uid） */
function accountDir(ctx, uid, kind = 'history') {
  return path.join(dataRoot(ctx), uid, IDE, uid, kind);
}

/**
 * 造一条会话：history/<md5>/index.json + <convId>/index.json + messages/*.json
 * companions = ['check-point','file-tree','plan-task'] 时同坐标各放一个文件
 */
function seedConversation(ctx, { uid, cwd, convId, turns = 2, withCompanions = false, provenance = false }) {
  const key = wsKey(cwd);
  const wsDir = path.join(accountDir(ctx, uid), key);
  const conv = path.join(wsDir, convId);
  fs.mkdirSync(path.join(conv, 'messages'), { recursive: true });
  const messages = [];
  for (let i = 0; i < turns; i++) {
    for (const role of ['user', 'assistant']) {
      const id = `${convId}-${role}-${i}`;
      const blocks = role === 'user'
        ? [{ type: 'text', text: i === 0 ? `<user_info>\nWorkspace Folder: ${cwd}\n</user_info>\n\n问 ${i}` : `问 ${i}` }]
        : [{ type: 'text', text: `答 ${i}` }];
      fs.writeFileSync(path.join(conv, 'messages', `${id}.json`), JSON.stringify({ role, message: JSON.stringify({ role, content: blocks }), id, extra: JSON.stringify({ requestId: `r${i}`, modelId: 'm' }) }), 'utf8');
      messages.push({ id, type: 'text', role, isComplete: true });
    }
  }
  fs.writeFileSync(path.join(conv, 'index.json'), JSON.stringify({ messages, requests: [] }), 'utf8');
  if (provenance) {
    fs.writeFileSync(path.join(conv, 'index.json.session-sync.json'), JSON.stringify({ tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: convId } }), 'utf8');
  }
  const wsIndexFile = path.join(wsDir, 'index.json');
  const prev = fs.existsSync(wsIndexFile) ? JSON.parse(fs.readFileSync(wsIndexFile, 'utf8')) : { conversations: [], current: '' };
  prev.conversations = (prev.conversations ?? []).filter((c) => String(c.id) !== convId);
  prev.conversations.push({ id: convId, type: 'craft', name: `会话 ${convId}`, createdAt: '2026-10-01T00:00:00.000Z', lastMessageAt: '2026-10-02T00:00:00.000Z' });
  prev.current = convId;
  fs.writeFileSync(wsIndexFile, JSON.stringify(prev), 'utf8');
  if (withCompanions) {
    for (const kind of ['check-point', 'file-tree', 'plan-task']) {
      const dir = path.join(accountDir(ctx, uid, kind), key, convId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ kind, convId }), 'utf8');
    }
  }
  return { conv, wsDir, key };
}

function wsIndex(ctx, uid, key) {
  return JSON.parse(fs.readFileSync(path.join(accountDir(ctx, uid), key, 'index.json'), 'utf8'));
}
function fingerprints(ctx, id) {
  const s = readSession('codebuddy-ide', ctx, id).session;
  return s ? s.turns.map((t) => JSON.stringify(t.items.map((i) => i.text ?? i.name ?? ''))) : null;
}

function switchTo(ctx, { id, account, opts = {}, planOpts = {} }) {
  const plan = planSwitch(ctx, { variant: 'codebuddy-ide', ids: [id], account, ...planOpts });
  assert.equal(plan.fatal, undefined, JSON.stringify(plan));
  return { plan, results: executeSwitch(ctx, plan, { apply: true, lock: false, ...opts }) };
}

test('切到没有该项目的账号：补出 history/<md5>/index.json，正文与三个平行目录一起搬，内容逐轮等价', () => {
  const ctx = ctxFor(tmpHome('project-create'));
  const cwd = path.join(ctx.home, 'proj', 'alpha');
  const seeded = seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-1', turns: 2, withCompanions: true });
  // 目标账号本机存在，但没挂过这个项目
  fs.mkdirSync(path.join(accountDir(ctx, B_UID), 'other-key'), { recursive: true });
  fs.writeFileSync(path.join(accountDir(ctx, B_UID), 'other-key', 'index.json'), JSON.stringify({ conversations: [], current: '' }), 'utf8');
  const before = fingerprints(ctx, 'conv-1');
  assert.equal(before.length, 2, JSON.stringify(before));

  const dry = planSwitch(ctx, { variant: 'codebuddy-ide', ids: ['conv-1'], account: B_UID });
  assert.equal(dry.items[0].projectCreated, true, `dry-run 必须预告「会补 project」：${JSON.stringify(dry.items[0])}`);
  assert.ok(!fs.existsSync(path.join(accountDir(ctx, B_UID), seeded.key)), 'dry-run 一个字节都不该写');

  const { results } = switchTo(ctx, { id: 'conv-1', account: B_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok((results[0].warnings ?? []).some((w) => /project-created/.test(w)), JSON.stringify(results[0].warnings));

  const moved = path.join(accountDir(ctx, B_UID), seeded.key, 'conv-1');
  assert.ok(fs.existsSync(path.join(moved, 'index.json')), `目标账号里要有正文：${moved}`);
  assert.deepEqual(wsIndex(ctx, B_UID, seeded.key).conversations.map((c) => c.id), ['conv-1'], '目标工作区索引要登记这条');
  assert.deepEqual(wsIndex(ctx, A_UID, seeded.key).conversations, [], '源账号索引不能再列它');
  assert.ok(!fs.existsSync(seeded.conv), '源账号正文已搬走');
  for (const kind of ['check-point', 'file-tree', 'plan-task']) {
    assert.ok(fs.existsSync(path.join(accountDir(ctx, B_UID, kind), seeded.key, 'conv-1', 'marker.json')), `${kind} 要跟着搬，否则检查点/文件树/计划任务留在旧账号`);
    assert.ok(!fs.existsSync(path.join(accountDir(ctx, A_UID, kind), seeded.key, 'conv-1')), `${kind} 源位置要清空`);
  }
  assert.ok(results[0].backup && fs.existsSync(results[0].backup), '搬迁前必须留备份');
  assert.deepEqual(fingerprints(ctx, 'conv-1'), before, '切换前后内容必须逐轮等价');
  assert.equal(readSession('codebuddy-ide', ctx, 'conv-1').session.account?.id, B_UID, '读回的归属要是目标账号');
});

test('重跑幂等：第二次只剩目标副本，动作是 already 且不再写文件', () => {
  const ctx = ctxFor(tmpHome('idempotent'));
  const cwd = path.join(ctx.home, 'proj', 'beta');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-2', turns: 1 });
  fs.mkdirSync(accountDir(ctx, B_UID), { recursive: true });
  const first = switchTo(ctx, { id: 'conv-2', account: B_UID });
  assert.equal(first.results[0].ok, true, JSON.stringify(first.results[0]));
  const file = path.join(accountDir(ctx, B_UID), wsKey(cwd), 'conv-2', 'index.json');
  const mtime = fs.statSync(file).mtimeMs;
  const second = switchTo(ctx, { id: 'conv-2', account: B_UID });
  assert.equal(second.results[0].ok, true, JSON.stringify(second.results[0]));
  assert.match(String((second.results[0].warnings ?? []).join('|')), /already-in-target-account/, JSON.stringify(second.results[0]));
  assert.equal(fs.statSync(file).mtimeMs, mtime, '第二次不该重写文件');
});

test('--keep-source 时两处都留一份', () => {
  const ctx = ctxFor(tmpHome('keep-source'));
  const cwd = path.join(ctx.home, 'proj', 'gamma');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-3', turns: 1 });
  fs.mkdirSync(accountDir(ctx, B_UID), { recursive: true });
  const { results } = switchTo(ctx, { id: 'conv-3', account: B_UID, opts: { keepSource: true } });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok(fs.existsSync(path.join(accountDir(ctx, A_UID), wsKey(cwd), 'conv-3', 'index.json')), '源账号那份要留着');
  assert.ok(fs.existsSync(path.join(accountDir(ctx, B_UID), wsKey(cwd), 'conv-3', 'index.json')), '目标账号多一份');
  assert.equal(wsIndex(ctx, A_UID, wsKey(cwd)).conversations.length, 1, '源索引条目不能被摘掉');
  assert.ok((results[0].warnings ?? []).some((w) => /copied:/.test(w)), JSON.stringify(results[0].warnings));
});

test('目标账号已有同 id 但内容不同 → refused content-diverged；--force 才替换且先备份目标', () => {
  const ctx = ctxFor(tmpHome('diverged'));
  const cwd = path.join(ctx.home, 'proj', 'delta');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-4', turns: 3 });
  seedConversation(ctx, { uid: B_UID, cwd, convId: 'conv-4', turns: 1 });
  const refused = switchTo(ctx, { id: 'conv-4', account: B_UID });
  assert.equal(refused.results[0].ok, false, JSON.stringify(refused.results[0]));
  assert.match(String(refused.results[0].error), /content-diverged/, JSON.stringify(refused.results[0]));
  assert.equal(readSession('codebuddy-ide', ctx, 'conv-4').session.turns.length, 3, '拒绝时源副本（更长）仍在盘上，内容没被动');

  const forced = switchTo(ctx, { id: 'conv-4', account: B_UID, opts: { force: true } });
  assert.equal(forced.results[0].ok, true, JSON.stringify(forced.results[0]));
  assert.ok((forced.results[0].warnings ?? []).some((w) => /target-backup-replaced/.test(w)), JSON.stringify(forced.results[0].warnings));
  assert.ok(!fs.existsSync(path.join(accountDir(ctx, A_UID), wsKey(cwd), 'conv-4')), '强制替换后源账号不再留副本');
});

test('--only-imported 拒绝宿主原生行；带 session-sync 标记的行放行', () => {
  const ctx = ctxFor(tmpHome('only-imported'));
  const cwd = path.join(ctx.home, 'proj', 'eps');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'native-1', turns: 1 });
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'ours-1', turns: 1, provenance: true });
  fs.mkdirSync(accountDir(ctx, B_UID), { recursive: true });
  const refused = switchTo(ctx, { id: 'native-1', account: B_UID, opts: { onlyImported: true } });
  assert.equal(refused.results[0].ok, false, JSON.stringify(refused.results[0]));
  assert.match(String(refused.results[0].error), /not-imported-row/, JSON.stringify(refused.results[0]));
  const allowed = switchTo(ctx, { id: 'ours-1', account: B_UID, opts: { onlyImported: true } });
  assert.equal(allowed.results[0].ok, true, JSON.stringify(allowed.results[0]));
});

test('宿主原生行默认允许切，但逐条打 foreign-switch-authorized 审计', () => {
  const ctx = ctxFor(tmpHome('foreign-audit'));
  const cwd = path.join(ctx.home, 'proj', 'zeta');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'native-2', turns: 1 });
  fs.mkdirSync(accountDir(ctx, B_UID), { recursive: true });
  const { results } = switchTo(ctx, { id: 'native-2', account: B_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok((results[0].warnings ?? []).some((w) => /foreign-switch-authorized/.test(w)), JSON.stringify(results[0].warnings));
});

test('恢复不出项目目录时拒绝并要 --cwd，绝不造宿主不打开的目录', () => {
  const ctx = ctxFor(tmpHome('cwd-required'));
  const cwd = path.join(ctx.home, 'proj', 'eta');
  const seeded = seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-5', turns: 1 });
  // 抹掉正文里的 Workspace Folder 注入，并保证 md5→路径 反查也取不到
  const msgFile = fs.readdirSync(path.join(seeded.conv, 'messages')).map((f) => path.join(seeded.conv, 'messages', f));
  for (const f of msgFile) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const payload = JSON.parse(raw.message);
    payload.content = payload.content.map((b) => ({ ...b, text: String(b.text).replace(/<user_info>[\s\S]*?<\/user_info>/g, '').trim() }));
    raw.message = JSON.stringify(payload);
    fs.writeFileSync(f, JSON.stringify(raw), 'utf8');
  }
  fs.mkdirSync(accountDir(ctx, B_UID), { recursive: true });
  const r = switchTo(ctx, { id: 'conv-5', account: B_UID });
  assert.equal(r.results[0].ok, false, JSON.stringify(r.results[0]));
  assert.match(String(r.results[0].error), /cwd-required/, JSON.stringify(r.results[0]));
  assert.equal(fs.readdirSync(accountDir(ctx, B_UID)).length, 0, '拒绝时不能在目标账号里造任何目录');

  const fixed = switchTo(ctx, { id: 'conv-5', account: B_UID, planOpts: { cwd: path.join(ctx.home, 'proj', 'eta2') } });
  assert.equal(fixed.results[0].ok, true, JSON.stringify(fixed.results[0]));
  assert.ok(fixed.results[0].path.includes(wsKey(path.join(ctx.home, 'proj', 'eta2'))), JSON.stringify(fixed.results[0]));
});

test('读侧把账号与全部副本暴露出来（只展示，不按账号过滤）', () => {
  const ctx = ctxFor(tmpHome('reader-copies'));
  const cwd = path.join(ctx.home, 'proj', 'theta');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-6', turns: 2 });
  seedConversation(ctx, { uid: B_UID, cwd, convId: 'conv-6', turns: 5 });
  const rows = listSessions('codebuddy-ide', ctx, {}).sessions;
  assert.equal(rows.length, 1, '同一 id 只出一行');
  const row = rows[0];
  assert.equal(row.account.id, B_UID, 'best 副本 = 消息更多那份');
  assert.equal(row.copies.length, 2, JSON.stringify(row.copies));
  assert.deepEqual(row.copies.map((c) => c.account?.id).sort(), [A_UID, B_UID], '两处坐标都要看得见');
  const acc = codebuddyIdeWriter.listAccounts(ctx);
  assert.equal(acc.ok, true, JSON.stringify(acc));
  assert.equal(acc.current, null, '当前登录 uid 本机无可信落点 → 必须报 null，不能猜');
  assert.deepEqual(acc.accounts.map((a) => a.id).sort(), [A_UID, B_UID].sort());
});

test('账号目录本机不存在时按源副本形态派生，并告警 target-root-derived', () => {
  const ctx = ctxFor(tmpHome('derived-root'));
  const cwd = path.join(ctx.home, 'proj', 'iota');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'conv-7', turns: 1 });
  const { results } = switchTo(ctx, { id: 'conv-7', account: B_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok((results[0].warnings ?? []).some((w) => /target-root-derived/.test(w)), JSON.stringify(results[0].warnings));
  assert.ok(fs.existsSync(path.join(accountDir(ctx, B_UID), wsKey(cwd), 'conv-7', 'index.json')));
});

test('写侧不擅自改道：--account 的账号本机没有 history 时，导入仍写进现有最新账号并告警', () => {
  const ctx = ctxFor(tmpHome('import-pin-warning'));
  const cwd = path.join(ctx.home, 'proj', 'kappa');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'seed-only', turns: 1 });
  const missing = 'cccccccc-3333-4333-8333-333333333333';
  const res = codebuddyIdeWriter.write(ctx, {
    session: { id: 'w-1', variant: 'claude', title: 't', cwd, createdAt: 1, updatedAt: 2, turns: [] },
    targetId: 'w-1',
    mode: 'create',
    provenance: null,
    force: false,
    account: { variant: 'codebuddy-ide', id: missing },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.path.startsWith(accountDir(ctx, A_UID)), `目标账号没有 history 时不凭空造目录，仍写现有账号：${res.path}`);
  assert.ok((res.warnings ?? []).some((w) => /account-root-unmatched/.test(w)), JSON.stringify(res.warnings));
});

test('写根按账号坐标，不按「谁最近被改过」：冷账号不会被 mtime 挤掉', () => {
  const ctx = ctxFor(tmpHome('cold-account'));
  const cwd = path.join(ctx.home, 'proj', 'lambda');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'cold-1', turns: 1 });
  seedConversation(ctx, { uid: B_UID, cwd, convId: 'hot-2', turns: 1 });
  // 把 A 的工作区索引调成很久以前：按 mtime 选根的实现会把它判成「不存在」，写进 B
  const coldIndex = path.join(accountDir(ctx, A_UID), wsKey(cwd), 'index.json');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(coldIndex, old, old);

  const res = codebuddyIdeWriter.write(ctx, {
    session: { id: 'w-2', variant: 'claude', title: 't', cwd, createdAt: 1, updatedAt: 2, turns: [] },
    targetId: 'w-2',
    mode: 'create',
    provenance: null,
    force: false,
    account: { variant: 'codebuddy-ide', id: A_UID },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.path.startsWith(accountDir(ctx, A_UID)), `指定了账号就必须落在那儿，哪怕它是冷数据：${res.path}`);

  // 没指定账号、本机只有一个账号坐标时，仍然写那一份（mtime 不参与决策，冷数据反而更能证明这点）
  const solo = ctxFor(tmpHome('cold-solo'));
  const cwd2 = path.join(solo.home, 'proj', 'mu');
  seedConversation(solo, { uid: A_UID, cwd: cwd2, convId: 'cold-3', turns: 1 });
  const soloIndex = path.join(accountDir(solo, A_UID), wsKey(cwd2), 'index.json');
  fs.utimesSync(soloIndex, old, old);
  const r2 = codebuddyIdeWriter.write(solo, {
    session: { id: 'w-3', variant: 'claude', title: 't', cwd: cwd2, createdAt: 1, updatedAt: 2, turns: [] },
    targetId: 'w-3',
    mode: 'create',
    provenance: null,
    force: false,
    account: null,
  });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(r2.path.startsWith(accountDir(solo, A_UID)), JSON.stringify(r2));
});

test('多账号并存却没指定账号时不猜：报 account-ambiguous，且一个字都不写', () => {
  const ctx = ctxFor(tmpHome('ambiguous-account'));
  const cwd = path.join(ctx.home, 'proj', 'nu');
  seedConversation(ctx, { uid: A_UID, cwd, convId: 'a-1', turns: 1 });
  seedConversation(ctx, { uid: B_UID, cwd, convId: 'b-1', turns: 1 });
  const res = codebuddyIdeWriter.write(ctx, {
    session: { id: 'w-4', variant: 'claude', title: 't', cwd, createdAt: 1, updatedAt: 2, turns: [] },
    targetId: 'w-4',
    mode: 'create',
    provenance: null,
    force: false,
    account: null,
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error, 'account-ambiguous');
  assert.ok((res.warnings ?? []).some((w) => /target-root-unresolved/.test(w)), '必须说清「为什么不写」，不能只回一个错误码');
  for (const uid of [A_UID, B_UID]) {
    assert.ok(!fs.existsSync(path.join(accountDir(ctx, uid), wsKey(cwd), 'w-4')), `不许擅自选账号落盘：${uid}`);
  }
});
