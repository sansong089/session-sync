// M88 测试：宿主注入的压缩摘要必须落成 opencode **原生 compaction 边界**
//
// 真机取证（会话 ses_e1c76339dffeWy5BaXFRbayRW0，源 workbuddy-cn 1247ccc6）：
//   续写报 400 Provider returned error，重放抓包请求拿到网关原始响应体
//   `[400003] Input tokens exceed the model context limit` —— 是**尺寸**不是配额。
//   源 20.5MB/4900 事件（源宿主自己压缩过 10 次），忠实导入后摘要成了普通 user 消息
//   → opencode 不认它是压缩边界 → 续写时把全部历史压平成一条 user 消息：抓包里该会话
//   25 次 compaction 请求，hy4-flash-free/high 下整请求 3.43–4.05MB（压平那条 user 占 3.3–3.9MB）。
//   该会话后来靠**换大上下文模型**（deepseek-v4.1-flash-free/max）压缩成功才自愈，
//   所以现网旧目标已不复现 400；复现要用删掉旧目标后重新导入的沙箱。
//   修后沙箱实测（2026-11-19）：10 条原生 compaction 行落在源 10 个 cmp_ 的同一批 seq 上，
//   续写只发 1 次 **primary** 请求 214199B（system 106581 + checkpoint 摘要 22800 + 尾部轮次），
//   9 份早期摘要在请求里 0 次出现，hy4-flash-free 直接答对 —— 不再触发 compaction。
//
// 宿主机制（上游源码实证）：
//   history.ts latestCompaction：type='compaction' 且 data.status='completed' 的最新一行是边界；
//   messageEntries 只读 seq >= 边界.seq；本地摘要（无 native.messages）无条件成边界、与模型无关；
//   runner-llm.ts estimatePrompt(loaded) 用的是**已截断**历史 → 不再触发自动 compaction；
//   rowInput 把行的 type 列注入解码对象 ⇒ data 内**不放** type；
//   解码失败会 orDie ⇒ 形状不对的 compaction 行让整条会话读不出来（比 400 更严重）。
//
// 方案 A（用户定稿）：压缩轮的**核心指纹** = 剥掉宿主包裹后的内层摘要正文 X。
//   规范化在读/算时统一施加于源与目标 → 收敛不变量保持，存量不需要迁移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';
import { opencodeReader } from '../src/readers/opencode.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { decideAction } from '../src/diff.mjs';
import { verifyImported } from '../src/verify.mjs';
import { makeTurn, messageItem, attachmentItem, sessionCoreFingerprints, turnCoreFingerprint } from '../src/ir.mjs';
import { compactionSummaryText, compactionInjectionKind } from '../src/text.mjs';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

