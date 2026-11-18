// writers/freebuff.mjs — 写 Freebuff 原生会话
//
// 产出：<config>/projects/<project>/chats/<ISO目录>/
//   chat-messages.json（数组：{id, variant:'user'|'ai', content, blocks[], timestamp}）
//   chat-meta.json     （messageCount / firstPrompt / messagesSize / messagesMtimeMs / session-sync）
//   run-state.json     （sessionState.fileContext.projectRoot）
// 另 upsert <config>/recent-projects.json（项目选择器注册表，agent-storage §15 V8）
// Freebuff 无追加语义（单文件全量 JSON），append 即整文件重写
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_RESULT_ONLY } from '../readers/base.mjs';
import { newNodeId, readJsonFileSafe, readJsonStrict, unreadableTarget, writeJsonFilePretty, backupIfExists, findExistingByTargetId, relocateByTargetId,
  outputText,
} from './base.mjs';
import { ensureDir, cmpPath } from '../util.mjs';
import { roleRoots } from '../roots.mjs';

function projectsRoot(ctx) {
  return roleRoots('freebuff', ctx, 'projects')[0]?.path ?? null;
}

const RECENT_PROJECTS_CAP = 10;

// 项目选择器只读 <config>/recent-projects.json，只建 projects/<project>/ 目录不会进列表。
// 形状按宿主自己的 save：目录在盘上存在才登记、按 path 去重置顶、上限 10 条、2 空格 JSON。
// refresh=false 供 skip 自愈：只补缺的条目，不动已有条目的位置与 lastOpened（幂等复跑不该重排用户的最近列表）。
function registerProject(ctx, directory, { refresh = true } = {}) {
  const root = projectsRoot(ctx);
  if (!root) return { ok: false, changed: false, warnings: ['projects-dir-unresolved'] };
  const raw = String(directory ?? '').trim();
  if (!raw) return { ok: true, changed: false, warnings: [] };
  const dir = path.resolve(raw);
  let onDisk = false;
  try { onDisk = fs.statSync(dir).isDirectory(); } catch { onDisk = false; }
  if (!onDisk) {
    return { ok: true, changed: false, warnings: [`project-unmatched: 项目目录 ${dir} 不在盘上，未登记 recent-projects.json（项目选择器不会列出）`] };
  }
  const file = path.join(path.dirname(root), 'recent-projects.json');
  const parsed = readJsonFileSafe(file, null);
  const entries = (Array.isArray(parsed) ? parsed : []).filter((e) => e && typeof e === 'object' && typeof e.path === 'string');
  const idx = entries.findIndex((e) => cmpPath(e.path) === cmpPath(dir));
  if (idx >= 0 && !refresh) return { ok: true, changed: false, warnings: [] };
  const rest = idx >= 0 ? entries.filter((_, i) => i !== idx) : entries;
  const next = [{ path: dir, lastOpened: Date.now() }, ...rest].slice(0, RECENT_PROJECTS_CAP);
  writeJsonFilePretty(file, next);
  const warnings = idx < 0 ? [`project-registered: 已登记项目 ${dir} 到 recent-projects.json（项目选择器列表）`] : [];
  return { ok: true, changed: true, warnings };
}

