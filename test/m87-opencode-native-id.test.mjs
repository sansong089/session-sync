// M87 测试：opencode 会话 ID 必须是宿主原生 Identifier 形态（Zen 网关续写契约）
//
// 真机交叉实验取证（2026-11-18，同一时刻、同项目、同模型）：
//   - ses_+12hex+14base62（len26，原生格式）→ 续写成功；
//   - ses_+32hex（session-sync 旧派生）→ 429 FreeUsageLimitError，与历史体量无关
//     （截断到 1 条小消息仍 429）、与 provenance 无关（带同样 metadata 的原生格式 id 成功）；
//   - len26 但前缀全 0（解出 epoch 0）→ 仍 429 ⇒ 前缀必须解出 sane 时间戳；
//   - 原生前缀 + 32hex 后缀 → 429 ⇒ 长度/结构也必须原生。
// 宿主 Identifier 算法（二进制实证）：r=now*0x1000+counter; a=~r; 前缀= a 的低 48 位六字节 hex；
// 后缀=14 个 base62。counter=1 时低 12 位恒为 ffe（与真机原生行吻合）。
// 因此派生 id = ses_ + 降序12hex(源 createdAt) + 14base62(originKey 哈希)：确定性保留去重不变量。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';
import { mintNativeOpencodeId, isNativeOpencodeId, importedNativeId } from '../src/opencode-id.mjs';
import { targetSessionId, originKeyOf } from '../src/identity.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';

const TS = 1794896204614;
const LEGACY = 'ses_6b943313918652eaa681534371f6ade1';
const PROV = JSON.stringify({ 'session-sync': { origin: { variant: 'workbuddy-cn', sessionId: 'src-1' }, tool: 'session-sync', v: 1 } });

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m87-${name}-`));
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
function seedImported(file, id, metadata) {
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'p1', 's', 'D:/x', '', '导入', 'session-sync/1', metadata, 'build', null, TS, TS);
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_u0', id, 'user', 0, TS, TS, JSON.stringify({ time: { created: TS }, text: '问题', files: [], agents: [] }));
  db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?,?,NULL)').run(id, 0);
  db.close();
}

test('派生形态：ses_+12hex+14base62，前缀可解回源时间戳，且确定性', () => {
  const key = 'workbuddy-cn:src-1';
  const a = mintNativeOpencodeId(key, TS);
  const b = mintNativeOpencodeId(key, TS);
  assert.equal(a, b, '同 (key,ts) 必须恒定复现（去重不变量）');
  assert.ok(isNativeOpencodeId(a), `必须是原生形态：${a}`);
  assert.notEqual(a, mintNativeOpencodeId('workbuddy-cn:src-2', TS), '不同 origin 必须不同 id');
  assert.notEqual(a, mintNativeOpencodeId(key, TS + 1), '不同 createdAt 前缀应不同');
  // 前缀只编码 r 的低 48 位 ⇒ 解回的是 now mod 2^36（48/12 位窗口），仍须与源 createdAt 同余
  const prefix = BigInt(`0x${a.slice(4, 16)}`);
  const M48 = 0xffffffffffffn;
  const now = (M48 - prefix - 1n) / 0x1000n;
  assert.equal(Number(now), TS % 68719476736, '前缀必须能解回源 createdAt（模 2^36 窗口，网关要求 sane 时间戳）');
  assert.equal(a.slice(13, 16), 'ffe', 'counter=1 时前缀低 12 位恒为 ffe（与真机原生行同）');
});

test('identity：opencode 目标 id 走原生派生且取源 createdAt；round-trip 保留原生 id', () => {
  const src = { id: 'src-1', variant: 'workbuddy-cn', createdAt: TS, updatedAt: TS + 1, origin: { variant: 'workbuddy-cn', sessionId: 'src-1' } };
  assert.equal(targetSessionId('opencode', src), mintNativeOpencodeId(originKeyOf(src), TS));
  const native = { id: 'ses_e1729a950ffeU6j3W0juW2Y2Fl', variant: 'opencode', createdAt: TS };
  assert.equal(targetSessionId('opencode', native), native.id, '导回 opencode 必须收敛到原生 id');
});

test('自愈迁移：ses_<32hex> 存量行改名成原生 id，消息与计数器一并搬，且幂等', () => {
  const home = tmpHome('migrate');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedImported(file, LEGACY, PROV);
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  const want = mintNativeOpencodeId('workbuddy-cn:src-1', TS);

  const first = opencodeWriter.repair(ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.renamed >= 1, `必须迁移旧 id：${JSON.stringify(first)}`);

  const db = new DatabaseSync(file, { readOnly: true });
  assert.ok(db.prepare('SELECT 1 FROM session_v2 WHERE id=?').get(want), '会话行必须改成原生 id');
  assert.equal(db.prepare('SELECT 1 FROM session_v2 WHERE id=?').get(LEGACY), undefined, '旧 id 不得残留');
  assert.equal(db.prepare('SELECT session_id FROM session_message WHERE id=?').get('msg_u0').session_id, want, '消息必须随迁');
  assert.ok(db.prepare('SELECT 1 FROM event_sequence WHERE aggregate_id=?').get(want), '计数器必须随迁');
  assert.equal(db.prepare('SELECT 1 FROM event_sequence WHERE aggregate_id=?').get(LEGACY), undefined, '不得留孤儿计数器');
  db.close();

  const again = opencodeWriter.repair(ctx);
  assert.equal(again.renamed, 0, JSON.stringify(again));
});

test('读侧收敛：迁移前 list 就暴露原生 id，且按原生 id 能读回旧行正文', () => {
  const home = tmpHome('read');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedImported(file, LEGACY, PROV);
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  const want = importedNativeId({ id: LEGACY, metadata: PROV, time_created: TS });

  const list = listSessions('opencode', ctx).sessions;
  const hit = list.find((s) => String(s.id) === want);
  assert.ok(hit, `list 必须暴露原生 id ${want}：${JSON.stringify(list.map((s) => s.id))}`);
  const back = readSession('opencode', ctx, want);
  assert.ok(back?.session, '按原生 id 必须能读回迁移前的旧行');
  assert.equal(back.session.turns.length, 1);
});

test('自愈不碰宿主原生会话（非原生格式的原生 id 也不改名）', () => {
  const home = tmpHome('native');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES ('ses_native000000000000000000001','p1','n','D:/x','','原生','2.1.4',NULL,'build',NULL,?,?)`).run(TS, TS);
  db.close();
  const out = opencodeWriter.repair(ctxFor(home, { OPENCODE_DATA_DIR: dataDir }));
  assert.equal(out.renamed, 0, JSON.stringify(out));
  const check = new DatabaseSync(file, { readOnly: true });
  assert.ok(check.prepare('SELECT 1 FROM session_v2 WHERE id=?').get('ses_native000000000000000000001'), '原生行 id 绝不能被改');
  check.close();
});