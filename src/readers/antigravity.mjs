// readers/antigravity.mjs — Antigravity（桌面 Hub / IDE / CLI 共用一个变体）
//
// 一个变体跨四个落点（详见 hosts.mjs 的 VARIANTS.antigravity 注释）：
//   ~/.gemini/antigravity          桌面 Hub 活库：每会话一个 SQLite + conversation_summaries.db
//   ~/.gemini/antigravity-cli      CLI 会话库：同样的 steps 表 + history.jsonl
//   ~/.gemini/antigravity-ide      独立 IDE：只有旧加密 .pb，正文不可读
//   ~/.gemini/antigravity-backup   升级备份：同 ID 的旧 .pb，正文不可读
//
// 正文形态两代：
//   新 .db  —— steps.step_payload 是 protobuf，正文/思考/工具调用按 step_type 落在不同子消息；
//              由 antigravity-proto.mjs 解码（读写共用同一份 schema 取证）。
//   旧内嵌 JSON —— 早期版本把 USER_INPUT / PLANNER_RESPONSE 塞在 protobuf 外壳里，保留兜底。
//   旧 .pb   —— 每文件随机密钥加密（熵 7.999、双副本仅 0.4% 相同），无密钥不可读，直接跳过。
//
// provenance 槽位：sidecar（db 为二进制，无法内嵌）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { roleRoots } from '../roots.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, noteItem, finalizeSession } from '../ir.mjs';
import { applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import {
  assembleTurns, deriveTitle, stripSystemInjections, walkFiles, toMs, fileMtime, tableExists, inTimeRange,
  parseArgs, pushAssistantItem,
} from './base.mjs';
import { decodeStepRow, decodeWorkspaceBlob, uriToPath, toBuf } from './antigravity-proto.mjs';
import { previewTitle } from '../titles.mjs';

// 优先级：Hub 是活库且带摘要表；CLI 次之；IDE/备份只有加密 .pb（这里仍扫一遍以便按 ID 去重时保持顺序）
const ROLE_PRIORITY = { hub: 0, sessions: 1, ide: 2, backup: 3 };

/** 逐 role 取根（不放进循环变量：role 必须有显式消费者，见 test/m77-role-declaration） */
function rootsForRole(ctx, role) {
  switch (role) {
    case 'hub':
      return roleRoots('antigravity', ctx, 'hub');
    case 'sessions':
      return roleRoots('antigravity', ctx, 'sessions');
    case 'ide':
      return roleRoots('antigravity', ctx, 'ide');
    case 'backup':
      return roleRoots('antigravity', ctx, 'backup');
    default:
      return [];
  }
}

/** 四个根下的 conversations 目录（去重，按优先级排） */
export function conversationDirs(ctx) {
  const out = [];
  for (const role of ['hub', 'sessions', 'ide', 'backup']) {
    for (const r of rootsForRole(ctx, role)) {
      if (r.kind !== 'dir' || !r.path) continue;
      if (!out.some((x) => x.path === r.path)) out.push({ role, path: r.path });
    }
  }
  return out;
}

/** 侧栏摘要库：唯一出口是 aux role（与 writer 共用） */
function summariesDbOf(ctx) {
  const f = roleRoots('antigravity', ctx, 'aux').find((r) => r.kind === 'file')?.path ?? null;
  return f && fs.existsSync(f) ? f : null;
}

function readSummaries(ctx) {
  const map = new Map();
  const file = summariesDbOf(ctx);
  if (!file) return map;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return map;
  }
  try {
    if (!tableExists(db, 'conversation_summaries')) return map;
    for (const r of db.prepare('SELECT * FROM conversation_summaries').all()) {
      map.set(String(r.conversation_id), r);
    }
  } catch {
    /* 老库无此表 */
  } finally {
    try {
      db.close();
    } catch { /* ignore */ }
  }
  return map;
}

