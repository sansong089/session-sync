// placement.mjs — 落点模型的唯一策略出口（两个纯函数，不碰文件系统、不读时间）
//
// 硬要求（用户补充）：目录 / scope / account 只决定「写到哪、宿主能不能把它列成非项目会话」，
// 绝不参与「是不是同一条会话」。身份由 identity.mjs 的 originKey + 轮次指纹唯一决定，
// 所以改落点只会移动同一 targetId，不会生成新会话。
//
// 三种桶形态（逐家实测，见 references/落点表）：
//   generated  每会话一个互不重叠的子目录（codex / workbuddy / minimax / mimo）
//   shared     所有非项目会话共用一个固定目录（zcode / dsh / opencode）→ 搬迁只改归属字段，绝不 move 目录
//   none       宿主结构上没有非项目落点（claude / codebuddy / codebuddy-ide / pi / cursor / antigravity / cline / kilo / roo / freebuff）
//              → 按 D4：不兜底、不造目录，标 requires-cwd 让调用方补 --cwd
import path from 'node:path';
import { makeCtx, ALL_VARIANTS, locatorOf } from './hosts.mjs';
import { resolveRoot } from './roots.mjs';
import { cmpPath } from './util.mjs';

const seg = (...parts) => path.join(...parts);

/** 桶根的唯一取法：resolver 的声明结果（认 env、认 known-folder 校验状态） */
function bucketOf(variant, ctx) {
  return resolveRoot(variant, ctx).bucketRoot?.path ?? null;
}

function bucketValidated(variant, ctx) {
  const b = resolveRoot(variant, ctx).bucketRoot;
  return b ? b.validated !== false : true;
}

// ---- 表 1：宿主自管根（规则 1，全局按前缀匹配，不按变体区分调用方）----
// 命中即 scope:'none' 的硬保证：这些目录是宿主自己给「无项目会话」生成的工作区，
// 把任何会话（不论哪个变体读到的）挂在这里都绝不能再被当成项目，否则会出现幽灵项目目录。
export function INTERNAL_ROOTS(ctx = makeCtx()) {
  const c = ctx || makeCtx();
  // 一条都不再手拼：宿主自管根全部来自各家的 locator 声明（桶根 + internal 补充）。
  // 手拼的话根被 env 搬走或文档目录重定向，这里就认不出宿主自己的目录 → 非项目会话被误判成项目。
  const out = [];
  for (const variant of ALL_VARIANTS) {
    const bucket = resolveRoot(variant, c).bucketRoot;
    const name = variant.replace(/-(cn|intl)$/, '');
    // 「桶 = 整个 home」的形态（opencode：宿主把 home 当共享桶）不能进这张表 ——
    // 它是前缀匹配的根，会把 home 下每一个项目目录都误判成非项目会话。
    // 该家的非项目判定本来就走库内信号（project_id='global'），不需要目录前缀。
    if (bucket?.path && cmpPath(bucket.path) !== cmpPath(c.home)) out.push({ variant: name, path: bucket.path });
    for (const extra of locatorOf(variant).internal?.(c) ?? []) {
      if (cmpPath(extra) !== cmpPath(c.home)) out.push({ variant: name, path: extra });
    }
  }
  return out.filter((x) => x.path);
}

// ---- 表 2：各根内的具体形态（只用于给出分类理由，不参与判定）----
export const INTERNAL_PATH_PATTERNS = {
  codex: /\/documents\/codex\/\d{4}-\d{2}-\d{2}\/[^/]+$/,
  qoder: /\/documents\/qoder(?:cn)?\/\d{4}-\d{2}-\d{2}\/[^/]+$/,
  workbuddy: /\/workbuddy(?: ai)?\/(?:\d{8}|\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}-task-\d+|automation-\d{14}|claw)$/,
  minimax: /\/\.minimax\/sessions\/[^/]+\/workspace$/,
  dsh: /\/documents\/deepseek-harness\/default-workspace$/,
  zcode: /\/(?:\.zcode\/workspace|zcodeproject)(?:\/[^/]+)?$/,
  mimo: /\/xiaomimimoprojects\//,
};

function shapeOf(variant, cwd) {
  const re = INTERNAL_PATH_PATTERNS[String(variant).toLowerCase().replace(/-(cn|intl)$/, '')];
  return re && re.test(cmpPath(cwd)) ? 'shape' : 'prefix';
}

/** cwd 命中的宿主自管根；返回 {variant, path} | null */
export function matchInternalRoot(cwd, ctx) {
  const n = cmpPath(cwd);
  if (!n) return null;
  for (const r of INTERNAL_ROOTS(ctx)) {
    const root = cmpPath(r.path);
    if (n === root || n.startsWith(`${root}/`)) return { ...r, shape: shapeOf(r.variant, n) };
  }
  return null;
}

// ---- 表 3：目标宿主的非项目桶 ----

