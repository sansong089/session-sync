// readers/codebuddy.mjs — CodeBuddy Code（CLI）
//
// 存储：<root>/projects/<compressPath(cwd)>/<sessionId>.jsonl（一行一条历史项）
// 行形态（CLI 2.178.1 真机样本 + dist-server 源码）：
//   {id, parentId?, timestamp(ms), type:'message', role:'user'|'assistant', content:[block], sessionId, cwd}
//   block: input_text / output_text / text / thinking / tool_use / tool_result / image / document
//   {type:'custom-title'|'ai-title'|'topic'}  标题事实（custom > ai > topic）
//   {type:'session-meta', meta:{cwd?}}       会话级元数据
//   其余：file-history-snapshot / result 等机械事件
// 子代理：<project>/<parent>/subagents/<agentId>.jsonl —— 宿主主列表不列
// provenance：sidecar（<id>.jsonl.session-sync.json），正文里不塞自定义行
import fs from 'node:fs';
import path from 'node:path';
import { codebuddyProjectsRoot } from '../hosts.mjs';
import { roleRoots } from '../roots.mjs';
import { outputText } from '../text.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  attachmentItem,
  finalizeSession,
} from '../ir.mjs';
import { applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, listEvents, parseJsonl, toMs, fileMtime, inTimeRange, pushAssistantItem } from './base.mjs';
import { previewTitle } from '../titles.mjs';


function projectsDir(ctx) {
  return roleRoots('codebuddy', ctx, 'projects')[0]?.path ?? codebuddyProjectsRoot(ctx).path;
}

function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  for (const f of walkFiles(dir, {
    maxDepth: 3,
    match: (n) => n.endsWith('.jsonl') && !n.includes('.session-sync.'),
    skipDir: (n) => n === 'subagents',
  })) {
    const id = path.basename(f, '.jsonl');
    const prev = map.get(id);
    if (!prev || fileMtime(f) > fileMtime(prev)) map.set(id, f);
  }
  return map;
}

function consumeMeta(ev, acc) {
  const ts = toMs(ev.timestamp);
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    if (ts > acc.updatedAt) acc.updatedAt = ts;
  }
  if (ev.cwd && !acc.cwd) acc.cwd = ev.cwd;
  if (ev.type === 'session-meta' && ev.meta?.cwd && !acc.cwd) acc.cwd = String(ev.meta.cwd);
  if (ev.type === 'custom-title' && ev.customTitle) acc.title = String(ev.customTitle);
  if (ev.type === 'ai-title' && ev.aiTitle && !acc.aiTitle) acc.aiTitle = String(ev.aiTitle);
  if (ev.type === 'topic' && ev.topic && !acc.topic) acc.topic = String(ev.topic);
  if (ev.type === 'message' && ev.role === 'assistant' && ev.providerData?.model && !acc.model) acc.model = ev.providerData.model;
}

function replayEntries(lines) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  for (const ev of lines) {
    if (ev.type !== 'message') continue;
    const ts = toMs(ev.timestamp);
    const role = ev.role === 'user' ? 'user' : ev.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content = ev.content;
    const items = [];
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const c of blocks) {
      const type = String(c?.type ?? '');
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        const raw = String(c.text ?? '');
        const text = role === 'user' ? stripSystemInjections(raw) : raw;
        if (text) items.push(messageItem(role, text, ts));
      } else if (type === 'thinking') {
        if (c.thinking ?? c.text) items.push(reasoningItem(c.thinking ?? c.text, ts));
      } else if (type === 'redacted_thinking') {
        // 加密推理块，跳过
      } else if (type === 'tool_use') {
        items.push(toolCallItem(c.id ?? null, c.name ?? 'tool', c.input ?? null, ts));
      } else if (type === 'tool_result') {
        items.push(toolResultItem(c.tool_use_id ?? null, c.name ?? 'tool', c.is_error ? 'error' : 'ok', outputText(c.content), ts));
      } else if (type === 'image' || type === 'document' || type === 'input_file') {
        items.push(attachmentItem(c.source?.path ?? c.path ?? c.name ?? type, type, ts));
      }
    }
    if (!items.length) continue;
    // 只有 tool_result 的 user 项是工具回执，属于上一轮：不能开新 turn
    const hasUserText = items.some((i) => i.kind === 'message' && i.role === 'user');
    entries.push({ role: hasUserText ? 'user' : 'assistant', ts, items });
  }
  return entries;
}

function titleOf(acc, turns) {
  return deriveTitle(acc.title || acc.aiTitle || acc.topic || '', turns);
}

function modelOf(acc) {
  return acc.model ?? null;
}

function listMeta(file) {
  const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', aiTitle: '', topic: '', model: null };
  let userMsgs = 0;
  let preview = '';
  for (const ev of listEvents(file)) {
    consumeMeta(ev, acc);
    if (ev.type === 'message' && ev.role === 'user') {
      const text =
        typeof ev.content === 'string'
          ? ev.content
          : (Array.isArray(ev.content) ? ev.content : []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
      if (text.trim()) {
        userMsgs++;
        if (!preview) preview = stripSystemInjections(text);
      }
    }
  }
  return { acc, userMsgs, preview };
}

function readAll(file) {
  const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', aiTitle: '', topic: '', model: null };
  const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
  for (const ev of lines) consumeMeta(ev, acc);
  return { acc, lines };
}

export const codebuddyReader = {
  variant: 'codebuddy',
  label: 'CodeBuddy Code',

  available(ctx) {
    const d = projectsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const [id, file] of indexSessions(projectsDir(ctx))) {
      const { acc, userMsgs, preview } = listMeta(file);
      const explicit = acc.title || acc.aiTitle || acc.topic;
      out.push({
        id,
        variant: 'codebuddy',
        title: explicit || previewTitle(preview) || 'untitled',
        preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: acc.cwd,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt || fileMtime(file),
        turns: userMsgs,
        turnsApprox: false,
        model: modelOf(acc),
        provenance: readSidecarProvenance(file),
        sourcePath: file,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const file = indexSessions(projectsDir(ctx)).get(String(id));
    if (!file) return null;
    const { acc, lines } = readAll(file);
    const turns = assembleTurns(replayEntries(lines));
    const session = makeSession({
      id: String(id),
      variant: 'codebuddy',
      title: titleOf(acc, turns),
      cwd: acc.cwd,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
      model: modelOf(acc),
      turns,
      meta: { sourcePath: file },
    });
    applyProvenanceToIR(session, readSidecarProvenance(file));
    return finalizeSession(session);
  },
};
