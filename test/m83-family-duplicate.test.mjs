// M83 测试：同族双份守卫（workbuddy 中英版共享派生 id → 写前必须查另一版）
//
// 为什么必须有：`identity.UUID_FAMILY` 让同一 originKey 在中英版派生**同一个会话 id**。这本来是
// 为了让"同一条会话在两版里都能被认出来"，但代价是：宿主判错时不会报错，只会在另一版再存一份，
// 两份各自"看起来正常"，事后无从判定哪份是真的。真机现场即如此 —— 同一个 minimax origin
// 在 `.workbuddy` 里 12653 行、在 `.workbuddy-ai` 里 139 行，同 id 各一份。
// 用户选定策略：默认中止该条并点名要求，绕过必须显式加开关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { seedHostSeen } from './matrix-home.mjs';

const SRC_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m83-locks-'));

const tmpHome = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ss-m83-${name}-`));
const ctxFor = (home) => {
  const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {} });
  return seedHostSeen(ctx, ['workbuddy-cn', 'workbuddy-intl', 'pi']);
};

function makeClaudeSource(home) {
  const file = path.join(home, '.claude', 'projects', 'D--proj', `${SRC_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd: 'D:\\proj' },
    { parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第一轮回答' }] }, uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', sessionId: SRC_ID, cwd: 'D:\\proj' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const run = (ctx, from, into, opts = {}) => {
  const plan = planImport(ctx, { from, into, ...opts });
  return { plan, results: executePlan(ctx, plan, { apply: true, ...opts }) };
};

test('另一版已有同一来源 → 中止该条，一个字节都不写', () => {
  const home = tmpHome('cn-first');
  makeClaudeSource(home);
  const ctx = ctxFor(home);

  const first = run(ctx, ['claude'], ['workbuddy-cn']);
  assert.equal(first.plan.pairs[0].action, 'create', `第一次应当正常写入中文版：${JSON.stringify(first.plan.pairs[0])}`);
  assert.ok(first.results.some((r) => r.executed && r.ok), '第一次写入没成功，后面无从判断');

  const second = run(ctx, ['claude'], ['workbuddy-intl']);
  const item = second.plan.pairs[0];
  assert.equal(item.action, 'skip', `同族另一版已有同 origin，却仍判成 ${item.action}`);
  assert.equal(item.reason, 'edition-duplicate');
  assert.equal(item.duplicateOfSibling.variant, 'workbuddy-cn');
  assert.equal(String(item.duplicateOfSibling.id), String(item.targetId), '两版必须给同一个派生 id —— 这正是双份能发生的原因');
  assert.ok(item.duplicateOfSibling.path, '必须把另一版那份的路径端出来，否则用户无从判断');

  second.results.forEach((r) => assert.notEqual(r.executed, true, '被中止的条目不许落盘'));
  assert.equal(listSessions('workbuddy-intl', ctx).sessions.length, 0, '国际版应当一个字节都没被写过');
});

test('显式放行才允许两版各留一份', () => {
  const home = tmpHome('allow');
  makeClaudeSource(home);
  const ctx = ctxFor(home);
  run(ctx, ['claude'], ['workbuddy-cn']);
  const blocked = run(ctx, ['claude'], ['workbuddy-intl']);
  assert.equal(blocked.plan.pairs[0].reason, 'edition-duplicate');
  const allowed = run(ctx, ['claude'], ['workbuddy-intl'], { allowFamilyDuplicate: true });
  assert.equal(allowed.plan.pairs[0].action, 'create', '加了开关还拦，就是不给退路');
  assert.ok(allowed.results.some((r) => r.executed && r.ok));
  assert.equal(listSessions('workbuddy-intl', ctx).sessions.length, 1);
});

test('不同族的目标不受影响（不许把守卫做成全局减速带）', () => {
  const home = tmpHome('other-family');
  makeClaudeSource(home);
  const ctx = ctxFor(home);
  run(ctx, ['claude'], ['workbuddy-cn']);
  const r = run(ctx, ['claude'], ['pi']);
  assert.equal(r.plan.pairs[0].action, 'create', `pi 与 workbuddy 不同族却被拦：${JSON.stringify(r.plan.pairs[0])}`);
});

test('目标版本自己已有这条时照旧走 skip/append，不被误报成跨版重复', () => {
  const home = tmpHome('same-variant');
  makeClaudeSource(home);
  const ctx = ctxFor(home);
  run(ctx, ['claude'], ['workbuddy-intl']);
  const again = run(ctx, ['claude'], ['workbuddy-intl']);
  assert.notEqual(again.plan.pairs[0].reason, 'edition-duplicate', '同一版里的重复被误报成跨版重复');
  assert.equal(again.plan.pairs[0].action, 'skip', `重复导入应幂等跳过，实际 ${again.plan.pairs[0].action}（${again.plan.pairs[0].reason}）`);
});
