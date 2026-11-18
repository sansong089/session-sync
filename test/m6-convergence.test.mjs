// M6 测试：多跳链路收敛、跨链路去重、chain 完整性、fork 跨路径确定性
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m6-${name}-`));
}

function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['pi', 'codex', 'workbuddy-intl'],
  );
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function makeClaudeSource(home, id = 'cccccccc-1111-2222-3333-444444444444') {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${id}.jsonl`);
  writeJsonl(file, [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: id, cwd: 'D:/work/demo' },
    { parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '第一轮回答' }] }, uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', sessionId: id, cwd: 'D:/work/demo' },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: id, cwd: 'D:/work/demo' },
    { parentUuid: 'u2', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:04.000Z', sessionId: id, cwd: 'D:/work/demo' },
  ]);
  return { file, id };
}

function run(ctx, from, into) {
  const plan = planImport(ctx, { from, into });
  const results = executePlan(ctx, plan, { apply: true });
  return { plan, results };
}

test('三跳链路收敛：claude→pi→codex→wb 与 claude→wb 命中同一会话', () => {
  const home = tmpHome('3hop');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 跳 1：claude → pi
  const h1 = run(ctx, ['claude'], ['pi']);
  assert.equal(h1.results[0].ok, true, JSON.stringify(h1.results[0]));
  const piId = h1.results[0].targetId;

  // 跳 2：pi → codex
  const h2 = run(ctx, ['pi'], ['codex']);
  assert.equal(h2.results[0].ok, true, JSON.stringify(h2.results[0]));
  const codexId = h2.results[0].targetId;

  // 跳 3：codex → workbuddy-intl
  const h3 = run(ctx, ['codex'], ['workbuddy-intl']);
  assert.equal(h3.results[0].ok, true, JSON.stringify(h3.results[0]));
  const hopId = h3.results[0].targetId;

  // 直连：claude → workbuddy-intl
  const direct = planImport(ctx, { from: ['claude'], into: ['workbuddy-intl'] });
  assert.equal(direct.pairs[0].targetId, hopId, '多跳与直连必须派生同一目标 ID');
  assert.equal(direct.pairs[0].action, 'skip', '不得复制成第二份');

  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 1);

  // chain 记录完整路径
  const wb = readSession('workbuddy-intl', ctx, hopId).session;
  assert.equal(wb.origin.variant, 'claude');
  assert.equal(wb.origin.sessionId, src.id);
  const hops = wb.chain.map((h) => h.variant);
  assert.deepEqual(hops, ['claude', 'pi', 'codex']);
  assert.equal(wb.chain[1].sessionId, piId);
  assert.equal(wb.chain[2].sessionId, codexId);

  // 三条链路的最终内容一致
  const claudeSess = readSession('claude', ctx, src.id).session;
  assert.deepEqual(sessionCoreFingerprints(wb), sessionCoreFingerprints(claudeSess));
});

test('同批多源同目标：三个副本只写一份', () => {
  const home = tmpHome('batch3');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  run(ctx, ['claude'], ['pi']);
  run(ctx, ['claude'], ['codex']);

  const { plan, results } = run(ctx, ['claude', 'pi', 'codex'], ['workbuddy-intl']);
  assert.equal(results.filter((r) => r.executed && r.ok).length, 1, '只写一次');
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.sourceDuplicates.length, 2, '另外两个副本在计划期被折入保留者');

  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 1);
});

test('多跳 append：链路中段追加后，末端能继续增量同步', () => {
  const home = tmpHome('hop-append');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  run(ctx, ['claude'], ['pi']);
  const h2 = run(ctx, ['pi'], ['workbuddy-intl']);
  const wbId = h2.results[0].targetId;

  // claude 源新增第三轮
  const rows = fs.readFileSync(src.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ parentUuid: 'a2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:05.000Z', sessionId: src.id, cwd: 'D:/work/demo' });
  writeJsonl(src.file, rows);

  // claude → pi 应 append
  const a1 = run(ctx, ['claude'], ['pi']);
  assert.equal(a1.plan.pairs[0].action, 'append');
  // pi → wb 也应 append
  const a2 = run(ctx, ['pi'], ['workbuddy-intl']);
  assert.equal(a2.plan.pairs[0].action, 'append', JSON.stringify(a2.plan.pairs[0]));
  assert.equal(a2.plan.pairs[0].targetId, wbId);

  const wb = readSession('workbuddy-intl', ctx, wbId).session;
  assert.equal(wb.turns.length, 3);
});

test('fork 跨路径确定性：同一分歧内容经不同链路得到同一 fork ID', () => {
  const home = tmpHome('fork-cross');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 目标侧：导入后被本地改写（制造分歧）
  const first = run(ctx, ['claude'], ['workbuddy-intl']);
  const baseId = first.results[0].targetId;
  const wbFile = first.results[0].path;
  const rows = fs.readFileSync(wbFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (r.type === 'message' && r.role === 'assistant' && r.content?.[0]?.text === '第二轮回答') {
      r.content[0].text = '第二轮回答（本地改写）';
    }
  }
  writeJsonl(wbFile, rows);

  // 路径 A（先跑）：经 pi 再进 wb → 分叉
  run(ctx, ['claude'], ['pi']);
  const a = run(ctx, ['pi'], ['workbuddy-intl']);
  assert.equal(a.plan.pairs[0].action, 'fork', JSON.stringify(a.plan.pairs[0]));
  const forkIdA = a.plan.pairs[0].targetId;
  assert.notEqual(forkIdA, baseId);

  // 路径 B：claude 直连 wb → 必须算出同一个 fork ID，且已存在 → 收敛为 skip
  const b = run(ctx, ['claude'], ['workbuddy-intl']);
  assert.equal(b.plan.pairs[0].targetId, forkIdA, '同一分歧内容经不同链路必须得到同一 fork ID');
  assert.equal(b.plan.pairs[0].action, 'skip');
  assert.match(b.plan.pairs[0].reason, /fork-converged/);

  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 2, '原生导入 + 一个 fork，不得继续增长');
});
