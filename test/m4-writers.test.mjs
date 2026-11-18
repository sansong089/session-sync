// M4 测试：Tier A writers + diff/fork 执行 + 写后校验（全部在临时 home 内，不触碰真实数据）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';
import { seedHostSeen } from './matrix-home.mjs';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}

function ctxFor(root) {
  // 目标宿主（pi / workbuddy-intl / freebuff / cline）垫出配置根，否则被写门按 ghost 拦下
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['pi', 'workbuddy-intl', 'freebuff', 'cline'],
  );
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// 构造一个 2 轮的 claude 源会话（含 reasoning / tool_use / tool_result）
function makeClaudeSource(home, id = 'aaaaaaaa-1111-2222-3333-444444444444') {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${id}.jsonl`);
  const lines = [
    {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] },
      uuid: 'u1',
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    {
      parentUuid: 'u1',
      isSidechain: false,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'm-1',
        content: [
          { type: 'thinking', thinking: '先读文件' },
          { type: 'text', text: '第一轮回答' },
          { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } },
        ],
      },
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    {
      parentUuid: 'a1',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] },
      uuid: 'u2',
      timestamp: '2026-01-01T00:00:03.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    {
      parentUuid: 'u2',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] },
      uuid: 'u3',
      timestamp: '2026-01-01T00:00:04.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    {
      parentUuid: 'u3',
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] },
      uuid: 'a2',
      timestamp: '2026-01-01T00:00:05.000Z',
      sessionId: id,
      cwd: 'D:/work/demo',
    },
    { type: 'ai-title', aiTitle: '演示会话', sessionId: id },
  ];
  writeJsonl(file, lines);
  return { file, id };
}

function run(ctx, from, into, extra = {}) {
  const plan = planImport(ctx, { from, into, ...extra });
  const results = executePlan(ctx, plan, { apply: true });
  return { plan, results };
}

test('claude → pi：create + 校验通过 + 幂等 skip', () => {
  const home = tmpHome('m4-pi');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['pi']);
  assert.equal(first.plan.pairs.length, 1);
  assert.equal(first.plan.pairs[0].action, 'create');
  const r0 = first.results[0];
  assert.equal(r0.ok, true, JSON.stringify(r0));
  assert.equal(r0.verify.ok, true, JSON.stringify(r0.verify));

  // 目标 IR 核心指纹与源一致
  const source = readSession('claude', ctx, src.id).session;
  const target = readSession('pi', ctx, r0.targetId).session;
  assert.deepEqual(sessionCoreFingerprints(target), sessionCoreFingerprints(source));
  assert.equal(target.origin.variant, 'claude');
  assert.equal(target.origin.sessionId, src.id);

  // 再跑一次：同 ID → skip
  const second = run(ctx, ['claude'], ['pi']);
  assert.equal(second.plan.pairs[0].action, 'skip');
  assert.equal(second.plan.pairs[0].reason, 'identical');
});

test('claude → workbuddy-intl：create + 校验 + provenance 落在 session-meta', () => {
  const home = tmpHome('m4-wb');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  const { results } = run(ctx, ['claude'], ['workbuddy-intl']);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  const s = readSession('workbuddy-intl', ctx, r.targetId).session;
  assert.equal(s.origin.variant, 'claude');
  assert.equal(s.title, '演示会话');
  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.sessionId, src.id);
});

test('跨链路收敛：claude → pi → workbuddy-intl 与 claude → workbuddy-intl 命中同一会话', () => {
  const home = tmpHome('m4-conv');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 链路 A：claude → pi
  const a = run(ctx, ['claude'], ['pi']);
  assert.equal(a.results[0].ok, true);

  // 链路 B：claude → workbuddy-intl（直导）
  const b = run(ctx, ['claude'], ['workbuddy-intl']);
  assert.equal(b.results[0].ok, true);
  const directId = b.results[0].targetId;

  // 链路 C：pi（已是导入副本）→ workbuddy-intl
  const c = run(ctx, ['pi'], ['workbuddy-intl']);
  assert.equal(c.plan.pairs.length, 1);
  assert.equal(c.plan.pairs[0].targetId, directId, '不同路径必须派生同一目标 ID');
  assert.equal(c.plan.pairs[0].action, 'skip', '不得复制成第二份会话');

  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.sessionId, src.id);
});

test('round-trip：claude → pi → claude 收敛回原生会话，不产生副本', () => {
  const home = tmpHome('m4-rt');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  run(ctx, ['claude'], ['pi']);
  const back = run(ctx, ['pi'], ['claude']);

  assert.equal(back.plan.pairs.length, 1);
  assert.equal(back.plan.pairs[0].targetId, src.id, 'round-trip 目标 ID 必须等于原生 ID');
  assert.equal(back.plan.pairs[0].action, 'skip');

  const files = fs.readdirSync(path.join(home, '.claude', 'projects', 'D--work-demo'));
  assert.equal(files.filter((f) => f.endsWith('.jsonl')).length, 1, '不应新增文件');
});

test('append：源新增轮次 → 追加到导入会话（续接 parentId 链）', () => {
  const home = tmpHome('m4-append');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['pi']);
  const targetId = first.results[0].targetId;

  // 源新增第三轮
  const file = src.file;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({
    parentUuid: 'a2',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] },
    uuid: 'u4',
    timestamp: '2026-01-01T00:00:06.000Z',
    sessionId: src.id,
    cwd: 'D:/work/demo',
  });
  rows.push({
    parentUuid: 'u4',
    isSidechain: false,
    type: 'assistant',
    message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第三轮回答' }] },
    uuid: 'a3',
    timestamp: '2026-01-01T00:00:07.000Z',
    sessionId: src.id,
    cwd: 'D:/work/demo',
  });
  writeJsonl(file, rows);

  const second = run(ctx, ['claude'], ['pi']);
  assert.equal(second.plan.pairs[0].action, 'append');
  assert.equal(second.plan.pairs[0].at, 2);
  assert.equal(second.results[0].ok, true, JSON.stringify(second.results[0]));

  const target = readSession('pi', ctx, targetId).session;
  assert.equal(target.turns.length, 3);
  const source = readSession('claude', ctx, src.id).session;
  assert.deepEqual(sessionCoreFingerprints(target), sessionCoreFingerprints(source));

  // 幂等：再跑一次应 skip
  const third = run(ctx, ['claude'], ['pi']);
  assert.equal(third.plan.pairs[0].action, 'skip');
});

test('fork：目标被本地改动后分叉，fork ID 确定且重复执行收敛', () => {
  const home = tmpHome('m4-fork');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['pi']);
  const baseId = first.results[0].targetId;
  const piFile = first.results[0].path;

  // 模拟「导入后在目标侧被继续编辑」：改掉第 2 轮的用户文本
  const rows = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (r.type === 'message' && r.message?.role === 'user' && r.message.content?.[0]?.text === '第二轮问题') {
      r.message.content[0].text = '第二轮问题（目标侧改写）';
    }
  }
  writeJsonl(piFile, rows);

  const second = run(ctx, ['claude'], ['pi']);
  assert.equal(second.plan.pairs[0].action, 'fork', JSON.stringify(second.plan.pairs[0]));
  const forkId = second.plan.pairs[0].targetId;
  assert.notEqual(forkId, baseId);
  assert.equal(second.results[0].ok, true, JSON.stringify(second.results[0]));

  // 同一分歧再跑 → 同一 fork ID，且已存在 → 收敛为 skip
  const third = run(ctx, ['claude'], ['pi']);
  assert.equal(third.plan.pairs[0].targetId, forkId, 'fork ID 必须确定性');
  assert.equal(third.plan.pairs[0].action, 'skip');
  assert.match(third.plan.pairs[0].reason, /fork-converged/);

  const all = listSessions('pi', ctx, {}).sessions;
  assert.equal(all.length, 2, '原生 + fork 各一份，不应继续增长');
});

test('身份不同（目标 root 不是源的 root）时绝不 append，只 fork 并标 identity-mismatch', () => {
  const home = tmpHome('m4-native');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 目标侧先导出一个 pi 会话，再把 provenance 剥掉 → 它的 root 变成 pi:<id>，与源的 root 不同
  const derived = run(ctx, ['claude'], ['pi']);
  const targetId = derived.results[0].targetId;
  const piFile = derived.results[0].path;
  const rows = fs.readFileSync(piFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const stripped = rows.filter((r) => r.type !== 'session-sync/provenance');
  writeJsonl(piFile, stripped);
  // 删掉 sidecar，彻底去掉 provenance
  const sidecar = `${piFile}.session-sync.json`;
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);

  // 源新增一轮 → 目标身份已丢，必须 fork 而不是 append
  const file = src.file;
  const srcRows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  srcRows.push({
    parentUuid: 'a2',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '第三轮问题' }] },
    uuid: 'u9',
    timestamp: '2026-01-01T00:00:09.000Z',
    sessionId: src.id,
    cwd: 'D:/work/demo',
  });
  writeJsonl(file, srcRows);

  const second = run(ctx, ['claude'], ['pi']);
  const p = second.plan.pairs[0];
  assert.equal(p.sameLineage, false);
  assert.equal(p.action, 'fork', '身份不同不得被 append');
  assert.equal(p.reason, 'identity-mismatch');
  assert.notEqual(p.targetId, targetId);

  // 原文件未被改动
  const after = readSession('pi', ctx, targetId).session;
  assert.equal(after.turns.length, 2);
});

test('freebuff / cline 目标：create + 校验通过', () => {
  const home = tmpHome('m4-fb');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  for (const target of ['freebuff', 'cline']) {
    const { results } = run(ctx, ['claude'], [target]);
    const r = results[0];
    assert.equal(r.ok, true, `${target}: ${JSON.stringify(r)}`);
    assert.equal(r.verify.ok, true, `${target}: ${JSON.stringify(r.verify)}`);
  }

  const fb = listSessions('freebuff', ctx, {}).sessions;
  assert.equal(fb.length, 1);
  assert.equal(fb[0].cwd, 'D:/work/demo');

  const cl = listSessions('cline', ctx, {}).sessions;
  assert.equal(cl.length, 1);
});

test('批次内去重：同一原始会话的多个副本同批导入只写一次', () => {
  const home = tmpHome('m4-batch');
  const src = makeClaudeSource(home);
  const ctx = ctxFor(home);

  // 先造两份「同一原始会话」的副本：claude 原生 + pi 导入副本
  run(ctx, ['claude'], ['pi']);

  const { plan, results } = run(ctx, ['claude', 'pi'], ['workbuddy-intl']);
  const written = results.filter((r) => r.executed && r.ok);
  assert.equal(written.length, 1, '只应写入一次');
  assert.equal(plan.pairs.length, 1, JSON.stringify(plan.pairs.map((p) => [p.sourceVariant, p.sourceId])));
  assert.equal(plan.sourceDuplicates.length, 1, '同源同内容的副本在计划期被折入保留者');

  const list = listSessions('workbuddy-intl', ctx, {}).sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].provenance.origin.sessionId, src.id);
});

test('dry-run 不写盘', () => {
  const home = tmpHome('m4-dry');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  const plan = planImport(ctx, { from: ['claude'], into: ['pi'] });
  const results = executePlan(ctx, plan, { apply: false });
  assert.equal(results[0].dryRun, true);
  // ctxFor 已按写门契约垫出 pi 配置根（.pi/）；dry-run 不该再往下造会话目录
  assert.equal(fs.existsSync(path.join(home, '.pi', 'agent', 'sessions')), false);
});
