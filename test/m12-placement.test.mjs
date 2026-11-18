// M12 测试：落点模型（scope/account 进 IR + placement.mjs 两个纯函数）
// 核心不变量：目录/scope/account 只决定「写到哪」，绝不参与「是不是同一条会话」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeSession, turnCoreFingerprint } from '../src/ir.mjs';
import { makeCtx, ALL_VARIANTS, bucketRoot } from '../src/hosts.mjs';
import { applyProvenanceToIR } from '../src/provenance.mjs';
import { INTERNAL_ROOTS, NON_PROJECT_BUCKET, classifySource, resolvePlacement } from '../src/placement.mjs';

const HOME = 'C:/TestHome';
const ctx = makeCtx({ home: HOME, platform: 'win32', cwd: 'C:/TestHome/wherever' });
// 反斜杠转正斜杠后再比，避免断言里混写两种分隔符
const N = (s) => String(s ?? '').replace(/\\/g, '/');
const src = (over = {}) =>
  makeSession({ id: 'src-1', variant: 'codex', title: 't', cwd: 'D:/00-work/code/demo-app', createdAt: Date.UTC(2026, 9, 8, 18, 38, 21, 123), turns: [], ...over });

// ---- IR：两个新字段 ----

test('makeSession：scope/account 默认 null，可显式传入', () => {
  const s = makeSession({ id: 'a', variant: 'claude', turns: [] });
  assert.equal(s.scope, null);
  assert.equal(s.account, null);
  const t = src({ scope: 'none', account: { variant: 'workbuddy-cn', id: 'bbbbbbbb' } });
  assert.equal(t.scope, 'none');
  assert.deepEqual(t.account, { variant: 'workbuddy-cn', id: 'bbbbbbbb' });
});

test('scope/account 不进轮次指纹（幂等与 fork 判定不受影响）', () => {
  const a = src({ scope: 'project' });
  const b = src({ scope: 'none', account: { variant: 'codex', id: 'x' } });
  assert.equal(turnCoreFingerprint(a.turns[0] ?? { role: 'user', items: [] }), turnCoreFingerprint(b.turns[0] ?? { role: 'user', items: [] }));
  const mk = (scope) => src({ scope, turns: [{ role: 'user', items: [{ kind: 'message', role: 'user', text: 'hi', ts: 0 }] }] });
  assert.equal(turnCoreFingerprint(mk('project').turns[0]), turnCoreFingerprint(mk('none').turns[0]));
});

// ---- classifySource ----

test('classifySource：真实项目目录 → project', () => {
  const r = classifySource(src({ cwd: 'D:/00-work/code/demo-app' }), ctx);
  assert.equal(r.scope, 'project');
  assert.ok(r.reason);
});

test('classifySource：cwd 落在宿主自管根内 → none（规则 1 全量根）', () => {
  const inside = [
    'C:/TestHome/Documents/Codex/2026-10-15/ni-x20',
    'C:/TestHome/Documents/Qoder/2026-10-14/ac68541b',
    'C:/TestHome/Documents/QoderCN/2026-10-15/chat-2',
    'C:/TestHome/WorkBuddy/2026-10-08-18-38-21',
    'C:/TestHome/WorkBuddy AI/2026-10-08-18-38-21',
    'C:/TestHome/.minimax/sessions/019f.../workspace',
    'C:/TestHome/Documents/deepseek-harness/default-workspace',
    'C:/TestHome/.zcode/workspace/default',
    'C:/TestHome/ZCodeProject',
    'C:/TestHome/XiaomiMiMoProjects/.mimo-sessions/2026/10/08/curious-harbor',
  ];
  for (const cwd of inside) {
    assert.equal(classifySource(src({ cwd }), ctx).scope, 'none', `${cwd} 应判非项目`);
  }
  // 根必须按路径段匹配，不能把邻居目录一起吃掉
  for (const cwd of ['C:/TestHome/WorkBuddyx/proj', 'C:/TestHome/Documents/Codex2/proj', 'C:/TestHome/Documents/qoder-runner/proj']) {
    assert.equal(classifySource(src({ cwd }), ctx).scope, 'project', `${cwd} 不该被判非项目`);
  }
});

test('classifySource：Windows 分隔符与大小写差异仍算命中', () => {
  assert.equal(classifySource(src({ cwd: 'C:\\TestHome\\Documents\\Codex\\2026-10-15\\ni-x20' }), ctx).scope, 'none');
  assert.equal(classifySource(src({ cwd: 'c:/testhome/documents/codex/2026-10-15/ni-x20' }), ctx).scope, 'none');
});

