// writers/claude.mjs — 写 Claude Code 原生会话
//
// 产出：<root>/projects/<slug>/<targetId>.jsonl
// 事件形态：user(message.content[{text|tool_result}]) / assistant(message.content[{thinking|text|tool_use}])
// parentUuid 线性续接（Claude 靠它建树，断链会导致会话打不开）
// provenance：专用行 type="session-sync-provenance" + sidecar 兜底
import path from 'node:path';
import { writeSidecarProvenance } from '../provenance.mjs';
import { PROVENANCE_LINE_TYPE } from '../readers/claude.mjs';
import { configRoot } from '../hosts.mjs';
import { writeRootOf } from '../roots.mjs';
import {
  newNodeId,
  isoOf,
  writeJsonlFile,
  appendJsonlRebuild,
  backupIfExists,
  resolveSlugDir,
  slugForClaude,
  lastNodeId,
  findExistingByTargetId,
  preflightOverwrite,
  relocateByTargetId,
} from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';

function projectsRoot(ctx) {
  // 正文根按 role 取（声明层已登记 CLAUDE_CONFIG_DIR）：根被 --data-root / env 搬走时写侧跟着走
  const hit = writeRootOf('claude', ctx, 'projects');
  return hit ? hit.path : path.join(configRoot(ctx, 'claude'), 'projects');
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// 一轮 turn → Claude 事件序列（保持 tool_call → tool_result 的原始交错）
function turnToEvents(turn, session) {
  const events = [];
  let buf = [];
  let results = [];

  const flushAssistant = () => {
    if (buf.length) {
      events.push({ type: 'assistant', content: buf, ts: buf.ts });
      buf = [];
    }
  };
  const flushResults = () => {
    if (results.length) {
      events.push({ type: 'user', content: results, ts: results.ts });
      results = [];
    }
  };
  const pushBuf = (c, ts) => {
    if (buf.length === 0) buf.ts = ts;
    buf.push(c);
  };
  const pushResult = (c, ts) => {
    if (results.length === 0) results.ts = ts;
    results.push(c);
  };
  // 同一轮的连续用户文本块并成一条 user 事件：读侧「一条含文本的 user 事件 = 一轮」，
  // 逐块各发一条会把一轮拆成多轮，续写就会被误判成分叉
  let userBlocks = null;
  let userTs = 0;
  const flushUser = () => {
    if (userBlocks && userBlocks.length) events.push({ type: 'user', content: userBlocks, ts: userTs });
    userBlocks = null;
  };
  const pushUser = (c, ts) => {
    if (!userBlocks) {
      userBlocks = [];
      userTs = ts;
    }
    userBlocks.push(c);
  };

  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    const isUserText = it.kind === 'message' && it.role === 'user';
    if (!isUserText) flushUser();
    if (it.kind !== 'tool_result' && results.length) flushResults();

    switch (it.kind) {
      case 'message':
        if (isUserText) {
          flushAssistant();
          flushResults();
          pushUser({ type: 'text', text: it.text }, ts);
        } else if (it.text) {
          pushBuf({ type: 'text', text: it.text }, ts);
        }
        break;
      case 'reasoning':
        if (it.text) pushBuf({ type: 'thinking', thinking: it.text }, ts);
        break;
      case 'tool_call':
        pushBuf({ type: 'tool_use', id: it.callId || newNodeId(), name: it.name || 'tool', input: it.input ?? {} }, ts);
        break;
      case 'tool_result':
        flushAssistant();
        pushResult({ type: 'tool_result', tool_use_id: it.callId || null, content: textOf(it.output) }, ts);
        break;
      case 'attachment':
        if (it.ref) pushBuf({ type: 'text', text: `[attachment] ${it.ref}` }, ts);
        break;
      default:
        break;
    }
  }
  flushUser();
  flushAssistant();
  flushResults();
  return events;
}

function buildLines(session, turns, targetId, startParent, provenance, opts = {}) {
  const lines = [];
  let parent = startParent ?? null;
  const cwd = session.cwd || '';
  const model = session.model || null;

  const emit = (obj) => {
    const uuid = newNodeId();
    const line = {
      parentUuid: parent,
      isSidechain: false,
      ...obj,
      uuid,
      timestamp: isoOf(obj.ts),
      sessionId: targetId,
      cwd,
      version: '2.1.138',
      userType: 'external',
    };
    delete line.ts;
    lines.push(line);
    parent = uuid;
    return line;
  };

  // 标题事实行放在首轮之前（与 workbuddy 的 header 同款）：目的是新建的会话在宿主里
  // **立刻有标题**，不必等宿主下一次生成。读侧是「最后一条胜出」，宿主之后自己写的新
  // ai-title 会自然排在我们这行后面并取而代之 —— 那是正确顺序，不需要我们让路。
  if (opts.titleOnCreate && String(session.title ?? '').trim()) {
    emit({ type: 'ai-title', aiTitle: String(session.title).trim(), ts: session.createdAt || Date.now() });
  }

  for (const turn of turns) {
    for (const ev of turnToEvents(turn, session)) {
      if (ev.type === 'user') emit({ type: 'user', message: { role: 'user', content: ev.content }, ts: ev.ts });
      else emit({ type: 'assistant', message: { role: 'assistant', model, content: ev.content }, ts: ev.ts });
    }
  }

  if (provenance) {
    emit({ type: PROVENANCE_LINE_TYPE, 'session-sync': provenance, ts: session.updatedAt });
  }
  return lines;
}

