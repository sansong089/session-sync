// writers/pi.mjs — 写 Pi 原生会话
//
// 产出：<root>/agent/sessions/<slug>/<ISO>_<targetId>.jsonl
// 事件：session(头) / model_change / message(role user|assistant|toolResult)
// content 类型仅 text / toolCall / image（Pi 无独立 reasoning 类型）
// provenance：专用行 type="session-sync/provenance" + sidecar 兜底
import fs from 'node:fs';
import path from 'node:path';
import { roleRoots } from '../roots.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import { PROVENANCE_LINE_TYPE } from '../readers/pi.mjs';
import {
  newNodeId,
  isoOf,
  isoFileStamp,
  writeJsonlFile,
  appendJsonlRebuild,
  backupIfExists,
  resolveSlugDir,
  slugForPi,
  lastNodeId,
  findExistingByTargetId,
  preflightOverwrite,
  relocateByTargetId,
  outputText,
} from './base.mjs';

function sessionsRoot(ctx) {
  return roleRoots('pi', ctx, 'sessions')[0]?.path ?? null;
}

function turnToEvents(turn, session) {
  const events = [];
  let buf = [];
  let bufTs = 0;
  const flush = () => {
    if (buf.length) {
      events.push({ role: 'assistant', content: buf, ts: bufTs });
      buf = [];
    }
  };

  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    switch (it.kind) {
      case 'message':
        if (it.role === 'user') {
          flush();
          // 连续用户文本块并进同一条 user 事件（读侧一条 user 事件 = 一轮，拆开就会多轮）
          const last = events[events.length - 1];
          if (last && last.role === 'user') last.content.push({ type: 'text', text: it.text });
          else events.push({ role: 'user', content: [{ type: 'text', text: it.text }], ts });
        } else if (it.text) {
          if (buf.length === 0) bufTs = ts;
          buf.push({ type: 'text', text: it.text });
        }
        break;
      case 'tool_call':
        if (buf.length === 0) bufTs = ts;
        buf.push({ type: 'toolCall', id: it.callId || newNodeId(), name: it.name || 'tool', arguments: it.input ?? {} });
        break;
      case 'tool_result':
        flush();
        events.push({ role: 'toolResult', toolCallId: it.callId || null, toolName: it.name || 'tool', content: [{ type: 'text', text: outputText(it.output) ?? '' }], isError: it.status === 'error', ts });
        break;
      case 'attachment':
        if (it.ref) {
          if (buf.length === 0) bufTs = ts;
          buf.push({ type: 'image', path: it.ref });
        }
        break;
      default:
        // Pi 无 reasoning / meta 槽位，跳过（读回后指纹一致）
        break;
    }
  }
  flush();
  return events;
}

function buildLines(session, turns, targetId, startParent, provenance, opts = {}) {
  const lines = [];
  let parent = startParent ?? null;
  const cwd = session.cwd || '';
  const createdAt = session.createdAt || Date.now();

  const emit = (obj) => {
    const id = newNodeId();
    lines.push({ id, parentId: parent, ...obj });
    parent = id;
    return id;
  };

  if (!startParent) {
    // 新会话：session 头必须是最前一行
    lines.push({ type: 'session', version: 3, id: targetId, timestamp: isoOf(createdAt), cwd });
    parent = null;
    if (session.model) emit({ type: 'model_change', timestamp: isoOf(createdAt + 1), provider: 'session-sync', modelId: session.model });
  }

  for (const turn of turns) {
    for (const ev of turnToEvents(turn, session)) {
      const message = { role: ev.role, content: ev.content, timestamp: ev.ts };
      if (ev.role === 'assistant' && session.model) message.model = session.model;
      if (ev.role === 'toolResult') {
        message.toolCallId = ev.toolCallId;
        message.toolName = ev.toolName;
        message.isError = ev.isError;
      }
      emit({ type: 'message', timestamp: isoOf(ev.ts), message });
    }
  }

  if (provenance) emit({ type: PROVENANCE_LINE_TYPE, timestamp: isoOf(session.updatedAt), 'session-sync': provenance });
  return lines;
}

export const piWriter = {
  variant: 'pi',
  label: 'Pi',

  canWrite(ctx) {
    return sessionsRoot(ctx) ? { ok: true } : { ok: false, reason: 'sessions-dir-unresolved' };
  },

  targetPath(ctx, session, targetId) {
    const root = sessionsRoot(ctx);
    const found = findExistingByTargetId(root, targetId);
    if (found) return found;
    const dir = resolveSlugDir(root, slugForPi(session.cwd));
    return path.join(dir, `${isoFileStamp(session.createdAt || Date.now())}_${targetId}.jsonl`);
  },

  relocate(ctx, { targetId, directory }) {
    const root = sessionsRoot(ctx);
    const dir = resolveSlugDir(root, slugForPi(directory));
    const r = relocateByTargetId(root, targetId, dir, { ctx, variant: 'pi' });
    return { ok: true, moved: r.moved, path: r.path, warnings: r.warning ? [r.warning] : [] };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const root = sessionsRoot(ctx);
    if (!root) return { ok: false, error: 'sessions-dir-unresolved' };
    const dir = resolveSlugDir(root, slugForPi(session.cwd));
    // 先按 id 找回既有正文搬进本次落点（Pi 的文件名内嵌 ISO，搬完仍能在 dir 里按后缀找回来）
    const reloc = relocateByTargetId(root, targetId, dir, { ctx, variant: 'pi' });
    if (reloc.moved) warnings.push(reloc.warning);

    // Pi 的文件名内嵌会话 id，append 必须找回原文件
    const existing = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.endsWith(`_${targetId}.jsonl`)) : null;
    const file = existing
      ? path.join(dir, existing)
      : path.join(dir, `${isoFileStamp(session.createdAt || Date.now())}_${targetId}.jsonl`);
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);

    if (mode === 'append') {
      const backup = backupIfExists(file, ctx, 'pi');
      let warnedNoParent = false;
      const res = appendJsonlRebuild(file, () => {
        const startParent = lastNodeId(file, 'id');
        if (!startParent && !warnedNoParent) {
          warnings.push('目标文件缺少可续接的 id，将以新链写入');
          warnedNoParent = true;
        }
        return buildLines(session, turns, targetId, startParent, provenance);
      });
      if (provenance) writeSidecarProvenance(file, provenance);
      return { ok: true, targetId, path: file, lines: res.lines, mode, backup, warnings, concurrentRetries: res.concurrentRetries };
    }

    const pre = preflightOverwrite(file, { force });
    if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
    const lines = buildLines(session, turns, targetId, null, provenance);
    const backup = backupIfExists(file, ctx, 'pi');
    writeJsonlFile(file, lines);
    if (provenance) writeSidecarProvenance(file, provenance);
    return { ok: true, targetId, path: file, lines: lines.length, mode, backup, warnings };
  },
};
