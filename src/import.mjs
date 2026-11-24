// import.mjs — 导入编排：多源 × 多目标 计划（status）与执行（import）
//
// 零登记表去重的落点：
//   1. 同一原始会话经不同链路到达 → originKey 相同 → 目标 ID 相同 → 命中同一目标会话
//   2. 源侧去重（计划期）：同 origin 多副本读 IR 算核心指纹——严格前缀/相同 → 丢短副本并把
//      provenance/account 并入保留者；分叉 → 全部保留（摘要只用于排序，不用于判定）
//   3. 批内去重：键含源身份，只折叠真正重复的 pair；分叉副本交给执行期逐条重校验（先落一条，后续 fork）
//   4. round-trip 导回原生变体 → 目标 ID = 原生会话 ID → 已存在且一致即 skip
//   5. append 判据：身份（originKey 相等）+ 内容（目标是源的严格前缀）；原生会话同样可续写，
//      写侧剥离 provenance 保持其原生状态
//
// 支持「目标 agent 正在运行」的并发安全（这是主用场景）：
//   - 每个 (源,目标) 的写入在**目标级文件锁**内完成（挡住我们自己的多进程）
//   - 锁内**重新读目标并重新判定**：宿主可能在 plan 之后又写了新内容
//   - 底层用原子写/单次追加/DB 事务（见 writers/base.mjs、lock.mjs）
import fs from 'node:fs';
import { buildProvenance, tagTitle } from './provenance.mjs';
import { targetSessionId, forkSessionId, forkBranchKey, originKeyOf } from './identity.mjs';
import { decideAction, isFpPrefix } from './diff.mjs';
import { sessionCoreFingerprints } from './ir.mjs';
import { cmpPath } from './util.mjs';
import { listSessions, readSession } from './readers/index.mjs';
import { getWriter } from './writers/index.mjs';
import { verifyImported } from './verify.mjs';
import { acquireLock } from './lock.mjs';
import { resolvePlacement } from './placement.mjs';
import { writeGate } from './roots.mjs';
import { ALL_VARIANTS } from './hosts.mjs';
import { fitTitleFor, normalizeTitle, titleMaxOf } from './titles.mjs';

function pairKey(target, targetId, sourceVariant, sourceId) {
  // 键含源身份：同 origin 的分叉副本会被源侧去重保留下来，属于不同内容的不同导入，
  // 不能按 (target,targetId) 折叠（折叠会静默丢掉一条分支）
  return `${target}\u0000${targetId}\u0000${sourceVariant}:${sourceId}`;
}

/**
 * 源侧去重：同 origin 的多份副本按内容判定。
 * 摘要（turns）只用于排序——轮次少不一定是前缀，判定必须读 IR 算核心指纹。
 * 严格前缀 / 完全相同 → 丢弃短副本（provenance/account 是会话属性，并入保留者）；分叉 → 全部保留。
 */
function dedupeSources(ctx, sources) {
  const byOrigin = new Map();
  for (const s of sources) {
    const key = originKeyOf(s);
    const g = byOrigin.get(key);
    if (g) g.push(s);
    else byOrigin.set(key, [s]);
  }
  const list = [];
  const dropped = [];
  for (const [originKey, group] of byOrigin) {
    if (group.length === 1) {
      list.push(group[0]);
      continue;
    }
    const loaded = group.map((s) => {
      let fp = null;
      try {
        const r = readSession(s.variant, ctx, s.id);
        if (r.ok && r.session) fp = sessionCoreFingerprints(r.session);
      } catch {
        /* 读不出就保留，交给执行期再判 */
      }
      return { s, fp };
    });
    loaded.sort((a, b) => (b.fp?.length ?? b.s.turns ?? 0) - (a.fp?.length ?? a.s.turns ?? 0));
    const keep = [];
    for (const item of loaded) {
      const covered = item.fp ? keep.find((t) => isFpPrefix(item.fp, t.fp)) : null;
      if (covered) {
        if (!covered.s.provenance && item.s.provenance) covered.s.provenance = item.s.provenance;
        if (!covered.s.account && item.s.account) covered.s.account = item.s.account;
        dropped.push({ originKey, dropped: { variant: item.s.variant, id: String(item.s.id) }, kept: { variant: covered.s.variant, id: String(covered.s.id) } });
        continue;
      }
      keep.push(item);
    }
    list.push(...keep.map((x) => x.s));
  }
  return { list, dropped };
}

// 落点选项：CLI 的 --cwd / --account / --placement 原样透传给唯一策略出口
function placementOpts(opts = {}) {
  return { cwd: opts.cwd, account: opts.account, placement: opts.placement };
}

// append 的落点：默认仍跟随 placement（m19：改了落点要搬，正文只能有一份）；
// 但 kilo/cline 这类「源里没有 cwd」的变体算不出落点时，不能把已经存在的会话判成 requires-cwd 跳过 ——
// 追加写进它自己在的位置就行（真机实测：kilo/cline 的 append 被 D4 误拦）。
function placementFor({ source, target, ctx, opts, action, dstSession, targetId }) {
  const place = resolvePlacement(source, target, ctx, { ...placementOpts(opts), targetId });
  if (action === 'append' && dstSession && place.source === 'requires-cwd' && !place.directory) {
    return {
      scope: dstSession.scope ?? 'none',
      directory: dstSession.cwd || null,
      source: 'append:target',
      account: dstSession.account ?? place.account ?? null,
      warnings: [`append-in-place: 源没有可用落点，追加写进目标现有位置（${dstSession.cwd || '目标自有位置'}）`],
    };
  }
  return place;
}

/**
 * 落点告警（必须碰文件系统，所以不放进 placement.mjs —— 那边保持纯函数）：
 * 项目会话按源目录落，但那个目录已经不在了 → 原样保留 + 提示，不静默造目录。
 */
function annotatePlacement(place) {
  if (!place) return place;
  try {
    if (place.scope === 'project' && place.directory && !fs.existsSync(place.directory)) {
      place.warnings = [...(place.warnings ?? []), `project-dir-missing: 源项目目录不存在（${place.directory}），仍按原样保留；宿主可能不会列出`];
    }
  } catch {
    /* 权限/长路径异常不影响计划 */
  }
  return place;
}

/**
 * 在已知目标会话的前提下做决策（plan 与 execute 共用，保证两边规则一致）。
 * @param {(targetVariant:string, id:string)=>{ok:boolean, session?:object|null, error?:string}} readTarget
 *   读回目标会话（fork 收敛判定用）。**必须保留 ok**：读失败 ≠ 不存在（见函数内说明）
 */
