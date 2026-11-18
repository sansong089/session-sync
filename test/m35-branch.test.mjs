// M35 测试：A + branch（Phase 3）
//
//   - fork ID 稳定：父基准本地 ID + 分歧点 k + 第 k 轮指纹；分支增长不换 ID
//   - 续写基准在同 origin 的候选集里选：候选 ⊂ 源 → append 到最长候选（fork 也能被续写）
//   - 分叉再分叉：相对 LCP 最长的候选 fork；同内容重导 → fork-converged skip
//   - 归档只作存在性判定：X 归档但 fork 活跃 → append 到 fork
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m35-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function provenance(originVariant, originId) {
  return { tool: 'session-sync', v: 1, origin: { variant: originVariant, sessionId: originId }, chain: [{ variant: originVariant, sessionId: originId, at: 1 }] };
}
function mkCodexSession(home, id, texts, { prov = null, archived = false } = {}) {
  const dir = archived ? path.join(home, '.codex', 'archived_sessions') : path.join(home, '.codex', 'sessions', '2026', '10', '08');
  const rows = [{ timestamp: '2026-10-08T18:38:21.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd: 'D:/w' } }];
  texts.forEach((text, i) => {
    rows.push({
      timestamp: `2026-10-08T18:38:2${i}.000Z`,
      type: 'response_item',
      payload: { type: 'message', role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: i % 2 === 0 ? 'input_text' : 'output_text', text }] },
    });
  });
  if (prov) rows.push({ timestamp: '2026-10-08T18:38:30.000Z', type: 'session-sync-provenance', 'session-sync': prov });
  writeJsonl(path.join(dir, `rollout-2026-10-08T18-38-21-${id}.jsonl`), rows);
}
function mkClaudeCopy(home, id, texts, prov) {
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
      cwd: 'D:/w',
    });
    parent = `u${i}`;
  });
  writeJsonl(path.join(home, '.claude', 'projects', 'D--w', `${id}.jsonl`), rows);
}
function run(ctx, from, into) {
  const plan = planImport(ctx, { from, into });
  const results = executePlan(ctx, plan, { apply: true, lock: false });
  return { plan, results };
}

const X = '01a13f28-22a1-7f20-9adc-062faf6271c9';
const C = 'cc000000-1111-2222-3333-444444444444';
const C2 = 'cc000000-2222-2222-3333-444444444444';
const F = 'f0f0f0f0-1111-2222-3333-444444444444';

// X 2 轮；C 的第 2 轮与 X 不同 → 真分叉
const X_TEXTS = ['一', '甲', '二', '甲2'];
const C2T = ['一', '甲', '二', '乙2'];
const C3T = [...C2T, '三', '丙'];
const C4T = [...C3T, '四', '丁2'];
const C_DIVERGE2 = [...C2T, '三', '丙2']; // 与 fork（C3T）在第 3 轮分叉

test('fork ID 稳定：同一分歧点，源在分叉后多几轮不改变 fork ID', () => {
  // 场景 A：源只有 2 轮（分叉点之后 1 轮）
  const homeA = tmpHome('stable-a');
  mkCodexSession(homeA, X, X_TEXTS);
  mkClaudeCopy(homeA, C, C2T, provenance('codex', X));
  const a = run(ctxFor(homeA), ['claude'], ['codex']);
  const pairA = a.plan.pairs.find((p) => p.sourceId === C);
  assert.equal(pairA.action, 'fork', JSON.stringify(pairA));
  assert.notEqual(pairA.targetId, X);

  // 场景 B：源有 3 轮（同一分歧点，后面多一轮）→ 必须算出同一个 fork ID
  const homeB = tmpHome('stable-b');
  mkCodexSession(homeB, X, X_TEXTS);
  mkClaudeCopy(homeB, C, C3T, provenance('codex', X));
  const b = run(ctxFor(homeB), ['claude'], ['codex']);
  const pairB = b.plan.pairs.find((p) => p.sourceId === C);
  assert.equal(pairB.action, 'fork', JSON.stringify(pairB));
  assert.equal(pairB.targetId, pairA.targetId, 'fork ID 不能随分支长度漂移');
});

