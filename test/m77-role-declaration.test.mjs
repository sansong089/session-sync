// M77 测试：落点 role 声明的棘轮
//
// 为什么需要：role 曾经只是「写了没人用」的装饰（derivedCache / db 全仓零消费），
// 而写侧 14 个变体各自用 dirs[0] / firstExisting / 文件名正则挑根——形态一变就可能写错一份。
// 本轮把 role 收紧为「落点职责」并接上消费者，这份棘轮守住四条底线：
//   1) role 的 kind 必须落在闭集里（写错会被 kind 过滤静默读空）
//   2) 每个 role 都能在声明层取到（不是 typo、不是死分支）
//   3) 同一路径不许挂两个 role（dedupe 按路径合并，会静默丢一个）
//   4) 每个 role 都必须有消费者，且代码与文档词表双向一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_VARIANTS, VARIANTS, makeCtx } from '../src/hosts.mjs';
import { roleRoots, resolveRoot, parseDataRoots, invalidateRoots, writeGate } from '../src/roots.mjs';

// role → 允许的 kind（闭集）。新增 role 必须同时登记这里、program-spec 的词表、以及消费者。
const ROLE_KINDS = {
  projects: ['dir'],
  sessions: ['dir'],
  tasks: ['dir'],
  history: ['dir'],
  data: ['dir'],
  archive: ['dir'],
  cwdMap: ['dir'],
  cliProjects: ['dir'],
  sessionsIndex: ['file'],
  registry: ['file'],
  db: ['file'],
  aux: ['file', 'dir'],
};