function parseHostTime(v) {
  const s = String(v ?? '');
  if (!s || s.startsWith('0001-')) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function urisToPath(uris) {
  for (const u of uris || []) {
    const p = uriToPath(u);
    if (p) return p;
  }
  return '';
}

// 在字节流里扫描配平的 JSON 对象（跳过字符串内的括号）—— 老形态兜底
export function extractJsonBlobs(buf) {
  const out = [];
  const s = buf.toString('utf8');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const o = JSON.parse(s.slice(i, j + 1));
            if (o && typeof o === 'object' && !Array.isArray(o)) {
              out.push(o);
              i = j;
            }
          } catch { /* 不是完整 JSON，继续向后 */ }
          break;
        }
      }
    }
  }
  return out;
}

// 会话目录下的 history.jsonl：conversationId → {workspace, prompts[]}（CLI 形态）
function readHistory(baseDir) {
  const map = new Map();
  const file = path.join(baseDir, 'history.jsonl');
  if (!fs.existsSync(file)) return map;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    const cid = o.conversationId;
    if (!cid) continue;
    const cur = map.get(cid) ?? { workspace: '', prompts: [] };
    if (o.workspace && !cur.workspace) cur.workspace = o.workspace;
    if (typeof o.display === 'string' && o.type !== 'slash_command') cur.prompts.push({ text: o.display, ts: toMs(o.timestamp) });
    map.set(cid, cur);
  }
  return map;
}

/** 全部会话文件（.db），按 ID 去重；.pb 是密文，直接跳过 */
export function findConversationFiles(ctx) {
  const byId = new Map();
  for (const dir of conversationDirs(ctx)) {
    if (!fs.existsSync(dir.path)) continue;
    for (const file of walkFiles(dir.path, { maxDepth: 1, match: (n) => n.endsWith('.db') && !n.includes('.session-sync.') })) {
      const id = path.basename(file, '.db');
      const prev = byId.get(id);
      const mtime = fileMtime(file);
      if (prev && (prev.priority < ROLE_PRIORITY[dir.role] || (prev.priority === ROLE_PRIORITY[dir.role] && prev.mtime >= mtime))) continue;
      byId.set(id, { id, file, role: dir.role, priority: ROLE_PRIORITY[dir.role], mtime });
    }
  }
  return [...byId.values()].sort((a, b) => b.mtime - a.mtime);
}

/** 读取一个会话 db → protobuf 步骤 + 老 JSON blobs + 工作区 URI */
function readDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = { steps: [], trajectory: null, workspaceUris: [] };
    if (tableExists(db, 'trajectory_meta')) {
      out.trajectory = db.prepare('SELECT * FROM trajectory_meta LIMIT 1').get() ?? null;
    }
    if (tableExists(db, 'trajectory_metadata_blob')) {
      try {
        const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'").get();
        if (row) out.workspaceUris = decodeWorkspaceBlob(row.data);
      } catch { /* 老库无此表 */ }
    }
    if (!tableExists(db, 'steps')) return out;
    const rows = db.prepare('SELECT * FROM steps ORDER BY idx').all();
    for (const row of rows) {
      const decoded = decodeStepRow(row);
      const blobs = [];
      const seen = new Set();
      for (const col of ['step_payload', 'metadata', 'task_details']) {
        const buf = toBuf(row[col]);
        if (!buf) continue;
        for (const o of extractJsonBlobs(buf)) {
          const key = JSON.stringify(o);
          if (seen.has(key)) continue;
          seen.add(key);
          blobs.push(o);
        }
      }
      if (decoded || blobs.length) out.steps.push({ idx: Number(row.idx) || 0, type: Number(row.step_type) || 0, decoded, blobs });
    }
    return out;
  } finally {
    db.close();
  }
}

// USER_INPUT.content 被包在 <USER_REQUEST>/<ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> 里
function cleanUserInput(content) {
  let t = String(content ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
  if (m) t = m[1];
  t = t.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '');
  t = t.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
  return stripSystemInjections(t);
}

function isUserInput(o) {
  return o && (o.type === 'USER_INPUT' || (o.source === 'USER_EXPLICIT' && typeof o.content === 'string'));
}
function isPlannerResponse(o) {
  return o && (o.type === 'PLANNER_RESPONSE' || (o.source === 'MODEL' && typeof o.content === 'string'));
}

