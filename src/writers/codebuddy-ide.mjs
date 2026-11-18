// writers/codebuddy-ide.mjs — 写 CodeBuddy IDE / VS Code 插件的本地历史
//
// 产出：<history>/<md5(workspace)>/index.json（新增 conversation 条目）
//       <history>/<md5>/<conversationId>/index.json（messages + requests）
//       <history>/<md5>/<conversationId>/messages/<messageId>.json
// 行/块形状按真实扩展缓存（2026-10-29 取证）：
//   message.content[]：text / reasoning / tool-call{toolCallId,toolName,args}
//                     / tool-result{toolCallId,toolName,result,isError}
// provenance：conversation 目录下的 index.json.session-sync.json（宿主只读自己的文件）
import fs from 'node:fs';
import path from 'node:path';
import { codebuddyExtensionDataRoot } from '../hosts.mjs';
import { writeRootOf } from '../roots.mjs';

// 扩展数据根按 role 取（声明层已登记 CODEBUDDY_EXTENSION_DATA）：根被 --data-root / env 搬走时写侧跟着走
function codebuddyIdeDataRoot(ctx) {
  return writeRootOf('codebuddy-ide', ctx, 'data')?.path ?? codebuddyExtensionDataRoot(ctx);
}
import { ensureDir } from '../util.mjs';
import { accountIdOf } from '../placement.mjs';
import { sessionCoreFingerprints } from '../ir.mjs';
import { readJsonFileSafe, writeJsonFilePretty, backupIfExists, backupPathFor, newNodeId } from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { readSidecarProvenance, writeSidecarProvenance } from '../provenance.mjs';
import {
  codebuddyConversationMap,
  codebuddyPickBest,
  codebuddyExtensionHistoryDirs,
  codebuddyWorkspaceKey,
  resolveCodebuddyWorkspaceKey,
  codebuddyAccountOf,
  codebuddyRootCoords,
  readCopyAsIr,
  workspaceIndexFor,
} from '../readers/codebuddy-ide.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';

const newId = () => newNodeId().replace(/-/g, '');

// 宿主在账号目录内还按同一个 <md5(cwd)>/<convId> 坐标存这三样：
// 只搬 history 会把这条会话的检查点 / 文件树 / 计划任务留在旧账号里。
const COMPANION_DIRS = ['check-point', 'file-tree', 'plan-task'];

// 同一 ctx 的一次导入里反复按 targetId 找会话：扫一遍 conv 索引即可，不必每条都全盘重扫
const conversationCache = new WeakMap();

function conversationMapFor(ctx) {
  let map = conversationCache.get(ctx);
  if (!map) {
    map = codebuddyConversationMap(ctx);
    conversationCache.set(ctx, map);
  }
  return map;
}

function invalidateConversations(ctx) {
  conversationCache.delete(ctx);
}

function findConversation(ctx, targetId) {
  const best = codebuddyPickBest(conversationMapFor(ctx).get(String(targetId)));
  if (best) return { history: best.dir, ws: best.ws, conv: best.convDir };
  // 索引坏了（或工作区 index 读不出）但会话目录还在：仍按 id 找回，
  // 否则 create/append 会在新落点再起一份，旧目录变孤儿
  for (const dir of codebuddyExtensionHistoryDirs(ctx)) {
    for (const ws of safeReaddir(dir)) {
      const conv = path.join(dir, ws, String(targetId));
      if (fs.existsSync(conv)) return { history: dir, ws, conv };
    }
  }
  return null;
}

// 目标 history 根：测试/沙箱用 CODEBUDDY_EXTENSION_HISTORY；
// 否则按**账号/IDE 坐标**选（见 resolveHistoryRoot 的取舍说明）。
// 给了 --account 时：只在**该账号本机已有 history** 时按它走；
// 账号目录本来不存在却为导入凭空造一棵，等于替用户决定「这个账号在这台机器上开过什么」，
// 那是 switch-account 的活（它会明确告警 target-root-derived）。

/**
 * 目标 history 根的坐标解析。返回 `{ dir, why }`，dir 为 null 时 why 说明该补什么。
 *
 * 旧实现取「index.json 最近被改动的那份」。那是拿**活动度**做落点决策：
 * 多账号并存时写进「最近在用」的那个账号，很久没打开的账号会被当成不存在 ——
 * 用户以为导进了 B，实际进了 A，而且没有任何告警。活动度只能解释「哪个在用」，
 * 解释不了「该写到哪儿」。
 *
 * 现在的口径：
 *   1. 钉住（`CODEBUDDY_EXTENSION_HISTORY`）最高优先；
 *   2. `--account` 指定且本机有该账号 → 用它；
 *   3. 本机只有一个账号坐标 → 用它（指定了别的账号时写侧会告警 account-root-unmatched，
 *      「不擅自改道」的语义保留：宁可写进唯一那份 + 明确告警，也不凭空造目录）；
 *   4. 多个账号坐标并存且没有 `--account` → 不猜，报 account-ambiguous 让用户点名；
 *   5. 一个坐标都没有（本机从没开过这个 IDE）→ 按 user/ide 坐标派生（首次启动时就该长这样）。
 */
