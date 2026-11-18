// readers/dsh.mjs — DSH (DeepSeek Harness)
//
// 存储：<root>/sessions/<project-slug>/<会话目录>/session.v4.jsonl.zstd
//   注意：文件是「多帧 zstd 拼接」（每条事件一次压缩），zstdDecompressSync 只解第一帧，
//   必须按帧魔数 28 B5 2F FD 切分后逐帧解压。
// 事件：session(头) / turn/start / step/start / system/message / user/message
//      / assistant/message / tool/call / tool/result / session/title / step/end / turn/end
//      / agent/inbox/spliced / subagent/descriptor / sandbox/mode / approval/policy
//   assistant/message 的 content 已含 tool-call，独立的 tool/call 事件是重复投影 → 跳过
//   agent/inbox/spliced 与 user/message 内容重复 → 跳过
// provenance 槽位：会话目录下 provenance.json（sidecar）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { roleRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  attachmentItem,
  metaItem,
  finalizeSession,
} from '../ir.mjs';
import { applyProvenanceToIR, readSidecarProvenance, provenanceFromObject } from '../provenance.mjs';
import { firstExisting } from './base.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, toMs, fileMtime, inTimeRange,
  parseArgs, pushAssistantItem } from './base.mjs';
import { outputText } from '../text.mjs';
import { previewTitle } from '../titles.mjs';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const PROVENANCE_EVENT_TYPE = 'session-sync/provenance';

function magicOffsets(buf) {
  const magics = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    magics.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  return magics;
}

/**
 * 写侧用的整份解帧：任何一帧解不开就报失败。
 * 读侧那套「解不开就截断」对只读无害，但追加是解压→重写，静默截断会把宿主已有事件的尾巴抹掉。
 */
export function decodeZstdFramesAll(buf) {
  const magics = magicOffsets(buf);
  if (magics.length === 0) {
    try {
      return { ok: true, text: zlib.zstdDecompressSync(buf).toString('utf8') };
    } catch (err) {
      return { ok: false, reason: `不是可解的 zstd 载荷：${String(err?.message ?? err).slice(0, 100)}` };
    }
  }
  const parts = [];
  for (let k = 0; k < magics.length; k++) {
    const end = k + 1 < magics.length ? magics[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(magics[k], end)).toString('utf8'));
    } catch (err) {
      return { ok: false, reason: `第 ${k + 1}/${magics.length} 帧解不开：${String(err?.message ?? err).slice(0, 100)}` };
    }
  }
  return { ok: true, text: parts.join('') };
}

/**
 * 解压多帧 zstd。
 * 帧边界靠魔数切分；若魔数恰好出现在压缩数据内部，切分点会解压失败，
 * 此时向后顺延到下一个魔数重试，直到成功。
 */
export function decodeZstdFrames(buf) {
  const magics = magicOffsets(buf);
  if (magics.length === 0) return zlib.zstdDecompressSync(buf).toString('utf8');

  const parts = [];
  let pos = 0;
  let gi = 0;
  while (pos < buf.length) {
    while (gi < magics.length && magics[gi] < pos) gi++;
    if (gi >= magics.length) break;
    const start = magics[gi];
    let idx = gi + 1;
    let ok = false;
    while (true) {
      const end = idx < magics.length ? magics[idx] : buf.length;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
        pos = end;
        gi = idx;
        ok = true;
        break;
      } catch {
        if (idx >= magics.length) break;
        idx++;
      }
    }
    if (!ok) break;
  }
  return parts.join('');
}

function sessionsDir(ctx) {
  return firstExisting(roleRoots('dsh', ctx, 'sessions'))?.path ?? null;
}

/**
 * 宿主的工作区登记表：<root>/storages/workspace.json
 * 只用来取「默认工作区归属」和 archivedSessionIds（D1 归档标记），一律不当筛选条件。
 * 实测：裸 uuid 目录全是 subagent、不在登记表里，所以登记表不能当存在性判据。
 */
function workspaceRegistry(ctx) {
  const dir = sessionsDir(ctx);
  const file = dir ? path.join(path.dirname(dir), 'storages', 'workspace.json') : null;
  const empty = { defaultId: null, archived: new Set(), workspaceOf: new Map() };
  if (!file || !fs.existsSync(file)) return empty;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty;
  }
  const archived = new Set((j?.global?.archivedSessionIds ?? []).map(String));
  const workspaceOf = new Map();
  for (const [id, w] of Object.entries(j?.tables?.workspaces ?? {})) {
    // title = 宿主侧栏显示的工作区名（本机实测等于目录名，但以宿主字段为准）
    const entry = { id, path: String(w?.path ?? ''), name: String(w?.title ?? '').trim() };
    for (const sid of Array.isArray(w?.sessionIds) ? w.sessionIds : []) workspaceOf.set(String(sid), entry);
  }
  return { defaultId: j?.global?.defaultWorkspaceId ? String(j.global.defaultWorkspaceId) : null, archived, workspaceOf };
}

