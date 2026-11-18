// M1 测试：identity / provenance / diff / ir / hosts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAMESPACE_DNS, uuid5, sha256hex, stableStringify, parseTimeSpec } from '../src/util.mjs';
import { outputText } from '../src/text.mjs';
import {
  NS, originKeyOf, mintTargetId, mintForkId, targetSessionId, forkSessionId, forkBranchKey,
} from '../src/identity.mjs';
import {
  buildProvenance, provenanceFromObject, embedInJsonObject, extractFromJsonObject,
  embedInJsonlLine, extractFromJsonlLine, tagTitle, provenanceSummary,
} from '../src/provenance.mjs';
import { decideAction, lcpLength } from '../src/diff.mjs';
import {
  makeSession, makeTurn, messageItem, reasoningItem, toolCallItem, toolResultItem,
  normalizeItem, turnFingerprint, sessionFingerprints, finalizeSession, previewText,
} from '../src/ir.mjs';
import { ALL_VARIANTS, VARIANTS, LOCATOR, skillsDirOf, makeCtx } from '../src/hosts.mjs';
import { detectInstalled } from '../src/roots.mjs';

function mkSession(n, { id = 'S', variant = 'codex', origin = null, chain = [] } = {}) {
  return makeSession({
    id,
    variant,
    origin,
    chain,
    turns: Array.from({ length: n }, (_, i) => makeTurn(
      i % 2 === 0 ? 'user' : 'assistant',
      [messageItem(i % 2 === 0 ? 'user' : 'assistant', `m${i}`, i * 1000)],
      i * 1000,
    )),
  });
}

test('uuid5 确定且格式合法', () => {
  const a = uuid5('x', NAMESPACE_DNS);
  assert.equal(a, uuid5('x', NAMESPACE_DNS));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, uuid5('y', NAMESPACE_DNS));
  assert.equal(NS, uuid5('session-sync/identity/v1', NAMESPACE_DNS));
});

test('originKey：原生取自身，导入取内嵌 origin', () => {
  assert.equal(originKeyOf(mkSession(1, { id: 'X', variant: 'codex' })), 'codex:X');
  const imported = mkSession(1, { id: 'P', variant: 'pi', origin: { variant: 'codex', sessionId: 'X' } });
  assert.equal(originKeyOf(imported), 'codex:X');
});

test('目标 ID 派生：各家族形态与确定性', () => {
  const k = 'codex:X';
  const shapes = {
    'workbuddy-cn': /^[0-9a-f-]{36}$/, 'workbuddy-intl': /^[0-9a-f-]{36}$/,
    claude: /^[0-9a-f-]{36}$/, codebuddy: /^[0-9a-f-]{36}$/, 'codebuddy-ide': /^[0-9a-f]{32}$/, pi: /^[0-9a-f-]{36}$/, codex: /^[0-9a-f-]{36}$/,
    opencode: /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, dsh: /^[0-9a-f-]{36}$/, cursor: /^[0-9a-f-]{36}$/,
    mimo: /^ses_[0-9a-f]{22}$/, zcode: /^sess_[0-9a-f-]{36}$/, kilo: /^[0-9a-f-]{36}$/,
    minimax: /^mvs_[0-9a-f]{32}$/, freebuff: /^sync-[0-9a-f]{16}$/,
    'qoder-cn': /^[0-9a-f]{20}$/, 'qoder-intl': /^[0-9a-f]{20}$/, cline: /^\d{13}$/,
  };
  for (const [variant, re] of Object.entries(shapes)) {
    const id = mintTargetId(variant, k);
    assert.match(id, re, variant);
    assert.equal(id, mintTargetId(variant, k), `${variant} 确定性`);
  }
});

test('round-trip：导回原生变体收敛到原生会话 ID', () => {
  const native = mkSession(2, { id: 'W', variant: 'workbuddy-cn' });
  assert.equal(targetSessionId('workbuddy-cn', native), 'W');
  // 经 codex 中转再回 workbuddy
  const viaCodex = mkSession(2, { id: 'P', variant: 'pi', origin: { variant: 'workbuddy-cn', sessionId: 'W' }, chain: [{ variant: 'workbuddy-cn', sessionId: 'W', at: 1 }] });
  assert.equal(targetSessionId('workbuddy-cn', viaCodex), 'W');
  // 导到别处则是新 ID
  assert.notEqual(targetSessionId('pi', native), 'W');
});

