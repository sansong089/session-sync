// M86 测试：opencode v2 导入的 reasoning 必须带 provider 原生包裹（native），
// 且 assistant.model 用宿主真实 provider —— 否则续写时 reasoning 被网关丢弃。
//
// 机制（上游 packages/core/src/session/runner/to-llm-message.ts 实证）：
//   sameModel = message.model.providerID === model.providerID && message.model.id === model.id
//   reasoning 分支：sameModel ? {type:'reasoning', text, providerMetadata:{[key]: item.native}}
//                              : {type:'reasoning', text}   // 降级
//   providerMetadata(key, state) = state === undefined ? undefined : {[key]: state}
// 所以两处缺一不可：
//   1) providerID 必须是宿主真实 provider（占位 'session-sync' → sameModel=false → 降级）；
//   2) reasoning 部件必须带 native={reasoningField:'reasoning', reasoningDetails:[…]}，
//      否则即便 sameModel=true，providerMetadata(key, undefined)=undefined，照样降级。
// 降级后适配器把 reasoning 发成 reasoning_content，而 Zen 网关整段丢弃 reasoning_content
// （真机抓包：原生请求带 reasoning/reasoning_details，导入请求只有 reasoning_content）。
//
// 另覆盖 session_v2.version 同形（带 provenance 的行对齐宿主版本，识别改靠 metadata；
// 无 metadata 的行 version 是唯一识别标记，必须保留），以及自愈不改核心指纹（收敛安全）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';
import { opencodeReader } from '../src/readers/opencode.mjs';
import { turnCore } from '../src/ir.mjs';

const TS = 1792635493378;
const TARGET = 'ses_e1729a950ffeRsn00000000003';
const HOST_MODEL = { id: 'hy4-flash-free', providerID: 'opencode', variant: 'high' };

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m86-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}
function mkDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT NOT NULL PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`);
  db.close();
  return file;
}
// 宿主线：提供真实 model ref（含 variant）与宿主版本，供写入/自愈取同形值
function seedNative(file, model = HOST_MODEL, version = '2.1.4') {
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES ('ses_native000000000000000000001','p1','n','D:/x','','原生',?,?,?,?,?)`).run(version, 'build', model ? JSON.stringify(model) : null, TS, TS);
  db.close();
}
function rowsOf(file, sessionId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq').all(sessionId)
      .map((r) => ({ type: r.type, seq: r.seq, data: JSON.parse(r.data) }));
  } finally {
    db.close();
  }
}
function sessionWithReasoning(home) {
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id: 'src-r', title: '带推理的导入', cwd, createdAt: TS, updatedAt: TS + 10, model: 'm-1',
    turns: [{ items: [
      { kind: 'message', role: 'user', text: '问题', ts: TS },
      { kind: 'reasoning', text: '推理过程', ts: TS + 1 },
      { kind: 'message', role: 'assistant', text: '回答', ts: TS + 2 },
    ] }],
  };
}
const expectedNative = (text) => ({ reasoningField: 'reasoning', reasoningDetails: [{ type: 'reasoning.text', text, format: 'unknown', index: 0 }] });

