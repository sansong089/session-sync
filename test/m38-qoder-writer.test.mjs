// M38 测试：Qoder（中/英）三层写入 —— 正文 jsonl + 桌面注册表 chat_sessions + 投影 chat_session_messages
//
// DDL 与 CHECK 约束照抄真机 %APPDATA%\com.qodercn.app.stable\main.sqlite（2026-10-28 取证），
// 这样测试会替宿主校验我们写入的枚举值（session_kind/conversation_mode/product_mode）与必填列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, sessionCoreFingerprints } from '../src/ir.mjs';
import { resolvePlacement } from '../src/placement.mjs';

const N = (s) => String(s ?? '').replace(/\\/g, '/');

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m38-locks-'));

const T0 = 1791484221000;
const CHAT_SESSIONS_DDL = `CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY, sidebar_custom_order INTEGER, origin_session_id TEXT,
  session_kind TEXT NOT NULL DEFAULT 'standard' CHECK (session_kind IN ('standard','sideChat','automationExecution')),
  owner_session_id TEXT, conversation_mode TEXT NOT NULL DEFAULT 'normal' CHECK (conversation_mode IN ('normal','voice')),
  product_mode TEXT NOT NULL DEFAULT 'coding' CHECK (product_mode IN ('coding','general')),
  title TEXT NOT NULL, cwd TEXT NOT NULL, execution_kind TEXT, workspace_id TEXT, git_branch TEXT, model TEXT, permission_mode TEXT,
  additional_direcotries TEXT NOT NULL DEFAULT '{}', extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL, execution_target_json TEXT NOT NULL DEFAULT '{}',
  registration_json TEXT, archived INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMP, deleted_at TIMESTAMP, message_envelope_version INTEGER)`;
const MESSAGES_DDL = `CREATE TABLE chat_session_messages (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', feedback TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  role TEXT, message_stream TEXT, voice_session_id TEXT, subtype TEXT, runtime_input_state TEXT, fork_availability TEXT,
  turn_started_at INTEGER, is_compaction_boundary INTEGER, has_visible_content INTEGER, payload_bytes INTEGER, payload_hash TEXT,
  payload_schema_version INTEGER, PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE)`;
const REVISIONS_DDL = `CREATE TABLE chat_session_history_revisions (
  session_id TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0)`;
const WORKSPACES_DDL = `CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_source TEXT NOT NULL, root_paths_json TEXT NOT NULL,
  product_mode TEXT NOT NULL DEFAULT 'coding', extra_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`;

function setup({ registry = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m38-'));
  const appData = path.join(home, 'AppData', 'Roaming');
  const regDir = path.join(appData, 'com.qodercn.app.stable');
  if (registry) {
    fs.mkdirSync(regDir, { recursive: true });
    const db = new DatabaseSync(path.join(regDir, 'main.sqlite'));
    db.exec(CHAT_SESSIONS_DDL);
    db.exec(MESSAGES_DDL);
    db.exec(REVISIONS_DDL);
    db.exec(WORKSPACES_DDL);
    db.close();
  }
  fs.mkdirSync(path.join(home, '.qoder-cn', 'projects'), { recursive: true });
  const ctx = makeCtx({ home, platform: 'win32', appData, env: { QODER_CN_REGISTRY_DB: registry ? path.join(regDir, 'main.sqlite') : '' } });
  return { home, ctx, regFile: registry ? path.join(regDir, 'main.sqlite') : null };
}

function sourceSession(id = 'src-1') {
  const turns = [
    { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮问题', T0), reasoningItem('先想想', T0), messageItem('assistant', '第一轮回答', T0 + 1000), toolCallItem('call_a', 'Read', { file_path: 'a.txt' }, T0 + 1100), toolResultItem('call_a', 'Read', 'ok', 'file body', T0 + 1200)] },
    { index: 1, role: 'user', startedAt: T0 + 2000, items: [messageItem('user', '第二轮问题', T0 + 2000), messageItem('assistant', '第二轮回答', T0 + 3000)] },
  ];
  return makeSession({ id, variant: 'claude', title: 'M38 三层写入', cwd: 'D:/work/demo', createdAt: T0, updatedAt: T0 + 3000, model: 'm-1', turns, meta: {} });
}

function registryRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      sessions: db.prepare('SELECT * FROM chat_sessions ORDER BY session_id').all(),
      messages: db.prepare('SELECT * FROM chat_session_messages ORDER BY sequence').all(),
      revisions: db.prepare('SELECT * FROM chat_session_history_revisions').all(),
    };
  } finally {
    db.close();
  }
}

