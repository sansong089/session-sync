// readers/qoder.mjs — Qoder（中文版/国际版）
//
// 三套来源，必须都读（2026-10-28 真机取证，见 references/qoder-write.md）：
//   0. 桌面注册表 main.sqlite（<appData>/com.qodercn.app.stable/，现行代际）：chat_sessions 明文元数据
//      + chat_session_messages 明文正文投影（payload_json.parts，部件词表 text/thinking/tool/hook/
//      contextCompression）。旧实现以为「桌面正文是密文」，其实密文只属于被取代的 SharedClientCache/local.db。
//   1. 桌面端 local.db：chat_message.content / chat_record.question/answer 为加密密文（本机实测），
//      可读的只有会话元数据（标题、时间、项目、角色、token/模型）。因此这一路是
//      「元数据 + 内容哈希」降级读取：内容不可读时写入密文哈希参与指纹，保证会话间可区分。
//   2. CLI 侧 <cliRoot>/projects/<slug>/<uuid>.jsonl：**明文**，与 Claude Code 同构，正文完整可读
//      （实测本机 cn：projects 93 条主会话 + cache/projects 9 条；subagents/ 侧链另计，不列为会话）。
//      旧版实现只走 1，导致这 102 条明文会话一条都读不到。
// 变体根硬隔离：cn → ~/.qoder-cn，intl → ~/.qoder，均不跟随 QODER_CONFIG_DIR（见 hosts.mjs）
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS } from '../hosts.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, noteItem, metaItem, finalizeSession } from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { openDb, safeJson, tableExists, firstExisting, contentHashOf, assembleTurns, deriveTitle, walkFiles, listEvents, claudeUserTurnText, parseJsonl, fileMtime, stripSystemInjections, adoptSiblingIdentity, inTimeRange } from './base.mjs';

import { isFile } from '../util.mjs';
import { candidateRoots } from '../roots.mjs';
import { claudeLikeConsumeMeta, claudeLikeReplayEntries } from './claude.mjs';
import { previewTitle } from '../titles.mjs';


function localDb(ctx, variant) {
  // 候选文件里还有 state.vscdb（KV 库）：只认 local.db，别把 KV 库当会话库去查表
  const cands = candidateRoots(variant, ctx).filter((x) => x.kind === 'file' && /(^|[\\/])local\.db$/i.test(x.path));
  const hit = firstExisting(cands);
  return hit?.path ?? null;
}


// 桌面注册表（现行代际）。变体根硬隔离：cn → com.qodercn.app.stable，intl → com.qoder.app.stable
function registryDb(ctx, variant) {
  const cands = candidateRoots(variant, ctx).filter((x) => x.role === 'registry');
  return firstExisting(cands)?.path ?? null;
}

function registryProvenance(row) {
  const extra = safeJson(row.extra_json, null);
  return provenanceFromObject(extra && extra['session-sync']) || null;
}

// 投影部件 → IR 项。tool 部件在宿主里是一条（入参与响应同体），读回必须拆成 call + result，
// 否则与其他宿主「一次调用 + 一次回执」的形状不等价。
function registryItems(payload, role, ts) {
  const items = [];
  for (const part of payload?.parts ?? []) {
    switch (part?.type) {
      case 'thinking':
        if (part.text) items.push(reasoningItem(part.text, ts));
        break;
      case 'text': {
        const raw = String(part.text ?? '');
        if (!raw) break;
        const text = role === 'user' ? stripSystemInjections(raw) : raw;
        if (text) items.push(messageItem(role === 'user' ? 'user' : 'assistant', text, ts));
        break;
      }
      case 'tool': {
        const t = part.tool ?? {};
        const callId = t.id ?? null;
        items.push(toolCallItem(callId, t.name ?? 'tool', t.input ?? null, ts));
        if (t.response != null) {
          const out = typeof t.response === 'string' ? t.response : JSON.stringify(t.response);
          items.push(toolResultItem(callId, t.name ?? 'tool', t.status === 'failed' ? 'error' : 'ok', out, ts));
        }
        break;
      }
      case 'hook':
        items.push(metaItem('hook', part.text ?? part.hookName ?? null, ts));
        break;
      case 'contextCompression':
        items.push(metaItem('context-compression', part.text ?? null, ts));
        break;
      default:
        break;
    }
  }
  return items;
}

