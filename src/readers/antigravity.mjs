// readers/antigravity.mjs — Antigravity CLI
//
// 存储：~/.gemini/antigravity-cli/conversations/<conversationId>.db
//   每个 db = 一个会话；表 trajectory_meta / steps / gen_metadata / executor_metadata
//   / parent_references / trajectory_metadata_blob / battle_mode_infos
// steps.step_payload / metadata / task_details 是 protobuf 二进制（BLOB），
// 但内部嵌了完整可读 JSON：
//   {"step_index":N,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>…"}
//   {"step_index":N,"source":"MODEL","type":"PLANNER_RESPONSE","content":"…","thinking":"…","tool_calls":[…]}
// 因此按「字节流里扫配平 JSON 对象」提取正文，质量接近正常读取。
// cwd 取自同目录 history.jsonl 的 workspace（按 conversationId 关联）。
// provenance 槽位：sidecar（db 为二进制，无法内嵌）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { roleRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  noteItem,
  finalizeSession,
} from '../ir.mjs';
import { applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { firstExisting } from './base.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, toMs, fileMtime, tableExists, inTimeRange,
  parseArgs, pushAssistantItem } from './base.mjs';
import { previewTitle } from '../titles.mjs';

function conversationsDir(ctx) {
  return firstExisting(roleRoots('antigravity', ctx, 'sessions'))?.path ?? null;
}

// sqlite 返回 BLOB 可能是 Buffer / Uint8Array / 数字键对象（旧库也可能是文本）
function toBuf(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'binary');
  if (typeof v === 'object') {
    const keys = Object.keys(v)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
    if (!keys.length) return null;
    const b = Buffer.alloc(keys[keys.length - 1] + 1);
    for (const k of keys) b[k] = Number(v[k]) & 0xff;
    return b;
  }
  return null;
}

// 在字节流里扫描配平的 JSON 对象（跳过字符串内的括号）
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
          } catch {
            /* 不是完整 JSON，继续向后 */
          }
          break;
        }
      }
    }
  }
  return out;
}

// 会话目录下的 history.jsonl：conversationId → {workspace, prompts[]}
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

function listDbs(dir) {
  if (!dir) return [];
  return walkFiles(dir, { maxDepth: 1, match: (n) => n.endsWith('.db') && !n.includes('.session-sync.') });
}

// 读取一个会话 db → {steps:[{idx, blobs[]}], trajectory}
function readDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = { steps: [], trajectory: null };
    if (tableExists(db, 'trajectory_meta')) {
      out.trajectory = db.prepare('SELECT * FROM trajectory_meta LIMIT 1').get() ?? null;
    }
    if (!tableExists(db, 'steps')) return out;
    const rows = db.prepare('SELECT * FROM steps ORDER BY idx').all();
    for (const row of rows) {
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
      out.steps.push({ idx: Number(row.idx) || 0, type: Number(row.step_type) || 0, blobs });
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

function buildEntries(parsed) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  // step_index 决定顺序；同一 step 内 USER_INPUT 先于 PLANNER_RESPONSE
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
    // PLANNER_RESPONSE
    const items = [];
    if (o.thinking) items.push(reasoningItem(o.thinking, ts));
    const text = String(o.content ?? '').trim();
    if (text) items.push(messageItem('assistant', text, ts));
    for (const call of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      const input = call?.args ?? parseArgs(call?.argumentsJson ?? call?.arguments);
      items.push(toolCallItem(call?.id ?? null, call?.name ?? 'tool', input, ts));
    }
    if (items.length) entries.push({ role: 'assistant', ts, items });
  }
  return entries;
}

function summarize(parsed, historyEntry) {
  let createdAt = 0;
  let updatedAt = 0;
  let cwd = historyEntry?.workspace ?? '';
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
      if (isUserInput(o)) {
        const t = cleanUserInput(o.content);
        if (t) {
          userMsgs++;
          if (!preview) preview = t;
        }
      }
    }
  }
  if (!preview && historyEntry?.prompts?.length) preview = historyEntry.prompts[0].text;
  if (!userMsgs) userMsgs = historyEntry?.prompts?.length ?? 0;
  return { createdAt, updatedAt, cwd, preview, userMsgs, model };
}

export const antigravityReader = {
  variant: 'antigravity',
  label: 'Antigravity CLI',

  available(ctx) {
    const d = conversationsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const dir = conversationsDir(ctx);
    const history = readHistory(path.dirname(dir ?? ''));
    const out = [];
    for (const file of listDbs(dir)) {
      const id = path.basename(file, '.db');
      let parsed;
      try {
        parsed = readDb(file);
      } catch {
        continue;
      }
      const h = history.get(id);
      const s = summarize(parsed, h);
      out.push({
        id,
        variant: 'antigravity',
        title: previewTitle(s.preview) || 'untitled',
        preview: s.preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: s.cwd,
        createdAt: s.createdAt || fileMtime(file),
        updatedAt: s.updatedAt || fileMtime(file),
        turns: s.userMsgs,
        turnsApprox: false,
        model: s.model,
        steps: parsed.steps.length,
        readQuality: 'embedded-json',
        provenance: readSidecarProvenance(file),
        sourcePath: file,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const dir = conversationsDir(ctx);
    const file = path.join(dir, `${id}.db`);
    if (!fs.existsSync(file)) return null;
    const parsed = readDb(file);
    const history = readHistory(path.dirname(dir));
    const h = history.get(String(id));
    const s = summarize(parsed, h);

    const turns = assembleTurns(buildEntries(parsed));
    if (turns.length === 0) {
      // 完全无可解内容：保留一条说明，避免产生"空会话"误导
      turns.push({ index: 0, role: 'system', items: [noteItem('antigravity: 该会话的 steps 中未提取到可读正文')] });
    }

    const session = makeSession({
      id: String(id),
      variant: 'antigravity',
      title: deriveTitle(s.preview, turns),
      cwd: s.cwd,
      createdAt: s.createdAt || fileMtime(file),
      updatedAt: s.updatedAt || fileMtime(file),
      model: s.model,
      turns,
      meta: {
        sourcePath: file,
        readQuality: 'embedded-json',
        trajectory: parsed.trajectory ?? null,
        steps: parsed.steps.length,
        historyPrompts: h?.prompts?.length ?? 0,
      },
    });
    applyProvenanceToIR(session, readSidecarProvenance(file));
    return finalizeSession(session);
  },
};
