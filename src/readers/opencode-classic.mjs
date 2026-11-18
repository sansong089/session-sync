// readers/opencode-classic.mjs — OpenCode 血统（session + message + part 三表）：
// 用于 ZCode / MiMo Code / Kilo(db 模式)
import { VARIANTS } from '../hosts.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, metaItem, attachmentItem, finalizeSession } from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR } from '../provenance.mjs';
import { openDb, safeJson, tableExists, tableHasColumn, existingFiles, assembleTurns, deriveTitle, stripSystemInjections, adoptSiblingIdentity, TOOL_RESULT_ONLY, GLOBAL_PROJECT, opencodeSessionLabel, projectNameMap, inTimeRange } from './base.mjs';

import { isFile } from '../util.mjs';
import { roleRoots } from '../roots.mjs';

// 宿主用 project_id='global' 标「无项目会话」（mimo 实测 16/16 与桶目录一致）；分类只在这里判一次
const scopeOfProject = (row) => (row?.project_id === GLOBAL_PROJECT ? 'none' : null);

// 候选库可能不止一个（env 指定 + XDG / Roaming / LocalAppData 默认）：全部读，再由 listSessions 按 id 合并
function filesOf(ctx, variant) {
  return existingFiles(roleRoots(variant, ctx, 'db').filter((x) => x.kind === 'file'));
}

function partItems(part, role, ts) {
  const d = safeJson(part.data, {});
  const items = [];
  switch (d?.type) {
    case 'text': {
      const text = role === 'user' ? stripSystemInjections(d.text) : String(d.text ?? '');
      if (text) items.push(messageItem(role === 'user' ? 'user' : 'assistant', text, ts));
      break;
    }
    case 'reasoning':
      if (d.text) items.push(reasoningItem(d.text, ts));
      break;
    case 'tool': {
      const state = d.state || {};
      const callId = d.callID ?? d.id ?? null;
      const name = d.tool ?? d.name ?? 'tool';
      const out = typeof state.output === 'string' ? state.output : (state.output ?? null);
      // 只有写侧显式标了 resultOnly 的孤儿结果（源里没有对应调用）才不产 tool_call；
      // 真实调用即使 input 为 null 也必须保留，否则核心指纹会少一项 → 续写被判成分叉。
      if (!state[TOOL_RESULT_ONLY]) items.push(toolCallItem(callId, name, state.input ?? null, ts));
      if (out !== null || state.status) items.push(toolResultItem(callId, name, state.status ?? 'unknown', out, ts));
      break;
    }
    case 'patch':
      items.push(metaItem('patch', d.hash ?? (d.files || []).join(',') ?? '', ts));
      break;
    case 'file':
      items.push(attachmentItem(d.url ?? d.path ?? '', 'file part', ts));
      break;
    default:
      break; // step-start / step-finish / timeline 等
  }
  return items;
}

function readProvenance(db, variant, sessionRow, provenanceSlot) {
  if (provenanceSlot === 'session_entry' && tableExists(db, 'session_entry')) {
    try {
      const rows = db.prepare("SELECT data FROM session_entry WHERE session_id = ? AND type LIKE 'session-sync%'").all(sessionRow.id);
      for (const r of rows) {
        const p = provenanceFromObject(safeJson(r.data, null));
        if (p) return p;
      }
    } catch {
      /* ignore */
    }
  }
  // permission JSON 槽位（mimo / kilo）
  const perm = safeJson(sessionRow.permission, null);
  const p = provenanceFromObject(perm && perm['session-sync']);
  if (p) return p;
  return null;
}

/**
 * 旧 schema（session + message + part 三表）列表。纯函数，接受已打开的 db，
 * 供 opencode-classic 家族（zcode/mimo/kilo）与 opencode 的 v1 回退共用。
 */
export function classicListFromDb(db, { variant, provenanceSlot = 'permission', includeSubagents = false, file = null }) {
  if (!tableExists(db, 'session') || !tableExists(db, 'message')) return [];
  const rows = db.prepare('SELECT * FROM session').all();

  // 排除自动导入会话（mimo：external_import / claude_import）
  const autoImported = new Set();
  for (const t of ['external_import', 'claude_import']) {
    if (tableExists(db, t)) {
      try {
        for (const r of db.prepare(`SELECT session_id FROM ${t}`).all()) autoImported.add(r.session_id);
      } catch {
        /* ignore */
      }
    }
  }

  const counts = new Map();
  try {
    for (const r of db.prepare("SELECT session_id, COUNT(*) AS c FROM message WHERE json_extract(data,'$.role') = 'user' GROUP BY session_id").all()) {
      counts.set(r.session_id, r.c);
    }
  } catch {
    /* ignore */
  }
  const names = projectNameMap(db);

  return rows
    .filter((row) => !autoImported.has(row.id))
    // parent_id 有值 = 子代理侧链，宿主主列表不出现（--include-subagents 才带出来）
    .filter((row) => includeSubagents || !row.parent_id)
    .map((row) => ({
      id: row.id,
      variant,
      title: opencodeSessionLabel(row.title, row.parent_id),
      cwd: row.directory || '',
      createdAt: Number(row.time_created) || 0,
      updatedAt: Number(row.time_updated) || 0,
      turns: counts.get(row.id) ?? 0,
      provenance: readProvenance(db, variant, row, provenanceSlot),
      source: 'db',
      sourcePath: file ?? null,
      scope: scopeOfProject(row),
      projectName: row.project_id ? names.get(String(row.project_id)) ?? '' : '',
      archived: row.time_archived != null && row.time_archived !== '' ? true : false,
      account: null,
    }));
}