function turnToMessages(turn, session) {
  const out = [];
  let blocks = null;
  let aiId = null;
  // 同一 tool 块的入参与输出必须合并（读侧一个 tool 块 → tool_call + tool_result，
  // 拆成两块会让读回的指纹与源不一致，破坏 round-trip 稳定性）
  const callBlocks = new Map();
  let headUser = null;

  const flushAi = () => {
    if (blocks && blocks.length) {
      out.push({ id: aiId, variant: 'ai', content: '', blocks, timestamp: hhmm(blocks.ts) });
    }
    blocks = null;
    aiId = null;
    callBlocks.clear();
  };
  const pushBlock = (b, ts) => {
    if (!blocks) {
      blocks = [];
      aiId = `ai-${Date.now()}-${newNodeId().slice(0, 12)}`;
      blocks.ts = ts;
    }
    blocks.push(b);
    return b;
  };

  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    if (it.kind === 'message' && it.role === 'user') {
      flushAi();
      // 同一轮的连续用户文本并成一条（读侧一条 user = 一轮，拆开就多轮 → 跨落点误判分叉）
      if (headUser) headUser.content = `${headUser.content}\n\n${it.text}`;
      else {
        headUser = { id: `user-${ts}`, variant: 'user', content: it.text, timestamp: hhmm(ts) };
        out.push(headUser);
      }
      continue;
    }
    headUser = null;
    switch (it.kind) {
      case 'message':
        if (it.text) pushBlock({ type: 'text', content: it.text }, ts);
        break;
      case 'reasoning':
        if (it.text) pushBlock({ type: 'text', content: it.text, textType: 'reasoning' }, ts);
        break;
      case 'tool_call': {
        const callId = it.callId || newNodeId();
        const block = pushBlock({ type: 'tool', toolCallId: callId, toolName: it.name || 'tool', input: it.input ?? null, agentId: 'main-agent' }, ts);
        callBlocks.set(callId, block);
        break;
      }
      case 'tool_result': {
        const callId = it.callId || null;
        const existing = callId ? callBlocks.get(callId) : null;
        if (existing) {
          existing.output = outputText(it.output) ?? '';
          if (!existing.toolName && it.name) existing.toolName = it.name;
        } else {
          pushBlock({ type: 'tool', toolCallId: callId || newNodeId(), toolName: it.name || 'tool', input: null, output: outputText(it.output) ?? '', agentId: 'main-agent', [TOOL_RESULT_ONLY]: true }, ts);
        }
        break;
      }
      case 'attachment':
        if (it.ref) pushBlock({ type: 'text', content: `[attachment] ${it.ref}` }, ts);
        break;
      default:
        break;
    }
  }
  flushAi();
  return out;
}