test('fork ID：同分歧同 ID，异分歧异 ID', () => {
  const src = mkSession(3, { id: 'X', variant: 'codex' });
  const h = sha256hex('div');
  assert.equal(forkSessionId('pi', src, h), forkSessionId('pi', src, h));
  assert.notEqual(forkSessionId('pi', src, h), forkSessionId('pi', src, sha256hex('other')));
  assert.notEqual(forkSessionId('pi', src, h), targetSessionId('pi', src));
  // 多路径：经 pi 中转的同一原始会话，origin 不变 → fork ID 相同
  const viaPi = mkSession(3, { id: 'P', variant: 'pi', origin: { variant: 'codex', sessionId: 'X' } });
  assert.equal(forkSessionId('pi', viaPi, h), mintForkId('pi', 'codex:X', h));
});

test('provenance：构造/解析/JSON 槽位 round-trip', () => {
  const src = mkSession(1, { id: 'X', variant: 'codex' });
  const p1 = buildProvenance(src, 1000);
  assert.deepEqual(p1.origin, { variant: 'codex', sessionId: 'X' });
  assert.equal(p1.chain.length, 1);

  const obj = embedInJsonObject({ composerId: 'c1' }, p1);
  const parsed = provenanceFromObject(extractFromJsonObject(obj));
  assert.ok(parsed);
  assert.equal(parsed.origin.sessionId, 'X');

  const line = embedInJsonlLine({ type: 'session' }, p1);
  assert.ok(provenanceFromObject(extractFromJsonlLine(line)));

  // 非法对象 → null
  assert.equal(provenanceFromObject({ foo: 1 }), null);
  assert.equal(provenanceFromObject({ tool: 'other', v: 1, origin: { variant: 'a', sessionId: 'b' } }), null);

  // 二次中转：chain 追加，origin 不变
  const hop = mkSession(1, { id: 'P', variant: 'pi', origin: parsed.origin, chain: parsed.chain });
  const p3 = buildProvenance(hop, 2000);
  assert.equal(p3.chain.length, 2);
  assert.equal(p3.chain[1].variant, 'pi');
  assert.equal(p3.origin.variant, 'codex');
  assert.equal(provenanceSummary(p3), 'codex:X → codex:X → pi:P');

  // 连续 build 不重复追加同一跳
  const p4 = buildProvenance(hop, 3000);
  assert.equal(p4.chain.length, 2);
});

test('provenance：标题标签', () => {
  const p = buildProvenance(mkSession(1, { id: 'X', variant: 'codex' }));
  assert.equal(tagTitle('my chat', p), '[codex] my chat');
  assert.equal(tagTitle('[codex] my chat', p), '[codex] my chat'); // 不重复打标
  assert.equal(tagTitle('', p), '[codex] imported session');
});

test('diff：五态决策', () => {
  // create
  assert.equal(decideAction(mkSession(2), null).action, 'create');
  // skip identical
  assert.equal(decideAction(mkSession(3), mkSession(3), true).action, 'skip');
  // skip target-ahead
  assert.equal(decideAction(mkSession(2), mkSession(3), true).action, 'skip');
  // append：身份相同 + 目标是源的严格前缀（原生与导入会话一律允许）
  const r1 = decideAction(mkSession(3), mkSession(2), true);
  assert.equal(r1.action, 'append');
  assert.equal(r1.at, 2);
  // fork：双方分叉
  const dst = mkSession(2);
  dst.turns[1].items[0].text = 'changed';
  const r2 = decideAction(mkSession(3), dst, true);
  assert.equal(r2.action, 'fork');
  // fork 结果只报「在第几轮分歧」：分支坐标由调用方拿着 at 去算（identity.forkBranchKey）
  assert.equal(r2.at, 1);
  // 身份不同：绝不 append/skip，fork 并标 identity-mismatch
  const r3 = decideAction(mkSession(3), mkSession(2), false);
  assert.equal(r3.action, 'fork');
  assert.equal(r3.reason, 'identity-mismatch');
  assert.equal(decideAction(mkSession(3), mkSession(3), false).reason, 'identity-mismatch');
  assert.equal(decideAction(mkSession(2), mkSession(3), false).reason, 'identity-mismatch');
  // fork 判定是纯内容判断，同一输入必然同一结论
  assert.equal(decideAction(mkSession(3), dst, true).at, r2.at);
});