test('create：三层都落地，形状符合宿主取证（首末行、cli-import、schema 2、assistant:<userUuid>）', () => {
  const { ctx, regFile } = setup();
  const plan = planImport(ctx, { from: [], into: ['qoder-cn'] });
  const src = sourceSession();
  const p = { ...plan, targets: [{ variant: 'qoder-cn', existing: 0 }], pairs: [{
    target: 'qoder-cn', sourceVariant: 'claude', sourceId: src.id, targetId: 'q1', action: 'create',
    placement: { scope: 'project', directory: src.cwd, source: 'test' },
  }], placementOpts: {} };
  // 源用内存 IR：直接走 writer，确保三层落点单独可控
  const res = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q1', mode: 'create', provenance: { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: src.id }, chain: [] }, force: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  void p;

  const jsonl = fs.readFileSync(res.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(jsonl[0].type, 'workspace-directories', '首行必须是 workspace-directories');
  assert.deepEqual(jsonl[0].directories, ['D:/work/demo']);
  assert.equal(jsonl[1].type, 'runtime-config');
  assert.equal(jsonl.at(-1).type, 'active-leaf', '末行必须是 active-leaf');
  assert.equal(jsonl.at(-1).leafUuid, [...jsonl].reverse().find((l) => l.type === 'user' || l.type === 'assistant').uuid);

  const reg = registryRows(regFile);
  assert.equal(reg.sessions.length, 1);
  const row = reg.sessions[0];
  assert.equal(row.session_id, 'q1');
  assert.equal(row.title, 'M38 三层写入');
  assert.equal(row.cwd, 'D:/work/demo');
  assert.equal(row.archived, 0);
  assert.equal(JSON.parse(row.extra_json).importedFrom, 'session-sync');
  assert.equal(JSON.parse(row.extra_json)['session-sync'].origin.sessionId, src.id, 'provenance 必须进注册表，供身份判定');

  assert.equal(reg.messages.length, 4, `两轮应 4 行（user+assistant 各一），实际 ${reg.messages.length}`);
  for (const m of reg.messages) {
    assert.equal(m.source, 'cli-import', '投影行必须是 cli-import');
    assert.equal(m.payload_schema_version, 2, '必须是 schema 2，否则宿主读回为空');
    if (m.role === 'assistant') assert.match(m.message_id, /^assistant:/, 'assistant 行 message_id 必须是 assistant:<userUuid>');
    const payload = JSON.parse(m.payload_json);
    assert.equal(payload.role, m.role);
    for (const part of payload.parts) assert.ok(['text', 'thinking', 'tool'].includes(part.type), part.type);
  }
  const toolPart = JSON.parse(reg.messages.find((m) => m.role === 'assistant').payload_json).parts.find((x) => x.type === 'tool');
  assert.ok(toolPart, '工具调用要落成 tool 部件');
  assert.equal(toolPart.tool.name, 'Read');
  assert.equal(toolPart.tool.response, 'file body', '回执要合进同一个 tool 部件（宿主就是一体）');
  assert.ok(toolPart.tool.id.startsWith('toolu_'), '调用 id 要跟宿主迁移口径一致');
  assert.deepEqual(reg.revisions.map((r) => r.revision), [4]);
});

function addWorkspace(file, { id, name, roots, archived = 0, deletedAt = null }) {
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO workspaces (workspace_id, name, workspace_source, root_paths_json, created_at, updated_at, archived, deleted_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, name, 'local', JSON.stringify(roots), T0, T0, archived, deletedAt);
  } finally {
    db.close();
  }
}

