// M18 测试：编排层接入 placement（计划改动清单 5）
//
// 要钉住的三件事：
//   1. pair 带 placement，dry-run 就能看清「这条会落到哪、为什么」；
//   2. executePlan 写入前用 placed 副本（writer 只读 session.cwd）→ 所有 writer 的落点自动跟随；
//   3. D4：宿主结构上没有非项目落点 → skipped(requires-cwd)，零写入、不失败整批。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');
// 必须按本次临时 home 拼：INTERNAL_ROOTS 是「宿主自管根前缀表」，写死绝对路径就命中不了
const bucketCwd = (root) => J(path.join(root, 'WorkBuddy', '2026-10-08-18-38-21'));
const PROJ_CWD = 'D:/00-work/code/demo-app';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m18-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['dsh', 'codex', 'workbuddy-cn', 'freebuff'],
  );
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
const claudeRow = (id, cwd, text) => ({
  parentUuid: null,
  type: 'user',
  sessionId: id,
  cwd,
  uuid: `${id}-u1`,
  timestamp: '2026-10-08T18:38:21.000Z',
  message: { role: 'user', content: text },
});
const claudeAsst = (id) => ({
  parentUuid: `${id}-u1`,
  type: 'assistant',
  sessionId: id,
  cwd: undefined,
  uuid: `${id}-a1`,
  timestamp: '2026-10-08T18:38:30.000Z',
  message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '收到' }] },
});

/** 两条源会话：一条落宿主自管根（非项目），一条真实项目目录 */
function twoSources(root) {
  writeJsonl(path.join(root, '.claude', 'projects', 'wb', 's-none.jsonl'), [claudeRow('s-none', bucketCwd(root), '桶里的会话'), claudeAsst('s-none')]);
  writeJsonl(path.join(root, '.claude', 'projects', 'pj', 's-proj.jsonl'), [claudeRow('s-proj', PROJ_CWD, '项目里的会话'), claudeAsst('s-proj')]);
}

test('planImport：每个 pair 带 placement（shared / generated / requires-cwd 三种形态）', () => {
  const root = tmpRoot('plan');
  twoSources(root);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['dsh', 'codex', 'freebuff'] });
  const none = plan.pairs.filter((p) => p.sourceId === 's-none');
  assert.equal(none.length, 3, JSON.stringify(none.map((p) => p.target)));
  const byTarget = Object.fromEntries(none.map((p) => [p.target, p]));

  assert.equal(byTarget.dsh.placement.scope, 'none');
  assert.equal(byTarget.dsh.placement.source, 'bucket:shared');
  assert.equal(J(byTarget.dsh.placement.directory), J(path.join(root, 'Documents', 'deepseek-harness', 'default-workspace')));

  assert.equal(byTarget.codex.placement.source, 'bucket:generated');
  assert.equal(J(byTarget.codex.placement.directory), J(path.join(root, 'Documents', 'Codex', '2026-10-08', byTarget.codex.targetId.replace(/[^A-Za-z0-9._-]+/g, '-'))));

  assert.equal(byTarget.freebuff.placement.source, 'requires-cwd');
  assert.equal(byTarget.freebuff.placement.directory, null);
  assert.match(byTarget.freebuff.placement.hint, /--cwd/);

  // 项目源仍按原目录
  const projByTarget = Object.fromEntries(plan.pairs.filter((p) => p.sourceId === 's-proj').map((p) => [p.target, p]));
  assert.equal(projByTarget.dsh.placement.scope, 'project');
  assert.equal(J(projByTarget.dsh.placement.directory), J(PROJ_CWD));
});

test('executePlan --apply：写入落点跟随 placement，读回 scope 正确（round-trip）', () => {
  const root = tmpRoot('apply');
  twoSources(root);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['dsh', 'codex'] });
  const results = executePlan(ctx, plan, { apply: true, lock: false });
  for (const r of results) assert.equal(r.ok, true, JSON.stringify(r));

  // 两条源会话 → 同一目标会有两条结果：一条项目 cwd、一条非项目（桶）。
  // 原先用 Object.fromEntries 按 target 折叠成一条，等于「谁排在后面就断言谁」，
  // 源枚举顺序一变就随机翻脸 —— 这里按 placement.scope 取该验的那条，两种落点都验。
  const perTarget = (t) => results.filter((r) => r.target === t);
  for (const t of ['dsh', 'codex']) assert.equal(perTarget(t).length, 2, `${t} 应有两条结果：${JSON.stringify(results.map((r) => [r.target, r.sourceId]))}`);

  for (const r of perTarget('dsh')) {
    assert.ok(fs.existsSync(r.path), `dsh 正文应落在 placement 目录：${r.path}`);
    assert.ok(J(r.path).includes(J(path.join(root, '.dsh', 'sessions'))), r.path);
    const back = readSession('dsh', ctx, r.targetId).session;
    assert.equal(J(back.cwd), J(r.placement.directory), '写出去的 cwd 必须就是 placement 目录');
    assert.equal(back.scope, r.placement.scope, `读回 scope 必须与落点一致（${r.placement.source}）`);
  }

  for (const r of perTarget('codex')) {
    const cb = readSession('codex', ctx, r.targetId).session;
    assert.equal(J(cb.cwd), J(r.placement.directory));
    assert.equal(cb.scope, r.placement.scope, `codex 读回 scope 必须与落点一致（${r.placement.source}）`);
  }
  // 至少各有一条真的走了桶（非项目），否则上面两条循环都在验同一形态
  assert.ok(perTarget('dsh').some((r) => r.placement.scope === 'none' && String(r.placement.source).startsWith('bucket')), JSON.stringify(perTarget('dsh').map((r) => r.placement)));
  assert.ok(perTarget('codex').some((r) => r.placement.scope === 'none' && String(r.placement.source).startsWith('bucket')));
});

