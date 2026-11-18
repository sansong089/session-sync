// test/roots-snapshot.mjs — 声明层快照（不是测试文件：不带 .test，不进 npm test）
//
// 用途：在给 readPaths 补 role 之前/之后各跑一次，diff 必须为空。
// role 本身不进快照（它是唯一被允许变化的字段），单独用 --roles 出视图逐条对账。
// 为什么不用断言而用快照：这次改动面跨 21 个变体 × 多场景，「逐条相等」比「挑几个点断言」更能兜住意外。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_VARIANTS, VARIANTS, makeCtx } from '../src/hosts.mjs';
import { resolveRoot, invalidateRoots, parseDataRoots } from '../src/roots.mjs';

const PLATFORMS = ['win32', 'linux'];
const SCENARIOS = ['empty', 'materialized', 'pinned'];

function sandboxCtx(root, platform, dataRoots = null) {
  return makeCtx({
    home: root,
    platform,
    appData: path.join(root, 'AppData', 'Roaming'),
    localAppData: path.join(root, 'AppData', 'Local'),
    xdgData: path.join(root, '.local', 'share'),
    xdgConfig: path.join(root, '.config'),
    programFiles: path.join(root, 'ProgramFiles'),
    documents: path.join(root, 'Documents'),
    env: {},
    dataRoots,
  });
}

/** 按声明形状把默认落点造出来（只允许在沙箱内，越界一律跳过） */
function materialize(root, ctx) {
  const inside = (p) => path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase());
  for (const v of ALL_VARIANTS) {
    const decl = [...(VARIANTS[v].readPaths?.(ctx) ?? []), ...(VARIANTS[v].auxPaths?.(ctx) ?? [])];
    for (const c of decl) {
      if (!c?.path || !inside(c.path)) continue;
      try {
        if (c.kind === 'dir') fs.mkdirSync(c.path, { recursive: true });
        else {
          fs.mkdirSync(path.dirname(c.path), { recursive: true });
          if (!fs.existsSync(c.path)) fs.writeFileSync(c.path, '');
        }
      } catch {
        /* 造不出来不影响快照：exists=false 本身就是被测事实 */
      }
    }
  }
}

const rel = (root, p) => String(p).replace(/\\/g, '/').replace(new RegExp(`^${root.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'), '<H>');

function project(root, r, withRoles) {
  const cands = r.candidates.map((c) => ({
    path: rel(root, c.path),
    kind: c.kind ?? null,
    tier: c.tier ?? null,
    source: c.source ?? null,
    envKey: c.envKey ?? null,
    marker: c.marker ?? null,
    ...(withRoles ? { role: c.role ?? null } : {}),
  }));
  if (withRoles) return { variant: r.variant, candidates: cands };
  return {
    variant: r.variant,
    candidates: cands,
    readRoots: r.readRoots.map((c) => rel(root, c.path)),
    writeRoot: r.writeRoot ? { path: rel(root, r.writeRoot.path), tier: r.writeRoot.tier } : null,
    installed: !!r.installed,
    tried: r.evidence.tried.map((t) => ({ path: rel(root, t.path), tier: t.tier ?? null, outcome: t.outcome, why: t.whyRejected ?? null })),
    bucket: r.bucketRoot?.path ? rel(root, r.bucketRoot.path) : null,
    skillsDir: r.skillsDir ? rel(root, r.skillsDir) : null,
    accounts: r.accountPaths.map((a) => rel(root, a.path)),
    userData: r.userDataDirs.map((a) => rel(root, a.path)),
  };
}

function snap(withRoles) {
  const out = {};
  for (const platform of PLATFORMS) {
    out[platform] = {};
    for (const scenario of SCENARIOS) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-snap-${platform}-${scenario}-`));
      try {
        const dataRoots = scenario === 'pinned' ? parseDataRoots(ALL_VARIANTS.map((v) => `${v}=${path.join(root, 'pinned', v)}`).join(',')) : null;
        const ctxBefore = sandboxCtx(root, platform, dataRoots);
        if (scenario === 'materialized') materialize(root, ctxBefore);
        if (scenario === 'pinned') {
          for (const v of ALL_VARIANTS) fs.mkdirSync(path.join(root, 'pinned', v), { recursive: true });
        }
        const ctx = sandboxCtx(root, platform, dataRoots);
        invalidateRoots(ctx);
        out[platform][scenario] = {};
        for (const v of ALL_VARIANTS) out[platform][scenario][v] = project(root, resolveRoot(v, ctx), withRoles);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  return out;
}

const withRoles = process.argv.includes('--roles');
process.stdout.write(`${JSON.stringify(snap(withRoles), null, 2)}\n`);
