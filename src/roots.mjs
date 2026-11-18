// roots.mjs — 宿主根定位的唯一出口
//
// 规矩（由 test/m55-roots-contract.test.mjs 的棘轮锁死）：任何模块要「某变体的根在哪」，
// 只能读 resolveRoot(variant, ctx) 的返回，不得自己拿 ctx.home/appData/xdg* 再拼一遍。
// 同一个问题在仓里有过六套答案（detect / reader.available / 写侧取 readPaths[0] / 各家重抄 env 链 /
// accounts 登录态 / 两张落点表），它们会在 env 覆盖或目录被搬走时各指一处。
//
// tier 阶梯（高→低）：flag(--data-root) > env(宿主官方变量) > pin(各家专用钉住变量) > probe(探测) > default。
// 候选一律保留在集合里，探测只做增补、不替换 —— 少一条候选就等于漏读一批会话。
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS, ALL_VARIANTS, makeCtx, bucketRoot, bucketShape, skillsDirOf, configRoot, accountPathsOf, userDataDirsOf, locatorBase, locatorOf, documentsRoot, ROOT_ENV_KEYS } from './hosts.mjs';
import { exists, isDir, isFile, cmpPath } from './util.mjs';
import { openDb, tableExists } from './readers/base.mjs';

export const TIER_RANK = { flag: 0, env: 1, pin: 2, probe: 3, default: 4 };
// 写侧只认这四档：它们都是用户或宿主自己声明/生成的落点。
// probe 不在其中 —— 探测能告诉我们「数据在哪儿」，但不能替用户决定「往哪儿写」。
export const WRITABLE_TIERS = new Set(['flag', 'env', 'pin', 'default']);
// 读侧即使目录还不存在也照用的档（宿主可能还没首次启动，但落点是用户明确指了名的）。
const AUTHORITATIVE = new Set(['flag', 'env', 'pin']);

// 只有探测索引缓存（一次有界遍历，全变体共用）。
// resolveRoot 本身**不缓存**：导入是「写完立刻读回」的流程，同一进程里跑多对(源,目标)，
// 缓存会让第二次读把刚写进去的正文当成不存在 —— 于是把 append 误判成 create 撞 target-exists。
const INDEX_BY_CTX = new WeakMap();
// 探测记账也按 ctx 存：INDEX_BY_CTX 是 WeakMap，没法反过来遍历取统计
const PROBE_STATS = new WeakMap();

/** 探测之外的事后失效：清掉本进程的目录索引，下一次 resolveRoot 重新遍历 */
export function invalidateRoots(ctx) {
  INDEX_BY_CTX.delete(ctx);
  PROBE_STATS.delete(ctx);
}

function existsOf(cand) {
  if (cand.kind === 'file') return isFile(cand.path);
  if (cand.kind === 'dir') return isDir(cand.path);
  return exists(cand.path);
}

/**
 * 解析 `--data-root <变体>=<目录>[,<变体>=<目录>...]`。
 * 按第一个 `=` 切：Windows 路径里不会出现裸 `=` 前缀，而变体名总是短在前。
 * @returns {Map<string,string>}
 */
export function parseDataRoots(raw) {
  const out = new Map();
  for (const item of String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = item.indexOf('=');
    if (i <= 0) throw new Error(`--data-root 要写成 <变体>=<目录>（收到 "${item}"）`);
    const variant = item.slice(0, i).trim();
    const dir = item.slice(i + 1).trim();
    if (!VARIANTS[variant]) throw new Error(`--data-root 未知 agent 变体: ${variant}（可用: ${Object.keys(VARIANTS).join(', ')}）`);
    if (!dir) throw new Error(`--data-root ${variant} 的目录是空的`);
    out.set(variant, dir);
  }
  return out;
}