/**
 * 账户归属降成标量 id 的**唯一**出口。
 * IR 里 account 是会话属性 `{variant, id, name?, orgId?}`（--account 给的是裸字符串），
 * 而各家库里要写的是一列 id。以前各处自己 `String(account)`，对象就变成了 "[object Object]"：
 * 宿主的列表谓词是 `user_id = 当前登录 uid`，挂上这种值等于把会话写进没人能看见的桶里，还不报错。
 * 所以：placement 继续原样带着对象（不许在这里丢字段，codex 还要用 accountId），
 * 由各 writer 在写那一列之前调用本函数取值；取不到就当作「没有可用账户」。
 * @returns {string|null}
 */
export function accountIdOf(account) {
  if (!account) return null;
  if (typeof account === 'string' || typeof account === 'number') return String(account) || null;
  const id = account.id ?? account.uid ?? account.accountId ?? null;
  return id === null || id === undefined || id === '' ? null : String(id);
}

// targetId → 文件系统安全的自铸 slug（宿主桶内叶子名复刻不了：它取首条用户消息转写 + 同日计数器）
function targetSlug(id) {
  const s = String(id ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (s || 'session').slice(0, 60);
}

function msOf(session) {
  const n = Number(session?.createdAt) > 0 ? Number(session.createdAt) : Number(session?.updatedAt) > 0 ? Number(session.updatedAt) : 0;
  return n;
}

// 日期一律由源会话派生（绝不能用「今天」，否则每次重跑都换目录 → 旧文件变孤儿 + append 写残）
function ymd(session, warnings) {
  const ms = msOf(session);
  if (!ms) {
    warnings.push('missing-created-at: 落点日期取 epoch 以保证确定性');
    return '1970-01-01';
  }
  return new Date(ms).toISOString().slice(0, 10);
}
function ymdParts(session, warnings) {
  return ymd(session, warnings).split('-');
}

// hyphen6：WorkBuddy 现行代际叶子名 2026-10-08-18-38-21（实测 34 条，2026-07 起）
function hyphen6(session, warnings) {
  const ms = msOf(session);
  if (!ms) {
    warnings.push('missing-created-at: 桶内叶子名取 epoch 以保证确定性');
  }
  return (ms ? new Date(ms).toISOString() : new Date(0).toISOString()).slice(0, 19).replace('T', '-').replace(/:/g, '-');
}

export const NON_PROJECT_BUCKET = {
  opencode: { kind: 'shared', root: (c) => bucketOf('opencode', c) },
  claude: { kind: 'none' },
  codebuddy: { kind: 'none' },
  'codebuddy-ide': { kind: 'none' },
  pi: { kind: 'none' },
  antigravity: { kind: 'none' },
  cursor: { kind: 'none' },
  cline: { kind: 'none' },
  kilo: { kind: 'none' },
  roo: { kind: 'none' },
  freebuff: { kind: 'none' },
  doubao: { kind: 'none' },
  codex: {
    kind: 'generated',
    root: (c) => bucketOf('codex', c),
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, ymd(session, warnings), targetSlug(targetId)),
  },
  'workbuddy-cn': {
    kind: 'generated',
    root: (c) => bucketOf('workbuddy-cn', c),
    // 同代际 leaf 可被宿主复用（实测同名最多 11 次），所以不带 targetId 也是宿主形态
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, hyphen6(session, warnings)),
  },
  'workbuddy-intl': {
    kind: 'generated',
    root: (c) => bucketOf('workbuddy-intl', c),
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, hyphen6(session, warnings)),
  },
  minimax: {
    kind: 'generated',
    root: (c) => bucketOf('minimax', c),
    // 实测宿主按 session_id 建目录，不含日期层
    dirFor: (targetId, session, ctx, root) => seg(root, targetSlug(targetId), 'workspace'),
  },
  mimo: {
    kind: 'generated',
    root: (c) => bucketOf('mimo', c),
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, '.mimo-sessions', ...ymdParts(session, warnings), targetSlug(targetId)),
  },
  dsh: { kind: 'shared', root: (c) => bucketOf('dsh', c) },
  zcode: { kind: 'shared', root: (c) => bucketOf('zcode', c) },
  // 双桶根实测：intl `~/Documents/Qoder/<日期>/<12hex>`（现网 25/30 是 12 hex，其余 8 字符），
  // cn `~/Documents/QoderCN/<日期>/<chat-N>`。宿主叶子是它自己按天铸的计数器，复刻不了也保证不了唯一，
  // 所以取 targetId 前 12 位：确定性、同 id 恒定复现，形态与宿主一致（宿主只认目录里有没有它的会话行）
  'qoder-cn': {
    kind: 'generated',
    root: (c) => bucketOf('qoder-cn', c),
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, ymd(session, warnings), targetSlug(targetId).slice(0, 12)),
  },
  'qoder-intl': {
    kind: 'generated',
    root: (c) => bucketOf('qoder-intl', c),
    dirFor: (targetId, session, ctx, root, warnings) => seg(root, ymd(session, warnings), targetSlug(targetId).slice(0, 12)),
  },
};

