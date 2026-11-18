// readers/freebuff.mjs — Freebuff（Codebuff 系）
//
// 存储：<config>/projects/<project>/chats/<ISO时间目录>/
//   chat-messages.json  对话正文（数组：{id, variant:'user'|'ai', content, blocks[], timestamp}）
//   chat-meta.json      {messageCount, firstPrompt, messagesSize, messagesMtimeMs}
//   run-state.json      sessionState.fileContext.projectRoot / cwd
//   log.jsonl           运行日志（非对话，忽略）
// blocks 类型：mode-divider / text(content, textType='reasoning') / tool(toolCallId,toolName,input,output) / agent
// 会话 id = "<project>/<chats 目录名>"（唯一且可逆）
// provenance 槽位：chat-meta.json 的 "session-sync" 字段
import fs from 'node:fs';
import path from 'node:path';
import { roleRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  finalizeSession,
} from '../ir.mjs';
import { applyProvenanceToIR, extractFromJsonObject } from '../provenance.mjs';
import { firstExisting, outputText } from './base.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, fileMtime, inTimeRange,
  parseArgs,
  TOOL_RESULT_ONLY,
} from './base.mjs';
import { previewTitle } from '../titles.mjs';

function projectsDir(ctx) {
  return firstExisting(roleRoots('freebuff', ctx, 'projects'))?.path ?? null;
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 会话目录索引：id = chats 目录名（全局唯一的会话标识，与 identity 派生一致）
// project 只作为定位信息，不参与 id（否则 list 的 id 与派生 id 形态不一致会导致重复导入）
function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  for (const f of walkFiles(dir, { maxDepth: 4, match: (n) => n === 'chat-messages.json' || n === 'chat-meta.json' })) {
    const chatDir = path.dirname(f);
    const project = path.basename(path.dirname(path.dirname(chatDir)));
    const chatsName = path.basename(chatDir);
    const cur = map.get(chatsName) ?? { id: chatsName, dir: chatDir, project, chatsName };
    if (path.basename(f) === 'chat-messages.json') cur.messages = f;
    if (path.basename(f) === 'chat-meta.json') cur.meta = f;
    map.set(chatsName, cur);
  }
  return map;
}

// 目录名形如 2026-08-17T09-22-24.284Z
function timeFromDirName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})[.\d]*Z$/.exec(name);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// 单条 chat-messages 元素 → 条目
function toEntry(msg, fallbackTs) {
  const variant = String(msg?.variant ?? msg?.role ?? '');
  const blocks = Array.isArray(msg?.blocks) ? msg.blocks : [];

  if (variant === 'user') {
    const items = [];
    const text = stripSystemInjections(typeof msg.content === 'string' ? msg.content : '');
    if (text) items.push(messageItem('user', text, fallbackTs));
    for (const b of blocks) {
      if (b?.type === 'text' && b.content) {
        const t = stripSystemInjections(b.content);
        if (t) items.push(messageItem('user', t, fallbackTs));
      }
    }
    return items.length ? { role: 'user', ts: fallbackTs, items } : null;
  }

  // ai 侧：content 常为空，正文在 blocks
  const items = [];
  const plain = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (plain) items.push(messageItem('assistant', plain, fallbackTs));
  for (const b of blocks) {
    switch (b?.type) {
      case 'text': {
        const text = String(b.content ?? '');
        if (!text) break;
        if (b.textType === 'reasoning') items.push(reasoningItem(text, fallbackTs));
        else items.push(messageItem('assistant', text, fallbackTs));
        break;
      }
      case 'tool': {
        const callId = b.toolCallId ?? null;
        const name = b.toolName ?? 'tool';
        if (!b[TOOL_RESULT_ONLY]) items.push(toolCallItem(callId, name, parseArgs(b.input), fallbackTs));
        items.push(toolResultItem(callId, name, b.isError ? 'error' : 'ok', outputText(b.output), fallbackTs));
        break;
      }
      case 'agent':
        // 子代理分隔标记：纯 UI 标记，不产生内容项（agentId 不是附件）
        break;
      default:
        // mode-divider / 其它 UI 标记
        break;
    }
  }
  return items.length ? { role: 'assistant', ts: fallbackTs, items } : null;
}

export const freebuffReader = {
  variant: 'freebuff',
  label: 'Freebuff (Codebuff)',

  available(ctx) {
    const d = projectsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const [id, s] of indexSessions(projectsDir(ctx))) {
      const meta = s.meta ? safeReadJson(s.meta, {}) : {};
      const runState = safeReadJson(path.join(s.dir, 'run-state.json'), {});
      const cwd = runState?.sessionState?.fileContext?.projectRoot ?? runState?.sessionState?.fileContext?.cwd ?? '';
      const createdAt = timeFromDirName(s.chatsName) || Number(meta?.createdAt) || 0;
      const updatedAt = Number(meta?.messagesMtimeMs) || fileMtime(s.messages ?? s.meta ?? s.dir);
      const preview = String(meta?.firstPrompt ?? '').replace(/\s+/g, ' ').slice(0, 120);
      // 轮次按 read 的同一套条目构造算：messageCount 是消息条数（user+ai 各一条），
      // 直接拿来当轮次会翻倍（真机 8 轮报成 16 轮）
      const rawMessages = s.messages ? safeReadJson(s.messages, null) : null;
      const messageList = Array.isArray(rawMessages) ? rawMessages : Array.isArray(rawMessages?.messages) ? rawMessages.messages : [];
      const turns = assembleTurns(messageList.map((m) => toEntry(m, createdAt)).filter(Boolean)).length;
      out.push({
        id,
        variant: 'freebuff',
        title: previewTitle(preview) || 'untitled',
        preview,
        cwd,
        createdAt,
        updatedAt,
        turns,
        turnsApprox: false,
        model: null,
        project: s.project,
        provenance: extractFromJsonObject(meta),
        sourcePath: s.dir,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const s = indexSessions(projectsDir(ctx)).get(String(id));
    if (!s || !s.messages) return null;
    const raw = safeReadJson(s.messages, null);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : [];
    const meta = s.meta ? safeReadJson(s.meta, {}) : {};
    const runState = safeReadJson(path.join(s.dir, 'run-state.json'), {});
    const cwd = runState?.sessionState?.fileContext?.projectRoot ?? runState?.sessionState?.fileContext?.cwd ?? '';

    const createdAt = timeFromDirName(s.chatsName) || Number(meta?.createdAt) || 0;
    const entries = [];
    for (const msg of list) {
      const e = toEntry(msg, createdAt);
      if (e) entries.push(e);
    }
    const turns = assembleTurns(entries);
    const session = makeSession({
      id: String(id),
      variant: 'freebuff',
      title: deriveTitle(String(meta?.firstPrompt ?? ''), turns),
      cwd,
      createdAt,
      updatedAt: Number(meta?.messagesMtimeMs) || fileMtime(s.messages),
      model: null,
      turns,
      meta: { sourcePath: s.dir, project: s.project, chatDir: s.chatsName },
    });
    applyProvenanceToIR(session, extractFromJsonObject(meta));
    return finalizeSession(session);
  },
};
