// M58 测试：表驱动 · 全变体矩阵 —— 同一份夹具形态，21 个变体逐个过四道断言
//
// 为什么是表驱动：每个变体的根、marker、probe 锚点形状都不同，但**要保证的性质完全一样**。
// 逐个变体单写一条用例 = 21 份容易漂移的真相；表驱动 = 一处改、21 家同时被验。
//
// 四道断言（与计划一致）：
//   ① env 指向带 marker 的自定义根时，读/写/skills/account（凡是以该根为基准的）跟到同一个根；
//   ② 「数据在别处 + 不带 env」时读侧 probe 命中且 detectInstalled 含该变体；
//   ③ 同一场景写侧一个目录都不 mkdir，返回 write-root-unpinned，提示串能被下一次调用直接接受；
//   ④ 把不合格的同名目录摆进候选 → marker 拒收（不许「目录存在即算」）。
//
// 夹具按**声明形状**派生，不手搓每家的目录：拿该变体声明候选里锚点名之后的相对段，
// 在锚点下照原样重建（目录建目录、文件建文件、marker 要求的库表照建）。
// 这也顺带验证了「探测产物 = 搬过位置的声明形状」这条设计，而不是把形状写死在用例里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ALL_VARIANTS, LOCATOR, ROOT_ENV_KEYS, makeCtx } from '../src/hosts.mjs';
import { resolveRoot, candidateRoots, parseDataRoots, writeGate, detectInstalled } from '../src/roots.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m58-${name}-`));
}

// 探测的父集全部指向临时盘：不能扫真实用户目录，也不能扫到别的变体的真数据
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

const isUnder = (p, root) => {
  const a = path.resolve(String(p ?? '')).toLowerCase();
  const b = path.resolve(String(root ?? '')).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
};

const norm = (p) => path.normalize(String(p ?? '')).split(/[\\/]+/).filter(Boolean);

/**
 * 声明候选（不含探测档）—— 夹具要按它的形状重建。
 * 必须用**独立的 ctx**：探测索引按 ctx 缓存，若在这里先解析过一次，后面建出来的锚点目录
 * 就进不了那份索引快照（真实使用里目录不会在同一次调用中途出现，夹具会踩到这个差别）。
 */
function declaredOf(variant, home) {
  const probeCtx = ctxFor(home);
  return candidateRoots(variant, probeCtx).filter((c) => c.tier !== 'probe');
}

/** 锚点名之后的那段相对形状（与 resolver 的 remap 口径一致） */
function shapeUnder(declared, anchorName) {
  const out = [];
  for (const d of declared) {
    const segs = norm(d.path);
    const idx = segs.findIndex((s, i) => i < segs.length - 1 && s.toLowerCase() === anchorName.toLowerCase());
    if (idx < 0) continue;
    out.push({ candidate: d, tail: segs.slice(idx + 1), kind: d.kind });
  }
  return out;
}

