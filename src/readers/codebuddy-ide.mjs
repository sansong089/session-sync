// readers/codebuddy-ide.mjs — CodeBuddy IDE / VS Code 插件（共用 tencent-cloud.coding-copilot）
//
// 存储：<Data>/<user>/<ide>/<uid>/history/<md5(workspace)>/
//   index.json                 {conversations:[{id,type,name,createdAt,lastMessageAt}], current}
//   <conversationId>/index.json {messages:[{id,type,role,isComplete}], requests}
//   <conversationId>/messages/<messageId>.json
//     {role, message: "<JSON string>", id, extra: "<JSON string>"}
//     message.content[]：text / reasoning / tool-call / tool-result
// cwd：首条 user 文本里的 <user_info> Workspace Folder: ...（宿主注入）；缺失时用 md5→路径索引兜底
// 同一会话可能同时存在于多个账户/IDE 的 Data 下：读、写两侧统一按
// 「消息更多 → 更新时间更晚」选同一份（codebuddyPickBest），否则 list 与 show/append 会指向不同副本。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { codebuddyExtensionDataRoot } from '../hosts.mjs';
import { outputText } from '../text.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  finalizeSession,
} from '../ir.mjs';
import { applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, safeJson, toMs, fileMtime, inTimeRange } from './base.mjs';
import { canonicalDirPath, cmpPath } from '../util.mjs';

function dataRoot(ctx) {
  return codebuddyExtensionDataRoot(ctx).path;
}

// Data/<user>/<ide>/<uid>/history 或 Data/<user>/<ide>/history（default 账户没有 uid 层）
function historyDirs(ctx) {
  const root = dataRoot(ctx);
  if (!fs.existsSync(root)) return [];
  return dirsNamedHistory(root);
}

export function codebuddyExtensionHistoryDirs(ctx) {
  return historyDirs(ctx);
}

export function codebuddyWorkspaceKey(cwd) {
  // 宿主记的路径形态：盘符**小写** + 正斜杠（VS Code 的 URI 形态 `d:/...`，本机 368 条实测），
  // md5 取的就是这个形态（normalize 只把 / 折成 \，不动字母大小写）——
  // 真机核对：现网 60 个 history 目录里 58 个与本式哈希逐字相等。
  // 盘符大小写对不上 = 另一个 md5 = 另一个 history 目录 = 侧栏两个同名项目。
  return md5(nativeNorm(canonicalDirPath(cwd, { driveCase: 'lower' })));
}

/**
 * 工作区键（md5）解析：优先复用宿主**自己那个**目录键，认领不到才按规范形态现算。
 *
 * 宿主的项目键是 md5(cwd)：源 agent 记的盘符大小写与宿主自己记的不一致时
 * （Windows 上 process.cwd() 把盘符变大写），算出来是另一个 md5 → 写进另一个
 * history 目录 → 侧栏两个同名项目。md5 不可逆，不能像 slug 那样「按名字复用」，
 * 只能借宿主登记过的「md5 → 目录」对照表认领。
 *
 * 取值顺序：
 *   ① 盘上 history 目录里存在、且对照表指向我们的目录的那个键（宿主自己那个）；
 *   ② 对照表里指向我们目录的键（宿主登记过、目录还没建）；
 *   ③ 规范形态（盘符大写 + 原生分隔符）现算。
 */
export function resolveCodebuddyWorkspaceKey(ctx, history, cwd) {
  const canonical = canonicalDirPath(cwd);
  if (!canonical) return null;
  const want = cmpPath(canonical);
  const index = workspaceIndex(ctx);
  let dirs = [];
  try {
    dirs = fs.readdirSync(history, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const p = index.get(dir);
    if (p && cmpPath(p) === want) return dir;
  }
  for (const [key, p] of index) {
    if (cmpPath(p) === want) return key;
  }
  return codebuddyWorkspaceKey(canonical);
}

function dirsNamedHistory(root) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'history') out.push(full);
      else if (depth < 4) stack.push([full, depth + 1]);
    }
  }
  return out.sort();
}