test('项目会话必须挂到宿主的 workspace_id（侧栏按它分组，留空就掉出项目）', () => {
  const { ctx, regFile } = setup();
  // 宿主已登记两个工作区：D:/work 与 D:/work/demo（后者更长）；另有一个归档的同名工作区不得被认领
  addWorkspace(regFile, { id: 'ws-root-0001', name: 'work', roots: ['D:/work'] });
  addWorkspace(regFile, { id: 'ws-demo-0002', name: 'demo', roots: ['D:\\WORK\\DEMO'] });
  addWorkspace(regFile, { id: 'ws-arch-0003', name: 'elsewhere', roots: ['D:/elsewhere'], archived: 1 });

  const src = { ...sourceSession(), cwd: 'D:/work/demo/sub', scope: 'project' };
  const res = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q-ws', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.index.workspaceId, 'ws-demo-0002', '必须取最长前缀、忽略大小写与分隔符');
  assert.equal(registryRows(regFile).sessions[0].workspace_id, 'ws-demo-0002');

  // 归档工作区不认领：宁可留空并告警，也不要把会话挂进一个宿主已归档的项目
  const orphan = { ...sourceSession('src-2'), cwd: 'D:/elsewhere/x', scope: 'project' };
  const res2 = getWriter('qoder-cn').write(ctx, { session: orphan, targetId: 'q-ws2', mode: 'create', provenance: null, force: true });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(registryRows(regFile).sessions.find((s) => s.session_id === 'q-ws2').workspace_id, null);
  assert.ok(res2.warnings.some((w) => w.startsWith('workspace-unmatched')), `无匹配工作区必须告警：${JSON.stringify(res2.warnings)}`);
});

test('已导入的项目会话续写时自愈 workspace_id（落点当时登记不上，后来补上了要跟着填）', () => {
  const { home, ctx, regFile } = setup();
  // 目录在盘上不存在 → 宿主登记项目要求目录真实存在，这一次只能留空
  const dir = path.join(home, 'not-created-m38');
  const src = { ...sourceSession(), cwd: dir, scope: 'project' };
  const prov = { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: src.id }, chain: [] };
  const r1 = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q-heal', mode: 'create', provenance: prov, force: true });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(registryRows(regFile).sessions[0].workspace_id, null, '目录不存在且宿主没登记时只能留空');

  addWorkspace(regFile, { id: 'ws-new-0004', name: 'demo', roots: [dir] });
  const appended = { ...src, turns: [...src.turns, { index: 2, role: 'user', startedAt: T0 + 9000, items: [messageItem('user', '再问一句', T0 + 9000)] }], updatedAt: T0 + 9500 };
  const r2 = getWriter('qoder-cn').write(ctx, { session: appended, targetId: 'q-heal', mode: 'append', fromTurnIndex: 2, provenance: prov });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(registryRows(regFile).sessions[0].workspace_id, 'ws-new-0004', '续写要顺带把归属补上');
});

function workspaceRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM workspaces ORDER BY workspace_id').all();
  } finally {
    db.close();
  }
}

// 宿主按 root_paths_json[0] === path 严格比较复用项目行，断言只比对 realpath 归一后的等价性
const samePath = (a, b) => N(String(a).replace(/[\\/]+$/, '')).toLowerCase() === N(String(b).replace(/[\\/]+$/, '')).toLowerCase();

test('宿主没登记过该项目时补登记 workspaces 行（项目会话不能只写会话不写项目）', () => {
  const { home, ctx, regFile } = setup();
  const dir = path.join(home, 'proj', 'real-demo');
  fs.mkdirSync(dir, { recursive: true });
  const src = { ...sourceSession(), cwd: dir, scope: 'project' };
  const res = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q-reg', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.warnings.some((w) => w.startsWith('workspace-created')), `补登记必须告警告知：${JSON.stringify(res.warnings)}`);

  const ws = workspaceRows(regFile);
  assert.equal(ws.length, 1, `应补出恰好一行项目，实际 ${ws.length}`);
  assert.equal(registryRows(regFile).sessions[0].workspace_id, ws[0].workspace_id, '会话的分组键必须等于新登记行的 id');
  assert.equal(ws[0].workspace_source, 'local', 'source 要跟宿主本地项目一致');
  assert.equal(samePath(JSON.parse(ws[0].root_paths_json)[0], fs.realpathSync(dir)), true, 'root_paths_json 必须是该目录的真实路径（宿主严格比较这一列）');
  assert.equal(ws[0].name, 'real-demo', '项目名取目录末段');
  assert.equal(ws[0].archived, 0);
  assert.equal(ws[0].deleted_at, null);
  assert.match(ws[0].workspace_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '宿主这一列是随机 uuid，不是路径哈希');
});

