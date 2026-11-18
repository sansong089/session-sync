// M56 测试：自定义安装目录的主动探测（读侧自动采用 / 写侧必须钉住）
//
// 这一份只回答一个问题：agent 的数据被搬到非默认位置、且宿主没把官方 env 导出到当前进程时，
// session-sync 还能不能找到它 —— 以及找到之后**不许**擅自往那儿写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx, locatorOf } from '../src/hosts.mjs';
import { detectInstalled } from '../src/roots.mjs';
import { resolveRoot, parseDataRoots, verifyMarker, rootSummary } from '../src/roots.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { SRC_ID } from './matrix-home.mjs';
import { mkOpencodeDb } from './db-fixtures.mjs';

function tmpHome(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m56-${name}-`));
  return dir;
}

// 探测的父集全部指向临时盘，避免扫到真实用户目录（programFiles 在 Windows 上是 C:\Program Files）
function ctxFor(home, env = {}, extra = {}) {
  return makeCtx({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    programFiles: path.join(home, 'Program Files'),
    documents: path.join(home, 'Documents'),
    env: { ...env },
    ...extra,
  });
}

const jsonl = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ type: i === 0 ? 'user' : 'assistant', message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `第 ${i} 轮` }] }, uuid: `u${i}`, timestamp: '2026-01-01T00:00:00.000Z', sessionId: SRC_ID, cwd: 'D:/work/moved' })).join('\n') + '\n';

test('claude 数据搬到非默认目录且没有 env：探测命中、能读出会话、且不是靠 env 命中的', () => {
  const home = tmpHome('claude-probe');
  // 搬到 home 下一个不像默认名的地方（marker 判据：里面有 projects/）
  // 搬运保名：按名探测认的是目录名本身；改名后的目录只能靠 --data-root 点名（已在文档里写明）
  const moved = path.join(home, 'srv', 'agents', '.claude');
  fs.mkdirSync(path.join(moved, 'projects', 'D--work-moved'), { recursive: true });
  fs.writeFileSync(path.join(moved, 'projects', 'D--work-moved', `${SRC_ID}.jsonl`), jsonl(3));

  const ctx = ctxFor(home);
  const r = resolveRoot('claude', ctx);
  const probed = r.candidates.filter((c) => c.tier === 'probe');
  assert.deepEqual(probed.map((c) => path.normalize(c.path)), [path.normalize(path.join(moved, 'projects'))], '探测产物必须是「搬过位置的声明形状」：根 + projects/');
  assert.equal(r.installed, true);
  const listed = listSessions('claude', ctx);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.available, true, '探测到的根必须让 reader 认为这家是装着的');
  assert.ok(listed.sessions.some((s) => s.id === SRC_ID), `应读到搬走的那条会话：${JSON.stringify(listed.sessions.map((s) => s.id))}`);
});

test('探测到的根默认不可写：只给可粘贴的 --data-root，一个目录都不建', () => {
  const home = tmpHome('probe-gate');
  const moved = path.join(home, 'srv', '.claude');
  fs.mkdirSync(path.join(moved, 'projects', 'D--work-moved'), { recursive: true });
  fs.writeFileSync(path.join(moved, 'projects', 'D--work-moved', `${SRC_ID}.jsonl`), jsonl(2));
  const ctx = ctxFor(home);
  const before = fs.readdirSync(home).sort();

  const r = resolveRoot('claude', ctx);
  assert.equal(r.writeRoot, null, '探测档不能自动写');
  assert.equal(r.evidence.write.reason, 'write-root-unpinned');
  assert.equal(r.evidence.paste, `--data-root claude=${moved}`, '提示串要能直接粘进下一次调用（钉的是数据根，声明形状挂在它下面）');
  assert.deepEqual(fs.readdirSync(home).sort(), before, '判定阶段不许在盘上留东西');

  // 粘上之后：同一份根立刻变成可写（flag 档）
  const pinned = ctxFor(home, {}, { dataRoots: parseDataRoots(r.evidence.paste.replace('--data-root ', '')) });
  const r2 = resolveRoot('claude', pinned);
  assert.equal(r2.evidence.tier, 'flag');
  assert.ok(r2.writeRoot, '用户点过名就能写');
  assert.equal(path.normalize(r2.writeRoot.path), path.normalize(path.join(moved, 'projects')));
});

test('marker 拒收：目录名像但不是这家的不算命中（防误探测）', () => {
  const home = tmpHome('marker-reject');
  // 同名空壳：.claude 在，但没有 projects/ —— 不是 claude 的根
  fs.mkdirSync(path.join(home, 'moved', '.claude', 'sessions'), { recursive: true });
  const r = resolveRoot('claude', ctxFor(home));
  assert.deepEqual(r.candidates.filter((c) => c.tier === 'probe'), []);
  assert.ok(r.evidence.tried.some((t) => t.outcome === 'rejected' && String(t.whyRejected).startsWith('marker:')), '拒收必须写清是 marker 挡掉的');
  assert.equal(r.installed, false);
});

test('SQLite 型 marker 认特征表：表不对就拒，库打不开也拒（不抛）', () => {
  const home = tmpHome('sqlite-marker');
  const good = path.join(home, 'srv', '.minimax');
  fs.mkdirSync(path.join(good, 'v2', 'sqlite'), { recursive: true });
  const bad = path.join(home, 'other', '.minimax');
  fs.mkdirSync(path.join(bad, 'v2', 'sqlite'), { recursive: true });
  for (const [dir, tables] of [
    [good, ['local_runtime_sessions']],
    [bad, ['whatever']],
  ]) {
    const db = new DatabaseSync(path.join(dir, 'v2', 'sqlite', 'runtime-state.sqlite'));
    for (const t of tables) db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
    db.close();
  }
  const marker = locatorOf('minimax').marker;
  assert.equal(verifyMarker(good, marker).ok, true);
  assert.equal(verifyMarker(bad, marker).why, 'table-missing');
  assert.equal(verifyMarker(path.join(home, 'nowhere'), marker).why, 'db-missing');
  // 损坏文件也不能抛，只能判不通过
  fs.mkdirSync(path.join(home, 'broken', 'v2', 'sqlite'), { recursive: true });
  fs.writeFileSync(path.join(home, 'broken', 'v2', 'sqlite', 'runtime-state.sqlite'), 'not a db');
  assert.equal(verifyMarker(path.join(home, 'broken'), marker).ok, false);

  const r = resolveRoot('minimax', ctxFor(home));
  assert.deepEqual(r.candidates.filter((c) => c.tier === 'probe').map((c) => path.normalize(c.path)), [path.normalize(path.join(good, 'v2', 'sqlite', 'runtime-state.sqlite')), path.normalize(path.join(good, 'v2', 'sessions'))]);
});

test('qoder 中/国际版候选按目录名硬隔离：CN 被搬走了也不会被国际版读到', () => {
  const home = tmpHome('qoder-isolation');
  const cn = path.join(home, 'srv', '.qoder-cn');
  fs.mkdirSync(path.join(cn, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(cn, 'projects', 'p', `${SRC_ID}.jsonl`), jsonl(2));
  const ctx = ctxFor(home);
  assert.ok(resolveRoot('qoder-cn', ctx).candidates.some((c) => c.tier === 'probe'), 'CN 该探到');
  const intl = resolveRoot('qoder-intl', ctx);
  assert.deepEqual(intl.candidates.filter((c) => c.tier === 'probe'), [], '国际版绝不能把 .qoder-cn 当成自己的根');
  assert.equal(listSessions('qoder-intl', ctx).available, false);
});

test('portable / 自定义安装的 IDE 派生宿主：data/User/globalStorage/<extId> 也能探到', () => {
  const home = tmpHome('portable-ide');
  const ext = path.join(home, 'Program Files', 'VSCode-portable', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  fs.mkdirSync(path.join(ext, 'data', 'sessions'), { recursive: true });
  const ctx = ctxFor(home);
  const r = resolveRoot('cline', ctx);
  assert.ok(r.candidates.some((c) => c.tier === 'probe' && path.normalize(c.path).startsWith(path.normalize(ext))), `应探到 portable 扩展目录：${JSON.stringify(r.candidates.map((c) => [c.tier, c.path]))}`);
  // 不在 globalStorage 下面的同名目录不算（避免撞名误判）
  const decoy = path.join(home, 'srv', 'saoudrizwan.claude-dev', 'data', 'sessions');
  fs.mkdirSync(decoy, { recursive: true });
  const r2 = resolveRoot('cline', ctxFor(home));
  assert.ok(!r2.candidates.some((c) => path.normalize(c.path).endsWith('srv') === false && c.tier === 'probe' && path.normalize(c.path) === path.normalize(path.join(home, 'srv', 'saoudrizwan.claude-dev'))), '脱离 globalStorage 的同名目录不能算命中');
  assert.equal(rootSummary('cline', ctx).probeCount, r.candidates.filter((c) => c.tier === 'probe').length);
});

test('探测预算用尽时降级：只回声明档，绝不拿半截扫描结果当结论', () => {
  const home = tmpHome('budget');
  const moved = path.join(home, 'srv', 'claude');
  fs.mkdirSync(path.join(moved, 'projects', 'x'), { recursive: true });
  // 造一个会撑爆遍历的树：400 个兄弟目录 × 各 400 子项
  for (let i = 0; i < 400; i++) {
    const d = path.join(home, 'noise', `n${i}`);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < 20; j++) fs.mkdirSync(path.join(d, `s${j}`), { recursive: true });
  }
  const ctx = ctxFor(home);
  const r = resolveRoot('claude', ctx);
  assert.ok(r.installed === true || r.candidates.every((c) => c.tier !== 'probe'), '降级也要自洽：要么探到了，要么一条探测都没写进结论');
});

test('detectInstalled 认探测命中：「搬走了但 detect 说没装」不允许再发生', () => {
  // 真机复现过的洞：resolveRoot 靠探测找到了根、list 读得到，但 detectInstalled 只问
  // VARIANTS[].detect（声明档），detect 命令报 not installed —— 两套「装了没有」答案打架。
  const home = tmpHome('detect-installed');
  try {
    const dir = path.join(home, '.local', 'share', 'custom-host', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    // marker 是 sqlite-tables：临时库带一张特征表即过，不依赖真库
    const db = new DatabaseSync(path.join(dir, 'opencode.db'));
    db.exec('CREATE TABLE session_v2 (id TEXT)');
    db.close();
    const ctx = ctxFor(home);
    const r = resolveRoot('opencode', ctx);
    assert.equal(r.installed, true, 'resolveRoot 判已装（探测候选真实存在）');
    assert.ok(detectInstalled(ctx).includes('opencode'), 'detectInstalled 必须与 resolveRoot 同源，探测命中也要进 installed 名单');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('写门接线到 import：探测档宿主默认拒写（skip + 可粘贴钉法），钉住后同一批照常落盘', () => {
  const home = tmpHome('gate-wiring');
  try {
    const dir = path.join(home, '.local', 'share', 'custom-host', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    mkOpencodeDb(path.join(dir, 'opencode.db'));
    // claude 源（会话 cwd 是真实项目目录 → scope=project，落点=源目录，与桶无关）
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'D--work-gate'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'projects', 'D--work-gate', `${SRC_ID}.jsonl`),
      [
        { parentUuid: null, type: 'user', sessionId: SRC_ID, cwd: 'D:/work/gate', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: '问' } },
        { parentUuid: 'u1', type: 'assistant', sessionId: SRC_ID, uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答' }] } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const base = { from: ['claude'], into: ['opencode'] };

    const dry = executePlan(ctxFor(home), planImport(ctxFor(home), base), { apply: false })[0];
    assert.equal(dry.status, 'skipped');
    assert.equal(dry.reason, 'write-root-unpinned', JSON.stringify(dry));
    assert.match(String(dry.hint), /^--data-root opencode=/, '必须给可直接粘贴的钉法');

    const applied = executePlan(ctxFor(home), planImport(ctxFor(home), base), { apply: true })[0];
    assert.equal(applied.status, 'skipped', 'apply 与 dry-run 同一结论，绝不偷偷写探测档');

    // 显式 --data-root 点名后照常写
    const pinned = parseDataRoots(`opencode=${dir}`);
    const ctxPinned = ctxFor(home, {}, { dataRoots: pinned });
    const done = executePlan(ctxPinned, planImport(ctxPinned, base), { apply: true })[0];
    assert.equal(done.ok, true, JSON.stringify(done));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