// ---- 目标索引：按 id 与 originKey 索引目标会话（plan 与 execute 共用） ----
function targetIndexFor(variant, ctx) {
  const r = listSessions(variant, ctx, {});
  const summaryById = new Map((r.sessions ?? []).map((s) => [String(s.id), s]));
  const byOrigin = new Map();
  for (const s of r.sessions ?? []) {
    const key = originKeyOf(s);
    const g = byOrigin.get(key) ?? [];
    g.push(s);
    byOrigin.set(key, g);
  }
  return { ok: r.ok, available: r.available !== false, count: (r.sessions ?? []).length, conflicts: r.conflicts ?? [], ids: new Set(summaryById.keys()), summaryById, byOrigin };
}

// 按 ctx 分组缓存（WeakMap：落点一律由出口解析，这里不碰任何基准目录，也不留跨调用的悬挂引用）
const siblingIndexCache = new WeakMap();
function siblingIndexFor(variant, ctx) {
  let byVariant = siblingIndexCache.get(ctx);
  if (!byVariant) {
    byVariant = new Map();
    siblingIndexCache.set(ctx, byVariant);
  }
  if (!byVariant.has(variant)) {
    const r = listSessions(variant, ctx, {});
    byVariant.set(variant, new Map((r.sessions ?? []).map((s) => [String(s.id), s])));
  }
  return byVariant.get(variant);
}

/**
 * 同族双份守卫。危险条件很窄，只有一种：**同族两版共享同一套派生命名空间**
 * （`identity.UUID_FAMILY`），于是同一 originKey 在两版得到同一个 id —— 写错版本时不报错，
 * 只在另一版再存一份，两份各自看起来都正常，事后无从判定哪份是真的
 * （本机现场：同一来源在 `.workbuddy` 里 12653 行、在 `.workbuddy-ai` 里 139 行，同 id 各一份）。
 *
 * 因此两条豁免必须留着，否则这道门会把正常功能拦掉：
 *   - 派生 id 不同的同族两版（qoder-cn / qoder-intl）各写一份是本工具的 n:n 本意，不是双份；
 *   - 命中的那份如果就是这一条会话在另一版的**原生本体**（源即那一版），那是跨安装导入的上游，
 *     不是副本（`switch-account` / 中英互导都走这条路）。
 */
export function familyDuplicateOf(target, srcDesc, ctx) {
  const fam = (v) => v.replace(/-(cn|intl)$/, '');
  const idHere = String(targetSessionId(target, srcDesc));
  for (const sib of ALL_VARIANTS) {
    if (sib === target || fam(sib) !== fam(target) || !getWriter(sib)) continue;
    const id = String(targetSessionId(sib, srcDesc));
    if (id !== idHere) continue;
    const hit = siblingIndexFor(sib, ctx).get(id);
    if (!hit) continue;
    if (sib === srcDesc?.variant && String(srcDesc?.id) === id) continue;
    const body = readSession(sib, ctx, id);
    return {
      variant: sib,
      id,
      title: hit.title ?? '',
      turns: hit.turns ?? null,
      updatedAt: hit.updatedAt ?? null,
      path: body?.session?.meta?.sourcePath ?? hit.sourcePath ?? null,
      placement: hit.scope === 'none' ? '非项目桶' : hit.cwd || '项目目录',
    };
  }
  return null;
}

// 写入后把新会话/更新行并回索引，避免同一批次内后续 pair 读到陈旧列表
function addToIndex(index, summary) {
  const id = String(summary.id);
  index.summaryById.set(id, summary);
  index.ids.add(id);
  const key = originKeyOf(summary);
  const g = index.byOrigin.get(key) ?? [];
  const i = g.findIndex((x) => String(x.id) === id);
  if (i >= 0) g[i] = summary;
  else g.push(summary);
  index.byOrigin.set(key, g);
}

// fork 决策：分支坐标的定义在 identity.forkBranchKey（那里只有一份实现）
function forkFrom(target, sourceSession, parentId, baseId, at, reason, sameLineage) {
  const branchKey = forkBranchKey(parentId, at, sourceSession.turns?.[at] ?? null);
  return { action: 'fork', targetId: String(forkSessionId(target, sourceSession, branchKey)), at, reason: reason ?? null, sameLineage, baseId, parentId: String(parentId), targetSession: null };
}

/**
 * 这些 skip 理由说明「正文完全一致、只有名字可能变」——
 * 只有它们在 skip 通道里有资格同步标题（内容有差异的路径在写入后单独补一次）。
 */
const TITLE_ONLY_REASONS = new Set(['identical', 'fork-converged:identical']);

/**
 * 标题同步的**唯一出口**：源侧名字跟目标不一样就改成源侧的名字（没变则一律不写）。
 *
 * 为什么判据不在这里：什么时候有资格同步标题取决于**场景**，不是这条同步本身的性质。
 *   - 正文没变（identical / fork-converged:identical）→ 只有标题可能变，必须同步
 *   - 正文有新增（append）→ 写入时不再顺带写标题（那是第二条写入口），写完同样走这里补
 * 把判据放在调用点、机制只留一份，标题就只有一个写入口。
 *
 * 「用户自己定过名」由 writer 的 guard 槽挡住（syncTitle 内部 fail-closed），不在这里判。
 * 标题变化**不算内容变化**：核心指纹只取消息文本与工具调用，不含标题，
 * 所以改名不会把 identical 变成 fork（否则每次改名都会长出一条新副本）。
 */
function syncTitleIfChanged({ writer, ctx, target, targetId, sourceTitle, targetTitle, targetSession }) {
  const warnings = [];
  if (!writer?.syncTitle) return { changed: false, warnings };
  // 期望值必须**按目标宿主的容量算**：写侧装不下会截断，拿未截断的源值去比，
  // 就会「写进去 120 字、读回来 120 字、源值 300 字」永远不相等 → 每轮重写一遍。
  const fit = fitTitleFor(target, sourceTitle);
  const src = fit.value;
  if (!src) return { changed: false, warnings };
  // 目标侧标题取读回来的 IR（读侧口径与宿主一致：db 列优先、正文标题行兜底）
  const dst = normalizeTitle(targetTitle ?? targetSession?.title ?? '');
  if (dst === src) return { changed: false, warnings };
  try {
    const r = writer.syncTitle(ctx, { targetId, title: src });
    if (!r?.ok) warnings.push(`title-sync-failed: ${r?.error ?? 'unknown'}`);
    if (Array.isArray(r?.warnings)) warnings.push(...r.warnings);
    // skipped 不是错误（典型是「用户在目标宿主里改过名」）：如实透出原因，
    // 让调用方能在结果里说清「为什么这次没改名」，而不是让用户以为同步漏了
    return { changed: Boolean(r?.changed), warnings, skipped: r?.skipped ?? null, title: src, truncated: fit.truncated };
  } catch (err) {
    warnings.push(`title-sync-failed: ${String(err?.message ?? err)}`);
    return { changed: false, warnings, skipped: null };
  }
}