const TS = 1792635493378;
const TARGET = 'ses_e1729a950ffeCmp00000000001';
const HOST_MODEL = { id: 'hy4-flash-free', providerID: 'opencode', variant: 'high' };
const SUM = '## Objective\n- 迁移 event_callback_url 字段到新表\n- DAO 层已完成';
const PHRASE = 'Please continue with the conversation based on the summarized context above. Maintain the same level of detail and helpfulness as before the summarization.';
const CB = `<cb_summary>\n${SUM}\n</cb_summary>`;
const CHS = `<conversation_history_summary>\n${SUM}\n</conversation_history_summary>`;
const PROV = JSON.stringify({ 'session-sync': { origin: { variant: 'workbuddy-cn', sessionId: 'src-c' }, tool: 'session-sync', v: 1 } });

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m88-${name}-`));
}
function ctxFor(root, env = {}) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } }),
    ['workbuddy-cn', 'opencode'],
  );
}
function mkDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT NOT NULL PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`);
  db.close();
  return file;
}
// 宿主线：提供真实 model ref（含 variant）与宿主版本
function seedNative(file) {
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1','D:/x','git',?,?,0,'[]')`).run(TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES ('ses_native000000000000000000001','p1','n','D:/x','','原生','2.1.4','build',?,?,?)`).run(JSON.stringify(HOST_MODEL), TS, TS);
  db.close();
}
function setup(name) {
  const home = tmpHome(name);
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  seedNative(file);
  return { home, file, ctx: ctxFor(home, { OPENCODE_DATA_DIR: dataDir }) };
}
function rowsOf(file, sessionId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq').all(sessionId);
  } finally {
    db.close();
  }
}
const parsed = (rows) => rows.map((r) => ({ type: r.type, seq: r.seq, data: JSON.parse(r.data) }));
const u = (text, ts = TS) => messageItem('user', text, ts);
const a = (text, ts = TS + 1) => messageItem('assistant', text, ts);
const turn = (items) => makeTurn('user', items, TS);
function srcSession(home, turns) {
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    id: 'src-c', title: '压缩会话', cwd, createdAt: TS, updatedAt: TS + 100, model: 'm-1',
    origin: { variant: 'workbuddy-cn', sessionId: 'src-c' }, turns,
  };
}
function write(ctx, session, mode = 'create', targetId = TARGET) {
  const out = opencodeWriter.write(ctx, { session, targetId, mode });
  assert.equal(out.ok, true, JSON.stringify(out));
  return out;
}
// 源侧 workbuddy 真形态：普通轮 uuid id，压缩轮 cmp_ id + 标签包裹正文
function mkWbSource(home, id, { summary = CB } = {}) {
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const msg = (eid, role, text, ms) => ({ type: 'message', id: eid, role, content: [{ type: 'text', text }], timestamp: iso(ms), logicalParentId: null });
  const rows = [
    { type: 'session-meta', id, cwd, timestamp: iso(TS) },
    msg('01a1u1', 'user', '第一轮问题', TS + 1),
    msg('01a1a1', 'assistant', '第一轮回答', TS + 2),
    { ...msg('cmp_0001', 'user', summary, TS + 3), logicalParentId: '01a1a1' },
    msg('01a1a2', 'assistant', '压缩后回答', TS + 4),
    msg('01a1u2', 'user', '第二轮问题', TS + 5),
    msg('01a1a3', 'assistant', '第二轮回答', TS + 6),
  ];
  const file = path.join(home, '.workbuddy', 'projects', 'd--proj', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { file, cwd };
}
const runImport = (ctx) => executePlan(ctx, planImport(ctx, { from: ['workbuddy-cn'], into: ['opencode'] }), { apply: true, lock: false });

// ---- 1. 剥壳函数本身 ----

test('compactionSummaryText：两标签、整段/嵌入/多段/嵌套都剥，无标签恒等，缺闭合不吞正文', () => {
  const cases = [
    [CB, `\n${SUM}\n`],
    [CHS, `\n${SUM}\n`],
    [`前缀 ${CHS} 后缀`, `前缀 \n${SUM}\n 后缀`],
    ['<cb_summary>A</cb_summary>\n\n<cb_summary>B</cb_summary>', 'A\n\nB'],
    ['<cb_summary>a<cb_summary>b</cb_summary>c</cb_summary>', 'abc'],
    ['<cb_summary>未闭合', '<cb_summary>未闭合'],
    ['普通正文，提到 cb_summary 这个词', '普通正文，提到 cb_summary 这个词'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(compactionSummaryText(input), want, `剥壳结果不符：${JSON.stringify(input)}`);
  }
  assert.equal(compactionSummaryText(null), '');
  assert.equal(compactionSummaryText(undefined), '');
  // 判「带包裹」就是剥壳前后不等，不另开判据
  assert.notEqual(compactionSummaryText(CB), CB);
  assert.equal(compactionSummaryText('普通文本'), '普通文本');
  assert.equal(compactionInjectionKind(PHRASE), 'compaction');
});

// ---- 2/3. 核心指纹规范化（方案 A）----

test('核心指纹：两种宿主包裹与裸正文算出同一个骨架', () => {
  const fp = (text) => turnCoreFingerprint(turn([u(text)]));
  assert.equal(fp(CB), fp(CHS), '两种标签是表示差异，不是内容差异');
  assert.equal(fp(CB), fp(SUM), '剥壳后必须等于内层正文');
  assert.equal(fp(`<cb_summary>${SUM}</cb_summary>`), fp(SUM), '首尾空白由 normalizeText 归一');
});

test('核心指纹：摘要与真实用户文本混排也收敛（无条件剥壳，不只在整段纯摘要时剥）', () => {
  const split = turn([u(CB), u('真实问题')]);
  const joined = turn([u(`${CB}\n\n真实问题`)]);
  assert.equal(turnCoreFingerprint(split), turnCoreFingerprint(joined), '分块与拼接是表示差异');
  // 目标侧兜底写成一条 plain user（正文含标签），读回后核心仍与源一致
  const targetSide = turn([u(`${CB}\n\n真实问题`), a('回答')]);
  const sourceSide = turn([u(CB), u('真实问题'), a('回答')]);
  assert.equal(turnCoreFingerprint(targetSide), turnCoreFingerprint(sourceSide));
});

// ---- 4/5. 写侧形状 + 读回收敛 ----

test('写侧：纯压缩轮落成原生 compaction 行（completed/auto/summary 原文，data 内无 type）', () => {
  const { home, file, ctx } = setup('shape');
  const src = srcSession(home, [turn([u('第一轮问题'), a('第一轮回答')]), turn([u(CB), a('压缩后回答')]), turn([u('第二轮问题'), a('第二轮回答')])]);
  write(ctx, src);

  const rows = parsed(rowsOf(file, TARGET));
  assert.deepEqual(rows.map((r) => r.type), ['user', 'assistant', 'compaction', 'assistant', 'user', 'assistant']);
  const c = rows.find((r) => r.type === 'compaction');
  assert.equal(c.data.status, 'completed');
  assert.equal(c.data.reason, 'auto');
  assert.equal(c.data.summary, `\n${SUM}\n`, '摘要存剥壳后的**原文**（含首尾空白），一个字不丢');
  assert.ok(!('type' in c.data), '判别器来自行的 type 列（上游 rowInput 注入），data 内不得放 type');
  assert.ok(!('native' in c.data) && !('providerContext' in c.data), '本地摘要：不写 native，才能无条件成边界');
  assert.ok(Number.isFinite(c.data.time?.created), 'time.created 必填（Base schema）');
  assert.deepEqual(c.data.model, HOST_MODEL, 'model 取宿主真实 ref（含 variant）');
  assert.ok(rows.every((r) => r.seq === rows.indexOf(r)), 'seq 连续递增');
});

test('读回：compaction 行还原成一轮，核心指纹逐轮相等、轮数不变', () => {
  const { home, file, ctx } = setup('roundtrip');
  const src = srcSession(home, [turn([u('第一轮问题'), a('第一轮回答')]), turn([u(CHS), a('压缩后回答')]), turn([u('第二轮问题'), a('第二轮回答')])]);
  write(ctx, src);

  const back = opencodeReader.read(ctx, TARGET);
  assert.ok(back, '写出的会话必须读得回来');
  assert.equal(back.turns.length, src.turns.length, '一条 compaction 行 = 一轮，不得多开或少开');
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), '核心指纹必须逐轮收敛');
  const summaryTurn = back.turns[1].items.find((it) => it.kind === 'message' && it.role === 'user');
  // 统一归一化口径：text = 剥壳裸正文，compact:true 承载语义（正文与语义正交，导回任何宿主无损）
  assert.equal(summaryTurn.text, SUM, '读回是裸摘要正文（无宿主标签壳）');
  assert.equal(summaryTurn.compact, true, '压缩语义由 compact 位承载，不污染正文');
  assert.ok(summaryTurn.text.includes(SUM), '摘要正文完整读回');
  assert.equal(listSessions('opencode', ctx).sessions.find((s) => s.id === TARGET).turns, back.turns.length, 'list 计数 == read 轮数');
});

