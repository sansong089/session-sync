// M15 测试：D1「归档的会话一律不导」在 planImport 里落地
// reader 侧仍然列出归档行（m11/m13 已锁），因为「目标已存在」判定必须看得见它们；
// 拦截只发生在挑选导入候选这一步 —— 不带任何开关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport } from '../src/import.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
const codexRows = (id, cwd) => [
  { timestamp: '2026-10-14T00:03:14.017Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-14T00:03:14.017Z', cwd, model: 'gpt-5' } },
  { timestamp: '2026-10-14T00:03:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看下这个目录' }] } },
  { timestamp: '2026-10-14T00:03:40.159Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] } },
];

test('planImport：archived 的源会话不进计划', () => {
  const root = tmpRoot('d1-plan');
  const ctx = ctxFor(root);
  const live = '01a13f28-22a1-7f20-9adc-062faf627101';
  const arch = '01a13f28-22a1-7f20-9adc-062faf627102';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T00-03-14-${live}.jsonl`), codexRows(live, 'D:/00-demo-app'));
  writeJsonl(path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-14T00-03-14-${arch}.jsonl`), codexRows(arch, 'D:/00-demo-app'));

  const plan = planImport(ctx, { from: ['codex'], into: ['claude'] });
  const ids = plan.pairs.map((p) => p.sourceId);
  assert.deepEqual(ids, [live], `归档会话不该进计划，实际: ${ids.join(',')}`);
  assert.equal(plan.archivedSkipped, 1, '静默丢弃要能在报告里被看见');
});

test('planImport：先去归档再去重 —— 归档的长副本不能把活跃副本挤掉', () => {
  const root = tmpRoot('d1-before-dedupe');
  const ctx = ctxFor(root);
  const live = '01a13f28-22a1-7f20-9adc-062faf6271a1';
  const arch = '01a13f28-22a1-7f20-9adc-062faf6271a2';
  const prov = { timestamp: '2026-10-14T00:03:15.000Z', type: 'session-sync-provenance', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: 's-dup' } } };
  // 两条都是「同一个原始会话 claude:s-dup」的副本：归档那条更长（3 轮），活跃那条 2 轮
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T00-03-14-${live}.jsonl`), [...codexRows(live, 'D:/00-demo-app'), prov]);
  writeJsonl(path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-14T00-03-14-${arch}.jsonl`), [
    ...codexRows(arch, 'D:/00-demo-app'),
    { timestamp: '2026-10-14T00:04:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再来一轮' }] } },
    { timestamp: '2026-10-14T00:04:40.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好' }] } },
    prov,
  ]);

  const plan = planImport(ctx, { from: ['codex'], into: ['claude'] });
  const ids = plan.pairs.map((p) => p.sourceId);
  assert.ok(ids.includes(live), `活跃副本必须进计划（归档那条只是更长，不能替它出场）：${ids.join(',')}`);
  assert.ok(!ids.includes(arch), '归档副本本身仍不进计划');
  assert.equal(plan.archivedSkipped, 1);
});

test('planImport：目标只有归档版本时仍算「已存在」，不重复新建', () => {
  const root = tmpRoot('d1-target');
  const ctx = ctxFor(root);
  const srcId = '01a13f28-22a1-7f20-9adc-062faf6271ff';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T00-03-14-${srcId}.jsonl`), codexRows(srcId, 'D:/00-demo-app'));
  // 目标 codex 里同一条会话躺在 archived_sessions（同 id 同源 → 同 targetId）
  writeJsonl(path.join(root, '.codex', 'archived_sessions', `rollout-2026-10-14T00-03-14-${srcId}.jsonl`), codexRows(srcId, 'D:/00-demo-app'));

  const plan = planImport(ctx, { from: ['codex'], into: ['codex'] });
  const p = plan.pairs.find((x) => x.sourceId === srcId && x.target === 'codex');
  assert.ok(p, '计划里应有这条');
  assert.equal(p.targetExists, true, '归档区里的同 id 必须被算作已存在');
  assert.notEqual(p.action, 'create');
});