/**
 * 身份无据时**唯一允许的结论**：内容已经在了（什么都不做）。
 *
 * 只认两种「不动作」的结论：
 *   - identical    —— 源与目标内容逐轮一致，这条会话已经在目标里了
 *   - target-ahead —— 目标的内容是源的超集（源没有新东西可写）
 * 其余（目标是源的严格前缀 / 双方分叉）一律返回 null，交给调用方判 fork + identity-mismatch：
 * 那两种都要**往目标里写**，而身份旁证已经没了，写进去可能污染别人的会话（m4 的底线）。
 *
 * @returns {'identical'|'target-ahead'|null}
 */
function decideWithoutIdentity(sourceSession, targetSession) {
  const srcFp = sessionCoreFingerprints(sourceSession);
  const dstFp = sessionCoreFingerprints(targetSession);
  if (srcFp.length === dstFp.length && srcFp.every((f, i) => f === dstFp[i])) return 'identical';
  if (isFpPrefix(srcFp, dstFp)) return 'target-ahead';
  return null;
}
/**
 * 唯一的 (源, 目标) 决策：在同 originKey、未归档的候选集里做包含关系三分法。
 *   - 完全相同            → skip（命中的不是基础 ID 时标 fork-converged）
 *   - 候选 ⊂ 源（严格前缀）→ append 到最长的候选（fork 也能被续写）
 *   - 源 ⊂ 候选            → skip(target-ahead)
 *   - 其余                 → 相对 LCP 最长的候选 fork
 * 归档会话只作存在性判定：不作候选；没有任何活跃候选时，归档行 → skip(target-archived)，
 * 源与目标是同一条会话（round-trip）→ skip(round-trip-self)。
 * 基础 ID 上坐着不同身份的会话 → fork + identity-mismatch，绝不 append。
 * 身份旁证（来源标记）丢失时：只允许「已经在那儿」的结论，见 decideWithoutIdentity。
 */
function resolveDecision(target, sourceSession, index, readSessionFn) {
  const baseId = String(targetSessionId(target, sourceSession));
  const originKey = originKeyOf(sourceSession);
  const baseSummary = index?.summaryById?.get(baseId) ?? null;

  /**
   * 读目标统一走这里，返回**读结果**而不是 session 本身。
   *
   * 为什么必须保留 ok：`session === null` 有两种含义 ——「目标没有这条会话」和「有但读不出来」
   * （正文损坏 / 库被锁 / 编码不认识）。把后一种当成前一种，就会对一条真实存在的会话判 create，
   * 等于拿源侧内容去覆盖一份读不动的宿主数据（review 2026-11-04 P1）。
   *
   * 读失败的目标**绝不参与决策**；基座 ID 读失败则整条判 error（宁可这一条不导，也不覆盖）。
   */
  const readCache = new Map();
  const readTarget = (id) => {
    if (readCache.has(id)) return readCache.get(id);
    const raw = readSessionFn(target, id);
    const v = raw && typeof raw === 'object' && 'ok' in raw ? raw : { ok: true, session: raw ?? null };
    readCache.set(id, v);
    return v;
  };
  const baseRead = baseSummary ? readTarget(baseId) : null;
  if (baseSummary && baseRead && baseRead.ok === false) {
    return {
      action: 'error',
      targetId: baseId,
      at: 0,
      reason: 'target-unreadable',
      error: `target-unreadable: ${baseRead.error ?? 'unknown'}（目标存在但读不出来，不覆盖）`,
      sameLineage: null,
      baseId,
      parentId: null,
      targetSession: null,
    };
  }
  const baseSession = baseRead?.ok ? baseRead.session : null;

  const candidates = [];
  for (const s of index?.byOrigin?.get(originKey) ?? []) {
    if (s.archived === true) continue;
    const id = String(s.id);
    // 源与目标同变体时，源会话本身也在目标列表里 —— 它不是可写入的基准
    if (target === sourceSession.variant && id === String(sourceSession.id)) continue;
    const r = id === baseId && baseRead ? baseRead : readTarget(id);
    if (r.ok === false) continue; // 读不动的候选不能当基准，也不能当「不存在」
    if (r.session) candidates.push({ id, session: r.session, summary: s });
  }

  if (candidates.length === 0) {
    if (!baseSummary) return { action: 'create', targetId: baseId, at: 0, reason: null, sameLineage: null, baseId, parentId: null, targetSession: null };
    const baseOrigin = originKeyOf(baseSummary);
    if (baseOrigin === originKey) {
      // 候选集为空只剩两种真情况：目标是归档行（D1：只作存在性判定，不写不搬），
      // 或源与目标本来就是同一条会话（round-trip 自同步，内容必然一致）
      return {
        action: 'skip',
        targetId: baseId,
        at: 0,
        reason: baseSummary.archived === true ? 'target-archived' : 'round-trip-self',
        sameLineage: true,
        baseId,
        parentId: null,
        targetSession: baseSession,
      };
    }
    if (!baseSession) return { action: 'create', targetId: baseId, at: 0, reason: 'target-unreadable', sameLineage: false, baseId, parentId: null, targetSession: null };
    // 归档行只作存在性判定（D1）：它不是一条活会话，「已经在那儿」这个结论对它不成立 ——
    // 哪怕内容一模一样，也得把源另导一条新的（m28 钉住的就是这条）。
    if (baseSummary?.archived === true) {
      const d = decideAction(sourceSession, baseSession, false);
      return { ...forkFrom(target, sourceSession, baseId, baseId, d.at ?? 0, d.reason ?? 'identity-mismatch', false), targetSession: baseSession };
    }
    // 身份无据（来源标记被宿主抹掉 / 老版本导入没写标记）时的处置：
    //   **只允许「已经在那儿」的结论**（内容完全一致 → identical；目标是源的超集 → target-ahead），
    //   两者都是「什么都不做」；**绝不往里续写**（append / 分叉一律 fork + identity-mismatch）。
    //
    // 为什么这样切：目标 id 是按 originKey **确定性派生**出来的（宿主原生 id 不会撞上），
    //   所以「这个位置原本就是这条源的导入位」这件事仍然成立 —— 标记只是「内容同宗」的旁证，
    //   旁证没了不等于事实不成立。但既然旁证没了，就不能确认它现在的内容与这条源同宗，
    //   往里写就可能写进别人的会话（m4 钉住的就是这条底线：宁可 fork 也不污染）。
    //   而「内容一致 / 目标更长」这两个结论只是**不动作**，写不坏任何东西。
    const noIdentity = decideWithoutIdentity(sourceSession, baseSession);
    if (noIdentity) {
      return {
        action: 'skip',
        targetId: baseId,
        at: 0,
        reason: noIdentity,
        sameLineage: false,
        baseId,
        parentId: baseId,
        targetSession: baseSession,
      };
    }
    const d = decideAction(sourceSession, baseSession, false);
    return { ...forkFrom(target, sourceSession, baseId, baseId, d.at ?? 0, d.reason ?? 'identity-mismatch', false), targetSession: baseSession };
  }

  const evaluated = candidates.map((c) => ({ c, d: decideAction(sourceSession, c.session, true) }));

  const exact = evaluated.find((x) => x.d.action === 'skip' && x.d.reason === 'identical');
  if (exact) {
    return {
      action: 'skip',
      targetId: exact.c.id,
      at: 0,
      reason: exact.c.id === baseId ? 'identical' : 'fork-converged:identical',
      sameLineage: true,
      baseId,
      parentId: exact.c.id,
      targetSession: exact.c.session,
    };
  }

  const appends = evaluated.filter((x) => x.d.action === 'append');
  if (appends.length > 0) {
    const best = appends.sort((a, b) => b.d.at - a.d.at)[0];
    return { action: 'append', targetId: best.c.id, at: best.d.at, reason: null, sameLineage: true, baseId, parentId: best.c.id, targetSession: best.c.session };
  }

  const containers = evaluated.filter((x) => x.d.action === 'skip' && x.d.reason === 'target-ahead');
  if (containers.length > 0) {
    const best = containers.sort((a, b) => (a.c.session.turns?.length ?? 0) - (b.c.session.turns?.length ?? 0))[0];
    return { action: 'skip', targetId: best.c.id, at: 0, reason: 'target-ahead', sameLineage: true, baseId, parentId: best.c.id, targetSession: best.c.session };
  }

  const forks = evaluated.filter((x) => x.d.action === 'fork');
  const best = forks.sort((a, b) => b.d.at - a.d.at)[0] ?? evaluated[0];
  return { ...forkFrom(target, sourceSession, best.c.id, baseId, best.d.at ?? 0, null, true), targetSession: best.c.session };
}