// ---- 6/7. 真夹具端到端 + 幂等 ----

test('workbuddy 真形态端到端：cmp_ 压缩轮 → opencode 原生边界 → 读回核心一致', () => {
  const { home, file, ctx } = setup('wb-e2e');
  mkWbSource(home, 'wb-src-1');
  const src = readSession('workbuddy-cn', ctx, 'wb-src-1').session;
  assert.ok(src, '源会话必须读得出');
  assert.equal(src.turns.length, 3);

  const out = write(ctx, src, 'create', 'ses_e1729a950ffeCmp00000000002');
  const rows = parsed(rowsOf(file, out.targetId));
  assert.equal(rows.filter((r) => r.type === 'compaction').length, 1, '源里一个 cmp_ 摘要 → 一条 compaction 行');
  const back = readSession('opencode', ctx, out.targetId).session;
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), '跨宿主核心指纹逐轮相等');
  assert.equal(back.turns.length, 3);
});

test('幂等：同源复跑判 skip，正文行不重复、seq 计数器只进不退', () => {
  const { home, file, ctx } = setup('idempotent');
  mkWbSource(home, 'wb-src-2');
  const first = runImport(ctx)[0];
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.action, 'create');
  assert.equal(first.verify.ok, true, JSON.stringify(first.verify));

  const before = rowsOf(file, first.targetId);
  const seqBefore = new DatabaseSync(file, { readOnly: true });
  const counterBefore = seqBefore.prepare('SELECT seq FROM event_sequence WHERE aggregate_id=?').get(first.targetId).seq;
  seqBefore.close();
  assert.ok(before.some((r) => r.type === 'compaction'), '首次导入必须写出 compaction 行');

  const second = runImport(ctx)[0];
  assert.equal(second.action, 'skip', `复跑必须判 skip：${JSON.stringify(second)}`);
  assert.equal(second.reason, 'identical');
  const after = rowsOf(file, first.targetId);
  assert.deepEqual(after.map((r) => r.data), before.map((r) => r.data), 'skip 不得改写正文行');
  const db = new DatabaseSync(file, { readOnly: true });
  const counterAfter = db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id=?').get(first.targetId).seq;
  db.close();
  assert.ok(counterAfter >= counterBefore, '计数器只进不退');
});

