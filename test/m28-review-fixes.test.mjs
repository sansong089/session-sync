// M28 测试：review 发现问题的回归（D1 归档目标 / .zst 定位 / DB 型 writer 换目录 / 账户改标 / 谓词 / 警告 / origin 匹配）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { findExistingByTargetId } from '../src/writers/base.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { targetSessionId } from '../src/identity.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m28-${name}-`));
}
function ctxFor(root, env = {}) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } }),
    ['codex', 'workbuddy-cn', 'dsh'],
  );
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function mkClaudeSource(root, id, cwd, texts = ['第一轮']) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: new Date(1791484221000 + i * 9000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: new Date(1791484230000 + i * 9000).toISOString(), message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  writeJsonl(path.join(root, '.claude', 'projects', id, `${id}.jsonl`), rows);
}
const runImport = (ctx, opts) => executePlan(ctx, planImport(ctx, { from: ['claude'], ...opts }), { apply: true, lock: false });

const codexMeta = (id, cwd) => ({
  timestamp: '2026-10-08T18:38:21.000Z',
  type: 'session_meta',
  payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd, runtime_workspace_roots: [cwd], creator_user_id: 'u1' },
});
const codexMsgs = (id, texts) => {
  const out = [];
  texts.forEach((t, i) => {
    out.push({ timestamp: new Date(1791484221000 + i * 9000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
    out.push({ timestamp: new Date(1791484230000 + i * 9000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `答${t}` }] } });
  });
  return out;
};
// 归档行是「我们导入之后被宿主归档」的会话 → 必须带 provenance（身份判据吃这个）
const codexProv = (originVariant, originId) => ({
  timestamp: '2026-10-08T18:38:40.000Z',
  type: 'session-sync-provenance',
  'session-sync': { tool: 'session-sync', v: 1, origin: { variant: originVariant, sessionId: originId }, chain: [{ variant: originVariant, sessionId: originId, at: 1 }] },
});

// ---------- 1. D1：归档目标不得被改写 / 搬迁 / 重新登记 ----------

test('D1：目标侧已归档的同 id 会话 → skip(target-archived)，文件一字不改、注册表不重新登记', () => {
  const root = tmpRoot('d1');
  mkClaudeSource(root, 's1', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  // 派生 id 只由 originKey 决定，可直接算（与目标是否存在无关）
  const realId = String(targetSessionId('codex', { variant: 'claude', id: 's1', origin: null }));
  const archivedFile = path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-08T18-30-21-${realId}.jsonl`);
  writeJsonl(archivedFile, [codexMeta(realId, 'C:/old'), ...codexMsgs(realId, ['第一轮', '第二轮']), codexProv('claude', 's1')]);
  const beforeReal = fs.readFileSync(archivedFile, 'utf8');

  const r = runImport(ctx, { into: ['codex'] })[0];
  assert.equal(r.sourceId, 's1');
  assert.equal(r.action, 'skip', JSON.stringify(r));
  assert.equal(r.reason, 'target-archived', JSON.stringify(r));
  assert.equal(fs.readFileSync(archivedFile, 'utf8'), beforeReal, '归档文件内容不得被改写');
  const regFile = path.join(root, '.codex', '.codex-global-state.json');
  const registered = fs.existsSync(regFile) ? (JSON.parse(fs.readFileSync(regFile, 'utf8'))['projectless-thread-ids'] ?? []) : [];
  assert.ok(!registered.includes(realId), '归档会话不得被重新登记为非项目会话');
});

test('D1：归档目标 + 落点变化时，skip 分支也不得搬迁它', () => {
  const root = tmpRoot('d1-reloc');
  mkClaudeSource(root, 's2', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const probe = planImport(ctx, { from: ['claude'], into: ['claude'] });
  const id = probe.pairs[0].targetId;
  // claude 没有 archived 概念；这里用 codex 目标验证 skip-relocate 守卫
  const pid = planImport(ctx, { from: ['claude'], into: ['codex'] }).pairs[0].targetId;
  const arch = path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-08T18-30-21-${pid}.jsonl`);
  writeJsonl(arch, [codexMeta(pid, 'C:/old'), ...codexMsgs(pid, ['第一轮']), codexProv('claude', 's2')]);
  const statBefore = fs.statSync(arch).mtimeMs;
  const r = runImport(ctx, { into: ['codex'], placement: 'cwd', cwd: J(path.join(root, 'picked')) }).find((x) => x.target === 'codex');
  assert.equal(r.action, 'skip', JSON.stringify(r));
  assert.ok(!(r.warnings ?? []).some((w) => /relocated/.test(String(w))), JSON.stringify(r.warnings));
  assert.equal(fs.statSync(arch).mtimeMs, statBefore, '归档文件不得被移动');
  void id;
});

test('D1：归档行没有 provenance（身份冲突）→ fork 到新 ID，归档文件仍不动', () => {
  const root = tmpRoot('d1-collide');
  mkClaudeSource(root, 's2b', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const pid = planImport(ctx, { from: ['claude'], into: ['codex'] }).pairs[0].targetId;
  const arch = path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-08T18-30-21-${pid}.jsonl`);
  // 同一 ID 上坐着一段「原生」归档会话（无 provenance）→ 身份不同
  writeJsonl(arch, [codexMeta(pid, 'C:/old'), ...codexMsgs(pid, ['第一轮'])]);
  const before = fs.readFileSync(arch, 'utf8');

  const r = runImport(ctx, { into: ['codex'] }).find((x) => x.target === 'codex');
  assert.equal(r.action, 'fork', JSON.stringify(r));
  assert.equal(r.reason, 'identity-mismatch');
  assert.notEqual(r.targetId, pid, '不得写到冲突 ID 上');
  assert.equal(fs.readFileSync(arch, 'utf8'), before, '归档文件一字不改');
});

// ---------- 2. `.jsonl.zst` 目标：能按 id 找回，append 后仍是一个 .zst ----------
test('codex：目标是 .jsonl.zst 时按 id 找回并原地追加（不新起 .jsonl 残档）', () => {
  const root = tmpRoot('zst');
  mkClaudeSource(root, 's3', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const first = runImport(ctx, { into: ['codex'] })[0];
  assert.equal(first.ok, true, JSON.stringify(first));

  // 把刚落盘的 .jsonl 换成 .jsonl.zst（模拟宿主/旧版本压缩过的目标）
  const zstFile = `${first.path}.zst`;
  const body = fs.readFileSync(first.path);
  fs.writeFileSync(zstFile, zlib.zstdCompressSync(body));
  fs.unlinkSync(first.path);

  assert.equal(J(findExistingByTargetId(path.join(root, '.codex', 'sessions'), first.targetId)), J(zstFile));

  mkClaudeSource(root, 's3', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const second = runImport(ctx, { into: ['codex'] })[0];
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.action, 'append', JSON.stringify(second.action));
  assert.equal(J(second.path), J(zstFile), `必须追加进原 .zst：${second.path}`);
  assert.ok(!fs.existsSync(first.path), '不得另起一份 .jsonl');

  const text = zlib.zstdDecompressSync(fs.readFileSync(zstFile)).toString('utf8');
  const users = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.payload?.role === 'user');
  assert.equal(users.length, 2, `解压后应有两轮用户消息：${users.length}`);
  assert.equal(readSession('codex', ctx, first.targetId).session.turns.length, 2);
});

// ---------- 3. workbuddy：改标要听 --account ----------

test('workbuddy：--account 也决定历史行改标的归属（不只新行）', () => {
  const root = tmpRoot('wb-account');
  const dbFile = path.join(root, '.workbuddy', 'workbuddy.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER, transport TEXT, unread INTEGER, model TEXT, mode TEXT, source_mode TEXT, thought_level TEXT)`);
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status) VALUES (?,?,?,?,?)').run('row-ours', 'D:/x', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 't', 'Completed');
  db.close();
  // 正文带 session-sync 标记 → 属于「我们写过的行」
  writeJsonl(path.join(root, '.workbuddy', 'projects', 'p', 'row-ours.jsonl'), [
    { type: 'session-meta', id: 'row-ours', cwd: 'D:/x', timestamp: '2026-10-08T18:38:21.000Z', meta: { 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: 'x' } } } },
  ]);
  const snap = path.join(root, '.workbuddy', 'storage', 'skeleton', 'account-snapshot.json');
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.writeFileSync(snap, JSON.stringify({ primary: { uid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }), 'utf8');

  mkClaudeSource(root, 's4', 'D:/00-work/code/demo-app');
  const r = runImport(ctxFor(root), { into: ['workbuddy-cn'], account: 'uid-from-flag' })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  const check = new DatabaseSync(dbFile, { readOnly: true });
  const row = check.prepare('SELECT user_id FROM sessions WHERE id = ?').get('row-ours');
  check.close();
  assert.equal(row.user_id, 'uid-from-flag', `--account 必须同时决定改标归属，实际 ${row.user_id}`);
});

