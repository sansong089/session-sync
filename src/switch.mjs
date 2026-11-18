// switch.mjs — 把一条已存在的会话换到另一个账号（按 id 点名，独立于导入编排）
//
// 为什么不挂在 import 的 skip 自愈上：那条路径的触发条件是「落点目录变了」（import.mjs 里只比 cmpPath），
// 账号变了而内容/目录没变时它判 skip；在那里加「账号也触发」会一次改动 18 个 writer 的行为，
// 还会把「导入」与「改归属」两件事的授权口径混在一起。这里复用同一批原语（writer / lock / reader 回读），
// 但语义单独成立：必须 --id 点名、默认 dry-run、写前备份、宿主原生行逐条审计。
//
// 身份不变量：账号与目录一样，绝不参与「是不是同一条会话」，所以切换保持同一 targetId。
import { listSessions } from './readers/index.mjs';
import { getWriter } from './writers/index.mjs';
import { accountModelOf, PARTITION } from './accounts.mjs';
import { accountIdOf } from './placement.mjs';
import { acquireLock } from './lock.mjs';

/** 目标账号对象：写侧统一收 {variant,id,name,accountId}，codex 还要 accountId，别在这里丢字段 */
function targetAccountOf(variant, raw, known = []) {
  const id = accountIdOf(raw ? { id: raw } : null) ?? (raw ? String(raw) : null);
  if (!id) return null;
  const hit = known.find((a) => String(a.id) === id || String(a.accountId ?? '') === id);
  return { variant, id: hit ? String(hit.id) : id, name: hit?.name ?? null, accountId: hit?.accountId ?? null };
}

/**
 * 计划阶段（只读）。不可切的宿主在这里就给出**带证据的原因**，不留「静默没干活」的解读空间。
 */
export function planSwitch(ctx, { variant, ids = [], account = null, ide = null, cwd = null } = {}) {
  const model = accountModelOf(variant);
  const target = accountIdOf(account ? { id: account } : null) ?? (account ? String(account) : null);
  const plan = {
    variant,
    accountModel: model.kind,
    evidence: model.evidence,
    fields: model.fields ?? null,
    projectScoped: !!model.projectScoped,
    hint: model.hint ?? null,
    supported: model.kind === PARTITION,
    targetAccount: target,
    items: [],
    notes: [],
  };
  if (!target) {
    plan.fatal = 'account-required: 必须用 --account <uid> 指明目标账号（可切的 uid 用 accounts 命令查）';
    return plan;
  }
  if (!plan.supported) {
    plan.fatal = `switch-unsupported: ${variant} 的账号模型是 ${model.kind} —— ${model.evidence}${model.hint ? `｜替代路径：${model.hint}` : ''}`;
    return plan;
  }
  const writer = getWriter(variant);
  if (!writer) {
    plan.fatal = `writer-not-implemented: ${variant} 没有写侧实现`;
    return plan;
  }
  if (typeof writer.switchAccount !== 'function') {
    plan.fatal = `switch-not-implemented: ${variant} 的 writer 没有 switchAccount`;
    return plan;
  }
  const can = writer.canWrite?.(ctx) ?? { ok: true };
  if (can.ok === false) {
    plan.fatal = `cannot-write: ${can.reason}`;
    return plan;
  }

  // 账号候选：用于把 --account 传的裸 id 补齐成该宿主真正认得的账号对象（codex 需要 accountId）
  let known = [];
  const acc = typeof writer.listAccounts === 'function' ? writer.listAccounts(ctx) : null;
  if (acc?.ok) known = acc.accounts ?? [];
  else if (acc?.error) plan.notes.push(`list-accounts: ${acc.error}`);
  const accountTarget = targetAccountOf(variant, target, known);

  const r = listSessions(variant, ctx, {});
  const byId = new Map((r.sessions ?? []).map((s) => [String(s.id), s]));
  for (const id of ids.map(String)) {
    const s = byId.get(id);
    const item = {
      variant,
      id,
      title: s?.title ?? '',
      cwd: s?.cwd ?? '',
      scope: s?.scope ?? null,
      fromAccount: s?.account?.id ?? s?.account ?? null,
      toAccount: accountTarget.id,
      imported: !!s?.provenance,
      copies: s?.copies ?? null,
      action: 'switch',
      projectCreated: null,
      warnings: [],
    };
    if (!s) {
      item.action = 'error';
      item.error = 'not-found: 该变体的列表里没有这条会话（id 写错 / 被过滤条件挡掉 / 宿主已删除）';
      plan.items.push(item);
      continue;
    }
    if (String(item.fromAccount ?? '') === String(accountTarget.id) && !plan.projectScoped) {
      item.action = 'already';
      item.warnings.push('already-target-account: 现归属就是目标账号，未做任何改动');
      plan.items.push(item);
      continue;
    }
    if (typeof writer.switchPreview === 'function') {
      try {
        const pv = writer.switchPreview(ctx, { targetId: id, account: accountTarget, ide, directory: cwd });
        if (pv.ok) {
          item.action = pv.action === 'already' ? 'already' : 'switch';
          item.projectCreated = pv.projectCreated ?? null;
          item.directory = pv.directory ?? item.cwd;
          item.fromAccount = pv.sourceAccount ?? item.fromAccount;
          item.warnings.push(...(pv.warnings ?? []));
        } else {
          item.action = pv.action === 'not-found' ? 'error' : 'refused';
          item.error = pv.error;
          item.warnings.push(...(pv.warnings ?? []));
        }
      } catch (err) {
        item.warnings.push(`preview-failed: ${String(err?.message ?? err)}`);
      }
    }
    plan.items.push(item);
  }
  plan.accountTarget = accountTarget;
  return plan;
}

