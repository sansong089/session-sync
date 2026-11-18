// M55 测试：宿主根定位的唯一出口与结构棘轮
//
// 这一份存在的首要理由：「某变体的根在哪」在仓里曾有六套答案
// （VARIANTS.detect / 17 处 reader.available() / 写侧 variantDir 取 readPaths[0] / 各家重抄 env 链 /
// accounts 登录态手拼 ctx.home / BUCKET_ROOTS 与 INTERNAL_ROOTS 两张表只认 c.home）。
// 六套答案在「宿主把数据目录搬到别处」时不会一起搬，于是同一个宿主被读成两个安装、
// 或写进一个宿主永远不会打开的目录，而且不报错。
//
// 所以这里两类断言：
//   A. ROOT_ENV_KEYS 与真实代码双向对齐（登记了却没人用 = 假覆盖；能挪根却没登记 = 漏）；
//   B. 结构棘轮：白名单外的文件每新增一处自己拼宿主根就红，减一处必须同时下调白名单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_VARIANTS, VARIANTS, LOCATOR, ROOT_ENV_KEYS, makeCtx, configRoot } from '../src/hosts.mjs';
import { detectInstalled } from '../src/roots.mjs';
import { resolveRoot, parseDataRoots, invalidateRoots, rootSummary, TIER_RANK, WRITABLE_TIERS } from '../src/roots.mjs';
import { isDir, isFile } from '../src/util.mjs';

