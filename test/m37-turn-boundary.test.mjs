// M37 测试：轮次边界的跨落点保真（写入 → 读回必须还是同一串轮次）
//
// 真机取证（2026-10-27，沙箱=真实库镜像）发现两类失真，都会让「同一条会话」在不同表示下
// 算出不同核心指纹，从而把续写误判成分叉：
//   1) 一轮里的多段用户文本：Cline/DSH/WorkBuddy 存成一条消息的多个块，OpenCode 的 user
//      消息只有一个 text 字段（只能拼接）。写侧逐块各发一条 → 读回多出轮次。
//   2) 「只有助手发言」的一轮：WorkBuddy 原生用 content 为空的 user 事件标记（实测两家共 86 个），
//      而 claude/pi/codex 等宿主读不出这种轮次 → 同一会话在两类宿主里轮次数不同。
//      收口口径：各家一律「开轮必须有可展示内容」，空标记并进上一轮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { readSession } from '../src/readers/index.mjs';
import { assembleTurns } from '../src/readers/base.mjs';
import { getWriter, WRITABLE_VARIANTS } from '../src/writers/index.mjs';
import { mkMimoDb, mkOpencodeDb } from './db-fixtures.mjs';
import { setupHome } from './matrix-home.mjs';
import { makeSession, messageItem, toolCallItem, toolResultItem, attachmentItem, sessionCoreFingerprints, turnCore, normalizeTurnItems } from '../src/ir.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m37-locks-'));