test('append：源新增压缩轮 → 新摘要原生写入、边界前移，旧行逐字节不变', () => {
  const { home, file, ctx } = setup('append');
  const { file: srcFile } = mkWbSource(home, 'wb-src-3');
  const first = runImport(ctx)[0];
  assert.equal(first.action, 'create');
  assert.equal(first.verify.ok, true, JSON.stringify(first.verify));
  const before = rowsOf(file, first.targetId);
  assert.equal(before.filter((r) => r.type === 'compaction').length, 1);

  // 源续写：一轮普通问答 + 一轮**新的**压缩摘要（正文与第一份不同）
  const iso = (ms) => new Date(ms).toISOString();
  const msg = (eid, role, text, ms) => ({ type: 'message', id: eid, role, content: [{ type: 'text', text }], timestamp: iso(ms), logicalParentId: null });
  const SUM2 = '## Objective\n- 第三轮之后改用新表索引\n- 迁移脚本已跑完';
  const grown = [
    msg('01a1u3', 'user', '第三轮问题', TS + 7),
    msg('01a1a4', 'assistant', '第三轮回答', TS + 8),
    { ...msg('cmp_0002', 'user', `<cb_summary>\n${SUM2}\n</cb_summary>`, TS + 9), logicalParentId: '01a1a4' },
    msg('01a1a5', 'assistant', '新压缩后回答', TS + 10),
  ];
  fs.appendFileSync(srcFile, grown.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const src = readSession('workbuddy-cn', ctx, 'wb-src-3').session;
  assert.equal(src.turns.length, 5);
  const second = runImport(ctx)[0];
  assert.equal(second.action, 'append', `必须判 append：${JSON.stringify(second)}`);
  assert.equal(second.at, 3, '分歧点 = 目标已有轮数');
  assert.equal(second.verify.ok, true, JSON.stringify(second.verify));

  const after = rowsOf(file, first.targetId);
  assert.deepEqual(after.slice(0, before.length).map((r) => r.data), before.map((r) => r.data), 'append 不得改写已有正文行');
  assert.equal(after.length - before.length, 4, '新增两轮的 4 条行');
  const ids = after.map((r) => r.id);
  const seqs = after.map((r) => r.seq);
  assert.equal(new Set(ids).size, ids.length, '不得有重复行 id');
  assert.equal(new Set(seqs).size, seqs.length, '不得有重复 seq');

  const cmp = parsed(after).filter((r) => r.type === 'compaction');
  assert.equal(cmp.length, 2, '新摘要也必须是原生 compaction 行');
  assert.ok(cmp[1].data.summary.includes(SUM2), '新摘要正文进 data.summary');
  assert.equal(cmp[1].data.status, 'completed');
  assert.ok(!('type' in cmp[1].data), 'data 内不得放 type');
  assert.ok(cmp[1].seq > cmp[0].seq, '边界前移：最新一条 completed 行才是宿主取的边界');
  assert.equal(cmp[1].seq, Math.max(...cmp.map((r) => r.seq)));

  const db = new DatabaseSync(file, { readOnly: true });
  const counter = db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id=?').get(first.targetId).seq;
  db.close();
  assert.ok(counter >= Math.max(...seqs), '计数器登记到已占用的最大 seq');

  const back = readSession('opencode', ctx, first.targetId).session;
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), 'append 后核心指纹逐轮相等');
  assert.equal(listSessions('opencode', ctx, {}).sessions.find((s) => s.id === first.targetId).turns, back.turns.length, 'list == read');
});

// ---- 8/9. 续写提示同轮 + 三类兜底 ----