const ROOT = path.join(import.meta.dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function ctxFor(home, extra = {}) {
  return makeCtx({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    xdgData: path.join(home, '.local', 'share'),
    xdgConfig: path.join(home, '.config'),
    programFiles: path.join(home, 'ProgramFiles'),
    documents: path.join(home, 'Documents'),
    env: {},
    ...extra,
  });
}

/** 声明层里每个 (变体, 候选) 的 {path, kind, role, source} */
function declarations(ctx) {
  const out = [];
  for (const v of ALL_VARIANTS) {
    for (const [source, fn] of [['read', VARIANTS[v].readPaths], ['write', VARIANTS[v].writePaths], ['aux', VARIANTS[v].auxPaths]]) {
      // auxPaths 的 role 由 resolver 隐式补 'aux'（roots.mjs:90），这里照同一口径算，否则会和解析结果对不上
      for (const c of fn?.(ctx) ?? []) out.push({ variant: v, source, path: c.path, kind: c.kind ?? null, role: c.role ?? (source === 'aux' ? 'aux' : null) });
    }
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m77-'));
const ctx = ctxFor(tmp);
const decls = declarations(ctx);
const pairs = [...new Set(decls.filter((d) => d.role).map((d) => `${d.variant}|${d.role}`))].sort();

test('role 的 kind 必须落在闭集里：写错会被 kind 过滤静默读空', () => {
  const bad = [];
  for (const d of decls) {
    if (!d.role) continue;
    const allowed = ROLE_KINDS[d.role];
    if (!allowed) { bad.push(`${d.variant}: 未登记的 role「${d.role}」`); continue; }
    if (!allowed.includes(d.kind)) bad.push(`${d.variant}/${d.role}: kind=${d.kind}，只允许 ${allowed.join('|')}`);
  }
  assert.deepEqual(bad, [], `role 与 kind 不匹配：${bad.join('; ')}`);
  for (const [role, kinds] of Object.entries(ROLE_KINDS)) {
    assert.ok(decls.some((d) => d.role === role), `词表里的 role「${role}」没有任何声明使用（要么删词表，要么补声明）`);
    assert.ok(kinds.length > 0, `${role} 缺 kind 闭集`);
  }
});

test('每个 (变体, role) 都能在声明层取到候选：不是 typo，也不是死分支', () => {
  const missing = pairs.filter((p) => {
    const [v, role] = p.split('|');
    return roleRoots(v, ctx, role).length === 0;
  });
  assert.deepEqual(missing, [], `这些 (变体, role) 取不到候选：${missing.join(', ')}`);
});

test('同一变体、同一路径不许挂两个 role：dedupe 按路径合并会静默丢一个', () => {
  const byPath = new Map();
  const bad = [];
  for (const d of decls) {
    const key = `${d.variant}|${path.normalize(d.path).replace(/\\/g, '/').toLowerCase()}`;
    const prev = byPath.get(key);
    if (prev && prev !== d.role) bad.push(`${d.variant}: ${d.path} 同时被 ${prev} 与 ${d.role} 声明`);
    else byPath.set(key, d.role);
  }
  assert.deepEqual(bad, [], `同路径多 role（高 tier 会覆盖低 tier）：${bad.join('; ')}`);
});

test('readPaths 里不许出现 aux：aux 只由 auxPaths 隐式产生', () => {
  const bad = decls.filter((d) => d.source === 'read' && d.role === 'aux').map((d) => d.variant);
  assert.deepEqual(bad, [], `这些变体在 readPaths 里写了 aux（会让写根变 null）：${bad.join(', ')}`);
});

test('代码里的 role 集合与 program-spec 词表双向一致', () => {
  const doc = readText('references/program-spec.md');
  const lines = doc.split('\n');
  const head = lines.findIndex((l) => l.trim() === '| role | kind | 基数 | 职责 | 消费者 |');
  assert.ok(head >= 0, 'program-spec.md 缺「role 词表」表');
  const docRoles = new Set();
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) break;
    if (/^\|[\s-]+\|/.test(l)) continue;
    docRoles.add(l.split('|')[1].trim());
  }
  const codeRoles = new Set(decls.filter((d) => d.role).map((d) => d.role));
  assert.deepEqual([...codeRoles].sort(), [...docRoles].sort(),
    `代码与文档的 role 词表不一致：代码多 ${[...codeRoles].filter((r) => !docRoles.has(r)).join(',') || '无'}；文档多 ${[...docRoles].filter((r) => !codeRoles.has(r)).join(',') || '无'}`);
});

test('每个 role 都必须有消费者：在 hosts.mjs 之外的源码里出现过', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.mjs')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  // 去注释：注释里写一句 roleRoots(...) 不算消费者
  const stripComments = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const consumerText = files
    .filter((f) => path.basename(f) !== 'hosts.mjs')
    .map((f) => stripComments(fs.readFileSync(f, 'utf8')))
    .join('\n');
  // 只认两种真消费形态：roleRoots(..., '<role>') 或 x.role === '<role>'。
  // 光看字符串出现过不够——`source: 'db'` 这种无关字面量会让这条断言假绿。
  const consumed = (r) =>
    new RegExp("(?:roleRoots|writeRootOf)\\([^)]*'" + r + "'\\)").test(consumerText) ||
    new RegExp("\\.role\\s*===\\s*'" + r + "'").test(consumerText);
  const roles = [...new Set(decls.filter((d) => d.role).map((d) => d.role))];
  const orphan = roles.filter((r) => !consumed(r));
  assert.deepEqual(orphan, [], `这些 role 没有任何消费者（定义了没人用）：${orphan.join(', ')}`);
});