function resolveHistoryRoot(ctx, account = null) {
  const pinned = String(ctx.env.CODEBUDDY_EXTENSION_HISTORY || '').trim();
  if (pinned) return { dir: pinned, why: null };
  const uid = accountIdOf(account);
  const roots = accountHistoryRoots(ctx).filter((r) => r.canonical);
  if (uid) {
    const hit = roots.filter((r) => (String(uid).toLowerCase() === 'default' ? r.uid === null : r.uid === uid));
    if (hit.length) return { dir: hit[0].dir, why: null };
  }
  if (roots.length === 1) return { dir: roots[0].dir, why: null };
  if (roots.length > 1) return { dir: null, why: uid ? 'account-not-found' : 'account-ambiguous' };
  return { dir: derivedHistoryRoot(ctx), why: null };
}

/**
 * 账号坐标 → history 目录（宿主两处同名：`Data/<uid>/<ide>/<uid>/history`；default 账号没有 uid 层）。
 * 派生坐标只有这一处：「本机还没有这一层」与「本机从没开过这个 IDE」拼的是同一种形状，
 * 各拼一遍就会出现「switch 造的位置和 import 造的不一样」。
 */
function historyDirFor(data, { user = 'default', ide = null, uid = null } = {}) {
  const ideName = String(ide || 'CodeBuddyIDE').trim() || 'CodeBuddyIDE';
  const want = String(uid ?? '').trim();
  if (!want || want.toLowerCase() === 'default') return path.join(data, String(user || 'default'), ideName, 'history');
  return path.join(data, want, ideName, want, 'history');
}

/** 本机还没生成过任何账号目录时的派生坐标（首次启动就是这个形状） */
function derivedHistoryRoot(ctx) {
  const ide = String(ctx.env.CODEBUDDY_EXTENSION_IDE || 'CodeBuddyIDE').trim() || 'CodeBuddyIDE';
  const user = String(ctx.env.CODEBUDDY_EXTENSION_USER || 'default').trim() || 'default';
  const data = codebuddyIdeDataRoot(ctx);
  // 非 default 的 user 层被宿主当成 uid 用（两处同名），所以这里把 user 当 uid 传
  return historyDirFor(data, { ide, uid: user === 'default' ? null : user });
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function backupConversation(ctx, conv) {
  const dest = backupPathFor(ctx, 'codebuddy-ide', conv);
  ensureDir(path.dirname(dest));
  fs.cpSync(conv, dest, { recursive: true });
  return dest;
}

function resultValue(output) {
  return output == null ? '' : output;
}

// 一轮 → 消息文件 + 该轮的 request
function buildTurnMessages(turn, session) {
  const messages = [];
  const requestId = newId();
  let assistant = null;
  let tools = null;
  const flushAssistant = () => {
    if (assistant?.blocks.length) messages.push({ role: 'assistant', blocks: assistant.blocks, requestId });
    assistant = null;
  };
  const flushTools = () => {
    if (tools?.blocks.length) messages.push({ role: 'tool', blocks: tools.blocks, requestId });
    tools = null;
  };
  let user = null;
  const flushUser = () => {
    if (user?.blocks.length) messages.push({ role: 'user', blocks: user.blocks, requestId });
    user = null;
  };
  const pushUser = (b) => {
    if (!user) user = { blocks: [] };
    user.blocks.push(b);
  };
  const pushAssistant = (b) => {
    if (!assistant) assistant = { blocks: [] };
    assistant.blocks.push(b);
  };
  const pushTool = (b) => {
    if (!tools) tools = { blocks: [] };
    tools.blocks.push(b);
  };

  for (const it of turn.items ?? []) {
    const isUserText = it.kind === 'message' && it.role === 'user';
    if (isUserText) {
      flushAssistant();
      flushTools();
      if (it.text) pushUser({ type: 'text', text: it.text });
      continue;
    }
    if (it.kind !== 'tool_result') flushUser();
    switch (it.kind) {
      case 'message':
        if (it.text) pushAssistant({ type: 'text', text: it.text });
        break;
      case 'reasoning':
        if (it.text) pushAssistant({ type: 'reasoning', text: it.text });
        break;
      case 'tool_call':
        flushTools();
        pushAssistant({ type: 'tool-call', toolCallId: it.callId || newId(), toolName: it.name || 'tool', args: it.input ?? {} });
        break;
      case 'tool_result':
        flushAssistant();
        pushTool({ type: 'tool-result', toolCallId: it.callId || null, toolName: it.name || 'tool', result: resultValue(it.output), isError: it.status === 'error' });
        break;
      case 'attachment':
        if (it.ref) pushAssistant({ type: 'text', text: `[attachment] ${it.ref}` });
        break;
      default:
        break;
    }
  }
  flushUser();
  flushAssistant();
  flushTools();

  return messages.map((m) => {
    const id = newId();
    return {
      id,
      role: m.role,
      file: {
        role: m.role,
        message: JSON.stringify({ role: m.role, content: m.blocks }),
        id,
        extra: JSON.stringify({ requestId, modelId: session.model || 'session-sync', modelName: session.model || 'session-sync', isHelperMessage: false }),
      },
    };
  });
}

// injectCwd 只给会话首条 user 消息用：append 进已有会话时首条消息早已带过 user_info，
// 再注入会用「本次落点/源目录」覆盖宿主里的既有归属，读回 cwd 也就跟着漂移
function buildConversation(session, turns, { injectCwd = true } = {}) {
  const indexMessages = [];
  const requests = [];
  const files = [];
  let injectedCwd = !injectCwd;
  for (const turn of turns) {
    const msgs = buildTurnMessages(turn, session);
    if (!injectedCwd) {
      // 宿主自己的首条 user 消息带 <user_info> Workspace Folder: …；写侧照抄，
      // 读侧才能从缓存本身恢复 cwd（workspace 目录名是 md5，不可逆）
      for (const m of msgs) {
        if (m.role !== 'user') continue;
        const parsed = JSON.parse(m.file.message);
        const textBlock = (parsed.content ?? []).find((b) => b.type === 'text');
        if (textBlock) {
          textBlock.text = `<user_info>\nWorkspace Folder: ${session.cwd}\n</user_info>\n\n${textBlock.text}`;
          m.file.message = JSON.stringify(parsed);
          injectedCwd = true;
        }
        break;
      }
    }
    const ids = msgs.map((m) => m.id);
    requests.push({ id: newId(), type: 'craft', messages: ids, state: 'complete', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, lastTokens: 0 } });
    for (const m of msgs) {
      indexMessages.push({ id: m.id, type: 'text', role: m.role, isComplete: true });
      files.push(m);
    }
  }
  return { messages: indexMessages, requests, files };
}

