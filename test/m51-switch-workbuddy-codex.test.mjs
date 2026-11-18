// M51 测试：列分区两家（WorkBuddy / Codex）的切账号
//
// WorkBuddy 的账号在 `sessions.user_id` 一列；Codex 在两处（rollout 首行 session_meta + 线程库 threads 两列）。
// 这两家真正要守住的是同一条边界：**只动被点名的那一行**，不许把 import 侧 repair() 的批量改标顺手带进来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planSwitch, executeSwitch } from '../src/switch.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { ACCOUNT_MODEL } from '../src/accounts.mjs';

const OLD_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THIRD_UID = '11111111-2222-3333-4444-555555555555';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m51-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env });
}

function run(root, { variant = 'workbuddy-cn', id, account, opts = {}, planOpts = {} }) {
  const ctx = ctxFor(root);
  const plan = planSwitch(ctx, { variant, ids: [id], account, ...planOpts });
  if (plan.fatal) return { plan, results: [{ fatal: plan.fatal, ok: false }] };
  return { plan, results: executeSwitch(ctx, plan, { apply: true, lock: false, ...opts }) };
}

// ---------------- WorkBuddy ----------------

const SESSION_COLS = `(id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT,
  created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER,
  is_playground INTEGER, transport TEXT, unread INTEGER, model TEXT, mode TEXT,
  source_mode TEXT, thought_level TEXT)`;

function makeWbDb(root, { dir = '.workbuddy', rows = [] } = {}) {
  const file = path.join(root, dir, 'workbuddy.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions ${SESSION_COLS}`);
  for (const r of rows) {
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, deleted_at, is_playground, transport, unread) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      r.id, r.cwd ?? 'D:/work/demo', r.user_id ?? OLD_UID, r.title ?? r.id, 'Completed', 1791484221000, 1791484230000, 1791484230000, r.deleted_at ?? null, r.is_playground ?? 0, 'local', 0,
    );
  }
  db.close();
  return file;
}