function signalsOf(id, reg) {
  const ws = reg.workspaceOf.get(String(id)) ?? null;
  return {
    scope: ws && ws.id === reg.defaultId ? 'none' : ws ? 'project' : null,
    archived: reg.archived.has(String(id)),
    workspaceId: ws?.id ?? null,
    projectName: ws?.name ?? '',
  };
}

// header.id 与目录名都可能出现在登记表里，取第一个能命中的（subagent 两者都不命中 → scope null）
function firstSignal(ids, reg) {
  const list = ids.filter(Boolean).map(String);
  const sigs = list.map((id) => signalsOf(id, reg));
  const hit = sigs.find((s) => s.scope) ?? null;
  return {
    scope: hit ? hit.scope : null,
    archived: sigs.some((s) => s.archived),
    workspaceId: hit?.workspaceId ?? null,
    projectName: hit?.projectName ?? '',
  };
}

// 会话目录索引：id(目录名) → {dir, file}
function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  for (const f of walkFiles(dir, { maxDepth: 3, match: (n) => n.startsWith('session.') && n.endsWith('.jsonl.zstd') })) {
    const sdir = path.dirname(f);
    const dirId = path.basename(sdir);
    const prev = map.get(dirId);
    if (!prev || fileMtime(f) > fileMtime(prev.file)) map.set(dirId, { id: dirId, dir: sdir, file: f });
  }
  return map;
}

function readEvents(file) {
  const text = decodeZstdFrames(fs.readFileSync(file));
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

/**
 * list 用：逐帧解压，最多 maxFrames 帧就提前返回（大文件不必全解）。
 * dsh 的 session 头 / session:title / 首条 user:message 都在开头几帧。
 * @returns {{events:object[], truncated:boolean}}
 */
export function readEventsHead(file, maxFrames = 200) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { events: [], truncated: false };
  }
  const magics = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) {
    magics.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  const events = [];
  let truncated = false;
  if (magics.length === 0) {
    try {
      const text = zlib.zstdDecompressSync(buf).toString('utf8');
      for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          events.push(JSON.parse(s));
        } catch {
          /* ignore */
        }
      }
    } catch {
      return { events: [], truncated: false };
    }
    return { events, truncated: false };
  }

  let pos = 0;
  let gi = 0;
  while (pos < buf.length) {
    while (gi < magics.length && magics[gi] < pos) gi++;
    if (gi >= magics.length) break;
    const start = magics[gi];
    let idx = gi + 1;
    let ok = false;
    while (true) {
      const end = idx < magics.length ? magics[idx] : buf.length;
      try {
        const text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
        pos = end;
        gi = idx;
        ok = true;
        for (const line of text.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try {
            events.push(JSON.parse(s));
          } catch {
            /* ignore */
          }
        }
        break;
      } catch {
        if (idx >= magics.length) break;
        idx++;
      }
    }
    if (!ok) break;
    if (events.length >= maxFrames) {
      truncated = pos < buf.length;
      break;
    }
  }
  return { events, truncated };
}

// DSH 把运行时快照当作 user/message 注入，不是用户发言
const DSH_INJECTION_PATTERNS = [/^Current runtime context\b/i, /^<runtime_context>/i, /^<system[-_]reminder>/i];

function isInjection(text) {
  const t = String(text ?? '').trimStart();
  if (!t) return true;
  return DSH_INJECTION_PATTERNS.some((re) => re.test(t));
}

function contentItems(content, ts, role) {
  const items = [];
  for (const c of Array.isArray(content) ? content : []) {
    const type = String(c?.type ?? '');
    if (type === 'reasoning') {
      if (c.text) items.push(reasoningItem(c.text, ts));
    } else if (type === 'text') {
      const raw = String(c.text ?? '');
      const text = role === 'user' ? stripSystemInjections(raw) : raw;
      if (text) items.push(messageItem(role, text, ts));
    } else if (type === 'tool-call') {
      items.push(toolCallItem(c.id ?? null, c.name ?? 'tool', parseArgs(c.arguments), ts));
    } else if (type === 'image' || type === 'file') {
      items.push(attachmentItem(c.path ?? c.url ?? type, type, ts));
    }
  }
  return items;
}

function headerOf(events) {
  const h = events.find((e) => e.type === 'session') ?? {};
  return {
    id: h.id ? String(h.id) : null,
    createdAt: toMs(h.createdAt),
    cwd: h.cwd ?? '',
    parentSession: h.parentSession ?? null,
    origin: h.origin ?? null,
    delegationDepth: Number(h.delegationDepth) || 0,
    agentPreset: h.agentPreset ?? null,
    model: null,
  };
}

function replayEntries(events) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  for (const ev of events) {
    const ts = toMs(ev.time);
    switch (ev.type) {
      case 'user/message': {
        const items = contentItems(ev.data?.content, ts, 'user');
        if (!items.length) break;
        const textItem = items.find((i) => i.kind === 'message');
        // 纯注入消息（运行时快照）直接丢弃
        if (textItem && isInjection(textItem.text)) break;
        entries.push({ role: 'user', ts, items });
        break;
      }
      case 'assistant/message': {
        const msg = ev.data?.message ?? {};
        const items = contentItems(msg.content, ts, 'assistant');
        if (items.length) entries.push({ role: 'assistant', ts, items });
        break;
      }
      case 'tool/result': {
        const msg = ev.data?.message ?? {};
        const out = outputText(msg.content);
        pushItem(toolResultItem(msg.toolCallId ?? ev.data?.toolCallId ?? null, 'tool', msg.isError ? 'error' : 'ok', out, ts), ts);
        break;
      }
      default:
        // system/message / tool/call（重复） / step/* / turn/* / request/* / agent/inbox/spliced
        break;
    }
  }
  return entries;
}

