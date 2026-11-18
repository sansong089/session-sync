// readers/opencode.mjs — OpenCode（兼容 v1 与 v2 两种 schema）
//
// v2（当前）：session_v2 + session_message（data 内联 content[]）
// v1（旧版）：session + message + part 三表 —— 与 opencode-classic 同构
//   一个 db 只会有其中一种 schema；list/read 都按实际 schema 分派，
//   这样老版本 OpenCode（或官方回退）的存量会话也能读。
import { roleRoots } from '../roots.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, metaItem, attachmentItem, finalizeSession } from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR } from '../provenance.mjs';
import { openDb, safeJson, tableExists, tableHasColumn, existingFiles, assembleTurns, deriveTitle, stripSystemInjections, inTimeRange, adoptSiblingIdentity, TOOL_RESULT_ONLY, TOOL_NULL_INPUT, opencodeSessionLabel, projectNameMap } from './base.mjs';
import { classicListFromDb, classicReadFromDb } from './opencode-classic.mjs';
import { legacyOpencodeId, isNativeOpencodeId, importedNativeId } from '../opencode-id.mjs';

// 候选库可能不止一个（env 指定的库 + XDG/ Roaming 默认库并存）：全部读，再由 listSessions 按 id 合并
function dbFiles(ctx) {
  return existingFiles(roleRoots('opencode', ctx, 'db').filter((x) => x.kind === 'file'));
}

// 判定该库是 v2 还是 v1
export function schemaOf(db) {
  if (tableExists(db, 'session_v2') && tableExists(db, 'session_message')) return 'v2';
  if (tableExists(db, 'session') && tableExists(db, 'message')) return 'v1';
  return null;
}

function provenanceOf(row) {
  const meta = safeJson(row.metadata, null);
  return provenanceFromObject(meta && meta['session-sync']) || null;
}

// 旧版本把 OpenCode 会话写成裸 uuid / ses_<32hex>；列表对外暴露网关接受的原生 ID，
// 这样修复前后 plan 都能命中同一条已导入会话（读取再回退到旧 ID）。
function importedRow(row, prov) {
  return !!prov || row.version === 'session-sync/1';
}

function listIdOf(row, prov) {
  if (!importedRow(row, prov) || isNativeOpencodeId(row.id)) return String(row.id);
  return importedNativeId(row);
}

// assistant content[] → items
function contentItems(content, ts) {
  const items = [];
  for (const c of content || []) {
    switch (c?.type) {
      case 'reasoning':
        items.push(reasoningItem(c.text, ts));
        break;
      case 'text':
        if (c.text) items.push(messageItem('assistant', c.text, ts));
        break;
      case 'tool': {
        const state = c.state || {};
        if (!state[TOOL_RESULT_ONLY]) items.push(toolCallItem(c.id ?? null, c.name ?? c.tool ?? 'tool', state[TOOL_NULL_INPUT] ? null : (state.input ?? null), ts));
        const out = Array.isArray(state.content)
          ? state.content.map((x) => x?.text ?? '').filter(Boolean).join('\n')
          : typeof state.output === 'string' ? state.output : null;
        items.push(toolResultItem(c.id ?? null, c.name ?? c.tool ?? 'tool', state.status ?? 'unknown', out, ts));
        break;
      }
      case 'file':
        items.push(attachmentItem(c.url ?? c.path ?? '', 'file part', ts));
        break;
      case 'patch':
        items.push(metaItem('patch', c.hash ?? c.path ?? '', ts));
        break;
      default:
        break; // step-start / step-finish 等机械事件
    }
  }
  return items;
}

