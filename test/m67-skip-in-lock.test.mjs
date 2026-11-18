// M67 测试：skip 分支必须在锁内自愈（review 2026-11-04 的 P0-1 另一半）
//
// skip 不是只读：relocate 会 unlink 旧文件、ensureIndex 写 sqlite、drift 整份重写正文。
// 这三件事在 acquireLock 之前做，等于「我们一边搬运/改名，另一个进程一边写同一个会话」。
//
// 另一条：批内被折叠的 pair（duplicateOf）不许自愈 —— 正主那条会自己做，
// 抢在正主之前写索引/搬文件会把刚落好的落点又改回去。
//
// 还有：repair 失败不能记「已修」，否则这个目标本轮永远不再重试（以前就是失败也 add）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { WRITERS } from '../src/writers/index.mjs';
import { lockPathFor, listLocks } from '../src/lock.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m67-${name}-`));
}

function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['pi', 'workbuddy-cn'],
  );
}

/** pi 形态的源会话（slug 由 cwd 派生，与 reader 同口径） */
function writePiSource(root, id, texts, cwd = 'D:/00-work/code/demo-app') {
  const slug = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const rows = [{ type: 'session', version: 3, id, cwd, timestamp: '2026-10-08T18:30:21.000Z' }];
  texts.forEach((t, i) => {
    rows.push({ type: 'message', timestamp: `2026-10-08T18:3${i}:21.000Z`, message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ type: 'message', timestamp: `2026-10-08T18:3${i}:30.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: `答${t}` }] } });
  });
  const file = path.join(root, '.pi', 'agent', 'sessions', slug, `2026-10-08T18-30-21-000Z_${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

const DIR_A = 'D:/work/dir-a';
const DIR_B = 'D:/work/dir-b';

/** 按 id 在整棵沙箱里找**正文**（不猜落点目录形态；sidecar / 备份不算第二份正文） */
function bodiesWithId(root, id) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.includes(id)) out.push(f);
        stack.push(f);
        continue;
      }
      if (!e.name.includes(id)) continue;
      if (/\.session-sync\.json$/.test(e.name)) continue; // provenance sidecar
      if (e.name.includes('.bak')) continue;
      out.push(f);
    }
  }
  return out;
}

test('skip 也要拿锁：锁被占用时不做落点自愈，且不算失败', () => {
  const root = tmpRoot('skip-lock');
  const prevLockDir = process.env.SESSION_SYNC_LOCK_DIR;
  process.env.SESSION_SYNC_LOCK_DIR = tmpRoot('skip-lockdir');
  try {
    writePiSource(root, 's1', ['第一轮']);
    const ctx = ctxFor(root);

    // 第一次导入到 workbuddy：落点在 A
    const first = executePlan(ctx, planImport(ctx, { from: ['pi'], into: ['workbuddy-cn'], cwd: DIR_A, placement: 'cwd' }), { apply: true, lock: false });
    assert.equal(first[0]?.ok, true, JSON.stringify(first[0]?.error));
    const targetId = String(first[0].targetId);
    const before = bodiesWithId(root, targetId);
    assert.equal(before.length, 1, `首次导入应产出一份正文，实际：${JSON.stringify(before)}`);
    const bodyA = before[0];

    // 第二次：内容没变（skip），但落点改到 B —— 正是 skip 分支要搬文件的场景
    const plan = planImport(ctx, { from: ['pi'], into: ['workbuddy-cn'], cwd: DIR_B, placement: 'cwd' });
    assert.equal(plan.pairs[0]?.action, 'skip', `内容没变应判 skip，实际 ${plan.pairs[0]?.action}`);

    // 造一个「另一个活进程持有」的锁（同进程内锁可重入，直接造锁文件）
    const lockFile = lockPathFor('target:workbuddy-cn');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-process', key: 'target:workbuddy-cn', at: Date.now() }), 'utf8');
    assert.ok(listLocks().some((l) => l.key === 'target:workbuddy-cn' && l.alive), '应能看到锁');

    const blocked = executePlan(ctx, plan, { apply: true, lockTimeoutMs: 150 });
    assert.equal(blocked[0]?.ok, true, 'skip 拿不到锁不该判失败（正文本来就没变）');
    assert.ok(
      (blocked[0]?.warnings ?? []).some((w) => /lock-timeout/.test(String(w))),
      `必须如实说明这次没做自愈：${JSON.stringify(blocked[0]?.warnings)}`,
    );
    assert.equal(blocked[0]?.relocated, undefined, '锁被占用时不许搬迁');
    assert.ok(fs.existsSync(bodyA), '锁被占用时正文必须原地不动（旧实现会照搬）');
    assert.equal(bodiesWithId(root, targetId).length, 1, '不许在半路另起一份');

    // 锁释放后重跑：这次 skip 自愈应当把正文搬到 B
    fs.unlinkSync(lockFile);
    const healed = executePlan(ctx, plan, { apply: true, lockTimeoutMs: 3000 });
    assert.equal(healed[0]?.relocated, true, `锁释放后应完成搬迁：${JSON.stringify(healed[0])}`);
    const after = bodiesWithId(root, targetId);
    assert.equal(after.length, 1, `搬迁后仍只能有一份正文：${JSON.stringify(after)}`);
    assert.notEqual(after[0], bodyA, '正文应已离开旧落点');
    assert.ok(after[0].replace(/\\/g, '/').includes('dir-b'), `正文应在新落点 B：${after[0]}`);
  } finally {
    if (prevLockDir === undefined) delete process.env.SESSION_SYNC_LOCK_DIR;
    else process.env.SESSION_SYNC_LOCK_DIR = prevLockDir;
  }
});

test('批内被折叠的 pair 不做任何自愈（不写索引、不搬文件）', () => {
  const root = tmpRoot('dup');
  try {
    const ctx = ctxFor(root);
    const W = WRITERS['workbuddy-cn'];
    const calls = { relocate: 0, ensureIndex: 0, syncTitle: 0 };
    const orig = { relocate: W.relocate, ensureIndex: W.ensureIndex, syncTitle: W.syncTitle };
    W.relocate = () => {
      calls.relocate++;
      return { ok: true };
    };
    W.ensureIndex = () => {
      calls.ensureIndex++;
      return { ok: true };
    };
    W.syncTitle = () => {
      calls.syncTitle++;
      return { ok: true, changed: false, warnings: [] };
    };
    try {
      // 手工造一条「被折叠」的 pair：真实 planImport 需要两条同源同 id 才会折叠，
      // 这里直接钉住语义 —— duplicateOf 存在就只许纯 skip
      const plan = {
        targets: [{ variant: 'workbuddy-cn' }],
        pairs: [
          {
            sourceVariant: 'pi',
            sourceId: 's1',
            sourceTitle: '源侧名',
            target: 'workbuddy-cn',
            targetId: 'sess-1',
            action: 'skip',
            reason: 'duplicate-in-batch',
            duplicateOf: 'pi:s1',
            placement: { directory: DIR_B, scope: 'project' },
            targetSummary: { id: 'sess-1', title: '目标名', cwd: DIR_A, provenance: { origin: 'pi:s1' } },
          },
        ],
      };
      const r = executePlan(ctx, plan, { apply: true, lock: false });
      assert.equal(r[0]?.action, 'skip');
      assert.equal(r[0]?.reason, 'duplicate-in-batch');
      assert.deepEqual(calls, { relocate: 0, ensureIndex: 0, syncTitle: 0 }, '折叠的 pair 一个副作用都不许有');
    } finally {
      Object.assign(W, orig);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repair 失败不记「已修」：同一目标的下一条 pair 还会重试', () => {
  const root = tmpRoot('repair');
  try {
    writePiSource(root, 's1', ['会话一']);
    writePiSource(root, 's2', ['会话二']);
    const ctx = ctxFor(root);
    const W = WRITERS['workbuddy-cn'];
    const origRepair = W.repair;
    let calls = 0;
    W.repair = function repair(ctx2, args) {
      calls++;
      if (calls === 1) return { ok: false, error: 'boom' };
      return origRepair.call(this, ctx2, args);
    };
    try {
      const plan = planImport(ctx, { from: ['pi'], into: ['workbuddy-cn'], cwd: DIR_A, placement: 'cwd' });
      assert.equal(plan.pairs.length, 2, '需要两条 pair 才能观察重试');
      executePlan(ctx, plan, { apply: true, lock: false });
      assert.equal(calls, 2, `第一次失败后必须在第二条 pair 上重试，实际调用 ${calls} 次`);
    } finally {
      W.repair = origRepair;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
