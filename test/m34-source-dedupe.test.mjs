// M34 测试：计划期源侧去重（Phase 2）
//
// 规则：同 origin 多副本先按摘要排序，但**判定必须读 IR 算核心指纹**（轮次少不一定是前缀）：
//   - 严格前缀 / 完全相同 → 丢弃短副本，provenance/account 并入保留者
//   - 分叉 → 全部保留（执行期各自落位：一条基础 + 一条 fork）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { listSessions } from '../src/readers/index.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m34-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['pi'],
  );
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function provenance(originVariant, originId) {
  return { tool: 'session-sync', v: 1, origin: { variant: originVariant, sessionId: originId }, chain: [{ variant: originVariant, sessionId: originId, at: 1 }] };
}
function claudeRows({ id, cwd, texts, prov }) {
  const rows = [{ type: 'session-sync-provenance', 'session-sync': prov, timestamp: '2026-01-01T00:00:00.000Z' }];
  let parent = null;
  texts.forEach((text, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    rows.push({
      parentUuid: parent,
      isSidechain: false,
      type: role,
      message: { role, ...(role === 'assistant' ? { model: 'm' } : {}), content: [{ type: 'text', text }] },
      uuid: `u${i}`,
      timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
      sessionId: id,
      cwd,
    });
    parent = `u${i}`;
  });
  return rows;
}
function mkClaudeCopy(home, id, texts, prov) {
  writeJsonl(path.join(home, '.claude', 'projects', 'D--w', `${id}.jsonl`), claudeRows({ id, cwd: 'D:/w', texts, prov }));
}
function mkCodexCopy(home, id, texts, prov) {
  const rows = [{ timestamp: '2026-10-08T18:38:21.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd: 'D:/w' } }];
  texts.forEach((text, i) => {
    rows.push({
      timestamp: `2026-10-08T18:38:2${i}.000Z`,
      type: 'response_item',
      payload: { type: 'message', role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: i % 2 === 0 ? 'input_text' : 'output_text', text }] },
    });
  });
  rows.push({ timestamp: '2026-10-08T18:38:30.000Z', type: 'session-sync-provenance', 'session-sync': prov });
  writeJsonl(path.join(home, '.codex', 'sessions', '2026', '10', '08', `rollout-2026-10-08T18-38-21-${id}.jsonl`), rows);
}
function run(ctx, from, into) {
  const plan = planImport(ctx, { from, into });
  const results = executePlan(ctx, plan, { apply: true, lock: false });
  return { plan, results };
}

const P = 'p0p0p0p0-1111-2222-3333-444444444444';

test('C1 ⊂ C2：短副本在计划期被丢弃（摘要只排序，内容才算前缀）', () => {
  const home = tmpHome('prefix');
  mkClaudeCopy(home, 'c1c1c1c1-0000-0000-0000-000000000001', ['一', '二'], provenance('pi', P));
  mkCodexCopy(home, 'c2c2c2c2-0000-0000-0000-000000000002', ['一', '二', '三', '四'], provenance('pi', P));
  const ctx = ctxFor(home);

  const { plan, results } = run(ctx, ['claude', 'codex'], ['pi']);
  assert.equal(plan.pairs.length, 1, JSON.stringify(plan.pairs.map((p) => [p.sourceVariant, p.sourceId])));
  assert.equal(plan.pairs[0].sourceVariant, 'codex', '保留更长的那份');
  assert.equal(plan.sourceDuplicates.length, 1, JSON.stringify(plan.sourceDuplicates));
  assert.equal(plan.sourceDuplicates[0].dropped.variant, 'claude');

  assert.equal(results.filter((r) => r.executed && r.ok).length, 1);
  const list = listSessions('pi', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.match(JSON.stringify(list[0].title), /一|四/);
});

test('分叉副本（同 origin、同长度、内容不同）：计划期都保留，执行期各落一条', () => {
  const home = tmpHome('diverge');
  mkClaudeCopy(home, 'd1d1d1d1-0000-0000-0000-000000000001', ['一', '二A'], provenance('pi', P));
  mkCodexCopy(home, 'd2d2d2d2-0000-0000-0000-000000000002', ['一', '二B'], provenance('pi', P));
  const ctx = ctxFor(home);

  const { plan, results } = run(ctx, ['claude', 'codex'], ['pi']);
  assert.equal(plan.pairs.length, 2, JSON.stringify(plan.pairs.map((p) => [p.sourceVariant, p.action])));
  assert.equal(plan.sourceDuplicates.length, 0);
  assert.equal(new Set(plan.pairs.map((p) => p.targetId)).size, 1, '同一身份 → 同一基础槽位');
  assert.equal(results.filter((r) => r.executed && r.ok).length, 2, '第二条在执行期判为 fork');

  const list = listSessions('pi', ctx, {}).sessions;
  assert.equal(list.length, 2, JSON.stringify(list.map((s) => s.id)));
  const ids = new Set(list.map((s) => s.id));
  assert.equal(ids.size, 2);
});

test('完全相同副本：只留一条，provenance/account 并入保留者', () => {
  const home = tmpHome('identical');
  mkClaudeCopy(home, 'e1e1e1e1-0000-0000-0000-000000000001', ['一', '二'], provenance('pi', P));
  mkCodexCopy(home, 'e2e2e2e2-0000-0000-0000-000000000002', ['一', '二'], provenance('pi', P));
  const ctx = ctxFor(home);

  const { plan, results } = run(ctx, ['claude', 'codex'], ['pi']);
  assert.equal(plan.pairs.length, 1, JSON.stringify(plan.pairs.map((p) => [p.sourceVariant, p.sourceId])));
  assert.equal(plan.sourceDuplicates.length, 1);
  assert.equal(results.filter((r) => r.executed && r.ok).length, 1);
  assert.equal(listSessions('pi', ctx, {}).sessions.length, 1);
});