/** protobuf 步骤 → entries */
function buildProtoEntries(parsed) {
  const entries = [];
  const push = (item, ts) => pushAssistantItem(entries, item, ts);
  for (const step of parsed.steps) {
    const d = step.decoded;
    if (!d) continue;
    if (d.role === 'user') {
      const text = cleanUserInput(d.content);
      if (text) entries.push({ role: 'user', ts: d.ts, items: [messageItem('user', text, d.ts)] });
    } else if (d.role === 'assistant') {
      const items = [];
      if (d.thinking) items.push(reasoningItem(d.thinking, d.ts));
      if (d.content) items.push(messageItem('assistant', d.content, d.ts));
      for (const tc of d.toolCalls) items.push(toolCallItem(tc.id, tc.name, tc.input, d.ts));
      for (const item of items) push(item, d.ts);
    } else if (d.toolCalls.length) {
      const tc = d.toolCalls[0];
      push(toolResultItem(tc.id, tc.name, 'ok', d.output || null, d.ts), d.ts);
    }
  }
  return entries;
}

/** 老内嵌 JSON 步骤 → entries（保留旧库可读） */
function buildJsonEntries(parsed) {
  const entries = [];
  const push = (item, ts) => pushAssistantItem(entries, item, ts);
  const events = [];
  for (const step of parsed.steps) {
    for (const o of step.blobs) {
      if (isUserInput(o) || isPlannerResponse(o)) events.push({ step: step.idx, order: isUserInput(o) ? 0 : 1, o });
    }
  }
  events.sort((a, b) => a.step - b.step || a.order - b.order);
  for (const { o } of events) {
    const ts = toMs(o.created_at);
    if (isUserInput(o)) {
      const text = cleanUserInput(o.content);
      if (text) entries.push({ role: 'user', ts, items: [messageItem('user', text, ts)] });
      continue;
    }
    const items = [];
    if (o.thinking) items.push(reasoningItem(o.thinking, ts));
    const text = String(o.content ?? '').trim();
    if (text) items.push(messageItem('assistant', text, ts));
    for (const call of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      const input = call?.args ?? parseArgs(call?.argumentsJson ?? call?.arguments);
      items.push(toolCallItem(call?.id ?? null, call?.name ?? 'tool', input, ts));
    }
    for (const item of items) push(item, ts);
  }
  return entries;
}

function buildEntries(parsed) {
  const proto = buildProtoEntries(parsed);
  return proto.length ? proto : buildJsonEntries(parsed);
}

function summarize(parsed, { summary = null, historyEntry = null, file = '' } = {}) {
  let createdAt = 0;
  let updatedAt = 0;
  let cwd = '';
  let preview = '';
  let userMsgs = 0;
  let model = null;
  for (const step of parsed.steps) {
    for (const o of step.blobs) {
      const ts = toMs(o.created_at);
      if (ts) {
        if (!createdAt || ts < createdAt) createdAt = ts;
        if (ts > updatedAt) updatedAt = ts;
      }
      if (!cwd) {
        const c = o.Cwd ?? o.cwd;
        if (typeof c === 'string' && c) cwd = c;
      }
      if (typeof o.model === 'string' && !model) model = o.model;
    }
    const d = step.decoded;
    if (d?.ts) {
      if (!createdAt || d.ts < createdAt) createdAt = d.ts;
      if (d.ts > updatedAt) updatedAt = d.ts;
    }
    if (d?.role === 'user') {
      const t = cleanUserInput(d.content);
      if (t) {
        userMsgs++;
        if (!preview) preview = t;
      }
    }
  }
  const summaryTime = parseHostTime(summary?.last_modified_time);
  if (summaryTime) updatedAt = Math.max(updatedAt, summaryTime);
  const userTime = parseHostTime(summary?.last_user_input_time);
  if (userTime) createdAt = createdAt || userTime;
  if (!preview) preview = String(summary?.title || summary?.preview || '');
  if (!preview && historyEntry?.prompts?.length) preview = historyEntry.prompts[0].text;
  if (!cwd) cwd = urisToPath(parsed.workspaceUris);
  if (!cwd && summary?.workspace_uris) {
    try {
      cwd = urisToPath(JSON.parse(String(summary.workspace_uris)));
    } catch { /* ignore */ }
  }
  if (!cwd) cwd = historyEntry?.workspace ?? '';
  if (!userMsgs) userMsgs = Number(summary?.step_count) || historyEntry?.prompts?.length || 0;
  return { createdAt, updatedAt, cwd, preview, userMsgs, model };
}

