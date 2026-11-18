// M85 测试：opencode v2 导入消息必须写全「宿主判定回复是否完整」的那几个字段
//
// 背景（上游源码实证）：
//   - 上游 FinishReason = stop | length | tool-calls | content-filter | error | unknown
//     （packages/schema/src/llm.ts），写在 assistant 消息的 `finish` 上；
//   - 宿主转写历史时按 `cut = message.error !== undefined || message.finish === undefined`
//     判定「这条回复是不是被中断的流」——**缺 finish 一律当成被截断**，
//     于是末尾内容块不重放、尾部 reasoning 被丢弃
//     （packages/core/src/session/runner/to-llm-message.ts）；
//   - 工具部件另有 `executed`（是否 provider 侧托管执行）与 `time.ran`
//     （宿主靠 `time.ran !== undefined || state.status === 'completed'` 判定工具真跑过）。
//
// 真机对照（native session ses_e17522c9…）：assistant 顶层键
// [time, agent, model, content, finish, rawFinish, cost, tokens]，
// finish 取值 tool-calls×10 / stop×1；工具部件 executed=false、time={created, ran, completed}。
// 导入行这三样全缺 → 续写时历史被当成残缺流，reasoning/providerMetadata 全丢。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';

const TS = 1792635493378;
const TARGET = 'ses_e1729a950ffeMsg00000000002';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m85-${name}-`));
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
          { kind: 'message', role: 'user', text: '问题', ts: TS },
          // 一轮里先出工具调用、再出文本回答 → 这条回复以文本收尾 → finish 应为 stop
          { kind: 'tool_call', callId: 'call_1', name: 'read', input: { path: 'a.txt' }, ts: TS + 1 },
          { kind: 'tool_result', callId: 'call_1', name: 'read', output: 'body', ts: TS + 2 },
          { kind: 'message', role: 'assistant', text: '回答', ts: TS + 3 },
        ],
      },
      {
        items: [
          { kind: 'message', role: 'user', text: '第二个问题', ts: TS + 4 },
          // 这一轮以工具调用收尾（没有后续文本）→ finish 应为 tool-calls
          { kind: 'tool_call', callId: 'call_2', name: 'read', input: { path: 'b.txt' }, ts: TS + 5 },
        ],
      },
    ],
  };
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

test('写入路径：assistant 必须带 finish，工具必须带 executed 与 time.ran', () => {
  const home = tmpHome('write');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const out = opencodeWriter.write(ctx, { session: fakeSession(home), targetId: TARGET, mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));

  const rows = rowsOf(file, TARGET);
  const assistants = rows.filter((r) => r.type === 'assistant');
  assert.ok(assistants.length >= 2, '应有两条 assistant 消息');

  for (const a of assistants) {
    assert.ok(typeof a.data.finish === 'string', 'assistant 消息必须带 finish');
    assert.ok(
      ['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].includes(a.data.finish),
      `finish 取值必须是上游 FinishReason 之一：${a.data.finish}`,
    );
    assert.ok(Number.isFinite(a.data.time?.completed), 'assistant 仍要有 time.completed');
  }
  // 以文本收尾的那轮 → stop；以工具收尾的那轮 → tool-calls
  assert.equal(assistants[0].data.finish, 'stop', '以文本收尾的回复 finish=stop');
  assert.equal(assistants[1].data.finish, 'tool-calls', '以工具调用收尾的回复 finish=tool-calls');

  // 工具部件
  const tools = assistants.flatMap((a) => a.data.content.filter((c) => c.type === 'tool'));
  assert.ok(tools.length >= 2, '应有工具部件');
  for (const t of tools) {
    assert.equal(t.executed, false, '源侧本地执行的工具 executed 必须为 false');
    assert.ok(Number.isFinite(t.time?.ran), '工具必须有 time.ran');
    assert.ok(Number.isFinite(t.time?.created), '工具必须有 time.created');
    assert.ok(t.time.ran >= t.time.created, 'ran 不得早于 created');
  }
});

test('自愈路径：历史导入行缺 finish/executed/ran 的要补齐，且幂等', () => {
  const home = tmpHome('repair');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  // 造一条「旧版本导入器」写出的行：assistant 无 finish，工具无 executed/ran
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(TARGET, 'p1', 'x', 'D:/x', '', '旧导入', 'session-sync/1', 'build', null, TS, TS);
  const legacyAssistant = {
    time: { created: TS, completed: TS },
    agent: 'build',
    model: { id: 'm-1', providerID: 'session-sync' },
    content: [
      { type: 'reasoning', text: '想一下' },
      { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'a' }, content: [{ type: 'text', text: 'body' }] }, time: { created: TS, completed: TS } },
      { type: 'text', text: '回答' },
    ],
  };
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_legacy_1', TARGET, 'assistant', 0, TS, TS, JSON.stringify(legacyAssistant));
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_legacy_2', TARGET, 'user', 1, TS, TS, JSON.stringify({ time: { created: TS }, text: '问题', files: [], agents: [] }));
  db.close();

  const first = opencodeWriter.repair(ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.msgFixed >= 1, `必须补齐消息字段：${JSON.stringify(first)}`);

  const fixed = rowsOf(file, TARGET).find((r) => r.type === 'assistant');
  assert.equal(fixed.data.finish, 'stop', '末块是文本 → finish=stop');
  const tool = fixed.data.content.find((c) => c.type === 'tool');
  assert.equal(tool.executed, false, '工具要补 executed=false');
  assert.ok(Number.isFinite(tool.time?.ran), '工具要补 time.ran');

  // 幂等：第二次自愈没有可改的
  const again = opencodeWriter.repair(ctx);
  assert.equal(again.msgFixed, 0, JSON.stringify(again));
  const fixed2 = rowsOf(file, TARGET).find((r) => r.type === 'assistant');
  assert.deepEqual(fixed2.data, fixed.data, '二次自愈不得改动已补齐的行');
});

test('自愈只碰我们自己写过的行：宿主原生会话不被改写', () => {
  const home = tmpHome('native');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES ('ses_native000000000000000000001','p1','n','D:/x','','原生','2.1.4','build',NULL,?,?)`).run(TS, TS);
  const nativeAssistant = {
    time: { created: TS, completed: TS },
    agent: 'build',
    model: { id: 'm', providerID: 'opencode' },
    content: [{ type: 'text', text: '原生回答' }],
  };
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_native_1', 'ses_native000000000000000000001', 'assistant', 0, TS, TS, JSON.stringify(nativeAssistant));
  db.close();

  opencodeWriter.repair(ctx);
  const after = rowsOf(file, 'ses_native000000000000000000001').find((r) => r.type === 'assistant');
  assert.equal(after.data.finish, undefined, '原生会话绝不能被补 finish');
});
