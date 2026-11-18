// test/matrix-home.mjs — 全矩阵共用夹具：造一个「所有可写目标都可用」的临时 home
//
// m7（写入矩阵）与 m50（list 轮次口径）都要同一套落点，共用一份以免两处漂移。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, ROOT_ENV_KEYS, hostEnvSignalKeys } from '../src/hosts.mjs';
import { resolveRoot } from '../src/roots.mjs';
import { ensureDir } from '../src/util.mjs';
import { mkMimoDb, mkMinimaxDb, mkOpencodeDb, mkZcodeDb } from './db-fixtures.mjs';

export const SRC_ID = 'dddddddd-1111-2222-3333-444444444444';

/**
 * 沙箱 env：继承真实环境（PATH / TEMP 等），但抹掉宿主留下的两类痕迹。
 *
 * 为什么必须抹：测试进程自己常跑在宿主里（本机就是 WorkBuddy 桌面端），宿主导出的
 * `WORKBUDDY_CONFIG_DIR` 之类会随 `process.env` 漏进子进程，把 HOME 沙箱整个顶掉。
 * 被测代码是对的（显式根声明 > home 推导，见 program-spec §0 的档位阶梯），
 * 但断言就会读到本机真实会话 —— 测试从「隔离」退化成「看这台机器装了什么」。
 *
 * 两类痕迹分开抹，因为影响不同的出口：**根变量**影响定位（`ROOT_ENV_KEYS`），
 * **身份信号**影响判别（`hostEnvSignalKeys`，如 `WORKBUDDY_APP_VERSION`）。只抹前者时，
 * 同一用例在装了 WorkBuddy 的机器上报 `ambiguous`、在干净 CI 上报 `unknown`。
 */
export function sandboxEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const groups of Object.values(ROOT_ENV_KEYS)) {
    for (const key of [...(groups.env ?? []), ...(groups.pin ?? [])]) delete env[key];
  }
  const signals = hostEnvSignalKeys();
  for (const key of signals.keys) delete env[key];
  for (const key of Object.keys(env)) {
    if (signals.prefixes.some((pre) => key.startsWith(pre))) delete env[key];
  }
  delete env.SESSION_SYNC_DRY_RUN;
  return { ...env, ...extra };
}

// S2b 写门：宿主在本机出现过（配置根真实存在）才允许新建写入 —— 夹具通常只造源侧，
// 要当「导入目标」的宿主得用这个垫出来，等价于真实机器上宿主已安装（哪怕还没跑过第一次）。
export function seedHostSeen(ctx, variants) {
  for (const v of variants) {
    const root = resolveRoot(v, ctx).configRoot;
    if (root) ensureDir(root);
  }
  return ctx;
}

// 照抄真机 %APPDATA%\com.qodercn.app.stable\main.sqlite 的三张表（含 CHECK 约束），
// 让全矩阵顺带校验我们写进宿主的枚举值与必填列
const QODER_CHAT_SESSIONS_DDL = `CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY, origin_session_id TEXT,
  session_kind TEXT NOT NULL DEFAULT 'standard' CHECK (session_kind IN ('standard','sideChat','automationExecution')),
  owner_session_id TEXT, conversation_mode TEXT NOT NULL DEFAULT 'normal' CHECK (conversation_mode IN ('normal','voice')),
  product_mode TEXT NOT NULL DEFAULT 'coding' CHECK (product_mode IN ('coding','general')),
  title TEXT NOT NULL, cwd TEXT NOT NULL, execution_kind TEXT, workspace_id TEXT, git_branch TEXT, model TEXT, permission_mode TEXT,
  additional_direcotries TEXT NOT NULL DEFAULT '{}', extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL, execution_target_json TEXT NOT NULL DEFAULT '{}',
  registration_json TEXT, archived INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMP, deleted_at TIMESTAMP, message_envelope_version INTEGER)`;
const QODER_MESSAGES_DDL = `CREATE TABLE chat_session_messages (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed', feedback TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  role TEXT, message_stream TEXT, voice_session_id TEXT, subtype TEXT, runtime_input_state TEXT, fork_availability TEXT,
  turn_started_at INTEGER, is_compaction_boundary INTEGER, has_visible_content INTEGER, payload_bytes INTEGER, payload_hash TEXT,
  payload_schema_version INTEGER, PRIMARY KEY (session_id, message_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE)`;
const QODER_REVISIONS_DDL = `CREATE TABLE chat_session_history_revisions (
  session_id TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0)`;

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/**
 * 造 claude 源会话。
 * padChars > 0 时**每一轮**的助手回答都灌这么长的文本（一个窗口装不下，且轮次均匀铺满全文件，
 * 中间的轮次既不在 head 也不在 tail 采样区间里）；middleTurns 决定中间额外几轮。
 */