/**
 * 计划阶段（只读）。
 * @returns {{sources, sourceTotal, targets, pairs, summary, errors}}
 */
export function planImport(ctx, opts = {}) {
  // --from 省略 = 全部变体（未安装的自然为 0 条）；这是需求要求的缺省行为
  const from = Array.isArray(opts.from) && opts.from.length > 0 ? opts.from : ALL_VARIANTS.slice();
  const into = opts.into ?? [];
  const errors = [];
  const conflicts = [];

  // ---- 1. 收集源会话 ----
  const sources = [];
  for (const v of from) {
    const r = listSessions(v, ctx, {
      since: opts.since,
      until: opts.until,
      project: opts.project,
      includeSubagents: opts.includeSubagents,
    });
    if (!r.ok) errors.push({ variant: v, phase: 'list-source', error: r.error });
    if (r.available === false) errors.push({ variant: v, phase: 'list-source', error: 'not-installed' });
    for (const c of r.conflicts ?? []) conflicts.push({ ...c, from: 'source' });
    for (const s of r.sessions) sources.push({ ...s, variant: v });
  }
  // 正文加密/降级的会话（qoder 旧代 local.db 这类）只能读元数据：导过去只会写出「内容加密」占位说明，
  // 看起来像导成功、实际是空壳。默认跳过并单独计数，显式 --include-degraded 才允许。
  const degradedSkipped = sources.filter((s) => s.degraded).length;
  const usableSources = opts.includeDegraded ? sources : sources.filter((s) => !s.degraded);

  // 时间范围只对「有时间戳」的会话成立：updatedAt 缺失时无法证明它在范围内。
  // 给了范围就排除并计数（reader 侧仍放行 —— list 是查看，import 才落盘）；
  // 不带范围时不计数，无时间戳的会话照常参与。
  const ranged = opts.since != null || opts.until != null;
  const timed = ranged ? usableSources.filter((s) => Number(s.updatedAt) > 0) : usableSources;
  const timeUnknownSkipped = usableSources.length - timed.length;
  // D1：归档的会话一律不导（无开关）。reader 仍会列出它们，所以 sourceTotal
  //     与「目标已存在」判定都还看得见归档区，不会把已归档的同一条再新建一遍。
  //     必须先滤再去重：源侧去重是按内容比「谁覆盖谁」，归档副本往往更长（用户是在归档里继续写的），
  //     让它参加比对就会把活跃那份挤掉 —— 结果这条会话谁都不导，还不报错。
  const archivedSkipped = timed.filter((s) => s.archived === true).length;
  const activeSources = timed.filter((s) => s.archived !== true);
  // ---- 1.5 源侧去重：同 origin 多副本按内容判定，丢弃被更长副本覆盖的短副本 ----
  const deduped = dedupeSources(ctx, activeSources);
  const sourceDuplicates = deduped.dropped;
  const uniqueSources = deduped.list;
  uniqueSources.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  let picked = uniqueSources;
  // --id：指定的可能是「被源侧去重折叠掉的副本」——按 dropped→kept 映射到内容更全的那份，
  // 否则用户以为导了、实际 0 条（m28 的回归就是这个坑）。
  const requestedIds = Array.isArray(opts.ids) && opts.ids.length > 0 ? opts.ids.map(String) : [];
  const idRemap = new Map();
  for (const d of sourceDuplicates) {
    if (d?.dropped?.id != null && d?.kept?.id != null) idRemap.set(String(d.dropped.id), String(d.kept.id));
  }
  if (requestedIds.length > 0) {
    const want = new Set(requestedIds.map((id) => idRemap.get(id) ?? id));
    picked = picked.filter((s) => want.has(String(s.id)));
  }
  // 默认跳过空会话（0 轮且轮次为精确值；采样得到的 0 不可信，不据此丢弃）
  if (!opts.includeEmpty) {
    picked = picked.filter((s) => !(s.turns === 0 && !s.turnsApprox));
  }
  // --limit 语义：每个来源最多 N 条（多来源各自取最近 N 条，比全局截断更可预期）
  if (opts.limit > 0) {
    const perVariant = new Map();
    for (const s of picked) {
      const arr = perVariant.get(s.variant) ?? [];
      if (arr.length < opts.limit) arr.push(s);
      perVariant.set(s.variant, arr);
    }
    picked = [...perVariant.values()].flat();
  }

  // ---- 2. 每个目标变体只列一次，用于「目标是否已存在 / 同 origin 候选」判定 ----
  const targetIndex = new Map();
  for (const v of into) {
    const idx = targetIndexFor(v, ctx);
    if (!idx.ok) errors.push({ variant: v, phase: 'list-target', error: 'list-failed' });
    for (const c of idx.conflicts) conflicts.push({ ...c, from: 'target' });
    targetIndex.set(v, idx);
  }

  // ---- 3. 生成 (源 × 目标) 计划 ----
  const pairs = [];
  const srcIrCache = new Map();
  for (const src of picked) {
    const srcDesc = { variant: src.variant, id: src.id, origin: src.provenance?.origin ?? null };
    const originKey = originKeyOf(srcDesc);
    for (const target of into) {
      const idx = targetIndex.get(target);
      const baseId = String(targetSessionId(target, srcDesc));
      const base = {
        sourceVariant: src.variant,
        sourceId: String(src.id),
        sourceTitle: src.title ?? '',
        originKey,
        target,
        targetId: baseId,
        targetExists: idx?.ids.has(baseId) ?? false,
        targetSummary: idx?.summaryById.get(baseId) ?? null,
        action: 'create',
        at: 0,
        reason: null,
      };

      let decided;
      const sameOrigin = idx?.byOrigin?.get(originKey) ?? [];
      if (!base.targetExists && sameOrigin.length === 0) {
        // 快速路径：目标没有这条会话的任何形态 → create，不读源正文
        decided = base;
      } else {
        const cacheKey = `${src.variant}\u0000${src.id}`;
        let srcIr = srcIrCache.get(cacheKey);
        if (srcIr === undefined) {
          const r = readSession(src.variant, ctx, src.id);
          srcIr = r.ok && r.session ? r.session : null;
          srcIrCache.set(cacheKey, srcIr);
        }
        if (!srcIr) {
          errors.push({ variant: src.variant, phase: 'read-source', id: String(src.id), error: 'not-found' });
          decided = { ...base, action: 'error', reason: 'source-not-readable' };
        } else {
          const d = resolveDecision(target, srcIr, idx, (v, id) => readSession(v, ctx, id));
          const { targetSession, ...rest } = d;
          decided = { ...base, ...rest, targetId: String(d.targetId), targetSummary: idx?.summaryById.get(String(d.targetId)) ?? null };
          decided._dst = targetSession;
        }
      }
      // 同族双份守卫：这一条若会往目标**新引入**某个 origin，而同族另一版里已经有同一个
      // origin（派生 id 相同），就中止该条、一个字节都不写 —— 静默留下两份的后果是事后无从判定
      // 哪份是真的（中英版曾各留一份、行数差 90 倍）。要绕过必须显式点名。
      if (!opts.allowFamilyDuplicate && (decided.action === 'create' || decided.action === 'fork')) {
        const dup = familyDuplicateOf(target, srcDesc, ctx);
        if (dup) Object.assign(decided, { action: 'skip', reason: 'edition-duplicate', executed: false, duplicateOfSibling: dup });
      }
      // fork/append 的 targetId 可能与基础 ID 不同，落点目录（generated 桶按 targetId 派生）必须跟着最终 ID 算
      decided.placement = placementFor({ source: src, target, ctx, opts, action: decided.action, dstSession: decided._dst, targetId: decided.targetId });
      annotatePlacement(decided.placement);
      // 写侧采纳门：目标根没被采纳可写（探测档未钉住 / 宿主从没出现过）时预报告知怎么钉。
      // 挂在 placement 上，dry-run 与 --apply 走同一份结论，不会「预告要写、落盘时另作主张」。
      if (decided.action !== 'skip' && decided.action !== 'error') {
        const gate = writeGate(target, ctx);
        if (!gate.ok) decided.placement.writeGate = gate;
      }
      delete decided._dst;
      pairs.push(decided);
    }
  }

  // ---- 4. 批内去重：同一 (目标, 目标ID) 只留一条 ----
  const byKey = new Map();
  for (const p of pairs) {
    const k = pairKey(p.target, p.targetId, p.sourceVariant, p.sourceId);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, p);
      continue;
    }
    const rank = (a) => ({ append: 3, create: 2, fork: 1, skip: 0, error: -1 })[a] ?? 0;
    if (rank(p.action) > rank(cur.action)) {
      cur.duplicateOf = `${cur.sourceVariant}:${cur.sourceId}`;
      byKey.set(k, p);
    } else {
      p.action = 'skip';
      p.reason = 'duplicate-in-batch';
      p.duplicateOf = `${cur.sourceVariant}:${cur.sourceId}`;
    }
  }

  // 刻意**不**按 (目标, 目标ID) 在计划期折叠不同源的 pair：
  // 同一槽位被两条不同源会话命中时，正确结果是「执行期把第二条判 fork、各落一条」，
  // 而不是在这里静默丢掉一条（m34 的分叉副本用例钉着这条语义：同 origin、同长度、
  // 内容不同的两副本必须都活下来）。计划期折叠看起来更「干净」，代价是丢数据。
  const summary = {};
  for (const p of pairs) summary[p.action] = (summary[p.action] ?? 0) + 1;

  // 用户点名要的 id 里，最后没产出任何 pair 的就是「缺失」（归档 / 空会话 / 被 limit 截掉 / 根本不存在）
  const pairSourceIds = new Set(pairs.map((p) => String(p.sourceId)));
  const missingIds = requestedIds.filter((id) => !pairSourceIds.has(idRemap.get(id) ?? id));

  return {
    sources: picked.length,
    sourceTotal: sources.length,
    sourceDuplicates,
    archivedSkipped,
    timeUnknownSkipped,
    degradedSkipped,
    missingIds,
    // 同 id 但 origin 不同的冲突（按合并策略保留了一条，另一条未被采用）
    conflicts,
    // 落点选项随计划一起走：executePlan 缺省时延用它，避免 dry-run 说的落点和 --apply 真写的落点两套口径
    placementOpts: placementOpts(opts),
    targets: into.map((v) => ({ variant: v, existing: targetIndex.get(v)?.count ?? 0, available: targetIndex.get(v)?.available ?? false })),
    pairs,
    summary,
    errors,
  };
}