/**
 * claude 血统的 jsonl writer 工厂。qoder（中/英）的 CLI 正文与 Claude Code 同构，
 * 只多了首行 workspace-directories / runtime-config 与末行 active-leaf 的形状要求，
 * 所以共用一个实现，用 header/trailer 钩子表达差异，避免两处 append/relocate 逻辑各自漂移。
 */
export function createClaudeFamilyWriter({ variant, label, rootFor, header = null, trailer = null, titleOnCreate = false, titleSlots = null }) {
 return {
  variant,
  label,

  canWrite() {
    return { ok: true };
  },

  // 有标题落点的家才声明槽：qoder 的 CLI 明文里没有标题字段（标题只在桌面注册表），
  // 传 null 让这家**没有** syncTitle，而不是留一份指向不存在落点的声明（假声明比没声明更坏）
  ...(titleSlots ? { syncTitle: makeTitleSyncer(titleSlots, variant) } : {}),

  targetPath(ctx, session, targetId) {
    const root = rootFor(ctx);
    const found = findExistingByTargetId(root, targetId);
    if (found) return found;
    const dir = resolveSlugDir(root, slugForClaude(session.cwd));
    return path.join(dir, `${targetId}.jsonl`);
  },

  // 落点变了但内容没变（decide 判 skip）时，正文仍要跟着搬 —— 否则计划说的目录和盘上的目录永远对不上
  relocate(ctx, { targetId, directory }) {
    const root = rootFor(ctx);
    const dir = resolveSlugDir(root, slugForClaude(directory));
    const r = relocateByTargetId(root, targetId, dir, { ctx, variant });
    return { ok: true, moved: r.moved, path: r.path, warnings: r.warning ? [r.warning] : [] };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const root = rootFor(ctx);
    const dir = resolveSlugDir(root, slugForClaude(session.cwd));
    // 先按 id 找回既有正文并搬到本次落点：否则 append 会在新房写半截、旧房留完整孤儿
    const reloc = relocateByTargetId(root, targetId, dir, { ctx, variant });
    if (reloc.moved) warnings.push(reloc.warning);
    const file = reloc.path ?? path.join(dir, `${targetId}.jsonl`);
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);

    let backup = null;
    if (mode === 'append') {
      // 宿主可能在运行中继续写同一文件：原子追加 + 大小校验 + 重建重试
      backup = backupIfExists(file, ctx, variant);
      let warnedNoParent = false;
      const res = appendJsonlRebuild(file, () => {
        const startParent = lastNodeId(file, 'uuid');
        if (!startParent && !warnedNoParent) {
          warnings.push('目标文件缺少可续接的 uuid，将以新链写入');
          warnedNoParent = true;
        }
        const body = buildLines(session, turns, targetId, startParent, provenance);
        return trailer ? [...body, ...trailer(ctx, session, targetId, body, 'append')] : body;
      });
      if (provenance) writeSidecarProvenance(file, provenance);
      return { ok: true, targetId, path: file, lines: res.lines, mode, backup, warnings, concurrentRetries: res.concurrentRetries };
    }

    // create / fork
    const pre = preflightOverwrite(file, { force });
    if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
    let lines = buildLines(session, turns, targetId, null, provenance, { titleOnCreate });
    if (header) lines = [...header(ctx, session, targetId), ...lines];
    if (trailer) lines = [...lines, ...trailer(ctx, session, targetId, lines, 'create')];
    backup = backupIfExists(file, ctx, variant);
    writeJsonlFile(file, lines);
    if (provenance) writeSidecarProvenance(file, provenance);
    return { ok: true, targetId, path: file, lines: lines.length, mode, backup, warnings };
  },
 };
}

/**
 * claude 的标题落点：正文里的 ai-title 行。
 *
 * 为什么是 `pick:'last'`：真机上每个会话有 6–23 条 ai-title（宿主每轮可能重生成一次），
 * 读侧顺序消费、**最后一条胜出**（readers/claude.mjs consumeMeta）。同步必须改最后一条，
 * 改第一条等于改了一份宿主早已不看的旧事实。
 *
 * 为什么不设 guard：ai-title 是宿主自动生成的摘要，不是「用户自己起的名」——
 * 这里没有用户定名的落点，硬造一个 guard 只会让同步永远不生效。
 */
const claudeTitleSlots = (rootFor) => (ctx) => [
  {
    kind: 'body-row',
    file: (c, targetId) => findExistingByTargetId(rootFor(c), String(targetId)),
    type: 'ai-title',
    field: 'aiTitle',
    pick: 'last',
  },
];

export const claudeWriter = createClaudeFamilyWriter({
  variant: 'claude',
  label: 'Claude Code',
  rootFor: (ctx) => projectsRoot(ctx),
  titleOnCreate: true,
  titleSlots: claudeTitleSlots((ctx) => projectsRoot(ctx)),
});

export { projectsRoot as claudeProjectsRoot };