test('同一目录只登记一行：第二次导入不能再造项目（侧栏重复项=幽灵项目）', () => {
  const { home, ctx, regFile } = setup();
  const dir = path.join(home, 'proj', 'twice');
  fs.mkdirSync(dir, { recursive: true });
  const a = { ...sourceSession(), cwd: dir, scope: 'project' };
  const b = { ...sourceSession('src-9'), cwd: dir, scope: 'project' };
  assert.equal(getWriter('qoder-cn').write(ctx, { session: a, targetId: 'q-a', mode: 'create', provenance: null, force: true }).ok, true);
  const res2 = getWriter('qoder-cn').write(ctx, { session: b, targetId: 'q-b', mode: 'create', provenance: null, force: true });
  assert.equal(res2.ok, true, JSON.stringify(res2));

  assert.equal(workspaceRows(regFile).length, 1, '第二次的目录已经登记过，不能再插一行');
  assert.ok(!res2.warnings.some((w) => w.startsWith('workspace-created')), '第二次不该再报补登记');
  const ids = registryRows(regFile).sessions.map((s) => s.workspace_id);
  assert.equal(new Set(ids).size, 1, `两条会话要挂同一个项目：${JSON.stringify(ids)}`);
  assert.equal(ids[0], workspaceRows(regFile)[0].workspace_id);
});

test('目录盘上不存在时不补登记：留告警，绝不造出宿主打不开幽灵项目', () => {
  const { home, ctx, regFile } = setup();
  const src = { ...sourceSession(), cwd: path.join(home, 'ghost', 'never-created'), scope: 'project' };
  const res = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q-ghost', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.warnings.some((w) => w.startsWith('workspace-unmatched')), `落空必须仍告警：${JSON.stringify(res.warnings)}`);
  assert.equal(workspaceRows(regFile).length, 0, '目录不存在时一行都不该插');
  assert.equal(registryRows(regFile).sessions[0].workspace_id, null);
});

