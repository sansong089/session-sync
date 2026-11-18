// readers/pi.mjs — Pi
//
// 存储：<root>/agent/sessions/<project-slug>/<ISO时间>_<sessionId>.jsonl
// 事件：session(头) / model_change / thinking_level_change / message
//  message.message.role = user | assistant | toolResult
//   content 类型：text / toolCall{id,name,arguments} / image
// provenance 槽位：专用行 type="session-sync/provenance" + sidecar 兜底
import fs from 'node:fs';
import path from 'node:path';
import { roleRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  attachmentItem,
  finalizeSession,
} from '../ir.mjs';
import { toPiBlock, toolResultItemOfRow } from '../pi-agent-blocks.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { firstExisting } from './base.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, listEvents, parseJsonl, toMs, fileMtime, inTimeRange,
  pushAssistantItem } from './base.mjs';
import { outputText } from '../text.mjs';
import { previewTitle } from '../titles.mjs';

export const PROVENANCE_LINE_TYPE = 'session-sync/provenance';

function sessionsDir(ctx) {
  return firstExisting(roleRoots('pi', ctx, 'sessions'))?.path ?? null;
}

// 文件名形如 2026-08-10T05-56-16-791Z_019fea3e-4317-7747-98fb-6004a68d6f9b.jsonl
function idFromFile(file) {
  const base = path.basename(file, '.jsonl');
  const i = base.lastIndexOf('_');
  return i >= 0 ? base.slice(i + 1) : base;
}

function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  for (const f of walkFiles(dir, { maxDepth: 3, match: (n) => n.endsWith('.jsonl') && !n.includes('.session-sync.') })) {
    const id = idFromFile(f);
    const prev = map.get(id);
    if (!prev || fileMtime(f) > fileMtime(prev)) map.set(id, f);
  }
  return map;
}

// content → 文本：走 text.mjs 的唯一实现。
// 本地那份把「非数组非字符串」一律当空串，`{text:'x'}` 这种包一层的形态会被整段丢掉
function textOf(content) {
  return outputText(content) ?? '';
}

function consumeMeta(ev, acc) {
  const m = ev.message;
  const ts = toMs(ev.timestamp) || toMs(m?.timestamp);
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    if (ts > acc.updatedAt) acc.updatedAt = ts;
  }
  if (ev.type === 'session') {
    if (ev.cwd) acc.cwd = ev.cwd;
    if (ev.id) acc.sessionId = String(ev.id);
    if (ev.timestamp && !acc.createdAt) acc.createdAt = toMs(ev.timestamp);
  }
  if (ev.type === 'model_change' && ev.modelId && !acc.model) acc.model = ev.modelId;
  if (m?.model && !acc.model) acc.model = m.model;
  if (ev.type === PROVENANCE_LINE_TYPE) {
    const prov = provenanceFromObject(ev['session-sync']);
    if (prov) acc.provenance = prov;
  }
}

function replayEntries(lines) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  for (const ev of lines) {
    if (ev.type !== 'message') continue;
    const m = ev.message;
    if (!m) continue;
    const ts = toMs(ev.timestamp) || toMs(m.timestamp);

    if (m.role === 'user') {
      const items = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'text' && c.text) {
          const t = stripSystemInjections(c.text);
          if (t) items.push(messageItem('user', t, ts));
        } else if (c?.type === 'image') {
          items.push(attachmentItem(c.path ?? c.url ?? c.source?.url ?? 'image', 'image', ts));
        }
      }
      if (items.length) entries.push({ role: 'user', ts, items });
      continue;
    }

    if (m.role === 'assistant') {
      const items = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        // 块词汇与 minimax 同源（pi-agent runtime）：映射走 pi-agent-blocks 的唯一实现
        const b = toPiBlock(c);
        if (!b) continue;
        if (b.type === 'text') {
          if (b.text) items.push(messageItem('assistant', b.text, ts));
        } else if (b.type === 'thinking') {
          if (b.thinking) items.push(reasoningItem(b.thinking, ts));
        } else if (b.type === 'tool_use') {
          items.push(toolCallItem(b.id, b.name, b.input, ts));
        } else if (b.type === 'image') {
          items.push(attachmentItem(b.path || 'image', 'image', ts));
        }
      }
      if (items.length) entries.push({ role: 'assistant', ts, items });
      continue;
    }

    if (m.role === 'toolResult') {
      const item = toolResultItemOfRow(m, ts);
      if (Array.isArray(m.content)) {
        for (const c of m.content) if (c?.type === 'image') pushItem(attachmentItem(c.path ?? 'image', 'tool image', ts), ts);
      }
      pushItem(item, ts);
    }
  }
  return entries;
}

export const piReader = {
  variant: 'pi',
  label: 'Pi',

  available(ctx) {
    const d = sessionsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const [id, file] of indexSessions(sessionsDir(ctx))) {
      const acc = { createdAt: 0, updatedAt: 0, cwd: '', model: null, provenance: null, sessionId: id };
      let userMsgs = 0;
      let preview = '';
      for (const ev of listEvents(file)) {
        consumeMeta(ev, acc);
        if (ev.type === 'message' && ev.message?.role === 'user') {
          const t = stripSystemInjections(textOf(ev.message.content));
          if (t) {
            userMsgs++;
            if (!preview) preview = t;
          }
        }
      }
      out.push({
        id,
        variant: 'pi',
        title: previewTitle(preview) || 'untitled',
        preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: acc.cwd,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt || fileMtime(file),
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
    const file = indexSessions(sessionsDir(ctx)).get(String(id));
    if (!file) return null;
    const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
    const acc = { createdAt: 0, updatedAt: 0, cwd: '', model: null, provenance: null };
    for (const ev of lines) consumeMeta(ev, acc);

    const turns = assembleTurns(replayEntries(lines));
    const session = makeSession({
      id: String(id),
      variant: 'pi',
      title: deriveTitle('', turns),
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