function registryList(ctx, variant, opts = {}) {
  const file = registryDb(ctx, variant);
  if (!file) return [];
  const db = openDb(file);
  const out = [];
  try {
    if (!tableExists(db, 'chat_sessions')) return [];
    const msgCol = tableExists(db, 'chat_session_messages')
      // 早期行的 role 列是 NULL（角色只在 payload_json 里），列是后来才加的 → 必须 COALESCE
      ? db.prepare("SELECT session_id, COUNT(*) AS c FROM chat_session_messages WHERE COALESCE(role, json_extract(payload_json, '$.role')) = 'user' GROUP BY session_id").all()
      : [];
    const counts = new Map(msgCol.map((r) => [r.session_id, r.c]));
    let projectNames = new Map();
    if (tableExists(db, 'workspaces')) {
      try {
        projectNames = new Map(db.prepare('SELECT workspace_id, name FROM workspaces').all().map((r) => [String(r.workspace_id), String(r.name ?? '').trim()]));
      } catch {
        /* 老库没有 name 列 */
      }
    }
    for (const row of db.prepare('SELECT * FROM chat_sessions').all()) {
      // side chat（owner_session_id 有值）宿主主列表不列，与 subagent 同口径处理
      if (!opts.includeSubagents && row.owner_session_id) continue; // side chat 宿主主列表不列，与 subagent 同口径
      if (row.deleted_at) continue;
      out.push({
        id: String(row.session_id),
        variant,
        title: row.title || '',
        cwd: row.cwd || '',
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
        turns: counts.get(row.session_id) ?? 0,
        model: row.model ?? null,
        provenance: registryProvenance(row),
        archived: !!row.archived,
        scope: row.workspace_id ? 'project' : undefined,
        projectName: row.workspace_id ? (projectNames.get(String(row.workspace_id)) ?? '') : '',
        source: 'registry',
        sourcePath: file,
      });
    }
  } catch {
    return out;
  } finally {
    db.close();
  }
  return out;
}

function cliDirs(ctx, variant) {
  return candidateRoots(variant, ctx).filter((x) => x.role === 'cliProjects').map((x) => x.path);
}

// 账户信号只认库里的 user_id；CLI 明文 jsonl 里没有该字段 → 保持 null，绝不按目录猜
function accountOf(row, variant) {
  if (!row?.user_id) return null;
  return { variant, id: String(row.user_id), name: row.user_name ? String(row.user_name) : null, orgId: row.org_id ? String(row.org_id) : null };
}

// <cliRoot>/projects/<slug>/<id>.jsonl；subagents/ 下是子代理侧链，宿主不列为会话
function indexCli(ctx, variant) {
  const map = new Map();
  for (const dir of cliDirs(ctx, variant)) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of walkFiles(dir, { maxDepth: 3, match: (n) => n.endsWith('.jsonl') && !n.includes('.session-sync.'), skipDir: (n) => n === 'subagents' })) {
      const id = path.basename(f, '.jsonl');
      const prev = map.get(id);
      if (!prev || fileMtime(f) > fileMtime(prev)) map.set(id, f);
    }
  }
  return map;
}

// 首行 workspace-directories 给落点（非项目会话是宿主自生成的日期目录），逐行 cwd 兜底
function newCliAcc() {
  return { createdAt: 0, updatedAt: 0, cwd: '', title: '', model: null, provenance: null, workspaceDirectories: null };
}

function cliConsume(ev, acc) {
  if (ev.type === 'workspace-directories' && Array.isArray(ev.directories) && ev.directories.length) {
    acc.workspaceDirectories = ev.directories;
    if (!acc.cwd) acc.cwd = String(ev.directories[0] ?? '');
  }
  claudeLikeConsumeMeta(ev, acc);
}