/**
 * 声明的 envKey → 档位。
 *
 * 「这个变量属于 env 还是 pin」只在 `ROOT_ENV_KEYS` 登记一次，这里只查表，不从路径反推。
 * 以前是靠「候选路径落在哪个 env 值下面」算档：env 值只是 home 下的目录名时
 * （`WORKBUDDY_DATA_FOLDER_NAME`）算成 default，写门把宿主自己声明的位置当成「我们猜的」拒收；
 * 反过来 `CODEBUDDY_CONFIG_DIR` 被名称门拒掉后回落的默认路径不匹配它，反而算对 —— 同一件事两头都猜。
 *
 * 声明漏标 envKey 会被如实降成 default（不会静默升档），并由 m55 的执行锁定兜住：
 * 所有候选用到的 envKey 必须在 ROOT_ENV_KEYS 里登记。
 */
function tierOfDeclared(variant, cand) {
  if (cand.tier) return { tier: cand.tier, envKey: cand.envKey ?? null };
  const key = cand.envKey ?? null;
  if (!key) return { tier: 'default', envKey: null };
  const groups = ROOT_ENV_KEYS[variant] ?? {};
  if ((groups.env ?? []).includes(key)) return { tier: 'env', envKey: key };
  if ((groups.pin ?? []).includes(key)) return { tier: 'pin', envKey: key };
  return { tier: 'default', envKey: key };
}

/** 声明顺序 → 归一后的候选；role:'aux' 是给写侧的平行库（如 zcode 侧栏索引），不是会话来源 */
function declaredCandidates(variant, ctx) {
  const v = VARIANTS[variant];
  const out = [];
  for (const x of v.readPaths?.(ctx) ?? []) out.push({ ...x, source: 'read' });
  for (const x of v.writePaths?.(ctx) ?? []) out.push({ ...x, source: 'write' });
  for (const x of v.auxPaths?.(ctx) ?? []) out.push({ ...x, source: 'aux', role: x.role ?? 'aux' });
  return out.map((x) => {
    const t = tierOfDeclared(variant, x);
    return {
      path: x.path,
      kind: x.kind ?? null,
      role: x.role ?? null,
      note: x.note ?? null,
      tier: t.tier,
      envKey: t.envKey,
      marker: x.marker ?? null,
      source: x.source,
    };
  });
}

function notePair(kept, dropped, droppedTier) {
  if (!kept) return dropped ?? null;
  if (!dropped || dropped === kept) return kept;
  return `${kept}｜同一位置还由 ${droppedTier} 档登记：${dropped}`;
}

// 同一路径可能既被 env 派生又被默认登记（qoder 的注册表就是这种）：只留优先级最高的一份，
// 但被弃掉那份的 note 合并进来，否则证据里看不出它原本是哪一档。
function dedupe(cands) {
  const byPath = new Map();
  for (const c of cands) {
    const key = cmpPath(path.normalize(c.path));
    const prev = byPath.get(key);
    if (!prev) {
      byPath.set(key, { ...c, exists: existsOf(c) });
    } else if (prev.tier !== 'probe' && c.tier === 'probe') {
      // 探测撞上了声明过的同一个位置：声明那份赢。否则正常安装的宿主会被降级成 probe，
      // 而 probe 是不可自动写的档位 —— 会把「本来就能写」变成「要你补一个 --data-root」。
      prev.note = notePair(prev.note, c.note, c.tier);
    } else if (TIER_RANK[c.tier] < TIER_RANK[prev.tier]) {
      byPath.set(key, { ...prev, ...c, note: notePair(c.note, prev.note, prev.tier) });
    } else {
      prev.note = notePair(prev.note, c.note, c.tier);
    }
  }
  return [...byPath.values()];
}

// ---- 探测：候选父集 × marker 判定，一次遍历、全体变体共用 ----

export const PROBE_BUDGET_MS = 1200;
const PROBE_MAX_DIRS = 8000;
const PROBE_PER_DIR = 200;
// 这些进去只会烧掉预算而不会藏着会话库
const PROBE_NOISE = new Set(['node_modules', '.git', '.hg', '$recycle.bin', 'system volume information', 'winsxs', 'packages', 'temp', 'tmp', '__pycache__', 'venv', '.venv', 'target', 'dist', '.trash', 'appdata\\local\\temp']);

function childEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 一次有界遍历，建「小写目录名 → 路径清单」索引。
 * 逐家各扫一遍的话，20 个变体 × 上万个目录会把每条命令都拖成几十秒；
 * 所有 probe 的 names 都从同一份索引里查，预算只花一次。
 */