test('宿主已归档该项目：不复活成可见，也不另起一行重复登记', () => {
  const { home, ctx, regFile } = setup();
  const dir = path.join(home, 'proj', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  const src = { ...sourceSession(), cwd: dir, scope: 'project' };
  assert.equal(getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q-arc', mode: 'create', provenance: null, force: true }).ok, true);

  const db = new DatabaseSync(regFile);
  db.prepare('UPDATE workspaces SET archived = 1').run();
  db.close();

  const res2 = getWriter('qoder-cn').write(ctx, { session: { ...sourceSession('src-8'), cwd: dir, scope: 'project' }, targetId: 'q-arc2', mode: 'create', provenance: null, force: true });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.equal(workspaceRows(regFile).length, 1, '归档行占着这个根目录，不能再插第二条');
  assert.equal(registryRows(regFile).sessions.find((s) => s.session_id === 'q-arc2').workspace_id, null, '归档项目不认领（宿主 list 会滤掉它）');
});

test('round-trip：注册表投影读回的核心指纹与 jsonl 一致（两个源必须等价）', () => {
  const { home, ctx, regFile } = setup();
  const src = sourceSession();
  const res = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q2', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, res.error);

  const viaJsonl = readSession('qoder-cn', ctx, 'q2').session;
  assert.ok(viaJsonl, 'jsonl 侧必须读得到');

  // 只留注册表（把 projects 换成空目录）→ 必须读出同一串核心指纹
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m38-empty-'));
  const ctxRegOnly = makeCtx({ home: empty, platform: 'win32', appData: ctx.appData, env: { QODER_CN_REGISTRY_DB: regFile } });
  const viaRegistry = readSession('qoder-cn', ctxRegOnly, 'q2').session;
  assert.ok(viaRegistry, '注册表投影侧必须读得到');
  assert.deepEqual(sessionCoreFingerprints(viaRegistry), sessionCoreFingerprints(viaJsonl), '两路读出的核心指纹必须逐轮相等');
  fs.rmSync(empty, { recursive: true, force: true });
});

test('append：续写自己导入的会话时三层同步增长，宿主其他会话的投影行不受影响', () => {
  const { ctx, regFile } = setup();
  const db0 = new DatabaseSync(regFile);
  // 先放一条「宿主自己写的」会话，验证我们的删除-重建不会牵连它
  db0.exec('BEGIN');
  db0.prepare('INSERT INTO chat_sessions (session_id, title, cwd, created_at, updated_at) VALUES (?,?,?,?,?)').run('native-1', '宿主原生会话', 'D:/work/other', T0, T0 + 1000);
  db0.prepare('INSERT INTO chat_session_messages (session_id, message_id, turn_id, sequence, payload_json, source, created_at, updated_at, role) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('native-1', 'n1u', 'n1u', 1, JSON.stringify({ role: 'user', parts: [{ id: 'n1u:text:0', type: 'text', text: '宿主自己的话' }] }), 'sdk-projection', T0, T0, 'user');
  db0.exec('COMMIT');
  db0.close();

  const src = sourceSession();
  const r1 = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q3', mode: 'create', provenance: { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: src.id }, chain: [] }, force: true });
  assert.equal(r1.ok, true, r1.error);

  const appended = { ...src, turns: [...src.turns, { index: 2, role: 'user', startedAt: T0 + 5000, items: [messageItem('user', '第三轮问题', T0 + 5000), messageItem('assistant', '第三轮回答', T0 + 6000)] }], updatedAt: T0 + 6000 };
  const r2 = getWriter('qoder-cn').write(ctx, { session: appended, targetId: 'q3', mode: 'append', fromTurnIndex: 2, provenance: { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: src.id }, chain: [] } });
  assert.equal(r2.ok, true, JSON.stringify(r2));

  const back = readSession('qoder-cn', ctx, 'q3').session;
  assert.equal(back.turns.length, 3, `续写后应 3 轮，实际 ${back.turns.length}`);
  const reg = registryRows(regFile);
  assert.equal(reg.messages.filter((m) => m.session_id === 'q3').length, 6, '投影必须跟着补到 6 行');
  assert.equal(reg.messages.filter((m) => m.session_id === 'q3' && m.role === 'user').length, 3);
  assert.equal(reg.messages.filter((m) => m.session_id === 'native-1').length, 1, '宿主原生会话的投影行一条都不能少');
  assert.equal(reg.messages.find((m) => m.session_id === 'native-1').source, 'sdk-projection', '宿主原生日不得被我们改写');
  const lines = fs.readFileSync(r2.path, 'utf8').split('\n').filter(Boolean);
  assert.equal(JSON.parse(lines[0]).type, 'workspace-directories', '追加不能重复写头，也不能丢掉头');
  assert.equal(JSON.parse(lines.at(-1)).type, 'active-leaf');
});

test('注册表缺失时不假装成功：只写正文并明确警告', () => {
  const { ctx, regFile } = setup({ registry: false });
  assert.equal(regFile, null);
  const res = getWriter('qoder-cn').write(ctx, { session: sourceSession(), targetId: 'q4', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, '正文层写成功就该算成功（CLI 侧可见）');
  assert.ok(res.warnings.some((w) => w.startsWith('registry-db-absent')), `必须警告注册表没写成：${JSON.stringify(res.warnings)}`);
});

test('导入编排：claude → qoder-cn 一次成功，再跑一次是 skip，且列表能认出这条', () => {
  const { home, ctx } = setup();
  const id = 'cc000000-1111-2222-3333-444444444444';
  const dir = path.join(home, '.claude', 'projects', 'D--work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];
  let prev = null;
  ['第一问', '第二问'].forEach((t, i) => {
    rows.push({ type: 'user', uuid: `u${i}`, parentUuid: prev, timestamp: new Date(T0 + i * 1000).toISOString(), sessionId: id, cwd: 'D:/work/demo', message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, timestamp: new Date(T0 + i * 1000 + 500).toISOString(), sessionId: id, cwd: 'D:/work/demo', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `${t}答` }] } });
    prev = `a${i}`;
  });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['qoder-cn'] }), { apply: true });
  assert.equal(first[0].ok, true, JSON.stringify({ error: first[0].error, verify: first[0].verify }));
  assert.equal(first[0].verify.ok, true, JSON.stringify(first[0].verify));
  const targetId = first[0].targetId;

  const listed = listSessions('qoder-cn', ctx);
  assert.ok(listed.sessions.some((s) => s.id === targetId), '导入的会话必须能被本工具再列出来');

  const again = planImport(ctx, { from: ['claude'], into: ['qoder-cn'] });
  assert.equal(again.pairs[0].action, 'skip', `二次导入应 skip，实际 ${again.pairs[0].action}`);
});