function listOne(file, opts = {}) {
  const db = openDb(file);
  try {
    const schema = schemaOf(db);
    if (!schema) return [];
    // v1（旧三表）直接复用 opencode-classic 的读取逻辑
    if (schema === 'v1') {
      return classicListFromDb(db, { variant: 'opencode', provenanceSlot: 'session_entry', includeSubagents: !!opts.includeSubagents, file });
    }

    const t = 'session_v2';
    const hasArchived = tableColumnsHas(db, t, 'time_archived');
    const rows = db
      .prepare(`SELECT * FROM ${t}${hasArchived ? ' WHERE time_archived IS NULL' : ''}`)
      .all();
    const counts = new Map();
    if (tableExists(db, 'session_message')) {
      for (const r of db.prepare("SELECT session_id, COUNT(*) AS c FROM session_message WHERE type='user' GROUP BY session_id").all()) {
        counts.set(r.session_id, r.c);
      }
    }
    const names = projectNameMap(db);
    return rows.map((row) => {
      const prov = provenanceOf(row);
      return {
        id: listIdOf(row, prov),
        variant: 'opencode',
        title: opencodeSessionLabel(row.title, row.parent_id),
        cwd: row.directory || '',
        projectName: row.project_id ? names.get(String(row.project_id)) ?? '' : '',
        createdAt: Number(row.time_created) || 0,
        updatedAt: Number(row.time_updated) || 0,
        turns: counts.get(row.id) ?? 0,
        provenance: prov,
        source: 'db',
        sourcePath: file,
      };
    });
  } finally {
    db.close();
  }
}

function readOne(file, id) {
  const db = openDb(file);
  try {
    const schema = schemaOf(db);
    if (!schema) return null;
    if (schema === 'v1') return classicReadFromDb(db, id, { variant: 'opencode', provenanceSlot: 'session_entry', file });

    const t = 'session_v2';
    let row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
    // 迁移前的存量行仍是裸 uuid；按规范 ID 读取时回退到旧 ID
    if (!row) {
      const legacy = legacyOpencodeId(id);
      if (legacy) row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(legacy);
    }
    // 迁移前的存量行也可能是 ses_<32hex>；按原生 ID 读取时扫描映射回旧行
    if (!row && isNativeOpencodeId(id)) {
      const hit = db.prepare(`SELECT id, metadata, time_created FROM ${t}`).all()
        .find((r) => importedNativeId(r) === id);
      if (hit) row = db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(hit.id);
    }
    if (!row) return null;
    const prov = provenanceOf(row);
    const sessionId = listIdOf(row, prov);
    const msgs = db.prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq').all(row.id);

    const entries = [];
    for (const m of msgs) {
      const data = safeJson(m.data, {});
      const ts = Number(data?.time?.created) || Number(m.time_created) || 0;
      if (m.type === 'user') {
        const items = [];
        const userText = stripSystemInjections(data.text);
        if (userText) items.push(messageItem('user', userText, ts));
        for (const f of data.files || []) {
          items.push(attachmentItem(f.url ?? f.path ?? f.name ?? '', 'user file', ts));
        }
        entries.push({ role: 'user', ts, items });
      } else if (m.type === 'assistant') {
        entries.push({ role: 'assistant', ts, items: contentItems(data.content, ts) });
      }
      // synthetic / system / compaction / idle / model-switched / agent-switched / location-switched：机械事件，跳过
    }

    const turns = assembleTurns(entries);
    const session = makeSession({
      id: sessionId,
      variant: 'opencode',
      title: deriveTitle(opencodeSessionLabel(row.title, row.parent_id), turns),
      cwd: row.directory || '',
      createdAt: Number(row.time_created) || 0,
      updatedAt: Number(row.time_updated) || 0,
      model: safeJson(row.model, null)?.id ?? null,
      turns,
      meta: { sourcePath: file, agent: row.agent ?? null, version: row.version ?? null },
    });
    applyProvenanceToIR(session, prov);
    return finalizeSession(session);
  } finally {
    db.close();
  }
}

export const opencodeReader = {
  variant: 'opencode',
  label: 'OpenCode',

  available(ctx) {
    return dbFiles(ctx).length > 0;
  },

  list(ctx, opts = {}) {
    const out = [];
    for (const file of dbFiles(ctx)) {
      try {
        out.push(...listOne(file, opts));
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
    for (const file of dbFiles(ctx)) {
      try {
        const s = readOne(file, id);
        if (!s) continue;
        if (!body) body = s;
        if (body.origin) return body;
        if (s.origin) return adoptSiblingIdentity(body, [s]);
      } catch {
        /* 坏库跳过，继续找下一个 */
      }
    }
    return body;
  },
};

// 「表里有没有这一列」与「表里有哪些列」是同一件事的两种问法 —— 统一走 base 的口径
const tableColumnsHas = (db, table, col) => tableHasColumn(db, table, col);

export { tableColumnsHas };