/**
 * 源会话分类：project / none。
 * 优先级：宿主自管根（规则 1 硬保证）> provenance.placed（规则 4，迁移过的会话不按新目录猜）
 * > reader 显式信号 > 空 cwd > 项目目录。
 */
export function classifySource(session, ctx = makeCtx()) {
  const cwd = String(session?.cwd ?? '').trim();
  const hit = matchInternalRoot(cwd, ctx);
  if (hit) return { scope: 'none', reason: `internal-root:${hit.variant}:${hit.shape}`, root: hit.path };
  const placed = session?.placed?.scope ?? session?.provenance?.placed?.scope ?? null;
  if (placed === 'none' || placed === 'project') return { scope: placed, reason: 'placed' };
  const reader = session?.scope;
  if (reader === 'none' || reader === 'project') return { scope: reader, reason: 'reader' };
  if (!cwd) return { scope: 'none', reason: 'empty-cwd' };
  return { scope: 'project', reason: 'project-dir' };
}

/**
 * 唯一落点出口。
 * @param sourceSession 源会话 IR
 * @param target        目标变体名
 * @param ctx           makeCtx() 产物（只用 home，不用 cwd —— 执行导入的当前目录不得影响落点）
 * @param opts          { cwd, placement:'auto'|'project'|'bucket'|'cwd', account, targetId }
 * @returns {scope, directory|null, source, account, warnings[], hint?}
 */
export function resolvePlacement(sourceSession, target, ctx = makeCtx(), opts = {}) {
  const c = ctx || makeCtx();
  const warnings = [];
  // 归属只认显式 --account。源会话的 account 属于**来源宿主那一侧**：跨 agent 导入时它是另一个
  // 命名空间的 id（codex 的 user-xxxx、workbuddy 的 uid、qoder 上一代库的 user_id），
  // 钉进目标宿主的归属列等于把会话放进宿主列表谓词永远不匹配的桶里，而且不报错。
  // 「省略时用目标宿主当前登录账号」是各 writer 的 defaults（accounts.mjs 的 currentAccount），
  // 不在这里做 —— 本函数是纯函数，读不了宿主的登录态。
  const account = opts.account ?? null;
  const srcCwd = String(sourceSession?.cwd ?? '');
  const mode = opts.placement || 'auto';

  if (mode === 'cwd') {
    const directory = opts.cwd ? String(opts.cwd) : srcCwd;
    return { scope: classifySource(sourceSession, c).scope, directory: directory || null, source: 'flag:cwd', account, warnings };
  }
  if (mode === 'project') {
    if (!srcCwd) warnings.push('placement=project 但源会话没有 cwd，落点为空目录');
    return { scope: 'project', directory: srcCwd, source: 'project-dir', account, warnings };
  }

  const scope = classifySource(sourceSession, c).scope;
  if (scope === 'project' && mode !== 'bucket') {
    return { scope: 'project', directory: srcCwd, source: 'project-dir', account, warnings };
  }

  const bucket = NON_PROJECT_BUCKET[target] || { kind: 'none' };
  // 桶根落在「文档」这类已知文件夹里、而这一层没被证实过（注册表取不到、宿主也从未在那儿生成目录）：
  // 不建目录、不改判项目，按 requires-cwd 交回用户点名 —— 与「宿主没有非项目落点」同一道纪律。
  if (bucket.kind !== 'none' && !bucketValidated(target, c)) {
    if (opts.cwd) return { scope: 'none', directory: String(opts.cwd), source: 'flag:cwd', account, warnings };
    warnings.push(`documents-unvalidated: ${target} 的桶根建在未经证实的已知文件夹里（${resolveRoot(target, c).bucketRoot?.documentsSource ?? 'unknown'}）`);
    return { scope: 'none', directory: null, source: 'requires-cwd', account, warnings, hint: `需要 --cwd <目录>（${target} 的非项目桶根没能证实，不凭空建目录）` };
  }
  if (bucket.kind === 'none') {
    // D4：宿主结构上没有非项目落点 → 交用户决定，绝不造宿主永不打开的孤儿目录
    if (opts.cwd) {
      return { scope: 'none', directory: String(opts.cwd), source: 'flag:cwd', account, warnings };
    }
    return { scope: 'none', directory: null, source: 'requires-cwd', account, warnings, hint: `需要 --cwd <目录>（${target} 的宿主没有非项目会话落点）` };
  }

  const root = bucket.root(c);
  if (bucket.kind === 'shared') {
    return { scope: 'none', directory: root, source: 'bucket:shared', account, warnings };
  }
  let targetId = opts.targetId;
  if (!targetId) {
    warnings.push('generated-bucket-without-target-id: 退回源会话 id 派生目录');
    targetId = sourceSession?.id;
  }
  const directory = bucket.dirFor(String(targetId), sourceSession, c, root, warnings);
  return { scope: 'none', directory, source: 'bucket:generated', account, warnings };
}