test('摘要 + 「请基于摘要继续」同轮：仍是一条 compaction，提示并入摘要不丢字', () => {
  const { home, file, ctx } = setup('phrase');
  const src = srcSession(home, [turn([u(CB), u(PHRASE), a('继续回答')])]);
  write(ctx, src);
  const rows = parsed(rowsOf(file, TARGET));
  assert.deepEqual(rows.map((r) => r.type), ['compaction', 'assistant'], '不得为提示另开一轮');
  assert.ok(rows[0].data.summary.includes(SUM) && rows[0].data.summary.includes(PHRASE), '摘要与提示正文都在');
  const back = opencodeReader.read(ctx, TARGET);
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src));
});

test('兜底：混排真实文本 / 带附件 / 空摘要一律走 plain user，内容不丢', () => {
  const { home, file, ctx } = setup('fallback');
  const cases = [
    { name: 'mixed', items: [u(CB), u('真实问题')], text: `${CB}\n\n真实问题` },
    { name: 'attach', items: [u(CB), attachmentItem('D:/x/a.txt', 'user file')], text: CB },
    { name: 'empty', items: [u('<cb_summary></cb_summary>')], text: '<cb_summary></cb_summary>' },
  ];
  cases.forEach((c, i) => {
    const id = `ses_e1729a950ffeCmp0000000010${i}`;
    const src = srcSession(home, [turn(c.items)]);
    write(ctx, src, 'create', id);
    const rows = parsed(rowsOf(file, id));
    assert.equal(rows[0].type, 'user', `${c.name}: 必须兜底成 plain user`);
    assert.equal(rows[0].data.text, c.text, `${c.name}: 正文原样保留（写侧不剥壳）`);
    if (c.name === 'attach') assert.equal(rows[0].data.files.length, 1, '附件不得丢');
    const back = opencodeReader.read(ctx, id);
    assert.equal(back.turns.length, 1, `${c.name}: 空摘要也不得丢轮`);
    assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), `${c.name}: 核心仍收敛`);
  });
});

// ---- 10. 存量不管：收敛但不改写 ----

