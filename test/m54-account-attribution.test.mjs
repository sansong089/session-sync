// M54 测试：导入时的「账号归属」只能来自两个地方 —— 显式 --account，或目标宿主的当前登录账号。
//
// 回归的 bug（2026-11-02 真机）：placement.mjs 有一条 `opts.account ?? sourceSession.account`
// 兜底，于是跨 agent 导入把**源会话那一行**的归属原样钉进了目标宿主的归属列。
// workbuddy 的宿主列表谓词是 `user_id = 当前登录 uid`，源 uid 是另一个账号（甚至另一个命名空间，
// 例如 codex 的 user-xxxx），结果就是「导入报成功、库里确有行、宿主列表永远看不见」。
// 文档早就写的是另一套口径（SKILL.md「省略时取目标宿主当前登录账号」），这条把它钉成规格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { currentAccount, describeAccounts, PARTITIONED_VARIANTS, LOGIN_PROBED_VARIANTS } from '../src/accounts.mjs';

const WB_OLD_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // 源行所属的旧登录账号
const WB_CN_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // 目标宿主当前登录
const CODEX_USER = 'user-FAKEFAKEFAKEFAKEFAKEFAKES';
const CODEX_ACCOUNT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SRC_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

const SESSION_COLS = `(id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT,
  created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
  is_playground INTEGER, transport TEXT, unread INTEGER, model TEXT, mode TEXT,
  source_mode TEXT, thought_level TEXT)`;

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m54-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}

