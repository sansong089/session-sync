// M13 测试：reader 补 scope/account 信号（步骤 3）
// 口径来自现网实测交叉表（codex 352 条 session_meta）：
//   落 ~/Documents/Codex/<日期>/<slug> 的 105 条全部无 git；但有 112 条「有 git + 项目 cwd」同样出现在
//   .codex-global-state.json 的 projectless-thread-ids 里 → 注册表那份名单是「未挂到侧栏项目」不是「非项目会话」，
//   绝不能拿来做分类（本文件最后一条测试把它锁死）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { codexReader } from '../src/readers/codex.mjs';
import { minimaxReader } from '../src/readers/minimax.mjs';
import { DatabaseSync } from 'node:sqlite';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
const J = (s) => String(s ?? '').replace(/\\/g, '/');

// ---------- 共用：摘要透传 scope ----------

test('listSessions 摘要统一带 scope：宿主自管根下 → none，真实目录 → project', () => {
  const root = tmpRoot('scope-summary');
  const ctx = ctxFor(root);
  const bucketCwd = J(path.join(root, 'WorkBuddy', '2026-10-08-18-38-21'));
  const projCwd = 'D:/00-work/code/demo-app';
  writeJsonl(path.join(root, '.claude', 'projects', 'A', 's-bucket.jsonl'), [
    { type: 'user', cwd: bucketCwd, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: '桶里的会话' } },
  ]);
  writeJsonl(path.join(root, '.claude', 'projects', 'B', 's-proj.jsonl'), [
    { type: 'user', cwd: projCwd, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: '项目里的会话' } },
  ]);

  const r = listSessions('claude', ctx, {});
  assert.equal(r.ok, true, r.error);
  const byId = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
  assert.equal(byId['s-bucket'].scope, 'none', JSON.stringify(byId['s-bucket']));
  assert.match(byId['s-bucket'].scopeReason, /internal-root/);
  assert.equal(byId['s-proj'].scope, 'project');
  assert.equal(byId['s-proj'].account, null, '没有账户信号的变体 account 留 null，不许按目录猜');
});

// ---------- minimax：默认桶信号 + 宿主列表谓词 ----------

const MM_COLS = `(session_id TEXT PRIMARY KEY, record_json TEXT, updated_at_ms INTEGER, columnar_version INTEGER,
  agent_name TEXT, runtime TEXT, session_type TEXT, status TEXT, archived INTEGER, visibility TEXT,
  session_kind TEXT, purpose TEXT, purpose_kind TEXT, origin_cron_id TEXT, parent_session_id TEXT,
  workspace_dir TEXT, project_workspace_dir TEXT, is_default_workspace INTEGER, title TEXT,
  created_at_ms INTEGER, error_message TEXT, error_code TEXT, extra_data_json TEXT, project_id INTEGER,
  history_relative_dir TEXT)`;