function wbSnapshot(root, uid, { dir = '.workbuddy' } = {}) {
  const file = path.join(root, dir, 'storage', 'skeleton', 'account-snapshot.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ primary: { version: 1, uid, nickname: 'me@example.com', type: 'personal' } }), 'utf8');
}

/** 正文首行带不带 session-sync 标记 = 「我们写的行」唯一判据 */
function wbBody(root, id, { ours, dir = '.workbuddy', cwd = 'D:/work/demo' }) {
  const file = path.join(root, dir, 'projects', cwd.replace(/[:\\/]/g, '-'), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const meta = { type: 'session-meta', id, cwd, timestamp: '2026-10-08T18:38:21.000Z', meta: ours ? { 'codebuddy.ai/hostKind': 'unopted', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: id } } } : { 'codebuddy.ai/hostKind': 'unopted' } };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"message","role":"user","content":[{type:"input_text",text:"甲"}],"sessionId":"${id}","cwd":"${cwd}"}\n`, 'utf8');
  return file;
}

function wbRow(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

test('WorkBuddy：点名的行改标到目标 uid，回读一致，并留原值快照', () => {
  const root = tmpHome('wb-retag');
  const file = makeWbDb(root, { rows: [{ id: 'row-1', user_id: OLD_UID }] });
  wbBody(root, 'row-1', { ours: false });
  wbSnapshot(root, NEW_UID);

  const { results } = run(root, { id: 'row-1', account: NEW_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.equal(wbRow(file, 'row-1').user_id, NEW_UID, '归属列必须变成目标 uid');
  assert.ok(results[0].backup && fs.existsSync(results[0].backup), '改列没有文件可备份 → 必须落原值快照');
  assert.match(fs.readFileSync(results[0].backup, 'utf8'), new RegExp(OLD_UID), '快照里要存着改前的值');
  assert.equal(results[0].verify.ok, true, JSON.stringify(results[0].verify));
  assert.ok((results[0].warnings ?? []).some((w) => /foreign-switch-authorized/.test(w)), JSON.stringify(results[0].warnings));
});

test('WorkBuddy：只动点名那一行，其它行（含别的账号）一律不变', () => {
  const root = tmpHome('wb-scope');
  const file = makeWbDb(root, {
    rows: [
      { id: 'row-target', user_id: OLD_UID },
      { id: 'row-other-old', user_id: OLD_UID },
      { id: 'row-third', user_id: THIRD_UID },
    ],
  });
  wbBody(root, 'row-target', { ours: true });
  wbBody(root, 'row-other-old', { ours: true });
  wbBody(root, 'row-third', { ours: true });
  wbSnapshot(root, NEW_UID);

  const { results } = run(root, { id: 'row-target', account: NEW_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.equal(wbRow(file, 'row-other-old').user_id, OLD_UID, 'switch 不是整库 UPDATE：没点名的行不许动');
  assert.equal(wbRow(file, 'row-third').user_id, THIRD_UID, '别人账号的行更不许动');
});

test('WorkBuddy：重跑幂等，已到位时动作是 already 且不写库', () => {
  const root = tmpHome('wb-idempotent');
  const file = makeWbDb(root, { rows: [{ id: 'row-2', user_id: OLD_UID }] });
  wbBody(root, 'row-2', { ours: true });
  wbSnapshot(root, NEW_UID);
  const first = run(root, { id: 'row-2', account: NEW_UID });
  assert.equal(first.results[0].ok, true, JSON.stringify(first.results[0]));
  const mtime = fs.statSync(file).mtimeMs;
  const second = run(root, { id: 'row-2', account: NEW_UID });
  assert.equal(second.results[0].ok, true, JSON.stringify(second.results[0]));
  assert.equal(second.results[0].action, 'already', JSON.stringify(second.results[0]));
  assert.ok(fs.statSync(file).mtimeMs >= mtime);
  assert.match(String((second.plan.items[0].warnings ?? []).join('|')), /already-target-account/, JSON.stringify(second.plan.items[0]));
});

test('WorkBuddy：deleted_at 行拒绝（宿主列表谓词不含它，改了也看不见）', () => {
  const root = tmpHome('wb-deleted');
  const file = makeWbDb(root, { rows: [{ id: 'row-del', user_id: OLD_UID, deleted_at: 1791500000000 }] });
  wbBody(root, 'row-del', { ours: true });
  wbSnapshot(root, NEW_UID);
  const { results } = run(root, { id: 'row-del', account: NEW_UID });
  assert.equal(results[0].ok, false, JSON.stringify(results[0]));
  assert.match(String(results[0].error), /row-deleted/, JSON.stringify(results[0]));
  assert.equal(wbRow(file, 'row-del').user_id, OLD_UID, '拒绝时不能已经写进去');
});

test('WorkBuddy：--only-imported 只放行有 session-sync 标记的行', () => {
  const root = tmpHome('wb-only-imported');
  const file = makeWbDb(root, { rows: [{ id: 'native', user_id: OLD_UID }, { id: 'ours', user_id: OLD_UID }] });
  wbBody(root, 'native', { ours: false });
  wbBody(root, 'ours', { ours: true });
  wbSnapshot(root, NEW_UID);
  const refused = run(root, { id: 'native', account: NEW_UID, opts: { onlyImported: true } });
  assert.equal(refused.results[0].ok, false, JSON.stringify(refused.results[0]));
  assert.match(String(refused.results[0].error), /not-imported-row/, JSON.stringify(refused.results[0]));
  const allowed = run(root, { id: 'ours', account: NEW_UID, opts: { onlyImported: true } });
  assert.equal(allowed.results[0].ok, true, JSON.stringify(allowed.results[0]));
  assert.equal(wbRow(file, 'ours').user_id, NEW_UID);
});

test('WorkBuddy：切到的目标不是当前登录账号时明确告警（宿主列表按当前登录过滤）', () => {
  const root = tmpHome('wb-not-current');
  makeWbDb(root, { rows: [{ id: 'row-3', user_id: OLD_UID }] });
  wbBody(root, 'row-3', { ours: true });
  wbSnapshot(root, NEW_UID);
  const { results } = run(root, { id: 'row-3', account: THIRD_UID });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok((results[0].warnings ?? []).some((w) => /target-not-current-login/.test(w)), JSON.stringify(results[0].warnings));
  assert.ok((results[0].warnings ?? []).some((w) => /sidebar-snapshot-absent/.test(w)), '目标账号本机没有目录 → 只告警，不替宿主造缓存');
});

test('WorkBuddy：id 不存在时报 not-found，不写任何东西', () => {
  const root = tmpHome('wb-missing');
  const file = makeWbDb(root, { rows: [{ id: 'row-4', user_id: OLD_UID }] });
  wbSnapshot(root, NEW_UID);
  const { results } = run(root, { id: 'nope', account: NEW_UID });
  assert.equal(results[0].ok, false, JSON.stringify(results[0]));
  assert.match(String(results[0].error), /not-found/, JSON.stringify(results[0]));
  assert.equal(wbRow(file, 'row-4').user_id, OLD_UID);
});

// ---------------- Codex ----------------

const CODEX_USER = 'user-FAKEFAKEFAKEFAKEFAKEFAKES';
const CODEX_ACCOUNT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function codexRollout(root, { id, cwd, ours = false, zstd = false, creator = { creator_user_id: CODEX_USER, creator_account_id: CODEX_ACCOUNT } }) {
  const day = path.join(root, '.codex', 'sessions', '2026', '10', '08');
  fs.mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: '2026-10-08T18:38:21.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user', ...creator } },
    { timestamp: '2026-10-08T18:38:22.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '甲' }] } },
    { timestamp: '2026-10-08T18:38:23.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '乙' }] } },
  ];
  if (ours) lines.push({ timestamp: '2026-10-08T18:38:24.000Z', type: 'session-sync-provenance', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: id } } });
  const body = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  const file = path.join(day, `rollout-2026-10-08T18-38-21-${id}.${zstd ? 'jsonl.zst' : 'jsonl'}`);
  fs.writeFileSync(file, zstd ? zlib.zstdCompressSync(Buffer.from(body, 'utf8')) : body);
  return file;
}

function codexThreadsDb(root, rows) {
  const file = path.join(root, '.codex', 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, creator_user_id TEXT, creator_account_id TEXT, archived INTEGER)');
  for (const r of rows) db.prepare('INSERT INTO threads (id, rollout_path, cwd, title, creator_user_id, creator_account_id, archived) VALUES (?,?,?,?,?,?,0)').run(r.id, r.rollout_path ?? '', r.cwd ?? '', r.title ?? r.id, r.creator_user_id ?? null, r.creator_account_id ?? null);
  db.close();
  return file;
}

function codexRow(file, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function codexAuth(root) {
  fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { user_id: CODEX_USER, chatgpt_account_id: CODEX_ACCOUNT } })).toString('base64url');
  fs.writeFileSync(path.join(root, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { account_id: CODEX_ACCOUNT, id_token: `eyJh.${claims}.c`, access_token: 'x', refresh_token: 'y' } }), 'utf8');
}

function codexRegistry(root) {
  const file = path.join(root, '.codex', '.codex-global-state.json');
  fs.writeFileSync(file, JSON.stringify({ 'projectless-thread-ids': ['p1'], 'some-unknown-future-key': { keep: 'me' }, 'local-projects': { 'pr-1': { id: 'pr-1', name: 'demo', rootPaths: ['D:/work/demo'] } } }, null, 2), 'utf8');
  return file;
}

test('Codex：rollout 头行与线程库两处一起翻，注册表未知键原样保留', () => {
  const root = tmpHome('cx-both');
  const file = codexRollout(root, { id: 'th-1', cwd: 'D:/work/demo' });
  const db = codexThreadsDb(root, [{ id: 'th-1', creator_user_id: CODEX_USER, creator_account_id: CODEX_ACCOUNT }]);
  const reg = codexRegistry(root);
  codexAuth(root);
  const otherUser = 'user-otheraccountXXXX';
  const before = fs.readFileSync(reg, 'utf8');

  const { results } = run(root, { variant: 'codex', id: 'th-1', account: otherUser });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  assert.equal(meta.payload.creator_user_id, otherUser, 'rollout 头行必须跟着翻');
  assert.equal(codexRow(db, 'th-1').creator_user_id, otherUser, '线程库两列必须一起翻，缺一处就库里对了宿主看不到');
  assert.equal(fs.readFileSync(reg, 'utf8'), before, '注册表按安装共享、与账号无关 → 切账号不该动它');
  assert.ok((results[0].warnings ?? []).some((w) => /state5-host-predicate-unmeasured/.test(w)), '宿主列表谓词未取证，必须如实标注：' + JSON.stringify(results[0].warnings));
  assert.equal(results[0].verify.ok, true, JSON.stringify(results[0].verify));
});

test('Codex：目标是 .jsonl.zst 时切完仍是合法压缩帧', () => {
  const root = tmpHome('cx-zst');
  const file = codexRollout(root, { id: 'th-2', cwd: 'D:/work/demo', zstd: true });
  codexThreadsDb(root, [{ id: 'th-2', creator_user_id: CODEX_USER, creator_account_id: CODEX_ACCOUNT }]);
  codexAuth(root);
  const { results } = run(root, { variant: 'codex', id: 'th-2', account: 'user-newzip' });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  const decoded = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  assert.match(decoded, /"creator_user_id":"user-newzip"/, '整帧重压后内容要读得出来，且归属已改');
  assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8').slice(0, 40)), '不能把明文写进 .zst 文件名里');
});

test('Codex：--account 只给 user id 时，从本机已知账号里补齐 creator_account_id', () => {
  const root = tmpHome('cx-acct');
  codexRollout(root, { id: 'th-3', cwd: 'D:/work/demo' });
  const db = codexThreadsDb(root, [{ id: 'th-3', creator_user_id: CODEX_USER, creator_account_id: CODEX_ACCOUNT }, { id: 'th-9', creator_user_id: 'user-known-other', creator_account_id: 'cccc1111-1111-1111-1111-111111111111' }]);
  codexAuth(root);
  const hit = run(root, { variant: 'codex', id: 'th-3', account: 'user-known-other' });
  assert.equal(hit.results[0].ok, true, JSON.stringify(hit.results[0]));
  assert.equal(codexRow(db, 'th-3').creator_account_id, 'cccc1111-1111-1111-1111-111111111111', '匹配到已知账号 → 两列成对写入');
  assert.ok(!(hit.results[0].warnings ?? []).some((w) => /account-id-missing/.test(w)), JSON.stringify(hit.results[0].warnings));

  const unknown = run(root, { variant: 'codex', id: 'th-3', account: 'user-brand-new' });
  assert.equal(unknown.results[0].ok, true, JSON.stringify(unknown.results[0]));
  assert.ok((unknown.results[0].warnings ?? []).some((w) => /account-id-missing/.test(w)), '认不出 accountId 时要说明只改了一列');
});

test('Codex：线程库没有该行时只告警，rollout 仍算改成功', () => {
  const root = tmpHome('cx-row-absent');
  const file = codexRollout(root, { id: 'th-4', cwd: 'D:/work/demo' });
  codexThreadsDb(root, [{ id: 'other', creator_user_id: CODEX_USER }]);
  codexAuth(root);
  const { results } = run(root, { variant: 'codex', id: 'th-4', account: 'user-x' });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  assert.ok((results[0].warnings ?? []).some((w) => /state5-row-absent/.test(w)), JSON.stringify(results[0].warnings));
  assert.match(fs.readFileSync(file, 'utf8'), /"creator_user_id":"user-x"/);
});

test('Codex：--only-imported 下宿主原生 rollout 拒绝，带标记的放行', () => {
  const root = tmpHome('cx-only-imported');
  codexRollout(root, { id: 'th-native', cwd: 'D:/work/demo' });
  codexRollout(root, { id: 'th-ours', cwd: 'D:/work/demo', ours: true });
  codexThreadsDb(root, [{ id: 'th-native', creator_user_id: CODEX_USER }, { id: 'th-ours', creator_user_id: CODEX_USER }]);
  codexAuth(root);
  const refused = run(root, { variant: 'codex', id: 'th-native', account: 'user-y', opts: { onlyImported: true } });
  assert.equal(refused.results[0].ok, false, JSON.stringify(refused.results[0]));
  assert.match(String(refused.results[0].error), /not-imported-row/);
  const allowed = run(root, { variant: 'codex', id: 'th-ours', account: 'user-y', opts: { onlyImported: true } });
  assert.equal(allowed.results[0].ok, true, JSON.stringify(allowed.results[0]));
});

test('Codex：accounts 报当前登录来自 auth.json，creator 为 NULL 的行单独计数', () => {
  const root = tmpHome('cx-accounts');
  codexRollout(root, { id: 'th-a', cwd: 'D:/work/demo' });
  codexRollout(root, { id: 'th-null', cwd: 'D:/work/demo', creator: {} });
  codexThreadsDb(root, [{ id: 'th-a', creator_user_id: CODEX_USER, creator_account_id: CODEX_ACCOUNT }, { id: 'th-null', creator_user_id: null }]);
  codexAuth(root);
  const ctx = ctxFor(root);
  const rows = listSessions('codex', ctx, {}).sessions;
  assert.ok(rows.some((r) => r.account?.id === CODEX_USER), JSON.stringify(rows.map((r) => r.account)));
  assert.ok(rows.some((r) => !r.account), '没有 creator 的行仍要列出来（读侧绝不按账号过滤）');
  assert.equal(ACCOUNT_MODEL.codex.kind, 'partition');
});
