// M84 测试：opencode v2 的导入会话必须登记 event_sequence 计数器
//
// 故障（真机取证）：导入的会话有 78 条消息（seq 0..77 连续无空洞），
// 但 event_sequence 表里**没有**它那一行。宿主写新消息前先读这一行来分配 seq
// （上游 packages/core/src/bus.ts：latest = row?.seq ?? -1 → seq = latest + 1），
// 没有行 ⇒ 宿主以为从 0 开始 ⇒ 分配出 0 ⇒ 撞上 session_message 的唯一索引
// (session_id, seq) ⇒ UNIQUE constraint failed ⇒ /api/session/<id>/model 500
// ⇒ 这条会话再也续写不了（上游 anomalyco/opencode#56528 同族）。
//
// 修法（对齐上游 fork 路径 packages/core/src/session/projector.ts 末尾的
// Bus.reserveSequence(db, sessionID, copiedSeq)）：把计数器抬到已占用 seq 之上。
// 本文件锁三件事：
//   1. 写入路径写完消息后必须登记计数器（seq = 该会话已占用的最大 seq）；
//   2. 自愈路径必须给「计数器落后」的导入会话补登记，且幂等；
//   3. 计数器只进不退（宿主推进过的值不能被拉低），且只碰我们自己写过的行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';

const TS = 1792635493378;
const TARGET = 'ses_e1729a950ffeSeq00000000001';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m84-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

// 宿主 v2 库的关键表。event_sequence 是本次的主角：没有它，宿主分配 seq 会从 0 重来。
function mkDb(file, { withEventSequence = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`);
  if (withEventSequence) {
    db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT NOT NULL PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`);
  }
  db.close();
  return file;
}

function fakeSession(home) {
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id: 'src-1',
    title: '导入会话',
    cwd,
    createdAt: TS,
    updatedAt: TS + 10,
    model: 'm-1',
    turns: [
      {
        items: [
          { kind: 'message', role: 'user', text: '第一轮问题', ts: TS },
          { kind: 'message', role: 'assistant', text: '第一轮回答', ts: TS + 1 },
          { kind: 'message', role: 'user', text: '第二轮问题', ts: TS + 2 },
          { kind: 'message', role: 'assistant', text: '第二轮回答', ts: TS + 3 },
        ],
      },
    ],
  };
}

/** 宿主分配 seq 的口径（上游 bus.ts）：读计数器，没有行就当 -1 */
function hostNextSeq(db, sessionId) {
  const row = db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?').get(sessionId);
  return (row?.seq ?? -1) + 1;
}

function counterOf(file, sessionId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?').get(sessionId);
    return row ? Number(row.seq) : null;
  } finally {
    db.close();
  }
}

function maxMsgSeq(file, sessionId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM session_message WHERE session_id = ?').get(sessionId);
    return Number(row?.m ?? -1);
  } finally {
    db.close();
  }
}

/** 宿主往导入会话里写一条新消息（照上游 commitDurableEvent 的口径分配 seq） */
function hostWriteMessage(file, sessionId) {
  const db = new DatabaseSync(file);
  try {
    const seq = hostNextSeq(db, sessionId);
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
      .run(`host_${seq}`, sessionId, 'assistant', seq, TS, TS, JSON.stringify({ agent: 'build', model: { id: 'x', providerID: 'p' }, content: [] }));
    return seq;
  } finally {
    db.close();
  }
}

test('写入路径：写完消息必须登记 event_sequence 计数器，宿主续写不再撞唯一索引', () => {
  const home = tmpHome('write');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const out = opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));

  const maxMsg = maxMsgSeq(file, TARGET);
  assert.ok(maxMsg >= 0, '应写入消息');
  assert.equal(counterOf(file, TARGET), maxMsg, '计数器必须等于该会话已占用的最大 seq（宿主下一个 seq = max+1）');

  // 宿主续写：分配出的 seq 不能与已有消息重复
  const used = hostWriteMessage(file, TARGET);
  assert.ok(used > maxMsg, `宿主分配的 seq 必须越过导入行：${used} <= ${maxMsg}`);
});

test('没有计数器时宿主会分配出 0 并撞唯一索引（复现真机 500 的成因）', () => {
  const home = tmpHome('repro');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });

  // 复现故障态：把计数器行删掉（等价于旧版本导入器写出的会话）
  const db = new DatabaseSync(file);
  db.prepare('DELETE FROM event_sequence WHERE aggregate_id = ?').run(TARGET);
  db.close();

  assert.equal(hostNextSeq(new DatabaseSync(file, { readOnly: true }), TARGET), 0, '没有计数器 ⇒ 宿主从 0 开始分配');
  assert.throws(() => hostWriteMessage(file, TARGET), /UNIQUE constraint failed/, '缺计数器时宿主续写必须失败（与真机 500 同因）');
});

test('自愈路径：计数器落后的导入会话要补登记，且幂等', () => {
  const home = tmpHome('repair');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });

  // 制造故障态：历史导入的行有消息、没有计数器
  const db = new DatabaseSync(file);
  db.prepare('DELETE FROM event_sequence WHERE aggregate_id = ?').run(TARGET);
  db.close();
  const maxMsg = maxMsgSeq(file, TARGET);

  const out = opencodeWriter.repair(ctx);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.seqFixed >= 1, `必须补登记计数器：${JSON.stringify(out)}`);
  assert.equal(counterOf(file, TARGET), maxMsg, '补登记的计数器必须等于已占用的最大 seq');

  // 幂等：第二次自愈没有可改的
  const again = opencodeWriter.repair(ctx);
  assert.equal(again.seqFixed, 0, JSON.stringify(again));
  assert.equal(counterOf(file, TARGET), maxMsg, '幂等自愈不得改动计数器');

  // 自愈后宿主续写不再撞唯一索引
  const used = hostWriteMessage(file, TARGET);
  assert.ok(used > maxMsg, `宿主分配的 seq 必须越过导入行：${used} <= ${maxMsg}`);
});

test('计数器只进不退：宿主已推进的值不能被自愈拉低', () => {
  const home = tmpHome('monotonic');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });

  const db = new DatabaseSync(file);
  db.prepare('UPDATE event_sequence SET seq = 500 WHERE aggregate_id = ?').run(TARGET);
  db.close();

  opencodeWriter.repair(ctx);
  assert.equal(counterOf(file, TARGET), 500, '自愈不得把宿主已推进的计数器拉低');
});

test('只碰我们自己写过的行：宿主原生会话没有计数器也不补', () => {
  const home = tmpHome('native');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });

  // 造一条宿主原生行（无来源标记）+ 一条宿主自己的消息，但不给它登记计数器
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES ('ses_native000000000000000001','p1','native','D:/x','','原生会话','2.1.4','build',NULL,?,?)`).run(TS, TS);
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
              VALUES ('m_native','ses_native000000000000000001','user',0,?,?,?)`).run(TS, TS, JSON.stringify({ text: 'hi' }));
  db.prepare('DELETE FROM event_sequence WHERE aggregate_id = ?').run('ses_native000000000000000001');
  db.close();

  opencodeWriter.repair(ctx);
  assert.equal(counterOf(file, 'ses_native000000000000000001'), null, '宿主原生行绝不能被补登记');
});

test('老库没有 event_sequence 表时写入照常（不因缺表而失败）', () => {
  const home = tmpHome('legacy');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'), { withEventSequence: false });
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const out = opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.lines > 0, '消息仍要写进去');

  const rep = opencodeWriter.repair(ctx);
  assert.equal(rep.ok, true, JSON.stringify(rep));
});