function mmDb(file, rows, projects = [{ project_id: 1, project_kind: 'default' }]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE local_runtime_sessions ${MM_COLS}`);
  db.exec(`CREATE TABLE local_runtime_projects (project_id INTEGER PRIMARY KEY, project_kind TEXT, workspace_dir TEXT, hidden INTEGER)`);
  db.exec(`CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT, turn_id TEXT, created_at_ms INTEGER, data_json TEXT, source TEXT)`);
  for (const r of rows) {
    db.prepare('INSERT INTO local_runtime_message_rows (session_id, msg_id, role, created_at_ms, data_json) VALUES (?,?,?,?,?)').run(
      r.session_id,
      `${r.session_id}-m1`,
      'user',
      1760000000000,
      JSON.stringify({ content: [{ type: 'input_text', text: '跑一下测试' }] }),
    );
    db.prepare('INSERT INTO local_runtime_message_rows (session_id, msg_id, role, created_at_ms, data_json) VALUES (?,?,?,?,?)').run(
      r.session_id,
      `${r.session_id}-m2`,
      'assistant',
      1760000001000,
      JSON.stringify({ content: [{ type: 'output_text', text: '都过了' }] }),
    );
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO local_runtime_sessions (${cols.map((c) => `'${c}'`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
  }
  for (const p of projects) {
    db.prepare('INSERT INTO local_runtime_projects (project_id, project_kind, workspace_dir, hidden) VALUES (?,?,?,?)').run(p.project_id, p.project_kind, p.workspace_dir ?? null, p.hidden ?? 0);
  }
  db.close();
}

function mmRow(id, over = {}) {
  return {
    session_id: id,
    record_json: JSON.stringify({ model: 'MiniMax-M2' }),
    updated_at_ms: 1760000001000,
    columnar_version: 3,
    agent_name: 'mavis',
    archived: 0,
    visibility: 'visible',
    session_kind: 'conversation',
    parent_session_id: null,
    is_default_workspace: 1,
    project_id: 1,
    workspace_dir: `C:/MMHome/.minimax/sessions/${id}/workspace`,
    project_workspace_dir: `C:/MMHome/.minimax/sessions/${id}/workspace`,
    title: '',
    created_at_ms: 1760000000000,
    history_relative_dir: null,
    ...over,
  };
}

test('minimax reader：默认工作区 → scope none + cwd 置空，内部路径挪进 meta.internalPath', () => {
  const root = tmpRoot('minimax-scope');
  const ctx = ctxFor(root);
  const file = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  mmDb(file, [mmRow('mvs_aaa'), mmRow('mvs_bbb', { is_default_workspace: 0, project_workspace_dir: 'D:/00-work/code/demo-app', project_id: 2 })], [{ project_id: 1, project_kind: 'default' }, { project_id: 2, project_kind: 'local' }]);

  const list = minimaxReader.list(ctx, {});
  assert.equal(list.length, 2, JSON.stringify(list.map((s) => s.id)));
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(byId.mvs_aaa.cwd, '', '默认桶会话不能把内部目录当 cwd（会被下游认成项目）');
  assert.equal(byId.mvs_aaa.scope, 'none');
  assert.equal(J(byId.mvs_aaa.internalPath), 'C:/MMHome/.minimax/sessions/mvs_aaa/workspace');
  assert.equal(byId.mvs_bbb.cwd, 'D:/00-work/code/demo-app');

  const s = minimaxReader.read(ctx, 'mvs_aaa');
  assert.equal(s.cwd, '');
  assert.equal(s.meta.internalPath, byId.mvs_aaa.internalPath);
  assert.equal(s.turns.length, 1);
});

test('minimax reader：隐藏/cron/子代理不列，归档行只标记不筛掉（宿主口径 + D1）', () => {
  const root = tmpRoot('minimax-pred');
  const ctx = ctxFor(root);
  const file = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  mmDb(file, [
    mmRow('keep'),
    mmRow('sub-employee', { agent_name: 'worker' }),
    mmRow('sub-main', { agent_name: 'main' }),
    mmRow('hidden', { visibility: 'hidden' }),
    mmRow('peek', { session_kind: 'peek' }),
    mmRow('cron', { session_kind: 'cron' }),
    mmRow('old-columnar', { columnar_version: 2 }),
    mmRow('archived', { archived: 1 }),
    mmRow('child', { parent_session_id: 'keep' }),
  ]);
  const list = minimaxReader.list(ctx, {});
  const ids = list.map((s) => s.id).sort();
  assert.deepEqual(ids, ['archived', 'keep', 'sub-main'], `宿主口径应只留这三条，实际: ${ids.join(',')}`);
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(byId.archived.archived, true, '归档行要带标记，交给 planImport 拦（D1）');
  assert.equal(byId.keep.archived, false);
});

test('minimax reader：老库缺列时谓词自动跳过（不能整表读不出来）', () => {
  const root = tmpRoot('minimax-oldcols');
  const ctx = ctxFor(root);
  const file = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT, updated_at_ms INTEGER, agent_name TEXT, archived INTEGER, workspace_dir TEXT, title TEXT, created_at_ms INTEGER)`);
  db.exec(`CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT, turn_id TEXT, created_at_ms INTEGER, data_json TEXT, source TEXT)`);
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?,?,?,?)').run('legacy', '{}', 1760000001000, 'mavis', 0, 'C:/work/proj', '老库会话', 1760000000000);
  db.close();
  const list = minimaxReader.list(ctx, {});
  assert.deepEqual(list.map((s) => s.id), ['legacy']);
});