export function makeClaudeSource(home, { padChars = 0, middleTurns = 0 } = {}) {
  const file = path.join(home, '.claude', 'projects', 'D--work-demo', `${SRC_ID}.jsonl`);
  const pad = padChars > 0 ? `\n${'补'.repeat(padChars)}` : '';
  const rows = [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    {
      parentUuid: 'u1',
      type: 'assistant',
      message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: `想一想${pad}` }, { type: 'text', text: `第一轮回答${pad}` }, { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } }] },
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: SRC_ID,
      cwd: 'D:/work/demo',
    },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
  ];
  let prev = 'u2';
  for (let i = 0; i < middleTurns; i += 1) {
    const uid = `um${i}`;
    const aid = `am${i}`;
    const ts = `2026-01-01T00:${String(10 + i).padStart(2, '0')}:00.000Z`;
    rows.push({ parentUuid: prev, type: 'user', message: { role: 'user', content: [{ type: 'text', text: `中间第${i + 1}轮问题` }] }, uuid: uid, timestamp: ts, sessionId: SRC_ID, cwd: 'D:/work/demo' });
    rows.push({ parentUuid: uid, type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `中间第${i + 1}轮回答${pad}` }] }, uuid: aid, timestamp: ts, sessionId: SRC_ID, cwd: 'D:/work/demo' });
    prev = aid;
  }
  rows.push(
    { parentUuid: prev, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }, { type: 'text', text: '（同一轮的第二段用户文本：各家存储分块还是拼接并不一致，必须不影响轮次）' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:04.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
    { parentUuid: 'u3', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `第二轮回答${pad}` }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:05.000Z', sessionId: SRC_ID, cwd: 'D:/work/demo' },
  );
  writeJsonl(file, rows);
  return file;
}

function mkQoderRegistry(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(QODER_CHAT_SESSIONS_DDL);
  db.exec(QODER_MESSAGES_DDL);
  db.exec(QODER_REVISIONS_DDL);
  db.close();
  return file;
}

export function setupHome({ padChars = 0, middleTurns = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-matrix-'));
  makeClaudeSource(home, { padChars, middleTurns });
  const env = {};

  const ocDir = path.join(home, 'ocdata');
  mkOpencodeDb(path.join(ocDir, 'opencode.db'));
  env.OPENCODE_DATA_DIR = ocDir;

  const mmHome = path.join(home, 'mmhome');
  mkMinimaxDb(path.join(mmHome, 'v2', 'sqlite', 'runtime-state.sqlite'));
  env.MINIMAX_HOME = mmHome;

  const zcodeHome = path.join(home, 'zcodehome');
  mkZcodeDb(path.join(zcodeHome, 'cli', 'db', 'db.sqlite'), path.join(zcodeHome, 'v2', 'tasks-index.sqlite'));
  env.ZCODE_HOME = zcodeHome;

  const mimoHome = path.join(home, 'mimohome');
  mkMimoDb(path.join(mimoHome, 'mimocode.db'));
  env.MIMO_HOME = mimoHome;

  const dshHome = path.join(home, 'dshhome');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  env.DSH_HOME = dshHome;

  // CodeBuddy Code CLI：projects/<slug>/<id>.jsonl
  const cbHome = path.join(home, 'cbhome', '.codebuddy');
  fs.mkdirSync(path.join(cbHome, 'projects'), { recursive: true });
  env.CODEBUDDY_CONFIG_DIR = cbHome;

  // CodeBuddy IDE / 插件：扩展历史 Data/<user>/<ide>/<uid>/history
  const cbIdeData = path.join(home, 'cbide', 'Data');
  fs.mkdirSync(path.join(cbIdeData, 'default', 'CodeBuddyIDE', 'history'), { recursive: true });
  env.CODEBUDDY_EXTENSION_DATA = cbIdeData;

  const appData = path.join(home, 'AppData', 'Roaming');
  // qoder：正文根 + 桌面注册表（DDL 与 CHECK 照抄真机，见 m38）
  for (const [dirName, cliRootName] of [['com.qodercn.app.stable', '.qoder-cn'], ['com.qoder.app.stable', '.qoder']]) {
    mkQoderRegistry(path.join(appData, dirName, 'main.sqlite'));
    fs.mkdirSync(path.join(home, cliRootName, 'projects'), { recursive: true });
  }
  fs.mkdirSync(path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(appData, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks'), { recursive: true });

  const ctx = makeCtx({ home, platform: 'win32', appData, env });
  // env 档只盖住了带专用变量的目标；pi / workbuddy / freebuff / cline 族 / claude 这些
  // 走默认根的目标也要垫出配置根，否则全矩阵会被写门按「宿主从没出现过」拦下
  seedHostSeen(ctx, ['pi', 'codex', 'workbuddy-cn', 'workbuddy-intl', 'freebuff', 'cline', 'kilo', 'roo', 'claude', 'antigravity']);
  return { home, ctx };
}