test('D4：requires-cwd 记 skipped 且零写入，同批其他会话照常写', () => {
  const root = tmpRoot('d4');
  twoSources(root);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['freebuff', 'dsh'] });
  const results = executePlan(ctx, plan, { apply: true, lock: false });

  const skipped = results.filter((r) => r.status === 'skipped');
  assert.equal(skipped.length, 1, JSON.stringify(results.map((r) => [r.target, r.sourceId, r.status, r.executed])));
  assert.equal(skipped[0].reason, 'requires-cwd');
  assert.equal(skipped[0].executed, false);
  assert.match(skipped[0].hint, /--cwd/);
  assert.ok(!fs.existsSync(path.join(root, '.freebuff', 'projects', 'default')), '绝不造宿主永不打开的 projects/default');

  // 同批其余三条（项目源 × 2 目标 + 非项目源→dsh）照常写
  const written = results.filter((r) => r.executed && r.ok);
  assert.equal(written.length, 3, JSON.stringify(results.map((r) => [r.target, r.sourceId, r.action, r.ok])));
});

test('D4：补 --cwd 后同一条照常落进用户指定目录', () => {
  const root = tmpRoot('d4-cwd');
  writeJsonl(path.join(root, '.claude', 'projects', 'wb', 's-none.jsonl'), [claudeRow('s-none', bucketCwd(root), '桶里的会话'), claudeAsst('s-none')]);
  const ctx = ctxFor(root);
  const chosen = path.join(root, 'chosen-dir');
  const plan = planImport(ctx, { from: ['claude'], into: ['freebuff'], cwd: chosen });
  assert.equal(J(plan.pairs[0].placement.directory), J(chosen));
  assert.equal(plan.pairs[0].placement.source, 'flag:cwd');
  const r = executePlan(ctx, plan, { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  // freebuff 的落点是 projects/<basename(用户目录)>/chats/<id>，--cwd 只决定 basename
  assert.match(J(r.path), /projects\/chosen-dir\/chats\//, JSON.stringify(r.path));
  assert.ok(fs.existsSync(r.path), r.path);
});

test('placement=project 强制按源目录；placement=bucket 把项目会话也集中进桶', () => {
  const root = tmpRoot('mode');
  twoSources(root);
  const ctx = ctxFor(root);

  const asProject = planImport(ctx, { from: ['claude'], into: ['codex'], placement: 'project' });
  for (const p of asProject.pairs) {
    assert.equal(p.placement.scope, 'project');
    assert.equal(p.placement.source, 'project-dir');
  }
  assert.equal(J(asProject.pairs.find((p) => p.sourceId === 's-none').placement.directory), bucketCwd(root));

  const asBucket = planImport(ctx, { from: ['claude'], into: ['codex'], placement: 'bucket' });
  const proj = asBucket.pairs.find((p) => p.sourceId === 's-proj');
  assert.equal(proj.placement.scope, 'none');
  assert.equal(proj.placement.source, 'bucket:generated');
  assert.match(J(proj.placement.directory), /Documents\/Codex\/2026-10-08\//);
});

test('--account 透传到 placement（写侧归属由后续步骤按它落库）', () => {
  const root = tmpRoot('account');
  twoSources(root);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['workbuddy-cn'], account: 'uid-new-acct' });
  assert.equal(plan.pairs[0].placement.account, 'uid-new-acct');
});

test('写出的 provenance 要记下本次落点：搬到宿主不认的目录后仍按 placed 分类（规则 4）', () => {
  const root = tmpRoot('placed');
  const outside = J(path.join(root, 'user-picked-dir'));
  twoSources(root);
  const ctx = ctxFor(root);
  // --placement cwd + --cwd：落点是用户挑的任意目录，不在任何宿主自管根下
  const plan = planImport(ctx, { from: ['claude'], into: ['dsh'], placement: 'cwd', cwd: outside });
  const r = executePlan(ctx, plan, { apply: true, lock: false }).find((x) => x.sourceId === 's-none');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(J(r.placement.directory), outside);

  const back = readSession('dsh', ctx, r.targetId).session;
  assert.equal(J(back.cwd), outside, '正文里的 cwd 就是用户指定目录');
  // IR 上的落点记账字段是 placed（provenance 是摘要上的名字）
  assert.equal(back.placed?.scope, 'none', `provenance 必须记下本次落点的分类：${JSON.stringify(back.placed)}`);
  assert.equal(J(back.placed.directory), outside);
  assert.equal(back.scope, 'none', '目录不在宿主自管根下时，靠 placed 而不是靠目录猜');
  assert.equal(back.scopeReason, 'placed');
});
