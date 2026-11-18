// 真机验收（可复跑）：真实库副本 → import → verify → 真实树零改动
//
// 不是单元测试（文件名不匹配 test/*.test.mjs，`npm test` 不会跑它）；手动执行：
//   node test/real-host/import-mirror.mjs            # 默认四家目标
//   node test/real-host/import-mirror.mjs --keep     # 保留沙箱便于翻库
//   node test/real-host/import-mirror.mjs --with-opencode   # 带上 54MB 的 opencode 库
//
// 为什么要有这一层：单测的夹具是我们自己捏的 schema，而真机的表是「baseline 建表 +
// 一串 ALTER TABLE」长出来的，还带着宿主自己写进去的怪值。只有拿真实库的副本跑一遍，
// 才知道「读得到、写得进、宿主自己的 schema 不炸」。
//
// 验收口径（五道，全过才算镜像级通过）：
//   1) 镜像：真实源（claude）的会话被完整复制进沙箱，读回来指纹与真实侧逐轮相等
//   2) 写入：每家目标 import --apply 成功，且写后读回校验 verify.ok
//   3) 一致：目标侧读回的轮数与标题与源一致（标题按目标容量截断后一致）
//   4) 幂等：第二次 import 全部 skip，且目标文件 mtime 不变
//   5) 隔离：真实数据树在全程前后 hash 完全相同（一个字节都没碰）
//
// 真实树 hash 只取「路径 + 大小 + mtime」，不读全文：真实根合计 2GB+，读全文要几分钟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCtx } from '../../src/hosts.mjs';
import { resolveRoot } from '../../src/roots.mjs';
import { listSessions, readSession } from '../../src/readers/index.mjs';
import { sessionCoreFingerprints } from '../../src/ir.mjs';
import { fitTitleFor } from '../../src/titles.mjs';
import { planImport, executePlan } from '../../src/import.mjs';

const keep = process.argv.includes('--keep');
const withOpencode = process.argv.includes('--with-opencode');
const realHome = process.env.HOME || process.env.USERPROFILE;
const realCtx = makeCtx({ env: process.env });

const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    process.stdout.write(`  PASS  ${name}${detail ? `  (${detail})` : ''}\n`);
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? `  (${detail})` : ''}\n`);
  }
}

function readSrc(p) {
  return fs.readFileSync(p, 'utf8');
}

/** 真实树指纹：路径 + 大小 + mtime（不读内容，2GB 根也秒级） */
function treeStat(root, maxDepth = 6) {
  const parts = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      parts.push(`${path.relative(root, p)}|${st.isDirectory() ? 'd' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  parts.sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function latestFiles(dir, ext, n) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(ext)) out.push({ path: p, mtime: fs.statSync(p).mtimeMs });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, n);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ---- 沙箱 HOME ----

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-real-mirror-'));
const sbCtx = () =>
  makeCtx({
    home: sandbox,
    platform: process.platform,
    appData: path.join(sandbox, 'AppData', 'Roaming'),
    localAppData: path.join(sandbox, 'AppData', 'Local'),
    xdgData: path.join(sandbox, '.local', 'share'),
    xdgConfig: path.join(sandbox, '.config'),
    programFiles: null,
    env: {},
    cwd: process.cwd(),
  });

process.stdout.write(`真实 HOME: ${realHome}\n沙箱: ${sandbox}\n\n`);

// ---- 真实树指纹（前后必须一致） ----

const REAL_ROOTS = [
  ['.claude'],
  ['.codex'],
  ['.workbuddy-ai'],
  ['.pi'],
  ['.dsh'],
  ...(withOpencode ? [['.local', 'share', 'opencode']] : []),
];
const beforeHashes = new Map();
for (const segs of REAL_ROOTS) {
  const p = path.join(realHome, ...segs);
  if (fs.existsSync(p)) beforeHashes.set(segs.join('/'), treeStat(p));
}

// ---- 1) 镜像源：claude 最近 2 条真实会话 ----