function rewriteConversationCwd(conv, cwd) {
  const indexFile = path.join(conv, 'index.json');
  const index = readJsonFileSafe(indexFile, null);
  if (!index || !Array.isArray(index.messages)) return;
  for (const m of index.messages) {
    if (m.role !== 'user') continue;
    const file = path.join(conv, 'messages', `${m.id}.json`);
    const raw = readJsonFileSafe(file, null);
    if (!raw) continue;
    let payload;
    try {
      payload = JSON.parse(raw.message);
    } catch {
      return;
    }
    const block = (Array.isArray(payload.content) ? payload.content : []).find((b) => b.type === 'text');
    if (!block || typeof block.text !== 'string') return;
    block.text = block.text.replace(/Workspace Folder:\s*[^\r\n<]+/i, `Workspace Folder: ${cwd}`);
    raw.message = JSON.stringify(payload);
    writeJsonFilePretty(file, raw);
    return;
  }
}

// 目录搬迁：先备份会话目录（宿主扫描根之外），再 move，并同步新旧工作区索引
function moveConversation(ctx, found, directory, targetId, opts = {}) {
  // 目标根可换：跨账号切换时 destHistory 指向另一个账号目录，同根同 key 才算「没动」
  const destHistory = opts.destHistory ?? found.history;
  const key = resolveCodebuddyWorkspaceKey(ctx, destHistory, directory) ?? codebuddyWorkspaceKey(directory);
  const samePlace = key === found.ws && path.resolve(destHistory) === path.resolve(found.history);
  if (samePlace) return { moved: false, history: found.history, ws: found.ws, conv: found.conv, backup: null, warning: null };
  const backup = backupConversation(ctx, found.conv);
  const destDir = path.join(destHistory, key);
  ensureDir(destDir);
  const dest = path.join(destDir, String(targetId));
  // copyOnly = --keep-source：在目标账号另建一份，源账号那份留着（宿主两处都会列出来）
  if (opts.copyOnly) {
    if (path.resolve(found.conv) !== path.resolve(dest)) fs.cpSync(found.conv, dest, { recursive: true });
    const companionWarnings = copyCompanions(found.history, destHistory, key, targetId);
    return { moved: true, history: destHistory, ws: key, conv: dest, backup, warning: `copied: ${found.conv} → ${dest}`, companionWarnings };
  }
  try {
    fs.renameSync(found.conv, dest);
  } catch {
    fs.cpSync(found.conv, dest, { recursive: true });
    fs.rmSync(found.conv, { recursive: true, force: true });
  }
  rewriteConversationCwd(dest, directory);
  const oldIndexFile = path.join(found.history, found.ws, 'index.json');
  const oldIndex = readJsonFileSafe(oldIndexFile, { conversations: [], current: '' }) ?? { conversations: [], current: '' };
  const entry = (oldIndex.conversations ?? []).find((c) => String(c.id) === String(targetId));
  oldIndex.conversations = (oldIndex.conversations ?? []).filter((c) => String(c.id) !== String(targetId));
  if (String(oldIndex.current) === String(targetId)) oldIndex.current = oldIndex.conversations[0]?.id ?? '';
  backupIfExists(oldIndexFile, ctx, 'codebuddy-ide');
  writeJsonFilePretty(oldIndexFile, oldIndex);
  const newIndexFile = path.join(destDir, 'index.json');
  const newIndex = readJsonFileSafe(newIndexFile, { conversations: [], current: '' }) ?? { conversations: [], current: '' };
  const kept = (newIndex.conversations ?? []).filter((c) => String(c.id) !== String(targetId));
  kept.push(entry ?? { id: String(targetId), type: 'craft', name: String(targetId), createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() });
  backupIfExists(newIndexFile, ctx, 'codebuddy-ide');
  writeJsonFilePretty(newIndexFile, { ...newIndex, conversations: kept, current: String(targetId) });
  const companionWarnings = moveCompanions(found.history, destHistory, key, targetId);
  return { moved: true, history: destHistory, ws: key, conv: dest, backup, warning: `relocated: ${found.conv} → ${dest}`, companionWarnings };
}

