// hosts.mjs — 21 变体登记表：路径解析（平台分支）+ 能力 + 探测 + skills 目录
//
// 每个变体：
//   label          展示名
//   read           true | 'degraded'（降级读取）
//   write          'A'（直接可写）| 'B'（需注意）| false（不可写）
//   readPaths(ctx) 读取探测候选 [{kind:'file'|'dir', path, note}]
//   writePaths(ctx) 写入目标候选（与 readPaths 可能不同，如 cursor 仅旧路径可写）
//   detect(ctx)    安装探测（installer 自动桥接依据）
//   （skill 落点与配置根、非项目桶一起并入 LOCATOR，见 skillsDirOf/bucketRoot/bucketShape）
//   sharedDirect   true = 直读共享根 ~/.agents/skills/（桥接可选）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, cmpPath } from './util.mjs';

const cmpHome = (h) => cmpPath(String(h ?? '')).replace(/[\\/]+$/, '');
const processHome = () => process.env.USERPROFILE || process.env.HOME || '';

export function makeCtx(overrides = {}) {
  const env = overrides.env || process.env;
  const home = overrides.home || env.HOME || env.USERPROFILE;
  // 拿不到主目录时必须在入口处说清楚：往下走是 path.join(undefined) 直接抛 TypeError，
  // 用户看到的是一句栈信息，而不是「HOME/USERPROFILE 没设」。
  if (!home || typeof home !== 'string') throw new Error('拿不到主目录：请设置 HOME 或 USERPROFILE（或用 makeCtx({ home }) 注入）');
  const platform = overrides.platform || process.platform;
  const win = platform === 'win32';
  return {
    platform,
    home,
    env,
    appData: overrides.appData || env.APPDATA || (win ? path.join(home, 'AppData', 'Roaming') : path.join(home, '.config')),
    localAppData: overrides.localAppData || env.LOCALAPPDATA || (win ? path.join(home, 'AppData', 'Local') : path.join(home, '.local', 'share')),
    xdgData: env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
    xdgConfig: env.XDG_CONFIG_HOME || path.join(home, '.config'),
    // 探测 portable/自定义安装时要扫的父集之一。取不到就整档跳过，不编一个「通常是 C:\Program Files」的路径。
    programFiles: overrides.programFiles || env.PROGRAMFILES || env.ProgramFiles || (win ? null : '/usr/local'),
    // 非项目会话的兜底落点目录（= 执行导入的当前目录）。
    // 注意：它只用于「写到哪」，绝不参与「是不是同一条会话」的判定。
    cwd: overrides.cwd || process.cwd(),
    // `--data-root <变体>=<目录>` 解析后的 Map（见 roots.mjs parseDataRoots）。
    // 它是用户显式钉住的最高优先级落点，所以属于 ctx，不能由各消费点自己去读 argv。
    dataRoots: overrides.dataRoots || null,
    // 「文档」已知文件夹的注入点：给测试沙箱和「我知道自己 Documents 在哪」的调用方用；
    // 不给值时由 documentsRoot 走注册表 / XDG / home 默认（见下）。
    documents: overrides.documents || null,
    // 见 documentsRoot：只给测试用，用来替掉 reg.exe / user-dirs.dirs 这两次外部读取
    documentsProbe: overrides.documentsProbe || null,
    // 入口证据的测试缝：注入祖先进程链（形状同 entryChain 返回值）。
    // 少了它，入口层用例会在 CI 上查真机的链 —— 断言从此取决于这台机器装了什么。
    procChain: overrides.procChain || null,
  };
}

const p = (...parts) => path.join(...parts);
const HOME = (c, name) => p(c.home, name);

/**
 * 根的统一声明形态：`{ path, envKey }`。
 *
 * `envKey` 是**决定这个路径的那个环境变量**（没有就是默认位置），档位（env / pin / default）由
 * `ROOT_ENV_KEYS` 查得 —— 变量属于哪一档是同一份事实，不在声明处再写一遍。
 *
 * 为什么必须是声明产出而不是事后反推：以前档位靠「候选路径落在哪个 env 值下面」算，
 * 于是 env 值只是 home 下的一个目录名时（`WORKBUDDY_DATA_FOLDER_NAME` 就是）算成 default 档，
 * 写门按「宿主没在本机出现过」拒收用户明确声明过的落点；而 `CODEBUDDY_CONFIG_DIR` 被名称门
 * 拒掉后回落的默认路径不匹配它，反而算对了 —— 两件事靠猜，猜对猜错各占一头。
 */
function rootOf(path, envKey = null) {
  return { path, envKey: envKey || null };
}

/** 单变量根：该变量有值就用它并记下来源，否则用默认位置（= default 档）。 */
function envRootOf(c, key, fallback) {
  const v = String(c.env[key] ?? '').trim();
  return v ? rootOf(v, key) : rootOf(fallback);
}

/**
 * CodeBuddy 与 WorkBuddy 共用 `CODEBUDDY_CONFIG_DIR`（同一代码底座）：WorkBuddy 的桌面进程
 * 也会把这个变量指向自己的根。只有指向 `.codebuddy` 时才当成 CodeBuddy CLI 的配置根，
 * 否则一律回落 `~/.codebuddy` —— 避免把 `~/.workbuddy/projects` 读成 CodeBuddy 会话。
 *
 * 名称门拒掉时来源必须如实为空：仍标 `CODEBUDDY_CONFIG_DIR` 会让写侧以为用户钉过这个落点。
 */
export function codebuddyRoot(c) {
  const dir = String(c.env.CODEBUDDY_CONFIG_DIR || '').trim();
  if (/(^|[\\/])\.codebuddy[\\/]?$/i.test(dir)) return rootOf(dir, 'CODEBUDDY_CONFIG_DIR');
  return rootOf(HOME(c, '.codebuddy'));
}

// CodeBuddy CLI 的会话根（唯一派生处：reader/writer/hosts 共用，避免各算一遍）
export function codebuddyProjectsRoot(c) {
  const root = codebuddyRoot(c);
  return rootOf(p(root.path, 'projects'), root.envKey);
}