test('classifySource：空 cwd → none', () => {
  assert.equal(classifySource(src({ cwd: '' }), ctx).scope, 'none');
});

test('classifySource：reader 显式 scope 信号生效（minimax 把内部目录挪出 cwd 后靠标记）', () => {
  const r = classifySource(src({ cwd: '', scope: 'none' }), ctx);
  assert.equal(r.scope, 'none');
  assert.match(r.reason, /reader/);
});

test('classifySource：placed.scope 优先于按当前目录的猜测（迁移过的会话不变分类，规则 4）', () => {
  const moved = src({ cwd: 'D:/somewhere/looks-like-project', meta: {}, origin: null });
  moved.provenance = { origin: { variant: 'codex', sessionId: 'x' }, placed: { directory: N('C:/TestHome/Documents/Codex/2026-10-08/abc'), scope: 'none' } };
  assert.equal(classifySource(moved, ctx).scope, 'none');
  const movedProj = { ...moved, provenance: { origin: { variant: 'codex', sessionId: 'x' }, placed: { directory: 'D:/00-work/code/demo-app', scope: 'project' } } };
  assert.equal(classifySource(movedProj, ctx).scope, 'project');
});

test('classifySource：宿主自管根压过 placed.scope=project（规则 1 是硬保证）', () => {
  const s = src({ cwd: 'C:/TestHome/WorkBuddy/2026-10-08-18-38-21' });
  s.provenance = { placed: { directory: N('C:/TestHome/WorkBuddy/2026-10-08-18-38-21'), scope: 'project' } };
  assert.equal(classifySource(s, ctx).scope, 'none');
});

test('INTERNAL_ROOTS 条目都是 home 下的绝对路径', () => {
  const roots = INTERNAL_ROOTS(ctx);
  assert.ok(roots.length >= 9);
  for (const r of roots) {
    assert.ok(path.isAbsolute(r.path), `${r.path} 必须是绝对路径`);
    assert.ok(N(r.path).startsWith(N(HOME).toLowerCase()) || N(r.path).toLowerCase().startsWith(N(HOME).toLowerCase()), `${r.path} 应在 home 下`);
    assert.ok(r.variant || r.variants, '每条内部根要标明归属变体');
  }
});

// ---- resolvePlacement ----

test('resolvePlacement：项目会话 → project-dir，目录就是源 cwd', () => {
  const p = resolvePlacement(src({ cwd: 'D:/00-work/code/demo-app' }), 'opencode', ctx, { targetId: 'T1' });
  assert.equal(p.scope, 'project');
  assert.equal(p.source, 'project-dir');
  assert.equal(N(p.directory), 'D:/00-work/code/demo-app');
  assert.deepEqual(p.warnings, []);
});

test('resolvePlacement：generated 桶（codex）= 桶根/源日期/自铸 slug，不用今天', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8, 18, 38, 21) }), 'codex', ctx, { targetId: '019f0000-0000-7abc-8def-001122334455' });
  assert.equal(p.source, 'bucket:generated');
  assert.equal(p.scope, 'none');
  assert.ok(N(p.directory).startsWith('C:/TestHome/Documents/Codex/2026-10-08/'), p.directory);
  assert.ok(p.directory.length > 'C:/TestHome/Documents/Codex/2026-10-08/'.length, '要有自铸叶子名');
  const again = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8, 18, 38, 21) }), 'codex', ctx, { targetId: '019f0000-0000-7abc-8def-001122334455' });
  assert.equal(N(p.directory), N(again.directory), '同一 targetId 必须复现同一目录');
  const other = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8, 18, 38, 21) }), 'codex', ctx, { targetId: 'another-id-0002' });
  assert.notEqual(N(other.directory), N(p.directory), '不同 targetId 必须互不重叠');
});

test('resolvePlacement：generated 桶日期缺失时用 epoch 并记 warning（不许退回「今天」）', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: 0, updatedAt: 0 }), 'codex', ctx, { targetId: 'x1' });
  assert.ok(p.warnings.length > 0);
  assert.ok(N(p.directory).includes('/1970-01-01/'), p.directory);
});