// history 的上一级就是账号目录，那级邻居目录与 history 用同一个 <md5>/<convId> 坐标
function accountRootOf(historyDir) {
  return path.dirname(String(historyDir));
}

function moveCompanions(srcHistory, destHistory, key, targetId) {
  const out = [];
  const srcRoot = accountRootOf(srcHistory);
  const dstRoot = accountRootOf(destHistory);
  for (const name of COMPANION_DIRS) {
    const src = path.join(srcRoot, name, key, String(targetId));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dstRoot, name, key, String(targetId));
    if (path.resolve(src) === path.resolve(dst)) continue;
    ensureDir(path.dirname(dst));
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    out.push(`companion-moved: ${name}`);
  }
  return out;
}

function copyCompanions(srcHistory, destHistory, key, targetId) {
  const out = [];
  const srcRoot = accountRootOf(srcHistory);
  const dstRoot = accountRootOf(destHistory);
  for (const name of COMPANION_DIRS) {
    const src = path.join(srcRoot, name, key, String(targetId));
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dstRoot, name, key, String(targetId));
    if (path.resolve(src) === path.resolve(dst)) continue;
    ensureDir(path.dirname(dst));
    fs.cpSync(src, dst, { recursive: true });
    out.push(`companion-copied: ${name}`);
  }
  return out;
}

/** 本机现存的「账号目录 → history 根」坐标表（default 账号层没有 uid 段；别名/base64 层 canonical=false） */
function accountHistoryRoots(ctx) {
  const data = codebuddyIdeDataRoot(ctx);
  const out = [];
  for (const dir of codebuddyExtensionHistoryDirs(ctx)) {
    const c = codebuddyRootCoords(dir, data);
    if (c) out.push({ dir, ...c });
  }
  return out;
}

/**
 * 解析目标账号的 history 根。三种情况：
 *   1) 该账号本机已有 history → 直接用（给了 --ide 就按 ide 收窄）
 *   2) 该账号本机没有、但它从没开过这个 IDE → 按源副本的 <user>/<ide> 段派生路径（不存在则由 moveConversation 建）
 *   3) `default` = 没有 uid 层的账号目录（实测宿主就有这一层）
 * pinned（CODEBUDDY_EXTENSION_HISTORY）仍最高优先，但落在目标账号之外时明确告警，不悄悄改道。
 * 只认 canonical 层：`Data/default/<ide>/<base64(工作区)>/history` 那种别名层里也有会话，
 * 但它不是账号坐标，当目标会把正文写进宿主不扫的位置。
 */