function probeIndex(ctx, maxDepth) {
  const cached = INDEX_BY_CTX.get(ctx);
  if (cached && cached.maxDepth >= maxDepth) return cached.byName;
  const specs = ALL_PROBE_SPECS(ctx);
  const namesWanted = new Set(specs.flatMap((s) => s.names.map((n) => n.toLowerCase())));
  for (const s of specs) for (const id of s.extIds ?? []) namesWanted.add(id.toLowerCase());
  const byName = new Map();
  const queue = specs.map((s) => ({ dir: s.base, depth: 0 })).filter((x) => x.dir && isDir(x.dir));
  const seen = new Set();
  const deadline = Date.now() + PROBE_BUDGET_MS;
  let visited = 0;
  while (queue.length && visited < PROBE_MAX_DIRS) {
    const { dir, depth } = queue.shift();
    const key = cmpPath(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    visited++;
    if (Date.now() > deadline) break;
    for (const e of childEntries(dir).slice(0, PROBE_PER_DIR)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const lower = e.name.toLowerCase();
      if (PROBE_NOISE.has(lower)) continue;
      const full = path.join(dir, e.name);
      if (namesWanted.has(lower)) {
        if (!byName.has(lower)) byName.set(lower, []);
        byName.get(lower).push(full);
      }
      if (depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  const truncated = visited >= PROBE_MAX_DIRS || Date.now() > deadline;
  INDEX_BY_CTX.set(ctx, { maxDepth, byName, visited, truncated });
  PROBE_STATS.set(ctx, { visited, truncated, maxDepth });
  return byName;
}

function ALL_PROBE_SPECS(ctx) {
  const out = [];
  for (const variant of Object.keys(VARIANTS)) {
    const spec = locatorOf(variant).probe;
    if (!spec) continue;
    for (const base of spec.parents) {
      const dir = locatorBase(ctx, variant, base);
      if (dir) out.push({ base: dir, names: spec.names, extIds: spec.extIds ?? [], maxDepth: spec.maxDepth });
    }
  }
  return out;
}

export function probeMaxDepth() {
  return Math.max(1, ...Object.keys(VARIANTS).map((v) => locatorOf(v).probe?.maxDepth ?? 1));
}

/** marker 是「这个目录真的属于本变体」的唯一判据 —— 目录存在本身不算 */
export function verifyMarker(rootDir, marker) {
  if (!rootDir || !marker) return { ok: false, why: 'no-marker-declared' };
  switch (marker.kind) {
    case 'children': {
      const sets = marker.any ?? [];
      return { ok: sets.some((segs) => isDir(path.join(rootDir, ...segs))), why: 'children-missing' };
    }
    case 'sqlite-tables': {
      const file = path.join(rootDir, ...(Array.isArray(marker.rel) ? marker.rel : [marker.rel]));
      if (!isFile(file)) return { ok: false, why: 'db-missing' };
      let db = null;
      try {
        db = openDb(file);
        const sets = marker.any ?? [marker.all ?? []];
        return { ok: sets.some((tabs) => tabs.every((t) => tableExists(db, t))), why: 'table-missing' };
      } catch {
        return { ok: false, why: 'db-unreadable' };
      } finally {
        try {
          db?.close();
        } catch {
          /* 已经读到了结论，关不掉不影响判定 */
        }
      }
    }
    case 'descendant-named': {
      const queue = [{ dir: rootDir, depth: 0 }];
      const limit = marker.maxDepth ?? 4;
      while (queue.length) {
        const { dir, depth } = queue.shift();
        for (const e of childEntries(dir).slice(0, PROBE_PER_DIR)) {
          if (!e.isDirectory() || e.isSymbolicLink()) continue;
          if (e.name.toLowerCase() === marker.name.toLowerCase()) return { ok: true, why: null };
          if (depth + 1 < limit) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
      return { ok: false, why: `no-${marker.name}-descendant` };
    }
    default:
      throw new Error(`未知 marker.kind: ${marker.kind}`);
  }
}

/**
 * 探测命中一个目录后，把它**套回本家声明的形状**：
 * 声明里的 `<配置根>/projects`、`<appData 产品目录>/main.sqlite` 这些相对段原样搬到探测到的根下面，
 * kind/role/note 全部保留。这样各家 reader 现有的 role/kind 过滤不用改也能看到探测结果 ——
 * 探测的产物是「搬过位置的声明」，不是一种新的候选形态。
 */
function remapDeclaredOntoProbe(variant, ctx, probeDir) {
  const name = path.basename(probeDir).toLowerCase();
  const out = [];
  for (const d of declaredCandidates(variant, ctx)) {
    const segs = path.normalize(d.path).split(/[\\/]+/);
    const idx = segs.findIndex((s, i) => i < segs.length - 1 && s.toLowerCase() === name);
    if (idx < 0) continue;
    // probeRoot：被探测命中的那个目录本身。--data-root 钉的是「根」，不是根下某个文件 ——
    // 可粘贴钉法必须用它（opencode 这类以 <root>/opencode.db 文件为候选的家，粘文件路径钉不进去）
    out.push({ ...d, path: path.join(probeDir, ...segs.slice(idx + 1)), tier: 'probe', envKey: null, source: 'probe', probeRoot: probeDir, note: `探测到 ${probeDir}` });
  }
  return out;
}

function probeCandidates(variant, ctx) {
  const spec = locatorOf(variant).probe;
  if (!spec) return { found: [], rejected: [] };
  const byName = probeIndex(ctx, probeMaxDepth());
  const found = [];
  const rejected = [];
  const hitPaths = new Set();
  const consider = (dir, checkParent) => {
    if (hitPaths.has(dir)) return;
    hitPaths.add(dir);
    if (checkParent && cmpPath(path.basename(path.dirname(dir))) !== 'globalstorage') {
      rejected.push({ path: dir, whyRejected: 'not-under-globalStorage' });
      return;
    }
    const verdict = verifyMarker(dir, locatorOf(variant).marker);
    if (!verdict.ok) {
      rejected.push({ path: dir, whyRejected: `marker:${verdict.why}` });
      return;
    }
    const remapped = remapDeclaredOntoProbe(variant, ctx, dir);
    if (!remapped.length) {
      rejected.push({ path: dir, whyRejected: 'no-declared-shape-under-probe-root' });
      return;
    }
    found.push(...remapped);
  };
  for (const name of spec.names) for (const dir of byName.get(name.toLowerCase()) ?? []) consider(dir, false);
  for (const id of spec.extIds ?? []) for (const dir of byName.get(id.toLowerCase()) ?? []) consider(dir, true);
  return { found, rejected };
}

/**
 * @param {string} variant
 * @param {object} ctx makeCtx() 产物
 * @returns {{variant:string, candidates:object[], readRoots:object[], writeRoot:object|null,
 *            bucketRoot:{path,exists,shape}|null, skillsDir:string|null,
 *            accountPaths:object[], userDataDirs:object[], evidence:object}}
 */
/**
 * 钉住（--data-root）时把声明的候选搬到钉住的位置，**与探测命中用的是同一套形状搬运**：
 * 拿「锚点目录名」去声明路径里找同名段，它后面的相对段原样搬到钉住根下面。
 * 于是「钉住根」= 「探测会找到的那个目录」，两者形状完全一致 —— 用户把提示串粘回来，
 * 写侧落点与读侧读到的位置必然是同一个地方（形状不一致时会出现「读得到、写不到」）。
 * 挂在别处的附属目录（qoder 桌面产品目录里的注册表库、IDE 插件目录）认不出锚点 → 保持原位。
 */
function pinDeclaredOnto(variant, ctx, pinned) {
  const spec = locatorOf(variant).probe;
  // 锚点 = 探测用的目录名 + 扩展 id（IDE 派生宿主靠 extId 认家族，如 saoudrizwan.claude-dev）
  const anchors = [...(spec?.names ?? []), ...(spec?.extIds ?? [])];
  const out = [];
  for (const d of declaredCandidates(variant, ctx)) {
    const segs = path.normalize(d.path).split(/[\\/]+/);
    const idx = segs.findIndex((s, i) => i < segs.length - 1 && anchors.some((a) => a.toLowerCase() === s.toLowerCase()));
    if (idx < 0) {
      out.push(d);
      continue;
    }
    out.push({ ...d, path: path.join(pinned, ...segs.slice(idx + 1)), tier: 'flag', envKey: null, source: 'flag', note: 'flag --data-root' });
  }
  return out;
}

export function resolveRoot(variant, ctx) {
  if (!VARIANTS[variant]) throw new Error(`未知 agent 变体: ${variant}`);
  const pinned = ctx?.dataRoots?.get?.(variant);
  const probe = probeCandidates(variant, ctx);
  const cands = dedupe([
    ...(pinned ? pinDeclaredOnto(variant, ctx, pinned) : []),
    ...(pinned ? [] : declaredCandidates(variant, ctx)),
    // 探测命中的根进的是同一份候选集（marker 通过才算），读侧立刻能用；写侧由下面的档位拦住
    ...probe.found,
  ]);

  // 读侧采纳：真实存在的，或用户/宿主明确声明过落点的（env / pin / flag —— 它们即使还不存在也是
  // 「该往这儿读写」，宿主可能还没首次启动）。default 与 probe 档只认真实存在。
  const isAdopted = (c) => c.exists || AUTHORITATIVE.has(c.tier);
  const readRoots = cands.filter(isAdopted);
  const tried = [
    ...cands.map((c) => ({
      path: c.path,
      tier: c.tier,
      role: c.role,
      outcome: isAdopted(c) ? 'adopted' : 'rejected',
      ...(isAdopted(c) ? {} : { whyRejected: 'not-found' }),
    })),
    ...probe.rejected.map((x) => ({ ...x, tier: 'probe', role: 'probe', outcome: 'rejected' })),
  ];

  // 写侧选择：**先按档位**（用户/宿主声明过的 flag>env>pin 优先），同档内再按「存在优先」。
  // 旧口径「第一个存在的目录型候选」会让钉住的那份排在默认位置之后 —— 钉了等于没钉。
  // probe 档排在 default 之后：它是「猜出来的位置」，永远不能成为写侧默认。
  const usableAll = cands.filter((c) => c.role !== 'aux');
  const pickForWrite = (list) => list.find((c) => c.exists && c.kind === 'dir') ?? list.find((c) => c.kind === 'dir') ?? list[0] ?? null;
  const chosen =
    pickForWrite(usableAll.filter((c) => c.tier === 'flag')) ??
    pickForWrite(usableAll.filter((c) => c.tier === 'env')) ??
    pickForWrite(usableAll.filter((c) => c.tier === 'pin')) ??
    pickForWrite(usableAll.filter((c) => c.tier === 'default')) ??
    pickForWrite(usableAll.filter((c) => c.tier === 'probe')) ??
    null;
  // 采纳门只有一条表达式（档位表 × 可见性），不写各家特例：
  //   probe 永远不可自动写 —— WRITABLE_TIERS 里没有它，因为写侧会 mkdir/写库/搬正文；
  //   声明过（flag/env/pin）直接可写；
  //   default 还要看这个宿主在本机是否真的出现过 —— 「装过但没跑过第一次」时
  //   `~/.codebuddy` 在而 `projects/` 不在，那是新建会话该有的样子，不能拦。
  const hostSeen = isDir(configRoot(ctx, variant));
  const writable = chosen ? WRITABLE_TIERS.has(chosen.tier) && (AUTHORITATIVE.has(chosen.tier) || chosen.exists || hostSeen) : false;
  // 探测命中且真实存在的根：写门拒收时用它给「可直接粘贴」的钉法
  const probeHits = cands.filter((c) => c.tier === 'probe' && c.exists);
  const writeEvidence = chosen
    ? { path: chosen.path, tier: chosen.tier, exists: chosen.exists, writable, ...(writable ? {} : { reason: 'write-root-unpinned' }) }
    : { path: null, tier: null, exists: false, writable: false, reason: 'no-root' };

  const bucket = bucketRoot(ctx, variant);
  // 桶根落在「文档」这类已知文件夹里的家，要判断该不该信这个位置：
  // 已知文件夹被重定向到别处、而那儿又没有本家自己生成的目录（Codex / QoderCN / deepseek-harness）
  // → 未证实，写侧改判 requires-cwd，宁可不写也不造宿主永远不会看的孤儿桶。
  // 没重定向、或注册表根本读不到（受限环境）都沿用 home 下的默认位置 —— 「不知道」不等于「搬走过」。
  const docs = documentsRoot(ctx);
  const bucketDecl = locatorOf(variant).bucket;
  const needsDocs = Boolean(bucketDecl?.knownFolder);
  // 只有「已知文件夹确实被指到别处」且「那儿没有本家自生成的标记」才算不可信；
  // 没重定向（含注册表读不到的 fallback）沿用 home 下的默认位置，与历史行为一致。
  const markerSeen = needsDocs ? exists(path.join(docs.path, bucketDecl.knownFolder)) : true;
  const bucketValidated = !bucket ? null : !needsDocs ? true : !docs.redirected || markerSeen;
  const result = {
    variant,
    candidates: cands,
    // 「装了没有」只有一个判据：本家的存在性规则（detect）命中，或读侧已经拿到真实候选。
    // 判定动作在 VARIANTS[v].detect（各家声明），但**消费只从这里走** —— readers/index 的分派、
    // detect 命令、import 的 not-installed 都读这一个字段，不再各问一遍。
    installed: (VARIANTS[variant].detect?.(ctx) ?? false) || readRoots.some((c) => c.exists),
    readRoots,
    writeRoot: writable ? chosen : null,
    configRoot: configRoot(ctx, variant),
    bucketRoot: bucket ? { path: bucket, exists: isDir(bucket), shape: bucketShape(variant), validated: bucketValidated, knownFolder: locatorOf(variant).bucket.knownFolder ?? null, documentsSource: docs.source } : null,
    skillsDir: skillsDirOf(ctx, variant),
    // 登录态与宿主自用状态目录都来自同一份声明；没声明就是空数组，accounts.mjs 会如实报 none
    accountPaths: accountPathsOf(ctx, variant),
    userDataDirs: userDataDirsOf(ctx, variant),
    evidence: {
      variant,
      tried,
      adopted: readRoots.map((c) => c.path),
      tier: chosen?.tier ?? null,
      write: writeEvidence,
      // 只有探测到真实存在的根才给可粘贴的钉法；指向一个本来就不存在的默认位置，粘过去也不会有任何不同。
      // 钉的是 probeRoot（探测命中的目录），不是根下某个文件
      paste: !writable && probeHits.length ? `--data-root ${variant}=${probeHits[0].probeRoot ?? probeHits[0].path}` : null,
    },
  };
  return result;
}

/**
 * 写侧采纳门的唯一消费出口：这对 (变体, ctx) 现在能不能写、不能写时给什么提示。
 * plan/apply 都从这里拿结论（import.mjs 挂到 placement.writeGate），writer 不再各自从
 * candidateRoots 里挑一个能摸到的路径就写 —— 那会绕过门，把正文写进探测档根（marker
 * 不是百分百可信）或宿主从未出现过的位置（孤儿）。
 */
export function writeGate(variant, ctx = makeCtx()) {
  const r = resolveRoot(variant, ctx);
  const wr = r.evidence.write;
  if (wr.writable) return { ok: true, reason: null, paste: null };
  const probeHit = r.candidates.find((c) => c.tier === 'probe' && c.exists);
  return { ok: false, reason: wr.reason === 'no-root' ? 'no-root' : 'write-root-unpinned', paste: probeHit ? `--data-root ${variant}=${probeHit.probeRoot ?? probeHit.path}` : null };
}

/**
 * 各 reader/writer 拿候选的唯一入口：声明的候选 + 探测命中的候选（同一种条目形状，kind/role/note 都在）。
 * 取代原先散在 32 处的 VARIANTS[x].readPaths(ctx) —— 只读声明就会漏掉搬过位置的根。
 */
export function candidateRoots(variant, ctx) {
  return resolveRoot(variant, ctx).candidates;
}

/**
 * 探测预算被烧掉时的记账。
 *
 * 探测是有界的（目录数 / 耗时双上限），烧完就只剩一个「没找到」——那和「确实不存在」
 * 是两件事。以前 truncated 只写进缓存没人读，于是「宿主明明装了却说没装」永远查不出原因。
 * 消费点：detect 的 JSON/文本输出。
 */
export function probeStats(ctx) {
  const s = PROBE_STATS.get(ctx) ?? { visited: 0, truncated: false, maxDepth: 0 };
  return { visited: s.visited, truncated: s.truncated, maxDepth: s.maxDepth, maxDirs: PROBE_MAX_DIRS, perDir: PROBE_PER_DIR, budgetMs: PROBE_BUDGET_MS };
}

/** 逐家一行可读结论：detect 用它，避免「只回一个布尔、错了没人知道为什么」 */
export function rootSummary(variant, ctx) {
  const r = resolveRoot(variant, ctx);
  const rejected = r.evidence.tried.filter((t) => t.outcome === 'rejected').length;
  const probed = r.candidates.filter((c) => c.tier === 'probe').length;
  const first = r.readRoots[0]?.path ?? null;
  const bits = [];
  if (first) bits.push(first);
  if (r.evidence.tier && r.evidence.tier !== 'default') bits.push(r.evidence.tier);
  if (probed) bits.push(`探测 ${probed}`);
  if (rejected) bits.push(`拒 ${rejected}`);
  if (!r.readRoots.length) bits.push(r.installed ? '只探到安装痕迹，没有可读候选' : '无候选存在');
  if (probeStats(ctx).truncated && !r.readRoots.length) bits.push('（探测预算耗尽，没找到不等于不存在）');
  return { variant, installed: r.installed, root: first, tier: r.evidence.tier, probeCount: probed, writable: !!r.writeRoot, line: `${variant}: ${bits.join('  ')}` };
}

/**
 * 列出已安装（探测到数据）的变体。
 * 判据走 resolveRoot().installed（本家 detect ‖ 存在的读候选）而不是只问 VARIANTS[].detect ——
 * 后者只看声明候选，探到「搬过位置」的根时会说没装（真机复现：沙箱 HOME 下 relocate opencode，
 * detect 报 not installed 而 list 读得到）。消费点：detect/--from auto/默认 --into/installer。
 */
export function detectInstalled(ctx = makeCtx()) {
  const out = [];
  for (const name of ALL_VARIANTS) {
    if (resolveRoot(name, ctx).installed) out.push(name);
  }
  return out;
}

/**
 * 按 role 取候选集合（写侧专用）。写侧不再自己拼 <root>/<相对段>：
 * 声明里给每个落点一个 role，写侧只按 role 要路径 —— 根被 --data-root / env 搬走时，
 * 写侧跟着 resolver 走，不必再抄一遍 env 链（抄一遍就等于多一套答案）。
 */
export function roleRoots(variant, ctx, role) {
  return candidateRoots(variant, ctx).filter((c) => c.role === role);
}

/**
 * 写侧要「一个」根时的出口：按档位取，**高优先档一律压过低优先档**。
 * flag（用户点名）> env（宿主声明）> pin > default > probe。
 * 档内再按「存在优先」挑 —— 但存在性只在同档内比较：用户点名的位置哪怕还没建，
 * 也得写在那儿（写入会自建目录）；不能因为默认位置上有个旧目录就把钉住的意思吃掉。
 */
export function writeRootOf(variant, ctx, role = null) {
  const all = role ? roleRoots(variant, ctx, role) : candidateRoots(variant, ctx);
  const rank = { flag: 0, env: 1, pin: 2, default: 3, probe: 4 };
  const best = Math.min(...all.map((c) => rank[c.tier] ?? 9));
  const sameTier = all.filter((c) => (rank[c.tier] ?? 9) === best);
  return sameTier.find((c) => c.exists) ?? sameTier[0] ?? null;
}
