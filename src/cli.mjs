// cli.mjs — 命令行入口：selftest/list/status/import/verify/install/uninstall
//
// 退出码：0 成功 / 1 用法或环境错误 / 2 数据写入错误 / 3 无变化跳过
import path from 'node:path';
import { ALL_VARIANTS, VARIANTS, makeCtx, detectHost, entryChain } from './hosts.mjs';
import { runSelftest } from './selftest.mjs';
import { parseTimeSpec, parseUntilSpec, baseNameOf } from './util.mjs';
import { listSessions, readSession, getReader } from './readers/index.mjs';
import { planImport, executePlan, summarizeResults } from './import.mjs';
import { WRITABLE_VARIANTS, hasWriter, getWriter } from './writers/index.mjs';
import { describeAccounts } from './accounts.mjs';
import { planSwitch, executeSwitch } from './switch.mjs';
import { verifyImported } from './verify.mjs';
import { installSkill, uninstallSkill } from './installer.mjs';
import { parseDataRoots, rootSummary, resolveRoot, detectInstalled, probeStats } from './roots.mjs';

export const EXIT = { OK: 0, USAGE: 1, WRITE: 2, NOOP: 3 };

/**
 * 未指定 `--into` 时的默认目标：只采纳「唯一锁定」的当前宿主。
 * ambiguous（同族多版本判不出）/ unknown 一律留空，由调用方显式点名 ——
 * 这里的默认值会直接决定写进哪个安装，猜一个的代价是写进另一版的数据目录，事后无从发现。
 */
function hostTargets(host) {
  if (host.state !== 'identified' || !host.variant) return [];
  return [host.variant];
}

/** 默认目标为空时告诉用户为什么，而不是只说一句 usage。 */
function hostHint(host) {
  if (host.state === 'ambiguous') {
    const cands = host.candidates?.length ? `，候选 ${host.candidates.join(' / ')}` : '';
    return `当前宿主判不出是哪个变体（命中 ${host.evidence}${cands}），请显式用 --into 指定`;
  }
  if (host.state === 'unknown') return `当前宿主没有可用的身份信号${host.chain?.length ? `（已走过 ${host.chain.length} 层祖先进程，没匹配到任何已登记宿主）` : ''}，请显式用 --into 指定；判不出时本工具不挑「最近被改动的那个」写`;
  return null;
}

/** detect/status/import 共用的宿主行：终态与证据必须一起显示，否则「unknown」会被读成「没装」。 */
function hostLine(host) {
  const hint = host.state === 'ambiguous' ? `  候选 ${(host.candidates ?? []).join(' / ') || '-'}` : host.hint ? `  （活动度，非身份，勿当 --into）最近被改动的是 ${host.hint}` : '';
  return `${host.variant ?? `(${host.state})`}${host.sessionId ? `  session: ${host.sessionId}` : ''}  [${host.state} / ${host.confidence}]  ${host.evidence}${hint}`;
}

function out(obj, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
    return;
  }
  // 文本模式原先只认 message → 所有用法错误都变成「静默 exit 1」，用户看不到原因
  const msg = obj.message ?? obj.error;
  if (msg) process.stdout.write(`${msg}\n`);
  if (Array.isArray(obj.known)) process.stdout.write(`可用: ${obj.known.join(', ')}\n`);
  if (Array.isArray(obj.invalid)) process.stdout.write(`不合法: ${obj.invalid.join(', ')}\n`);
  if (!msg && !obj.known && !obj.invalid) process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateVariants(list, flag) {
  const bad = list.filter((v) => !VARIANTS[v]);
  if (bad.length > 0) {
    return { ok: false, error: `未知 agent 变体: ${bad.join(', ')}（${flag}）`, known: ALL_VARIANTS };
  }
  return { ok: true };
}

// 每条命令的 ctx 都从这里出：--data-root <变体>=<目录> 是最高优先级的落点钉住，
// 不传就是纯环境解析。放在构造点而不是各命令里，是为了「同一条命令里读到和写到同一个 ctx」。
function ctxFromArgs(args) {
  let parsed;
  try {
    parsed = parseDataRoots(getFlag(args, 'data-root'));
  } catch (err) {
    throw new Error(String(err?.message ?? err));
  }
  return makeCtx({ dataRoots: parsed });
}