test('续写基准选候选集：源继续写 → append 到已有 fork，不新增 fork', () => {
  const home = tmpHome('append-fork');
  const ctx = ctxFor(home);
  mkCodexSession(home, X, X_TEXTS);
  mkClaudeCopy(home, C, C2T, provenance('codex', X));

  const first = run(ctx, ['claude'], ['codex']);
  const forkId = first.plan.pairs.find((p) => p.sourceId === C).targetId;
  assert.equal(listSessions('codex', ctx, {}).sessions.length, 2, 'X + fork');

  // 分支不进 provenance：origin 仍是原始会话 codex:X，chain 末尾是源的持有者 claude:C
  const fork = readSession('codex', ctx, forkId).session;
  assert.deepEqual(fork.origin, { variant: 'codex', sessionId: X }, 'fork 不得改 origin（否则同源去重与续写收敛都会断）');
  assert.equal(fork.chain.at(-1).sessionId, C, 'chain 末尾是源的持有者');
  assert.ok(!fork.chain.some((h) => String(h.sessionId) === String(forkId)), 'fork 自己的 id 不能进 provenance');

  // 源续写一轮 → 候选 fork 是源的前缀 → append 到 fork
  mkClaudeCopy(home, C, C3T, provenance('codex', X));
  const second = run(ctx, ['claude'], ['codex']);
  const p = second.plan.pairs.find((x) => x.sourceId === C);
  assert.equal(p.action, 'append', JSON.stringify(p));
  assert.equal(p.targetId, forkId, 'append 到已有 fork，不新开分支');
  const list = listSessions('codex', ctx, {}).sessions;
  assert.equal(list.length, 2, JSON.stringify(list.map((s) => s.id)));
  assert.equal(readSession('codex', ctx, forkId).session.turns.length, 3);
});

test('分叉再分叉：相对 LCP 最长的 fork 派生新分支；同内容重导收敛 skip', () => {
  const home = tmpHome('fork2');
  const ctx = ctxFor(home);
  mkCodexSession(home, X, X_TEXTS);
  mkClaudeCopy(home, C, C3T, provenance('codex', X));
  const first = run(ctx, ['claude'], ['codex']);
  const forkId = first.plan.pairs.find((p) => p.sourceId === C).targetId;

  // 另一条副本与 fork 共享前 2 轮，在第 3 轮真分叉
  mkClaudeCopy(home, C2, C_DIVERGE2, provenance('codex', X));
  const second = run(ctx, ['claude'], ['codex']);
  const p = second.plan.pairs.find((x) => x.sourceId === C2);
  assert.equal(p.action, 'fork', JSON.stringify(p));
  assert.notEqual(p.targetId, forkId, '必须在 fork 的更深分歧点上再分叉');
  assert.equal(listSessions('codex', ctx, {}).sessions.length, 3, 'X + fork + fork2');

  const third = run(ctx, ['claude'], ['codex']);
  const q = third.plan.pairs.find((x) => x.sourceId === C2);
  assert.equal(q.action, 'skip');
  assert.equal(q.targetId, p.targetId);
  assert.match(q.reason, /fork-converged/);
});

test('归档根 + 活跃 fork：允许 append 到 fork（归档只作存在性判定）', () => {
  const home = tmpHome('archived-root');
  const ctx = ctxFor(home);
  mkCodexSession(home, X, X_TEXTS, { archived: true });
  mkCodexSession(home, F, C3T, { prov: provenance('codex', X) }); // 活跃 fork
  mkClaudeCopy(home, C, C4T, provenance('codex', X));

  const { plan, results } = run(ctx, ['claude'], ['codex']);
  const p = plan.pairs.find((x) => x.sourceId === C);
  assert.equal(p.action, 'append', JSON.stringify(p));
  assert.equal(p.targetId, F, '有活跃候选时必须追加到 fork，而不是被归档根挡住');
  assert.equal(results.find((r) => r.sourceId === C).ok, true);

  assert.equal(readSession('codex', ctx, F).session.turns.length, 4);
  assert.equal(readSession('codex', ctx, X).session.turns.length, 2, '归档根不被写入');
});