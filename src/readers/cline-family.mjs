// readers/cline-family.mjs — Cline 血统任务目录（Cline / Kilo Code / Roo 扩展）
// 两种落点形态（cline 实测三代路径，见 hosts.mjs）：
//   role=tasks    ：<tasks>/<taskId>/{api_conversation_history.json, ui_messages.json, task_metadata.json}
//   role=sessions ：<sessions>/<id>/{<id>.json（元数据：cwd/model/prompt/title）, <id>.messages.json（Claude 同构消息流）}
import path from 'node:path';
import fs from 'node:fs';
import { VARIANTS } from '../hosts.mjs';
import { makeSession, messageItem, toolCallItem, toolResultItem, metaItem, attachmentItem, finalizeSession } from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR } from '../provenance.mjs';
import { safeJson, assembleTurns, deriveTitle, stripSystemInjections, toMs, adoptSiblingIdentity, inTimeRange } from './base.mjs';

import { isDir, isFile } from '../util.mjs';
import { candidateRoots, roleRoots } from '../roots.mjs';
import { claudeLikeReplayEntries } from './claude.mjs';
import { previewTitle } from '../titles.mjs';

function entriesOf(ctx, variant, role) {
  // tasks / sessions 都是显式 role 了，不再用「不是 sessions 就是 tasks」的排除法
  return candidateRoots(variant, ctx).filter((x) => x.kind === 'dir' && x.role === role);
}

function taskDirs(ctx, variant) {
  const out = [];
  for (const x of entriesOf(ctx, variant, 'tasks')) {
    if (isDir(x.path) && fs.readdirSync(x.path).length > 0) out.push(x.path);
  }
  return out;
}

function sessionDirs(ctx, variant) {
  return entriesOf(ctx, variant, 'sessions').filter((x) => isDir(x.path));
}

// 会话库（Cline 4.x）把 provenance 放在 manifest.metadata 里；legacy 任务目录放在任务元数据顶层
function storeProvenance(meta) {
  return provenanceFromObject(meta?.metadata?.['session-sync']) || provenanceFromObject(meta?.['session-sync']) || null;
}

// <sessions>/<id>/<id>.messages.json；messages_path 优先用元数据里的指针
function indexSessions(ctx, variant) {
  const map = new Map();
  for (const { path: root } of sessionDirs(ctx, variant)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const metaFile = isFile(path.join(dir, `${e.name}.json`)) ? path.join(dir, `${e.name}.json`) : null;
      const meta = metaFile ? safeJson(fs.readFileSync(metaFile, 'utf8'), {}) || {} : {};
      const id = String(meta.session_id || e.name);
      const pointed = typeof meta.messages_path === 'string' && isFile(meta.messages_path) ? meta.messages_path : null;
      const msgFile = pointed ?? (isFile(path.join(dir, `${e.name}.messages.json`)) ? path.join(dir, `${e.name}.messages.json`) : null);
      if (!msgFile) continue;
      map.set(id, { id, dir, metaFile, msgFile });
    }
  }
  return map;
}

// 数组兜底：任务文件被截断或被写成单个对象时返回 []，不让一个坏文件拖垮整个变体的 list
const asArray = (v) => (Array.isArray(v) ? v : []);

function readMessages(file) {
  const doc = safeJson(fs.readFileSync(file, 'utf8'), {}) || {};
  return asArray(doc.messages);
}

// cline 的消息流是 {id, role, content:[{type:...}], ts}，与 Claude 的 {type, message:{content}} 只差一层壳
function toClaudeEvents(messages) {
  const evs = [];
  for (const m of messages) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    evs.push({ type: role, timestamp: toMs(m.ts), message: { role, content } });
  }
  return evs;
}

function readTaskMeta(dir) {
  const f = path.join(dir, 'task_metadata.json');
  if (!isFile(f)) return {};
  return safeJson(fs.readFileSync(f, 'utf8'), {}) || {};
}