// 从 argv 提取 --flag value 或 --flag=value
function getFlag(args, name) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${name}`) return args[i + 1] ?? '';
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

// 各子命令真正读取的开关。拼错的开关必须报错：静默忽略会让「本想只导一条」变成整库写入。
const FLAGS = {
  selftest: [],
  detect: ['data-root', 'trace-entry'],
  accounts: ['into', 'data-root', 'trace-entry'],
  list: ['from', 'since', 'until', 'project', 'limit', 'id', 'include-empty', 'data-root'],
  show: ['from', 'data-root'],
  status: ['from', 'into', 'since', 'until', 'project', 'limit', 'id', 'include-subagents', 'include-empty', 'include-degraded', 'data-root', 'trace-entry'],
  import: ['from', 'into', 'since', 'until', 'project', 'limit', 'id', 'include-subagents', 'include-empty', 'include-degraded', 'cwd', 'account', 'placement', 'apply', 'dry-run', 'force', 'no-lock', 'lock-timeout', 'data-root', 'trace-entry', 'allow-family-duplicate'],
  'switch-account': ['into', 'id', 'account', 'ide', 'cwd', 'keep-source', 'only-imported', 'apply', 'dry-run', 'force', 'no-lock', 'lock-timeout', 'data-root', 'trace-entry'],
  verify: ['into', 'expect', 'mode', 'strict', 'data-root', 'trace-entry'],
  // install / uninstall 也会调 ctxFromArgs（那里读 --data-root），白名单漏了它就会
  // 「实现认这个参数、校验说它是未知参数」；uninstall 同样要 cwd —— Freebuff 的
  // 薄封装写在 <cwd>/.agents 下，不给 cwd 就删不到安装时写的那个文件
  install: ['host', 'root', 'cwd', 'dry-run', 'force', 'no-shared', 'no-bridge', 'data-root'],
  uninstall: ['host', 'root', 'cwd', 'dry-run', 'purge', 'data-root'],
  // 这两个命令没有任何参数。不显式登记的话 unknownFlags 会因为「没有白名单」直接放行，
  // `help --force` 就成了静默接受 —— 拼错的开关至少要报一声
  help: [],
  version: [],
};

// 返回 null 表示通过；否则返回用法错误对象（未知开关 + 该命令的合法开关清单）
/**
 * 重复 flag 一律按用法错误处理。
 *
 * 原来只有「取第一个出现的值」这一条规则，于 `--into a --into b` 会**静默**只导 a，
 * 用户以为两条都导了。带值 flag 重复几乎总是笔误或拼接脚本拼错，宁可拒绝执行。
 * 布尔 flag（--apply/--force…）重复本身无害，但同样报错更好排查 —— 规则简单才不会漏。
 */
function duplicateFlag(cmd, args) {
  const seen = new Set();
  const dup = [];
  for (const a of args) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (seen.has(name)) {
      if (!dup.includes(`--${name}`)) dup.push(`--${name}`);
      continue;
    }
    seen.add(name);
  }
  if (dup.length === 0) return null;
  return { ok: false, error: `${cmd}: 参数重复出现 ${dup.join(', ')}（同一个参数只接受一次）`, invalid: dup };
}

function unknownFlags(cmd, args) {
  const allowed = FLAGS[cmd];
  // 没登记白名单 = 这个命令不接受任何 --flag（help/version）。原来这里直接 return null
  // 放行，等于「没登记的命令什么开关都收」，拼错也看不出
  if (!allowed) {
    const bad = args.filter((a) => a.startsWith('--') && a.slice(2).split('=')[0] !== 'json').map((a) => a.split('=')[0]);
    if (!bad.length) return null;
    return { ok: false, error: `未知参数: ${bad.join(', ')}（${cmd} 不接受参数）`, invalid: bad, known: [] };
  }
  const bad = [];
  for (const a of args) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (name === 'json') continue;
    if (!allowed.includes(name)) bad.push(`--${name}`);
  }
  if (bad.length === 0) return null;
  return {
    ok: false,
    error: `未知参数: ${bad.join(', ')}（${cmd} 可用: ${['json', ...allowed].map((f) => `--${f}`).join(' ')}）`,
    invalid: bad,
    known: allowed.map((f) => `--${f}`),
  };
}

function cmdSelftest(args, asJson) {
  const result = runSelftest();
  if (!asJson) {
    for (const c of result.checks) {
      const mark = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL';
      process.stdout.write(`[${mark}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`);
    }
    process.stdout.write(`summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail\n`);
  } else {
    out(result, true);
  }
  return result.ok ? EXIT.OK : EXIT.USAGE;
}

// 解析 --from / --into。省略 --from 时默认 = 全部变体（未安装的变体自然返回 0 条）；
// --from auto / installed = 只取本机探测到数据的变体。
function resolveFromList(args, flag = 'from') {
  const raw = parseList(getFlag(args, flag));
  if (raw.length === 0) return { list: ALL_VARIANTS.slice(), defaulted: true };
  const joined = raw.join(',').toLowerCase();
  if (joined === 'auto' || joined === 'installed' || joined === 'all-installed') {
    return { list: detectInstalled(ctxFromArgs(args)), defaulted: false, auto: true };
  }
  if (joined === 'all' || joined === 'any') {
    return { list: ALL_VARIANTS.slice(), defaulted: true };
  }
  return { list: raw, defaulted: false };
}

/** 展示用的项目名：reader 给了宿主协议名就用它；非项目会话固定文案；其余退回目录名 */
function projectDisplayOf(s) {
  if (s.scope === 'none') return '非项目会话';
  const named = String(s.projectName ?? '').trim();
  return named || baseNameOf(s.cwd) || '-';
}

function cmdList(args, asJson) {
  const from = resolveFromList(args).list;
  const check = validateVariants(from, '--from');
  if (!check.ok) {
    out({ ok: false, ...check }, asJson);
    return EXIT.USAGE;
  }
  let opts;
  try {
    opts = {
      since: parseTimeSpec(getFlag(args, 'since')),
      until: parseUntilSpec(getFlag(args, 'until')),
      project: getFlag(args, 'project'),
      limit: Number(getFlag(args, 'limit')) || 0,
      ids: parseList(getFlag(args, 'id')),
      includeEmpty: args.includes('--include-empty'),
    };
  } catch (err) {
    out({ ok: false, error: String(err.message) }, asJson);
    return EXIT.USAGE;
  }

  const ctx = ctxFromArgs(args);
  const results = [];
  const errors = [];
  const sessions = [];
  for (const v of from) {
    const r = listSessions(v, ctx, opts);
    if (!r.ok) errors.push({ variant: v, error: r.error });
    results.push({ variant: v, available: r.available ?? false, count: r.sessions.length, conflicts: r.conflicts ?? [] });
    for (const s of r.sessions) {
      s.variant = v;
      sessions.push(s);
    }
  }
  // --id：先核对再导。id 的名单按会话原生 id 算，缺失的明确报出来（不静默跑空）
  const wantIds = opts.ids ?? [];
  const matchedById = wantIds.length > 0 ? sessions.filter((s) => wantIds.includes(String(s.id))) : sessions;
  const missingIds = wantIds.filter((id) => !matchedById.some((s) => String(s.id) === id));
  // 0 轮的会话默认不列（与 import 的默认口径一致；采样得到的 0 不可信，不据此丢弃）
  const shown = opts.includeEmpty ? matchedById : matchedById.filter((s) => !(s.turns === 0 && !s.turnsApprox));
  // 表格里的 per-variant 计数跟过滤走：名称是「列出了几条」，不能和下面的行数自相矛盾
  for (const r of results) r.count = shown.filter((s) => s.variant === r.variant).length;
  shown.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const limited = opts.limit > 0 ? shown.slice(0, opts.limit) : shown;

  if (asJson) {
    out({
      ok: errors.length === 0,
      command: 'list',
      variants: results,
      errors,
      conflicts: results.flatMap((r) => (r.conflicts ?? []).map((c) => ({ ...c, variant: r.variant }))),
      missingIds,
      sessions: limited.map((s) => ({
        variant: s.variant,
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        projectName: projectDisplayOf(s),
        scope: s.scope ?? null,
        scopeReason: s.scopeReason ?? null,
        account: s.account ?? null,
        copies: s.copies?.map((c) => ({ account: c.account?.id ?? null, ide: c.ide, ws: c.ws, messageCount: c.messageCount })) ?? null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turns: s.turns,
        // 采样得到的轮数是近似值（dsh 读到截断、minimax 走采样）：不透出的话
        // 调用方会把「0 轮」当成真的空会话，而它其实只是没读完
        turnsApprox: !!s.turnsApprox,
        // 迁移落点记账：只迁过一次的会话，解释「它为什么在这个项目下」全靠这两个字段
        placed: s.placed ? { directory: s.placed.directory ?? null, scope: s.placed.scope ?? null, from: s.placed.from ?? null } : null,
        imported: !!s.provenance,
        origin: s.provenance?.origin ?? null,
        degraded: s.degraded ?? null,
        archived: !!s.archived,
        matchedBy: s.matchedBy ?? null,
        source: s.source ?? null,
      })),
    }, true);
    return errors.length > 0 ? EXIT.USAGE : EXIT.OK;
  }

  for (const r of results) {
    process.stdout.write(`${r.variant}: ${r.available ? `${r.count} sessions` : 'not available'}\n`);
  }
  for (const e of errors) process.stdout.write(`  ! ${e.variant}: ${e.error}\n`);
  for (const r of results) {
    for (const c of r.conflicts ?? []) {
      process.stdout.write(`  ! ${r.variant}: 同 id ${c.id} 但 origin 不同（${c.origins.join(', ')}）—— 保留 ${c.kept ?? '-'}，未采用 ${c.dropped.join(', ') || '-'}\n`);
    }
  }
  if (limited.length === 0) {
    if (missingIds.length > 0) process.stdout.write(`(no sessions) 指定但未找到: ${missingIds.join(', ')}\n`);
    else process.stdout.write('(no sessions)\n');
    return EXIT.OK;
  }
  if (missingIds.length > 0) process.stdout.write(`指定但未找到: ${missingIds.join(', ')}\n`);
  process.stdout.write('\n');
  for (const s of limited) {
    const when = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '-';
    const tag = s.provenance ? `[${s.provenance.origin.variant}]` : '';
    const arch = s.archived ? '[archived]' : '';
    const deg = s.degraded ? ' (degraded)' : '';
    const scopeTag = `[${s.scope || 'project'}]`;
    const acctTag = s.account?.id ? `[acct ${String(s.account.id).slice(0, 12)}]` : '';
    // --project 命中哪个字段（cwd / placed / origin-dir）直接打在行上，迁移过的会话才解释得清
    const matchTag = s.matchedBy ? `[match:${s.matchedBy}]` : '';
    // 所属项目：只显示项目名（宿主项目协议里的名字），非项目会话固定文案；完整路径仍在 JSON 的 cwd
    const proj = projectDisplayOf(s);
    process.stdout.write(`${when}  ${s.variant.padEnd(14)} ${(s.title || '').slice(0, 48).padEnd(50)} ${proj.slice(0, 24).padEnd(26)} ${String(s.id).slice(0, 36).padEnd(38)} ${(s.turnsApprox?String(s.turns)+String.fromCharCode(126):String(s.turns)).padStart(3)} 轮${scopeTag}${acctTag}${matchTag}${tag}${arch}${deg}\n`);
  }
  return EXIT.OK;
}

function cmdShow(args, asJson) {
  const from = getFlag(args, 'from');
  const id = args.find((a) => !a.startsWith('--') && a !== from);
  const check = validateVariants(from ? [from] : [], '--from');
  if (!check.ok) {
    out({ ok: false, ...check }, asJson);
    return EXIT.USAGE;
  }
  if (!from || !id) {
    out({ ok: false, error: 'usage: show --from <variant> <sessionId> [--json]' }, asJson);
    return EXIT.USAGE;
  }
  const ctx = ctxFromArgs(args);
  const r = readSession(from, ctx, id);
  if (!r.ok) {
    out({ ok: false, error: r.error, variant: from, id }, asJson);
    return EXIT.USAGE;
  }
  if (!r.session) {
    out({ ok: false, error: 'session-not-found', variant: from, id }, asJson);
    return EXIT.USAGE;
  }
  const s = r.session;
  if (asJson) {
    out({
      ok: true,
      command: 'show',
      variant: s.variant,
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      scope: s.scope ?? null,
      scopeReason: s.scopeReason ?? null,
      account: s.account ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      // show 是完整读（不是 list 的采样扫描），轮数必然精确；字段保留只为与 list 对齐
      turnsApprox: !!s.turnsApprox,
      placed: s.placed ? { directory: s.placed.directory ?? null, scope: s.placed.scope ?? null, from: s.placed.from ?? null } : null,
      model: s.model,
      origin: s.origin,
      chain: s.chain,
      turns: s.turns.map((t) => ({
        index: t.index,
        role: t.role,
        items: t.items.map((i) => ({ kind: i.kind, text: i.text?.slice(0, 200), name: i.name, key: i.key, value: i.value, ...(i.compact ? { compact: true } : {}) })),
      })),
      meta: s.meta,
    }, true);
    return EXIT.OK;
  }
  process.stdout.write(`${s.variant} ${s.id}\n`);
  process.stdout.write(`title: ${s.title}\ncwd: ${s.cwd}\nscope: ${s.scope ?? 'project'}${s.scopeReason ? ` (${s.scopeReason})` : ''}\naccount: ${s.account?.id ?? '-'}${s.account?.accountId ? ` / ${s.account.accountId}` : ''}\nmodel: ${s.model ?? '-'}\nturns: ${s.turns.length}\n`);
  if (s.origin) process.stdout.write(`origin: ${s.origin.variant}:${s.origin.sessionId} (chain ${s.chain.length})\n`);
  process.stdout.write('\n');
  for (const t of s.turns.slice(0, 6)) {
    process.stdout.write(`--- turn ${t.index} [${t.role}]\n`);
    for (const i of t.items.slice(0, 8)) {
      const body = i.kind === 'message' ? (i.text || '').replace(/\s+/g, ' ').slice(0, 120)
        : i.kind === 'reasoning' ? `(reasoning) ${(i.text || '').replace(/\s+/g, ' ').slice(0, 100)}`
        : i.kind === 'tool_call' ? `(tool_call) ${i.name} ${JSON.stringify(i.input).slice(0, 100)}`
        : i.kind === 'tool_result' ? `(tool_result) ${i.name} ${String(i.output).replace(/\s+/g, ' ').slice(0, 80)}`
        : i.kind === 'meta' ? `(meta) ${i.key}=${JSON.stringify(i.value).slice(0, 80)}`
        : i.kind === 'attachment' ? `(attachment) ${i.ref}`
        : `(note) ${i.text}`;
      process.stdout.write(`  ${body}\n`);
    }
    if (t.items.length > 8) process.stdout.write(`  ... +${t.items.length - 8} items\n`);
  }
  if (s.turns.length > 6) process.stdout.write(`... +${s.turns.length - 6} turns\n`);
  return EXIT.OK;
}

function cmdStatus(args, asJson) {
  const from = resolveFromList(args).list;
  const intoRaw = parseList(getFlag(args, 'into'));
  for (const [flag, list] of [['from', from], ['into', intoRaw]]) {
    const check = validateVariants(list, `--${flag}`);
    if (!check.ok) {
      out({ ok: false, ...check }, asJson);
      return EXIT.USAGE;
    }
  }
  const ctx = ctxFromArgs(args);
  const host = detectHost(ctx, { entry: true });
  const into = intoRaw.length > 0 ? intoRaw : hostTargets(host);
  if (from.length === 0 || into.length === 0) {
    const why = hostHint(host);
    out({ ok: false, error: `usage: status [--from <variant,...|auto>] [--into <variant,...>] [--since 7d] [--project substr] [--limit N]   （--from 省略 = 全部变体）${why ? `\n${why}` : ''}`, host }, asJson);
    return EXIT.USAGE;
  }
  let opts;
  try {
    opts = {
      from,
      into,
      since: parseTimeSpec(getFlag(args, 'since')),
      until: parseUntilSpec(getFlag(args, 'until')),
      project: getFlag(args, 'project'),
      limit: Number(getFlag(args, 'limit')) || 0,
      ids: parseList(getFlag(args, 'id')),
      includeSubagents: args.includes('--include-subagents'),
      includeEmpty: args.includes('--include-empty'),
      includeDegraded: args.includes('--include-degraded'),
    };
  } catch (err) {
    out({ ok: false, error: String(err.message) }, asJson);
    return EXIT.USAGE;
  }

  const plan = planImport(ctx, opts);
  if (asJson) {
    // errors 非空却报 ok:true，会让调用方把「有源读不出来」当成一切正常
    out({ ok: !(plan.errors ?? []).length, command: 'status', host, targets: plan.targets, summary: plan.summary, errors: plan.errors, pairs: plan.pairs }, true);
    return EXIT.OK;
  }
  process.stdout.write(`host: ${hostLine(host)}\n`);
  process.stdout.write(`plan: ${plan.sources} sources → ${plan.targets.map((t) => t.variant).join(', ')}\n`);
  process.stdout.write(`actions: ${formatSummary(plan.summary)}\n`);
  for (const e of plan.errors) process.stdout.write(`  ! ${e.variant} [${e.phase}] ${e.error}\n`);
  process.stdout.write('\n');
  const rows = plan.pairs.filter((p) => p.action !== 'skip').slice(0, 30);
  if (rows.length === 0) process.stdout.write('(no changes)\n');
  for (const p of rows) printPair(p);
  const hidden = plan.pairs.filter((p) => p.action !== 'skip').length - rows.length;
  if (hidden > 0) process.stdout.write(`... +${hidden} more\n`);
  return EXIT.OK;
}

function formatSummary(summary) {
  const order = ['create', 'append', 'fork', 'skip', 'error'];
  const parts = order.filter((k) => summary[k]).map((k) => `${k} ${summary[k]}`);
  for (const k of Object.keys(summary)) if (!order.includes(k)) parts.push(`${k} ${summary[k]}`);
  return parts.length ? parts.join('  ') : 'none';
}

function printPair(p) {
  const tag = p.action.padEnd(7);
  const src = `${p.sourceVariant}:${p.sourceId}`.slice(0, 44).padEnd(46);
  const extra = p.reason ? ` (${p.reason})` : '';
  process.stdout.write(`${tag} ${src} → ${p.target}:${String(p.targetId).slice(0, 36)}${extra}\n`);
}

/**
 * import 的退出码（脚本靠它判成败，不能混）：
 *   2 WRITE —— 有写入失败，或有写入成功但校验没过（verify-failed 同样是「数据可能不对」）
 *   3 NOOP  —— --apply 了却一条都没写成（全是 skip / error / 被规则挡住）
 *   0 OK    —— 其余
 * dry-run 一律 0：它本来就没打算写，把「没写」报成 NOOP 会让 --dry-run 的探测脚本误判。
 */
function importExitCode(results, apply) {
  const failed = results.some((r) => r.executed && (!r.ok || (r.verify && r.verify.ok === false)));
  if (failed) return EXIT.WRITE;
  if (!apply) return EXIT.OK;
  const wrote = results.some((r) => r.executed && r.ok);
  return wrote ? EXIT.OK : EXIT.NOOP;
}

function importOk(results) {
  return !results.some((r) => r.executed && (!r.ok || (r.verify && r.verify.ok === false)));
}

function cmdImport(args, asJson) {
  const from = resolveFromList(args).list;
  const intoRaw = parseList(getFlag(args, 'into'));
  for (const [flag, list] of [['from', from], ['into', intoRaw]]) {
    const check = validateVariants(list, `--${flag}`);
    if (!check.ok) {
      out({ ok: false, ...check }, asJson);
      return EXIT.USAGE;
    }
  }
  const ctx = ctxFromArgs(args);
  const host = detectHost(ctx, { entry: true });
  const into = intoRaw.length > 0 ? intoRaw : hostTargets(host);
  if (from.length === 0 || into.length === 0) {
    const why = hostHint(host);
    out({ ok: false, error: `usage: import [--from <variant,...|auto>] [--into <variant,...>] [--since 7d] [--apply] [--dry-run]   （--from 省略 = 全部变体）${why ? `\n${why}` : ''}`, host }, asJson);
    return EXIT.USAGE;
  }

  const unwritable = into.filter((v) => !hasWriter(v));
  if (unwritable.length > 0) {
    out({ ok: false, error: `目标暂不可写: ${unwritable.join(', ')}`, writable: WRITABLE_VARIANTS }, asJson);
    return EXIT.USAGE;
  }

  let opts;
  try {
    opts = {
      from,
      into,
      since: parseTimeSpec(getFlag(args, 'since')),
      until: parseUntilSpec(getFlag(args, 'until')),
      project: getFlag(args, 'project'),
      limit: Number(getFlag(args, 'limit')) || 0,
      ids: parseList(getFlag(args, 'id')),
      includeSubagents: args.includes('--include-subagents'),
      includeEmpty: args.includes('--include-empty'),
      includeDegraded: args.includes('--include-degraded'),
      cwd: getFlag(args, 'cwd') || undefined,
      account: getFlag(args, 'account') || undefined,
      allowFamilyDuplicate: args.includes('--allow-family-duplicate'),
      placement: (() => {
        const p = getFlag(args, 'placement') || 'auto';
        if (!['auto', 'project', 'bucket', 'cwd'].includes(p)) throw new Error(`--placement 只接受 auto|project|bucket|cwd，收到: ${p}`);
        return p;
      })(),
    };
  } catch (err) {
    out({ ok: false, error: String(err.message) }, asJson);
    return EXIT.USAGE;
  }

  const apply = args.includes('--apply') && !args.includes('--dry-run');
  const force = args.includes('--force');
  const lock = !args.includes('--no-lock');
  const lockTimeoutMs = Number(getFlag(args, 'lock-timeout')) || 30000;
  const plan = planImport(ctx, opts);
  const results = executePlan(ctx, plan, { apply, force, lock, lockTimeoutMs });
  const summary = summarizeResults(results);

  if (asJson) {
    out({ ok: importOk(results), command: 'import', apply, host, targets: plan.targets, summary, errors: plan.errors, conflicts: plan.conflicts ?? [], sourceDuplicates: plan.sourceDuplicates ?? [], timeUnknownSkipped: plan.timeUnknownSkipped ?? 0, degradedSkipped: plan.degradedSkipped ?? 0, missingIds: plan.missingIds ?? [], results }, true);
    return importExitCode(results, apply);
  }

  process.stdout.write(`host: ${hostLine(host)}\n`);
  process.stdout.write(`${apply ? 'import' : 'dry-run'}: ${formatSummary(summary)}\n`);
  for (const e of plan.errors) process.stdout.write(`  ! ${e.variant} [${e.phase}] ${e.error}\n`);
  for (const c of plan.conflicts ?? []) {
    process.stdout.write(`  ! ${c.variant}[${c.from}]: 同 id ${c.id} 但 origin 不同（${c.origins.join(', ')}）—— 保留 ${c.kept ?? '-'}，未采用 ${c.dropped.join(', ') || '-'}\n`);
  }
  for (const d of plan.sourceDuplicates ?? []) {
    process.stdout.write(`  - 同源副本折叠：${d.dropped.variant}:${String(d.dropped.id).slice(0, 20)} ⊂ ${d.kept.variant}:${String(d.kept.id).slice(0, 20)}（内容被保留者覆盖）\n`);
  }
  if (plan.timeUnknownSkipped > 0) process.stdout.write(`  - 无时间戳、被时间范围排除：${plan.timeUnknownSkipped} 条\n`);
  if ((plan.missingIds ?? []).length > 0) process.stdout.write(`  - 指定但未找到：${plan.missingIds.join(', ')}\n`);

  // 落点逐条打印：导入前必须能看见「这条会被当成项目会话还是非项目会话、落到哪个目录」
  for (const r of results) {
    const p = r.placement;
    if (!p) continue;
    process.stdout.write(`  ${String(r.sourceVariant)}:${String(r.sourceId)} → ${p.scope ?? '-'} → ${p.directory ?? '(待定)'} [${p.source}] → ${r.target}:${String(r.targetId).slice(0, 28)}\n`);
  }

  const pending = results.filter((r) => r.status === 'skipped' && r.reason === 'requires-cwd');
  if (pending.length) {
    process.stdout.write(`\n待用户指定目录（已跳过，给 --cwd 后重跑）：${pending.length} 条\n`);
    for (const r of pending) process.stdout.write(`  ${r.sourceVariant}:${r.sourceId} → ${r.target}  ${r.hint ?? ''}\n`);
  }

  const famDup = results.filter((r) => r.reason === 'edition-duplicate');
  if (famDup.length) {
    process.stdout.write(`
同族另一版已有同一来源（已中止，一个字节都没写）：${famDup.length} 条
`);
    for (const r of famDup) {
      const d = r.duplicateOfSibling ?? {};
      process.stdout.write(`  ${r.sourceVariant}:${r.sourceId} → ${r.target}：${d.variant} 已有 ${d.id}
`);
      process.stdout.write(`     那份在 ${d.path ?? '(路径未取到)'}  （${d.turns ?? '?'} 轮，更新于 ${d.updatedAt ? new Date(d.updatedAt).toISOString().slice(0, 16) : '?'}，${d.placement ?? '?'}）
`);
    }
    process.stdout.write(`  确认要在两版各留一份：加 --allow-family-duplicate；想接着另一版用：--into 指向那一版
`);
  }

  for (const r of results) {
    if (!r.executed && r.action === 'skip') continue;
    if (r.executed && r.ok) {
      const v = r.verify ? (r.verify.ok ? 'verified' : `VERIFY-FAIL(${r.verify.reason})`) : 'unverified';
      process.stdout.write(`  ok   ${r.sourceVariant}:${r.sourceId} → ${r.target}:${String(r.targetId).slice(0, 36)} [${r.action}] ${r.lines ?? 0} 行 ${v}\n`);
      for (const w of r.warnings ?? []) process.stdout.write(`       ! ${w}\n`);
    } else if (r.executed) {
      process.stdout.write(`  FAIL ${r.sourceVariant}:${r.sourceId} → ${r.target} [${r.action}] ${r.error}\n`);
    } else if (r.action === 'error') {
      process.stdout.write(`  ERR  ${r.sourceVariant}:${r.sourceId} → ${r.target} ${r.reason}\n`);
    }
  }
  if (!apply) process.stdout.write('(dry-run；加 --apply 实际写入)\n');
  if (results.length) {
    const projectCount = results.filter((r) => r.placement?.scope === 'project').length;
    process.stdout.write('\n可见性条件：\n');
    if (projectCount) {
      process.stdout.write(`  - 项目会话（${projectCount} 条）落在各自项目目录，要在该项目目录里启动宿主才能在其项目下看到\n`);
    }
    if (results.some((r) => r.placement?.scope === 'none')) {
      process.stdout.write('  - 非项目会话落在各家自己的桶目录里（这是宿主列得出它们的唯一前提）\n');
    }
    process.stdout.write('  - OpenCode 的列表默认只看当前目录，可按 ctrl+a 切「全部项目」（config.tabs?.scope 默认 "cwd"）\n');
  }
  return importExitCode(results, apply);
}

function cmdVerify(args, asJson) {
  const into = getFlag(args, 'into');
  const id = args.find((a) => !a.startsWith('--') && a !== into);
  const check = validateVariants(into ? [into] : [], '--into');
  if (!check.ok) {
    out({ ok: false, ...check }, asJson);
    return EXIT.USAGE;
  }
  if (!into || !id) {
    out({ ok: false, error: 'usage: verify --into <variant> <sessionId> [--expect <variant>:<sessionId>]' }, asJson);
    return EXIT.USAGE;
  }
  const ctx = ctxFromArgs(args);
  const r = readSession(into, ctx, id);
  if (!r.ok || !r.session) {
    out({ ok: false, error: r.error ?? 'session-not-found', variant: into, id }, asJson);
    return EXIT.USAGE;
  }
  const expectSpec = getFlag(args, 'expect');
  let expectSource = null;
  if (expectSpec) {
    const i = String(expectSpec).indexOf(':');
    if (i < 0) {
      out({ ok: false, error: '--expect 需为 <variant>:<sessionId>' }, asJson);
      return EXIT.USAGE;
    }
    const sv = String(expectSpec).slice(0, i);
    const sid = String(expectSpec).slice(i + 1);
    const sr = readSession(sv, ctx, sid);
    if (!sr.ok || !sr.session) {
      out({ ok: false, error: 'expect-source-not-found', variant: sv, id: sid }, asJson);
      return EXIT.USAGE;
    }
    expectSource = sr.session;
  }

  const res = verifyImported({
    readSession: (variant, sid) => readSession(variant, ctx, sid).session,
    variant: into,
    sessionId: id,
    expectSource,
    mode: getFlag(args, 'mode') ?? 'create',
    strict: args.includes('--strict'),
  });

  if (asJson) {
    out({ ok: res.ok, command: 'verify', ...res }, true);
    return res.ok ? EXIT.OK : EXIT.WRITE;
  }
  process.stdout.write(`${into}:${id}\n`);
  process.stdout.write(`turns: ${res.turns}  provenance: ${r.session.origin ? `${r.session.origin.variant}:${r.session.origin.sessionId}` : 'none'}\n`);
  if (res.reason) process.stdout.write(`result: ${res.ok ? 'ok' : 'FAIL'} (${res.reason})\n`);
  else process.stdout.write('result: ok\n');
  for (const m of res.mismatches.slice(0, 5)) process.stdout.write(`  turn ${m.index}: want ${String(m.want).slice(0, 12)} got ${String(m.got).slice(0, 12)}\n`);
  return res.ok ? EXIT.OK : EXIT.WRITE;
}

function cmdInstall(args, asJson) {
  const host = getFlag(args, 'host');
  if (host !== undefined) {
    const check = validateVariants(parseList(host), '--host');
    if (!check.ok) {
      out({ ok: false, ...check }, asJson);
      return EXIT.USAGE;
    }
  }
  const ctx = ctxFromArgs(args);
  let result;
  try {
    result = installSkill(ctx, {
      hosts: parseList(host),
      root: getFlag(args, 'root'),
      cwd: getFlag(args, 'cwd'),
      dryRun: args.includes('--dry-run'),
      force: args.includes('--force'),
      shared: !args.includes('--no-shared'),
      noBridge: args.includes('--no-bridge'),
    });
  } catch (err) {
    // 写失败原先是直接抛到顶层：JSON 模式下调用方连 JSON 都拿不到，只看到一段堆栈
    out({ ok: false, command: 'install', error: `install-failed: ${String(err?.message ?? err)}` }, asJson);
    return EXIT.WRITE;
  }
  if (asJson) {
    // ok 不再写死 true：安装可能只装了一半（见 installer 的 dangling 判定）
    out({ command: 'install', ...result }, true);
    return result.ok ? EXIT.OK : EXIT.WRITE;
  }
  process.stdout.write(`shared: ${result.sharedDir}\n`);
  process.stdout.write(`cli:    ${result.cli}\n\n`);
  for (const a of result.actions) {
    const tag = a.status.padEnd(14);
    const who = a.variant ? a.variant.padEnd(15) : a.kind.padEnd(15);
    process.stdout.write(`${tag} ${who} ${a.path}${a.note ? `  (${a.note})` : ''}\n`);
  }
  for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
  return EXIT.OK;
}

function cmdUninstall(args, asJson) {
  const host = getFlag(args, 'host');
  if (host !== undefined) {
    const check = validateVariants(parseList(host), '--host');
    if (!check.ok) {
      out({ ok: false, ...check }, asJson);
      return EXIT.USAGE;
    }
  }
  const ctx = ctxFromArgs(args);
  let result;
  try {
    result = uninstallSkill(ctx, {
      hosts: parseList(host),
      root: getFlag(args, 'root'),
      cwd: getFlag(args, 'cwd'),
      dryRun: args.includes('--dry-run'),
      purge: args.includes('--purge'),
    });
  } catch (err) {
    out({ ok: false, command: 'uninstall', error: `uninstall-failed: ${String(err?.message ?? err)}` }, asJson);
    return EXIT.WRITE;
  }
  if (asJson) {
    out({ command: 'uninstall', ...result }, true);
    return result.ok ? EXIT.OK : EXIT.WRITE;
  }
  for (const a of result.actions) {
    const tag = a.status.padEnd(14);
    const who = a.variant ? a.variant.padEnd(15) : a.kind.padEnd(15);
    process.stdout.write(`${tag} ${who} ${a.path}${a.note ? `  (${a.note})` : ''}\n`);
  }
  return EXIT.OK;
}

/** 账号发现：逐变体报告账号模型（partition / single-account / none）与本机实测到的账号 */
function cmdAccounts(args, asJson) {
  const intoRaw = parseList(getFlag(args, 'into'));
  const check = validateVariants(intoRaw, '--into');
  if (!check.ok) {
    out({ ok: false, ...check }, asJson);
    return EXIT.USAGE;
  }
  const ctx = ctxFromArgs(args);
  const variants = intoRaw.length > 0 ? intoRaw : detectInstalled(ctx);
  const rows = variants.map((v) => describeAccounts(v, ctx, { listSessions, getWriter }));
  if (asJson) {
    out({ ok: true, command: 'accounts', host: detectHost(ctx, { entry: true }), variants: rows }, true);
    return EXIT.OK;
  }
  process.stdout.write(`探测范围：${variants.length} 个变体${intoRaw.length ? '' : '（本机已安装）'}\n`);
  for (const r of rows) {
    process.stdout.write(`\n${r.variant}  [${r.accountModel}]\n`);
    if (r.current) process.stdout.write(`  当前登录：${r.current.id}${r.current.name ? ` (${r.current.name})` : ''} [${r.current.source ?? '实测'}]\n`);
    if (!r.accounts.length) process.stdout.write('  本机没有可见的账号分区/记录\n');
    for (const a of r.accounts) {
      const bits = [a.ide && `ide=${a.ide}`, a.conversations != null && `${a.conversations} 条会话`, a.sessions != null && `${a.sessions} 行`, a.threads != null && `${a.threads} 线程`, a.isCurrent && '当前登录'].filter(Boolean).join(' ');
      process.stdout.write(`  - ${String(a.id).slice(0, 40)}${a.name ? ` (${a.name})` : ''}${bits ? `  ${bits}` : ''}\n`);
      if (a.workspaceKeys?.length) process.stdout.write(`      该项目录下已挂载工作区 ${a.workspaceKeys.length} 个：${a.workspaceKeys.slice(0, 6).map((k) => k.slice(0, 8)).join(', ')}${a.workspaceKeys.length > 6 ? ' …' : ''}\n`);
    }
    for (const n of r.notes) process.stdout.write(`  ! ${n}\n`);
    if (r.accountModel !== 'partition') process.stdout.write(`  依据：${r.evidence}\n`);
  }
  process.stdout.write('\n可切账号（partition）：\n  ' + rows.filter((r) => r.accountModel === 'partition').map((r) => r.variant).join(', ') + '\n');
  return EXIT.OK;
}

/** 把已存在的会话换到另一个账号（按 id 点名；默认 dry-run） */
function cmdSwitchAccount(args, asJson) {
  const intoRaw = parseList(getFlag(args, 'into'));
  const check = validateVariants(intoRaw, '--into');
  if (!check.ok) {
    out({ ok: false, ...check }, asJson);
    return EXIT.USAGE;
  }
  const ctx = ctxFromArgs(args);
  const host = detectHost(ctx, { entry: true });
  const variants = intoRaw.length > 0 ? intoRaw : hostTargets(host);
  const ids = parseList(getFlag(args, 'id'));
  const account = getFlag(args, 'account');
  if (variants.length === 0) {
    const why = hostHint(host);
    out({ ok: false, error: `usage: switch-account --into <variant> --id <会话id,...> --account <目标uid> [--apply]   （--into 省略时用当前宿主）${why ? `\n${why}` : ''}`, host }, asJson);
    return EXIT.USAGE;
  }
  if (ids.length === 0) {
    // 不给 id 就等于一次改整库的归属，这个口子不放开
    out({ ok: false, error: 'switch-account 必须用 --id <会话id,...> 点名（批量改归属请逐条确认；可先用 list 查 id）' }, asJson);
    return EXIT.USAGE;
  }
  if (!account) {
    out({ ok: false, error: 'switch-account 必须用 --account <目标账号 uid> 指明去哪；可切的 uid 用 accounts 命令查' }, asJson);
    return EXIT.USAGE;
  }
  const apply = args.includes('--apply') && !args.includes('--dry-run');
  const opts = {
    account,
    ide: getFlag(args, 'ide') || null,
    cwd: getFlag(args, 'cwd') || null,
    apply,
    force: args.includes('--force'),
    keepSource: args.includes('--keep-source'),
    onlyImported: args.includes('--only-imported'),
    lock: !args.includes('--no-lock'),
    lockTimeoutMs: Number(getFlag(args, 'lock-timeout')) || 30000,
  };

  const plans = [];
  for (const v of variants) plans.push(planSwitch(ctx, { variant: v, ids, account: opts.account, ide: opts.ide, cwd: opts.cwd }));
  const results = plans.flatMap((plan) => executeSwitch(ctx, plan, { apply: opts.apply, force: opts.force, onlyImported: opts.onlyImported, keepSource: opts.keepSource, lock: opts.lock, lockTimeoutMs: opts.lockTimeoutMs }));
  const failed = results.filter((r) => r.executed && !r.ok).length + results.filter((r) => r.ok === false && !r.executed && !r.dryRun).length;
  // 与 import 同一口径：--apply 了却一条都没写成 → NOOP(3)。
  // 原来这里返回 0，脚本分不清「切完了」和「一条都没匹配上」。
  const switchExit = () => (failed > 0
    ? (apply ? EXIT.WRITE : EXIT.USAGE)
    : (apply && !results.some((r) => r.executed && r.ok) ? EXIT.NOOP : EXIT.OK));

  if (asJson) {
    out({
      ok: failed === 0,
      command: 'switch-account',
      apply,
      host,
      plans: plans.map((p) => ({ variant: p.variant, accountModel: p.accountModel, supported: p.supported, evidence: p.evidence, fields: p.fields, projectScoped: p.projectScoped, hint: p.hint, fatal: p.fatal ?? null, notes: p.notes, items: p.items })),
      results,
    }, true);
    return switchExit();
  }

  for (const p of plans) {
    const model = p.accountModel;
    process.stdout.write(`${p.variant} [账号模型 ${model}${p.projectScoped ? ' + 项目也按账号分区' : ''}] → 目标账号 ${p.targetAccount}\n`);
    if (p.fatal) process.stdout.write(`  不可切：${p.fatal}\n`);
    for (const n of p.notes ?? []) process.stdout.write(`  ! ${n}\n`);
  }
  for (const r of results) {
    if (r.fatal) continue;
    const tag = r.executed ? (r.ok ? 'ok  ' : 'FAIL') : r.dryRun ? '计划' : r.ok === false ? '拒绝' : '-- ';
    process.stdout.write(`  ${tag} ${r.variant}:${String(r.id).slice(0, 32)}  ${r.fromAccount ?? '(无归属)'} → ${r.toAccount}${r.projectCreated ? '  [会补 project]' : ''}${r.error ? `  ${r.error}` : ''}\n`);
    for (const w of r.warnings ?? []) process.stdout.write(`       ! ${w}\n`);
    if (r.verify) process.stdout.write(`       回读：${r.verify.ok ? '一致' : `不一致（读回 ${r.verify.readBack ?? '无'}）`}${r.verify.copies != null ? ` / 现存 ${r.verify.copies} 处` : ''}\n`);
    if (r.backup) process.stdout.write(`       备份：${r.backup}\n`);
  }
  if (!apply) process.stdout.write('(dry-run；加 --apply 实际改归属)\n');
  return switchExit();
}

function cmdDetect(args, asJson) {
  const ctx = ctxFromArgs(args);
  const installed = detectInstalled(ctx);
  const host = detectHost(ctx, { entry: true });
  const readers = installed.filter((v) => getReader(v));
  const writers = installed.filter((v) => hasWriter(v));
  if (asJson) {
    // probe：预算有没有烧光。烧光了「not installed」只代表没找到，不代表没装
    // --trace-entry 时链必须进 JSON：env 已定身份时 detectHost 不查链，而「现场到底是谁在调用我」
    // 恰恰要在有 env 的机器上看 —— 少这一行，豆包里的探针就只能报结论、报不出链。
    const traced = args.includes('--trace-entry') ? { chain: host.chain ?? entryChain(ctx) } : {};
    out({ ok: true, command: 'detect', installed, readers, writers, host, ...traced, home: ctx.home, platform: ctx.platform, probe: probeStats(ctx), roots: ALL_VARIANTS.map((v) => rootSummary(v, ctx)) }, true);
    return EXIT.OK;
  }
  process.stdout.write(`home: ${ctx.home}  platform: ${ctx.platform}\n`);
  process.stdout.write(`host: ${hostLine(host)}\n`);
  // --trace-entry：把祖先进程链与命中的判据如实打出来。宿主判不出时这是唯一的现场证据，
  // 也是「在豆包/WorkBuddy 里跑一次就能确认入口层到底认不认得出它」的探针（environment.md R7）。
  if (args.includes('--trace-entry')) {
    const chain = host.chain ?? entryChain(ctx);
    process.stdout.write(`entry: ${chain.length ? `祖先链 ${chain.length} 层` : '查不到链（没有入口证据，只能 unknown）'}\n`);
    for (const hop of chain) process.stdout.write(`  pid ${hop.pid}  ${hop.exe || '(无路径)'}\n`);
    process.stdout.write(`  命中判据: ${host.evidence}  [${host.state} / ${host.confidence}]\n`);
  }
  // 预算烧光时必须说出口：否则「没探到」会被读成「没装」
  const probe = probeStats(ctx);
  if (probe.truncated) {
    process.stdout.write(`probe: 预算耗尽（扫过 ${probe.visited} 个目录，上限 ${probe.maxDirs} 个 / ${probe.budgetMs}ms）—— 下面的 not installed 只代表没找到\n`);
  }
  process.stdout.write(`installed (${installed.length}): ${installed.join(', ') || '-'}\n`);
  process.stdout.write(`readable  (${readers.length}): ${readers.join(', ') || '-'}\n`);
  process.stdout.write(`writable  (${writers.length}): ${writers.join(', ') || '-'}\n`);
  // 装了不等于读得到：逐家给「用哪个根、哪一档、被拒几条候选」，否则「not installed」是无话可说
  for (const v of installed) {
    const s = rootSummary(v, ctx);
    process.stdout.write(`  ${s.line}\n`);
  }
  const missing = ALL_VARIANTS.filter((v) => !installed.includes(v));
  if (missing.length) process.stdout.write(`not installed: ${missing.join(', ')}\n`);
  return EXIT.OK;
}

const HELP = `session-sync — 通用 n:n coding agent 会话同步

用法:
  session-sync selftest [--json]                      环境与核心逻辑自检
  session-sync detect [--json]                        探测本机已安装 agent / 当前宿主
  session-sync accounts [--into a,b|auto] [--json]     列出各宿主的账号模型与本机实测到的账号（只读）
  session-sync list [--from a,b|auto] [--since 7d] [--until 2026-10-01]
         [--project substr] [--limit N] [--json]      列出源会话（--from 省略 = 全部变体）
  session-sync show --from <variant> <id> [--json]    查看单个会话（IR）
  session-sync status [--from a,b|auto] [--into c,d] [--since/--until/--project/--limit/--id]
         [--json]                                     只读预告（--from 省略 = 全部变体）
  session-sync import [--from a,b|auto] [--into c,d] [--since/--until/--project/--limit/--id]
         [--cwd <目录>] [--account <id>] [--placement auto|project|bucket|cwd]
         [--apply] [--dry-run] [--force] [--allow-family-duplicate]
         [--lock-timeout <ms>] [--no-lock] [--json]    导入（--from 省略 = 全部变体；默认 dry-run）
  session-sync verify --into X <id> [--expect a:id] [--mode create|fork] [--strict]
  session-sync switch-account --into <variant> --id <会话id,...> --account <目标uid>
         [--ide <CodeBuddyIDE|VSCode>] [--cwd <目录>] [--keep-source] [--only-imported]
         [--apply] [--dry-run] [--force] [--no-lock] [--lock-timeout <ms>] [--json]
                                                    把一条已存在的会话换到另一个账号（按 id 点名，默认 dry-run）
  session-sync install [--host a,b] [--dry-run] [--force] [--root PATH]
  session-sync uninstall [--purge]

--into 省略时按环境变量自动探测当前宿主（调用本 skill 的 agent 即目标）。
--from 省略时默认 = 全部变体（未安装的自动为 0 条）；--from auto = 只取本机已装变体。

并发：目标 agent 运行中可直接导入。每个(源,目标)在 target:<变体> 跨进程锁内写入，
拿到锁后重新读目标并重新判定，因此陈旧计划不会盲写。--no-lock 仅排障用。

支持的 agent 变体（20，含各变种）:
  ${ALL_VARIANTS.join(', ')}

可写目标（${WRITABLE_VARIANTS.length}）:
  ${WRITABLE_VARIANTS.join(', ')}

时间参数: 30m / 12h / 7d / 2w / 2026-10-01 / ISO 时间串
退出码: 0 成功 / 1 用法环境错 / 2 写入错 / 3 无变化跳过`;

export function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const cmd = args[0];
  const rest = args.slice(1);

  const bad = unknownFlags(cmd, rest);
  if (bad) {
    out(bad, asJson);
    return EXIT.USAGE;
  }
  const dup = duplicateFlag(cmd, rest);
  if (dup) {
    out(dup, asJson);
    return EXIT.USAGE;
  }

  switch (cmd) {
    case 'selftest':
      return cmdSelftest(args.slice(1), asJson);
    case 'detect':
      return cmdDetect(args.slice(1), asJson);
    case 'accounts':
      return cmdAccounts(args.slice(1), asJson);
    case 'switch-account':
      return cmdSwitchAccount(args.slice(1), asJson);
    case 'list':
      return cmdList(args.slice(1), asJson);
    case 'show':
      return cmdShow(args.slice(1), asJson);
    case 'status':
      return cmdStatus(args.slice(1), asJson);
    case 'import':
      return cmdImport(args.slice(1), asJson);
    case 'verify':
      return cmdVerify(args.slice(1), asJson);
    case 'install':
      return cmdInstall(args.slice(1), asJson);
    case 'uninstall':
      return cmdUninstall(args.slice(1), asJson);
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return EXIT.OK;
    case '--version':
    case 'version':
      process.stdout.write('0.1.0\n');
      return EXIT.OK;
    default:
      out({ ok: false, error: `未知命令: ${cmd}`, known: ['selftest', 'detect', 'accounts', 'list', 'show', 'status', 'import', 'switch-account', 'verify', 'install', 'uninstall', 'help'] }, asJson);
      return EXIT.USAGE;
  }
}