function resolveAccountHistoryRoot(ctx, uid, { ide = null, sourceCopy = null } = {}) {
  const data = codebuddyIdeDataRoot(ctx);
  const pinned = String(ctx.env.CODEBUDDY_EXTENSION_HISTORY || '').trim();
  const roots = accountHistoryRoots(ctx).filter((r) => r.canonical);
  const wantsDefault = String(uid).toLowerCase() === 'default';
  const matches = roots.filter((r) => (wantsDefault ? r.uid === null : r.uid === uid)).filter((r) => (ide ? r.ide === ide : true));
  const chosen = matches[0] ?? null;
  if (pinned && !chosen) {
    const warn = !path.resolve(pinned).toLowerCase().includes(wantsDefault ? 'default' : String(uid).toLowerCase());
    return { dir: pinned, exists: fs.existsSync(pinned), derived: true, pinned: true, warnPin: warn ? 'history-pin-conflict: 指定的 history 根不在目标账号目录下' : null, user: null, ide: null, uid: wantsDefault ? null : uid };
  }
  if (chosen) {
    return { ...chosen, exists: true, derived: false, pinned: false, warnPin: pinned && path.resolve(pinned) !== path.resolve(chosen.dir) ? 'history-pin-conflict: 忽略了 CODEBUDDY_EXTENSION_HISTORY，按目标账号的真实目录走' : null };
  }
  // 派生：优先用源副本坐标（同一 <user>/<ide> 换 uid），其次用 env 里的 ide/user
  const srcCoords = sourceCopy ? codebuddyRootCoords(sourceCopy.dir, data) : null;
  const like = srcCoords?.canonical ? srcCoords : null;
  // 派生：外层 <user> 段就用目标 uid 本身（实测宿主两处同名：Data/<uid>/<ide>/<uid>/history），
  // 只有 ide 沿用源副本那一层 —— 用源副本的 user 会把 B 账号的目录挂到 A 底下
  const useIde = String(ide || like?.ide || ctx.env.CODEBUDDY_EXTENSION_IDE || 'CodeBuddyIDE').trim() || 'CodeBuddyIDE';
  if (wantsDefault) return { dir: historyDirFor(data, { ide: useIde }), exists: false, derived: true, pinned: false, user: 'default', ide: useIde, uid: null, warnPin: null };
  const useUser = String(uid);
  return { dir: historyDirFor(data, { ide: useIde, uid: useUser }), exists: false, derived: true, pinned: false, user: useUser, ide: useIde, uid: useUser, warnPin: null };
}

/** map 里的副本用的是 reader 字段名（dir/convDir/convIndexFile），写侧统一成 {history, conv, ws} 后再交给 moveConversation */
function asFound(c) {
  return { ...c, history: c.dir, conv: c.convDir };
}

/**
 * 解析「这条会话从哪个账号搬到哪个账号、落到哪个项目」。
 * dry-run 与实际写入共用它，两边口径不会分叉；这一步一个字节都不写。
 */
function resolveSwitch(ctx, { targetId, account, ide = null, directory = null, keepSource = false, onlyImported = false, force = false } = {}) {
  const warnings = [];
  const uid = accountIdOf(account);
  if (!uid) return { error: `account-unusable: 目标账户里没有可用的 id（${JSON.stringify(account ?? null).slice(0, 80)}）；用 --account <uid>（uid 从 accounts 命令取）`, warnings };
  invalidateConversations(ctx);
  const copies = (codebuddyConversationMap(ctx).get(String(targetId)) ?? []).map(asFound);
  if (!copies.length) return { error: `conversation-not-found: ${targetId} 不在任何账号的 history 里`, action: 'not-found', warnings };

  const dest = resolveAccountHistoryRoot(ctx, uid, { ide, sourceCopy: codebuddyPickBest(copies) });
  if (!dest) return { error: 'target-root-unresolved: 拼不出目标账号的 history 根', warnings };
  if (dest.warnPin) warnings.push(dest.warnPin);
  if (dest.derived) warnings.push(`target-root-derived: 本机没有该账号的 history 目录，按现有形态取 ${dest.dir}`);

  const same = (c) => path.resolve(c.dir).toLowerCase() === path.resolve(dest.dir).toLowerCase();
  const src = codebuddyPickBest(copies.filter((c) => !same(c)));
  const dst = copies.filter(same).sort((a, b) => b.messageCount - a.messageCount)[0] ?? null;
  const sourceAccount = src ? codebuddyAccountOf(src.dir) ?? 'default' : uid;
  const public0 = { sourceAccount, targetAccount: uid };
  if (!src) return { ...public0, error: null, identical: true, dst, dest, warnings: [...warnings, 'already-in-target-account: 这条只存在于目标账号，没有要搬的东西'], public: { ...public0, projectCreated: false, workspaceKey: null, copied: keepSource }, action: 'already' };

  if (onlyImported && !readSidecarProvenance(src.convIndexFile)) {
    return { ...public0, error: 'not-imported-row: 该副本没有 session-sync 标记，--only-imported 下不动宿主原生会话', warnings };
  }
  if (!readSidecarProvenance(src.convIndexFile)) warnings.push(`foreign-switch-authorized: 这条是宿主原生会话（无 session-sync 标记），按点名授权搬 ${sourceAccount} → ${uid}`);

  const wsIndex = workspaceIndexFor(ctx);
  const cwd = String(directory || readCopyAsIr(ctx, src, wsIndex).cwd || '').trim();
  if (!cwd) {
    return { ...public0, error: `cwd-required: 这条副本恢复不出项目目录（history/${src.ws} 是 md5，正文里也没有 Workspace Folder），用 --cwd <目录> 指明要挂到哪个项目`, warnings };
  }
  const key = resolveCodebuddyWorkspaceKey(ctx, dest.dir, cwd) ?? codebuddyWorkspaceKey(cwd);
  const projectCreated = !fs.existsSync(path.join(dest.dir, key));
  if (projectCreated) warnings.push(`project-created: 目标账号没有这个项目，按导入同一条路径补 ${path.join(dest.dir, key, 'index.json')}`);

  let identical = false;
  let diverged = false;
  let forceReplace = false;
  if (dst) {
    const a = sessionCoreFingerprints(readCopyAsIr(ctx, src, wsIndex));
    const b = sessionCoreFingerprints(readCopyAsIr(ctx, dst, wsIndex));
    identical = a.length === b.length && a.every((x, i) => x === b[i]);
    if (!identical) {
      if (!force) return { ...public0, error: `content-diverged: 目标账号那份与源账号内容不同（源 ${a.length} 轮 / 目标 ${b.length} 轮），已保留两份；确认要用源覆盖目标再加 --force（会先备份目标）`, warnings, diverged: true };
      diverged = true;
      forceReplace = true;
    }
  }
  return {
    src,
    dst,
    dest,
    cwd,
    identical,
    diverged,
    forceReplace,
    warnings,
    public: { ...public0, projectCreated, workspaceKey: key, copied: keepSource, directory: cwd },
  };
}

