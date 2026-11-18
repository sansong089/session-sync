// M33 测试：原生会话可续写（Phase 1）
//
// 规则：append 判据 = 身份（originKey 相等）+ 内容（目标是源的严格前缀），与目标是否原生无关。
// 写侧：原生目标 append 剥离 provenance（保持原生），并用目标现有 cwd/scope，不 relocate。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { mintTargetId, originKeyOf } from '../src/identity.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m33-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['cline', 'pi'],
  );
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function provenance(variant, sessionId) {
  return { tool: 'session-sync', v: 1, origin: { variant, sessionId }, chain: [{ variant, sessionId, at: 1 }] };
}

// claude JSONL 会话；withProv 时在首行挂 provenance（= 导入副本）
function claudeRows({ id, cwd, texts, prov }) {
  const rows = [];
  if (prov) rows.push({ type: 'session-sync-provenance', 'session-sync': prov, timestamp: '2026-01-01T00:00:00.000Z' });
  let parent = null;
  texts.forEach((text, i) => {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const uuid = `u${i}`;
    rows.push({
      parentUuid: parent,
      isSidechain: false,
      type: role,
      message: { role, ...(role === 'assistant' ? { model: 'm' } : {}), content: [{ type: 'text', text }] },
      uuid,
      timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
      sessionId: id,
      cwd,
    });
    parent = uuid;
  });
  return rows;
}

function run(ctx, from, into, opts = {}) {
  const plan = planImport(ctx, { from, into, ...opts });
  const results = executePlan(ctx, plan, { apply: true, lock: false });
  return { plan, results };
}

function mkCodexNative(home, id, cwd, texts) {
  const file = path.join(home, '.codex', 'sessions', '2026', '10', '08', `rollout-2026-10-08T18-38-21-${id}.jsonl`);
  const rows = [{ timestamp: '2026-10-08T18:38:21.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-10-08T18:38:21.000Z', cwd } }];
  texts.forEach((text, i) => {
    rows.push({
      timestamp: `2026-10-08T18:38:2${i}.000Z`,
      type: 'response_item',
      payload: { type: 'message', role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: i % 2 === 0 ? 'input_text' : 'output_text', text }] },
    });
  });
  writeJsonl(file, rows);
  return file;
}

// ---------- codex：原生根会话 + 外部副本续写 → append 回原生，不产生 fork ----------

test('codex round-trip：副本续写导回原生会话 → append（不 fork、不写 provenance）', () => {
  const home = tmpHome('codex-append');
  const X = '01a13f28-22a1-7f20-9adc-062faf6271c9';
  const rollout = mkCodexNative(home, X, 'D:/work/x', ['第一问', '第一答']);
  const C = 'c0c0c0c0-1111-2222-3333-444444444444';
  writeJsonl(path.join(home, '.claude', 'projects', 'D--work-x', `${C}.jsonl`), claudeRows({ id: C, cwd: 'D:/work/x', texts: ['第一问', '第一答', '第二问（副本续写）', '第二答（副本续写）'], prov: provenance('codex', X) }));
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['codex']);
  const pair = first.plan.pairs.find((p) => p.sourceId === C);
  assert.equal(pair.sameLineage, true, '副本 origin=codex:X 与原生 X 同一身份');
  assert.equal(pair.action, 'append', JSON.stringify(pair));
  assert.equal(pair.targetId, X, 'round-trip 必须落到原生 ID');
  assert.equal(first.results.find((r) => r.sourceId === C).ok, true);

  // 原生会话被续写、仍是 1 条；没有 fork、没有 provenance 行、没有 sidecar
  const rows = readJsonl(rollout);
  assert.equal(rows.filter((r) => r.type === 'session-sync-provenance').length, 0, '原生会话 append 必须剥离 provenance');
  assert.equal(fs.existsSync(`${rollout}.session-sync.json`), false, '原生会话不得写 provenance sidecar');
  const list = listSessions('codex', ctx, {}).sessions;
  assert.equal(list.length, 1, JSON.stringify(list.map((s) => [s.id, s.origin])));
  assert.equal(list[0].provenance, null, '原生会话 append 后仍应显示为原生');
  assert.equal(readSession('codex', ctx, X).session.turns.length, 2);

  // 再续一轮 → 继续 append 到同一条，不新增会话
  writeJsonl(path.join(home, '.claude', 'projects', 'D--work-x', `${C}.jsonl`), claudeRows({ id: C, cwd: 'D:/work/x', texts: ['第一问', '第一答', '第二问（副本续写）', '第二答（副本续写）', '第三问'], prov: provenance('codex', X) }));
  const second = run(ctx, ['claude'], ['codex']);
  const p2 = second.plan.pairs.find((p) => p.sourceId === C);
  assert.equal(p2.action, 'append', JSON.stringify(p2));
  assert.equal(p2.targetId, X);
  assert.equal(readSession('codex', ctx, X).session.turns.length, 3);
  assert.equal(listSessions('codex', ctx, {}).sessions.length, 1, '不得累积 fork');
});

// ---------- claude：原生目标 append 使用目标 cwd，不跟随源落点 ----------

