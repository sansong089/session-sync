// accounts.mjs — 各家宿主的「账号模型」登记表 + 账号发现
//
// 为什么要有这张表（2026-10-30 复核教训）：
// 早先只查会话表里有没有账号列就断言「某些宿主没有账号概念」，那是错的：
// 一是扫描脚本深度参数写错，`~/.minimax/v2/sqlite/…`、`~/.zcode/v2/…` 这类三层深的库整批没打开过（假阴）；
// 二是「有登录态」和「会话按账号分区」是两件事。所有国产宿主都有登录态，
// 决定「切换账号」能不能做的只有后者 —— 所以每个变体都必须在这里有一条**带实测证据路径**的结论，
// 缺项即视为未取证（test/m52 断言覆盖 ALL_VARIANTS），不许用「没找到」代替「没有」。
import fs from 'node:fs';
import path from 'node:path';
import { codebuddyRoot, codexRoot, workbuddyRoot, locatorBase, accountPathsOf } from './hosts.mjs';

const PARTITION = 'partition';

const p = (...parts) => path.join(...parts);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 登录态落点由 locator 声明（根被 env 搬走时它跟着走）；取第一个存在的那份
function accountFile(ctx, variant, order = 0) {
  const list = accountPathsOf(ctx, variant);
  const hit = list.find((x) => x.exists) ?? list[order];
  return hit?.path ?? null;
}

function dirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---- single-account 宿主的登录态读取（只读，读不到就不报，绝不猜）----

function qoderAppDir(ctx, variant) {
  // 桌面产品目录是 locator 声明的（正文在 ~/.qoder-cn，档案在 %APPDATA%\com.qodercn.app.stable，两回事）
  return locatorBase(ctx, variant, 'appDir');
}

function qoderIdentity(ctx, variant) {
  const out = [];
  const ext = readJson(p(qoderAppDir(ctx, variant), 'qoder-data.v1.ext.json'));
  for (const key of Object.keys(ext?.accounts ?? {})) out.push({ id: key, name: null, source: 'qoder-data.v1.ext.json → .accounts' });
  const main = readJson(p(qoderAppDir(ctx, variant), 'qoder-data.v1.json'));
  if (main?.agentAccountScope) {
    const hit = out.find((x) => x.id === main.agentAccountScope);
    if (hit) hit.isCurrent = true;
    else out.push({ id: main.agentAccountScope, name: null, isCurrent: true, source: 'qoder-data.v1.json → agentAccountScope' });
  }
  return out;
}

function minimaxIdentity(ctx) {
  const file = accountFile(ctx, 'minimax');
  if (!file) return [];
  const j = readJson(file);
  const id = j?.auth?.realUserID;
  if (!id) return [];
  return [{ id: String(id), name: j.auth.userName || null, isCurrent: true, source: '~/.minimax/local-runtime.auth.json → auth.realUserID' }];
}

function mimoIdentity(ctx) {
  const file = accountFile(ctx, 'mimo');
  if (!file) return [];
  const confirmed = readJson(file);
  const id = confirmed?.userId;
  if (!id) return [];
  return [{ id: String(id), name: null, isCurrent: true, source: '%APPDATA%/Xiaomi MiMo/xiaomi-last-confirmed.json → userId' }];
}

// ZCode 把账号 uid 直接编在凭据条目的**键名**里（值本身是 enc:v1 密文）：
// project-key-location:v1:<URI 编码的 [endpoint, provider, uid, null, 1, team]>
function zcodeIdentity(ctx) {
  const file = accountFile(ctx, 'zcode');
  if (!file) return [];
  const j = readJson(file);
  const out = [];
  for (const key of Object.keys(j ?? {})) {
    if (!key.startsWith('project-key-location:')) continue;
    let arr;
    try {
      arr = JSON.parse(decodeURIComponent(key.slice(key.indexOf('v1:') + 3)));
    } catch {
      continue;
    }
    const uid = Array.isArray(arr) ? arr[2] : null;
    if (uid) out.push({ id: String(uid), name: arr[1] ?? null, isCurrent: true, source: '~/.zcode/v2/credentials.json → project-key-location 键名' });
  }
  return out;
}