// ---------- workbuddy ----------
// 实测（C:\Users\you\.workbuddy\workbuddy.db 数百行 / .workbuddy-ai 百余行）：
//   project_id 全 NULL；is_playground=1 只有 64/131（cn）、22/69（intl）→ 不能当非项目判据；
//   真正可靠的是 cwd 落在 ~/WorkBuddy[ AI]/<compact14|hyphen6|automation-*|Claw>（INTERNAL_ROOTS 前缀命中）；
//   但 db 里有 jsonl 事件缺 cwd 时可作兜底，user_id/deleted_at 只能作为信号，一律不得当筛选条件（D3）。

const WB_COLS = `(id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT, created_at INTEGER,
  updated_at INTEGER, deleted_at INTEGER, is_playground INTEGER, model TEXT, project_id TEXT,
  visibility TEXT, group_id TEXT)`;

function wbDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions ${WB_COLS}`);
  for (const r of rows) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
  }
  db.close();
}

function wbJsonl(root, dirSlug, id, { cwd = null, text = '看下这个项目' } = {}) {
  const mk = (type, role, ts, text2) => ({
    id: `${id}-${ts}`,
    timestamp: ts,
    type,
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: text2 }],
    providerData: { model: 'hunyuan' },
    sessionId: id,
    ...(cwd ? { cwd } : {}),
  });
  writeJsonl(path.join(root, '.workbuddy', 'projects', dirSlug, `${id}.jsonl`), [
    mk('message', 'user', 1760000000000, text),
    mk('message', 'assistant', 1760000001000, '好的'),
  ]);
}

test('workbuddy reader：db 只供信号（兜底 cwd / account / deleted_at），绝不当筛选条件', () => {
  const root = tmpRoot('workbuddy-signals');
  const ctx = ctxFor(root);
  const bucketCwd = J(path.join(root, 'WorkBuddy', '20260325175256'));
  wbJsonl(root, 'c-Users-Test-WorkBuddy-20260325175256', 'wb_no_cwd_in_jsonl');
  wbJsonl(root, 'c-Users-Test-WorkBuddy-20260325175256', 'wb_other_account', { cwd: bucketCwd });
  wbJsonl(root, 'c-Users-Test-WorkBuddy-20260325175256', 'wb_deleted', { cwd: bucketCwd });
  wbJsonl(root, 'd-00-demo-app', 'wb_project', { cwd: 'D:/00-demo-app' });
  wbDb(path.join(root, '.workbuddy', 'workbuddy.db'), [
    { id: 'wb_no_cwd_in_jsonl', cwd: bucketCwd, user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', is_playground: 0 },
    { id: 'wb_other_account', cwd: bucketCwd, user_id: '11111111-2222-3333-4444-555555555555', is_playground: 0 },
    { id: 'wb_deleted', cwd: bucketCwd, user_id: '11111111-2222-3333-4444-555555555555', is_playground: 1, deleted_at: 1760000002000 },
    { id: 'wb_project', cwd: 'D:/00-demo-app', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', is_playground: 0 },
  ]);

  const list = listSessions('workbuddy-cn', ctx, {});
  assert.equal(list.ok, true, list.error);
  const byId = Object.fromEntries(list.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['wb_deleted', 'wb_no_cwd_in_jsonl', 'wb_other_account', 'wb_project'], 'D3：别的账户/已删除的行一样要列出来');

  assert.equal(byId.wb_no_cwd_in_jsonl.cwd, bucketCwd, 'jsonl 没带 cwd 时用 db.cwd 兜底，否则落点判不出来');
  assert.deepEqual(byId.wb_no_cwd_in_jsonl.account, { variant: 'workbuddy-cn', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(byId.wb_other_account.account.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(byId.wb_deleted.archived, true, 'db deleted_at → 归档标记（D1 由 planImport 过滤）');

  assert.equal(byId.wb_no_cwd_in_jsonl.scope, 'none');
  assert.match(byId.wb_no_cwd_in_jsonl.scopeReason, /internal-root/);
  assert.equal(byId.wb_project.scope, 'project');

  const s = readSession('workbuddy-cn', ctx, 'wb_no_cwd_in_jsonl').session;
  assert.equal(s.cwd, bucketCwd);
  assert.deepEqual(s.account, byId.wb_no_cwd_in_jsonl.account);
  assert.equal(s.scope, 'none');
  assert.match(J(s.meta.sourcePath), /wb_no_cwd_in_jsonl\.jsonl$/, '正文路径要随摘要带出（搬迁靠它定位）');
});

test('workbuddy reader：没有 workbuddy.db 时照常读，account 留 null', () => {
  const root = tmpRoot('workbuddy-nodb');
  const ctx = ctxFor(root);
  wbJsonl(root, 'd-00-demo-app', 'wb_plain', { cwd: 'D:/00-demo-app' });
  const list = listSessions('workbuddy-cn', ctx, {});
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].account, null);
  assert.equal(list.sessions[0].scope, 'project');
});

// ---------- dsh ----------
// 实测（C:\Users\you\.dsh\storages\workspace.json + sessions 目录 10 条）：
//   默认工作区 319ba08d… → path=~/Documents/deepseek-harness/default-workspace，登记 4 条 session-<uuid>；
//   裸 uuid 目录 4 条全是 subagent（不在登记表里）；archivedSessionIds 当前为空但语义要接上（D1）。

async function dshSession(root, slug, id, { cwd = '' } = {}) {
  const zlib = await import('node:zlib');
  const events = [
    { type: 'session', id, cwd, createdAt: 1760000000000 },
    { type: 'user/message', time: 1760000001000, data: { content: [{ type: 'text', text: '看下这个目录' }] } },
    { type: 'assistant/message', time: 1760000002000, data: { message: { content: [{ type: 'text', text: '好的' }], source: { model: 'deepseek-flash' } } } },
  ];
  const dir = path.join(root, '.dsh', 'sessions', slug, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))));
}

test('dsh reader：默认工作区登记给 scope，archivedSessionIds 只标记不筛掉', async () => {
  const root = tmpRoot('dsh-signals');
  const ctx = ctxFor(root);
  const bucket = J(path.join(root, 'Documents', 'deepseek-harness', 'default-workspace'));
  await dshSession(root, '--C-Users-you-Documents-deepseek-harness-default-workspace--', 'session-dflt', { cwd: bucket });
  await dshSession(root, '--C-Users-you-Documents-deepseek-harness-default-workspace--', 'session-no-cwd');
  await dshSession(root, '--D-00-demo-app--', 'session-arch', { cwd: 'D:/00-demo-app' });
  writeJson(path.join(root, '.dsh', 'storages', 'workspace.json'), {
    unit: { name: 'workspace', version: 2 },
    global: { defaultWorkspaceId: 'ws-default', archivedSessionIds: ['session-arch'], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-default': { path: bucket, title: 'default-workspace', sessionIds: ['session-dflt', 'session-no-cwd'] },
        'ws-proj': { path: 'D:\\00-demo-app', title: '00-demo-app', sessionIds: ['session-arch'] },
      },
    },
  });

  const list = listSessions('dsh', ctx, {});
  assert.equal(list.ok, true, list.error);
  const byId = Object.fromEntries(list.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['session-arch', 'session-dflt', 'session-no-cwd'], 'D1/D3：归档行照样列出来（由 planImport 拦），不按账户筛');
  assert.equal(byId['session-arch'].archived, true);
  assert.equal(byId['session-dflt'].archived, false);
  assert.equal(byId['session-dflt'].scope, 'none');
  assert.equal(byId['session-no-cwd'].scope, 'none', 'cwd 缺失时靠登记表判定默认工作区');
  assert.match(byId['session-no-cwd'].scopeReason, /reader/);
  assert.equal(byId['session-arch'].scope, 'project');

  const s = readSession('dsh', ctx, 'session-no-cwd').session;
  assert.equal(s.scope, 'none');
});

// ---------- opencode-classic 家族（mimo / zcode）----------
// 实测 C:\Users\you\.local\share\mimocode\mimocode.db 20 行：
//   project_id='global' 16 条 ⇔ directory 全在 ~/XiaomiMiMoProjects 下（16/16 一致，无一条相反）；
//   另 4 条 project_id=uuid ⇔ 真实项目目录。所以 global 是可靠的库内信号，目录前缀只是兜底。
//   宿主最新代际桶形态 = .mimo-sessions/<Y>/<M>/<D>/<slug>（实测 2026-10-08 new-chat）。

const CLS_SESSION_COLS = `(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
  title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`;

function classicDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session ${CLS_SESSION_COLS}`);
  db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)`);
  db.exec(`CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER)`);
  for (const r of rows) {
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      r.id,
      r.project_id ?? 'global',
      r.parent_id ?? null,
      r.slug ?? 's',
      r.directory ?? '',
      r.title ?? r.id,
      '1.0',
      null,
      r.time_created ?? 1760000000000,
      r.time_updated ?? 1760000001000,
      r.time_archived ?? null,
    );
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(`${r.id}-m1`, r.id, 1760000000000, JSON.stringify({ role: 'user', time: { created: 1760000000000 } }), 0);
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(`${r.id}-p1`, `${r.id}-m1`, r.id, 1760000000000, JSON.stringify({ type: 'text', text: '看下这个目录' }), 0);
  }
  db.close();
}

test('opencode-classic：project_id=global → none；子链不列；归档只标记不筛掉（D1）', () => {
  const root = tmpRoot('classic-signals');
  const mimoDir = path.join(root, 'mimo');
  const bucket = J(path.join(root, 'XiaomiMiMoProjects', '.mimo-sessions', '2026', '10', '08', 'new-chat'));
  classicDb(path.join(mimoDir, 'mimocode.db'), [
    { id: 'ses_global_no_dir', project_id: 'global', directory: '' },
    { id: 'ses_global', project_id: 'global', directory: bucket },
    { id: 'ses_proj', project_id: '9aa222c4-5022-42df-ac9f-d7dadda4e178', directory: 'D:/00-demo-app' },
    { id: 'ses_child', project_id: 'global', directory: bucket, parent_id: 'ses_global' },
    { id: 'ses_arch', project_id: '9aa222c4-5022-42df-ac9f-d7dadda4e178', directory: 'D:/00-demo-app', time_archived: 1760000002000 },
  ]);
  const ctx = ctxFor(root, { MIMO_HOME: mimoDir });

  const list = listSessions('mimo', ctx, {});
  assert.equal(list.ok, true, list.error);
  const ids = list.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ['ses_arch', 'ses_global', 'ses_global_no_dir', 'ses_proj'], '子链不列，但归档要列出来给存在性判定用');
  const byId = Object.fromEntries(list.sessions.map((s) => [s.id, s]));
  assert.equal(byId.ses_arch.archived, true);
  assert.equal(byId.ses_global.archived, false);
  assert.equal(byId.ses_global_no_dir.scope, 'none', 'directory 为空也要靠 project_id=global 判出来');
  assert.match(byId.ses_global_no_dir.scopeReason, /reader/);
  assert.equal(byId.ses_proj.scope, 'project');

  const sub = listSessions('mimo', ctx, { includeSubagents: true });
  assert.ok(sub.sessions.some((s) => s.id === 'ses_child'), '--include-subagents 时子链要能看到');

  const s = readSession('mimo', ctx, 'ses_global_no_dir').session;
  assert.equal(s.scope, 'none');
});

// ---------- qoder ----------
// 实测 C:\Users\you\AppData\Roaming\QoderCN\SharedClientCache\cache\db\local.db 数十行：
//   parent_session_id 有值 53 行 ⇔ session_type='agent_sub_browser'|'agent_sub_generalpurpose'（宿主主列表不出现），
//   top 29 行 = add_user_message/assistant/quest；org_id 全空、user_id 单值。
//   落桶的 4 行 = quest + mode=long_running，project_uri=~/Documents/QoderCN/<日期>/chat-N。

function qoderDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE chat_session (session_id TEXT PRIMARY KEY, user_id TEXT, user_name TEXT, session_title TEXT,
    project_id TEXT, project_uri TEXT, project_name TEXT, gmt_create INTEGER, gmt_modified INTEGER, org_id TEXT,
    session_type TEXT, mode TEXT, version TEXT, preferred_model_info TEXT, status TEXT, last_user_query_at INTEGER,
    stop_reason TEXT, extra TEXT, parent_session_id TEXT, parent_tool_call_id TEXT)`);
  for (const r of rows) {
    db.prepare('INSERT INTO chat_session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      r.session_id,
      r.user_id ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      r.user_name ?? 'me@example.com',
      r.session_title ?? r.session_id,
      r.project_uri ?? '',
      r.project_uri ?? '',
      '',
      1760000000000,
      1760000001000,
      r.org_id ?? '',
      r.session_type ?? 'assistant',
      r.mode ?? '',
      '1.0',
      null,
      '',
      0,
      null,
      null,
      r.parent_session_id ?? '',
      null,
    );
  }
  db.close();
}

