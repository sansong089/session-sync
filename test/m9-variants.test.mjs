// M9 测试：变种覆盖 —— opencode v1（旧三表）回退、Roo Code 变体、--from 缺省 = 全部变体
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, ALL_VARIANTS } from '../src/hosts.mjs';
import { detectInstalled } from '../src/roots.mjs';
import { opencodeReader, schemaOf } from '../src/readers/opencode.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { WRITABLE_VARIANTS } from '../src/writers/index.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';

const SRC_ID = '99999999-1111-2222-3333-444444444444';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m9-${name}-`));
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function makeClaudeSource(home) {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    {
      parentUuid: 'u1',
      type: 'assistant',
      message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '第一轮回答' }, { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } }] },
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: SRC_ID,
      cwd: 'D:/work/demo',
    },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:04.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'u3', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:05.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ---------- opencode v1（旧三表 schema） ----------
test('opencode v1：旧三表 schema 自动识别并回退读取（与 v2 同一 reader）', () => {
  const home = tmpHome('ocv1');
  const dbFile = path.join(home, 'ocdata', 'opencode.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  // 只有 v1 三表，没有 session_v2 / session_message
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL)`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER)`);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'main', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.close();

  const db2 = new DatabaseSync(dbFile);
  db2.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)`).run(
    'ses_v1_1', 'global', 'slug-v1', 'D:/work/demo', 'v1 标题', 'legacy', 1000, 2000,
  );
  const msgId = 'msg_v1_1';
  db2.prepare(`INSERT INTO message (id, session_id, agent_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`).run(
    msgId, 'ses_v1_1', 'main', 1000, 1000,
    JSON.stringify({ role: 'user', time: { created: 1000 }, agent: 'build' }),
  );
  // 同一毫秒内的多个 part：用零填充序号保证顺序
  let seq = 0;
  const part = (data) => {
    const id = `prt_${String(seq++).padStart(8, '0')}_x`;
    db2.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)`).run(id, msgId, 'ses_v1_1', 1000, 1000, JSON.stringify(data));
  };
  part({ type: 'text', text: '第一轮问题' });
  db2.close();

  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: path.join(home, 'ocdata') });

  // schema 判定
  {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    assert.equal(schemaOf(d), 'v1');
    d.close();
  }

  const list = opencodeReader.list(ctx, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ses_v1_1');
  assert.equal(list[0].title, 'v1 标题');

  const s = opencodeReader.read(ctx, 'ses_v1_1');
  assert.ok(s, 'v1 会话应可读');
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].items[0].text, '第一轮问题');
  assert.equal(s.variant, 'opencode');
});

test('opencode v2：新 schema 仍走原路径（不被 v1 回退影响）', () => {
  const home = tmpHome('ocv2');
  const dbFile = path.join(home, 'ocdata', 'opencode.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)`).run(
    'ses_v2_1', 'global', 'slug-v2', 'D:/work/demo', 'v2 标题', '2.0', 1000, 2000,
  );
  db.prepare(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)`).run(
    'm1', 'ses_v2_1', 'user', 0, 1000, 1000, JSON.stringify({ time: { created: 1000 }, text: '第一轮问题', files: [] }),
  );
  db.close();

  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: path.join(home, 'ocdata') });
  const d = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(schemaOf(d), 'v2');
  d.close();

  const s = opencodeReader.read(ctx, 'ses_v2_1');
  assert.ok(s);
  assert.equal(s.turns[0].items[0].text, '第一轮问题');
});

// ---------- Roo Code ----------
test('Roo Code：作为 Cline 血统变体可读写（ROO_TASKS_DIRS 指定）', () => {
  const home = tmpHome('roo');
  makeClaudeSource(home);
  const tasksDir = path.join(home, 'roo-tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const ctx = ctxFor(home, { ROO_TASKS_DIRS: tasksDir });

  assert.ok(ALL_VARIANTS.includes('roo'), 'roo 应在变体注册表中');
  assert.ok(WRITABLE_VARIANTS.includes('roo'), 'roo 应可写');

  const plan = planImport(ctx, { from: ['claude'], into: ['roo'] });
  const res = executePlan(ctx, plan, { apply: true });
  const r = res[0];
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  // Roo 任务 ID 与 Cline 一样是 13 位时间戳形态
  assert.match(r.targetId, /^\d{13}$/);

  const dst = readSession('roo', ctx, r.targetId).session;
  const src = readSession('claude', ctx, SRC_ID).session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(src));
  assert.equal(dst.origin.variant, 'claude');

  // 幂等
  const again = planImport(ctx, { from: ['claude'], into: ['roo'] });
  assert.equal(again.pairs[0].action, 'skip');
});

// ---------- --from 缺省 = 全部变体 ----------
test('--from 省略 = 全部变体；auto = 只取已安装变体', () => {
  const home = tmpHome('default-from');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 省略 --from：所有变体都被当作源（未安装的返回 0 条），能拿到 claude 的会话
  const plan = planImport(ctx, { into: ['pi'] });
  assert.ok(plan.pairs.some((p) => p.sourceVariant === 'claude' && p.sourceId === SRC_ID), '缺省 --from 应包含 claude 会话');
  // 不应出现只读目标作源以外的东西
  assert.equal(plan.targets.length, 1);

  // detectInstalled 在该 home 里应只报 claude（其它目录没建）
  const installed = detectInstalled(ctx);
  assert.deepEqual(installed, ['claude']);

  // status 的 targets 数与 --into 一致
  assert.equal(plan.summary.create >= 1, true);
});

test('全部变体注册：21 个，含多变种家族', () => {
  // 多变种家族应同时存在
  for (const v of ['workbuddy-cn', 'workbuddy-intl', 'qoder-cn', 'qoder-intl', 'opencode', 'roo']) {
    assert.ok(ALL_VARIANTS.includes(v), v);
  }
  assert.equal(ALL_VARIANTS.length, 21);
});