/**
 * skip 的唯一执行出口：正文没变，但落点 / 索引 / 标题仍可能需要自愈。
 *
 * 只在 `acquireLock('target:<变体>')` 内调用 —— 这三件事都不是只读：
 * relocate 会 unlink 旧文件、ensureIndex 写 sqlite、drift 整份重写正文。
 *
 * 顺序是约束，不可调换：
 *   1) duplicate-in-batch / 归档 → 纯 skip（不自愈、不搬、不改名）
 *   2) relocate（只搬我们自己写过的行：宿主原生会话摆在哪是宿主自己的决定）
 *   3) ensureIndex（标题传**目标侧**，绝不传源侧 —— 那是绕过 drift 窄判据的旁路）
 *   4) syncTitleDrift（必须排在 relocate 之后：body-row 槽靠 findExistingByTargetId 找文件）
 *   5) addToIndex 并回（否则同批后续 pair 读旧摘要会重复搬、重复改名）
 */
function applySkipSelfHeal({ p, writer, ctx, summary, reason, freshIdx }) {
  const warnings = [];

  // 批内被折叠：正主那条负责自愈
  if (reason === 'duplicate-in-batch') {
    return { ...p, action: 'skip', reason, executed: false, duplicateOf: p.duplicateOf ?? null };
  }
  // D1：归档目标只作存在性判定（改了也看不见，取消归档后状态还会错乱）
  if (summary?.archived === true) {
    return { ...p, action: 'skip', reason: 'target-archived', executed: false };
  }

  const wantDir = p.placement?.directory;
  const curDir = summary?.cwd;
  let relocated = false;

  if (!summary?.provenance) {
    if (wantDir && cmpPath(wantDir) !== cmpPath(curDir)) {
      warnings.push('relocate-foreign: 目标是宿主原生会话（无 session-sync 标记），未搬迁落点、未改索引');
    }
  } else {
    if (wantDir && writer?.relocate && cmpPath(wantDir) !== cmpPath(curDir)) {
      try {
        const rr = writer.relocate(ctx, {
          targetId: p.targetId,
          directory: wantDir,
          scope: p.placement?.scope ?? null,
          account: p.placement?.account ?? null,
        });
        relocated = Boolean(rr?.ok);
        if (rr && rr.ok === false) warnings.push(`relocate-refused: ${rr.error}`);
        for (const w of rr?.warnings ?? []) warnings.push(w);
      } catch {
        warnings.push('relocate-failed: 落点已变但正文搬迁失败（内容仍完整，可重跑）');
      }
    }
    if (writer?.ensureIndex) {
      try {
        const ei = writer.ensureIndex(ctx, {
          targetId: p.targetId,
          // 索引自愈**不碰标题**：标题有且只有一个负责人 —— drift 通道。
          // 这里传目标侧自己的标题（仅供「索引行还不存在、需要新建」时填初值），
          // 不传源侧标题 —— 否则就成了绕过 drift 窄判据（仅 identical）的旁路：
          // skip 分支还有 target-ahead（目标比源更新），那时源侧标题是旧名。
          title: summary?.title ?? '',
          // 用落点目录而不是摘要里的 cwd：否则自愈会把索引行钉回旧的沙箱路径
          cwd: wantDir ?? summary?.cwd ?? '',
          scope: p.placement?.scope ?? null,
          model: summary?.model ?? null,
          createdAt: summary?.createdAt,
          updatedAt: summary?.updatedAt,
        });
        // 自愈的动作要能报出来（例如 minimax 合并重复项目行）——否则用户看不到发生了什么
        for (const w of ei?.warnings ?? []) warnings.push(String(w));
      } catch {
        /* 自愈失败不影响 skip 结论 */
      }
    }
  }

  // 元数据漂移：内容没变（指纹相同）但源侧改了标题 → 把新名同步到目标。
  // 计划期就判 skip 的这条路径也要同步，否则「在源宿主改了名再复跑」永远看不到新名。
  // 只有「这条会话正文没变、只是名字变了」才在这里同步（判据属场景，见 syncTitleIfChanged）
  const drift = TITLE_ONLY_REASONS.has(reason)
    ? syncTitleIfChanged({
        writer,
        ctx,
        target: p.target,
        targetId: p.targetId,
        sourceTitle: p.sourceTitle,
        targetTitle: summary?.title ?? null,
      })
    : null;

  // 并回锁内索引：不并回的话，同批后续 pair 会拿旧 cwd 再搬一遍、拿旧标题再同步一遍
  if (freshIdx && summary) {
    addToIndex(freshIdx, {
      ...summary,
      cwd: relocated ? wantDir : summary.cwd,
      title: drift?.changed ? String(drift.title ?? '') : summary.title,
    });
  }

  const allWarnings = [...warnings, ...(drift?.warnings ?? [])];
  return {
    ...p,
    action: 'skip',
    reason,
    executed: false,
    ...(relocated ? { ok: true, relocated: true } : {}),
    ...(drift?.changed ? { titleSynced: true, title: drift.title } : {}),
    ...(drift?.truncated ? { titleTruncatedTo: titleMaxOf(target) } : {}),
    ...(drift?.skipped ? { titleSkipped: drift.skipped } : {}),
    ...(allWarnings.length ? { warnings: allWarnings } : {}),
  };
}