export const dshReader = {
  variant: 'dsh',
  label: 'DSH (DeepSeek Harness)',

  available(ctx) {
    const d = sessionsDir(ctx);
    return !!d && fs.existsSync(d);
  },

  list(ctx, opts = {}) {
    const reg = workspaceRegistry(ctx);
    const out = [];
    for (const [dirId, s] of indexSessions(sessionsDir(ctx))) {
      // 大文件不必全解：头部若干帧已含 session 头 / title / 前几条 user 消息
      const { events, truncated } = readEventsHead(s.file);
      const h = headerOf(events);
      const isSubagent = h.delegationDepth > 0 || h.origin === 'subagent';
      if (isSubagent && !opts.includeSubagents) continue;

      let title = '';
      let userMsgs = 0;
      let preview = '';
      let model = null;
      let provenance = null;
      let updatedAt = h.createdAt;
      for (const ev of events) {
        const ts = toMs(ev.time);
        if (ts > updatedAt) updatedAt = ts;
        if (ev.type === 'session/title' && ev.data?.title) title = String(ev.data.title);
        if (ev.type === 'assistant/message' && ev.data?.message?.source?.model && !model) model = ev.data.message.source.model;
        if (ev.type === PROVENANCE_EVENT_TYPE) {
          const p = provenanceFromObject(ev.data?.['session-sync'] ?? ev['session-sync']);
          if (p) provenance = p;
        }
        if (ev.type === 'user/message') {
          const raw = (ev.data?.content ?? []).map((c) => c?.text ?? '').join('\n');
          if (!isInjection(raw)) {
            const t = stripSystemInjections(raw);
            if (t) {
              userMsgs++;
              if (!preview) preview = t;
            }
          }
        }
      }
      const sig = firstSignal([h.id, dirId], reg);
      out.push({
        id: h.id ?? dirId,
        variant: 'dsh',
        title: title || previewTitle(preview) || 'untitled',
        preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: h.cwd,
        createdAt: h.createdAt,
        updatedAt: truncated ? fileMtime(s.file) : updatedAt,
        turns: userMsgs,
        turnsApprox: truncated,
        model,
        subagent: isSubagent,
        parentSession: h.parentSession,
        provenance: provenance || readSidecarProvenance(path.join(s.dir, 'provenance')),
        sourcePath: s.file,
        scope: sig.scope,
        projectName: sig.projectName,
        archived: sig.archived,
        account: null,
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const idx = indexSessions(sessionsDir(ctx));
    // id 可能是 header.id 或目录名，两者都要能命中
    let entry = idx.get(String(id));
    if (!entry) {
      for (const s of idx.values()) {
        try {
          if (headerOf(readEvents(s.file)).id === String(id)) {
            entry = s;
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (!entry) return null;

    const events = readEvents(entry.file);
    const h = headerOf(events);
    let title = '';
    let model = null;
    let provenance = null;
    let updatedAt = h.createdAt;
    for (const ev of events) {
      const ts = toMs(ev.time);
      if (ts > updatedAt) updatedAt = ts;
      if (ev.type === 'session/title' && ev.data?.title) title = String(ev.data.title);
      if (ev.type === 'assistant/message' && ev.data?.message?.source?.model && !model) model = ev.data.message.source.model;
      if (ev.type === PROVENANCE_EVENT_TYPE) {
        const p = provenanceFromObject(ev.data?.['session-sync'] ?? ev['session-sync']);
        if (p) provenance = p;
      }
    }

    const turns = assembleTurns(replayEntries(events));
    const sig = firstSignal([h.id, String(id)], workspaceRegistry(ctx));
    const session = makeSession({
      id: h.id ?? String(id),
      variant: 'dsh',
      title: deriveTitle(title, turns),
      cwd: h.cwd,
      createdAt: h.createdAt,
      updatedAt,
      model,
      scope: sig.scope,
      turns,
      meta: {
        sourcePath: entry.file,
        parentSession: h.parentSession,
        delegationDepth: h.delegationDepth,
        origin: h.origin,
        agentPreset: h.agentPreset,
        workspaceId: sig.workspaceId,
        archived: sig.archived,
      },
    });
    if (h.delegationDepth > 0 || h.origin === 'subagent') {
      session.meta.subagent = true;
      session.turns.unshift({ index: 0, role: 'system', startedAt: h.createdAt, items: [metaItem('subagent', h.parentSession ?? true, h.createdAt)] });
    }
    applyProvenanceToIR(session, provenance || readSidecarProvenance(path.join(entry.dir, 'provenance')));
    return finalizeSession(session);
  },
};