const SRC_ROOT = path.join(import.meta.dirname, '..', 'src');

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m55-${name}-`));
}

function ctxFor(root, env = {}, extra = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { ...env }, ...extra });
}

/** 给某个根变量造值：要过名称门（`.codebuddy` / `.workbuddy`），且与默认位置不同（否则「路径动没动」判不出来） */
function envValueFor(home, variant, key) {
  const base = path.join(home, 'env', key.toLowerCase());
  if (key === 'CODEBUDDY_CONFIG_DIR') return path.join(base, variant.startsWith('workbuddy') ? (variant.endsWith('intl') ? '.workbuddy-ai' : '.workbuddy') : '.codebuddy');
  if (key === 'WORKBUDDY_DATA_FOLDER_NAME') return variant.endsWith('intl') ? '.workbuddy-ai' : '.workbuddy';
  if (key.endsWith('_DB')) return path.join(base, 'main.sqlite');
  return base;
}

function readSrc(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 这些是「基准根」而不是某家的根，不参与登记表对齐 */
const BASE_ENV = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH', 'TMP', 'TEMP', 'TMPDIR', 'HGPLAIN', 'COMSPEC', 'SHELL', 'LANG', 'PWD', 'OLDPWD', 'ELECTRON_RUN_AS_NODE', 'SESSION_SYNC_LOCK_DIR', 'CODEBUDDY_SESSION_ID']);

/**
 * hosts.mjs 里 env 键有两种写法：直接读 `c.env.X`，或由根声明工厂带上
 * （`envRootOf(c, 'X_HOME', ...)`，把「路径 + 谁决定它」一次产出）。
 * 两种都要认 —— 只认同一种，收敛写法就会被当成「没读」而报假覆盖，逼人把 env 链抄回来。
 */
function envKeysUsedIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/\b(?:c|ctx)\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!BASE_ENV.has(m[1])) found.add(m[1]);
  }
  for (const m of text.matchAll(/\benvRootOf\(\s*(?:c|ctx)\s*,\s*'([A-Z][A-Z0-9_]*)'/g)) {
    if (!BASE_ENV.has(m[1])) found.add(m[1]);
  }
  return found;
}

function registeredKeys() {
  const all = new Map(); // key -> Set(variant)
  for (const [variant, groups] of Object.entries(ROOT_ENV_KEYS)) {
    for (const group of ['env', 'pin']) {
      for (const key of groups[group] ?? []) {
        if (!all.has(key)) all.set(key, new Set());
        all.get(key).add(variant);
      }
    }
  }
  return all;
}

// ---- A. 登记表与真实代码双向对齐 ----

test('ROOT_ENV_KEYS 覆盖全部变体，且每组只允许 env/pin 两个字段', () => {
  assert.deepEqual(Object.keys(ROOT_ENV_KEYS).sort(), [...ALL_VARIANTS].sort(), '每个变体都必须有登记（没有官方 env 也要写空数组，表示「只能靠探测或 --data-root」）');
  for (const [variant, groups] of Object.entries(ROOT_ENV_KEYS)) {
    assert.deepEqual(Object.keys(groups).sort(), Object.keys(groups).sort().filter((k) => k === 'env' || k === 'pin'), `${variant} 的登记只能含 env/pin`);
    for (const key of groups.env ?? []) assert.ok(!groups.pin?.includes(key), `${variant}: ${key} 不能同时是 env 和 pin`);
  }
});

test('hosts.mjs 里每个能挪根的环境变量都必须在 ROOT_ENV_KEYS 登记', () => {
  const used = envKeysUsedIn(readSrc(path.join(SRC_ROOT, 'hosts.mjs')));
  const registered = registeredKeys();
  const missing = [...used].filter((k) => !registered.has(k));
  assert.deepEqual(missing, [], `这些变量出现在路径解析里却没登记：${missing.join(', ')} —— 不登记就会让同一宿主被读成两个安装`);
});

test('ROOT_ENV_KEYS 登记的每个变量都真的被代码消费（拒绝假覆盖）', () => {
  const usedAcrossSrc = new Set();
  for (const file of srcFiles()) {
    for (const key of envKeysUsedIn(readSrc(file))) usedAcrossSrc.add(key);
  }
  const dead = [...registeredKeys().keys()].filter((k) => !usedAcrossSrc.has(k));
  assert.deepEqual(dead, [], `登记了但没有任何代码读取：${dead.join(', ')} —— 表写Full了不等于能生效`);
});

// ---- B. 结构棘轮：唯一出口之外不许再长出第二套答案 ----

// 「session-sync 自己的目录」不是宿主根，允许直接拼（备份根、锁目录、共享 skills 根、展示用打印）
const OUR_ROOT_EXEMPT = [
  { file: 'lock.mjs', re: /SESSION_SYNC_LOCK_DIR|os\.tmpdir|tmpdir\(/ },
  { file: path.join('writers', 'base.mjs'), re: /\.session-sync/ },
  { file: path.join('writers', 'codebuddy-ide.mjs'), re: /\.session-sync/ },
  { file: 'cli.mjs', re: /home: |command: 'detect'/ },
  // 与 home 比较相等性（「桶根是不是整个 home」的排除规则），不是在拼宿主根
  { file: 'placement.mjs', re: /cmpPath\(c\.home\)/ },
  { file: path.join('writers', 'opencode.mjs'), re: /HGPLAIN/ },
];

// 待迁移的债：文件 → {命中数, 为什么还留着}。只能变小，不能变大，且每条都要写明理由。
// 存量债清空后，这里应当保持空表：任何一行新命中都必须先登记理由才能合入。
const HOST_ROOT_DEBT = {
  [path.join('readers', 'codebuddy-ide.mjs')]: { n: 1, why: '扫的是 appData 下「别的 IDE 的兄弟目录」而不是本变体的根，portable 候选接入时一并声明化' },
};

const HOST_ROOT_RE = /\b(?:c|ctx)\.(home|appData|localAppData|xdgData|xdgConfig)\b|HOME\(c,/g;

function srcFiles(dir = SRC_ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(f, out);
    else if (e.name.endsWith('.mjs')) out.push(f);
  }
  return out;
}

function hostRootHits(file) {
  const rel = path.relative(SRC_ROOT, file);
  // hosts.mjs 是声明处（bases 的默认值必然要拼基准根）、roots.mjs 是唯一出口，这两处允许
  if (rel === 'hosts.mjs' || rel === 'roots.mjs') return null;
  const exempt = OUR_ROOT_EXEMPT.find((x) => x.file === rel);
  const lines = readSrc(file).split(/\r?\n/);
  let hits = 0;
  for (const line of lines) {
    const matches = [...line.matchAll(HOST_ROOT_RE)];
    if (!matches.length) continue;
    if (exempt && matches.every((m) => exempt.re.test(line))) continue;
    hits += matches.length;
  }
  return hits;
}

test('唯一出口之外拼宿主根的地方只减不增（棘轮）', () => {
  const actual = {};
  for (const file of srcFiles()) {
    const rel = path.relative(SRC_ROOT, file);
    const hits = hostRootHits(file);
    if (hits) actual[rel] = (actual[rel] ?? 0) + hits;
  }
  const cap = (rel) => HOST_ROOT_DEBT[rel]?.n ?? 0;
  const grew = Object.entries(actual).filter(([rel, n]) => n > cap(rel));
  assert.deepEqual(grew, [], `新增了自己拼宿主根的代码：${grew.map(([f, n]) => `${f}(${n} 处，上限 ${cap(f)})`).join('; ')} —— 请改读 resolveRoot(variant, ctx) 或 hosts 的声明层`);

  const shrank = Object.entries(HOST_ROOT_DEBT).filter(([rel]) => (actual[rel] ?? 0) < HOST_ROOT_DEBT[rel].n);
  assert.deepEqual(shrank, [], `这些文件的债已变少，必须同步下调白名单：${shrank.map(([f]) => `${f}: ${HOST_ROOT_DEBT[f].n} → ${actual[f] ?? 0}`).join('; ')}（棘轮只能收紧一次记录一次，否则数字会假装还在）`);

  for (const [rel, d] of Object.entries(HOST_ROOT_DEBT)) assert.ok(String(d.why).length > 12, `${rel} 的存量债必须写明为什么还留着`);
});

test('roots.mjs 是唯一消费 bucketRoot 的地方（落点表不再是策略源）', () => {
  const consumers = {};
  for (const file of srcFiles()) {
    const rel = path.relative(SRC_ROOT, file);
    if (rel === 'hosts.mjs' || rel === 'roots.mjs') continue;
    const n = [...readSrc(file).matchAll(/\bbucketRoot\(/g)].length;
    if (n) consumers[rel] = n;
  }
  // placement 与 codex 写侧都已改成只读 resolveRoot().bucketRoot；这张表必须保持空
  assert.deepEqual(
    consumers,
    {},
    `桶根消费点漂移：${JSON.stringify(consumers)} —— 除 roots.mjs 之外不该有人直读桶根，棘轮只减不增`,
  );
});

// ---- C. LOCATOR：配置根 / skills / 桶 只允许一处声明 ----

test('LOCATOR 给每家声明 root+skills+bucket，且 VARIANTS 里不再有第二份', () => {
  assert.deepEqual(Object.keys(LOCATOR).sort(), [...ALL_VARIANTS].sort(), '每个变体都要有 locator（没有桶也要写 shape:none）');
  for (const variant of ALL_VARIANTS) {
    const l = LOCATOR[variant];
    assert.equal(typeof l.root, 'function', `${variant}: root 必须是派生函数`);
    assert.ok(['generated', 'shared', 'none'].includes(l.bucket.shape), `${variant}: bucket.shape 非法 ${l.bucket.shape}`);
    if (l.bucket.shape === 'none') assert.equal(l.bucket.root, undefined, `${variant}: 没有桶就不该给 root（有 root 会被当成可写落点）`);
    else assert.equal(typeof l.bucket.root, 'function', `${variant}: ${l.bucket.shape} 桶必须有 root`);
    if (l.skills) assert.ok(Array.isArray(l.skills.rel) && l.skills.rel.length > 0, `${variant}: skills.rel 必须是路径段数组`);
    assert.equal(VARIANTS[variant].skillsDir, undefined, `${variant}: skillsDir 只能由 LOCATOR 声明一处`);
  }
});

test('LOCATOR.root 必须返回 {path, envKey}：configRoot 只投影 path，返回字符串会静默变成 undefined', () => {
  const ctx = ctxFor(tmpHome('root-spec'));
  for (const variant of ALL_VARIANTS) {
    const spec = LOCATOR[variant].root(ctx);
    assert.equal(typeof spec?.path, 'string', `${variant}: root 必须返回 {path, envKey}（收到 ${typeof spec}）—— 各家根派生用 rootOf/envRootOf 构造`);
    assert.ok(spec.path.length > 0, `${variant}: root.path 不能为空`);
    assert.ok(spec.envKey === null || typeof spec.envKey === 'string', `${variant}: envKey 只能是字符串或 null`);
    assert.ok(!String(spec.path).includes('[object'), `${variant}: 拼路径时把对象当路径用了（${spec.path}）`);
    assert.equal(configRoot(ctx, variant), spec.path, `${variant}: configRoot 必须是 root 的路径投影`);
  }
});

test('配置根被 env 搬走时，skills 与桶一起跟着走（半搬状态是 bug）', () => {
  const home = tmpHome('locator-env');
  const moved = path.join(home, 'srv', 'minimax');
  const ctx = ctxFor(home, { MINIMAX_HOME: moved });
  const r = resolveRoot('minimax', ctx);
  assert.equal(r.skillsDir, path.join(moved, 'skills'), 'skills 必须随 MINIMAX_HOME');
  assert.equal(r.bucketRoot.path, path.join(moved, 'sessions'), '非项目桶必须随 MINIMAX_HOME');
  assert.equal(path.normalize(r.configRoot), path.normalize(moved));
  // zcode 同理（以前 BUCKET_ROOTS 只认 c.home，ZCODE_HOME 搬根后桶还留在老位置）
  const z = resolveRoot('zcode', ctxFor(home, { ZCODE_HOME: path.join(home, 'srv', 'zcode') }));
  assert.equal(z.bucketRoot.path, path.join(home, 'srv', 'zcode', 'workspace', 'default'));
});

test('声明了 shape:none 的家确实没有桶根（写侧要落 requires-cwd，不是造目录）', () => {
  const ctx = ctxFor(tmpHome('nobucket'));
  for (const variant of ALL_VARIANTS) {
    const r = resolveRoot(variant, ctx);
    if (LOCATOR[variant].bucket.shape === 'none') {
      assert.equal(r.bucketRoot, null, `${variant} 不该有桶根`);
      continue;
    }
    assert.ok(r.bucketRoot && r.bucketRoot.path, `${variant} 有桶声明却没算出根`);
  }
});

// ---- D. resolver 契约 ----

test('未知变体直接抛，不静默返回空', () => {
  assert.throws(() => resolveRoot('nope', makeCtx({ home: tmpHome('unknown'), env: {} })), /未知 agent 变体/);
});

test('没钉住时，候选集合与 VARIANTS 声明的候选逐条相等（façade 不增删路径）', () => {
  const home = tmpHome('parity');
  const ctx = ctxFor(home);
  for (const variant of ALL_VARIANTS) {
    const r = resolveRoot(variant, ctx);
    const declared = [...(VARIANTS[variant].readPaths?.(ctx) ?? []), ...(VARIANTS[variant].writePaths?.(ctx) ?? []), ...(VARIANTS[variant].auxPaths?.(ctx) ?? [])].map((x) => path.normalize(x.path));
    const uniq = [...new Set(declared)];
    assert.deepEqual(r.candidates.map((c) => path.normalize(c.path)), uniq, `${variant} 的候选必须与登记表一一对应`);
    const surviving = uniq.filter((p) => isFile(p) || isDir(p));
    assert.deepEqual(r.readRoots.map((c) => path.normalize(c.path)), surviving, `${variant} 读侧只应留下真实存在的候选`);
  }
});

test('证据必须逐条给「试过哪儿、为什么不要」，不能只回一个布尔', () => {
  const ctx = ctxFor(tmpHome('evidence'));
  for (const variant of ALL_VARIANTS) {
    const r = resolveRoot(variant, ctx);
    assert.ok(r.evidence.tried.length > 0, `${variant} 一条候选都没试过 = 登记表没生效`);
    for (const t of r.evidence.tried) {
      assert.ok(t.path && typeof t.path === 'string', `${variant} 的证据缺路径`);
      assert.ok(['adopted', 'rejected'].includes(t.outcome), `${variant} 的 outcome 非法: ${t.outcome}`);
      if (t.outcome === 'rejected') assert.ok(t.whyRejected, `${variant} 拒了 ${t.path} 却没说为什么`);
      assert.ok(Object.keys(TIER_RANK).includes(t.tier), `${variant} 的档位没登记: ${t.tier}`);
    }
  }
});

test('写侧采纳门：宿主在本机没出现过时不可写，而不是「当作没有历史」', () => {
  const home = tmpHome('gate');
  const ctx = ctxFor(home);
  const r = resolveRoot('claude', ctx);
  assert.equal(r.readRoots.length, 0, '临时 home 里 .claude/projects 不该存在');
  assert.equal(r.writeRoot, null, '只有不存在的默认根时绝不能当成「可以写」——那正是孤儿目录的来源');
  assert.equal(r.evidence.write.writable, false);
  assert.equal(r.evidence.write.reason, 'write-root-unpinned', '有候选但既没被钉住、宿主也没在本机出现过');
  assert.equal(r.evidence.paste, null, '什么都没探测到时，粘任何路径都是错的');

  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  invalidateRoots(ctx);
  const after = resolveRoot('claude', ctx);
  assert.ok(after.writeRoot, '根真实存在后应可写（tier 仍是 default）');
  assert.equal(after.evidence.tier, 'default');
  assert.equal(after.evidence.paste, null);
});

test('装过但没跑过第一次：配置根在、会话目录不在 → 允许新建写入（反之仍拦）', () => {
  const home = tmpHome('fresh');
  fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
  const r = resolveRoot('codebuddy', ctxFor(home));
  assert.equal(r.readRoots.length, 0, 'projects/ 还不存在，读侧确实没候选');
  assert.ok(r.writeRoot, '第一次新建不能被拦 —— 那时会话目录本来就不存在');
  assert.equal(path.normalize(r.writeRoot.path), path.normalize(path.join(home, '.codebuddy', 'projects')));

  // 反面对照：这家在本机压根没出现过，就不许凭空造一个宿主永远不会看的根
  const ghost = resolveRoot('codebuddy', ctxFor(tmpHome('ghost')));
  assert.equal(ghost.writeRoot, null);
  assert.equal(ghost.evidence.write.reason, 'write-root-unpinned');
});

test('可写档不含 probe：探测能定位，不能替用户决定往哪儿写', () => {
  assert.deepEqual([...WRITABLE_TIERS].sort(), ['default', 'env', 'flag', 'pin'], '可写档只能多不能少，尤其不能把 probe 放进来');
  assert.ok(!WRITABLE_TIERS.has('probe'));
  assert.ok(WRITABLE_TIERS.has('default'), 'default 档必须在可写集合里，否则正常安装的宿主一律写不了（那是把护栏装反）');
});

test('官方 env 指向新目录时即使目录还不存在也可写（那是用户/宿主声明的落点，不是我们猜的）', () => {
  const home = tmpHome('envgate');
  const custom = path.join(home, 'moved', 'codex');
  const ctx = ctxFor(home, { CODEX_HOME: custom });
  const r = resolveRoot('codex', ctx);
  assert.equal(r.evidence.tier, 'env', '由 CODEX_HOME 派生的候选必须落成 env 档');
  assert.equal(r.candidates.find((c) => c.tier === 'env').envKey, 'CODEX_HOME');
  assert.ok(r.writeRoot, 'env 档可写');
  assert.equal(path.normalize(r.writeRoot.path), path.normalize(path.join(custom, 'sessions')));
});

test('只有 session-sync 认的钉住变量落成 pin 档，优先级低于 flag 高于 env', () => {
  const home = tmpHome('pingate');
  const pinnedDb = path.join(home, 'elsewhere', 'main.sqlite');
  const ctx = ctxFor(home, { QODER_CN_REGISTRY_DB: pinnedDb });
  const r = resolveRoot('qoder-cn', ctx);
  const cand = r.candidates.find((c) => path.normalize(c.path) === path.normalize(pinnedDb));
  assert.equal(cand.tier, 'pin');
  assert.equal(cand.envKey, 'QODER_CN_REGISTRY_DB');
});

test('--data-root 是最高档：路径不存在也进读候选并可写（用户明确指了方向）', () => {
  const home = tmpHome('flaggate');
  const target = path.join(home, 'somewhere-else', 'codex');
  const ctx = ctxFor(home, { CODEX_HOME: path.join(home, '.codex') }, { dataRoots: parseDataRoots(`codex=${target}`) });
  const r = resolveRoot('codex', ctx);
  assert.equal(r.candidates[0].tier, 'flag', 'flag 档必须排在最前');
  assert.equal(r.evidence.tier, 'flag');
  assert.ok(r.writeRoot);
  // 钉的是「数据根」，声明形状挂在它下面（codex 的 sessions/）——与探测搬过去的形状一致
  assert.equal(path.normalize(r.writeRoot.path), path.normalize(path.join(target, 'sessions')));
  // 钉住时旧位置的声明候选不再出现（否则同一宿主两个根，读侧会各读一遍）
  assert.ok(!r.candidates.some((c) => c.tier !== 'flag' && path.normalize(c.path).startsWith(path.normalize(path.join(home, '.codex')))), `旧根不该再出现：${JSON.stringify(r.candidates.map((c) => c.path))}`);
});

test('parseDataRoots 的口径：第一个 = 切分、变体名必须认识、空值报错', () => {
  assert.equal(parseDataRoots('').size, 0);
  const two = parseDataRoots(`codex=${path.join('D:', 'a')},claude=${path.join('D:', 'b')}`);
  assert.equal(two.size, 2);
  assert.equal(two.get('codex'), path.join('D:', 'a'));
  assert.throws(() => parseDataRoots('codex'), /要写成 <变体>=<目录>/);
  assert.throws(() => parseDataRoots('nope=D:\\x'), /未知 agent 变体/);
  assert.throws(() => parseDataRoots('codex='), /目录是空的/);
});

test('codebuddy 的 .codebuddy 名称门不能被误标成用户钉过', () => {
  const home = tmpHome('cbgate');
  // CODEBUDDY_CONFIG_DIR 指向不以 .codebuddy 结尾 → readPaths 回落 ~/.codebuddy，档位必须如实是 default
  const ctx = ctxFor(home, { CODEBUDDY_CONFIG_DIR: path.join(home, 'workbuddy-ish') });
  const r = resolveRoot('codebuddy', ctx);
  const fallback = r.candidates.find((c) => path.normalize(c.path) === path.normalize(path.join(home, '.codebuddy', 'projects')));
  assert.ok(fallback, '回落候选必须在');
  assert.equal(fallback.tier, 'default', '被名称门拒掉的 env 不能算 env 档，否则写侧会以为用户钉过');
  assert.equal(fallback.envKey, null, '名称门拒掉之后连来源也不能留 —— 留着就等于宣称这个路径由那个变量决定');
});

test('档位由声明产出，不按路径反推：env 值只是目录名也照样落 env 档', () => {
  const home = tmpHome('declared-tier');
  // WORKBUDDY_DATA_FOLDER_NAME 给的是**根名**（`.workbuddy`），不是路径。
  // 反推式定档（候选路径落在哪个 env 值下面）会算成 default，写门随后按「宿主没在本机出现过」拒收。
  const ctx = ctxFor(home, { WORKBUDDY_DATA_FOLDER_NAME: '.workbuddy' });
  const r = resolveRoot('workbuddy-cn', ctx);
  const proj = r.candidates.find((c) => c.role === 'projects');
  assert.ok(proj, 'projects 候选必须在');
  assert.equal(proj.envKey, 'WORKBUDDY_DATA_FOLDER_NAME');
  assert.equal(proj.tier, 'env');
  assert.ok(r.writeRoot, '宿主自己声明过的落点必须可写 —— 这正是反推式定档踩的那个坑');

  // 反面对照：没有任何声明时同一位置落 default（不能靠「路径长得像」升档）
  const plain = resolveRoot('workbuddy-cn', ctxFor(tmpHome('declared-tier-plain')));
  assert.equal(plain.candidates.find((c) => c.role === 'projects').tier, 'default');
});

test('候选声明的 envKey 必须已登记，且档位与登记表一致（声明写错当场红）', () => {
  const home = tmpHome('declared-registry');
  for (const variant of ALL_VARIANTS) {
    const groups = ROOT_ENV_KEYS[variant] ?? {};
    const known = new Set([...(groups.env ?? []), ...(groups.pin ?? [])]);
    // 只给它自己登记的键赋值：值按名称门需要挑，其余用互不相同的目录，避免同一路径撞车掩盖问题
    const env = {};
    for (const key of known) env[key] = envValueFor(home, variant, key);
    for (const c of resolveRoot(variant, ctxFor(home, env)).candidates) {
      if (c.envKey == null) continue;
      assert.ok(known.has(c.envKey), `${variant}: 候选 ${c.path} 声明的来源 ${c.envKey} 没在 ROOT_ENV_KEYS 登记（漏登记 = 同一个宿主被读成两个安装）`);
      const want = (groups.env ?? []).includes(c.envKey) ? 'env' : 'pin';
      assert.equal(c.tier, want, `${variant}: ${c.envKey} 必须落 ${want} 档（档位只在 ROOT_ENV_KEYS 登记一次）`);
    }
  }
});

/**
 * 逐个变量单独设值，检查「路径被这个变量推动过」时候选有没有如实标上来源。
 *
 * 这条盯的是**漏标**：档位不再从路径反推，声明忘了带 envKey 就只会安静降成 default 档，
 * 写门随后按「宿主没出现过」拒收用户明确指过的位置 —— 既没有报错，也没有证据。
 * 判据用「候选路径是否真的变了」而不是「键是否出现」：像 `CODEBUDDY_EXTENSION_HISTORY`
 * 这种只喂写侧 history 根、不进 readPaths 的变量，本来就不该要求候选标来源。
 */
test('候选路径被某个变量推动时，必须有一条候选声明该来源（漏标 envKey 当场红）', () => {
  const home = tmpHome('declared-coverage');
  const pathsOf = (variant, env) => resolveRoot(variant, ctxFor(home, env)).candidates.map((c) => path.normalize(c.path));
  for (const variant of ALL_VARIANTS) {
    const groups = ROOT_ENV_KEYS[variant] ?? {};
    const bare = pathsOf(variant, {});
    for (const key of [...(groups.env ?? []), ...(groups.pin ?? [])]) {
      const ctx = ctxFor(home, { [key]: envValueFor(home, variant, key) });
      const cands = resolveRoot(variant, ctx).candidates;
      const moved = cands.some((c) => !bare.includes(path.normalize(c.path)));
      if (!moved) continue; // 这个键在本变体不影响候选（如只喂写侧的 CODEBUDDY_EXTENSION_HISTORY）
      assert.ok(
        cands.some((c) => c.envKey === key),
        `${variant}: 设了 ${key} 后候选路径变了，却没有任何候选声明该来源 —— 根派生漏带 envKey（会静默降成 default 档）`,
      );
    }
  }
});

test('detectInstalled 与 resolveRoot 读候选同源：装了哪家 = 哪家有存在的候选', () => {
  const home = tmpHome('detect');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const ctx = ctxFor(home);
  const installed = detectInstalled(ctx);
  const fromResolver = ALL_VARIANTS.filter((v) => resolveRoot(v, ctx).readRoots.length > 0);
  assert.deepEqual(fromResolver, installed, '探测口径必须与 resolver 一致（两套判定就会有两套答案）');
  assert.ok(installed.includes('claude'));
});

test('rootSummary 给人一行含路径与档位的结论', () => {
  const home = tmpHome('summary');
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  const s = rootSummary('codex', ctxFor(home));
  assert.equal(s.installed, true);
  assert.match(s.line, /codex: .*sessions/);
  assert.equal(s.tier, 'default');
});