// ---------- 4. DB 型 writer：append 也要跟着落点走 ----------

function mkClassicDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)`);
  db.close();
  return file;
}

test('mimo：换落点后 append 要更新 directory / project_id（git 仓库按宿主 id 文件换项目）', (t) => {
  const root = tmpRoot('mimo-append');
  const dbFile = mkClassicDb(path.join(root, '.local', 'share', 'mimocode', 'mimocode.db'));
  // 落点必须是两个**真实 git 仓库**：MiMo 只有 git 目录才有项目（非 git 一律 global，宿主实测）
  const dirA = path.join(root, 'dirA');
  const dirB = path.join(root, 'dirB');
  for (const d of [dirA, dirB]) {
    fs.mkdirSync(d, { recursive: true });
    if (spawnSync('git', ['init', '-q'], { cwd: d }).status !== 0) return t.skip('本机没有 git');
  }
  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['mimo'], placement: 'cwd', cwd: J(dirA) }), { apply: true, lock: false })[0];
  assert.equal(first.ok, true, JSON.stringify(first));

  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const second = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['mimo'], placement: 'cwd', cwd: J(dirB) }), { apply: true, lock: false })[0];
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.action, 'append', JSON.stringify(second.action));

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const row = db.prepare('SELECT directory, project_id FROM session WHERE id = ?').get(second.targetId);
  const proj = db.prepare('SELECT worktree FROM project WHERE id = ?').get(row.project_id);
  db.close();
  const idFileB = fs.readFileSync(path.join(dirB, '.git', 'mimocode-project-id'), 'utf8').trim();
  const idFileA = fs.readFileSync(path.join(dirA, '.git', 'mimocode-project-id'), 'utf8').trim();
  assert.equal(J(row.directory), J(dirB), 'append 必须把 directory 更新到新落点');
  assert.equal(String(row.project_id), idFileB, 'project_id 必须是新仓库 id 文件里的那个');
  assert.notEqual(idFileA, idFileB, '两个仓库的 project id 必须不同（否则没换项目）');
  assert.equal(J(proj.worktree), J(dirB), 'project 行必须是新落点');
});

test('minimax：换落点后 append 要更新 workspace_dir（默认桶与会话 scope 一致）', () => {
  const root = tmpRoot('mm-append');
  const dbFile = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, columnar_version INTEGER NOT NULL DEFAULT 0, agent_name TEXT, runtime TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown', purpose TEXT, purpose_kind TEXT NOT NULL DEFAULT '', origin_cron_id TEXT, parent_session_id TEXT, workspace_dir TEXT, project_workspace_dir TEXT, is_default_workspace INTEGER NOT NULL DEFAULT 0, title TEXT, created_at_ms INTEGER, error_message TEXT, error_code INTEGER, extra_data_json TEXT NOT NULL DEFAULT '{}', project_id INTEGER, history_relative_dir TEXT)`);
  db.exec(`CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL, role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL, source TEXT, source_context_json TEXT, UNIQUE(session_id, msg_id))`);
  db.close();
  mkClaudeSource(root, 's6', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['minimax'], placement: 'cwd', cwd: J(path.join(root, 'dirA')) }), { apply: true, lock: false })[0];
  assert.equal(first.ok, true, JSON.stringify(first));

  mkClaudeSource(root, 's6', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const second = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['minimax'], placement: 'cwd', cwd: J(path.join(root, 'dirB')) }), { apply: true, lock: false })[0];
  assert.equal(second.action, 'append', JSON.stringify(second.action));
  const check = new DatabaseSync(dbFile, { readOnly: true });
  const row = check.prepare('SELECT workspace_dir, project_workspace_dir FROM local_runtime_sessions WHERE session_id = ?').get(second.targetId);
  check.close();
  assert.equal(J(row.workspace_dir), J(path.join(root, 'dirB')));
  assert.equal(J(row.project_workspace_dir), J(path.join(root, 'dirB')));
});