const nativeNorm = (p) => path.normalize(String(p));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function safeB64(s) {
  // 目录名是 base64url（- _）与标准 base64（+ /）的混合形态，两种都要认
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64').toString('utf8');
}

// md5 → 工作区路径：v1 genie-history 的 base64 目录 + 各 IDE 的 workspaceStorage/workspace.json
export function workspaceIndexFor(ctx) {
  return workspaceIndex(ctx);
}

function workspaceIndex(ctx) {
  const map = new Map();
  const add = (p) => {
    const v = String(p ?? '').trim();
    if (v) map.set(codebuddyWorkspaceKey(v), v);
  };
  const ideUsers = ['Code', 'Cursor', 'CodeBuddy', 'CodeBuddy CN', 'CodeBuddyIDE', 'VSCodium', 'Windsurf'];
  const appData = ctx.appData; // 扩展 Data 根本身走 locator（root: codebuddyExtensionDataRoot），这里只是扫兄弟目录
  for (const ide of ideUsers) {
    const gh = path.join(appData, ide, 'User', 'globalStorage', 'tencent-cloud.coding-copilot', 'genie-history');
    if (fs.existsSync(gh)) {
      for (const d of fs.readdirSync(gh)) {
        try {
          const decoded = safeB64(d);
          if (decoded) add(decoded);
        } catch {
          /* 非 base64 目录 */
        }
      }
    }
    const ws = path.join(appData, ide, 'User', 'workspaceStorage');
    if (fs.existsSync(ws)) {
      for (const d of fs.readdirSync(ws)) {
        const f = path.join(ws, d, 'workspace.json');
        try {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (j.folder) add(decodeURIComponent(String(j.folder).replace(/^file:\/\/\//, '')));
        } catch {
          /* 没有 workspace.json */
        }
      }
    }
  }
  return map;
}

function messageBlocks(raw) {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }];
  if (Array.isArray(raw)) return raw;
  return [];
}

function entriesOf(convDir, orderedIds) {
  const messagesDir = path.join(convDir, 'messages');
  if (!fs.existsSync(messagesDir)) return { entries: [], model: null, workspaceCwd: '' };
  const ids = Array.isArray(orderedIds) && orderedIds.length ? orderedIds : fs.readdirSync(messagesDir).map((f) => f.replace(/\.json$/i, ''));
  const entries = [];
  let model = null;
  let workspaceCwd = '';

  for (const id of ids) {
    const file = path.join(messagesDir, `${id}.json`);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const extra = safeJson(raw.extra, {}) || {};
    if (!model && extra.modelId) model = String(extra.modelId);
    const payload = safeJson(raw.message, null);
    if (!payload) continue;
    const role = payload.role ?? raw.role;
    if (role === 'user') {
      const items = [];
      for (const b of messageBlocks(payload.content)) {
        if (b?.type === 'text' && b.text) {
          if (!workspaceCwd) {
            const m = String(b.text).match(/Workspace Folder:\s*([^\r\n<]+)/i);
            if (m) workspaceCwd = m[1].trim();
          }
          const text = stripSystemInjections(b.text);
          if (text) items.push(messageItem('user', text, 0));
        }
      }
      if (items.length) entries.push({ role: 'user', items });
      continue;
    }
    if (role === 'assistant' || role === 'tool') {
      const items = [];
      for (const b of messageBlocks(payload.content)) {
        if (b?.type === 'text' && b.text) items.push(messageItem('assistant', String(b.text), 0));
        else if (b?.type === 'reasoning' && b.text) items.push(reasoningItem(String(b.text), 0));
        else if (b?.type === 'tool-call') items.push(toolCallItem(b.toolCallId ?? null, b.toolName ?? b.name ?? 'tool', b.args ?? b.input ?? null, 0));
        else if (b?.type === 'tool-result') items.push(toolResultItem(b.toolCallId ?? null, b.toolName ?? 'tool', b.isError ? 'error' : 'ok', outputText(b.result), 0));
      }
      if (items.length) entries.push({ role: 'assistant', items });
    }
  }
  return { entries, model, workspaceCwd };
}

function cwdFromEntries(wsKey, wsIndex, workspaceCwd = '') {
  return workspaceCwd || wsIndex.get(wsKey) || '';
}

// history 目录的父级是 uid，再上一级才是 IDE 名；default 账户没有 uid 层
function ideNameOf(historyDir) {
  const segs = String(historyDir).split(/[\\/]/);
  const h = segs.lastIndexOf('history');
  const before = h > 0 ? segs[h - 1] : '';
  if (h > 1 && /^[0-9a-f-]{16,}$/i.test(before)) return segs[h - 2];
  return before;
}

// 这一家的账户目录层用 uuid（实测与 WorkBuddy 同源）；base64 形态的层名不是账号
const UID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

/** 账号 uid = `<user>/<ide>/<uid>/history` 里紧邻 history 的那一段；default 层没有 → null */
export function codebuddyAccountOf(historyDir) {
  const segs = String(historyDir).split(/[\\/]/);
  const h = segs.lastIndexOf('history');
  if (h < 1) return null;
  const seg = segs[h - 1];
  return UID_SEGMENT.test(seg) ? seg : null;
}

/**
 * 账号目录坐标：{user, ide, uid, canonical}（uid = null 表示 default 账号层，没有账号目录）。
 * 写侧「切到目标账号」要靠它拼出 `<Data>/<user>/<ide>/<uid>/history`。
 * 实测还有第四种层（`Data/default/CodeBuddyIDE/<base64(工作区路径)>/history`、genie 别名层）：
 * 那些层里确实有会话，但它们不是账号坐标 → canonical=false，只列不选。
 */
export function codebuddyRootCoords(historyDir, dataRoot) {
  const rel = path.relative(dataRoot, historyDir);
  const segs = rel.split(/[\\/]/).filter(Boolean);
  const h = segs.lastIndexOf('history');
  if (h < 1) return null;
  const seg = segs[h - 1];
  if (UID_SEGMENT.test(seg)) {
    const ide = segs[h - 2];
    const user = segs[h - 3] ?? segs[0];
    if (!ide || !user) return null;
    return { user, ide, uid: seg, canonical: true };
  }
  // <user>/<ide>/history 形态（default 账号层）
  const ide = seg;
  const user = segs[h - 2];
  if (!user) return null;
  return { user, ide, uid: null, canonical: h === 2 };
}

/**
 * 扫描所有账户/IDE 的 history，返回 id → 全部副本（含目录坐标与消息数），
 * 供 list/read 与写侧 findConversation 共用同一次判定。
 */
export function codebuddyConversationMap(ctx) {
  const map = new Map();
  for (const dir of historyDirs(ctx)) {
    let wss = [];
    try {
      wss = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const ws of wss) {
      const wsIndexFile = path.join(dir, ws, 'index.json');
      let wsIdx;
      try {
        wsIdx = JSON.parse(fs.readFileSync(wsIndexFile, 'utf8'));
      } catch {
        continue;
      }
      for (const conv of wsIdx.conversations ?? []) {
        const convDir = path.join(dir, ws, String(conv.id));
        const convIndexFile = path.join(convDir, 'index.json');
        let convIndex;
        try {
          convIndex = JSON.parse(fs.readFileSync(convIndexFile, 'utf8'));
        } catch {
          continue;
        }
        const ordered = (convIndex.messages ?? []).map((m) => String(m.id));
        const copy = {
          id: String(conv.id),
          dir,
          ws,
          wsIndexFile,
          wsEntry: conv,
          convDir,
          convIndexFile,
          convIndex,
          ordered,
          messageCount: ordered.length,
          createdAt: toMs(conv.createdAt) || 0,
          updatedAt: toMs(conv.lastMessageAt) || fileMtime(convIndexFile),
        };
        const arr = map.get(copy.id);
        if (arr) arr.push(copy);
        else map.set(copy.id, [copy]);
      }
    }
  }
  return map;
}

export function codebuddyPickBest(copies) {
  let best = null;
  for (const c of copies ?? []) {
    if (!best || c.messageCount > best.messageCount || (c.messageCount === best.messageCount && c.updatedAt > best.updatedAt)) best = c;
  }
  return best;
}

function accountOf(historyDir, variant = 'codebuddy-ide') {
  const id = codebuddyAccountOf(historyDir);
  return id ? { variant, id, name: null } : null;
}

/** 会话所属账号目录的坐标标签，供 list/show 与写侧「按账号取副本」共用 */
function copyLabel(copy) {
  return { account: accountOf(copy.dir), ide: ideNameOf(copy.dir), ws: copy.ws, messageCount: copy.messageCount, path: copy.convDir };
}

function rowFromCopy(copy, wsIndex, copies = []) {
  const { entries, model, workspaceCwd } = entriesOf(copy.convDir, copy.ordered);
  const cwd = cwdFromEntries(copy.ws, wsIndex, workspaceCwd);
  const turns = assembleTurns(entries.map((e) => ({ ...e, ts: copy.createdAt || 0 })));
  return {
    id: copy.id,
    variant: 'codebuddy-ide',
    title: String(copy.wsEntry?.name ?? '').trim() || deriveTitle('', turns),
    cwd,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    turns: turns.length,
    model,
    provenance: readSidecarProvenance(copy.convIndexFile),
    sourcePath: copy.convIndexFile,
    source: 'db',
    // 账号只作展示与写侧归属，读侧绝不按它过滤（D3）
    account: accountOf(copy.dir),
    // 同一 id 可能同时存在于多个账号/IDE 缓存里：把全部副本坐标带出来，
    // 用户才看得见「这条在哪几处、哪处最全」，switch-account 也按坐标选源/目标副本
    copies: copies.map(copyLabel),
  };
}

/**
 * 按**指定副本**解码成 IR（不按 best 猜）。
 * 写侧 append/verify 与 switch-account 必须走这条路径，否则同 id 多副本时会解到另一份上。
 */
export function readCopyAsIr(ctx, copy, wsIndex = workspaceIndex(ctx)) {
  const { entries, model, workspaceCwd } = entriesOf(copy.convDir, copy.ordered);
  const cwd = cwdFromEntries(copy.ws, wsIndex, workspaceCwd);
  const turns = assembleTurns(entries.map((e) => ({ ...e, ts: copy.createdAt || 0 })));
  const session = makeSession({
    id: copy.id,
    variant: 'codebuddy-ide',
    title: deriveTitle(String(copy.wsEntry?.name ?? '').trim(), turns),
    cwd,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
    model,
    account: accountOf(copy.dir),
    turns,
    meta: { sourcePath: copy.convIndexFile, ide: ideNameOf(copy.dir), historyRoot: copy.dir },
  });
  applyProvenanceToIR(session, readSidecarProvenance(copy.convIndexFile));
  return finalizeSession(session);
}

export const codebuddyIdeReader = {
  variant: 'codebuddy-ide',
  label: 'CodeBuddy IDE / 插件',

  available(ctx) {
    return fs.existsSync(dataRoot(ctx));
  },

  list(ctx, opts = {}) {
    const wsIndex = workspaceIndex(ctx);
    const out = [];
    for (const copies of codebuddyConversationMap(ctx).values()) {
      const best = codebuddyPickBest(copies);
      if (best) out.push(rowFromCopy(best, wsIndex, copies));
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const best = codebuddyPickBest(codebuddyConversationMap(ctx).get(String(id)));
    return best ? readCopyAsIr(ctx, best) : null;
  },
};