function dshIdentity(ctx) {
  let raw = '';
  try {
    raw = fs.readFileSync(accountFile(ctx, 'dsh'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const m of raw.matchAll(/^\s{2,}([A-Z0-9_]*ACCOUNT[A-Z0-9_]*)\s*:\s*(\S+)/gm)) {
    out.push({ id: m[1], name: m[1].split('_')[0], source: '~/.dsh/.credentials.yaml → refs' });
  }
  return out;
}

function freebuffIdentity(ctx) {
  const file = accountFile(ctx, 'freebuff');
  if (!file) return [];
  const j = readJson(file);
  return Object.entries(j ?? {}).map(([profile, v]) => ({
    id: String(v?.id ?? profile),
    name: v?.email || v?.name || profile,
    isCurrent: profile === 'default',
    source: '~/.config/manicode/credentials.json',
  }));
}

function codebuddyIdentity(ctx) {
  return dirNames(p(codebuddyRoot(ctx).path, 'inspiration'))
    .filter((n) => /^[0-9a-f-]{16,}$/i.test(n))
    .map((uid) => ({ id: uid, name: null, source: '<codebuddy 根>/inspiration/<uid>/' }));
}

// ---- 「本宿主当前登录账号」的探针（写侧归属默认值的唯一来源）----
//
// 为什么必须有这一处：导入的归属绝不能沿用源会话那一行的账号（那是来源宿主命名空间里的 id），
// 而各家「当前登录」的落点完全不同、且都不是「库里有哪些 uid」（刚登录的新账号本来就没有行）。
// 以前 workbuddy 在 writer 里读快照、codex 在 writer 里解 auth.json、accounts 命令再各读一遍，
// 三处漂移就会出现「accounts 报的当前登录」和「import 实际写进去的归属」不是同一个账号。
// 现在探针只写一次，写侧与只读命令共用；读不出来一律返回 null，绝不猜。

// WorkBuddy：`<安装根>/storage/skeleton/account-snapshot.json → primary.uid`（实测两个根都返回同一个 uid）
function workbuddyLogin(ctx, variant) {
  const j = readJson(p(workbuddyRoot(ctx, variant).path, 'storage', 'skeleton', 'account-snapshot.json'));
  const uid = j?.primary?.uid;
  if (typeof uid !== 'string' || !uid) return null;
  const name = typeof j.primary.nickname === 'string' && j.primary.nickname ? j.primary.nickname : null;
  return { variant, id: uid, accountId: null, name, source: 'account-snapshot:primary.uid' };
}

/**
 * Codex：`<CODEX_HOME>/auth.json` 的 `tokens.account_id` + id_token 明文 claims
 * （`https://api.openai.com/auth` 里的 `user_id` / `chatgpt_account_id`）。
 * 这两个值与 threads.creator_user_id / creator_account_id 同源同形（实测形态：`user-` 前缀的 base62 串
 * + 一个 uuid 形态的 org id；本机真实值不在仓里留痕），
 * 所以它是「目标账号是不是我现在登录的这个」的唯一判据。只读，不验签、不打印凭据。
 */
function codexLogin(ctx) {
  const j = readJson(p(codexRoot(ctx).path, 'auth.json'));
  if (!j) return null;
  const out = { variant: 'codex', id: null, accountId: j?.tokens?.account_id ? String(j.tokens.account_id) : null, name: null, source: 'auth.json:tokens.account_id' };
  const seg = String(j?.tokens?.id_token ?? '').split('.');
  if (seg.length >= 2) {
    try {
      const claims = JSON.parse(Buffer.from(seg[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const auth = claims['https://api.openai.com/auth'] ?? {};
      out.id = auth.user_id ? String(auth.user_id) : null;
      if (!out.accountId) out.accountId = auth.chatgpt_account_id ? String(auth.chatgpt_account_id) : null;
      if (out.id || out.accountId) out.source = 'auth.json:id_token claims';
    } catch {
      /* claims 解不出就只用 tokens.account_id */
    }
  }
  if (!out.id && !out.accountId) return null;
  return out;
}

/**
 * 按账号分区（partition）的宿主：归属列/目录的「该填谁」。
 * codebuddy-ide 的分区是**目录层**，而本机没有可信的「当前登录 uid」落点（实测 `Data/Public/auth/*.info`
 * 只有 workbuddy-desktop 的 uid）→ 返回 null，由 --account 点名，绝不拿「哪个目录最新」当登录态。
 * 每一家都必须显式登记在这里（m54 断言 PARTITIONED_VARIANTS ⊆ LOGIN_PROBED_VARIANTS）：
 * 漏登记 = 写侧拿不到默认归属，新宿主就会静默地把归属留空或沿用来源侧的 id。
 */
const CURRENT_LOGIN = {
  'workbuddy-cn': workbuddyLogin,
  'workbuddy-intl': workbuddyLogin,
  codex: (ctx) => codexLogin(ctx),
  'codebuddy-ide': () => null,
};

export const LOGIN_PROBED_VARIANTS = Object.keys(CURRENT_LOGIN);

/**
 * 当前登录账号的唯一出口，任何变体都能问。
 * @returns {{variant:string,id:string,accountId:string|null,name:string|null,source:string}|null}
 *          id 是各家归属列里的那个值；accountId 只有 codex 这类「两列成对」的宿主才带。
 */
export function currentAccount(variant, ctx) {
  const probe = CURRENT_LOGIN[variant];
  if (probe) {
    try {
      return probe(ctx, variant) ?? null;
    } catch {
      return null;
    }
  }
  const model = accountModelOf(variant);
  if (typeof model.identity !== 'function') return null;
  try {
    // identity 可能按变体分叉（qoder 的 cn/intl 各读自己的 %APPDATA% 目录），必须把 variant 传进去
    const hit = (model.identity(ctx, variant) ?? []).find((x) => x.isCurrent);
    return hit ? { variant, id: String(hit.id), accountId: null, name: hit.name ?? null, source: hit.source ?? '登记表 identity' } : null;
  } catch {
    return null;
  }
}

/**
 * 每个变体一条：
 *   kind          partition = 会话/项目可见性真的按账号分区 → switch-account 可用
 *                 single-account = 有登录态，但本地会话行不带账号归属 → 改它不产生可见性变化
 *                 none = 未发现任何账号身份落点
 *   fields        partition 时写清「改哪几处」（列 / 目录 / 头行字段）
 *   projectScoped true = 项目注册表也在账号目录内（切换时必须补 project）
 *   evidence      取证依据（路径 + 实测数字）；不可切的宿主也要能出示
 *   identity      可选：读本机登录态（single-account 用它把账号 id 报出来）
 */
export const ACCOUNT_MODEL = {
  'workbuddy-cn': {
    kind: PARTITION,
    fields: ['sessions.user_id'],
    evidence: '~/.workbuddy/workbuddy.db 的 sessions.user_id（实测数百行，全部同一 uid；uid 为标准 8-4-4-4-12 uuid 形态）；当前登录 uid 取 ~/.workbuddy/storage/skeleton/account-snapshot.json → primary.uid',
    switchNote: '宿主列表谓词是 user_id = 当前登录 AND deleted_at IS NULL；workspaces/projects 目录按安装共享，不需补 project',
  },
  'workbuddy-intl': {
    kind: PARTITION,
    fields: ['sessions.user_id'],
    evidence: '~/.workbuddy-ai/workbuddy.db 的 sessions.user_id（实测同一库里两个 uid 并存，均为 uuid 形态：主账号百余行、次账号十余行）。本机真实 uid 不在仓里留痕，形状与量级即为可核对口径',
    switchNote: '同一库里两账号行并存 = 分区成立的直接实证',
  },
  'codebuddy-ide': {
    kind: PARTITION,
    fields: ['目录层 Data/<user>/<ide>/<uid>/', 'history/<md5(cwd)>/index.json', 'check-point|file-tree|plan-task/<md5(cwd)>/<convId>'],
    projectScoped: true,
    evidence: '%LOCALAPPDATA%\\CodeBuddyExtension\\Data 下每个 uid 一套 history；实测两账号的 md5 workspace key 集合几乎不相交（各自约 6-7 个键、交集只有个别键；键值是项目路径的 md5 前缀，不在仓里留痕）',
    switchNote: '会话正文与四个平行目录都在账号目录内 → 切换 = 搬目录 + 补 project',
  },
  codex: {
    kind: PARTITION,
    fields: ['state_5.sqlite 的 threads.creator_user_id / creator_account_id', 'rollout 首行 session_meta 同名字段'],
    evidence: '~/.codex/state_5.sqlite threads（实测少数行带 creator_*、多数行两列为 NULL —— 只在部分代际/入口写）；活跃账号在 ~/.codex/auth.json，另有 remote_control_enrollments.account_id',
    switchNote: '项目注册表 .codex-global-state.json 的 local-projects 按安装共享 → 补 project 与账号无关',
  },
  'qoder-cn': {
    kind: 'single-account',
    identity: qoderIdentity,
    evidence: '登录态确凿：%APPDATA%\\com.qodercn.app.stable\\qoder-data.v1.ext.json 的 .accounts（实测 2 份档案：local + 一份 qoder:prod:cn: 前缀的长哈希（真实值不留痕））、main.sqlite 的 account_profiles/agent_profiles/agent_runtimes/plugin_inventory_meta 都带 account_id、~/.qoder-cn/.models/<account-uuid>/catalog-v6|v7 是按账号目录。但现行注册表 chat_sessions（百余行）没有任何账号列（owner_session_id distinct=0、registration_json 全 NULL），workspaces 4 行也没有。带账号列的是上一代库 %APPDATA%\\QoderCN\\SharedClientCache\\cache\\db\\local.db（chat_session.user_id 数十行同一个 uid，mtime 停在 2026-10-15 = 已被 main.sqlite 取代，不再被写）',
    hint: '要「在另一个账号里看到它」的可行路径：跨安装导入（import --into qoder-intl），或对齐宿主自己的 sessionMigration.sqlite 台账语义',
  },
  'qoder-intl': {
    kind: 'single-account',
    identity: qoderIdentity,
    evidence: '同 qoder-cn：qoder-data.v1.ext.json/.accounts + agentAccountScope 有账号档案，现行注册表 chat_sessions（个位行）与 workspaces（1 行）都没有账号列；上一代 %APPDATA%\\Qoder\\SharedClientCache\\cache\\db\\local.db 里才有 chat_session.user_id',
    hint: '同 qoder-cn（跨安装导入）',
  },
  mimo: {
    kind: 'single-account',
    identity: mimoIdentity,
    evidence: '库内 account/account_state/control_account 表存在（实测 0 行）；桌面登录态在 %APPDATA%\\Xiaomi MiMo\\model-catalog.json 的 .account 与 xiaomi-last-confirmed.json 的 .userId（实测为 8 位纯数字 id），另有 Electron 分区 Partitions/xiaomi-account。但 mimocode.db 的 session/project 都没有账号列，mimo.projects / mimo.projectRecentUsed 在 localStorage 按安装',
    hint: '账号只决定模型目录与配额，不决定会话可见性',
  },
  minimax: {
    kind: 'single-account',
    identity: minimaxIdentity,
    evidence: '登录态：~/.minimax/local-runtime.auth.json → auth.realUserID（实测为 19 位纯数字 id）、%APPDATA%\\MiniMax\\minimax-agent-cn-config.json 的 .user/.sharedUser、leveldb UNIQUE_USER_ID 与 mavis:account-onboarding-completion:v1:<realUserID>。但 ~/.minimax/v2/sqlite/runtime-state.sqlite 的 local_runtime_sessions 没有账号列',
    hint: '唯一按账号键控的是项目显示别名 mavis.remote-control.project-aliases.v1:<account>（纯展示，非可见性前置）',
  },
  zcode: {
    kind: 'single-account',
    identity: zcodeIdentity,
    evidence: '登录态：~/.zcode/v2/credentials.json 有 oauth:active_provider / oauth:bigmodel:access_token，以及按账号 uid 键控的 project-key-location:v1:[endpoint,provider,<uid>,null,1,"non-team"]。但 ~/.zcode/cli/db/db.sqlite 无 project 表、会话按目录分组；~/.zcode/v2/tasks-index.sqlite 的 tasks 按 workspace_key 分组、无账号列（hosts.membership_id 列存在，本机 1 行 host 值为 NULL）',
    hint: 'membership_id 是宿主预留的账号槽位，写入前需另行取证',
  },
  dsh: {
    kind: 'single-account',
    identity: dshIdentity,
    evidence: '有账号池：~/.dsh/.credentials.yaml 的 refs 里 6 个具名账号引用（BUDDY/QODERCN/TRAE/MINIMAX/LOBSTERAI/CODEARTS _ACCOUNT_xxxxxxxx）+ .anonymous-user-id。但会话体 ~/.dsh/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd 解出来没有账号字段，storages/workspace.json 按 workspace→sessionIds 组织',
    hint: '那是多供应商凭据池（谁付费），不是会话归属',
  },
  freebuff: {
    kind: 'single-account',
    identity: freebuffIdentity,
    evidence: '登录态：~/.config/manicode/credentials.json 的 default.{id,name,email,fingerprintId}（profile 键可多个）。但 ~/.config/manicode/projects/<basename>/chats/<ISO> 没有账号维度',
    hint: '换账号不会改变会话可见性',
  },
  codebuddy: {
    kind: 'single-account',
    identity: codebuddyIdentity,
    evidence: '与 WorkBuddy 同底座：~/.codebuddy/inspiration/<uid>/ 是按账号目录层（实测 uid 与 workbuddy 同源）。但会话正文 ~/.codebuddy/projects/<slug>/<id>.jsonl 行内没有账号字段',
    hint: '会话不带归属；要换账号只能重新导入到目标账号在用的一侧',
  },
  opencode: {
    kind: 'single-account',
    evidence: '库 ~/.local/share/opencode/opencode.db 里 account/account_state/control_account 表存在（实测 0 行），project/session 无账号列',
    hint: '同 MiMo：账号是 provider 凭据，不是会话归属',
  },
  claude: { kind: 'none', evidence: '修正扫描深度后 ~/.claude 与 %APPDATA%/Claude 全库无账号类列/表；会话只有 projects/<cwd-slug>/<id>.jsonl 一层，行内无账号字段' },
  pi: { kind: 'none', evidence: '~/.pi 下会话目录只有 --<cwd>-- 一层（实测 4 个），全库扫描无账号类列/表，也没有凭据文件；宿主按 --slug 目录分组，与登录无关' },
  antigravity: { kind: 'none', evidence: '~/.gemini/antigravity-cli 会话按 <uuid>.db 平铺，修正深度后扫到的 20 个库均无账号类列/表' },
  cursor: { kind: 'none', evidence: '列表源是 %APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb 的 composer KV，无账号维度（cursorAuth/* 只存登录邮箱）' },
  cline: { kind: 'none', evidence: '~/.cline/data/sessions/<id>/ 与会话库 db/sessions.db 的 sessions 表无账号列（谓词是 is_subagent=0 + started_at 排序）；legacy state/taskHistory.json 同' },
  kilo: { kind: 'none', evidence: 'kilo.db（7.8.18+ OpenCode 血统 project/session/message/part）与 ≤5.16.2 的 state.vscdb taskHistory 两代都无账号列；记录里的 workspace 字段是目录不是账号' },
  roo: { kind: 'none', evidence: '~/.roo 与 %APPDATA%/Code/User/globalStorage 里 tasks/ 目录、_index.json、taskHistory 均无账号维度（webview 用 getAll() 不按工作区也不按账号过滤）' },
  doubao: {
    kind: 'single-account',
    evidence: '登录态在云端；本地 %LOCALAPPDATA%\\Doubao\\User Data\\Default\\.doubao\\agent_mode\\workspace\\.sessions 的会话目录按 chatId 平铺、无账号维度，trajectory / assignment 行内也没有账号字段。IndexedDB chrome_doubao-chat_0.indexeddb.leveldb 的列表缓存带 creator 字段（protobuf，未解码）',
    hint: '换账号只影响云端可见性，本地正文不分区',
  },
};

export const PARTITIONED_VARIANTS = Object.entries(ACCOUNT_MODEL)
  .filter(([, m]) => m.kind === PARTITION)
  .map(([v]) => v);

export function accountModelOf(variant) {
  return ACCOUNT_MODEL[variant] ?? { kind: 'unknown', evidence: '未登记：本仓还没对这家的账号模型取证' };
}

// 从读侧摘要里收集「本机见过的账号」：只统计，绝不参与过滤
function accountsFromSessions(variant, ctx, listSessions) {
  const r = listSessions(variant, ctx, {});
  const byId = new Map();
  for (const s of r.sessions ?? []) {
    const id = s.account?.id ?? s.account ?? null;
    if (!id) continue;
    const hit = byId.get(String(id)) ?? { id: String(id), name: s.account?.name ?? null, sessions: 0 };
    hit.sessions += 1;
    byId.set(String(id), hit);
  }
  return { available: r.available !== false, sessions: (r.sessions ?? []).length, accounts: [...byId.values()] };
}

/**
 * 单个变体的账号清单（只读）。
 * partition 且 writer 提供 listAccounts → 用写侧的真实分区（含 ide / 工作区键）；
 * 其余走登录态登记处 + 会话上挂着的账号，读不到就不报，绝不猜。
 */
export function describeAccounts(variant, ctx, { listSessions, getWriter } = {}) {
  const model = accountModelOf(variant);
  const out = { variant, accountModel: model.kind, evidence: model.evidence, fields: model.fields ?? null, projectScoped: !!model.projectScoped, accounts: [], current: null, notes: [] };
  if (model.switchNote) out.notes.push(model.switchNote);
  if (model.hint) out.notes.push(model.hint);
  if (model.kind === 'none' || model.kind === 'unknown') {
    out.skipped = true;
    return out;
  }

  const writer = getWriter?.(variant);
  if (model.kind === PARTITION && typeof writer?.listAccounts === 'function') {
    try {
      const r = writer.listAccounts(ctx);
      if (r?.ok) {
        out.accounts = r.accounts ?? [];
        out.current = r.current ?? currentAccount(variant, ctx);
        for (const w of r.warnings ?? []) out.notes.push(w);
        return out;
      }
      if (r?.error) out.notes.push(`listAccounts: ${r.error}`);
    } catch (err) {
      out.notes.push(`listAccounts-failed: ${String(err?.message ?? err)}`);
    }
  }
  if (typeof model.identity === 'function') {
    try {
      const ids = model.identity(ctx, variant) ?? [];
      if (ids.length) out.accounts = ids;
    } catch {
      /* 登录态读不出来就只报会话侧统计 */
    }
  }
  // 「当前登录」一律走同一个出口，不再从 accounts 列表里 find(isCurrent) ——
  // 两处各挑一次就会出现「列出来的账号」和「写侧用的归属」不是同一个。
  out.current = currentAccount(variant, ctx);
  if (listSessions) {
    const seen = accountsFromSessions(variant, ctx, listSessions);
    for (const s of seen.accounts) {
      if (!out.accounts.some((a) => String(a.id) === s.id)) out.accounts.push(s);
    }
    out.sessionCount = seen.sessions;
    if (seen.available === false) out.notes.push('本机未安装该变体（读不到会话）');
  }
  return out;
}

export { readJson, dirNames, p, PARTITION };