// CodeBuddy IDE / VS Code 插件共用 tencent-cloud.coding-copilot 的扩展数据目录
export function codebuddyExtensionDataRoot(c) {
  const env = String(c.env.CODEBUDDY_EXTENSION_DATA || '').trim();
  if (env) return rootOf(env, 'CODEBUDDY_EXTENSION_DATA');
  if (c.platform === 'win32') return rootOf(p(c.localAppData, 'CodeBuddyExtension', 'Data'));
  if (c.platform === 'darwin') return rootOf(p(c.home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data'));
  return rootOf(p(c.home, '.local', 'share', 'CodeBuddyExtension', 'Data'));
}

export const SHARED_SKILLS_ROOT = (c) => p(c.home, '.agents', 'skills');

/**
 * 每个变体「哪些环境变量能挪动它的根」的唯一登记表 —— env 档与 pin 档的判据来源（roots.mjs 用它给候选定档）。
 *
 * 为什么单独列一份而不是就地读：定位一个根这件事在仓里曾有六套答案
 * （detect / reader.available / 写侧取 readPaths[0] / 各家重抄 env 链 / accounts 登录态 / 两张落点表），
 * 变量名散在六处就会在某一处漏掉一个 env，于是同一个宿主被读成两个安装。
 * 本表由 test/m55 双向锁定：列在这里的键必须真的被 VARIANTS 用到，VARIANTS 用到的键必须列在这里。
 *
 *   env = 宿主自己认的官方变量（跟着它走 = 跟着宿主走）
 *   pin = 只有 session-sync 认的钉住变量（宿主本体不认，用户用它来指定自定义落点）
 * 两家都没有的（antigravity / cursor）只能靠探测或 --data-root，不为此发明新变量。
 */
export const ROOT_ENV_KEYS = {
  opencode: { env: [], pin: ['OPENCODE_DATA_DIR'] },
  claude: { env: ['CLAUDE_CONFIG_DIR'] },
  pi: { env: ['PI_HOME'] },
  antigravity: { env: [], pin: [] },
  codex: { env: ['CODEX_HOME'] },
  codebuddy: { env: ['CODEBUDDY_CONFIG_DIR'] },
  'codebuddy-ide': { pin: ['CODEBUDDY_EXTENSION_DATA', 'CODEBUDDY_EXTENSION_HISTORY'] },
  // 两版共用同一批官方变量：值指向哪个根，就属于哪个版本（由根名区分，见 workbuddyRoot）
  'workbuddy-cn': { env: ['WORKBUDDY_CONFIG_DIR', 'WORKBUDDY_DATA_FOLDER_NAME', 'CODEBUDDY_CONFIG_DIR'], pin: ['WORKBUDDY_HOME'] },
  'workbuddy-intl': { env: ['WORKBUDDY_CONFIG_DIR', 'WORKBUDDY_DATA_FOLDER_NAME', 'CODEBUDDY_CONFIG_DIR'], pin: ['WORKBUDDY_AI_HOME'] },
  'qoder-cn': { pin: ['QODER_CN_REGISTRY_DB'] },
  'qoder-intl': { pin: ['QODER_INTL_REGISTRY_DB'] },
  zcode: { env: ['ZCODE_HOME'] },
  mimo: { env: ['MIMO_HOME'] },
  minimax: { env: ['MINIMAX_HOME'] },
  dsh: { env: ['DSH_HOME'] },
  freebuff: { env: ['FREEBUFF_CONFIG_DIR'] },
  cline: { env: ['CLINE_DIR', 'CLINE_DATA_DIR'], pin: ['CLINE_TASKS_DIRS', 'CLINE_SESSION_DATA_DIR', 'CLINE_DB_DATA_DIR'] },
  kilo: { pin: ['KILO_DB', 'KILO_DATA_DIR', 'KILO_TASKS_DIRS', 'KILO_TASKS_DIR'] },
  roo: { pin: ['ROO_TASKS_DIRS'] },
  cursor: { env: [], pin: [] },
  doubao: { env: [], pin: [] },
};

/**
 * Codex 的配置根（唯一派生处）：`sessions/`、`state_N.sqlite`、`.codex-global-state.json`、
 * 登录态 `auth.json` 都在它下面。auth.json 是「当前登录账号」的唯一来源，路径必须与
 * reader/writer 算会话根用的是同一个根，否则 env 覆盖时会读错一份登录态。
 */
export function codexRoot(c) {
  return envRootOf(c, 'CODEX_HOME', HOME(c, '.codex'));
}

/**
 * WorkBuddy 中/英安装根的唯一派生处。
 * 正文 `projects/`、索引 `workbuddy.db`、登录态 `storage/skeleton/account-snapshot.json`
 * 都是它下面的固定相对路径，各算一遍就会在 env 覆盖时指到不同的安装。
 *
 * 优先级：宿主自己声明的根（`WORKBUDDY_CONFIG_DIR`，兼容 `CODEBUDDY_CONFIG_DIR`）
 *   → 根名 + home（`WORKBUDDY_DATA_FOLDER_NAME`）→ 本工具的钉住别名 → 默认位置。
 *
 * 官方的根变量**只在它的根名与本变体相符时才采纳**：两版可以同时装在一台机器上，
 * 中文版进程里查 intl 时若无条件跟随 `WORKBUDDY_CONFIG_DIR`，就会拿到 cn 的根，
 * 把两个安装读成同一个（这正是 qoder 刻意不跟随 `QODER_CONFIG_DIR` 的同一条纪律）。
 */
export function workbuddyRoot(c, variant) {
  const declared = String(c.env.WORKBUDDY_CONFIG_DIR || '').trim();
  const declaredKey = declared ? 'WORKBUDDY_CONFIG_DIR' : 'CODEBUDDY_CONFIG_DIR';
  const dir = declared || String(c.env.CODEBUDDY_CONFIG_DIR || '').trim();
  // 裸目录名（不带任何分隔符）只有相对 cwd 才能解释成路径，那是错的：按 home 展开，与下面的根名分支一致
  if (wbNameMatches(dir, variant)) return rootOf(/[\\/]/.test(dir) ? dir : HOME(c, dir), declaredKey);
  const folder = String(c.env.WORKBUDDY_DATA_FOLDER_NAME || '').trim();
  if (wbNameMatches(folder, variant)) return rootOf(HOME(c, folder), 'WORKBUDDY_DATA_FOLDER_NAME');
  // 两个别名分开写死而不是 `c.env[aliasKey]`：动态键在文本扫描里认不出来，
  // ROOT_ENV_KEYS 的「登记了就必须真的被读」棘轮（m55）会把它当成假覆盖。
  const pinned = variant === 'workbuddy-intl' ? String(c.env.WORKBUDDY_AI_HOME || '').trim() : String(c.env.WORKBUDDY_HOME || '').trim();
  if (pinned) return rootOf(pinned, variant === 'workbuddy-intl' ? 'WORKBUDDY_AI_HOME' : 'WORKBUDDY_HOME');
  return rootOf(HOME(c, variant === 'workbuddy-intl' ? '.workbuddy-ai' : '.workbuddy'));
}

/** 根名是否属于该版本：intl 是 `.workbuddy-ai`，cn 是 `.workbuddy`（只比最后一段，值可以是完整路径也可以是裸目录名）。 */
function wbNameMatches(value, variant) {
  const name = String(value ?? '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  if (!name) return false;
  return variant === 'workbuddy-intl' ? /^\.workbuddy-ai$/i.test(name) : /^\.workbuddy$/i.test(name);
}

/**
 * 落点基准的唯一声明处：每家宿主的「配置根」「skills 落点」「非项目会话桶」都只在这里写一遍。
 *
 * 之前这三件事散在 VARIANTS 的 skillsDir 字段、BUCKET_ROOTS 表和 placement 的 INTERNAL_ROOTS 里，
 * 三份各算各的，于是 env 覆盖时会出现「会话读到了 D 盘、skills 还装到 C 盘」这种半搬状态。
 * 消费方一律走 locatorOf()/bucketRoot()/skillsDirOf()，不要自己拼。
 *
 * skills.base 说明：'root' = 随本变体已解析的根走；其余是按 ctx 的哪个基准根起算。
 * cline 的 skills 仍从 home 起算 —— 宿主源码里取证到的是 `CLINE_DIR` 决定**数据根**
 * （resolveClineDataDir），skills 层是否跟着搬没有实测，所以不猜。
 */

/**
 * 「文档」已知文件夹。不少人把 Documents 重定向到别处（域环境常见），
 * 拿 <home>\Documents 硬拼会得到两个错：写侧在无人在的目录里造孤儿桶，
 * 读侧认不出宿主自己生成的桶 → 非项目会话被误判成项目会话。
 * 主路径是注册表（HKCU 的 User Shell Folders\\Personal，值里带 %USERPROFILE% 要展开）；
 * 取不到就回 home\Documents 并如实标 validated:false，写侧据此拒绝建目录。
 */
const PERSONAL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
const DOCS_BY_CTX = new WeakMap();

function expandUserEnv(value, c) {
  return String(value)
    .replace(/%USERPROFILE%/gi, c.home)
    .replace(/\\/g, '\\')
    .trim();
}

function readPersonalFromRegistry(c) {
  if (c.platform !== 'win32') return null;
  let out = '';
  try {
    out = execFileSync('reg', ['query', PERSONAL_KEY, '/v', 'Personal'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // 受限环境、无 reg.exe、或键不存在：都按取不到处理
  }
  const m = /Personal\s+REG_[A-Z_]+\s+(.+)$/im.exec(out.trim());
  return m ? expandUserEnv(m[1], c) : null;
}

function readXdgDocuments(c) {
  if (c.platform === 'win32' || c.platform === 'darwin') return null;
  let text = '';
  try {
    text = fs.readFileSync(p(c.xdgConfig, 'user-dirs.dirs'), 'utf8');
  } catch {
    return null;
  }
  const m = /XDG_DOCUMENTS_DIR="?([^"\n]+)"?/.exec(text);
  return m ? expandUserEnv(m[1].replace('$HOME', c.home), c) : null;
}

/** 返回 {path, source, validated, redirected}；source = override|home-relative|registry|xdg-user-dirs|fallback */
export function documentsRoot(c) {
  const hit = DOCS_BY_CTX.get(c);
  if (hit) return hit;
  const override = String(c.documents || '').trim();
  // 注册表/XDG 描述的是**当前登录用户**；ctx.home 被换成沙箱目录时它已经不适用（拿真机的
  // Documents 当沙箱的桶根，测试会把正文写进真实用户目录）。这种 ctx 直接按 home 相对拼，
  // 并视为已证实 —— 夹具里的世界由调用方定义。真实 ctx 仍然走注册表，取不到就是未证实。
  const sandboxed = cmpHome(c.home) !== cmpHome(processHome());
  const res = override
    ? { path: override, source: 'override', validated: true, redirected: cmpHome(override) !== cmpHome(p(c.home, 'Documents')) }
    : sandboxed && !c.documentsProbe
      ? { path: p(c.home, 'Documents'), source: 'home-relative', validated: true, redirected: false }
      : (() => {
        const def = p(c.home, 'Documents');
        // documentsProbe 是测试注入位（真机上这条要走 reg.exe，夹具里没法可靠地跑它），不是用户开关
        const reg = c.documentsProbe ? c.documentsProbe(c) : readPersonalFromRegistry(c);
        const xdg = reg ? null : readXdgDocuments(c);
        const found = reg ?? xdg;
        // redirected 才是危险信号：已知文件夹被指到别处，而那儿又没有宿主自己生成的目录。
        // 「读不到注册表」（受限环境、PATH 里没有 reg.exe）不算 —— 那只是不知道，不能当成搬走过。
        if (found) return { path: found, source: reg ? 'registry' : 'xdg-user-dirs', validated: true, redirected: cmpHome(found) !== cmpHome(def) };
        return { path: def, source: 'fallback', validated: true, redirected: false };
      })();
  DOCS_BY_CTX.set(c, res);
  return res;
}

export function documents(c) {
  return documentsRoot(c).path;
}

// ---- 各家配置根的唯一派生处：readPaths / detect / locator 都调这里，不在第二处重抄 env 链 ----
export function claudeRoot(c) {
  return envRootOf(c, 'CLAUDE_CONFIG_DIR', HOME(c, '.claude'));
}
export function piRoot(c) {
  return envRootOf(c, 'PI_HOME', HOME(c, '.pi'));
}
export function zcodeRoot(c) {
  return envRootOf(c, 'ZCODE_HOME', HOME(c, '.zcode'));
}
export function mimoRoot(c) {
  return envRootOf(c, 'MIMO_HOME', p(c.xdgData, 'mimocode'));
}
export function minimaxRoot(c) {
  return envRootOf(c, 'MINIMAX_HOME', HOME(c, '.minimax'));
}
export function dshRoot(c) {
  return envRootOf(c, 'DSH_HOME', HOME(c, '.dsh'));
}
export function freebuffRoot(c) {
  return envRootOf(c, 'FREEBUFF_CONFIG_DIR', p(c.xdgConfig, 'manicode'));
}
/** 豆包桌面端（Chromium 系）：userData = `%LOCALAPPDATA%\Doubao\User Data`；macOS / Linux 的根形态未取证（见 agent-storage §22 待证-doubao-3）。 */
export function doubaoUserDataRoot(c) {
  return rootOf(p(c.localAppData, 'Doubao', 'User Data'));
}
/** Profile 清单：`Local State` 的 `profile.info_cache` 键；读不到时按宿主默认的 Default 兜底。 */
export function doubaoProfiles(c) {
  try {
    const st = JSON.parse(fs.readFileSync(p(doubaoUserDataRoot(c).path, 'Local State'), 'utf8'));
    const names = Object.keys(st?.profile?.info_cache ?? {});
    if (names.length) return names;
  } catch {
    /* 读不到就按默认 Profile */
  }
  return ['Default'];
}
/** 各 Profile 的 agent 会话根（读侧唯一派生处）。 */
export function doubaoSessionRoots(c) {
  const userData = doubaoUserDataRoot(c).path;
  return doubaoProfiles(c).map((profile) => ({
    profile,
    userData,
    path: p(userData, profile, '.doubao', 'agent_mode', 'workspace', '.sessions'),
  }));
}
export function clineRoot(c) {
  return envRootOf(c, 'CLINE_DIR', HOME(c, '.cline'));
}
/**
 * Cline 的数据根：`CLINE_DATA_DIR` 指了就用它，否则是 `<CLINE_DIR>/data`。
 * 来源跟着派生链走 —— `<CLINE_DIR>/data` 该记 `CLINE_DIR` 而不是 default，
 * 否则 `CLINE_DIR` 搬根时写门会把宿主自己建的位置当成「我们猜的」。
 */
export function clineDataRoot(c) {
  const explicit = String(c.env.CLINE_DATA_DIR ?? '').trim();
  if (explicit) return rootOf(explicit, 'CLINE_DATA_DIR');
  const dir = clineRoot(c);
  return rootOf(p(dir.path, 'data'), dir.envKey);
}

export const LOCATOR = {
  opencode: { marker: { kind: 'sqlite-tables', rel: 'opencode.db', any: [['session_v2'], ['session', 'message', 'part']] }, probe: { parents: ['home', 'localAppData', 'appData'], names: ['opencode'], maxDepth: 5 }, root: (c) => rootOf(p(c.xdgData, 'opencode')), skills: { base: 'xdgConfig', rel: ['opencode', 'skill'] }, bucket: { shape: 'shared', root: (c) => c.home } },
  claude: { marker: { kind: 'children', any: [['projects']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.claude'], maxDepth: 3 }, root: claudeRoot, skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' } },
  pi: { marker: { kind: 'children', any: [['agent', 'sessions']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.pi'], maxDepth: 3 }, root: piRoot, skills: { base: 'root', rel: ['agent', 'skills'] }, bucket: { shape: 'none' } },
  antigravity: { marker: { kind: 'children', any: [['conversations']] }, probe: { parents: ['home'], names: ['.gemini'], maxDepth: 2 }, root: (c) => rootOf(HOME(c, '.gemini', 'antigravity-cli')), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' } },
  codex: { marker: { kind: 'children', any: [['sessions'], ['archived_sessions']] }, probe: { parents: ['home', 'documents', 'localAppData', 'appData', 'programFiles'], names: ['.codex'], maxDepth: 3 }, root: codexRoot, skills: null, bucket: { shape: 'generated', knownFolder: 'Codex', root: (c) => p(documents(c), 'Codex') }, account: [{ base: 'root', rel: ['auth.json'], note: '当前登录的唯一来源' }] },
  codebuddy: { marker: { kind: 'children', any: [['projects']] }, probe: { parents: ['home', 'documents', 'localAppData', 'appData', 'programFiles'], names: ['.codebuddy'], maxDepth: 3 }, root: codebuddyRoot, skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' }, account: [{ base: 'root', rel: ['inspiration'], kind: 'dir', note: '按 uid 分目录' }] },
  'codebuddy-ide': { marker: { kind: 'descendant-named', name: 'history', maxDepth: 4 }, probe: { parents: ['localAppData', 'appData', 'programFiles'], names: ['CodeBuddyExtension'], maxDepth: 5 }, root: codebuddyExtensionDataRoot, skills: null, bucket: { shape: 'none' } },
  'workbuddy-cn': { marker: { kind: 'children', any: [['projects'], ['storage']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.workbuddy'], maxDepth: 3 }, root: (c) => workbuddyRoot(c, 'workbuddy-cn'), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'generated', root: (c) => HOME(c, 'WorkBuddy') }, account: [{ base: 'root', rel: ['storage', 'skeleton', 'account-snapshot.json'], note: 'primary.uid 是当前登录的唯一权威来源' }] },
  'workbuddy-intl': { marker: { kind: 'children', any: [['projects'], ['storage']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.workbuddy-ai'], maxDepth: 3 }, root: (c) => workbuddyRoot(c, 'workbuddy-intl'), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'generated', root: (c) => HOME(c, 'WorkBuddy AI') }, account: [{ base: 'root', rel: ['storage', 'skeleton', 'account-snapshot.json'], note: '同 cn' }] },
  // Qoder 桌面端的非项目工作区桶（cn/intl 各一根，现网实测）：会话可写进这里并被宿主列出
  // 登录档案在桌面产品目录，正文与 skills 在 CLI 根 —— 两个基准必须分开声明，别再在别处手拼 %APPDATA%
  'qoder-cn': { marker: { kind: 'children', any: [['projects'], ['cache', 'projects']] }, probe: { parents: ['home', 'documents', 'appData'], names: ['.qoder-cn', 'com.qodercn.app.stable', 'QoderCN'], maxDepth: 5 }, root: (c) => rootOf(HOME(c, '.qoder-cn')), appDir: (c) => p(c.appData, 'com.qodercn.app.stable'), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'generated', knownFolder: 'QoderCN', root: (c) => p(documents(c), 'QoderCN') }, account: [{ base: 'appDir', rel: ['qoder-data.v1.ext.json'] }, { base: 'appDir', rel: ['qoder-data.v1.json'] }] },
  'qoder-intl': { marker: { kind: 'children', any: [['projects'], ['cache', 'projects']] }, probe: { parents: ['home', 'documents', 'appData'], names: ['.qoder', 'com.qoder.app.stable', 'Qoder'], maxDepth: 5 }, root: (c) => rootOf(HOME(c, '.qoder')), appDir: (c) => p(c.appData, 'com.qoder.app.stable'), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'generated', knownFolder: 'Qoder', root: (c) => p(documents(c), 'Qoder') }, account: [{ base: 'appDir', rel: ['qoder-data.v1.ext.json'] }, { base: 'appDir', rel: ['qoder-data.v1.json'] }] },
  zcode: { marker: { kind: 'sqlite-tables', rel: ['cli', 'db', 'db.sqlite'], any: [['session']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.zcode'], maxDepth: 3 }, root: zcodeRoot, skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'shared', root: (c) => p(zcodeRoot(c).path, 'workspace', 'default') }, internal: (c) => [p(zcodeRoot(c).path, 'workspace'), p(c.home, 'ZCodeProject')], account: [{ base: 'root', rel: ['v2', 'credentials.json'], note: 'uid 编在 project-key-location 的键名里' }] },
  mimo: { marker: { kind: 'sqlite-tables', rel: 'mimocode.db', any: [['session', 'project']] }, probe: { parents: ['home', 'localAppData', 'appData', 'xdgData'], names: ['mimocode', '.mimocode'], maxDepth: 5 }, root: mimoRoot, appDir: (c) => p(c.appData, 'Xiaomi MiMo'), skills: { base: 'xdgData', rel: ['mimocode', 'compose'] }, bucket: { shape: 'generated', root: (c) => HOME(c, 'XiaomiMiMoProjects') }, account: [{ base: 'appDir', rel: ['xiaomi-last-confirmed.json'] }] },
  minimax: { marker: { kind: 'sqlite-tables', rel: ['v2', 'sqlite', 'runtime-state.sqlite'], any: [['local_runtime_sessions']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.minimax'], maxDepth: 3 }, root: minimaxRoot, skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'generated', root: (c) => p(minimaxRoot(c).path, 'sessions') }, account: [{ base: 'root', rel: ['local-runtime.auth.json'], note: 'auth.realUserID' }], userData: [{ base: 'appData', rel: ['MiniMax', 'Local Storage', 'leveldb'] }, { base: 'appData', rel: ['MiniMax Code', 'Local Storage', 'leveldb'] }] },
  dsh: { marker: { kind: 'children', any: [['sessions']] }, probe: { parents: ['home', 'documents', 'localAppData', 'programFiles'], names: ['.dsh'], maxDepth: 3 }, root: dshRoot, skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'shared', knownFolder: 'deepseek-harness', root: (c) => p(documents(c), 'deepseek-harness', 'default-workspace') }, account: [{ base: 'root', rel: ['.credentials.yaml'], note: 'refs 里是供应商凭据池，不是会话归属' }] },
  freebuff: { marker: { kind: 'children', any: [['projects']] }, probe: { parents: ['xdgConfig', 'home'], names: ['manicode', '.manicode', 'codebuff'], maxDepth: 3 }, root: freebuffRoot, skills: null, bucket: { shape: 'none' }, account: [{ base: 'root', rel: ['credentials.json'], note: 'profile→id/email，会话行无归属列' }] },
  cline: { marker: { kind: 'children', any: [['data', 'sessions'], ['data', 'tasks'], ['tasks']] }, probe: { parents: ['home', 'localAppData', 'appData', 'programFiles'], names: ['.cline'], maxDepth: 5, extIds: ['saoudrizwan.claude-dev'] }, root: clineRoot, skills: { base: 'home', rel: ['.cline', 'skills'] }, bucket: { shape: 'none' } },
  kilo: { marker: { kind: 'sqlite-tables', rel: 'kilo.db', any: [['session', 'message', 'part']] }, probe: { parents: ['home', 'localAppData', 'appData', 'xdgData'], names: ['kilo', '.kilo'], maxDepth: 5, extIds: ['kilocode.kilo-code'] }, root: (c) => rootOf(HOME(c, '.kilo')), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' } },
  roo: { marker: { kind: 'children', any: [['tasks']] }, probe: { parents: ['home', 'appData', 'localAppData', 'programFiles'], names: ['.roo'], maxDepth: 5, extIds: ['rooveterinaryinc.roo-cline'] }, root: (c) => rootOf(HOME(c, '.roo')), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' } },
  cursor: { marker: { kind: 'sqlite-tables', rel: ['User', 'globalStorage', 'state.vscdb'], any: [['cursorDiskKV']] }, probe: { parents: ['home', 'appData', 'localAppData', 'programFiles'], names: ['.cursor', 'Cursor'], maxDepth: 5 }, root: (c) => rootOf(HOME(c, '.cursor')), skills: { base: 'root', rel: ['skills'] }, bucket: { shape: 'none' } },
  // 豆包：userData 根下 `User Data` 是 Chromium 的形态判据；会话根按 Profile 派生。
  // 只读，没有非项目桶（侧栏是云端 + 缓存库，见 agent-storage §22）。
  doubao: { marker: { kind: 'children', any: [['User Data']] }, probe: { parents: ['localAppData'], names: ['Doubao'], maxDepth: 2 }, root: doubaoUserDataRoot, skills: null, bucket: { shape: 'none' } },
};

/** 该家声明的配置根（env 覆盖后的真实根）；没有 locator 登记 = 该项目还没接入 */
export function locatorOf(variant) {
  const l = LOCATOR[variant];
  if (!l) throw new Error(`变体 ${variant} 没有 locator 登记（root/skills/bucket 三件事必须声明）`);
  return l;
}

/** 本变体的配置根（只有路径）。需要「这个根由哪个变量决定」时读 `configRootSpec`。 */
export function configRoot(ctx, variant) {
  return configRootSpec(ctx, variant).path;
}

/** 配置根的声明形态 `{ path, envKey }`：档位由 ROOT_ENV_KEYS 查得，见 rootOf 的说明。 */
export function configRootSpec(ctx, variant) {
  return locatorOf(variant).root(ctx);
}

/**
 * 声明里的 base 名 → 实际基准目录。
 * 'root' 用本变体已解析的配置根；'appDir' 用桌面端自己的产品目录 —— 两者对 qoder 是两回事
 * （正文在 ~/.qoder-cn，登录档案在 %APPDATA%\com.qodercn.app.stable），所以必须分开声明，
 * 不能在 accounts.mjs 里再手拼一遍 %APPDATA%。
 * 没声明 account 的家 = 本机没取证到账号落点，accounts.mjs 会如实报 none。
 */
export function locatorBase(ctx, variant, base) {
  const l = locatorOf(variant);
  if (base === 'root') return l.root(ctx).path;
  if (base === 'appDir') return l.appDir ? l.appDir(ctx) : null;
  if (base === 'documents') return documents(ctx);
  if (['home', 'appData', 'localAppData', 'xdgConfig', 'xdgData', 'programFiles'].includes(base)) return ctx[base];
  throw new Error(`${variant}: 未知的 locator base "${base}"`);
}

function specToPath(ctx, variant, spec) {
  const base = locatorBase(ctx, variant, spec.base);
  if (!base) return null;
  const full = p(base, ...spec.rel);
  const kind = spec.kind ?? 'file';
  return { path: full, kind, note: spec.note ?? null, exists: exists(full) };
}

/** 登录态落点清单（可能有多份，如 qoder 的两个 json）；没声明 = 这家没取证到账号落点 */
export function accountPathsOf(ctx, variant) {
  const specs = locatorOf(variant).account;
  return (specs ?? []).map((s) => specToPath(ctx, variant, s)).filter(Boolean);
}

/** 宿主自己存状态的地方（如 MiniMax 的 LevelDB localStorage） */
export function userDataDirsOf(ctx, variant) {
  const specs = locatorOf(variant).userData;
  return (specs ?? []).map((s) => specToPath(ctx, variant, { kind: 'dir', ...s })).filter(Boolean);
}

export function skillsDirOf(ctx, variant) {
  const spec = locatorOf(variant).skills;
  return spec ? specToPath(ctx, variant, { ...spec, kind: 'dir' })?.path ?? null : null;
}

export function bucketRoot(ctx, variant) {
  const bucket = locatorOf(variant).bucket;
  return bucket.shape === 'none' || !bucket.root ? null : bucket.root(ctx);
}

/** 宿主自己给「无项目会话」用的桶形态；placement 只读它，不再自己列表 */
export function bucketShape(variant) {
  return locatorOf(variant).bucket.shape;
}

export const VARIANTS = {
  opencode: {
    label: 'OpenCode',
    read: true,
    write: 'B',
    readPaths: (c) => {
      const out = [];
      if (c.env.OPENCODE_DATA_DIR) out.push({ kind: 'file', path: p(c.env.OPENCODE_DATA_DIR, 'opencode.db'), role: 'db', envKey: 'OPENCODE_DATA_DIR' });
      // OpenCode 全平台都用 XDG 路径（`opencode debug paths` 实证：Windows 上 config 也是 ~/.config/opencode）
      out.push({ kind: 'file', path: p(c.xdgData, 'opencode', 'opencode.db'), role: 'db', note: 'data 目录' });
      if (c.platform === 'win32') out.push({ kind: 'file', path: p(c.appData, 'opencode', 'opencode.db'), role: 'db', note: '旧版遗留' });
      return out;
    },
    detect: (c) => VARIANTS.opencode.readPaths(c).some((x) => exists(x.path)) || exists(p(c.xdgConfig, 'opencode')),
    // skills 目录是单数 skill（从 opencode 二进制符号实证：AGENTS.md/skill、/skill）
  },

  claude: {
    label: 'Claude Code',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = claudeRoot(c);
      return [{ kind: 'dir', path: p(root.path, 'projects'), role: 'projects', envKey: root.envKey, note: 'CLI 正文根（projects/<slug>/<id>.jsonl）' }];
    },
    detect: (c) => exists(VARIANTS.claude.readPaths(c)[0].path) || exists(claudeRoot(c).path),
  },

  pi: {
    label: 'Pi',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = piRoot(c);
      return [{ kind: 'dir', path: p(root.path, 'agent', 'sessions'), role: 'sessions', envKey: root.envKey }];
    },
    detect: (c) => exists(VARIANTS.pi.readPaths(c)[0].path) || exists(piRoot(c).path),
    sharedDirect: true,
  },

  antigravity: {
    label: 'Antigravity CLI',
    read: true,
    write: false, // steps 为 protobuf 二进制，无安全写入路径
    readPaths: (c) => [{ kind: 'dir', path: p(c.home, '.gemini', 'antigravity-cli', 'conversations'), role: 'sessions', envKey: null }],
    detect: (c) => exists(VARIANTS.antigravity.readPaths(c)[0].path) || exists(p(c.home, '.gemini', 'antigravity-cli')),
  },

  codex: {
    label: 'Codex CLI',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = codexRoot(c);
      return [
        { kind: 'dir', path: p(root.path, 'sessions'), role: 'sessions', envKey: root.envKey },
        { kind: 'dir', path: p(root.path, 'archived_sessions'), role: 'archive', envKey: root.envKey, note: '已归档：只用于存在性判定，按 D1 不进导入候选' },
      ];
    },
    detect: (c) => exists(VARIANTS.codex.readPaths(c)[0].path) || exists(codexRoot(c).path),
    sharedDirect: true,
  },

  // CodeBuddy Code（腾讯的 CLI）：会话按 cwd 分项目目录，纯本地 JSONL
  codebuddy: {
    label: 'CodeBuddy Code',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = codebuddyRoot(c);
      return [{ kind: 'dir', path: p(root.path, 'projects'), role: 'projects', envKey: root.envKey, root: root.path }];
    },
    detect: (c) => exists(codebuddyProjectsRoot(c).path) || exists(codebuddyRoot(c).path),
  },

  // CodeBuddy IDE / VS Code 插件：共用 tencent-cloud.coding-copilot 扩展的 history 目录
  'codebuddy-ide': {
    label: 'CodeBuddy IDE / 插件',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = codebuddyExtensionDataRoot(c);
      return [{ kind: 'dir', path: root.path, role: 'data', envKey: root.envKey }];
    },
    detect: (c) => exists(codebuddyExtensionDataRoot(c).path),
  },

  'workbuddy-cn': {
    label: 'WorkBuddy 中文版',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = workbuddyRoot(c, 'workbuddy-cn');
      return [
        { kind: 'file', path: p(root.path, 'workbuddy.db'), role: 'sessionsIndex', envKey: root.envKey },
        { kind: 'dir', path: p(root.path, 'projects'), role: 'projects', envKey: root.envKey },
      ];
    },
    detect: (c) => VARIANTS['workbuddy-cn'].readPaths(c).some((x) => exists(x.path)),
  },

  'workbuddy-intl': {
    label: 'WorkBuddy 国际版',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = workbuddyRoot(c, 'workbuddy-intl');
      return [
        { kind: 'file', path: p(root.path, 'workbuddy.db'), role: 'sessionsIndex', envKey: root.envKey },
        { kind: 'dir', path: p(root.path, 'projects'), role: 'projects', envKey: root.envKey },
      ];
    },
    detect: (c) => VARIANTS['workbuddy-intl'].readPaths(c).some((x) => exists(x.path)),
  },

  'qoder-cn': {
    label: 'Qoder 中文版',
    read: true,
    // 可写：正文 jsonl 明文（claude 同构）+ 桌面注册表 main.sqlite 明文（元数据 + 正文投影）。
    // 旧的 SharedClientCache/local.db 才是密文只读降级源（2026-10-28 真机取证，见 references/qoder-write.md）
    write: 'B',
    // 变体根必须硬隔离：CN 只认 .qoder-cn、国际版只认 .qoder，都不跟随 QODER_CONFIG_DIR
    // （本机 QODER_CONFIG_DIR=C:\\Users\\you\\.qoder-cn，跟随它会让国际版读到 CN 数据）
    readPaths: (c) => {
      const cliRoot = rootOf(HOME(c, '.qoder-cn'));
      const reg = String(c.env.QODER_CN_REGISTRY_DB || '').trim();
      return [
        { kind: 'file', path: reg || p(c.appData, 'com.qodercn.app.stable', 'main.sqlite'), role: 'registry', envKey: reg ? 'QODER_CN_REGISTRY_DB' : null, note: '桌面注册表 main.sqlite（明文元数据 + 正文投影，现行代际）' },
        { kind: 'file', path: p(c.appData, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'), note: '旧版 local.db（桌面端，正文密文）' },
        { kind: 'file', path: p(c.appData, 'QoderCN', 'User', 'globalStorage', 'state.vscdb'), note: '旧版索引' },
        { kind: 'dir', path: p(cliRoot.path, 'projects'), role: 'cliProjects', envKey: cliRoot.envKey, note: 'CLI 正文 jsonl（明文）' },
        { kind: 'dir', path: p(cliRoot.path, 'cache', 'projects'), envKey: cliRoot.envKey, note: '按 task 派生的会话历史缓存：实测 9 条里 8 条与 projects/ 同源换 id，不作会话来源' },
      ];
    },
    detect: (c) => VARIANTS['qoder-cn'].readPaths(c).some((x) => exists(x.path)) || exists(p(c.appData, 'QoderCN')),
  },

  'qoder-intl': {
    label: 'Qoder 国际版',
    read: true,
    write: 'B', // 同 qoder-cn：明文 jsonl + 明文注册表
    readPaths: (c) => {
      const cliRoot = rootOf(HOME(c, '.qoder'));
      const reg = String(c.env.QODER_INTL_REGISTRY_DB || '').trim();
      return [
        { kind: 'file', path: reg || p(c.appData, 'com.qoder.app.stable', 'main.sqlite'), role: 'registry', envKey: reg ? 'QODER_INTL_REGISTRY_DB' : null, note: '桌面注册表（国际版目录名按 cn 规则推断，本机未装未取证）' },
        { kind: 'file', path: p(c.appData, 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db'), note: '旧版 local.db（桌面端，正文密文）' },
        { kind: 'file', path: p(c.appData, 'Qoder', 'User', 'globalStorage', 'state.vscdb'), note: '旧版索引' },
        { kind: 'dir', path: p(cliRoot.path, 'projects'), role: 'cliProjects', envKey: cliRoot.envKey, note: 'CLI 正文 jsonl（明文）' },
        { kind: 'dir', path: p(cliRoot.path, 'cache', 'projects'), envKey: cliRoot.envKey, note: '按 task 派生的会话历史缓存：同 cn，不作会话来源' },
      ];
    },
    detect: (c) => VARIANTS['qoder-intl'].readPaths(c).some((x) => exists(x.path)) || exists(p(c.appData, 'Qoder')),
  },

  zcode: {
    label: 'ZCode',
    read: true,
    // 明文 SQLite、无加密、无 revision 哈希（本机两库实测 + ZCode 开源仓库取证）→ 可写。
    // 可见性要同时写第二个库（桌面侧栏读 tasks-index），见 writers/zcode.mjs。
    write: 'B',
    readPaths: (c) => {
      const root = zcodeRoot(c);
      return [{ kind: 'file', path: p(root.path, 'cli', 'db', 'db.sqlite'), role: 'db', envKey: root.envKey }];
    },
    auxPaths: (c) => {
      const root = zcodeRoot(c);
      return [{ kind: 'file', path: p(root.path, 'v2', 'tasks-index.sqlite'), envKey: root.envKey, note: '桌面侧栏列表源' }];
    },
    detect: (c) => exists(VARIANTS.zcode.readPaths(c)[0].path) || exists(zcodeRoot(c).path),
  },

  mimo: {
    label: 'MiMo Code',
    read: true,
    write: 'B',
    readPaths: (c) => {
      const out = [];
      const root = mimoRoot(c);
      if (root.envKey) out.push({ kind: 'file', path: p(root.path, 'mimocode.db'), role: 'db', envKey: root.envKey });
      out.push({ kind: 'file', path: p(c.xdgData, 'mimocode', 'mimocode.db'), role: 'db' });
      if (c.platform === 'win32') {
        out.push({ kind: 'file', path: p(c.appData, 'mimocode', 'mimocode.db'), role: 'db' });
        out.push({ kind: 'file', path: p(c.localAppData, 'mimocode', 'mimocode.db'), role: 'db' });
      }
      return out;
    },
    detect: (c) => VARIANTS.mimo.readPaths(c).some((x) => exists(x.path)) || exists(p(c.xdgData, 'mimocode')) || (c.platform === 'win32' && (exists(p(c.appData, 'mimocode')) || exists(p(c.localAppData, 'mimocode')))),
    sharedDirect: true,
  },

  minimax: {
    label: 'MiniMax Code',
    read: true,
    // 只写 DB 即可（正文源选择链会回退到 local_runtime_message_rows，
    // canonical-history-materializer 自己把行物化成 messages.jsonl 并算 revision）
    // → 原先「activeRevision 算法未公开所以只读」的理由不成立。
    write: 'B',
    readPaths: (c) => {
      const root = minimaxRoot(c);
      return [
        { kind: 'file', path: p(root.path, 'v2', 'sqlite', 'runtime-state.sqlite'), role: 'db', envKey: root.envKey },
        { kind: 'dir', path: p(root.path, 'v2', 'sessions'), role: 'history', envKey: root.envKey, note: 'v2 文件型历史' },
      ];
    },
    detect: (c) => VARIANTS.minimax.readPaths(c).some((x) => exists(x.path)) || exists(minimaxRoot(c).path),
    sharedDirect: true,
  },

  dsh: {
    label: 'DSH (DeepSeek Harness)',
    read: true,
    write: 'B',
    readPaths: (c) => {
      const root = dshRoot(c);
      return [{ kind: 'dir', path: p(root.path, 'sessions'), role: 'sessions', envKey: root.envKey }];
    },
    detect: (c) => exists(VARIANTS.dsh.readPaths(c)[0].path) || exists(dshRoot(c).path),
    sharedDirect: true,
  },

  freebuff: {
    label: 'Freebuff (Codebuff)',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const root = freebuffRoot(c);
      return [{ kind: 'dir', path: p(root.path, 'projects'), role: 'projects', envKey: root.envKey }];
    },
    detect: (c) => exists(VARIANTS.freebuff.readPaths(c)[0].path) || exists(freebuffRoot(c).path),
  },

  cline: {
    label: 'Cline',
    read: true,
    write: 'A',
    // 三代落点（本机实测）：
    //   1. <ide globalStorage>/saoudrizwan.claude-dev/tasks/<ts>/  —— 扩展一代，实测 Code 19 条
    //   2. ~/.cline/tasks（一代 CLI，本机空目录）、~/.cline/data/tasks/<ts>/（二代 CLI，实测 3 条）
    //      —— 与 (1) 同构：api_conversation_history.json + ui_messages.json + task_metadata.json
    //   3. ~/.cline/data/sessions/<id>/<id>.messages.json（三代 CLI，实测 2 条）
    //      —— Claude 同构消息流 + <id>.json 元数据；data/db/sessions.db 是它的索引（实测 2 行 = 2 个目录，无额外会话）
    readPaths: (c) => {
      const out = [];
      const cliRoot = clineRoot(c);
      const dataRoot = clineDataRoot(c);
      if (c.env.CLINE_TASKS_DIRS) {
        for (const d of String(c.env.CLINE_TASKS_DIRS).split(path.delimiter).filter(Boolean)) {
          out.push({ kind: 'dir', path: d, role: 'tasks', envKey: 'CLINE_TASKS_DIRS', note: 'env CLINE_TASKS_DIRS' });
        }
      }
      for (const dir of clineTaskDirs(c)) out.push({ kind: 'dir', path: dir, role: 'tasks' });
      out.push({ kind: 'dir', path: p(cliRoot.path, 'tasks'), role: 'tasks', envKey: cliRoot.envKey });
      out.push({ kind: 'dir', path: p(dataRoot.path, 'tasks'), role: 'tasks', envKey: dataRoot.envKey });
      // 4.x 会话库与它的索引：env 指定优先（pin 档），否则默认在 <data>/sessions 与 <data>/db
      if (c.env.CLINE_SESSION_DATA_DIR) out.push({ kind: 'dir', path: String(c.env.CLINE_SESSION_DATA_DIR).trim(), role: 'sessions', envKey: 'CLINE_SESSION_DATA_DIR', note: 'env CLINE_SESSION_DATA_DIR' });
      else out.push({ kind: 'dir', path: p(dataRoot.path, 'sessions'), role: 'sessions', envKey: dataRoot.envKey });
      if (c.env.CLINE_DB_DATA_DIR) out.push({ kind: 'file', path: p(String(c.env.CLINE_DB_DATA_DIR).trim(), 'sessions.db'), role: 'sessionsIndex', envKey: 'CLINE_DB_DATA_DIR', note: 'env CLINE_DB_DATA_DIR' });
      else out.push({ kind: 'file', path: p(dataRoot.path, 'db', 'sessions.db'), role: 'sessionsIndex', envKey: dataRoot.envKey });
      return out;
    },
    detect: (c) => VARIANTS.cline.readPaths(c).some((x) => exists(x.path)) || exists(p(c.home, '.cline')),
  },

  kilo: {
    label: 'Kilo Code',
    read: true,
    write: 'B',
    readPaths: (c) => {
      const out = [];
      if (c.env.KILO_DB) out.push({ kind: 'file', path: c.env.KILO_DB, role: 'db', envKey: 'KILO_DB', note: 'env KILO_DB' });
      if (c.env.KILO_DATA_DIR) out.push({ kind: 'file', path: p(c.env.KILO_DATA_DIR, 'kilo.db'), role: 'db', envKey: 'KILO_DATA_DIR' });
      if (c.platform === 'win32') out.push({ kind: 'file', path: p(c.localAppData, 'kilo', 'kilo.db'), role: 'db' });
      out.push({ kind: 'file', path: p(c.xdgData, 'kilo', 'kilo.db'), role: 'db' });
      // VS Code 系扩展任务目录（Cline 血统：tasks/<id>/api_conversation_history.json）
      for (const ide of ['Code', 'Cursor', 'Windsurf']) {
        out.push({ kind: 'dir', path: p(c.appData, ide, 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), role: 'tasks', note: `VS Code 扩展（${ide}）` });
      }
      if (c.env.KILO_TASKS_DIRS) {
        // 复数形态是官方变量（多个任务目录用平台分隔符连接）；单数 KILO_TASKS_DIR 是旧名，两者都认
        for (const d of String(c.env.KILO_TASKS_DIRS).split(path.delimiter).filter(Boolean)) {
          out.push({ kind: 'dir', path: d, role: 'tasks', envKey: 'KILO_TASKS_DIRS', note: 'env KILO_TASKS_DIRS' });
        }
      }
      if (c.env.KILO_TASKS_DIR) out.push({ kind: 'dir', path: c.env.KILO_TASKS_DIR, role: 'tasks', envKey: 'KILO_TASKS_DIR', note: 'legacy tasks' });
      out.push({ kind: 'dir', path: p(c.home, '.kilo', 'tasks'), role: 'tasks', note: 'legacy tasks' });
      return out;
    },
    detect: (c) => VARIANTS.kilo.readPaths(c).some((x) => exists(x.path)) || exists(p(c.home, '.kilo')),
    sharedDirect: true,
  },

  // Roo Code：Cline 血统的另一插件分支（RooVeterinaryInc.roo-cline）
  // 任务目录结构与 Cline 同构：tasks/<id>/{api_conversation_history.json, ui_messages.json, task_metadata.json}
  roo: {
    label: 'Roo Code',
    read: true,
    write: 'A',
    readPaths: (c) => {
      const out = [];
      if (c.env.ROO_TASKS_DIRS) {
        for (const d of String(c.env.ROO_TASKS_DIRS).split(path.delimiter).filter(Boolean)) {
          out.push({ kind: 'dir', path: d, role: 'tasks', envKey: 'ROO_TASKS_DIRS', note: 'env ROO_TASKS_DIRS' });
        }
      }
      // 插件版（跑在哪个 IDE 里就存哪个 IDE 的 globalStorage）
      for (const ide of ['Code', 'Cursor', 'Windsurf', 'VSCodium']) {
        out.push({ kind: 'dir', path: p(c.appData, ide, 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'), role: 'tasks', note: `插件版（${ide}）` });
      }
      out.push({ kind: 'dir', path: p(c.home, '.roo', 'tasks'), role: 'tasks', note: 'CLI 版' });
      return out;
    },
    detect: (c) => VARIANTS.roo.readPaths(c).some((x) => exists(x.path)) || exists(p(c.home, '.roo')),
  },

  cursor: {
    label: 'Cursor',
    read: true,
    // 列表源是 state.vscdb 的 cursorDiskKV 表 composerData:<id>（本机实测 22 条，其中 16 条 conversation=[] 空壳），
    // 与目录无关；composer 有内部不变量（bubbles/索引/工作区映射），新代 chats/store.db
    // 为内容寻址 blob 链且 schema 未文档化 → 只读
    write: false,
    readPaths: (c) => {
      const out = [];
      if (c.platform === 'win32') {
        out.push({ kind: 'file', path: p(c.appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'), role: 'db', note: '会话正文（实测本机唯一来源）' });
        out.push({ kind: 'dir', path: p(c.appData, 'Cursor', 'User', 'workspaceStorage'), role: 'cwdMap', note: 'composerId → cwd 映射（实测 52 个，8/22 无映射）' });
      } else if (c.platform === 'darwin') {
        out.push({ kind: 'file', path: p(c.home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'), role: 'db', note: '会话正文' });
        out.push({ kind: 'dir', path: p(c.home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'), role: 'cwdMap', note: 'composerId → cwd 映射' });
      } else {
        out.push({ kind: 'file', path: p(c.xdgConfig, 'Cursor', 'User', 'globalStorage', 'state.vscdb'), role: 'db', note: '会话正文' });
        out.push({ kind: 'dir', path: p(c.xdgConfig, 'Cursor', 'User', 'workspaceStorage'), role: 'cwdMap', note: 'composerId → cwd 映射' });
      }
      // 新代布局：本机不存在（~/.cursor 下只有 extensions/mcp.json/projects(空)/skills），保留为可选兼容
      out.push({ kind: 'dir', path: p(c.home, '.cursor', 'chats'), role: 'sessions', note: '新代 store.db 目录（本机不存在，best-effort）' });
      return out;
    },
    writePaths: (c) => {
      // 只读：见上方 write: false
      return [];
    },
    detect: (c) => VARIANTS.cursor.readPaths(c).some((x) => exists(x.path)) || exists(p(c.home, '.cursor')) || exists(p(c.appData, 'Cursor')),
  },

  // 豆包（Doubao）桌面端 agent 模式：只读。侧栏 = 云端 + IndexedDB 缓存，
  // 本地 `.sessions` 是 agent 运行时工作区、不是会话注册表（外部写入不进列表，见 agent-storage §22 V7）。
  doubao: {
    label: '豆包 (Doubao) agent 模式',
    read: true,
    write: false,
    readPaths: (c) => doubaoSessionRoots(c).map((x) => ({ kind: 'dir', path: x.path, role: 'sessions', note: `Profile ${x.profile}`, envKey: null })),
    detect: (c) => VARIANTS.doubao.readPaths(c).some((x) => exists(x.path)) || exists(doubaoUserDataRoot(c).path),
  },
};

function clineTaskDirs(c) {
  // Cline 任务目录：跑在哪个 IDE 里就存哪个 IDE 的 globalStorage
  const ides = ['Code', 'Cursor', 'Windsurf', 'VSCodium'];
  return ides.map((ide) => p(c.appData, ide, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'));
}

export const ALL_VARIANTS = Object.keys(VARIANTS);

export function getVariant(name) {
  const v = VARIANTS[name];
  if (!v) throw new Error(`未知 agent 变体: ${name}（可用: ${ALL_VARIANTS.join(', ')}）`);
  return v;
}

export function variantCapability(name) {
  const v = getVariant(name);
  return { read: v.read, write: v.write };
}

/**
 * 宿主探测：当前进程跑在哪个 agent 里（= skill 被调用时的目标 agent）。
 *
 * 优先看环境变量指纹（各家启动子进程时会带自己的标记），拿不到再退化为
 * 「已安装变体中存储最近被改动者」——但那一步只用来解释，不产出结论。
 *
 * 三终态：identified = 唯一锁定；ambiguous = 命中信号但只到产品级（同族多版本）；unknown = 无正面证据。
 * ambiguous 必须能被表达出来：判不出时给一个确定答案是静默写歪的源头，调用方事后无从发现。
 */
const HOST_ENV_MARKERS = [
  // 顺序敏感：越具体的越靠前
  {
    // 中英判别只认「带值匹配」：根名整段等于 `.workbuddy-ai` 才是 intl，等于 `.workbuddy` 才是 cn。
    // 版本号 / 资源路径 / 自造别名都是两版共用的产品级信号，只能确定「这是 WorkBuddy」，判不出 edition。
    //
    // 判据与 `workbuddyRoot` 共用 `wbNameMatches`（唯一出口）。曾各写一份正则，于是同一个值在两个
    // 出口给出相反答案：尾分隔符的值定位认、判别判不出；`my-workbuddy-ai` 判别判 intl、定位不认，
    // 结果「识别为 intl 却写进默认目录」—— 正是本期要消灭的那类静默写歪。
    variant: (env) => {
      const declared = String(env.WORKBUDDY_CONFIG_DIR || env.CODEBUDDY_CONFIG_DIR || '').trim();
      if (wbNameMatches(declared, 'workbuddy-intl')) return 'workbuddy-intl';
      if (wbNameMatches(declared, 'workbuddy-cn')) return 'workbuddy-cn';
      // 根名变量只给目录名（不是完整路径），同样能定 edition
      const folder = String(env.WORKBUDDY_DATA_FOLDER_NAME || '').trim();
      if (wbNameMatches(folder, 'workbuddy-intl')) return 'workbuddy-intl';
      if (wbNameMatches(folder, 'workbuddy-cn')) return 'workbuddy-cn';
      // 宿主自己的产品配置路径：文件里 dataFolderName 是它对edition 的正面声明（E-WB-ACC-PATH）
      const acc = String(env.ACC_PRODUCT_CONFIG_PATH || '').trim();
      if (acc) {
        const declared = accConfigDataFolder(acc);
        if (wbNameMatches(declared, 'workbuddy-intl')) return 'workbuddy-intl';
        if (wbNameMatches(declared, 'workbuddy-cn')) return 'workbuddy-cn';
      }
      return null;
    },
    keys: ['WORKBUDDY_CONFIG_DIR', 'WORKBUDDY_DATA_FOLDER_NAME', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_HOME', 'WORKBUDDY_AI_HOME', 'WORKBUDDY_APP_VERSION', 'WORKBUDDY_RESOURCES_PATH', 'WORKBUDDY_STARTUP_PID', 'ACC_PRODUCT_CONFIG_PATH'],
    family: ['workbuddy-cn', 'workbuddy-intl'],
    // 与 CodeBuddy CLI 共用的键：只命中它时不代表「这是 WorkBuddy」
    sharedKeys: ['CODEBUDDY_CONFIG_DIR'],
    sessionKeys: ['CODEBUDDY_SESSION_ID'],
  },
  // CodeBuddy Code CLI：与 WorkBuddy 共用 CODEBUDDY_CONFIG_DIR，只在指向 `.codebuddy` 时认
  {
    variant: (env) => (/(^|[\\/])\.codebuddy[\\/]?$/i.test(String(env.CODEBUDDY_CONFIG_DIR || '')) ? 'codebuddy' : null),
    keys: ['CODEBUDDY_CONFIG_DIR'],
    // 这个变量本身只能证明「codebuddy 家族」：CLI 与 WorkBuddy 中英版都用它，值不像任何一家时全给出来
    family: ['codebuddy', 'workbuddy-cn', 'workbuddy-intl'],
    sessionKeys: [],
  },
  { variant: () => 'claude', keys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR'], sessionKeys: ['CLAUDE_SESSION_ID'] },
  { variant: () => 'codex', keys: ['CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'CODEX_THREAD_ID'], sessionKeys: ['CODEX_THREAD_ID'] },
  { variant: () => 'opencode', keys: ['OPENCODE_DATA_DIR', 'OPENCODE_CONFIG', 'OPENCODE_BIN'], sessionKeys: [] },
  { variant: () => 'pi', keys: ['PI_HOME', 'PI_SESSION_ID'], sessionKeys: ['PI_SESSION_ID'] },
  // 中英判别只看根名：`.qoder-cn` 是中文版的正面证据，`.qoder` 是国际版的正面证据。
  // 两者都不像时返回 null（交回 ambiguous），不再用「不是 cn 就是 intl」的排除法兜底。
  {
    variant: (env) => {
      const dirs = [env.QODER_CONFIG_DIR, env.QODER_HOME].map((v) => String(v ?? '').trim());
      if (dirs.some((d) => /(^|[\\/])\.qoder-cn$/i.test(d) || /qodercn/i.test(d))) return 'qoder-cn';
      if (dirs.some((d) => /(^|[\\/])\.qoder$/i.test(d))) return 'qoder-intl';
      return null;
    },
    keys: ['QODER_CONFIG_DIR', 'QODER_HOME', 'QODER_SESSION_ID'],
    family: ['qoder-cn', 'qoder-intl'],
    sessionKeys: ['QODER_SESSION_ID'],
  },
  { variant: () => 'zcode', keys: ['ZCODE_HOME', 'ZCODE_SESSION_ID'], sessionKeys: ['ZCODE_SESSION_ID'] },
  // MiMo 的宿主指纹是 MIMOCODE_* 前缀（二进制取证：MIMOCODE_BIN_PATH/CONFIG_DIR/DB/CLIENT 等）；
  // 它不导出固定会话 id，所以 sessionId 留空
  { variant: () => 'mimo', prefix: 'MIMOCODE_', keys: ['MIMO_HOME'], sessionKeys: ['MIMOCODE_SESSION_ID'] },
  { variant: () => 'minimax', keys: ['MINIMAX_HOME', 'MINIMAX_SESSION_ID'], sessionKeys: ['MINIMAX_SESSION_ID'] },
  { variant: () => 'dsh', keys: ['DSH_HOME', 'DSH_SESSION_ID'], sessionKeys: ['DSH_SESSION_ID'] },
  { variant: () => 'freebuff', keys: ['FREEBUFF_CONFIG_DIR', 'CODEBUFF_CONFIG_DIR'], sessionKeys: [] },
  { variant: () => 'cline', keys: ['CLINE_TASKS_DIRS'], sessionKeys: [] },
  { variant: () => 'kilo', keys: ['KILO_DB', 'KILO_DATA_DIR', 'KILO_TASKS_DIR'], sessionKeys: [] },
  { variant: () => 'cursor', keys: ['CURSOR_TRACE_ID', 'CURSOR_AGENT'], sessionKeys: [] },
];

/**
 * 指纹表用到的全部环境变量键（含会话键与 MiMo 的 `MIMOCODE_*` 前缀）。
 *
 * 给测试沙箱用：只抹 `ROOT_ENV_KEYS` 抹不掉身份信号（`WORKBUDDY_APP_VERSION`、
 * `CLAUDE_CODE_ENTRYPOINT`、`CODEBUDDY_SESSION_ID`…），于是同一个用例在装了 WorkBuddy
 * 的机器上报 `ambiguous`、在干净 CI 上报 `unknown` —— 测试结果取决于这台机器装了什么。
 */
export function hostEnvSignalKeys() {
  const keys = new Set();
  const prefixes = new Set();
  for (const m of HOST_ENV_MARKERS) {
    for (const k of m.keys ?? []) keys.add(k);
    for (const k of m.sessionKeys ?? []) keys.add(k);
    if (m.prefix) prefixes.add(m.prefix);
  }
  return { keys: [...keys], prefixes: [...prefixes] };
}

/**
 * 入口证据表（S2）：只回答「谁在调用我」，不参与落点，也不得成为第二个兜底（R7）。
 *
 * 两种取值来源，都是宿主自己生成的正面证据：
 *   - `exe`     —— 祖先进程链上的可执行文件路径，整段目录名/文件名相等才算命中；
 *   - `pidFile` —— 宿主**按 pid** 自生成的归属文件：WorkBuddy 每次加载产品配置都往自己的数据根
 *                  写 `cache/acc-product-config-v3-<pid>-<guid>.json`，文件里的 `dataFolderName`
 *                  就是它自己声明的数据根名（中英版各写各的根）。所以「哪个根里有这个 pid」不是猜。
 */
const HOST_ENTRY_MARKERS = [
  { variant: 'doubao', exe: [/[\\/]Doubao[\\/]Application[\\/]app[\\/]Doubao\.exe$/i, /[\\/]Doubao[\\/]User Data[\\/]sandbox_runtime[\\/]bases[\\/][^\\/]+[\\/]pwsh[\\/]/i] },
  // 归属文件落在**该变体自己的配置根**下：根名由 LOCATOR 给（唯一出口），
  // 这里只声明「去这个变体的 cache 里找它自己写的 pid 记录」，不再抄一遍 `.workbuddy`。
  { variant: 'workbuddy-cn', pidFile: true },
  { variant: 'workbuddy-intl', pidFile: true },
];

const CHAIN_MAX_HOPS = 8;
const CHAIN_TIMEOUT_MS = 4000;

/**
 * 祖先进程链（含自己），返回 [{pid, exe}]。
 *
 * 一次查询走完整条链：逐跳 spawn 会把 8 跳变成 8 秒。测试用 `ctx.procChain` 注入。
 * 失败/超时/平台不支持一律返回空数组 —— 空链只能得到 `unknown`，绝不许退回活动度（R7）。
 */
export function entryChain(ctx = makeCtx()) {
  if (Array.isArray(ctx.procChain)) return ctx.procChain;
  if (globalThis.__sessionSyncEntryChain) return globalThis.__sessionSyncEntryChain;
  let out = [];
  try {
    if (ctx.platform === 'win32') {
      const script = '$p=$PID;' + `for($i=0;$i -lt ${CHAIN_MAX_HOPS};$i++){ $q=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $q){break}; $e=$q.ExecutablePath; if($null -eq $e){$e=""}; "{0}|{1}" -f $q.ProcessId,$e; $p=$q.ParentProcessId }`;
      const so = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: CHAIN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4e6 });
      out = String(so).split(/\r?\n/).filter(Boolean).map((l) => {
        const i = l.indexOf('|');
        return i < 0 ? null : { pid: Number(l.slice(0, i)), exe: l.slice(i + 1).trim() };
      }).filter((x) => x && Number.isFinite(x.pid));
    } else {
      // POSIX：/proc 可读就顺手走一条链；读不到（macOS）就是空链，不假装知道
      let pid = process.pid;
      for (let i = 0; i < CHAIN_MAX_HOPS && pid > 1; i++) {
        let exe = '';
        try {
          exe = fs.realpathSync(`/proc/${pid}/exe`);
        } catch {
          break;
        }
        out.push({ pid, exe });
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
        pid = Number(stat[1]);
      }
    }
  } catch {
    out = [];
  }
  globalThis.__sessionSyncEntryChain = out;
  return out;
}

/**
 * 归属文件判据：链上的 pid 是否出现在该变体自己配置根的 cache 里，
 * 且文件自声明的 `dataFolderName` 与那个根**逐字相等**。
 *
 * 两道校验各自挡一种假阳性：只看文件名会把「另一版也用过这个 pid」当成自己；
 * 不比根名则根被 env / 钉住搬走后会认错家。任一道不过就是没证据。
 */
function pidFileHit(ctx, chain, variant) {
  const root = configRoot(ctx, variant);
  if (!root) return null;
  const selfName = path.basename(path.normalize(root));
  const pids = new Set(chain.map((c) => c.pid));
  const dir = path.join(root, 'cache');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = /^acc-product-config-v3-(\d+)-/.exec(n);
    if (!m || !pids.has(Number(m[1]))) continue;
    let declare = '';
    try {
      declare = String(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).dataFolderName ?? '');
    } catch {
      continue; // 打不开就是没证据，不许按文件名猜归属
    }
    if (declare === selfName) return Number(m[1]);
  }
  return null;
}

/** 入口证据的结论：唯一命中才 identified，多个只能 ambiguous，没有就 unknown。 */
function entryEvidence(ctx) {
  const chain = entryChain(ctx);
  if (!chain.length) return { variant: null, candidates: [], evidence: 'entry:none', chain };
  const hits = new Map();
  for (const m of HOST_ENTRY_MARKERS) {
    for (const p of m.exe ?? []) {
      const hop = chain.find((c) => c.exe && p.test(c.exe));
      if (hop) hits.set(m.variant, `entry:exe@${hop.pid}`);
    }
    if (m.pidFile) {
      const pid = pidFileHit(ctx, chain, m.variant);
      if (pid) hits.set(m.variant, `entry:pidFile(${m.variant})@${pid}`);
    }
  }
  if (hits.size === 1) {
    const [variant, evidence] = [...hits][0];
    return { variant, candidates: [variant], evidence, chain };
  }
  if (hits.size > 1) return { variant: null, candidates: [...hits.keys()], evidence: [...hits.values()].join('+'), chain };
  return { variant: null, candidates: [], evidence: 'entry:none', chain };
}

/**
 * `ACC_PRODUCT_CONFIG_PATH` 指向的配置里 `dataFolderName` 是宿主自己声明的数据根名。
 * 读不到文件/字段就返回空串：这条判据只在真读到值时参与判别，存在性本身不算判据。
 */
function accConfigDataFolder(file) {
  try {
    return String(JSON.parse(fs.readFileSync(String(file), 'utf8')).dataFolderName ?? '');
  } catch {
    return '';
  }
}

export function detectHost(ctx = makeCtx(), { entry = false } = {}) {
  const env = ctx.env || {};
  // 命中指纹但只到产品级（同族多版本判不出）：先记下来，后面若有更高分辨力的入口再覆盖
  let partial = null;
  for (const marker of HOST_ENV_MARKERS) {
    // prefix 优先（MiMo 的 MIMOCODE_*），否则按登记键；两者都命中同一变体
    const byPrefix = marker.prefix ? Object.keys(env).filter((k) => k.startsWith(marker.prefix) && String(env[k] ?? '') !== '') : [];
    const hit = byPrefix.length ? byPrefix : marker.keys.filter((k) => env[k] != null && String(env[k]) !== '');
    if (hit.length === 0) continue;
    const variant = marker.variant(env);
    if (variant && VARIANTS[variant]) {
      let sessionId = null;
      for (const k of marker.sessionKeys ?? []) {
        if (env[k]) {
          sessionId = String(env[k]);
          break;
        }
      }
      return { variant, sessionId, evidence: hit.join(','), confidence: 'env', state: 'identified', candidates: [variant] };
    }
    if (!partial) {
      // 只到产品级时把「已知范围」记下来。`sharedKeys` 里的键是几个产品共用的（`CODEBUDDY_CONFIG_DIR`
      // 同时属于 CLI 与 WorkBuddy 中英版），只命中它时范围不是本 marker 的产品，交给下一条 marker 报。
      const shared = marker.sharedKeys ?? [];
      if (hit.some((k) => !shared.includes(k))) partial = { evidence: hit.join(','), candidates: marker.family ?? [] };
    }
  }
  // S1 只到家族/产品级（partial）时，入口证据是唯一的细化来源；它推翻不了任何 identified 结论（R2）。
  const e = entry ? entryEvidence(ctx) : null;
  if (e?.variant) {
    if (!partial || partial.candidates.includes(e.variant)) {
      return { variant: e.variant, sessionId: null, evidence: `${partial ? partial.evidence + '+' : ''}${e.evidence}`, confidence: 'entry', state: 'identified', candidates: [e.variant], chain: e.chain };
    }
    // 两条正面证据互相冲突：谁也不许压住谁，如实报候选（曾靠 mtime 挑一个，就是把冲突藏进静默写歪）
    return { variant: null, sessionId: null, evidence: `${partial.evidence}+${e.evidence}`, confidence: 'conflict', state: 'ambiguous', candidates: [...new Set([...partial.candidates, e.variant])], chain: e.chain };
  }
  if (e && e.candidates.length > 1) {
    return { variant: null, sessionId: null, evidence: e.evidence, confidence: 'entry', state: 'ambiguous', candidates: partial ? [...new Set([...partial.candidates, ...e.candidates])] : e.candidates, chain: e.chain };
  }
  if (partial) {
    const hint = entry ? null : activityHint(ctx);
    return { variant: null, sessionId: null, evidence: partial.evidence, confidence: 'env', state: 'ambiguous', candidates: partial.candidates, ...(hint ? { hint } : {}), ...(e?.chain?.length ? { chain: e.chain } : {}) };
  }

  // 退化：活动度只作解释（hint），不产出结论（R6）；链查到了也仍是 unknown（R7）
  const hint = activityHint(ctx);
  if (hint) return { variant: null, sessionId: null, evidence: 'newest-store', confidence: 'heuristic', state: 'unknown', candidates: null, hint, ...(e?.chain?.length ? { chain: e.chain } : {}) };
  return { variant: null, sessionId: null, evidence: 'none', confidence: 'none', state: 'unknown', candidates: null, ...(e?.chain?.length ? { chain: e.chain } : {}) };
}

/** 「最近被改动的是谁」—— 给人看的解释，永远不是结论（R6）。 */
function activityHint(ctx) {
  const installed = ALL_VARIANTS.filter((name) => VARIANTS[name].detect(ctx));
  let best = null;
  for (const v of installed) {
    const t = newestMtime(ctx, v);
    if (t > 0 && (!best || t > best.t)) best = { variant: v, t };
  }
  return best?.variant ?? null;
}

function newestMtime(ctx, variant) {
  let newest = 0;
  const visit = (p, depth) => {
    if (depth < 0) return;
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      return;
    }
    let ents = [];
    try {
      ents = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents.slice(0, 200)) visit(path.join(p, e.name), depth - 1);
  };
  for (const x of VARIANTS[variant].readPaths(ctx)) visit(x.path, x.kind === 'file' ? 0 : 2);
  return newest;
}
