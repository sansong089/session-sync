// M7 测试：可写目标全矩阵 —— 全部可写目标逐个导入 + 读回校验 + round-trip 收敛
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { sessionCoreFingerprints } from '../src/ir.mjs';
import { WRITABLE_VARIANTS } from '../src/writers/index.mjs';
import { SRC_ID, setupHome } from './matrix-home.mjs';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

test('可写目标全矩阵：18 个目标逐个导入 + 校验 + round-trip 收敛', () => {
  const { ctx } = setupHome();
  // 源就是 claude，claude → claude 属自导（应为 skip），单独断言；其余目标逐一验证
  const selfPlan = planImport(ctx, { allowFamilyDuplicate: true, from: ['claude'], into: ['claude'] });
  assert.equal(selfPlan.pairs[0].action, 'skip', 'claude → claude 应为 skip');
  assert.equal(selfPlan.pairs[0].targetId, SRC_ID);

  const targets = WRITABLE_VARIANTS.filter((v) => v !== 'claude').sort();
  assert.equal(WRITABLE_VARIANTS.length, 19, `可写目标应为 19 个，实际 ${WRITABLE_VARIANTS.length}`);
  assert.equal(targets.length, 18);

  const srcSession = readSession('claude', ctx, SRC_ID).session;
  const want = sessionCoreFingerprints(srcSession);

  const written = [];
  for (const target of targets) {
    const plan = planImport(ctx, { allowFamilyDuplicate: true, from: ['claude'], into: [target] });
    const results = executePlan(ctx, plan, { apply: true });
    const r = results[0];
    assert.equal(r.ok, true, `${target}: ${JSON.stringify({ error: r.error, verify: r.verify })}`);
    assert.equal(r.verify.ok, true, `${target} verify: ${JSON.stringify(r.verify)}`);

    const dst = readSession(target, ctx, r.targetId).session;
    assert.deepEqual(sessionCoreFingerprints(dst), want, `${target} 核心指纹应与源一致`);
    assert.equal(dst.origin?.variant, 'claude', `${target} 应带 provenance`);
    assert.equal(dst.origin?.sessionId, SRC_ID, `${target} origin 应指向源会话`);
    written.push({ target, targetId: r.targetId });
  }

  // 幂等：全部再跑一次应全 skip
  for (const target of targets) {
    const plan = planImport(ctx, { allowFamilyDuplicate: true, from: ['claude'], into: [target] });
    assert.equal(plan.pairs[0].action, 'skip', `${target} 二次导入应 skip，实际 ${plan.pairs[0].action}`);
  }

  // round-trip：从每个目标导回 claude，应全部收敛到原生会话（skip，不产生新文件）
  for (const { target } of written) {
    const plan = planImport(ctx, { allowFamilyDuplicate: true, from: [target], into: ['claude'] });
    assert.equal(plan.pairs[0].targetId, SRC_ID, `${target} → claude 应收敛到原生 ID`);
    assert.equal(plan.pairs[0].action, 'skip', `${target} → claude 应 skip`);
  }
  const claudeFiles = fs.readdirSync(path.join(ctx.home, '.claude', 'projects', 'D--work-demo')).filter((f) => f.endsWith('.jsonl'));
  assert.equal(claudeFiles.length, 1, 'round-trip 不应在 claude 新增文件');
});

test('可写目标全矩阵：一次 import 同时写多个目标', () => {
  const { ctx } = setupHome();
  const targets = WRITABLE_VARIANTS.slice().sort();
  const plan = planImport(ctx, { allowFamilyDuplicate: true, from: ['claude'], into: targets });
  const results = executePlan(ctx, plan, { apply: true });

  assert.equal(results.length, targets.length);
  // claude → claude 是自导（skip，不写盘），其余 10 个必须写入成功
  const self = results.find((r) => r.target === 'claude');
  assert.equal(self.action, 'skip');
  const ok = results.filter((r) => r.executed && r.ok);
  assert.equal(ok.length, targets.length - 1, `应写入 ${targets.length - 1} 个（claude 自导为 skip），实际 ${ok.length}: ${JSON.stringify(results.filter((r) => r.executed && !r.ok).map((r) => [r.target, r.error]))}`);

  // 每个目标都恰好 1 个会话
  for (const t of targets) {
    const list = listSessions(t, ctx, {}).sessions;
    assert.equal(list.length, 1, `${t} 应有 1 个会话，实际 ${list.length}`);
  }
});