test('搬根/钉住之后 role 不丢：flag 与 probe 重映射都保留声明里的 role', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m77-pin-'));
  try {
    for (const v of ALL_VARIANTS) fs.mkdirSync(path.join(home, 'pinned', v), { recursive: true });
    const flagCtx = ctxFor(home, { dataRoots: parseDataRoots(ALL_VARIANTS.map((v) => `${v}=${path.join(home, 'pinned', v)}`).join(',')) });
    invalidateRoots(flagCtx);
    const declaredRoles = (v) => new Set(declarations(ctxFor(home)).filter((d) => d.variant === v && d.role).map((d) => d.role));
    for (const v of ALL_VARIANTS) {
      const want = [...declaredRoles(v)].sort();
      const got = [...new Set(resolveRoot(v, flagCtx).candidates.filter((c) => c.role).map((c) => c.role))].sort();
      assert.deepEqual(got, want, `${v} 在 --data-root 之后 role 丢失或串味`);
    }

    // probe：把 codex 的根整体搬到 ProgramFiles 下的锚点目录，重映射后 role 必须还在
    const moved = path.join(home, 'ProgramFiles', 'apps', '.codex');
    fs.mkdirSync(path.join(moved, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(moved, 'archived_sessions'), { recursive: true });
    const probeCtx = ctxFor(home);
    invalidateRoots(probeCtx);
    const probed = resolveRoot('codex', probeCtx).candidates.filter((c) => c.tier === 'probe');
    const probedRoles = [...new Set(probed.map((c) => c.role))].sort();
    assert.deepEqual(probedRoles, ['archive', 'sessions'], `探测命中的根丢了 role：${JSON.stringify(probed.map((c) => [c.path, c.role]))}`);
    for (const c of probed) {
      const under = path.resolve(c.path).toLowerCase().startsWith(path.resolve(moved).toLowerCase());
      assert.ok(under, `探测重映射后路径没落在锚点 ${moved} 下：${c.path}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 写门（writeGate）看全局最优根，writer 按 role 取根：两者可能指向不同位置。
// 这是既有设计缺口，本轮不修；用债表钉住，新增分叉会红、修好了也必须下调。
const WRITER_ROLE = {
  claude: 'projects',
  'codebuddy-ide': 'data',
  codebuddy: 'projects',
  'workbuddy-cn': 'projects',
  'workbuddy-intl': 'projects',
  zcode: 'db',
  opencode: 'db',
  mimo: 'db',
  kilo: 'db',
  minimax: 'history',
  cline: 'sessions',
  pi: 'sessions',
  dsh: 'sessions',
  freebuff: 'projects',
  roo: 'tasks',
  codex: 'sessions',
};

const KNOWN_GATE_DIVERGENCE = {
  cline: '门按「已存在的目录优先」会指向 tasks，写侧固定落 data/sessions（三代契约）',
  kilo: '门指向已存在的 tasks 目录，写侧按 kilo.db 是否存在分派，实际写库',
};

test('写门与写侧取根的分叉只减不增（已知：cline / kilo）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m77-gate-'));
  try {
    const mkdirs = (ctx) => {
      for (const v of ALL_VARIANTS) {
        for (const fn of [VARIANTS[v].readPaths, VARIANTS[v].auxPaths]) {
          for (const c of fn?.(ctx) ?? []) {
            const p = c.path;
            if (!path.resolve(p).toLowerCase().startsWith(path.resolve(home).toLowerCase())) continue;
            try {
              if (c.kind === 'dir') fs.mkdirSync(p, { recursive: true });
              else { fs.mkdirSync(path.dirname(p), { recursive: true }); if (!fs.existsSync(p)) fs.writeFileSync(p, ''); }
            } catch { /* 造不出来不影响判定 */ }
          }
        }
      }
    };
    const gctx = ctxFor(home);
    mkdirs(gctx);
    invalidateRoots(gctx);

    const norm = (p) => (p ? path.normalize(p).split(path.sep).join('/').toLowerCase() : null);
    const diverged = [];
    for (const [v, role] of Object.entries(WRITER_ROLE)) {
      // 这张表是手维护的映射：先钉住「表里写的 role 在声明层真的存在」，挡住改名/删 role 后的静默失效
      assert.ok(roleRoots(v, gctx, role).length > 0, `WRITER_ROLE['${v}']='${role}' 在声明层不存在（映射表已漂移）`);
      const gate = writeGate(v, gctx);
      if (!gate.ok) { diverged.push(`${v}: gate-closed(${gate.reason})`); continue; }
      const gatePath = resolveRoot(v, gctx).writeRoot?.path ?? null;
      const writePath = roleRoots(v, gctx, role)[0]?.path ?? null;
      if (norm(gatePath) !== norm(writePath)) diverged.push(v);
    }
    assert.deepEqual(diverged.sort(), Object.keys(KNOWN_GATE_DIVERGENCE).sort(),
      `写门与写侧分叉的变体集合变了：${diverged.join(', ') || '无'} —— 新增的要么修好，要么在 KNOWN_GATE_DIVERGENCE 登记理由`);
    for (const [v, why] of Object.entries(KNOWN_GATE_DIVERGENCE)) {
      assert.ok(why.length > 12, `${v} 的分叉必须写明原因`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
