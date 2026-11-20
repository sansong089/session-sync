// readers/claude.mjs — Claude Code
//
// 存储：<root>/projects/<project-slug>/<sessionId>.jsonl（一行一事件）
// 事件：user / assistant / attachment / queue-operation / file-history-snapshot
//      / last-prompt / ai-title
// 内容：user.message.content = string | [{type:'text'|'tool_result', ...}]
//      assistant.message.content = [{type:'thinking'|'text'|'tool_use', ...}]
// provenance 槽位：专用行 type="session-sync-provenance"（宿主忽略未知 type）+ sidecar 兜底
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS } from '../hosts.mjs';
import { candidateRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  attachmentItem,
  finalizeSession,
} from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { firstExisting, assembleTurns, deriveTitle, stripSystemInjections, walkFiles, listEvents, claudeUserTurnText, parseJsonl, toMs, fileMtime, inTimeRange, pushAssistantItem } from './base.mjs';
import { outputText } from '../text.mjs';
import { previewTitle } from '../titles.mjs';

export const PROVENANCE_LINE_TYPE = 'session-sync-provenance';

function projectsDir(ctx) {
  return firstExisting(candidateRoots('claude', ctx))?.path ?? null;
}

function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  // subagents/ 下是子代理侧链 transcript（现场 74 个 jsonl 里 41 个是侧链），宿主 `--resume` 不列，
  // 我们也不能把它当独立会话，否则一条主会话会被拆成若干「孤儿会话」
  for (const f of walkFiles(dir, { maxDepth: 3, match: (n) => n.endsWith('.jsonl') && !n.includes('.session-sync.'), skipDir: (n) => n === 'subagents' })) {
    const id = path.basename(f, '.jsonl');
    const prev = map.get(id);
    if (!prev || fileMtime(f) > fileMtime(prev)) map.set(id, f);
  }
  return map;
}

// tool_result.content 可为 string 或 [{type:'text',text}] —— 归一走 text.mjs 的唯一出口

function consumeMeta(ev, acc) {
  const ts = toMs(ev.timestamp);
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    if (ts > acc.updatedAt) acc.updatedAt = ts;
  }
  if (ev.cwd && !acc.cwd) acc.cwd = ev.cwd;
  if (ev.message?.model && !acc.model) acc.model = ev.message.model;
  if (ev.type === 'ai-title' && ev.aiTitle) acc.title = String(ev.aiTitle);
  if (ev.type === PROVENANCE_LINE_TYPE) {
    const prov = provenanceFromObject(ev['session-sync']);
    if (prov) acc.provenance = prov;
  }
  if (ev.type === 'system' && ev.subtype === 'init' && ev.model && !acc.model) acc.model = ev.model;
}

function replayEntries(lines) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  for (const ev of lines) {
    const ts = toMs(ev.timestamp);
    switch (ev.type) {
      case 'user': {
        const content = ev.message?.content;
        const items = [];
        // 宿主注入的压缩摘要（qoder/claude 血统）：结构标记 isCompactSummary，正文是裸文本无标签壳。
        // 归一化：text = 剥壳正文原样（本就无壳），compact:true 承载语义；正文一字不丢。
        const compact = ev.isCompactSummary === true;
        if (typeof content === 'string') {
          const t = stripSystemInjections(content);
          if (t) items.push(messageItem('user', t, ts, compact));
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === 'text' && c.text) {
              const t = stripSystemInjections(c.text);
              if (t) items.push(messageItem('user', t, ts, compact));
            } else if (c?.type === 'tool_result') {
              items.push(toolResultItem(c.tool_use_id ?? null, 'tool', c.is_error ? 'error' : 'ok', outputText(c.content), ts));
            } else if (c?.type === 'image') {
              items.push(attachmentItem(c.source?.data ? 'inline-image' : c.source?.url ?? '', 'image', ts));
            }
          }
        }
        // 只有 tool_result 的 user 事件是「工具回执」，属于上一轮，不能开新 turn
        const hasUserText = items.some((i) => i.kind === 'message');
        if (items.length) entries.push({ role: hasUserText ? 'user' : 'assistant', ts, items });
        break;
      }
      case 'assistant': {
        const items = [];
        for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (c?.type === 'thinking' && c.thinking) items.push(reasoningItem(c.thinking, ts));
          else if (c?.type === 'text' && c.text) items.push(messageItem('assistant', c.text, ts));
          else if (c?.type === 'tool_use') items.push(toolCallItem(c.id ?? null, c.name ?? 'tool', c.input ?? null, ts));
        }
        if (items.length) entries.push({ role: 'assistant', ts, items });
        break;
      }
      case 'attachment': {
        // 系统注入（skill_listing / todo_reminder / hook_additional_context …）：不进对话内容
        const a = ev.attachment ?? {};
        if (a.type === 'edited_text_file' && a.path) pushItem(attachmentItem(a.path, 'edited_text_file', ts), ts);
        break;
      }
      default:
        // queue-operation / file-history-snapshot / last-prompt / ai-title / system
        break;
    }
  }
  return entries;
}

export const claudeReader = {
  variant: 'claude',
  label: 'Claude Code',

  available(ctx) {
    const d = projectsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const [id, file] of indexSessions(projectsDir(ctx))) {
      // 全量解析（不采样）：轮次要与 read 一致；updatedAt 用 mtime（排序用途）
      const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', model: null, provenance: null };
      let userMsgs = 0;
      let preview = '';
      for (const ev of listEvents(file)) {
        consumeMeta(ev, acc);
        const clean = claudeUserTurnText(ev);
        if (clean) {
          userMsgs++;
          if (!preview) preview = clean;
        }
      }
      out.push({
        id,
        variant: 'claude',
        title: acc.title || previewTitle(preview) || 'untitled',
        preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: acc.cwd,
        createdAt: acc.createdAt,
        updatedAt: fileMtime(file),
        turns: userMsgs,
        turnsApprox: false,
        model: acc.model,
        provenance: acc.provenance,
        sourcePath: file,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const file = indexSessions(projectsDir(ctx)).get(String(id));
    if (!file) return null;
    const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
    const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', model: null, provenance: null };
    for (const ev of lines) consumeMeta(ev, acc);

    const turns = assembleTurns(replayEntries(lines));
    const session = makeSession({
      id: String(id),
      variant: 'claude',
      title: deriveTitle(acc.title, turns),
      cwd: acc.cwd,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
      model: acc.model,
      turns,
      meta: { sourcePath: file },
    });
    applyProvenanceToIR(session, acc.provenance || readSidecarProvenance(file));
    return finalizeSession(session);
  },
};

// Qoder CLI 的 projects/*.jsonl 与 Claude Code 同构（同一套 user/assistant/tool_use 事件格式），
// 这里把解析核导出给 readers/qoder.mjs 复用，避免两套实现各自漂移
export { consumeMeta as claudeLikeConsumeMeta, replayEntries as claudeLikeReplayEntries };