test('diff：lcp 只有一份实现', () => {
  assert.equal(lcpLength(['a', 'b', 'c'], ['a', 'b', 'x', 'y']), 2);
  assert.equal(lcpLength([], ['a']), 0);
});

test('fork 分支坐标：父基准 + 分歧点 + 第 k 轮，分支后续增长不换 ID', () => {
  const parent = 'base-id';
  const at = 2;
  const k = forkBranchKey(parent, at, mkSession(4).turns[at]);
  // 同内容 → 同坐标（不同来源、不同时刻到达都一样）
  assert.equal(forkBranchKey(parent, at, mkSession(4).turns[at]), k);
  // 父基准不同 → 必须是两条分支
  assert.notEqual(forkBranchKey('other-base', at, mkSession(4).turns[at]), k);
  // 分歧点不同 → 不同的 fork
  assert.notEqual(forkBranchKey(parent, 1, mkSession(4).turns[1]), k);
  // 关键：第 k 轮之后新长出来的轮次**不许**影响坐标。
  // 旧的「源侧整段后缀哈希」正是在这里错：分支每续一轮尾巴就变，fork ID 跟着变，
  // 同一个分支在不同时刻导入会累积出多条近似副本。
  const grown = mkSession(6);
  assert.equal(forkBranchKey(parent, at, grown.turns[at]), k, '分支增长不许改 fork ID');
});

test('ir：指纹忽略 ts/id，感知内容', () => {
  const s1 = mkSession(1, { id: 'a' });
  const s2 = mkSession(1, { id: 'b' });
  s2.turns[0].items[0].ts = 999999;
  assert.equal(sessionFingerprints(s1)[0], sessionFingerprints(s2)[0]);
  const s3 = mkSession(1);
  s3.turns[0].items.push(reasoningItem('think'));
  assert.notEqual(sessionFingerprints(s1)[0], sessionFingerprints(s3)[0]);
});

test('ir：finalize/preview/normalize', () => {
  const s = finalizeSession(mkSession(2, { id: 'a' }));
  assert.equal(s.turns[0].index, 0);
  assert.equal(s.turns[1].index, 1);
  assert.equal(s.updatedAt, 1000);
  assert.equal(previewText(s), 'm0');
  assert.deepEqual(normalizeItem(toolCallItem('c1', 'bash', { cmd: 'ls' }, 5)), { kind: 'tool_call', name: 'bash', input: { cmd: 'ls' } });
  assert.deepEqual(normalizeItem(toolResultItem('c1', 'bash', 'ok', { out: 'x' })), { kind: 'tool_result', name: 'bash', status: 'ok', output: { out: 'x' } });
  assert.deepEqual(normalizeItem({ kind: 'weird', text: 't' }), { kind: 'note', text: 't' });
  assert.equal(turnFingerprint(makeTurn('user', [])), turnFingerprint(makeTurn('user', [])));
});