function makeSqlite(file, tables) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 幂等：形状重建与 marker 满足可能都要求建同一个库
  for (const t of tables) db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT)`);
  db.close();
}

/** 按 marker 声明在锚点下造出「合格」内容 */
function satisfyMarker(anchorDir, marker) {
  if (marker.kind === 'children') {
    for (const segs of marker.any ?? []) fs.mkdirSync(path.join(anchorDir, ...segs), { recursive: true });
    return;
  }
  if (marker.kind === 'sqlite-tables') {
    const rel = Array.isArray(marker.rel) ? marker.rel : [marker.rel];
    makeSqlite(path.join(anchorDir, ...rel), (marker.any ?? []).flat());
    return;
  }
  if (marker.kind === 'descendant-named') {
    fs.mkdirSync(path.join(anchorDir, marker.name), { recursive: true });
    return;
  }
  throw new Error(`未知的 marker.kind: ${marker.kind}`);
}

/** 在锚点下按声明形状重建内容（目录建目录；文件按 marker 需要建成带特征表的库） */
function rebuildShape(anchorDir, shapes, marker) {
  for (const s of shapes) {
    if (!s.tail.length) continue;
    const full = path.join(anchorDir, ...s.tail);
    if (s.kind === 'dir') {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    // 文件型：marker 指到同一个文件时按 marker 建库，否则建空文件
    const markerRel = marker.kind === 'sqlite-tables' ? (Array.isArray(marker.rel) ? marker.rel : [marker.rel]) : null;
    const isMarkerFile = markerRel && markerRel.join('/') === s.tail.join('/');
    if (isMarkerFile) makeSqlite(full, (marker.any ?? []).flat());
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
  }
}

/**
 * 探测的父集里挑一个能放根的基准，并在其下多嵌一层 —— 锚点必须与该变体的**默认位置不同**，
 * 否则探测命中会与声明候选同路径、按设计让位给声明档（探测档只增补不替换），测的就不是探测了。
 */
function probeBaseFor(variant, home) {
  const parents = LOCATOR[variant].probe.parents;
  const layer = `probe-${variant}`;
  if (parents.includes('home')) return path.join(home, layer);
  if (parents.includes('localAppData')) return path.join(home, 'AppData', 'Local', layer);
  if (parents.includes('appData')) return path.join(home, 'AppData', 'Roaming', layer);
  return path.join(home, layer);
}

/** Windows 上 sqlite 句柄可能还没释放，退避重试 */
function rmHome(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  } catch {
    /* 临时目录残留不影响判定 */
  }
}

/** 造一个「探得到、marker 过、形状对」的锚点目录；返回其绝对路径 */
function makeAnchor(variant, ctx, base, anchorName) {
  const marker = LOCATOR[variant].marker;
  const anchorDir = path.join(base, anchorName);
  fs.mkdirSync(anchorDir, { recursive: true });
  const shapes = shapeUnder(declaredOf(variant, ctx.home), anchorName);
  rebuildShape(anchorDir, shapes, marker);
  satisfyMarker(anchorDir, marker);
  return { anchorDir, shapes };
}

test('表驱动矩阵：全变体 × 四道断言', async (t) => {
  for (const variant of ALL_VARIANTS) {
    await t.test(`${variant}`, () => {
      const loc = LOCATOR[variant];
      const marker = loc.marker;
      const envKeys = ROOT_ENV_KEYS[variant]?.env ?? [];

      // ---------- ① env 指向自定义根 → 以该根为基准的落点全跟过去 ----------
      if (envKeys.length) {
        const home = tmpHome(`${variant}-env`);
        try {
          const rootName = loc.probe.names[0];
          const root = path.join(home, 'custom', rootName);
          const ctx0 = ctxFor(home);
          fs.mkdirSync(root, { recursive: true });
          // env 根 = 变体根：按声明形状重建（marker 要求的特征表照建）
          rebuildShape(root, shapeUnder(declaredOf(variant, home), rootName), marker);
          satisfyMarker(root, marker);

          const ctx = ctxFor(home, { [envKeys[0]]: root });
          const r = resolveRoot(variant, ctx);
          const envCands = r.candidates.filter((c) => c.tier === 'env');
          assert.ok(envCands.length > 0, `${variant}: env 档候选必须存在（${envKeys[0]}）`);
          assert.ok(envCands.every((c) => isUnder(c.path, root)), `${variant}: env 档候选必须挂在该根下：${envCands.map((c) => c.path).join(',')}`);
          assert.ok(r.readRoots.some((c) => isUnder(c.path, root)), `${variant}: 读侧必须跟到自定义根`);
          if (r.writeRoot) assert.ok(isUnder(r.writeRoot.path, root), `${variant}: 写侧必须跟到自定义根（实际 ${r.writeRoot.path}）`);
          if (loc.skills?.base === 'root') assert.ok(isUnder(r.skillsDir, root), `${variant}: skills 必须跟到自定义根（实际 ${r.skillsDir}）`);
          if ((loc.account ?? []).length && (loc.account ?? []).every((a) => a.base === 'root')) {
            for (const a of r.accountPaths) assert.ok(isUnder(a.path, root), `${variant}: 登录态必须跟到自定义根（实际 ${a.path}）`);
          }
        } finally {
          rmHome(home);
        }
      }

      // ---------- ② 数据在别处、不带 env → 探测命中 + detectInstalled 含它 ----------
      const home2 = tmpHome(`${variant}-probe`);
      try {
        const base = probeBaseFor(variant, home2);
        const ctx0 = ctxFor(home2);
        let hit = null;
        for (const name of loc.probe.names) {
          const { anchorDir, shapes } = makeAnchor(variant, ctx0, base, name);
          if (!shapes.length) continue; // 这个锚点名与本家声明形状对不上（如 cursor 的 .cursor）
          const r = resolveRoot(variant, ctx0);
          const probed = r.candidates.filter((c) => c.tier === 'probe' && c.exists);
          if (probed.length) {
            hit = { anchorDir, probed };
            break;
          }
        }
        assert.ok(hit, `${variant}: 探测应命中（锚点 ${loc.probe.names.join('/')}）`);
        assert.ok(hit.probed.every((c) => isUnder(c.path, hit.anchorDir)), `${variant}: 探测产物必须挂在锚点下`);
        assert.ok(detectInstalled(ctx0).includes(variant), `${variant}: detectInstalled 必须含探测命中的变体`);

        // ---------- ③ 写侧拒收 + 零 mkdir + 提示串可直接被下一次调用接受 ----------
        const before = fs.readdirSync(hit.anchorDir).sort();
        const gate = writeGate(variant, ctx0);
        assert.equal(gate.ok, false, `${variant}: 探测档不得自动写`);
        assert.equal(gate.reason, 'write-root-unpinned');
        assert.match(String(gate.paste), new RegExp(`^--data-root ${variant}=`), `${variant}: 必须给可粘贴的钉法`);
        assert.deepEqual(fs.readdirSync(hit.anchorDir).sort(), before, `${variant}: 判定阶段不得在盘上留东西`);

        const pinnedRaw = String(gate.paste).replace(/^--data-root /, '');
        const pinnedCtx = ctxFor(home2, {}, { dataRoots: parseDataRoots(pinnedRaw) });
        assert.equal(writeGate(variant, pinnedCtx).ok, true, `${variant}: 钉住后必须可写（${pinnedRaw}）`);

        // ---------- ④ 同名但不合格的目录 → marker 拒收 ----------
        const home3 = tmpHome(`${variant}-reject`);
        try {
          const base3 = probeBaseFor(variant, home3);
          const fake = path.join(base3, loc.probe.names[0]);
          fs.mkdirSync(fake, { recursive: true }); // 内容为空：不是这家的根
          const r3 = resolveRoot(variant, ctxFor(home3));
          assert.ok(!r3.candidates.some((c) => c.tier === 'probe' && isUnder(c.path, fake)), `${variant}: 空壳同名目录不得被当成本家`);
          assert.ok(r3.evidence.tried.some((x) => x.outcome === 'rejected' && String(x.whyRejected).startsWith('marker:')), `${variant}: 拒收理由必须写明是 marker 挡的`);
        } finally {
          rmHome(home3);
        }
      } finally {
        rmHome(home2);
      }
    });
  }
});

test('候选集只有一个入口：candidateRoots 与 resolveRoot 同源（不再有第二套）', () => {
  const home = tmpHome('same-source');
  try {
    const ctx = ctxFor(home);
    for (const variant of ALL_VARIANTS) {
      const viaHelper = candidateRoots(variant, ctx).map((c) => c.path).sort();
      const viaRoot = resolveRoot(variant, ctx).candidates.map((c) => c.path).sort();
      assert.deepEqual(viaHelper, viaRoot, `${variant}: candidateRoots 必须只是 resolveRoot 的投影`);
    }
  } finally {
    rmHome(home);
  }
});