// ---------- 5. minimax reader 的 archived 谓词 ----------

test('minimax：归档行照常列出（带 archived:true，供存在性判定），但不进导入候选（D1）', () => {
  const root = tmpRoot('mm-archived');
  const dbFile = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, columnar_version INTEGER, agent_name TEXT, archived INTEGER NOT NULL DEFAULT 0, visibility TEXT, session_kind TEXT, parent_session_id TEXT, is_default_workspace INTEGER, workspace_dir TEXT, project_workspace_dir TEXT, title TEXT, created_at_ms INTEGER, extra_data_json TEXT DEFAULT '{}')`);
  db.exec(`CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT, created_at_ms INTEGER, data_json TEXT)`);
  const ins = db.prepare("INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms, columnar_version, agent_name, archived, visibility, session_kind, parent_session_id, is_default_workspace, workspace_dir, project_workspace_dir, title, created_at_ms, extra_data_json) VALUES (?,?,?,3,'mavis',?,'visible','conversation',NULL,1,?,?,'t',1,'{}')");
  ins.run('keep', '{}', 2, 0, 'C:/w', 'C:/w');
  ins.run('arch', '{}', 2, 1, 'C:/w', 'C:/w');
  db.close();

  const rows = listSessions('minimax', ctxFor(root), {}).sessions;
  const byId = Object.fromEntries(rows.map((s) => [s.id, s]));
  assert.deepEqual(rows.map((s) => s.id).sort(), ['arch', 'keep'], '归档行要列出来（否则目标存在性判定会漏）');
  assert.equal(byId.arch.archived, true);

  // D1：候选集里剔除归档
  mkClaudeSource(root, 's9', 'C:/w', ['x']);
  const plan = planImport(ctxFor(root), { from: ['minimax'], ids: ['arch'] });
  assert.equal(plan.pairs.length, 0, JSON.stringify(plan.pairs));
  assert.equal(plan.archivedSkipped, 1);
});

// ---------- 6. project-dir-missing 警告 ----------

test('落点目录不存在时给 project-dir-missing 警告（仍原样保留源目录）', () => {
  const root = tmpRoot('missing-dir');
  mkClaudeSource(root, 's7', 'D:/definitely/not/here');
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['dsh'] });
  const p = plan.pairs[0];
  assert.equal(p.placement.directory, 'D:/definitely/not/here');
  assert.ok((p.placement.warnings ?? []).some((w) => /project-dir-missing/.test(String(w))), JSON.stringify(p.placement));
});

// ---------- 7. --project 可按「源目录」命中 + 文本输出标明 matchedBy ----------

test('provenance 记下源目录，list --project 能按源目录搜到，文本输出标明命中哪个', () => {
  const root = tmpRoot('origin-match');
  mkClaudeSource(root, 's8', 'D:/00-work/code/demo-app', ['第一轮']);
  const ctx = ctxFor(root);
  // 搬到宿主不认的目录：cwd 变了，原 project 目录只能从 provenance 里找
  const outside = J(path.join(root, 'picked'));
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['dsh'], placement: 'cwd', cwd: outside }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));

  const back = readSession('dsh', ctx, r.targetId).session;
  assert.equal(J(back.placed?.from ?? ''), 'D:/00-work/code/demo-app', `placed.from 必须记源目录：${JSON.stringify(back.placed)}`);

  const hit = listSessions('dsh', ctx, { project: 'demo-app' });
  assert.deepEqual(hit.sessions.map((s) => s.id), [r.targetId], JSON.stringify(hit.sessions));
  assert.equal(hit.sessions[0].matchedBy, 'origin-dir');
});