test('hosts：21 变体登记与路径解析', () => {
  assert.equal(ALL_VARIANTS.length, 21);
  assert.equal(ALL_VARIANTS.filter((v) => VARIANTS[v].read).length, 21);
  // 架构上可写 18 家；antigravity/cursor/doubao 只读（原因见 hosts.mjs 注释）
  assert.equal(ALL_VARIANTS.filter((v) => VARIANTS[v].write).length, 18);
  for (const ro of ['antigravity', 'cursor', 'doubao']) {
    assert.equal(VARIANTS[ro].write, false, ro);
  }
  // qoder×2 本轮转可写：正文 jsonl 明文 + 桌面注册表 main.sqlite 明文（2026-10-28 真机取证）
  for (const q of ['qoder-cn', 'qoder-intl']) {
    assert.equal(VARIANTS[q].write, 'B', q);
    assert.ok(VARIANTS[q].readPaths(makeCtx({ home: '/h', platform: 'win32', env: {} })).some((x) => x.role === 'registry'), `${q} 必须登记注册表路径`);
  }
  assert.equal(VARIANTS.zcode.write, 'B', 'zcode 本轮改为可写（明文 SQLite + tasks-index 双库）');
  assert.equal(VARIANTS.minimax.write, 'B', 'minimax 本轮改为可写（只写 DB，物化交给宿主）');
  assert.equal(VARIANTS['workbuddy-cn'].write, 'A');
  const ctx = makeCtx({ home: '/home/tester', platform: 'linux', env: {} });
  for (const name of ALL_VARIANTS) {
    const paths = VARIANTS[name].readPaths(ctx);
    assert.ok(paths.length > 0, name);
    for (const x of paths) assert.ok(typeof x.path === 'string' && x.path.length > 0, `${name}: ${x.path}`);
  }
  // cursor 只读：writePaths 为空
  assert.deepEqual(VARIANTS.cursor.writePaths(ctx), []);
  // skills 落点：codex / codebuddy-ide / freebuff 没有独立 skill 目录
  assert.equal(skillsDirOf(ctx, 'codex'), null);
  assert.equal(skillsDirOf(ctx, 'freebuff'), null);
  assert.equal(skillsDirOf(ctx, 'codebuddy-ide'), null);
  assert.equal(ALL_VARIANTS.filter((v) => skillsDirOf(ctx, v)).length, 17);
  // 根被 CLAUDE_CONFIG_DIR 搬走时，skills 必须跟着一起搬
  // （以前 skillsDir 与 readPaths 各算一遍 env，会出现「会话在 D 盘、技能装 C 盘」的半搬状态）
  const moved = makeCtx({ home: ctx.home, platform: 'linux', env: { CLAUDE_CONFIG_DIR: '/srv/claude' } });
  assert.match(skillsDirOf(moved, 'claude'), /claude[\\/]+skills$/);
  assert.match(VARIANTS.claude.readPaths(moved)[0].path, /claude[\\/]+projects$/);
  // locator 是这三件事的唯一声明处，VARIANTS 里不该再有第二个 skillsDir
  assert.equal(VARIANTS.claude.skillsDir, undefined, 'skillsDir 只能由 LOCATOR 声明');
  assert.equal(Object.keys(LOCATOR).length, ALL_VARIANTS.length);
});

test('hosts：detectInstalled 在空 home 下返回空', () => {
  const ctx = makeCtx({ home: '/nonexistent-home-xyz', platform: 'linux', env: {} });
  assert.deepEqual(detectInstalled(ctx), []);
});

test('util：stableStringify 键序无关', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }),
    stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }),
  );
});

test('util：parseTimeSpec', () => {
  const now = 1700000000000;
  assert.equal(parseTimeSpec('7d', now), now - 7 * 86400000);
  assert.equal(parseTimeSpec('12h', now), now - 12 * 3600000);
  assert.equal(parseTimeSpec('30m', now), now - 30 * 60000);
  assert.equal(parseTimeSpec('2026-10-01', now), Date.parse('2026-10-01'));
  assert.equal(parseTimeSpec(null, now), null);
  assert.throws(() => parseTimeSpec('not-a-time', now));
});

test('util：toolOutputText 把字符串/文本块数组/{text}/{content[]} 归一成同一段文本', () => {
  assert.equal(outputText('ok'), 'ok');
  assert.equal(outputText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲\n乙');
  assert.equal(outputText({ text: '丙' }), '丙');
  assert.equal(outputText({ content: [{ type: 'text', text: '丁' }] }), '丁');
  assert.equal(outputText({ status: 'success' }), '{"status":"success"}');
  assert.equal(outputText(null), null);
});
