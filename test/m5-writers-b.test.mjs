// M5 测试：Tier B writers（opencode / mimo / dsh / kilo）+ 写后校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { mkMimoDb, mkOpencodeDb, OPENCODE_DDL } from './db-fixtures.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m5-${name}-`));
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// 2 轮 claude 源：含 reasoning / tool_use / tool_result
function makeClaudeSource(home, id = 'bbbbbbbb-1111-2222-3333-444444444444') {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${id}.jsonl`);
  writeJsonl(file, [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: id, cwd: 'D:/work/demo' },
    {
      parentUuid: 'u1',
      type: 'assistant',
      message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: '先读文件' }, { type: 'text', text: '第一轮回答' }, { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } }] },
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: id, cwd: 'D:/work/demo' },
    { parentUuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:04.000Z', sessionId: id, cwd: 'D:/work/demo' },
    { parentUuid: 'u3', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:05.000Z', sessionId: id, cwd: 'D:/work/demo' },
  ]);
  return { file, id };
}

function run(ctx, from, into) {
  const plan = planImport(ctx, { from, into });
  const results = executePlan(ctx, plan, { apply: true });
  return { plan, results };
}



test('opencode（v2）：create + 校验 + 幂等', () => {
  const home = tmpHome('oc');
  makeClaudeSource(home);
  const dataDir = path.join(home, 'ocdata');
  mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const first = run(ctx, ['claude'], ['opencode']);
  const r = first.results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  const src = readSession('claude', ctx, 'bbbbbbbb-1111-2222-3333-444444444444').session;
  const dst = readSession('opencode', ctx, r.targetId).session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(src));
  assert.equal(dst.origin.variant, 'claude');
  assert.equal(dst.cwd, 'D:/work/demo');

  const again = run(ctx, ['claude'], ['opencode']);
  assert.equal(again.plan.pairs[0].action, 'skip');

  const list = listSessions('opencode', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.variant, 'claude');
});

test('opencode（v2）：append 追加新轮次', () => {
  const home = tmpHome('oc-append');
  const src = makeClaudeSource(home);
  const dataDir = path.join(home, 'ocdata');
  mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const first = run(ctx, ['claude'], ['opencode']);
  const targetId = first.results[0].targetId;

  const rows = fs.readFileSync(src.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ parentUuid: 'a2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] }, uuid: 'u4', timestamp: '2026-01-01T00:00:06.000Z', sessionId: src.id, cwd: 'D:/work/demo' });
  writeJsonl(src.file, rows);

  const second = run(ctx, ['claude'], ['opencode']);
  assert.equal(second.plan.pairs[0].action, 'append');
  assert.equal(second.results[0].ok, true, JSON.stringify(second.results[0]));

  const dst = readSession('opencode', ctx, targetId).session;
  assert.equal(dst.turns.length, 3);
  const srcSession = readSession('claude', ctx, src.id).session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(srcSession));
});

test('mimo（三表）：create + 校验 + provenance 落在 permission', () => {
  const home = tmpHome('mimo');
  makeClaudeSource(home);
  const mimoHome = path.join(home, 'mimohome');
  mkMimoDb(path.join(mimoHome, 'mimocode.db'));
  const ctx = ctxFor(home, { MIMO_HOME: mimoHome });

  const { results } = run(ctx, ['claude'], ['mimo']);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  const dst = readSession('mimo', ctx, r.targetId).session;
  const src = readSession('claude', ctx, 'bbbbbbbb-1111-2222-3333-444444444444').session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(src));
  assert.equal(dst.origin.variant, 'claude');

  const list = listSessions('mimo', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.variant, 'claude');
});

test('dsh（多帧 zstd）：create + 校验 + 幂等', () => {
  const home = tmpHome('dsh');
  makeClaudeSource(home);
  const dshHome = path.join(home, 'dshhome');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const ctx = ctxFor(home, { DSH_HOME: dshHome });

  const first = run(ctx, ['claude'], ['dsh']);
  const r = first.results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));
  assert.ok(fs.existsSync(r.path));

  const dst = readSession('dsh', ctx, r.targetId).session;
  const src = readSession('claude', ctx, 'bbbbbbbb-1111-2222-3333-444444444444').session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(src));
  assert.equal(dst.title, src.title, '标题必须原样带过去');
  assert.equal(dst.origin.variant, 'claude');

  const again = run(ctx, ['claude'], ['dsh']);
  assert.equal(again.plan.pairs[0].action, 'skip');
});

test('kilo（任务目录）：create + 校验', () => {
  const home = tmpHome('kilo');
  makeClaudeSource(home);
  const appData = path.join(home, 'AppData', 'Roaming');
  fs.mkdirSync(path.join(appData, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });
  const ctx = ctxFor(home);

  const { results } = run(ctx, ['claude'], ['kilo']);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  const dst = readSession('kilo', ctx, r.targetId).session;
  const src = readSession('claude', ctx, 'bbbbbbbb-1111-2222-3333-444444444444').session;
  assert.deepEqual(sessionCoreFingerprints(dst), sessionCoreFingerprints(src));

  // Kilo 原生任务 ID 是 uuid 形态（Cline 血统里 cline 用时间戳、kilo 用 uuid）
  assert.match(r.targetId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('只读目标被拒绝：cursor / doubao', () => {
  const home = tmpHome('readonly');
  makeClaudeSource(home);
  const ctx = ctxFor(home);
  for (const target of ['cursor', 'doubao']) {
    const plan = planImport(ctx, { from: ['claude'], into: [target] });
    const results = executePlan(ctx, plan, { apply: true });
    assert.equal(results[0].ok, false, target);
    assert.equal(results[0].error, 'writer-not-implemented', target);
  }
});