test('append 不得把宿主已有的标题降级成本地推导的首条用户文本', () => {
  const { ctx, regFile } = setup();
  const src = sourceSession();
  const r1 = getWriter('qoder-cn').write(ctx, { session: src, targetId: 'q5', mode: 'create', provenance: null, force: true });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(registryRows(regFile).sessions[0].title, 'M38 三层写入');

  // 续写时读回来的 session 常只剩「从首条用户文本推导」的标题，甚至为空
  const appended = { ...src, title: '', turns: [...src.turns, { index: 2, role: 'user', startedAt: T0 + 9000, items: [messageItem('user', '追加', T0 + 9000)] }], updatedAt: T0 + 9500 };
  const r2 = getWriter('qoder-cn').write(ctx, { session: appended, targetId: 'q5', mode: 'append', fromTurnIndex: 2, provenance: null });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(registryRows(regFile).sessions[0].title, 'M38 三层写入', '已有标题必须保留');
});

test('append 到「只有注册表行、没有 jsonl」的桌面原生会话：整份物化且不删宿主历史行', () => {
  const { home, ctx, regFile } = setup();
  // 宿主原生的桌面会话：注册表里有行 + 宿主自己写的投影行，但 projects 下没有 jsonl
  const db = new DatabaseSync(regFile);
  db.exec('BEGIN');
  db.prepare('INSERT INTO chat_sessions (session_id, title, cwd, created_at, updated_at, extra_json) VALUES (?,?,?,?,?,?)')
    .run('native-nojsonl', '宿主桌面原生会话', 'D:/work/demo', T0, T0 + 1000, JSON.stringify({ source: 'workspace' }));
  db.prepare('INSERT INTO chat_session_messages (session_id, message_id, turn_id, sequence, payload_json, source, created_at, updated_at, role) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('native-nojsonl', 'h1', 'h1', 1, JSON.stringify({ role: 'user', parts: [{ id: 'h1:text:0', type: 'text', text: '宿主里的第一轮' }] }), 'sdk-projection', T0, T0, 'user');
  db.prepare('INSERT INTO chat_session_messages (session_id, message_id, turn_id, sequence, payload_json, source, created_at, updated_at, role) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('native-nojsonl', 'assistant:h1', 'h1', 2, JSON.stringify({ role: 'assistant', parts: [{ id: 'h1:text:0', type: 'text', text: '宿主里的回答' }] }), 'sdk-projection', T0, T0, 'assistant');
  db.exec('COMMIT');
  db.close();

  const src = sourceSession('native-nojsonl');
  src.variant = 'qoder-cn';
  src.cwd = 'D:/work/demo';
  const appended = { ...src, turns: [...src.turns, { index: 2, role: 'user', startedAt: T0 + 9000, items: [messageItem('user', '新追加的一轮', T0 + 9000), messageItem('assistant', '追加回答', T0 + 9500)] }], updatedAt: T0 + 9500 };
  const res = getWriter('qoder-cn').write(ctx, { session: appended, targetId: 'native-nojsonl', mode: 'append', fromTurnIndex: 2, provenance: null, force: true });
  assert.equal(res.ok, true, JSON.stringify(res));

  const file = path.join(home, '.qoder-cn', 'projects', 'D--work-demo', 'native-nojsonl.jsonl');
  assert.ok(fs.existsSync(file), '必须物化出完整正文 jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'workspace-directories', '物化的正文要带头，不能只有增量');
  const s = readSession('qoder-cn', ctx, 'native-nojsonl').session;
  assert.equal(s.turns.length, 3, `读回应 3 轮，实际 ${s.turns.length}`);
  const reg = registryRows(regFile);
  const hostRows = reg.messages.filter((m) => m.session_id === 'native-nojsonl' && m.source === 'sdk-projection');
  assert.equal(hostRows.length, 2, '宿主自己写的两行投影一条都不能被删');
  assert.ok(reg.messages.some((m) => m.source === 'cli-import' && m.sequence > 2), '新增轮次要补上 cli-import 投影');
});

test('非项目落点：qoder 用宿主自生成的日期桶，写进去后读回来仍判非项目', () => {
  const { ctx, regFile } = setup();
  const TID = '4d682a1a878c0123456789';
  const src = { ...sourceSession(), cwd: '', scope: 'none' };
  const place = resolvePlacement(src, 'qoder-cn', ctx, { targetId: TID });
  assert.equal(place.source, 'bucket:generated', JSON.stringify(place));
  assert.equal(place.scope, 'none');
  assert.match(N(place.directory), /\/Documents\/QoderCN\/2026-10-08\/4d682a1a878c$/, `叶子应是 targetId 前 12 位：${place.directory}`);

  const res = getWriter('qoder-cn').write(ctx, {
    session: { ...src, cwd: place.directory },
    targetId: TID,
    mode: 'create',
    provenance: { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: 'src-1' }, chain: [] },
    force: true,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(fs.existsSync(place.directory), `落点目录必须真的建出来（宿主按目录打开）：${place.directory}`);
  assert.equal(N(registryRows(regFile).sessions[0].cwd), N(place.directory), '注册表行的 cwd 要指向桶内目录');

  const back = readSession('qoder-cn', ctx, TID).session;
  assert.equal(back.scope, 'none', `读回来必须仍判非项目，否则宿主会把它挂成幽灵项目：${back.scope}/${back.scopeReason}`);
  assert.equal(N(back.cwd), N(place.directory));
});

test('list 标题优先用桌面注册表的标题（侧栏显示的名字），jsonl 推导的只兜底', () => {
  const { ctx, regFile } = setup();
  const id = 'a6ddbeab-0000-4000-8000-000000000000';
  const dir = path.join(ctx.home, '.qoder-cn', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'workspace-directories', directories: ['D:/x'] },
    { type: 'user', uuid: 'u1', timestamp: '2026-10-29T02:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'D:/00-demo-app 生成规格文档' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const db = new DatabaseSync(regFile);
  db.prepare('INSERT INTO chat_sessions (session_id, title, cwd, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, '电话机器人', 'D:/x', T0, T0);
  db.close();

  const row = listSessions('qoder-cn', ctx, {}).sessions.find((s) => s.id === id);
  assert.ok(row, '会话必须被列出');
  assert.equal(row.title, '电话机器人', `应显示宿主侧栏的标题，实际 ${row.title}`);
});

test('read 与 list 同口径：标题取宿主注册表（jsonl 没有标题字段）', () => {
  const { ctx, regFile } = setup();
  const id = 'b1c2d3e4-0000-4000-8000-000000000000';
  const dir = path.join(ctx.home, '.qoder-cn', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'workspace-directories', directories: ['D:/x'] },
    { type: 'user', uuid: 'u1', timestamp: '2026-10-29T02:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'D:/00-demo-app 生成规格文档' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  const db = new DatabaseSync(regFile);
  db.prepare('INSERT INTO chat_sessions (session_id, title, cwd, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, '电话机器人', 'D:/x', T0, T0);
  db.close();

  const s = readSession('qoder-cn', ctx, id).session;
  assert.equal(s.title, '电话机器人', `read 的标题也必须是宿主侧栏那个，实际 ${s.title}`);
});