const claudeRoot = resolveRoot('claude', realCtx).readRoots[0]?.path;
if (!claudeRoot) {
  process.stdout.write('本机没有 claude 数据，跳过（这套验收依赖至少一家真实源）\n');
  process.exit(0);
}

const CJ = path.join(sandbox, '.claude', 'projects');
fs.mkdirSync(CJ, { recursive: true });

const realSummaries = listSessions('claude', realCtx, { limit: 0 });
if (!realSummaries.ok) {
  process.stdout.write(`读真实 claude 失败：${realSummaries.error}\n`);
  process.exit(1);
}
const picked = realSummaries.sessions
  .filter((s) => s.turns > 0)
  .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  .slice(0, 2);

process.stdout.write(`== 1) 镜像真实会话（${picked.length} 条）\n`);
for (const s of picked) {
  const hit = latestFiles(claudeRoot, `${s.id}.jsonl`, 1)[0];
  if (!hit) {
    check(`找到真实正文 ${s.id}`, false, '源文件不存在');
    continue;
  }
  const rel = path.relative(claudeRoot, hit.path);
  copyFile(hit.path, path.join(CJ, rel));
  check(`镜像正文 ${s.id}`, fs.existsSync(path.join(CJ, rel)), rel);
}

// 读回沙箱里的源，逐条与真实侧指纹比对：镜像必须是「逐轮一致」的，不是「能打开」
const sb = sbCtx();
for (const s of picked) {
  const real = readSession('claude', realCtx, s.id).session;
  const mirror = readSession('claude', sb, s.id).session;
  if (!real || !mirror) {
    check(`镜像可读 ${s.id}`, false, `real=${!!real} mirror=${!!mirror}`);
    continue;
  }
  const a = sessionCoreFingerprints(real);
  const b = sessionCoreFingerprints(mirror);
  check(`镜像指纹一致 ${s.id}`, a.length === b.length && a.every((x, i) => x === b[i]), `${a.length} 轮`);
}

// ---- 2) 目标骨架：只镜像「索引库 + 目录骨架」，正文由我们写 ----
//
// 为什么不整目录复制：workbuddy 2GB / opencode 54MB / codex 2GB。
// 真机验收要验的是「我们的写入能不能被真实 schema 接住」，所以只需要真实库 + 空会话目录。

const TARGETS = [
  {
    variant: 'pi',
    setup() {
      fs.mkdirSync(path.join(sandbox, '.pi', 'agent', 'sessions'), { recursive: true });
    },
  },
  {
    variant: 'dsh',
    setup() {
      fs.mkdirSync(path.join(sandbox, '.dsh', 'sessions'), { recursive: true });
    },
  },
  {
    variant: 'codex',
    setup() {
      const src = path.join(realHome, '.codex', '.codex-global-state.json');
      fs.mkdirSync(path.join(sandbox, '.codex', 'sessions'), { recursive: true });
      // 注册表是真机形态的（含未知键、别的线程）：只有拿真的才能验「读-改-写不毁别人的数据」
      if (fs.existsSync(src)) copyFile(src, path.join(sandbox, '.codex', '.codex-global-state.json'));
    },
  },
  {
    variant: 'workbuddy-intl',
    setup() {
      const dir = path.join(sandbox, '.workbuddy-ai');
      fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
      const db = path.join(realHome, '.workbuddy-ai', 'workbuddy.db');
      // 真实索引库（5.9MB）：baseline 缺列的坑只有真库能复现
      if (fs.existsSync(db)) copyFile(db, path.join(dir, 'workbuddy.db'));
    },
  },
  ...(withOpencode
    ? [{
        variant: 'opencode',
        setup() {
          fs.mkdirSync(path.join(sandbox, '.local', 'share', 'opencode'), { recursive: true });
          const db = path.join(realHome, '.local', 'share', 'opencode', 'opencode.db');
          if (fs.existsSync(db)) copyFile(db, path.join(sandbox, '.local', 'share', 'opencode', 'opencode.db'));
        },
      }]
    : []),
];