/**
 * 旧 schema 单会话读取。纯函数，接受已打开的 db。
 */
export function classicReadFromDb(db, id, { variant, provenanceSlot = 'permission', file = null }) {
  if (!tableExists(db, 'session') || !tableExists(db, 'message')) return null;
  const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id);
  if (!row) return null;
  const prov = readProvenance(db, variant, row, provenanceSlot);

  const hasMsgSeq = tableHasColumn(db, 'message', 'sequence');
  const msgs = db
    .prepare(`SELECT * FROM message WHERE session_id = ? ORDER BY ${hasMsgSeq ? 'sequence' : 'time_created, id'}`)
    .all(id);

  const hasPartSeq = tableExists(db, 'part') && tableHasColumn(db, 'part', 'sequence');
  const partsByMsg = new Map();
  if (tableExists(db, 'part')) {
    const parts = db
      .prepare(`SELECT * FROM part WHERE session_id = ? ORDER BY ${hasPartSeq ? 'sequence' : 'time_created, id'}`)
      .all(id);
    for (const p of parts) {
      if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
      partsByMsg.get(p.message_id).push(p);
    }
  }

  const entries = [];
  let model = null;
  for (const m of msgs) {
    const d = safeJson(m.data, {});
    const role = d?.role === 'user' ? 'user' : d?.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const ts = Number(d?.time?.created) || Number(m.time_created) || 0;
    if (d?.model?.modelID) model = d.model.modelID;
    const items = [];
    for (const p of partsByMsg.get(m.id) || []) {
      items.push(...partItems(p, role, Number(p.time_created) || ts));
    }
    // 无 part 时回退到 message.data.text（部分版本）
    if (items.length === 0 && typeof d.text === 'string' && d.text) {
      const text = role === 'user' ? stripSystemInjections(d.text) : d.text;
      if (text) items.push(messageItem(role, text, ts));
    }
    entries.push({ role, ts, items });
  }

  const turns = assembleTurns(entries);
  const session = makeSession({
    id: row.id,
    variant,
    title: deriveTitle(opencodeSessionLabel(row.title, row.parent_id), turns),
    cwd: row.directory || '',
    createdAt: Number(row.time_created) || 0,
    updatedAt: Number(row.time_updated) || 0,
    model,
    scope: scopeOfProject(row),
    turns,
    meta: {
      sourcePath: file ?? null,
      parentId: row.parent_id ?? null,
      version: row.version ?? null,
      archived: row.time_archived != null && row.time_archived !== '' ? true : false,
    },
  });
  applyProvenanceToIR(session, prov);
  return finalizeSession(session);
}

export function createOpencodeClassicReader({ variant, provenanceSlot = 'permission' }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    available(ctx) {
      return filesOf(ctx, variant).length > 0;
    },

    list(ctx, opts = {}) {
      const out = [];
      for (const file of filesOf(ctx, variant)) {
        try {
          const db = openDb(file);
          try {
            out.push(...classicListFromDb(db, { variant, provenanceSlot, includeSubagents: !!opts.includeSubagents, file }));
          } finally {
            db.close();
          }
        } catch {
          /* 多库并存时单个库损坏不能让整个变体归零 */
        }
      }
      // 同 id 的合并由 listSessions 统一处理（本函数只按库的登记顺序拼接）
      return out.filter((s) => inTimeRange(s, opts));
    },

    read(ctx, id) {
      // 正文取登记序第一个能读出的库（与 list 的 rank/顺序一致）；
      // 同一会话在别的库里带着 session-sync 标记时，用它补身份
      let body = null;
      for (const file of filesOf(ctx, variant)) {
        try {
          const db = openDb(file);
          try {
            const s = classicReadFromDb(db, id, { variant, provenanceSlot, file });
            if (!s) continue;
            if (!body) body = s;
            if (body.origin) return body;
            if (s.origin) return adoptSiblingIdentity(body, [s]);
          } finally {
            db.close();
          }
        } catch {
          /* 坏库跳过，继续找下一个 */
        }
      }
      return body;
    },
  };
}