/**
 * 执行阶段。
 * @param apply false = dry-run（不写盘）
 * @param lock true = 按目标加跨进程锁（默认开）
 * @param lockTimeoutMs 抢锁超时
 * @param cwd/account/placement CLI 的 --cwd / --account / --placement，交 placement.mjs 解释
 */
export function executePlan(ctx, plan, { apply = false, force = false, lock = true, lockTimeoutMs = 30000, cwd = null, account = null, placement = null } = {}) {
  const fromPlan = plan?.placementOpts ?? {};
  const opts = {
    cwd: cwd ?? fromPlan.cwd ?? null,
    account: account ?? fromPlan.account ?? null,
    placement: placement ?? fromPlan.placement ?? null,
  };
  const results = [];
  if (!apply) {
    // dry-run 也要把 requires-cwd / 未钉住的写根标成 skipped，报告才能与 --apply 同一口径列「待用户指定」
    for (const p of plan.pairs) {
      const req = p.placement?.source === 'requires-cwd' && !p.placement?.directory;
      const gate = p.placement?.writeGate;
      const blocked = !req && gate && !gate.ok;
      results.push({
        ...p,
        executed: false,
        dryRun: true,
        ...(req ? { status: 'skipped', reason: 'requires-cwd', hint: p.placement.hint } : {}),
        ...(blocked ? { status: 'skipped', reason: gate.reason ?? 'write-root-unpinned', hint: gate.paste ?? null } : {}),
      });
    }
    return results;
  }

  // 每个目标第一次真正写入前先做一次索引/ID 自愈（旧版导入的裸 uuid 等）
  const repairedTargets = new Set();
  // 锁内决策用的目标索引：按目标缓存，写入后把新会话并回去（同一批次后续 pair 才能看见）
  const freshIndexes = new Map();
  /**
   * 目标级自愈：**必须在锁内调**。
   * 失败不记「已修」—— 以前失败也 add，等于宣布这个目标永远不用再修了（review 2026-11-04 P1）。
   * 只有明确 ok === false 才算失败：大多数 writer 的 repair 返回 undefined。
   */
  const maybeRepair = (target, writer) => {
    if (repairedTargets.has(target)) return;
    if (!writer?.repair) {
      repairedTargets.add(target);
      return;
    }
    try {
      const r = writer.repair(ctx, { account: opts.account ?? null });
      if (r && r.ok === false) return;
      repairedTargets.add(target);
    } catch {
      /* 自愈失败不阻断正常导入；写入仍会做格式校验 */
    }
  };
  // 目标可能没有任何待写 pair（全是 skip 或本次没有源会话），但历史导入行仍可能让宿主的
  // 会话列表 500 —— 这些目标没有可进锁的 pair，只能在这里自愈一次（没有锁可持，也就无从重试）。
  // 有 pair 的目标一律留给锁内的 maybeRepair，避免「锁外修 + 失败也标记已修」再回来。
  const targetsWithPairs = new Set(plan.pairs.map((p) => p.target));
  for (const t of plan.targets ?? []) {
    if (targetsWithPairs.has(t.variant)) continue;
    const writer = getWriter(t.variant);
    if (!writer?.repair) continue;
    try {
      const r = writer.repair(ctx, { account: opts.account ?? null });
      if (r && r.ok === false) continue;
      repairedTargets.add(t.variant);
    } catch {
      /* 自愈失败不阻断导入 */
    }
  }

  for (const p of plan.pairs) {
    if (p.action === 'error') {
      results.push({ ...p, executed: false });
      continue;
    }
    const writer = getWriter(p.target);

    // D1：目标已归档 → 只当「存在」用。不 append、不 relocate、不改注册表
    if (p.targetSummary?.archived === true) {
      results.push({ ...p, action: 'skip', reason: 'target-archived', executed: false });
      continue;
    }

    // 批内被折叠的 pair：正主那条会自己自愈，这里再动一遍就是抢在正主之前写索引/搬文件
    if (p.duplicateOf) {
      results.push({ ...p, action: 'skip', reason: 'duplicate-in-batch', executed: false });
      continue;
    }

    if (!writer) {
      results.push({ ...p, executed: false, ok: false, error: 'writer-not-implemented' });
      continue;
    }

    // 目标级锁：挡住我们自己并发写同一 agent。
    // skip 也要拿锁 —— 它不是只读：relocate 会 unlink 旧文件、ensureIndex 写 sqlite、
    // drift 整份重写正文（review 2026-11-04 的 P0-1：宿主并发追加的轮次被抹掉）。
    let lk = null;
    if (lock) {
      lk = acquireLock(`target:${p.target}`, { timeoutMs: lockTimeoutMs });
      if (!lk.ok) {
        if (p.action === 'skip') {
          // 自愈没做成不等于导入失败：正文本来就没变，只是这次没机会搬/改名
          results.push({
            ...p,
            executed: false,
            ok: true,
            warnings: ['lock-timeout: 未做落点/索引/标题自愈（下次重跑再试）'],
            holder: lk.holder,
            waitedMs: lk.waitedMs,
          });
          continue;
        }
        results.push({ ...p, executed: false, ok: false, error: 'lock-timeout', holder: lk.holder, waitedMs: lk.waitedMs });
        continue;
      }
    }

    try {
      maybeRepair(p.target, writer);

      // ---- 锁内重校验：宿主可能在我们 plan 之后写了新内容 ----
      // 目标索引同样必须在锁内取，且**只要这次拿锁碰过别人的痕迹就整份重建**：
      // 缓存里只有我们自己 addToIndex 的写入，看不见另一个进程（或宿主）刚建出来的同 id 会话，
      // 拿旧索引会把「该 append」判成「该 create」，留下两份重复会话。
      // 锁没竞争时沿用缓存（同一进程内后续 pair 靠 addToIndex 保持新鲜），避免每条都全库重扫。
      if (lk?.contended) freshIndexes.delete(p.target);
      if (!freshIndexes.has(p.target)) freshIndexes.set(p.target, targetIndexFor(p.target, ctx));
      const freshIdx = freshIndexes.get(p.target);

      // ---- skip：内容没变，但落点/索引/标题仍可能需要自愈 ----
      // 锁内定位到的摘要优先（plan 期那份可能已经过时：另一个进程刚搬过、刚改过名）
      if (p.action === 'skip') {
        const summary = freshIdx.summaryById.get(String(p.targetId)) ?? p.targetSummary ?? null;
        results.push(applySkipSelfHeal({ p, writer, ctx, summary, reason: p.reason ?? 'skip', freshIdx }));
        continue;
      }

      const srcRead = readSession(p.sourceVariant, ctx, p.sourceId);
      if (!srcRead.ok || !srcRead.session) {
        results.push({ ...p, executed: false, ok: false, error: srcRead.error ?? 'source-not-readable' });
        continue;
      }
      const sourceSession = srcRead.session;

      const fresh = resolveDecision(p.target, sourceSession, freshIdx, (v, id) => readSession(v, ctx, id));
      const { targetSession: dstSession, ...freshRest } = fresh;
      if (fresh.action === 'skip') {
        // 元数据漂移：源侧只改了标题（内容没变 → 指纹相同 → 判 identical），
        // 目标侧标题却还停在导入那一刻的旧名。skip 本身是对的（正文没变，不该重写），
        // 但标题是元数据，必须单独同步 —— 否则「在源宿主改了名再复跑」永远看不到新名。
        const titleDrift = TITLE_ONLY_REASONS.has(fresh.reason)
          ? syncTitleIfChanged({
              writer,
              ctx,
              target: p.target,
              targetId: fresh.targetId ?? p.targetId,
              sourceTitle: sourceSession.title,
              targetTitle: dstSession?.title ?? null,
              targetSession: dstSession ?? null,
            })
          : null;
        results.push({
          ...p,
          ...freshRest,
          executed: false,
          reason: fresh.reason ?? 'revalidated-skip',
          ...(titleDrift?.changed ? { titleSynced: true, title: sourceSession.title } : {}),
          ...(titleDrift?.skipped ? { titleSkipped: titleDrift.skipped } : {}),
          ...(titleDrift?.warnings?.length ? { warnings: titleDrift.warnings } : {}),
        });
        continue;
      }
      // 重校验可能把 create 变成 append（宿主刚写入了同一会话）
      const action = fresh.action;
      const targetId = fresh.targetId;
      const mode = action === 'fork' ? 'fork' : action === 'append' ? 'append' : 'create';

      // 落点以锁内重算为准（fork 会换 targetId，generated 桶的目录是按 targetId 派生的）
      const place = annotatePlacement(placementFor({ source: sourceSession, target: p.target, ctx, opts, action, dstSession, targetId }));
      // 原生会话 append 必须保持原生：剥离 provenance；追加行沿用目标既有 cwd/scope/account，不写落点
      const appendToNative = action === 'append' && dstSession && !dstSession.origin;
      // provenance 里记下本次落点与「源的原始目录」：迁移过的会话之后既不按新目录猜分类（规则 4），
      // 也能按原项目名搜到（--project 的 origin-dir 匹配就吃这个字段）
      const provenance = appendToNative ? null : buildProvenance(sourceSession, undefined, { directory: place.directory, scope: place.scope, from: sourceSession.cwd });

      // D4：宿主结构上没有非项目落点且用户没给 --cwd → 跳过这一条（不是失败），一个文件都不写
      if (place.source === 'requires-cwd' && !place.directory) {
        results.push({ ...p, ...freshRest, executed: false, status: 'skipped', reason: 'requires-cwd', hint: place.hint, placement: place });
        continue;
      }
      // 写侧采纳门：与 plan 阶段同一份结论（placementFor 重算后要重新挂门）——探测档根没被
      // --data-root 点名就不写，宁可跳过也不把正文写进 marker 判出来的目录或宿主从没出现过的位置
      const gate = place.writeGate ?? writeGate(p.target, ctx);
      if (!gate.ok) {
        results.push({ ...p, ...freshRest, executed: false, status: 'skipped', reason: gate.reason ?? 'write-root-unpinned', hint: gate.paste ?? null, placement: place });
        continue;
      }

      // placed 副本：writer 全部只读 session.cwd，所以改这一处就等于所有 writer 的落点跟着走。
      // 原生目标 append 不改落点（用目标现有 cwd/scope/account，那是用户自己的归属）；
      // 导入目标 append 保持既有语义：落点变化时按新落点搬迁 + 追加。
      const placedSession = { ...sourceSession, cwd: place.directory, scope: place.scope };
      if (appendToNative) {
        if (dstSession.cwd) placedSession.cwd = dstSession.cwd;
        if (dstSession.scope) placedSession.scope = dstSession.scope;
        placedSession.account = dstSession.account ?? null;
      } else {
        // 归属只可能是「显式 --account」；源会话那一行的账号属于来源侧，不带进副本
        placedSession.account = place.account ?? null;
      }

      let written;
      try {
        written = writer.write(ctx, {
          session: placedSession,
          targetId,
          mode,
          fromTurnIndex: action === 'append' ? fresh.at : 0,
          provenance,
          force,
          account: place.account ?? null,
          scope: place.scope,
          title: action === 'fork' ? tagTitle(sourceSession.title, provenance) : sourceSession.title,
        });
      } catch (err) {
        results.push({ ...p, ...freshRest, executed: true, ok: false, error: String(err?.message ?? err), placement: place });
        continue;
      }
      if (!written?.ok) {
        results.push({ ...p, ...freshRest, executed: true, ok: false, error: written?.error ?? 'write-failed', path: written?.path, hint: written?.hint, placement: place });
        continue;
      }

      // 正文写完后补一次标题同步。append 的正文写入**不再顺手写标题**（那会让标题有两个
      // 写入口：写入路径与 syncTitle 各一套，且绕过 guard），所以「源侧改了名 + 同时有新轮次」
      // 这条路径必须在这里补，否则改名永远同步不过去。
      // create / fork 不用补：新会话的标题是写入时一起落的，读回来必然相等（函数内部会早退）。
      const titleSync = mode === 'append'
        ? syncTitleIfChanged({
            writer,
            ctx,
            target: p.target,
            targetId,
            sourceTitle: sourceSession.title,
            targetTitle: dstSession?.title ?? null,
          })
        : null;

      // 写成功后把这条会话并回锁内索引：同批次后续 pair 必须看得见它（否则会把刚写的再判一次）
      addToIndex(freshIdx, {
        id: targetId,
        variant: p.target,
        title: sourceSession.title,
        cwd: placedSession.cwd,
        scope: placedSession.scope ?? place.scope ?? null,
        createdAt: sourceSession.createdAt,
        updatedAt: sourceSession.updatedAt,
        turns: sourceSession.turns.length,
        provenance: provenance ? { origin: provenance.origin } : null,
        archived: false,
        account: placedSession.account ?? null,
      });

      let verify = null;
      try {
        verify = verifyImported({
          readSession: (variant, id) => readSession(variant, ctx, id).session,
          variant: p.target,
          sessionId: targetId,
          expectSource: sourceSession,
          mode,
        });
      } catch (err) {
        verify = { ok: false, reason: String(err?.message ?? err) };
      }

      results.push({
        ...p,
        ...freshRest,
        executed: true,
        ok: true,
        path: written.path,
        lines: written.lines,
        backup: written.backup,
        warnings: [...(written.warnings ?? []), ...(place.warnings ?? []), ...(titleSync?.warnings ?? [])],
        ...(titleSync?.changed ? { titleSynced: true, title: sourceSession.title } : {}),
        ...(titleSync?.skipped ? { titleSkipped: titleSync.skipped } : {}),
        index: written.index,
        concurrentRetries: written.concurrentRetries,
        placement: place,
        verify,
      });
    } finally {
      lk?.release();
    }
  }
  return results;
}

export function summarizeResults(results) {
  const s = {};
  for (const r of results) {
    const k = r.status === 'skipped' ? `skipped:${r.reason}` : r.executed ? (r.ok ? `written:${r.action}` : 'write-failed') : r.action;
    s[k] = (s[k] ?? 0) + 1;
  }
  const verifyFailed = results.filter((r) => r.executed && r.ok && r.verify && !r.verify.ok).length;
  if (verifyFailed) s['verify-failed'] = verifyFailed;
  return s;
}