test('qoder reader：account 只从 local.db 取，子代理链不列，CLI 明文行没有账户信号就是 null', () => {
  const root = tmpRoot('qoder-signals');
  const ctx = ctxFor(root);
  const bucketUri = J(path.join(root, 'Documents', 'QoderCN', '2026-10-15', 'chat-2'));
  qoderDb(path.join(root, 'AppData', 'Roaming', 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'), [
    { session_id: 'qs_project', project_uri: 'D:/00-demo-app' },
    { session_id: 'qs_bucket', project_uri: bucketUri, session_type: 'quest', mode: 'long_running' },
    { session_id: 'qs_child', project_uri: 'D:/00-demo-app', session_type: 'agent_sub_browser', parent_session_id: 'qs_project' },
  ]);
  const cliBucket = J(path.join(root, 'Documents', 'QoderCN', '2026-10-16', 'chat-1'));
  writeJsonl(path.join(root, '.qoder-cn', 'projects', 'A', 'qs_cli.jsonl'), [
    { type: 'workspace-directories', directories: [cliBucket] },
    { type: 'user', cwd: cliBucket, timestamp: '2026-10-16T00:00:00.000Z', message: { role: 'user', content: 'cli 明文会话' } },
  ]);

  const list = listSessions('qoder-cn', ctx, {});
  assert.equal(list.ok, true, list.error);
  const byId = Object.fromEntries(list.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['qs_bucket', 'qs_cli', 'qs_project'], `子代理链不该出现在会话列表，实际: ${Object.keys(byId).join(',')}`);
  assert.deepEqual(byId.qs_project.account, { variant: 'qoder-cn', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'me@example.com', orgId: null });
  assert.equal(byId.qs_cli.account, null, 'CLI 明文 jsonl 没有账户字段，绝不按目录猜');
  assert.equal(byId.qs_bucket.scope, 'none');
  assert.equal(byId.qs_project.scope, 'project');

  const sub = listSessions('qoder-cn', ctx, { includeSubagents: true });
  assert.ok(sub.sessions.some((s) => s.id === 'qs_child'), '--include-subagents 才带出子链');

  const s = readSession('qoder-cn', ctx, 'qs_bucket').session;
  assert.deepEqual(s.account, byId.qs_bucket.account);
  assert.equal(s.cwd, bucketUri);
});