// 任务目录时间兜底：目录名可能是时间戳（Cline）或 uuid（Kilo），统一回退到目录 mtime
function dirTime(dir) {
  try {
    return Math.floor(fs.statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
}

function apiHistoryItems(content) {
  const items = [];
  for (const c of content || []) {
    if (typeof c === 'string') {
      items.push(messageItem('user', c, 0));
      continue;
    }
    switch (c?.type) {
      case 'text': {
        const text = stripSystemInjections(c.text);
        if (text) items.push(messageItem('user', text, 0));
        break;
      }
      case 'tool_use':
        items.push(toolCallItem(c.id ?? null, c.name ?? 'tool', c.input ?? null, 0));
        break;
      case 'tool_result':
        items.push(toolResultItem(c.tool_use_id ?? null, 'tool', 'ok', c.content ?? null, 0));
        break;
      default:
        if (typeof c?.text === 'string') items.push(messageItem('user', c.text, 0));
        break;
    }
  }
  return items;
}

// 任务目录 → IR 条目：read 与 list 共用这一份，轮次数才不会两处各算一套
function taskEntries(dir, meta) {
  const entries = [];
  const apiFile = path.join(dir, 'api_conversation_history.json');
  const uiFile = path.join(dir, 'ui_messages.json');

  if (isFile(apiFile)) {
    const arr = asArray(safeJson(fs.readFileSync(apiFile, 'utf8'), []));
    for (const m of arr) {
      const rawRole = m?.role === 'assistant' ? 'assistant' : 'user';
      const ts = Number(m?.ts) || 0;
      const items = rawRole === 'assistant'
        ? apiHistoryItems(m.content).map((it) => (it.kind === 'message' ? { ...it, role: 'assistant' } : it))
        : apiHistoryItems(m.content);
      // 只有 tool_result 的 user 消息是工具回执，属于上一轮，不能开新 turn
      const hasUserText = items.some((it) => it.kind === 'message');
      const role = rawRole === 'user' && !hasUserText ? 'assistant' : rawRole;
      if (items.length) entries.push({ role, ts, items });
    }
  } else if (isFile(uiFile)) {
    const arr = asArray(safeJson(fs.readFileSync(uiFile, 'utf8'), []));
    for (const m of arr) {
      if (m?.say === 'api_req_started' || m?.say === 'api_req_finished' || m?.say === 'checkpoint_saved') continue;
      const isUser = m?.say === 'user_feedback' || m?.type === 'ask' && /followup|tool/i.test(m?.ask ?? '');
      const rawText = String(m?.text ?? '').trim();
      const text = isUser ? stripSystemInjections(rawText) : rawText;
      const items = [];
      if (text) items.push(messageItem(isUser ? 'user' : 'assistant', text, Number(m?.ts) || 0));
      for (const f of m?.files ?? []) items.push(attachmentItem(f, 'file', Number(m?.ts) || 0));
      if (items.length > 0) entries.push({ role: isUser ? 'user' : 'assistant', ts: Number(m?.ts) || 0, items });
    }
  }

  // files_in_context → meta
  const files = (meta.files_in_context || []).map((f) => f?.path).filter(Boolean);
  if (files.length > 0 && entries[0]) {
    entries[0].items.push(metaItem('files_in_context', files.slice(0, 20), entries[0].ts || 0));
  }
  return entries;
}

function parseTask(dir, id, variant) {
  const meta = readTaskMeta(dir);
  const prov = provenanceFromObject(meta['session-sync']) || null;

  const entries = taskEntries(dir, meta);
  const turns = assembleTurns(entries);
  const firstTs = Number(String(id).match(/^\d{10,}$/)?.[0]) || entries[0]?.ts || dirTime(dir);
  const lastTs = entries.length > 0 ? entries[entries.length - 1].ts || firstTs : firstTs;
  const session = makeSession({
    id,
    variant,
    title: deriveTitle('', turns),
    cwd: '',
    createdAt: firstTs,
    updatedAt: Math.max(lastTs, firstTs),
    model: meta.modelInfo?.modelId ?? null,
    turns,
    meta: { sourcePath: dir },
  });
  applyProvenanceToIR(session, prov);
  return finalizeSession(session);
}

// ---- <sessions> 形态（cline 三代 CLI）----
function sessionTitle(meta, turns) {
  const explicit = String(meta?.metadata?.title || meta?.title || '').replace(/\s+/g, ' ').trim();
  if (explicit) return explicit.slice(0, 120);
  if (turns.length) return deriveTitle('', turns);
  const prompt = stripSystemInjections(String(meta?.prompt || ''));
  return prompt ? prompt.replace(/\s+/g, ' ').slice(0, 120) : 'untitled';
}

function parseSessionDoc(entry, variant) {
  const meta = entry.metaFile ? safeJson(fs.readFileSync(entry.metaFile, 'utf8'), {}) || {} : {};
  const messages = readMessages(entry.msgFile);
  const turns = assembleTurns(claudeLikeReplayEntries(toClaudeEvents(messages)));
  const session = makeSession({
    id: entry.id,
    variant,
    title: sessionTitle(meta, turns),
    cwd: String(meta.cwd || meta.workspace_root || ''),
    createdAt: toMs(meta.started_at) || dirTime(entry.dir),
    updatedAt: Math.max(toMs(meta.ended_at) || 0, turns.at(-1)?.startedAt || 0, toMs(meta.started_at) || 0),
    model: meta.model ?? null,
    turns,
    meta: { sourcePath: entry.dir, messagesPath: entry.msgFile, status: meta.status ?? null, provider: meta.provider ?? null },
  });
  applyProvenanceToIR(session, storeProvenance(meta));
  return finalizeSession(session);
}

function summarizeSessionDoc(entry, variant) {
  const meta = entry.metaFile ? safeJson(fs.readFileSync(entry.metaFile, 'utf8'), {}) || {} : {};
  const messages = readMessages(entry.msgFile);
  let turns = 0;
  let preview = '';
  let lastTs = 0;
  for (const m of messages) {
    const ts = toMs(m?.ts);
    if (ts > lastTs) lastTs = ts;
    if (m?.role !== 'user') continue;
    const text = (Array.isArray(m.content) ? m.content : []).find((c) => c?.type === 'text')?.text;
    if (typeof text !== 'string') continue;
    const clean = stripSystemInjections(text);
    if (!clean) continue;
    turns++;
    if (!preview) preview = clean;
  }
  return {
    id: entry.id,
    variant,
    title: sessionTitle(meta, []).replace(/\s+/g, ' ').trim(),
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
    cwd: String(meta.cwd || meta.workspace_root || ''),
    createdAt: toMs(meta.started_at) || dirTime(entry.dir),
    updatedAt: Math.max(toMs(meta.ended_at) || 0, lastTs, toMs(meta.started_at) || 0),
    turns,
    model: meta.model ?? null,
    provenance: storeProvenance(meta),
    source: 'sessions',
    sourcePath: entry.dir,
  };
}

export function createClineFamilyReader({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    available(ctx) {
      return taskDirs(ctx, variant).length > 0 || indexSessions(ctx, variant).size > 0;
    },

    list(ctx, opts = {}) {
      const out = [];
      for (const root of taskDirs(ctx, variant)) {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const dir = path.join(root, e.name);
          const hasApi = isFile(path.join(dir, 'api_conversation_history.json'));
          const hasUi = isFile(path.join(dir, 'ui_messages.json'));
          if (!hasApi && !hasUi) continue;
          const meta = readTaskMeta(dir);
          let title = '';
          let firstUiTs = 0;
          if (hasUi) {
            const ui = asArray(safeJson(fs.readFileSync(path.join(dir, 'ui_messages.json'), 'utf8'), []));
            const firstTask = ui.find((m) => m?.say === 'task' || (m?.say === 'text' && m?.type === 'say'));
            title = previewTitle(firstTask?.text);
            firstUiTs = Number(ui.find((m) => Number(m?.ts) > 0)?.ts) || 0;
          }
          if (hasApi && !title) {
            const api = asArray(safeJson(fs.readFileSync(path.join(dir, 'api_conversation_history.json'), 'utf8'), []));
            const firstUser = api.find((m) => m?.role !== 'assistant');
            const text = Array.isArray(firstUser?.content)
              ? firstUser.content.map((c) => c?.text ?? '').join(' ')
              : String(firstUser?.content ?? '');
            title = previewTitle(stripSystemInjections(text));
            if (!firstUiTs) firstUiTs = Number(api.find((m) => Number(m?.ts) > 0)?.ts) || 0;
          }
          // 轮次走 read 的同一套条目构造：早先用 ui 的 say 分类 + api 的 user 行数凑数，
          // 会把「只有 tool_result 的 user 消息」当成新轮（真机 kilo/roo 多报 1 轮）
          const turns = assembleTurns(taskEntries(dir, meta)).length;
          const ts = Number(e.name.match(/^\d{10,}$/)?.[0]) || firstUiTs || dirTime(dir);
          out.push({
            id: e.name,
            variant,
            title,
            cwd: '',
            createdAt: ts,
            updatedAt: ts,
            turns,
            provenance: storeProvenance(meta),
            source: 'tasks',
            sourcePath: dir,
          });
        }
      }
      // 会话库（现行代际）排在前面；同 id 的合并由 listSessions 统一处理
      const storeRows = [...indexSessions(ctx, variant)].map(([, entry]) => summarizeSessionDoc(entry, variant));
      return [...storeRows, ...out].filter((s) => inTimeRange(s, opts));
    },

    read(ctx, id) {
      const hit = indexSessions(ctx, variant).get(String(id));
      const hits = [];
      for (const root of taskDirs(ctx, variant)) {
        const dir = path.join(root, id);
        if (isDir(dir) && (isFile(path.join(dir, 'api_conversation_history.json')) || isFile(path.join(dir, 'ui_messages.json')))) hits.push(dir);
      }
      const provOfTask = (dir) => provenanceFromObject(readTaskMeta(dir)['session-sync']) || null;
      // 会话库是首选正文（与 list 的 rank 一致）；宿主迁移时可能没带上任务元数据里的
      // session-sync 标记，用同 id 任务目录副本的 provenance 补身份
      if (hit) return adoptSiblingIdentity(parseSessionDoc(hit, variant), hits.map(provOfTask));
      if (hits.length) return adoptSiblingIdentity(parseTask(hits[0], id, variant), hits.slice(1).map(provOfTask));
      return null;
    },
  };
}