const T0 = 1791484221000;
function tmpCtx(name, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m37-${name}-`));
  return makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env });
}

/** 一轮多段用户文本 + 带工具的一轮 + 普通一轮 */
function boundarySession(variant, id, cwd) {
  const turns = [
    { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮问题', T0), messageItem('user', '（补充）同一轮的第二段用户文本', T0), messageItem('assistant', '第一轮回答', T0 + 1000)] },
    { index: 1, role: 'user', startedAt: T0 + 2000, items: [messageItem('user', '第二轮问题', T0 + 2000), toolCallItem('call_a', 'Read', { file_path: 'a.txt' }, T0 + 2000), toolResultItem('call_a', 'Read', 'ok', 'file body', T0 + 2500), messageItem('assistant', '第二轮回答', T0 + 3000)] },
    { index: 2, role: 'user', startedAt: T0 + 4000, items: [messageItem('user', '第三轮问题', T0 + 4000), attachmentItem('src/a.txt', 'file', T0 + 4000), messageItem('assistant', '第三轮回答', T0 + 5000)] },
  ];
  return makeSession({ id, variant, title: '边界保真', cwd, createdAt: T0, updatedAt: T0 + 5000, model: 'm-1', turns, meta: {} });
}

function roundTrip(variant, ctx, targetId = 'rt-1') {
  const src = boundarySession(variant, 'src-boundary-1', 'D:/work/demo');
  const want = sessionCoreFingerprints(src);
  assert.equal(want.length, 3, '源应正好 3 轮');
  const res = getWriter(variant).write(ctx, { session: src, targetId, mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, `${variant} 写入失败: ${res.error}`);
  const back = readSession(variant, ctx, targetId).session;
  assert.ok(back, `${variant} 读不回`);
  assert.equal(
    back.turns.length,
    3,
    `${variant} 轮次数应保真为 3，实际 ${back.turns.length}: ${JSON.stringify(back.turns.map((t) => turnCore(t))).slice(0, 800)}`,
  );
  assert.deepEqual(sessionCoreFingerprints(back), want, `${variant} 核心指纹应逐轮一致`);
  return { src, back };
}

test('WorkBuddy 两家里：连续用户文本并成一条事件、轮次边界保真', () => {
  for (const variant of ['workbuddy-cn', 'workbuddy-intl']) roundTrip(variant, tmpCtx(`wb-${variant}`));
});

test('Claude / Cline / Kilo / DSH / OpenCode / MiMo：块分组保真轮次边界', () => {
  const cline = tmpCtx('cline');
  fs.mkdirSync(path.join(cline.home, '.cline', 'data'), { recursive: true });
  cline.env.CLINE_DATA_DIR = path.join(cline.home, '.cline', 'data');
  const dsh = tmpCtx('dsh');
  fs.mkdirSync(path.join(dsh.home, '.dsh', 'sessions'), { recursive: true });
  dsh.env.DSH_HOME = path.join(dsh.home, '.dsh');
  const kilo = tmpCtx('kilo');
  fs.mkdirSync(path.join(kilo.appData, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });
  const cbi = tmpCtx('codebuddy-ide');
  const cbiData = path.join(cbi.home, 'CodeBuddyExtensionData');
  fs.mkdirSync(cbiData, { recursive: true });
  cbi.env.CODEBUDDY_EXTENSION_DATA = cbiData;

  // 需要预置库表结构的 DB 型宿主（opencode/mimo/zcode/minimax）由 m7 的全矩阵覆盖
  for (const [variant, ctx] of [['claude', tmpCtx('claude')], ['codex', tmpCtx('codex')], ['pi', tmpCtx('pi')], ['freebuff', tmpCtx('freebuff')], ['cline', cline], ['kilo', kilo], ['dsh', dsh], ['codebuddy', tmpCtx('codebuddy')], ['codebuddy-ide', cbi]]) {
    if (!getWriter(variant)) continue;
    roundTrip(variant, ctx, `rt-${variant}`);
  }
});

test('Claude：两段用户文本写进同一条 user 事件', () => {
  const ctx = tmpCtx('claude-raw');
  roundTrip('claude', ctx);
  const raw = fs.readFileSync(path.join(ctx.home, '.claude', 'projects', 'D--work-demo', 'rt-1.jsonl'), 'utf8');
  const userTexts = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'user' && (e.message?.content ?? []).some((c) => c?.type === 'text'));
  assert.equal(userTexts.length, 3, `三轮 = 三条带文本的 user 事件，实际 ${userTexts.length}`);
});

test('WorkBuddy：宿主原生的「空 user 标记」并进上一轮，各家口径一致', () => {
  const ctx = tmpCtx('wb-marker');
  const id = 'sess-marker';
  const dir = path.join(ctx.home, '.workbuddy', 'projects', 'd-work-demo');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '甲' }], timestamp: new Date(T0).toISOString() },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '乙' }], timestamp: new Date(T0 + 1000).toISOString() },
    { type: 'message', role: 'user', content: [], timestamp: new Date(T0 + 2000).toISOString() },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '丙' }], timestamp: new Date(T0 + 3000).toISOString() },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const s = readSession('workbuddy-cn', ctx, id).session;
  assert.equal(s.turns.length, 1, '空标记不该另开一轮');
  // 写回再读回必须还是同一条核心指纹（跨落点收敛）
  const fp = sessionCoreFingerprints(s);
  const res = getWriter('workbuddy-cn').write(ctx, { session: { ...s, cwd: 'D:/work/demo' }, targetId: 'rt-marker', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, res.error);
  const back = readSession('workbuddy-cn', ctx, 'rt-marker').session;
  assert.equal(back.turns.length, 1);
  assert.deepEqual(sessionCoreFingerprints(back), fp);
});

test('turnCore：同角色相邻消息合并，工具调用不参与合并', () => {
  const a = turnCore({ role: 'user', items: [messageItem('user', '甲', T0), messageItem('user', '乙', T0), messageItem('assistant', '答', T0)] });
  const b = turnCore({ role: 'user', items: [messageItem('user', '甲\n\n乙', T0), messageItem('assistant', '答', T0)] });
  assert.deepEqual(a, b, '分块与拼接必须算出同一个核心');
  const c = turnCore({ role: 'user', items: [messageItem('user', '甲', T0), toolCallItem('x', 'Read', null, T0), messageItem('user', '乙', T0)] });
  assert.equal(c.items.length, 3, '被工具调用隔开的用户文本不合并');
});

test('附件占位全库同一种写法：\'[attachment] <路径>\'（别的写法会进核心指纹）', () => {
  const core = (text) => turnCore({ role: 'assistant', items: [messageItem('assistant', text, T0)] });
  assert.deepEqual(core('[attachment] src/a.png').items, [], '规范占位不进核心');
  assert.equal(core('[file] src/a.png').items.length, 1, '旧写法 [file] 会进核心 → 同一会话在不同宿主算出不同指纹');

  // 会把附件降级成文本的 writer 必须写同一种占位
  for (const variant of ['claude', 'codebuddy', 'codex', 'dsh', 'freebuff']) {
    const ctx = tmpCtx(`att-${variant}`);
    if (variant === 'dsh') {
      fs.mkdirSync(path.join(ctx.home, '.dsh', 'sessions'), { recursive: true });
      ctx.env.DSH_HOME = path.join(ctx.home, '.dsh');
    }
    const src = makeSession({
      id: 'att-src', variant: 'claude', title: '带附件', cwd: 'D:/work/demo',
      createdAt: T0, updatedAt: T0 + 1000, model: 'm-1',
      turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '看图', T0), attachmentItem('src/a.txt', 'file', T0 + 100), messageItem('assistant', '好的', T0 + 200)] }],
      meta: {},
    });
    const tid = `att-${variant}`;
    const res = getWriter(variant).write(ctx, { session: src, targetId: tid, mode: 'create', provenance: null, force: true });
    assert.equal(res.ok, true, `${variant} 写入失败: ${res.error}`);
    const back = readSession(variant, ctx, tid).session;
    const texts = (back.turns ?? []).flatMap((t) => (t.items ?? []).filter((i) => i.kind === 'message').map((i) => i.text));
    assert.ok(texts.includes('[attachment] src/a.txt'), `${variant} 的附件占位必须是 '[attachment] <路径>'，实际：${JSON.stringify(texts)}`);
  }
});

// 「一个部件同时承载调用与结果」的存储形态（opencode 血统 / freebuff）在孤儿结果上最容易失真：
// 写侧必须显式标 resultOnly，读侧据此不补调用；而真实调用即使 input 为 null 也必须保住。
const TOOL_TARGETS = [
  ['mimo', 'mimo（opencode-classic）', (home) => {
    fs.mkdirSync(path.join(home, 'mimocode'), { recursive: true });
    mkMimoDb(path.join(home, 'mimocode', 'mimocode.db'));
    return { XDG_DATA_HOME: home };
  }],
  ['freebuff', 'freebuff', (home) => {
    const d = path.join(home, '.config', 'manicode');
    fs.mkdirSync(d, { recursive: true });
    return { FREEBUFF_CONFIG_DIR: d };
  }],
  ['opencode', 'opencode（v2）', (home) => {
    const d = path.join(home, 'ocdata');
    mkOpencodeDb(path.join(d, 'opencode.db'));
    return { OPENCODE_DATA_DIR: d };
  }],
];

function roundTripTools(variant, setup, tag, items) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m37-' + variant + '-'));
  const env = setup(home);
  const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env });
  const src = makeSession({
    id: tag, variant: 'claude', title: '工具边界', cwd: 'D:/work/demo',
    createdAt: T0, updatedAt: T0 + 3000, model: 'm-1',
    turns: [{ index: 0, role: 'user', startedAt: T0, items }],
    meta: {},
  });
  const res = getWriter(variant).write(ctx, { session: src, targetId: 't-tools', mode: 'create', provenance: null, force: true });
  assert.equal(res.ok, true, variant + ' 写入失败: ' + res.error);
  const back = readSession(variant, ctx, 't-tools').session;
  return { src, back };
}

for (const [variant, label, setup] of TOOL_TARGETS) {
  test(label + '：孤儿 tool_result 不得在读回时变成 tool_call', () => {
    const { src, back } = roundTripTools(variant, setup, 'orphan-1', [
      messageItem('user', '跑一下', T0),
      messageItem('assistant', '我看看', T0 + 100),
      toolCallItem('call-real', 'Read', { file_path: 'a.txt' }, T0 + 200),
      toolResultItem('call-real', 'Read', 'ok', '内容', T0 + 300),
      toolResultItem('call-missing', 'Read', 'ok', '孤儿输出', T0 + 400),
      messageItem('assistant', '好了', T0 + 500),
    ]);
    assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), label + ' 核心指纹必须一致：' + JSON.stringify(back.turns.map(turnCore)).slice(0, 400));
  });

  test(label + '：输入为 null 的真实 tool_call 必须保住', () => {
    const { src, back } = roundTripTools(variant, setup, 'null-input-1', [
      messageItem('user', '跑一下', T0),
      toolCallItem('call-noargs', 'Bash', null, T0 + 100),
      toolResultItem('call-noargs', 'Bash', 'ok', '输出', T0 + 200),
      messageItem('assistant', '好了', T0 + 300),
    ]);
    assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), label + ' 无参调用不能被吞：' + JSON.stringify(back.turns.map(turnCore)).slice(0, 400));
  });
}

// ---- 真机复跑暴露的两处口径漂移（2026-11-03）：源侧与回读侧必须算出同一个核心指纹 ----

test('工具入参是裸字符串时，写侧包装（{value:…}）不得让复跑判成分叉', () => {
  const src = makeSession({ id: 'str-input', variant: 'claude', title: 't', turns: [
    { items: [messageItem('user', '跑一下', T0), toolCallItem('call-1', 'exec', 'const r = await tools.exec_command({cmd:"ls"});', T0 + 100), toolResultItem('call-1', 'exec', 'ok', 'out', T0 + 200)] },
  ] });
  // 同一份内容，入参写成 opencode 那种 {value: 字符串} 形态（写侧 schema 要求对象）
  const wrapped = makeSession({ id: 'str-input', variant: 'claude', title: 't', turns: [
    { items: [messageItem('user', '跑一下', T0), toolCallItem('call-1', 'exec', { value: 'const r = await tools.exec_command({cmd:"ls"});' }, T0 + 100), toolResultItem('call-1', 'exec', 'ok', 'out', T0 + 200)] },
  ] });
  assert.deepEqual(sessionCoreFingerprints(wrapped), sessionCoreFingerprints(src), '包装层是表示差异，不该进核心指纹');
});

// 真机复跑（qoder-cn → workbuddy-cn，2026-11-13）暴露的形状：
// 附件是**本轮第一个 item**，排在用户文本之前。写侧若把附件降级成独立 assistant 消息，
// 这条消息会排在本轮 user 事件之前 —— 读侧 assembleTurns 没有 user 轮可挂，就凭空多开一轮，
// 核心指纹整体平移一格（8 轮变 9 轮、verify-failed）。原有 boundarySession 的附件在用户文本之后，
// 归属到当前轮，所以测不出这个形状。
function leadingAttachmentSession() {
  const turns = [
    { index: 0, role: 'user', startedAt: T0, items: [
      attachmentItem('pic.png', 'image', T0),
      messageItem('user', '看图，这个需求怎么改', T0),
      messageItem('assistant', '我先读一下代码', T0 + 100),
      toolCallItem('call_a', 'Read', { file_path: 'a.txt' }, T0 + 200),
      toolResultItem('call_a', 'Read', 'ok', 'file body', T0 + 300),
    ] },
    { index: 1, role: 'user', startedAt: T0 + 1000, items: [
      messageItem('user', '第二轮问题', T0 + 1000),
      messageItem('assistant', '第二轮回答', T0 + 1100),
    ] },
  ];
  return makeSession({ id: 'lead-att-src', variant: 'claude', title: '轮首附件', cwd: 'D:/work/demo', createdAt: T0, updatedAt: T0 + 1100, model: 'm-1', turns, meta: {} });
}

test('轮首附件：所有可写目标写入后读回仍是同一串轮次', () => {
  const { ctx } = setupHome();
  const src = leadingAttachmentSession();
  const want = sessionCoreFingerprints(src);
  assert.equal(want.length, 2, '源应正好 2 轮');
  const broken = [];
  for (const variant of WRITABLE_VARIANTS) {
    const writer = getWriter(variant);
    if (!writer) continue;
    const id = `lead-att-${variant}`;
    const res = writer.write(ctx, { session: src, targetId: id, mode: 'create', provenance: null, force: true });
    assert.equal(res.ok, true, `${variant} 写入失败: ${res.error}`);
    const back = readSession(variant, ctx, id)?.session;
    assert.ok(back, `${variant} 读不回`);
    if (back.turns.length !== 2 || JSON.stringify(sessionCoreFingerprints(back)) !== JSON.stringify(want)) {
      broken.push(`${variant}(轮次 ${back.turns.length}, 指纹 ${JSON.stringify(sessionCoreFingerprints(back).map((f) => f.slice(0, 6)))})`);
    }
  }
  assert.deepEqual(broken, [], `轮首附件导致轮次边界失真的变体: ${broken.join('; ')}`);
});

test('normalizeTurnItems：只挪轮首附件，核心骨架不变', () => {
  const leading = { role: 'user', items: [
    attachmentItem('a.png', 'image', T0),
    attachmentItem('b.png', 'image', T0),
    messageItem('user', '问题', T0),
    messageItem('assistant', '回答', T0 + 1),
  ] };
  const moved = normalizeTurnItems(leading);
  assert.deepEqual(moved.items.map((i) => i.kind), ['message', 'attachment', 'attachment', 'message'], '两个轮首附件都要归位到用户消息之后');
  assert.equal(moved.items[0].text, '问题');
  assert.deepEqual(turnCore(moved), turnCore(leading), '挪顺序不得改变核心骨架');

  const afterUser = { role: 'user', items: [messageItem('user', '问题', T0), attachmentItem('a.png', 'image', T0)] };
  assert.equal(normalizeTurnItems(afterUser), afterUser, '附件已在用户文本之后时原样返回');

  const noUser = { role: 'assistant', items: [attachmentItem('a.png', 'image', T0), messageItem('assistant', '回答', T0)] };
  assert.equal(normalizeTurnItems(noUser), noUser, '一轮没有用户消息时没有可归位的目标');
});

test('codex 的工具结果行不带 name 时，结果项必须沿用配对调用的名字', () => {
  // 真机实测：custom_tool_call 名字是 exec，但 custom_tool_call_output 没有 name 字段；
  // 读侧回落成 tool、写侧按 callId 合并后回读成 exec → 同一会话两套名字 → 复跑判 fork。
  const rows = [
    { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑一下' }] } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:02.000Z', payload: { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'ls' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:03.000Z', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'out' } },
  ];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m37-codex-name-'));
  try {
    const file = path.join(home, '.codex', 'sessions', '2026', '01', '01', 'rollout-2026-01-01T00-00-00-abcdef01-1111-2222-3333-444444444444.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: {} });
    const back = readSession('codex', ctx, 'abcdef01-1111-2222-3333-444444444444').session;
    const call = (back.turns ?? []).flatMap((t) => t.items ?? []).find((it) => it.kind === 'tool_call');
    const result = (back.turns ?? []).flatMap((t) => t.items ?? []).find((it) => it.kind === 'tool_result');
    assert.equal(call?.name, 'exec');
    assert.equal(result?.name, 'exec', '结果行没有 name 时必须沿用配对调用的名字，不能回落成 tool');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