export const antigravityReader = {
  variant: 'antigravity',
  label: 'Antigravity',

  available(ctx) {
    return conversationDirs(ctx).some((d) => fs.existsSync(d.path));
  },

  list(ctx, opts = {}) {
    const summaries = readSummaries(ctx);
    const historyByDir = new Map();
    const out = [];
    for (const found of findConversationFiles(ctx)) {
      let parsed;
      try {
        parsed = readDb(found.file);
      } catch {
        continue;
      }
      if (!parsed.steps.length) continue;
      if (!historyByDir.has(found.role)) {
        historyByDir.set(found.role, readHistory(path.dirname(conversationDirs(ctx).find((d) => d.role === found.role)?.path ?? found.file)));
      }
      const historyEntry = historyByDir.get(found.role).get(found.id);
      const s = summarize(parsed, { summary: summaries.get(found.id), historyEntry, file: found.file });
      const hasProto = parsed.steps.some((x) => x.decoded?.role === 'user' || x.decoded?.role === 'assistant');
      out.push({
        id: found.id,
        variant: 'antigravity',
        title: String(summaries.get(found.id)?.title || '').trim() || previewTitle(s.preview) || 'untitled',
        preview: s.preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: s.cwd,
        createdAt: s.createdAt || fileMtime(found.file),
        updatedAt: s.updatedAt || fileMtime(found.file),
        turns: s.userMsgs,
        turnsApprox: false,
        model: s.model,
        steps: parsed.steps.length,
        readQuality: hasProto ? 'protobuf' : 'embedded-json',
        provenance: readSidecarProvenance(found.file),
        sourcePath: found.file,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const found = findConversationFiles(ctx).find((x) => x.id === String(id));
    if (!found) return null;
    const parsed = readDb(found.file);
    const summary = readSummaries(ctx).get(String(id)) ?? null;
    let historyEntry = null;
    for (const dir of conversationDirs(ctx)) {
      const h = readHistory(path.dirname(dir.path));
      if (h.has(String(id))) {
        historyEntry = h.get(String(id));
        break;
      }
    }
    const s = summarize(parsed, { summary, historyEntry, file: found.file });
    const turns = assembleTurns(buildEntries(parsed));
    if (turns.length === 0) {
      turns.push({ index: 0, role: 'system', items: [noteItem('antigravity: 该会话的 steps 中未提取到可读正文（旧 .pb 为加密格式）')] });
    }
    const hasProto = parsed.steps.some((x) => x.decoded?.role === 'user' || x.decoded?.role === 'assistant');
    const session = makeSession({
      id: String(id),
      variant: 'antigravity',
      title: String(summary?.title || '').trim() || deriveTitle(s.preview, turns),
      cwd: s.cwd,
      createdAt: s.createdAt || fileMtime(found.file),
      updatedAt: s.updatedAt || fileMtime(found.file),
      model: s.model,
      turns,
      meta: {
        sourcePath: found.file,
        readQuality: hasProto ? 'protobuf' : 'embedded-json',
        trajectory: parsed.trajectory ?? null,
        steps: parsed.steps.length,
        workspaceUris: parsed.workspaceUris,
        projectId: String(summary?.project_id || ''),
        historyPrompts: historyEntry?.prompts?.length ?? 0,
      },
    });
    applyProvenanceToIR(session, readSidecarProvenance(found.file));
    return finalizeSession(session);
  },
};