export const codebuddyIdeWriter = {
  variant: 'codebuddy-ide',
  label: 'CodeBuddy IDE / 插件',

  canWrite(ctx) {
    return fs.existsSync(codebuddyIdeDataRoot(ctx)) ? { ok: true } : { ok: false, reason: 'extension-data-absent' };
  },

  /**
   * 元数据漂移：源侧只改了标题时，改工作区索引 conversations[].name。
   *
   * 取舍（必须写明，因为它违反了别家的 guard 惯例）：ide 的 name 没有「用户已定名」信号 ——
   * 宿主里改名就是直接改这个字段，我们无法区分「用户改的」和「宿主生成的」。
   * 所以接槽 = 源侧改名会覆盖用户在 IDE 改的名。不声明 guard 是诚实，
   * 声明一个永远为假的 guard 才是假保护。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    {
      kind: 'json-file',
      file: (c, targetId) => {
        const found = findConversation(c, targetId);
        return found ? path.join(found.history, found.ws, 'index.json') : null;
      },
      field: ['conversations', { by: 'id', eq: '$targetId' }, 'name'],
      maxLen: TITLE_MAX['codebuddy-ide'],
    },
  ], 'codebuddy-ide'),

  targetPath(ctx, session, targetId) {
    const found = findConversation(ctx, targetId);
    if (found) return found.conv;
    if (!session.cwd) return null;
    const root = resolveHistoryRoot(ctx).dir;
    return root ? path.join(root, codebuddyWorkspaceKey(session.cwd), String(targetId)) : null;
  },

  relocate(ctx, { targetId, directory }) {
    const found = findConversation(ctx, targetId);
    if (!found) return { ok: true, moved: false, path: null, warnings: [] };
    if (!directory) return { ok: false, error: 'cwd-required', moved: false, path: found.conv, warnings: [] };
    const mv = moveConversation(ctx, found, directory, targetId);
    if (mv.moved) invalidateConversations(ctx);
    return { ok: true, moved: mv.moved, path: mv.conv, backup: mv.backup, warnings: mv.warning ? [mv.warning] : [] };
  },

  /**
   * 账号清单 = 本机实际存在的账号目录层（uid + ide + 工作区 key + 会话数）。
   * 「当前登录哪个账号」这一家没有可信落点（扩展自己的登录态未取证，
   * Data/Public/auth/*.info 实测只有 workbuddy-desktop 的 uid），所以一律报 current:null 并说明原因，
   * 不拿「哪个目录最新」当登录态 —— 那只说明谁被写过。
   */
  listAccounts(ctx) {
    const warnings = [];
    const data = codebuddyIdeDataRoot(ctx);
    if (!fs.existsSync(data)) return { ok: false, error: 'extension-data-absent' };
    const map = codebuddyConversationMap(ctx);
    const total = [...map.values()].reduce((n, copies) => n + (codebuddyPickBest(copies) ? 1 : 0), 0);
    const accounts = [];
    let odd = 0;
    for (const r of accountHistoryRoots(ctx)) {
      if (!r.canonical) {
        odd++;
        continue;
      }
      let wss = [];
      try {
        wss = fs.readdirSync(r.dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        /* 空账号 */
      }
      const inRoot = [...map.values()].flat().filter((c) => path.resolve(c.dir).toLowerCase() === path.resolve(r.dir).toLowerCase()).length;
      accounts.push({
        id: r.uid ?? `default/${r.ide}`,
        name: null,
        isCurrent: false,
        uid: r.uid,
        user: r.user,
        ide: r.ide,
        source: 'Data/<user>/<ide>/<uid>/history',
        historyRoot: r.dir,
        workspaceKeys: wss,
        conversations: inRoot,
      });
    }
    if (odd) warnings.push(`non-account-layers: 还有 ${odd} 个 history 层不是账号坐标（宿主的工作区别名/base64 层），只列在这里、不作为切换目标`);
    warnings.push(`current-account-unmeasured: 这一家的「当前登录 uid」本机没有可信落点，切到哪个账号必须由 --account 点名（本机共 ${total} 条会话）`);
    return { ok: true, current: null, accounts, warnings };
  },

  /**
   * dry-run 用的解析：只读，返回「会落到哪个账号目录、要不要补 project、动哪份副本」。
   * 与 switchAccount 共用同一条解析路径，预告和真写才不会两套口径。
   */
  switchPreview(ctx, args = {}) {
    const r = resolveSwitch(ctx, args);
    if (r.error) return { ok: false, action: r.action ?? 'refused', error: r.error, warnings: r.warnings ?? [] };
    return { ok: true, action: r.dst && r.identical ? 'already' : 'moved', ...(r.public ?? {}), warnings: r.warnings };
  },

  /**
   * 跨账号切换。这一家的账号分区是**目录**，所以：
   *   - 归属不在列里，而在路径里 → 搬目录（正文 + 三个平行目录）
   *   - 目标账号可能从没打开过这个项目 → history/<md5(cwd)>/index.json 必须补出来，和导入首写同一条路径
   *   - 同一 id 可能已在目标账号里（宿主自己复制过）→ 先比核心指纹，绝不无声留两份
   */
  switchAccount(ctx, { targetId, account, ide = null, directory = null, keepSource = false, onlyImported = false, force = false } = {}) {
    const r = resolveSwitch(ctx, { targetId, account, ide, directory, keepSource, onlyImported, force });
    const warnings = [...r.warnings];
    if (r.error) return { ok: false, action: r.action ?? 'refused', error: r.error, sourceAccount: r.sourceAccount ?? null, targetAccount: r.targetAccount ?? null, warnings };

    if (r.dst && r.identical && !keepSource) {
      // 内容一致 → 收敛成一份：备份源账号那份后删掉，并从源工作区索引里摘除条目
      const backup = backupConversation(ctx, r.src.conv);
      fs.rmSync(r.src.conv, { recursive: true, force: true });
      const idxFile = path.join(r.src.dir, r.src.ws, 'index.json');
      const idx = readJsonFileSafe(idxFile, { conversations: [], current: '' }) ?? { conversations: [], current: '' };
      idx.conversations = (idx.conversations ?? []).filter((c) => String(c.id) !== String(targetId));
      if (String(idx.current) === String(targetId)) idx.current = idx.conversations[0]?.id ?? '';
      backupIfExists(idxFile, ctx, 'codebuddy-ide');
      writeJsonFilePretty(idxFile, idx);
      invalidateConversations(ctx);
      return { ok: true, action: 'moved', path: r.dst.conv, backup, ...r.public, warnings: [...warnings, 'converged: 目标账号已有同一份内容，删掉源账号副本（已备份）'] };
    }
    if (r.dst && r.identical && keepSource) {
      return { ok: true, action: 'already', path: r.dst.conv, ...r.public, warnings: [...warnings, 'identical-copy: 目标账号已有一份内容相同的副本，按 --keep-source 保留两处、未写入'] };
    }
    if (r.dst && r.forceReplace) {
      const dropped = backupConversation(ctx, r.dst.conv);
      fs.rmSync(r.dst.conv, { recursive: true, force: true });
      invalidateConversations(ctx);
      warnings.push(`target-backup-replaced: 目标账号那份已备份后被替换（${dropped}）`);
    }

    const mv = moveConversation(ctx, r.src, r.cwd, String(targetId), { destHistory: r.dest.dir, copyOnly: keepSource });
    if (mv.moved) invalidateConversations(ctx);
    for (const w of mv.companionWarnings ?? []) warnings.push(w);
    if (mv.warning) warnings.push(mv.warning);
    warnings.push('host-restart-needed: 外部改扩展缓存不会推给宿主 UI；扩展日志出现「Loaded N conversations from HistoryStorage」或重启 IDE 才算生效');
    if (!mv.moved) return { ok: false, action: 'refused', error: `move-failed: 没能落到目标账号（${mv.conv ?? '无'}）`, backup: mv.backup, ...r.public, warnings };
    return { ok: true, action: 'moved', path: mv.conv, backup: mv.backup, ...r.public, warnings };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, account = null }) {
    const warnings = [];
    if (!session.cwd) return { ok: false, error: 'cwd-required', targetId, warnings };
    // 按 targetId 全局找回既有会话：create/append 用同一落点，避免换目录后留下两份
    let found = findConversation(ctx, targetId);
    // 导入目标 append 的语义是「落点变化时先搬迁再追加」；原生 append 的 cwd 由编排层钉成目标 cwd，
    // workspace key 相等，不会触发搬迁
    if (found && codebuddyWorkspaceKey(session.cwd) !== found.ws) {
      const mv = moveConversation(ctx, found, session.cwd, targetId);
      if (mv.moved) {
        warnings.push(mv.warning);
        invalidateConversations(ctx);
        found = findConversation(ctx, targetId);
      }
    }
    const picked = found ? { dir: found.history, why: null } : resolveHistoryRoot(ctx, account);
    if (!picked.dir) {
      return {
        ok: false,
        error: picked.why === 'account-ambiguous' ? 'account-ambiguous' : `account-not-found: ${accountIdOf(account)}`,
        targetId,
        warnings: [...warnings, 'target-root-unresolved: 本机有多个账号目录，写侧不替你选账号；用 --account <uid> 点名，或 switch-account 显式迁移'],
      };
    }
    const history = picked.dir;
    const wantUid = accountIdOf(account);
    if (!found && wantUid) {
      const landed = codebuddyAccountOf(history);
      if (landed && landed !== wantUid) {
        warnings.push(`account-root-unmatched: --account ${wantUid} 在本机没有 history 目录，这条仍写进 ${landed} 账号；要把已有会话换过去用 switch-account --account ${wantUid} --apply`);
      }
    }
    // 工作区键 = md5(cwd)：优先认领宿主自己那个目录键（源侧盘符大小写与宿主不一致时，
    // 现算 md5 会落到另一个 history 目录 = 侧栏两个同名项目）
    const key = found?.ws ?? (resolveCodebuddyWorkspaceKey(ctx, history, session.cwd) ?? codebuddyWorkspaceKey(session.cwd));
    const wsDir = path.join(history, key);
    const conv = found?.conv ?? path.join(wsDir, String(targetId));
    const convIndexFile = path.join(conv, 'index.json');
    const existing = fs.existsSync(convIndexFile);
    if (mode === 'append' && !existing) return { ok: false, error: `target-missing: ${convIndexFile}`, targetId, warnings };
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    let backup = null;

    if (existing && mode !== 'append') {
      if (!force) return { ok: false, error: 'target-exists', targetId, warnings };
      backup = backupConversation(ctx, conv);
      fs.rmSync(conv, { recursive: true, force: true });
    }

    const built = buildConversation(session, turns, { injectCwd: mode !== 'append' });
    ensureDir(path.join(conv, 'messages'));

    if (mode === 'append' && existing) {
      const old = readJsonFileSafe(convIndexFile, null);
      if (!old || !Array.isArray(old.messages)) return { ok: false, error: `unreadable-target: ${convIndexFile}`, targetId, warnings };
      for (const m of built.files) writeJsonFilePretty(path.join(conv, 'messages', `${m.id}.json`), m.file);
      backupIfExists(convIndexFile, ctx, 'codebuddy-ide');
      writeJsonFilePretty(convIndexFile, {
        ...old,
        messages: [...old.messages, ...built.messages],
        requests: [...(old.requests ?? []), ...built.requests],
      });
    } else {
      for (const m of built.files) writeJsonFilePretty(path.join(conv, 'messages', `${m.id}.json`), m.file);
      writeJsonFilePretty(convIndexFile, { messages: built.messages, requests: built.requests });
    }

    // 最后更新工作区索引：先写消息再登记，宿主在中间时刻看不到半截会话
    const wsIndexFile = path.join(wsDir, 'index.json');
    const wsIndex = readJsonFileSafe(wsIndexFile, { conversations: [], current: '' }) ?? { conversations: [], current: '' };
    const nowIso = new Date().toISOString();
    const prevEntry = (wsIndex.conversations ?? []).find((c) => String(c.id) === String(targetId));
    const entry = mode === 'append' && prevEntry
      ? { ...prevEntry, lastMessageAt: nowIso }
      : {
          id: String(targetId),
          type: 'craft',
          // 与 syncTitle 的 maxLen 同一个数：写侧不截、同步侧截 200 会让首次导入就漂移
          name: fitTitleFor('codebuddy-ide', session.title).value || 'imported session',
          createdAt: new Date(session.createdAt || Date.now()).toISOString(),
          lastMessageAt: nowIso,
        };
    const conversations = (wsIndex.conversations ?? []).filter((c) => String(c.id) !== String(targetId));
    conversations.push(entry);
    backupIfExists(wsIndexFile, ctx, 'codebuddy-ide');
    writeJsonFilePretty(wsIndexFile, { ...wsIndex, conversations, current: String(targetId) });
    if (provenance) writeSidecarProvenance(convIndexFile, provenance);
    invalidateConversations(ctx);

    return { ok: true, targetId, path: conv, lines: built.messages.length, mode, backup, warnings };
  },
};
