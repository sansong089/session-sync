// M50 测试：list 的轮次必须是精确值 —— 大会话（超出 head/tail 采样窗口）也要与 read 一致
//
// 真机现象：一条 19MB 的 qoder 会话，readSession 读出 67 轮，list 只显示 1 轮。
// 用户按 list 挑会话、按 0 轮过滤，看到的都是错的数，所以 list 与 read 的轮次口径必须相同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { WRITABLE_VARIANTS } from '../src/writers/index.mjs';
import { SRC_ID, setupHome } from './matrix-home.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m50-locks-'));

// 每一轮回答灌 ~60KB，八轮摊满 ~500KB：中间几轮既不在 head 也不在 tail 的采样窗口里
const PAD = 20_000;
const MIDDLE_TURNS = 6;
const WANT_TURNS = 2 + MIDDLE_TURNS; // 第一轮 + 中间 6 轮 + 第二轮

function targetList(ctx, target, targetId) {
  return listSessions(target, ctx, {}).sessions.find((s) => s.id === targetId);
}

test('夹具自身：源会话大到一个窗口装不下，轮次确实落在采样区间之外', () => {
  const { ctx } = setupHome({ padChars: PAD, middleTurns: MIDDLE_TURNS });
  const srcFile = path.join(ctx.home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  assert.ok(fs.statSync(srcFile).size > 4 * 128 * 1024, `夹具必须远大于采样窗口，实际 ${fs.statSync(srcFile).size} 字节`);
  const src = readSession('claude', ctx, SRC_ID).session;
  assert.equal(src.turns.length, WANT_TURNS, `源应 ${WANT_TURNS} 轮，实际 ${src.turns.length}`);
  const listed = targetList(ctx, 'claude', SRC_ID);
  assert.ok(listed, 'claude 侧必须列出源会话');
  assert.equal(listed.turns, WANT_TURNS, `list 的轮次必须等于 read 的轮次，实际 ${listed.turns}`);
  assert.ok(!listed.turnsApprox, `轮次既然是精确值就不该再标近似：${JSON.stringify(listed)}`);
});

test('workbuddy：宿主原生的「空 user 标记」不能进 list 的轮次', () => {
  // 真机抽查发现的第二类差异：list 把 content 为空的 user 事件也数成一轮（workbuddy 两家共 86 个），
  // 而 read 按各家一致口径把它并进上一轮 → 同一个会话两个数
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m53-wb-'));
  const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: {} });
  const id = 'sess-marker';
  const dir = path.join(home, '.workbuddy', 'projects', 'd-work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '甲' }], timestamp: new Date(1791484221000).toISOString() },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '乙' }], timestamp: new Date(1791484222000).toISOString() },
    { type: 'message', role: 'user', content: [], timestamp: new Date(1791484223000).toISOString() },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '丙' }], timestamp: new Date(1791484224000).toISOString() },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '丁' }], timestamp: new Date(1791484225000).toISOString() },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

  const readTurns = readSession('workbuddy-cn', ctx, id).session.turns.length;
  const listed = targetList(ctx, 'workbuddy-cn', id);
  assert.ok(listed, 'workbuddy 侧必须列出这条会话');
  assert.equal(readTurns, 2, `read 应算 2 轮，实际 ${readTurns}`);
  assert.equal(listed.turns, readTurns, `list 必须与 read 同口径，实际 list=${listed.turns}`);
});

test('全部可写目标：导入后 list 的轮次与 read 完全一致，且不标近似', () => {
  const { ctx } = setupHome({ padChars: PAD, middleTurns: MIDDLE_TURNS });
  const failures = [];
  // claude 是源本身（自导为 skip，不写盘），上一条用例已单独覆盖它的 list 口径。
  // 本例逐目标验证「写入契约 + 轮次口径」，同族双份策略（共享派生 id 的第二版默认中止）由 m83 单独锁，
  // 这里显式放行，否则两个同族目标的第二个拿不到写入、契约就没被验证到。
  for (const target of WRITABLE_VARIANTS.filter((v) => v !== 'claude').sort()) {
    const plan = planImport(ctx, { allowFamilyDuplicate: true, from: ['claude'], into: [target] });
    const results = executePlan(ctx, plan, { apply: true });
    const r = results[0];
    assert.equal(r.ok, true, `${target}: ${JSON.stringify({ error: r.error, verify: r.verify })}`);

    const readTurns = readSession(target, ctx, r.targetId).session.turns.length;
    const listed = targetList(ctx, target, r.targetId);
    assert.ok(listed, `${target} 导入的会话必须能被 list 列出`);
    if (readTurns !== WANT_TURNS) failures.push(`${target} read=${readTurns}（应 ${WANT_TURNS}）`);
    if (listed.turns !== readTurns) failures.push(`${target} list=${listed.turns} read=${readTurns}`);
    if (listed.turnsApprox) failures.push(`${target} 轮次仍标近似（turnsApprox=${listed.turnsApprox}）`);
  }
  assert.deepEqual(failures, [], `轮次口径不一致：\n${failures.join('\n')}`);
});