test('claude round-trip：append 使用目标既有 cwd，源目录不覆盖原生会话的归属', () => {
  const home = tmpHome('claude-cwd');
  const X = 'x0x0x0x0-1111-2222-3333-444444444444';
  const nativeFile = path.join(home, '.claude', 'projects', 'D--work-x', `${X}.jsonl`);
  writeJsonl(nativeFile, claudeRows({ id: X, cwd: 'D:/work/x', texts: ['问题一', '回答一'] }));
  const C = 'c1c1c1c1-1111-2222-3333-444444444444';
  writeJsonl(path.join(home, '.claude', 'projects', 'D--other', `${C}.jsonl`), claudeRows({ id: C, cwd: 'D:/other', texts: ['问题一', '回答一', '问题二'], prov: provenance('claude', X) }));
  const ctx = ctxFor(home);

  const { plan, results } = run(ctx, ['claude'], ['claude']);
  const pair = plan.pairs.find((p) => p.sourceId === C);
  assert.equal(pair.action, 'append', JSON.stringify(pair));
  assert.equal(pair.targetId, X);
  assert.equal(results.find((r) => r.sourceId === C).ok, true);

  const rows = readJsonl(nativeFile);
  const added = rows.filter((r) => r.type === 'user' && r.message?.content?.[0]?.text === '问题二');
  assert.equal(added.length, 1, '新增轮次必须写进原生会话文件');
  assert.equal(added[0].cwd, 'D:/work/x', 'append 必须沿用目标 cwd，而不是源的 D:/other');
});

// ---------- 导入目标：append 照常保留 provenance ----------

test('导入会话 append 后 provenance 保持（身份不丢）', () => {
  const home = tmpHome('imported-keep');
  const C = 'c2c2c2c2-1111-2222-3333-444444444444';
  const file = path.join(home, '.claude', 'projects', 'D--work-x', `${C}.jsonl`);
  writeJsonl(file, claudeRows({ id: C, cwd: 'D:/work/x', texts: ['一', '二'] }));
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['pi']);
  const targetId = first.results[0].targetId;
  assert.deepEqual(readSession('pi', ctx, targetId).session.origin, { variant: 'claude', sessionId: C }, 'create 的源 root=claude:C');

  // 源续写一轮 → append；目标 provenance 必须还在
  writeJsonl(file, claudeRows({ id: C, cwd: 'D:/work/x', texts: ['一', '二', '三'] }));
  const second = run(ctx, ['claude'], ['pi']);
  const p = second.plan.pairs[0];
  assert.equal(p.action, 'append', JSON.stringify(p));
  const back = readSession('pi', ctx, targetId).session;
  assert.ok(back.origin, '导入会话 append 后必须保留 provenance');
  assert.deepEqual(back.origin, { variant: 'claude', sessionId: C });
  assert.match(JSON.stringify(back.turns), /三/, '新增轮次必须已追加');
});
// ---------- 跨落点形态的续写：正文原来只在 legacy 任务目录里 ----------

test('cline：追加到「正文只有 legacy 任务目录」的原生会话时会话库整份落盘', () => {
  const home = tmpHome('cline-crossform');
  const ctx = ctxFor(home);
  ctx.env.CLINE_DATA_DIR = path.join(home, '.cline', 'data');
  const X = '1739441239770';
  const taskDir = path.join(ctx.appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', X);
  fs.mkdirSync(taskDir, { recursive: true });
  // 三轮：每轮一条 user 文本 + 一条 assistant（content 内多块，正是真机里会被拆轮的那种形状）
  const api = [];
  for (let i = 0; i < 3; i++) {
    api.push({ role: 'user', ts: 1739441239770 + i * 1000, content: [{ type: 'text', text: `第${i + 1}问` }, { type: 'text', text: `第${i + 1}问的补充` }] });
    api.push({ role: 'assistant', ts: 1739441239771 + i * 1000, content: [{ type: 'text', text: `第${i + 1}答` }] });
  }
  fs.writeFileSync(path.join(taskDir, 'api_conversation_history.json'), JSON.stringify(api), 'utf8');

  const src = readSession('cline', ctx, X).session;
  assert.equal(src.turns.length, 3, `任务目录读回应 3 轮，实际 ${src.turns.length}`);
  assert.ok(!fs.existsSync(path.join(ctx.env.CLINE_DATA_DIR, 'sessions', X)), '会话库此时不该有这份正文');

  // 源 = 原生会话 + 1 轮，按真机扫的做法写回同一变体的一个副本（provenance 指回 X）
  const copyId = mintTargetId('cline', `${originKeyOf(src)}#m33`);
  const turns = [...src.turns, { index: 3, role: 'user', startedAt: Date.now(), items: [{ kind: 'message', role: 'user', text: '第4问', ts: Date.now() }, { kind: 'message', role: 'assistant', text: '第4答', ts: Date.now() }] }];
  const srcIR = { ...src, turns, updatedAt: Date.now() };
  const put = getWriter('cline').write(ctx, {
    session: srcIR,
    targetId: copyId,
    mode: 'create',
    provenance: { tool: 'session-sync', v: 1, origin: { variant: 'cline', sessionId: X }, chain: [] },
    force: true,
  });
  assert.equal(put.ok, true, put.error);

  const plan = planImport(ctx, { from: ['cline', 'pi'], into: ['cline'], ids: [copyId] });
  const pair = plan.pairs.find((p) => p.target === 'cline');
  assert.equal(pair.action, 'append', JSON.stringify(pair));
  assert.equal(String(pair.targetId), X, '应续写回原生会话自己的 ID');

  const res = executePlan(ctx, plan, { apply: true }).find((r) => r.target === 'cline');
  assert.equal(res.ok, true, JSON.stringify({ error: res.error, verify: res.verify }));
  assert.equal(res.verify.ok, true, `读回校验必须过：${JSON.stringify(res.verify)}`);

  const back = readSession('cline', ctx, X).session;
  assert.equal(back.turns.length, 4, `整份物化后应 4 轮，实际 ${back.turns.length}`);
  assert.match(JSON.stringify(back.turns), /第1问/, '原有轮次不能因为「只写增量」而消失');
  assert.ok(!back.origin, '原生会话续写后仍然不带 provenance');
});