/** WorkBuddy 安装根：正文 projects/<slug>/<id>.jsonl + 索引库 + account-snapshot（当前登录唯一权威来源） */
function mkWorkbuddy(root, dir, currentUid, { withRow = null } = {}) {
  const base = path.join(root, dir);
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(base, 'storage', 'skeleton'), { recursive: true });
  fs.writeFileSync(
    path.join(base, 'storage', 'skeleton', 'account-snapshot.json'),
    JSON.stringify({ primary: { version: 1, uid: currentUid, nickname: 'x', type: 'personal' } }),
    'utf8',
  );
  const dbFile = path.join(base, 'workbuddy.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions ${SESSION_COLS}`);
  if (withRow) {
    db.prepare(
      'INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, is_playground, transport, unread) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(withRow.id, withRow.cwd, withRow.user_id, withRow.title ?? 'r', 'Completed', 1793349815133, 1793349869457, 1793349869457, 0, 'local', 0);
  }
  db.close();
  return dbFile;
}

/** WorkBuddy 宿主原生正文（不带 session-sync 标记） */
function mkWorkbuddyBody(root, dir, { id, cwd, user = '甲', assistant = '乙' }) {
  const file = path.join(root, dir, 'projects', 'd-work-demo', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      { type: 'session-meta', id, cwd, timestamp: '2026-10-30T09:00:00.000Z', meta: { 'codebuddy.ai/hostKind': 'unopted' } },
      { type: 'message', role: 'user', id, timestamp: '2026-10-30T09:00:01.000Z', content: [{ type: 'text', text: user }] },
      { type: 'message', role: 'assistant', id, timestamp: '2026-10-30T09:00:02.000Z', content: [{ type: 'text', text: assistant }] },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
    'utf8',
  );
  return file;
}

/** codex rollout（creator_* 只在部分代际/入口写，所以两处都造得到） */
function mkCodexSource(root, { id = SRC_ID, cwd = 'D:/work/demo', creator = null } = {}) {
  const day = path.join(root, '.codex', 'sessions', '2026', '10', '08');
  fs.mkdirSync(day, { recursive: true });
  const meta = { id, session_id: id, timestamp: '2026-10-30T09:00:00.000Z', cwd, runtime_workspace_roots: [cwd], model: 'gpt-5' };
  if (creator) Object.assign(meta, { creator_user_id: creator.user, creator_account_id: creator.account });
  const file = path.join(day, `rollout-2026-10-30T09-00-00-${id}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { timestamp: '2026-10-30T09:00:00.000Z', type: 'session_meta', payload: meta },
      { timestamp: '2026-10-30T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '甲' }] } },
      { timestamp: '2026-10-30T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '乙' }] } },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
    'utf8',
  );
  return file;
}

function mkCodexAuth(root, { user = CODEX_USER, account = CODEX_ACCOUNT, write = true } = {}) {
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  if (!write) return;
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { user_id: user, chatgpt_account_id: account } })).toString('base64url');
  fs.writeFileSync(
    path.join(root, '.codex', 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: account, id_token: `eyJh.${claims}.c`, access_token: 'x', refresh_token: 'y' } }),
    'utf8',
  );
}

function workbuddyUserId(dbFile, id) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id)?.user_id ?? null;
  } finally {
    db.close();
  }
}

/** 找 codex 会话根下按 targetId 落成的 rollout 头行 */
function codexMeta(root, targetId) {
  const root_ = path.join(root, '.codex', 'sessions');
  let hit = null;
  (function walk(d) {
    if (hit || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(`-${targetId}.jsonl`)) hit = f;
    }
  })(root_);
  if (!hit) return null;
  return JSON.parse(fs.readFileSync(hit, 'utf8').split('\n')[0]).payload;
}

function run(ctx, opts) {
  const plan = planImport(ctx, opts);
  return executePlan(ctx, plan, { apply: true, lock: false });
}

// ---------------- 回归用例 ----------------

test('导入不继承源行的 user_id：workbuddy-intl(旧账号) → workbuddy-cn(当前登录)', () => {
  const root = tmpHome('wb-inherit');
  const srcDb = mkWorkbuddy(root, '.workbuddy-ai', WB_OLD_UID, { withRow: { id: SRC_ID, cwd: 'D:/work/demo', user_id: WB_OLD_UID, title: '旧账号的会话' } });
  mkWorkbuddyBody(root, '.workbuddy-ai', { id: SRC_ID, cwd: 'D:/work/demo' });
  const dstDb = mkWorkbuddy(root, '.workbuddy', WB_CN_UID);
  const ctx = ctxFor(root);

  const res = run(ctx, { from: ['workbuddy-intl'], into: ['workbuddy-cn'] });
  assert.equal(res.length, 1, JSON.stringify(res));
  assert.equal(res[0].ok, true, JSON.stringify(res[0]));
  const uid = workbuddyUserId(dstDb, res[0].targetId);
  assert.equal(uid, WB_CN_UID, `必须落目标宿主当前登录 uid，实际 ${uid}（源行 uid=${WB_OLD_UID} 被继承了）`);
  assert.equal(res[0].index.userIdSource, 'account-snapshot', `归属来源要说实话，不能报成用户显式指定：${JSON.stringify(res[0].index)}`);
  assert.equal(workbuddyUserId(srcDb, SRC_ID), WB_OLD_UID, '源那一行的归属不受影响');
});

test('跨命名空间导入：codex 的 creator_user_id 绝不写进 workbuddy 的 sessions.user_id', () => {
  const root = tmpHome('codex-to-wb');
  mkCodexSource(root, { creator: { user: CODEX_USER, account: CODEX_ACCOUNT } });
  mkCodexAuth(root);
  const dstDb = mkWorkbuddy(root, '.workbuddy', WB_CN_UID);
  const ctx = ctxFor(root);

  const res = run(ctx, { from: ['codex'], into: ['workbuddy-cn'] });
  assert.equal(res[0].ok, true, JSON.stringify(res[0]));
  assert.equal(res[0].placement.account, null, `不带 --account 时落点不该带任何账号：${JSON.stringify(res[0].placement.account)}`);
  assert.equal(workbuddyUserId(dstDb, res[0].targetId), WB_CN_UID, '归属是当前登录，不是 codex 的 user-xxxx');
});

test('codex 作目标：没有 --account 时 creator_* 取本机 auth.json 的当前登录账号', () => {
  const root = tmpHome('into-codex-current');
  mkWorkbuddy(root, '.workbuddy', WB_OLD_UID, { withRow: { id: SRC_ID, cwd: 'D:/work/demo', user_id: WB_OLD_UID, title: 'workbuddy 的会话' } });
  mkWorkbuddyBody(root, '.workbuddy', { id: SRC_ID, cwd: 'D:/work/demo' });
  mkCodexAuth(root);
  const ctx = ctxFor(root);

  const res = run(ctx, { from: ['workbuddy-cn'], into: ['codex'] });
  assert.equal(res[0].ok, true, JSON.stringify(res[0]));
  const meta = codexMeta(root, res[0].targetId);
  assert.ok(meta, 'rollout 没落盘');
  assert.equal(meta.creator_user_id, CODEX_USER, `creator_user_id 必须是 codex 当前登录，实际 ${meta.creator_user_id}（workbuddy 的 uid 被跨命名空间继承了）`);
  assert.equal(meta.creator_account_id, CODEX_ACCOUNT, '两列成对出现');
});

test('codex 作目标且本机没有登录态：不写 creator_*（宁缺勿错，更不能写源的 uid）', () => {
  const root = tmpHome('into-codex-noauth');
  mkWorkbuddy(root, '.workbuddy', WB_OLD_UID, { withRow: { id: SRC_ID, cwd: 'D:/work/demo', user_id: WB_OLD_UID, title: 'workbuddy 的会话' } });
  mkWorkbuddyBody(root, '.workbuddy', { id: SRC_ID, cwd: 'D:/work/demo' });
  mkCodexAuth(root, { write: false });
  fs.mkdirSync(path.join(root, '.codex', 'sessions'), { recursive: true });
  const ctx = ctxFor(root);

  const res = run(ctx, { from: ['workbuddy-cn'], into: ['codex'] });
  assert.equal(res[0].ok, true, JSON.stringify(res[0]));
  const meta = codexMeta(root, res[0].targetId);
  assert.ok(meta, 'rollout 没落盘');
  assert.equal(meta.creator_user_id ?? null, null, `取不到当前登录就不该有归属，实际 ${meta.creator_user_id}`);
});

test('--account 仍然覆盖：workbuddy 与 codex 都听显式指定的那个 uid', () => {
  const root = tmpHome('flag-still-wins');
  mkCodexSource(root, { creator: { user: CODEX_USER, account: CODEX_ACCOUNT } });
  mkWorkbuddy(root, '.workbuddy', WB_CN_UID);
  const ctx = ctxFor(root);
  const res = run(ctx, { from: ['codex'], into: ['workbuddy-cn'], account: 'uid-explicit-target' });
  assert.equal(res[0].ok, true, JSON.stringify(res[0]));
  assert.equal(workbuddyUserId(path.join(root, '.workbuddy', 'workbuddy.db'), res[0].targetId), 'uid-explicit-target');
  assert.equal(res[0].index.userIdSource, 'flag:account', '显式指定的来源标注不变');
});

// ---------------- 「当前登录账号」这一抽象本身的契约 ----------------

test('currentAccount：各家登录态读法收敛成一个出口，返回同一形状', () => {
  const root = tmpHome('current-shape');
  mkWorkbuddy(root, '.workbuddy', WB_CN_UID);
  mkWorkbuddy(root, '.workbuddy-ai', WB_OLD_UID);
  mkCodexAuth(root);
  const ctx = ctxFor(root);

  assert.deepEqual(currentAccount('workbuddy-cn', ctx), { variant: 'workbuddy-cn', id: WB_CN_UID, accountId: null, name: 'x', source: 'account-snapshot:primary.uid' });
  assert.equal(currentAccount('workbuddy-intl', ctx).id, WB_OLD_UID, '中/英各自读自己的安装根');
  assert.deepEqual(currentAccount('codex', ctx), { variant: 'codex', id: CODEX_USER, accountId: CODEX_ACCOUNT, name: null, source: 'auth.json:id_token claims' });
});

test('currentAccount：读不到登录态就是 null，绝不猜（含 codebuddy-ide 无可信落点）', () => {
  const root = tmpHome('current-null');
  const ctx = ctxFor(root);
  assert.equal(currentAccount('codex', ctx), null, '没有 auth.json 就不报当前登录');
  assert.equal(currentAccount('workbuddy-cn', ctx), null, '没有 account-snapshot 就不报');
  assert.equal(currentAccount('codebuddy-ide', ctx), null, '这一家本机没有可信的当前登录落点，必须 --account 点名');
  assert.equal(currentAccount('claude', ctx), null, 'none 模型没有账号身份');
  assert.equal(currentAccount('no-such-variant', ctx), null, '未登记的变体不报错、也不猜');
});

test('可切账号（partition）的宿主必须每家都登记登录态探针，漏一家就失败', () => {
  assert.deepEqual(
    PARTITIONED_VARIANTS.filter((v) => !LOGIN_PROBED_VARIANTS.includes(v)),
    [],
    `这些变体的会话按账号分区，但没登记「当前登录怎么取」：${PARTITIONED_VARIANTS.filter((v) => !LOGIN_PROBED_VARIANTS.includes(v)).join(', ')}（写侧会拿不到默认归属）`,
  );
});

test('single-account 宿主也走同一个出口（qoder 取 agentAccountScope）', () => {
  const root = tmpHome('current-single');
  const dir = path.join(root, 'AppData', 'Roaming', 'com.qodercn.app.stable');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'qoder-data.v1.ext.json'), JSON.stringify({ accounts: { local: {}, 'qoder:prod:cn:deadbeef': {} } }), 'utf8');
  fs.writeFileSync(path.join(dir, 'qoder-data.v1.json'), JSON.stringify({ agentAccountScope: 'qoder:prod:cn:deadbeef' }), 'utf8');
  const cur = currentAccount('qoder-cn', ctxFor(root));
  assert.equal(cur.id, 'qoder:prod:cn:deadbeef');
  assert.equal(cur.variant, 'qoder-cn');
});

test('accounts 命令报的「当前登录」与写侧用的归属是同一个出口（不再两处各挑）', () => {
  const root = tmpHome('current-same-source');
  mkWorkbuddy(root, '.workbuddy', WB_CN_UID);
  const ctx = ctxFor(root);
  const described = describeAccounts('workbuddy-cn', ctx, { listSessions, getWriter });
  assert.equal(described.current?.id, WB_CN_UID, `accounts 要报出当前登录：${JSON.stringify(described)}`);
  assert.deepEqual(described.current, currentAccount('workbuddy-cn', ctx), '两处必须是同一个出口，否则 accounts 报的账号和 import 写的归属会分叉');
});