// 摘要走采样（头部 128KB，标题缺失才补读尾部）；正文 read() 才全量读
function cliMetaOf(file) {
  const acc = newCliAcc();
  let userMsgs = 0;
  let preview = '';
  // 全量解析：轮次必须与 readSession 同口径，采样会让 list 少报（真机 67 轮报成 1 轮）
  for (const ev of listEvents(file)) {
    cliConsume(ev, acc);
    const clean = claudeUserTurnText(ev);
    if (clean) {
      userMsgs++;
      if (!preview) preview = clean;
    }
  }
  return { acc, userMsgs, preview };
}

function provenanceOf(row) {
  const extra = safeJson(row.extra, null);
  return provenanceFromObject(extra && extra['session-sync']) || null;
}

// 同 id 的注册表行：只取 provenance，用于给没带标记的 CLI 明文副本补身份
function registrySibling(file, id) {
  if (!file) return null;
  const db = openDb(file);
  try {
    if (!tableExists(db, 'chat_sessions')) return null;
    const row = db.prepare('SELECT extra_json FROM chat_sessions WHERE session_id = ?').get(id);
    if (!row) return null;
    const prov = registryProvenance(row);
    return prov ? { origin: prov.origin, chain: prov.chain } : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// 同 id 的桌面库行：只取 provenance / account，用于给没有标记的 CLI 明文副本补身份与账户
function dbSibling(ctx, variant, id) {
  const file = localDb(ctx, variant);
  if (!file) return null;
  const db = openDb(file);
  try {
    if (!tableExists(db, 'chat_session')) return null;
    const row = db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get(id);
    if (!row) return null;
    return { ...(provenanceOf(row) ?? {}), account: accountOf(row, variant) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}


// 注册表投影 → IR 会话（宿主自己创建的桌面会话没有 CLI jsonl，正文只能从这一路读）
function registryRead(ctx, variant, id, file) {
  const db = openDb(file);
  try {
    if (!tableExists(db, 'chat_sessions')) return null;
    const row = db.prepare('SELECT * FROM chat_sessions WHERE session_id = ?').get(id);
    if (!row) return null;
    const entries = [];
    if (tableExists(db, 'chat_session_messages')) {
      const msgs = db.prepare('SELECT * FROM chat_session_messages WHERE session_id = ? ORDER BY sequence').all(id);
      for (const m of msgs) {
        const payload = safeJson(m.payload_json, null);
        // 早期行只有 payload_json.role，列 role 是后加的
        const rawRole = m.role ?? payload?.role ?? null;
        const role = rawRole === 'user' ? 'user' : rawRole === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const ts = Number(m.created_at) || 0;
        const items = registryItems(payload, role, ts);
        // 与各家一致的口径：没有可展示内容的事件不开轮，否则跨落点轮次数不等价
        if (items.length) entries.push({ role, ts, items });
      }
    }
    const turns = assembleTurns(entries);
    const session = makeSession({
      id: String(id),
      variant,
      title: deriveTitle(row.title, turns),
      cwd: row.cwd || '',
      createdAt: Number(row.created_at) || 0,
      updatedAt: Number(row.updated_at) || 0,
      model: row.model ?? null,
      turns,
      meta: { sourcePath: file, source: 'registry', sessionKind: row.session_kind ?? null, productMode: row.product_mode ?? null, workspaceId: row.workspace_id ?? null },
    });
    applyProvenanceToIR(session, registryProvenance(row));
    return finalizeSession(session);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * 桌面注册表里的会话元数据：
 *   chat_sessions.title        = 侧栏显示的会话名
 *   chat_sessions.workspace_id → workspaces.name = 侧栏显示的项目名（宿主自己的协议名）
 * 只取这三列，其它状态忽略。
 */
function registryMeta(ctx, variant) {
  const hit = firstExisting(candidateRoots(variant, ctx).filter((x) => x.kind === 'file' && x.role === 'registry'));
  if (!hit) return new Map();
  try {
    const db = openDb(hit.path);
    try {
      if (!tableExists(db, 'chat_sessions')) return new Map();
      let names = new Map();
      if (tableExists(db, 'workspaces')) {
        try {
          names = new Map(db.prepare('SELECT workspace_id, name FROM workspaces').all().map((r) => [String(r.workspace_id), String(r.name ?? '').trim()]));
        } catch {
          /* 老库没有 name 列 */
        }
      }
      const out = new Map();
      for (const r of db.prepare('SELECT session_id, title, workspace_id FROM chat_sessions').all()) {
        const wsid = r.workspace_id ? String(r.workspace_id) : '';
        out.set(String(r.session_id), {
          title: String(r.title ?? '').trim(),
          workspaceId: wsid || null,
          projectName: wsid ? names.get(wsid) ?? '' : '',
        });
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

// 单条会话的宿主标题（桌面注册表 chat_sessions.title = 侧栏显示的名字）
function registryTitle(ctx, variant, id) {
  const hit = firstExisting(candidateRoots(variant, ctx).filter((x) => x.kind === 'file' && x.role === 'registry'));
  if (!hit) return '';
  try {
    const db = openDb(hit.path);
    try {
      if (!tableExists(db, 'chat_sessions')) return '';
      const row = db.prepare('SELECT title FROM chat_sessions WHERE session_id = ?').get(String(id));
      return String(row?.title ?? '').trim();
    } finally { db.close(); }
  } catch { return ''; }
}

function cliList(ctx, variant) {
  const out = [];
  // 桌面向导的标题/项目名就是侧栏显示值：优先用它，jsonl 推导的标题只在没有宿主标题时兜底
  const hostMeta = registryMeta(ctx, variant);
  for (const [id, file] of indexCli(ctx, variant)) {
    const { acc, userMsgs, preview } = cliMetaOf(file);
    const meta = hostMeta.get(String(id));
    out.push({
      id,
      variant,
      title: meta?.title || acc.title || previewTitle(preview) || 'untitled',
      preview: preview.replace(/\s+/g, ' ').slice(0, 120),
      cwd: acc.cwd,
      // workspace_id 有值 = 宿主把它归在某个项目下（正信号；null 不反推，交给 cwd 分类）
      scope: meta?.workspaceId ? 'project' : undefined,
      projectName: meta?.projectName ?? '',
      createdAt: acc.createdAt,
      updatedAt: fileMtime(file),
      turns: userMsgs,
      turnsApprox: false,
      model: acc.model,
      provenance: acc.provenance,
      source: 'cli-jsonl',
      sourcePath: file,
    });
  }
  return out;
}

function cliRead(ctx, variant, id, file) {
  const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
  const acc = newCliAcc();
  for (const ev of lines) cliConsume(ev, acc);
  const turns = assembleTurns(claudeLikeReplayEntries(lines));
  const session = makeSession({
    id: String(id),
    variant,
    title: deriveTitle(registryTitle(ctx, variant, id) || acc.title, turns),
    cwd: acc.cwd,
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
    model: acc.model,
    turns,
    meta: { sourcePath: file, source: 'cli-jsonl', workspaceDirectories: acc.workspaceDirectories },
  });
  applyProvenanceToIR(session, acc.provenance || readSidecarProvenance(file));
  return finalizeSession(session);
}

function looksEncrypted(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  // 明文通常是可读 JSON/文本；密文为长 base64 且解码后高熵
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) return false;
  if (content.length < 64) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(content);
}

export function createQoderReader({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    available(ctx) {
      if (registryDb(ctx, variant)) return true;
      const f = localDb(ctx, variant);
      if (f && isFile(f)) return true;
      return cliDirs(ctx, variant).some((d) => d && fs.existsSync(d));
    },

    list(ctx, opts = {}) {
      const out = [];
      const file = localDb(ctx, variant);
      if (file) {
        const db = openDb(file);
        try {
          if (tableExists(db, 'chat_session')) {
            const rows = db.prepare('SELECT * FROM chat_session').all();
            const counts = new Map();
            if (tableExists(db, 'chat_message')) {
              try {
                for (const r of db.prepare("SELECT session_id, COUNT(*) AS c FROM chat_message WHERE role='user' GROUP BY session_id").all()) {
                  counts.set(r.session_id, r.c);
                }
              } catch {
                /* ignore */
              }
            }
            for (const row of rows) {
              // 实测：parent_session_id 有值 ⇔ session_type='agent_sub_*'，宿主主列表里根本不出现这些行
              if (!opts.includeSubagents && row.parent_session_id) continue;
              out.push({
                id: row.session_id,
                variant,
                title: row.session_title || '',
                cwd: row.project_uri || row.project_id || '',
                createdAt: Number(row.gmt_create) || 0,
                updatedAt: Number(row.gmt_modified) || 0,
                turns: counts.get(row.session_id) ?? 0,
                provenance: provenanceOf(row),
                degraded: 'encrypted-content',
                source: 'local-db',
                sourcePath: file,
                account: accountOf(row, variant),
              });
            }
          }
        } finally {
          db.close();
        }
      }
      // CLI 明文 jsonl 全部拼上；同 id 的合并由 listSessions 统一处理（明文副本优先，与 read 一致）
      out.push(...cliList(ctx, variant));
      out.push(...registryList(ctx, variant, opts));
      return out.filter((s) => inTimeRange(s, opts));
    },

    read(ctx, id) {
      const cliFile = indexCli(ctx, variant).get(String(id));
      const regFile = registryDb(ctx, variant);
      // 正文优先级：CLI 明文 jsonl > 注册表投影 > 旧密文库（必须与 list 的 rank 一致）
      if (cliFile) return adoptSiblingIdentity(cliRead(ctx, variant, id, cliFile), [registrySibling(regFile, id), dbSibling(ctx, variant, id)]);
      if (regFile) { const viaReg = registryRead(ctx, variant, id, regFile); if (viaReg) return viaReg; }
      const file = localDb(ctx, variant);
      if (!file) return null;
      const db = openDb(file);
      try {
        if (!tableExists(db, 'chat_session')) return null;
        const row = db.prepare('SELECT * FROM chat_session WHERE session_id = ?').get(id);
        if (!row) return null;
        const prov = provenanceOf(row);

        const entries = [];
        if (tableExists(db, 'chat_message')) {
          const msgs = db.prepare('SELECT * FROM chat_message WHERE session_id = ? ORDER BY gmt_create').all(id);
          for (const m of msgs) {
            const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : null;
            if (!role) continue;
            const ts = Number(m.gmt_create) || 0;
            const items = [];
            const encrypted = looksEncrypted(m.content);
            if (encrypted) {
              // 内容加密：写占位说明 + 密文哈希（参与指纹，保证会话间可区分）
              items.push(noteItem('[Qoder 内容加密，无法读取正文]', ts));
              items.push(metaItem('content-sha256', contentHashOf(m.content), ts));
            } else if (m.content) {
              items.push(messageItem(role, m.content, ts));
            }
            const modelInfo = safeJson(m.model_info, null);
            if (modelInfo) items.push(metaItem('model', modelInfo, ts));
            const tokenInfo = safeJson(m.token_info, null);
            if (tokenInfo) items.push(metaItem('usage', tokenInfo, ts));
            entries.push({ role, ts, items });
          }
        }

        const turns = assembleTurns(entries);
        const session = makeSession({
          id: row.session_id,
          variant,
          title: deriveTitle(row.session_title, turns),
          cwd: row.project_uri || row.project_id || '',
          createdAt: Number(row.gmt_create) || 0,
          updatedAt: Number(row.gmt_modified) || 0,
          model: safeJson(row.preferred_model_info, null)?.preferred_model ?? null,
          account: accountOf(row, variant),
          turns,
          meta: { sourcePath: file, sessionType: row.session_type ?? null, mode: row.mode ?? null, degraded: 'encrypted-content' },
        });
        applyProvenanceToIR(session, prov);
        return finalizeSession(session);
      } finally {
        db.close();
      }
    },
  };
}