// ---------- codex ----------

const codexMeta = (id, cwd, { git = null, creator = true } = {}) => ({
  timestamp: '2026-10-14T00:03:14.017Z',
  type: 'session_meta',
  payload: {
    ...(creator ? { creator_user_id: 'user-FAKEFAKEFAKEFAKEFAKEFAKES', creator_account_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } : {}),
    id,
    session_id: id,
    timestamp: '2026-10-14T00:03:14.017Z',
    cwd,
    runtime_workspace_roots: [cwd],
    model: 'gpt-5',
    ...(git ? { git } : {}),
  },
});
const codexBody = (id) => [
  { timestamp: '2026-10-14T00:03:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '了解助手身份' }] } },
  { timestamp: '2026-10-14T00:03:40.159Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我是…' }] } },
];

test('codex reader：creator_* 进 account，git 信号进 meta（写侧要靠它决定不写 git）', () => {
  const root = tmpRoot('codex-signals');
  const ctx = ctxFor(root);
  const bucketId = '01a13f28-22a1-7f20-9adc-062faf6271c9';
  const projId = '01a13f23-e76d-76d3-b950-ec00d9f2a64b';
  const bucketCwd = J(path.join(root, 'Documents', 'Codex', '2026-10-15', 'she'));
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '15', `rollout-2026-10-15T00-03-14-${bucketId}.jsonl`), [codexMeta(bucketId, bucketCwd), ...codexBody(bucketId)]);
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '15', `rollout-2026-10-15T00-04-14-${projId}.jsonl`), [
    codexMeta(projId, 'D:/00-demo-app', { git: { commit_hash: 'abc', branch: 'master', repository_url: 'https://x/y.git' } }),
    ...codexBody(projId),
  ]);

  const list = codexReader.list(ctx, {});
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.deepEqual(byId[bucketId].account, {
    variant: 'codex',
    id: 'user-FAKEFAKEFAKEFAKEFAKEFAKES',
    accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.equal(byId[bucketId].hasGit, false);
  assert.equal(byId[projId].hasGit, true);

  // list 与 read 两个口径必须一致
  const s = readSession('codex', ctx, projId).session;
  assert.deepEqual(s.account, byId[projId].account);
  assert.equal(s.meta.hasGit, true);
  assert.equal(s.meta.git.branch, 'master');
});

test('codex reader：projectless-thread-ids 不参与分类（112 条有 git 的项目会话会被误判非项目）', () => {
  const root = tmpRoot('codex-registry-trap');
  const ctx = ctxFor(root);
  const projId = '01a08522-5c5c-76a3-8a9c-3f74d46a7fc0';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '09', '03', `rollout-2026-09-03T00-00-00-${projId}.jsonl`), [
    codexMeta(projId, 'D:/00-demo-app', { git: { commit_hash: 'abc', branch: 'master', repository_url: 'https://x/y.git' } }),
    ...codexBody(projId),
  ]);
  writeJson(path.join(root, '.codex', '.codex-global-state.json'), { 'projectless-thread-ids': [projId] });

  const r = listSessions('codex', ctx, {});
  const row = r.sessions.find((x) => x.id === projId);
  assert.equal(row.scope, 'project', '注册表里挂着也不能改判：分类只认目录是否落在宿主自管根');
});