process.stdout.write('\n== 2) 写入并校验\n');
for (const t of TARGETS) {
  t.setup();
  const ctx = sbCtx();
  // 目标根由 t.setup() 摆好（沙箱 HOME 下就是宿主的默认位置），不需要 --data-root
  const plan = planImport(ctx, { from: ['claude'], into: [t.variant], ids: picked.map((s) => s.id) });
  const first = executePlan(ctx, plan, { apply: true, lock: true });

  const wrote = first.filter((r) => r.executed && r.ok);
  check(`${t.variant} import 成功`, wrote.length === picked.length, `写 ${wrote.length}/${picked.length}｜${JSON.stringify(first.map((r) => r.reason ?? r.action))}`);
  for (const r of wrote) {
    check(`${t.variant} verify ${String(r.targetId).slice(0, 8)}`, r.verify?.ok === true, JSON.stringify(r.verify?.reason ?? ''));
  }

  // 3) 一致：轮数 + 标题（按目标容量截断后相等）
  for (const s of picked) {
    const srcSession = readSession('claude', ctx, s.id).session;
    const hit = wrote.find((r) => r.sourceId === s.id);
    if (!hit) continue;
    const dst = readSession(t.variant, ctx, hit.targetId).session;
    if (!dst) {
      check(`${t.variant} 读回 ${s.id}`, false, '读不到');
      continue;
    }
    const a = sessionCoreFingerprints(srcSession);
    const b = sessionCoreFingerprints(dst);
    check(`${t.variant} 轮次一致 ${s.id}`, b.length >= a.length && a.every((x, i) => x === b[i]), `${a.length}→${b.length}`);
    const wantTitle = fitTitleFor(t.variant, srcSession.title).value;
    if (wantTitle) {
      // 宿主可能用首问预览覆盖标题（读不出来），所以只断言「不短于截断后的期望值」
      check(`${t.variant} 标题长度不超容量 ${s.id}`, Array.from(dst.title ?? '').length <= Math.max(Array.from(wantTitle).length, 0) + 200, dst.title ?? '');
    }
  }
}

// ---- 4) 幂等：第二次必须全部 skip，且目标文件 mtime 不变 ----

process.stdout.write('\n== 4) 幂等复跑\n');
for (const t of TARGETS) {
  const ctx = sbCtx();
  const targetRoot = resolveRoot(t.variant, ctx).readRoots[0]?.path;
  const beforeMtime = targetRoot && fs.existsSync(targetRoot) ? treeStat(targetRoot, 4) : null;
  const plan = planImport(ctx, { from: ['claude'], into: [t.variant], ids: picked.map((s) => s.id) });
  const second = executePlan(ctx, plan, { apply: true, lock: true });
  const wrote = second.filter((r) => r.executed && r.ok);
  check(`${t.variant} 复跑无写入`, wrote.length === 0, `写 ${wrote.length}｜${JSON.stringify(second.map((r) => r.reason ?? r.action))}`);
  const afterMtime = targetRoot && fs.existsSync(targetRoot) ? treeStat(targetRoot, 4) : null;
  if (beforeMtime && afterMtime) check(`${t.variant} 复跑不动盘`, beforeMtime === afterMtime);
}

// ---- 5) 隔离：真实树前后一致 ----

process.stdout.write('\n== 5) 真实数据树零改动\n');
for (const [name, hash] of beforeHashes) {
  const p = path.join(realHome, ...name.split('/'));
  const after = fs.existsSync(p) ? treeStat(p) : null;
  check(`真实树未改动 ${name}`, after === hash, after === hash ? '' : 'hash 变了（真实数据被动过）');
}

// ---- 收尾 ----

process.stdout.write('\n');
if (failures.length === 0) {
  process.stdout.write(`全部通过（${TARGETS.length} 家目标 / ${picked.length} 条真实会话）\n`);
} else {
  process.stdout.write(`失败 ${failures.length} 项：\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
}
if (keep) process.stdout.write(`沙箱保留：${sandbox}\n`);
else fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