test('存量：旧 plain-user 摘要行与新核心收敛 → 判 identical/skip，正文不被改写成 compaction', () => {
  const { home, file, ctx } = setup('legacy');
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?)`).run(TARGET, 'p1', 'x', 'D:/x', '旧导入', 'session-sync/1', PROV, 'build', null, TS, TS);
  const ins = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  ins.run('msg_l0', TARGET, 'user', 0, TS, TS, JSON.stringify({ time: { created: TS }, text: CB, files: [], agents: [] }));
  ins.run('msg_l1', TARGET, 'assistant', 1, TS, TS, JSON.stringify({
    time: { created: TS, completed: TS, streamed: TS }, agent: 'build', model: HOST_MODEL,
    content: [{ type: 'text', text: '压缩后回答' }], finish: 'stop', rawFinish: 'stop', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }));
  db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?,?,NULL)').run(TARGET, 1);
  db.close();

  const target = opencodeReader.read(ctx, TARGET);
  const src = srcSession(home, [turn([u(CB), a('压缩后回答')])]);
  assert.deepEqual(decideAction(src, target, true), { action: 'skip', reason: 'identical' }, '存量与新核心收敛，不得判 fork');

  const before = rowsOf(file, TARGET).map((r) => r.data);
  opencodeWriter.repair(ctx);
  const after = rowsOf(file, TARGET);
  assert.deepEqual(after.map((r) => r.data), before, '自愈不得改写存量正文行');
  assert.ok(!after.some((r) => r.type === 'compaction'), '存量不被自愈成原生边界（要享受边界必须删旧目标重导）');
});

// ---- 11. 原生行形状 + 计数判据 ----

test('原生 compaction 行（带 recent/cost/tokens/metadata）读回成一轮；非 completed/空摘要两侧都不计', () => {
  const { home, file, ctx } = setup('native-shape');
  const db = new DatabaseSync(file);
  const insS = db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
                           VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`);
  const insM = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  const NATIVE_ID = 'ses_e1729a950ffeNat00000000001';
  insS.run(NATIVE_ID, 'p1', 'nat', 'D:/x', '原生压缩', '2.1.4', 'build', JSON.stringify(HOST_MODEL), TS, TS);
  // 真机原生行的完整键集（实测 27 条）：time,status,reason,model,summary,recent,cost,tokens
  insM.run('msg_n0', NATIVE_ID, 'compaction', 0, TS, TS, JSON.stringify({
    time: { created: TS }, status: 'completed', reason: 'auto', model: HOST_MODEL, summary: SUM,
    recent: '最近上下文', cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: { keepID: 'msg_missing' },
  }));
  insM.run('msg_n1', NATIVE_ID, 'user', 1, TS, TS, JSON.stringify({ time: { created: TS }, text: '问题', files: [], agents: [] }));

  const BAD_ID = 'ses_e1729a950ffeBad00000000001';
  insS.run(BAD_ID, 'p1', 'bad', 'D:/x', '无效压缩', '2.1.4', 'build', JSON.stringify(HOST_MODEL), TS, TS);
  const bad = [
    { time: { created: TS }, status: 'running', reason: 'auto', summary: SUM },
    { time: { created: TS }, status: 'failed', reason: 'auto', error: { type: 'x', message: 'y' } },
    { time: { created: TS }, status: 'completed', reason: 'auto', summary: 123 },
    { time: { created: TS }, status: 'completed', reason: 'auto', summary: '   ' },
    { time: { created: TS }, status: 'completed', reason: 'auto' },
  ];
  bad.forEach((d, i) => insM.run(`msg_b${i}`, BAD_ID, 'compaction', i, TS, TS, JSON.stringify(d)));
  insM.run('msg_b9', BAD_ID, 'user', 9, TS, TS, JSON.stringify({ time: { created: TS }, text: '唯一一轮', files: [], agents: [] }));
  db.close();

  const list = listSessions('opencode', ctx).sessions;
  const nat = opencodeReader.read(ctx, NATIVE_ID);
  assert.equal(nat.turns.length, 2, '原生 completed 摘要还原成一轮 + 用户一轮');
  assert.equal(nat.turns[0].items[0].text, SUM, '归一化裸正文，无标签壳');
  assert.equal(nat.turns[0].items[0].compact, true, '压缩语义由 compact 位承载');
  assert.equal(list.find((s) => s.id === NATIVE_ID).turns, 2, 'list 计数必须与 read 一致');
  const badRead = opencodeReader.read(ctx, BAD_ID);
  assert.equal(badRead.turns.length, 1, 'running/failed/非字符串/全空白/缺 summary 都不算一轮');
  assert.equal(list.find((s) => s.id === BAD_ID).turns, 1, 'list 判据必须与 read 逐条对应');
});

// ---- 12. 自愈不碰 compaction 行 ----

test('自愈：新写出的 compaction 行 data 逐字节不变（repair 只认 user/assistant）', () => {
  const { home, file, ctx } = setup('repair');
  const src = srcSession(home, [turn([u(CB), a('压缩后回答')]), turn([u('第二轮问题'), a('第二轮回答')])]);
  write(ctx, src);
  const before = rowsOf(file, TARGET).map((r) => `${r.id}|${r.type}|${r.data}`);
  const r = opencodeWriter.repair(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = rowsOf(file, TARGET).map((x) => `${x.id}|${x.type}|${x.data}`);
  assert.deepEqual(after, before, 'compaction 行不得被自愈改写');
  const again = opencodeWriter.repair(ctx);
  assert.equal(again.msgFixed, 0, JSON.stringify(again));
});

// ---- 13. verify --strict 的已知边界 ----

test('verify：默认（核心）收敛；--strict（全量）在压缩轮报差异 —— 设计后果，钉死不变', () => {
  const { home, ctx } = setup('verify');
  // 源用另一种标签：读回统一成 <cb_summary>，全量指纹必然不同，核心相同
  const src = srcSession(home, [turn([u('第一轮问题'), a('第一轮回答')]), turn([u(CHS), a('压缩后回答')])]);
  write(ctx, src);
  const read = (variant, id) => opencodeReader.read(ctx, id);
  const loose = verifyImported({ readSession: read, variant: 'opencode', sessionId: TARGET, expectSource: src, mode: 'create' });
  assert.equal(loose.ok, true, JSON.stringify(loose));
  const strict = verifyImported({ readSession: read, variant: 'opencode', sessionId: TARGET, expectSource: src, mode: 'create', strict: true });
  assert.equal(strict.ok, false, '全量指纹在压缩轮必然有表示差（包裹统一/空白归一/多段并一条）');
  assert.ok(strict.mismatches.some((m) => m.index === 1), `差异必须落在压缩轮：${JSON.stringify(strict.mismatches)}`);
});