test('resolvePlacement：workbuddy cn/intl 桶根不同，叶子是 hyphen6', () => {
  const ms = Date.UTC(2026, 9, 8, 18, 38, 21, 123);
  const cn = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'workbuddy-cn', ctx, { targetId: 'T9' });
  const intl = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'workbuddy-intl', ctx, { targetId: 'T9' });
  assert.equal(N(cn.directory), 'C:/TestHome/WorkBuddy/2026-10-08-18-38-21');
  assert.equal(N(intl.directory), 'C:/TestHome/WorkBuddy AI/2026-10-08-18-38-21');
});

test('resolvePlacement：minimax 用 targetId 当键（不含日期层）', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none' }), 'minimax', ctx, { targetId: 'sess-abc' });
  assert.equal(N(p.directory), 'C:/TestHome/.minimax/sessions/sess-abc/workspace');
});

test('resolvePlacement：mimo 用 .mimo-sessions/年/月/日/slug', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8) }), 'mimo', ctx, { targetId: 'mimo-1' });
  assert.equal(N(p.directory), 'C:/TestHome/XiaomiMiMoProjects/.mimo-sessions/2026/10/08/mimo-1');
});

test('resolvePlacement：qoder cn/intl 是 generated 双桶根，叶子取 targetId 前 12 位（现网 25/30 是 12 hex）', () => {
  const ms = Date.UTC(2026, 9, 8, 18, 38, 21);
  const id = '4d682a1a878c0123456789';
  const cn = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'qoder-cn', ctx, { targetId: id });
  const intl = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'qoder-intl', ctx, { targetId: id });
  assert.equal(cn.source, 'bucket:generated');
  assert.equal(N(cn.directory), 'C:/TestHome/Documents/QoderCN/2026-10-08/4d682a1a878c');
  assert.equal(N(intl.directory), 'C:/TestHome/Documents/Qoder/2026-10-08/4d682a1a878c');
  assert.notEqual(N(cn.directory), N(intl.directory), 'cn/intl 必须分根');
  const again = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'qoder-cn', ctx, { targetId: id });
  assert.equal(N(again.directory), N(cn.directory), '同一 targetId 复现同一目录');
  const other = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: ms }), 'qoder-cn', ctx, { targetId: 'ffffffff000011112222' });
  assert.notEqual(N(other.directory), N(cn.directory), '不同 targetId 互不重叠');
});

test('resolvePlacement：shared 桶是常量目录，不随 targetId 变', () => {
  const s = src({ cwd: '', scope: 'none' });
  const cases = {
    zcode: 'C:/TestHome/.zcode/workspace/default',
    dsh: 'C:/TestHome/Documents/deepseek-harness/default-workspace',
    opencode: 'C:/TestHome',
  };
  for (const [variant, want] of Object.entries(cases)) {
    const a = resolvePlacement(s, variant, ctx, { targetId: 'one' });
    const b = resolvePlacement(s, variant, ctx, { targetId: 'two' });
    assert.equal(a.source, 'bucket:shared', variant);
    assert.equal(N(a.directory), want, variant);
    assert.equal(N(b.directory), want, `${variant} 会话彼此平铺`);
  }
});

test('resolvePlacement：none 桶 + 未给 --cwd → requires-cwd，directory 为 null（D4）', () => {
  const s = src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8) });
  for (const variant of ['claude', 'pi', 'cursor', 'antigravity', 'cline', 'kilo', 'roo', 'freebuff']) {
    const p = resolvePlacement(s, variant, ctx, { targetId: 'T' });
    assert.equal(p.source, 'requires-cwd', variant);
    assert.equal(p.directory, null, variant);
    assert.match(p.hint, /--cwd/, variant);
  }
});

test('resolvePlacement：none 桶 + 给了 --cwd → flag:cwd', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none' }), 'freebuff', ctx, { targetId: 'T', cwd: 'D:/00-work/code/demo-app' });
  assert.equal(p.source, 'flag:cwd');
  assert.equal(p.scope, 'none');
  assert.equal(N(p.directory), 'D:/00-work/code/demo-app');
});