function hhmm(ms) {
  const d = new Date(Number(ms) > 0 ? Number(ms) : Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}


export const freebuffWriter = {
  variant: 'freebuff',
  label: 'Freebuff (Codebuff)',

  canWrite(ctx) {
    return projectsRoot(ctx) ? { ok: true } : { ok: false, reason: 'projects-dir-unresolved' };
  },

  targetPath(ctx, session, targetId) {
    const root = projectsRoot(ctx);
    const found = findExistingByTargetId(root, targetId);
    if (found) return found;
    const project = path.basename(String(session.cwd || '').replace(/[\\/]+$/, ''));
    return project ? path.join(root, project, 'chats', String(targetId)) : null;
  },

  relocate(ctx, { targetId, directory }) {
    const root = projectsRoot(ctx);
    const project = path.basename(String(directory ?? '').replace(/[\\/]+$/, ''));
    if (!project) return { ok: false, warnings: ['cwd-required: 空落点无法搬迁 freebuff 会话'] };
    const r = relocateByTargetId(root, targetId, path.join(root, project, 'chats'), { ctx, variant: 'freebuff' });
    return { ok: true, moved: r.moved, path: r.path, warnings: r.warning ? [r.warning] : [] };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const root = projectsRoot(ctx);
    if (!root) return { ok: false, error: 'projects-dir-unresolved' };

    // targetId 就是 chats 目录名（identity 派生），project 由 cwd 决定。
    // 空 cwd 不能退成 projects/default —— 宿主里没有 projectRoot 时直接 throw，那个目录它永远不会打开。
    const project = path.basename(String(session.cwd || '').replace(/[\\/]+$/, ''));
    if (!project) return { ok: false, error: 'cwd-required: freebuff 的宿主没有非项目落点，需要 --cwd <目录>' };
    const chatDir = String(targetId);
    // 宿主按 basename(projectRoot) 认项目：不同父目录同 basename 会并进同一个分组（跨机器导入会串），明确提示
    const normRoot = (p) => String(p ?? '').replace(/[\\/]+$/, '');
    let siblings = [];
    try {
      siblings = fs
        .readdirSync(path.join(root, project, 'chats'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== chatDir)
        .map((e) => readJsonFileSafe(path.join(root, project, 'chats', e.name, 'run-state.json'), null)?.sessionState?.fileContext?.projectRoot)
        .filter((p) => p && normRoot(p) !== normRoot(session.cwd));
    } catch {
      siblings = [];
    }
    if (siblings.length) {
      warnings.push(`project-name-collision: projects/${project} 已被 ${siblings[0]} 使用；宿主按目录名认项目，本条 (${session.cwd}) 会并进同一分组`);
    }
    // 换 project（= 换落点）时先把既有 chats 目录整体搬走，避免同一会话在两处各有一份
    const reloc = relocateByTargetId(root, targetId, path.join(root, project, 'chats'), { ctx, variant: 'freebuff' });
    if (reloc.moved) warnings.push(reloc.warning);
    const dir = reloc.path ?? path.join(root, project, 'chats', chatDir);

    const messagesFile = path.join(dir, 'chat-messages.json');
    const metaFile = path.join(dir, 'chat-meta.json');
    const runStateFile = path.join(dir, 'run-state.json');

    // 三个文件都是整份重写（Freebuff 没有追加语义）：解不开就当成空会把既有正文换成只有增量
    const prevRes = readJsonStrict(messagesFile);
    const prevMetaRes = readJsonStrict(metaFile);
    const runStateRes = readJsonStrict(runStateFile);
    if (!force) {
      for (const [f, r] of [[messagesFile, prevRes], [metaFile, prevMetaRes], [runStateFile, runStateRes]]) {
        if (!r.ok) return { ok: false, error: unreadableTarget(f, r.reason), path: dir, targetId, warnings };
      }
    }
    const prev = Array.isArray(prevRes.value) ? prevRes.value : [];
    const prevMeta = prevMetaRes.value || {};
    if (!force && prev.length > 0 && mode !== 'append') {
      return { ok: false, error: 'target-exists', path: dir, targetId, warnings };
    }

    // append 语义：保留已有消息，仅追加新轮次
    const base = mode === 'append' ? prev.slice() : [];
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const fresh = [];
    for (const turn of turns) fresh.push(...turnToMessages(turn, session));
    const all = [...base, ...fresh];

    ensureDir(dir);
    const backup = backupIfExists(messagesFile, ctx, 'freebuff');
    writeJsonFilePretty(messagesFile, all);

    const firstUser = all.find((m) => m.variant === 'user');
    const meta = {
      ...prevMeta,
      messageCount: all.length,
      firstPrompt: String(firstUser?.content ?? prevMeta.firstPrompt ?? '').slice(0, 200),
      // 我们的会话目录名是 targetId（非宿主 ISO 形态），时间戳只能记在元数据里：
      // 否则 reader 的目录名解析拿不到时间，排序/--since 都会失真
      createdAt: Number(session.createdAt) || prevMeta.createdAt || Date.now(),
      updatedAt: Number(session.updatedAt) || prevMeta.updatedAt || Date.now(),
      messagesSize: fs.statSync(messagesFile).size,
      messagesMtimeMs: Date.now(),
      ...(provenance ? { 'session-sync': provenance } : {}),
    };
    writeJsonFilePretty(metaFile, meta);

    const runState = runStateRes.value || {
      sessionState: { fileContext: { projectRoot: session.cwd || '', cwd: session.cwd || '', fileTree: [] } },
    };
    writeJsonFilePretty(runStateFile, runState);

    try {
      const reg = registerProject(ctx, session.cwd);
      warnings.push(...reg.warnings);
    } catch {
      warnings.push('project-register-failed: 正文已写入，但 recent-projects.json 登记失败（重跑 import 走 skip 自愈可补）');
    }

    return { ok: true, targetId: String(targetId), path: dir, lines: all.length, mode, backup, warnings };
  },

  ensureIndex(ctx, info) {
    try {
      return registerProject(ctx, info?.cwd, { refresh: false });
    } catch {
      return { ok: false, changed: false, warnings: ['project-register-failed: recent-projects.json 登记失败（可重跑）'] };
    }
  },
};