/**
 * 执行阶段。apply=false 时只回计划（dry-run）。
 * 每个变体一次锁（`target:<变体>`），与导入共用同一把锁，避免两边同时改同一宿主。
 */
export function executeSwitch(ctx, plan, { apply = false, force = false, onlyImported = false, keepSource = false, lock = true, lockTimeoutMs = 30000 } = {}) {
  if (plan.fatal) return [{ variant: plan.variant, fatal: true, executed: false, ok: false, error: plan.fatal }];
  if (!apply) {
    return plan.items.map((p) => ({ ...p, executed: false, dryRun: true }));
  }
  const writer = getWriter(plan.variant);
  const account = plan.accountTarget ?? { variant: plan.variant, id: plan.targetAccount };
  let lk = null;
  if (lock) {
    lk = acquireLock(`target:${plan.variant}`, { timeoutMs: lockTimeoutMs });
    if (!lk.ok) return plan.items.map((p) => ({ ...p, executed: false, ok: false, error: 'lock-timeout', holder: lk.holder, waitedMs: lk.waitedMs }));
  }
  const results = [];
  try {
    for (const p of plan.items) {
      if (p.action === 'error') {
        results.push({ ...p, executed: false, ok: false, error: p.error });
        continue;
      }
      if (p.action === 'already') {
        results.push({ ...p, executed: false, ok: true });
        continue;
      }
      // 计划期的 refused 只是「预告」：真正能不能过（比如给了 --force 覆盖分叉副本）由写侧在同一条解析里判，
      // 否则 dry-run 的拒绝会被烤进计划里，--force 也传不进去。
      let res;
      try {
        res = writer.switchAccount(ctx, { targetId: p.id, account, directory: p.directory ?? null, force, onlyImported, keepSource });
      } catch (err) {
        results.push({ ...p, executed: true, ok: false, error: String(err?.message ?? err) });
        continue;
      }
      const warnings = [...(p.warnings ?? []), ...(res?.warnings ?? [])].filter((w, i, a) => a.indexOf(w) === i);
      if (!res?.ok) {
        results.push({ ...p, ...res, executed: true, ok: false, error: res?.error ?? 'switch-failed', warnings, backup: res?.backup ?? null });
        continue;
      }
      // 回读校验：归属必须真的变成目标账号（dry-run 说的和落盘做的同一口径）
      const after = listSessions(plan.variant, ctx, {}).sessions?.find((s) => String(s.id) === p.id);
      const landed = after?.account?.id ?? after?.account ?? null;
      const verified = plan.projectScoped ? res.action === 'moved' || res.action === 'already' : String(landed ?? '') === String(account.id);
      results.push({
        ...p,
        ...res,
        executed: true,
        ok: true,
        warnings,
        verify: { ok: verified, from: p.fromAccount, to: account.id, readBack: landed, copies: after?.copies?.length ?? null },
      });
    }
  } finally {
    lk?.release();
  }
  return results;
}

export function summarizeSwitch(results) {
  const s = {};
  for (const r of results) {
    const k = r.executed ? (r.ok ? `switched:${r.action}` : 'switch-failed') : r.dryRun ? 'planned' : r.action;
    s[k] = (s[k] ?? 0) + 1;
    if (r.executed && r.ok && r.verify && r.verify.ok === false) s['verify-failed'] = (s['verify-failed'] ?? 0) + 1;
  }
  return s;
}