test('写入路径：reasoning 部件带 native 包裹，assistant.model 用宿主真实 provider+variant', () => {
  const home = tmpHome('write');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedNative(file);
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const out = opencodeWriter.write(ctx, { session: sessionWithReasoning(home), targetId: TARGET, mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));

  const a = rowsOf(file, TARGET).find((r) => r.type === 'assistant');
  assert.ok(a, '应有 assistant 消息');
  assert.deepEqual(a.data.model, HOST_MODEL, 'model 必须是宿主真实 ref（含 variant），不能是占位 provider');
  const reasoning = a.data.content.find((c) => c.type === 'reasoning');
  assert.ok(reasoning, '应保留 reasoning 部件');
  assert.deepEqual(reasoning.native, expectedNative('推理过程'), 'reasoning 必须带 native 包裹（sameModel=true 时发成 reasoning+reasoning_details）');
  assert.ok(Number.isFinite(reasoning.time?.created) && Number.isFinite(reasoning.time?.completed), 'reasoning 部件带 time');
  // 与原生行同形的收尾/统计字段
  assert.equal(a.data.rawFinish, a.data.finish, 'rawFinish 与 finish 同值');
  assert.equal(a.data.cost, 0);
  assert.deepEqual(a.data.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.ok(Number.isFinite(a.data.time?.streamed), 'assistant 带 time.streamed');
});

test('自愈路径：占位 provider + 缺 native 的历史行补齐为宿主 ref（含 variant），且幂等', () => {
  const home = tmpHome('repair');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedNative(file);
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,NULL,?,?,NULL,?,?,?,?)`).run(TARGET, 'p1', 'x', 'D:/x', '旧导入', 'session-sync/1', 'build', null, TS, TS);
  const legacy = {
    time: { created: TS, completed: TS },
    agent: 'build',
    model: { id: 'm-1', providerID: 'session-sync' },
    content: [{ type: 'reasoning', text: '想一下' }, { type: 'text', text: '回答' }],
    finish: 'stop',
  };
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_r1', TARGET, 'assistant', 0, TS, TS, JSON.stringify(legacy));
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_r2', TARGET, 'user', 1, TS, TS, JSON.stringify({ time: { created: TS }, text: '问题', files: [], agents: [] }));
  db.close();

  const first = opencodeWriter.repair(ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.msgFixed >= 1, `必须补齐 reasoning/native：${JSON.stringify(first)}`);

  const fixed = rowsOf(file, TARGET).find((r) => r.type === 'assistant');
  assert.deepEqual(fixed.data.model, HOST_MODEL, '占位 provider 换成宿主真实 ref（含 variant）');
  const reasoning = fixed.data.content.find((c) => c.type === 'reasoning');
  assert.deepEqual(reasoning.native, expectedNative('想一下'), 'reasoning 补 native 包裹');
  assert.deepEqual(reasoning.time, { created: TS, completed: TS }, 'reasoning 补 time');
  assert.equal(fixed.data.rawFinish, 'stop');
  assert.deepEqual(fixed.data.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

  const again = opencodeWriter.repair(ctx);
  assert.equal(again.msgFixed, 0, JSON.stringify(again));
  const fixed2 = rowsOf(file, TARGET).find((r) => r.type === 'assistant');
  assert.deepEqual(fixed2.data, fixed.data, '二次自愈不得改动已补齐的行');
});

test('version 同形：带 provenance 的行对齐宿主版本；无 metadata 的行保留识别标记', () => {
  const home = tmpHome('version');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedNative(file, HOST_MODEL, '2.1.4');
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const prov = JSON.stringify({ 'session-sync': { origin: { variant: 'workbuddy-cn', sessionId: 'src-x' }, tool: 'session-sync', v: 1 } });
  const db = new DatabaseSync(file);
  // 带 provenance：version 应对齐到宿主 2.1.4（识别改靠 metadata）
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES ('ses_e1729a950ffeProv0000000001','p1','a','D:/x','','带prov','session-sync/1',?,'build',NULL,?,?)`).run(prov, TS, TS);
  // 无 metadata（appendToNative）：version 是唯一识别标记，必须保留 session-sync/1
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES ('ses_e1729a950ffeNoPr0000000001','p1','b','D:/x','','无prov','session-sync/1',NULL,'build',NULL,?,?)`).run(TS, TS);
  db.close();

  const r = opencodeWriter.repair(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.versionFixed, 1, `只对齐带 provenance 的那条：${JSON.stringify(r)}`);

  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('SELECT version FROM session_v2 WHERE id=?').get('ses_e1729a950ffeProv0000000001').version, '2.1.4');
  assert.equal(check.prepare('SELECT version FROM session_v2 WHERE id=?').get('ses_e1729a950ffeNoPr0000000001').version, 'session-sync/1', '无 metadata 的行 version 标记必须保留');
  // 原生行不被触碰
  assert.equal(check.prepare('SELECT version FROM session_v2 WHERE id=?').get('ses_native000000000000000000001').version, '2.1.4');
  check.close();

  // 幂等：二次自愈 version 不再变
  const again = opencodeWriter.repair(ctx);
  assert.equal(again.versionFixed, 0, JSON.stringify(again));
});

test('收敛安全：自愈补 native/provider 不改核心指纹（读侧 IR 逐字节一致）', () => {
  const home = tmpHome('converge');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedNative(file);
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,NULL,?,?,NULL,?,?,?,?)`).run(TARGET, 'p1', 'x', 'D:/x', '旧导入', 'session-sync/1', 'build', null, TS, TS);
  const legacy = {
    time: { created: TS, completed: TS }, agent: 'build', model: { id: 'm-1', providerID: 'session-sync' },
    content: [{ type: 'reasoning', text: '推理' }, { type: 'tool', id: 'c1', name: 'Read', state: { status: 'completed', input: { path: 'a' }, content: [{ type: 'text', text: 'body' }] }, time: { created: TS, completed: TS } }, { type: 'text', text: '回答' }],
    finish: 'stop',
  };
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_c1', TARGET, 'assistant', 0, TS, TS, JSON.stringify(legacy));
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_c2', TARGET, 'user', 1, TS, TS, JSON.stringify({ time: { created: TS }, text: '问题', files: [], agents: [] }));
  db.close();

  const coreHash = (s) => createHash('sha256').update(JSON.stringify((s.turns || []).map((t) => turnCore(t)))).digest('hex');
  const before = opencodeReader.read(ctx, TARGET);
  assert.ok(before, '自愈前读侧应能读出该导入会话');
  const hBefore = coreHash(before);

  opencodeWriter.repair(ctx);
  const after = opencodeReader.read(ctx, TARGET);
  assert.ok(after, '自愈后仍应认出导入会话（provenance/标记保留）');
  assert.equal(coreHash(after), hBefore, '补 native/provider/统计字段不得改变核心指纹（否则收敛判 fork）');
});