test('resolvePlacement：--placement 覆盖（bucket 强制进桶 / project 强制进源目录 / cwd 保持旧行为）', () => {
  const proj = src({ cwd: 'D:/00-work/code/demo-app', scope: 'project' });
  const forced = resolvePlacement(proj, 'codex', ctx, { targetId: 'T', placement: 'bucket' });
  assert.equal(forced.source, 'bucket:generated');
  assert.equal(forced.scope, 'none');
  const keep = resolvePlacement(src({ cwd: '', scope: 'none' }), 'opencode', ctx, { targetId: 'T', placement: 'project' });
  assert.equal(keep.source, 'project-dir');
  assert.equal(N(keep.directory), '');
  const byFlag = resolvePlacement(proj, 'claude', ctx, { targetId: 'T', placement: 'cwd', cwd: 'D:/other/dir' });
  assert.equal(byFlag.source, 'flag:cwd');
  assert.equal(N(byFlag.directory), 'D:/other/dir');
});

test('resolvePlacement：account 只认 --account，绝不继承源会话的账号', () => {
  // 源账号属于来源宿主的命名空间（codex 的 user-xxxx / workbuddy 的 uid），钉进目标宿主的归属列
  // 等于把会话写进宿主列表谓词永远不匹配的桶里，还不报错（见 m54 的端到端回归）。
  const s = src({ account: { variant: 'codex', id: 'src-uid' } });
  assert.equal(resolvePlacement(s, 'workbuddy-cn', ctx, { targetId: 'T' }).account, null);
  assert.deepEqual(resolvePlacement(s, 'workbuddy-cn', ctx, { targetId: 'T', account: { variant: 'workbuddy-cn', id: 'dst-uid' } }).account, {
    variant: 'workbuddy-cn',
    id: 'dst-uid',
  });
  assert.equal(resolvePlacement(src({}), 'claude', ctx, { targetId: 'T' }).account, null);
});

test('resolvePlacement：结果与「执行导入的当前目录」无关（目录不参与会话判定）', () => {
  const s = src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8) });
  const a = resolvePlacement(s, 'codex', makeCtx({ home: HOME, platform: 'win32', cwd: 'D:/00-work/code/demo-app' }), { targetId: 'T' });
  const b = resolvePlacement(s, 'codex', makeCtx({ home: HOME, platform: 'win32', cwd: 'C:/TestHome/WorkBuddy/2026-10-08-18-38-21' }), { targetId: 'T' });
  assert.equal(N(a.directory), N(b.directory));
  const pa = resolvePlacement(src({ cwd: 'D:/x/proj-a' }), 'claude', ctx, { targetId: 'T' });
  const pb = resolvePlacement(src({ cwd: 'D:/x/proj-b' }), 'claude', ctx, { targetId: 'T' });
  assert.equal(pa.source, pb.source);
});

test('applyProvenanceToIR：placed 要透出到 IR（reader 分类与 --project 搜索都依赖它）', () => {
  const s = src({ cwd: 'C:/TestHome/Documents/Codex/2026-10-08/abc' });
  applyProvenanceToIR(s, { origin: { variant: 'codex', sessionId: 'x' }, chain: [], placed: { directory: 'C:/x', scope: 'none' } });
  assert.deepEqual(s.placed, { directory: 'C:/x', scope: 'none' });
  assert.equal(classifySource(s, ctx).scope, 'none');
});

test('桶根只有一份：NON_PROJECT_BUCKET.root 必须等于 hosts.bucketRoot', () => {
  for (const [v, b] of Object.entries(NON_PROJECT_BUCKET)) {
    if (b.kind === 'none' || !b.root) continue;
    assert.equal(N(b.root(ctx)), N(bucketRoot(ctx, v)), v);
  }
});

test('NON_PROJECT_BUCKET：每个变体都有登记（kind 允许 none，但不许漏家）', () => {
  for (const v of ALL_VARIANTS) {
    const b = NON_PROJECT_BUCKET[v];
    assert.ok(b, `${v} 未登记非项目桶`);
    assert.ok(['generated', 'shared', 'none'].includes(b.kind), `${v} 桶形态非法: ${b.kind}`);
    if (b.kind !== 'none') assert.ok(typeof b.root === 'function', `${v} 必须给 root(ctx)`);
  }
});

test('NON_PROJECT_BUCKET：generated 桶缺 targetId 时记 warning 且仍可复现', () => {
  const p = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8) }), 'codex', ctx, {});
  assert.ok(p.warnings.some((w) => /target-id/.test(w)), JSON.stringify(p.warnings));
  const again = resolvePlacement(src({ cwd: '', scope: 'none', createdAt: Date.UTC(2026, 9, 8) }), 'codex', ctx, {});
  assert.equal(N(p.directory), N(again.directory));
});
