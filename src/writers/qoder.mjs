// writers/qoder.mjs — 写 Qoder（中文版 / 国际版）
//
// 2026-10-28 真机取证（细则见 references/qoder-write.md）：让一条会话「被识别」需要三层，缺任何一层都不算写完：
//   1) 正文层   <cliRoot>/projects/<slug>/<id>.jsonl —— 与 Claude Code 同构，CLI 与恢复读它。
//      差异只有形状要求：首行 workspace-directories + runtime-config，末行 active-leaf（宿主允许出现多次）。
//   2) 注册表行 <appData>/com.qodercn.app.stable/main.sqlite（国际版同规则换产品目录）的 chat_sessions ——
//      缺它时桌面直接回「这个会话未在 Qoder 中登记」，jsonl 写得再全也列不出来。项目会话还要求
//      workspace_id 命中同库 workspaces 的行（侧栏按它分组）：认领不到就按宿主 save() 的形状补登记。
//   3) 正文投影 同库 chat_session_messages —— 必须 source='cli-import' 且 payload_schema_version=2；
//      部件词表 text/thinking/tool/hook/contextCompression。实测同样两行用 source='sdk-projection'
//      + 版本 1 写进去，宿主读回是空的；改成 cli-import + 2 后原样读出。
//      assistant 行的 message_id 必须是 `assistant:<userUuid>`：包里的 needsCliProjectionRefresh
//      把 `cli-import 且 message_id NOT LIKE 'assistant:%'` 判定为过期投影。
//
// 写入纪律：注册表只动「我们自己建的会话行」，认领判据是 extra_json['session-sync']。
// 追加到宿主原生的会话时只推进 updated_at 并插入新增轮次的投影行，绝不删改宿主写的历史行。
// 外部写库拿不到宿主自己的 UI 推送（包内是 artifactSource.notifyCommitted），所以侧栏要刷新/重开列表才出现。
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS } from '../hosts.mjs';
import { createClaudeFamilyWriter } from './claude.mjs';
import { backupIfExists, insertRowFiltered, newNodeId, outputText, updateRowFiltered } from './base.mjs';
import { tableColumns } from '../readers/base.mjs';
import { provenanceFromObject } from '../provenance.mjs';
import { nowMs, ensureDir, baseNameOf } from '../util.mjs';
import { candidateRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { normalizeText } from '../ir.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';

// 同一进程对同一个库只备份一次：main.sqlite 实测 186 MB，逐条写入各备份一份会立刻写满磁盘
const backedUp = new Set();
function backupOnce(ctx, variant, file) {
  if (backedUp.has(file)) return null;
  backedUp.add(file);
  const b = backupIfExists(file, ctx, variant);
  // WAL 库只拷主文件会停在「已提交但缺最新事务」的状态，连 -wal/-shm 一起带走才回得去
  if (b) for (const suf of ['-wal', '-shm']) {
    if (fs.existsSync(file + suf)) { try { fs.copyFileSync(file + suf, `${b}${suf}`); } catch { /* 尽力而为 */ } }
  }
  return b;
}

function cliProjectsRoot(ctx, variant) {
  return candidateRoots(variant, ctx).find((x) => x.role === 'cliProjects')?.path ?? null;
}

function registryDbFile(ctx, variant) {
  const hit = candidateRoots(variant, ctx).find((x) => x.role === 'registry');
  return hit && fs.existsSync(hit.path) ? hit.path : null;
}

// ---- 第 1 层：正文 jsonl（复用 claude 血统 writer，只加 qoder 的首尾形状）----

function headerLines(ctx, session, targetId) {
  const cwd = String(session.cwd ?? '');
  const dirs = [cwd, ...(session.meta?.additionalDirectories ?? [])].filter(Boolean);
  return [
    { type: 'workspace-directories', sessionId: String(targetId), directories: dirs.length ? dirs : [cwd] },
    { type: 'runtime-config', sessionId: String(targetId), model: session.model || 'auto', reasoningEffort: null, contextWindow: null, timestamp: Number(session.createdAt) || nowMs() },
  ];
}

function trailerLines(ctx, session, targetId, lines) {
  const leaf = [...lines].reverse().find((l) => l.type === 'user' || l.type === 'assistant');
  if (!leaf?.uuid) return [];
  return [{ type: 'active-leaf', leafUuid: leaf.uuid, explicit: false, sessionId: String(targetId) }];
}

// ---- 第 3 层：投影行（一轮 → 一条 user + 一条 assistant）----

export function turnToProjectedRows(turn, session) {
  const items = turn.items ?? [];
  const userTs = Number(turn.startedAt) || Number(session.createdAt) || nowMs();
  const userUuid = newNodeId();
  const userParts = items
    .filter((it) => it.kind === 'message' && it.role === 'user' && String(it.text ?? '').trim())
    .map((it, i) => ({ id: `${userUuid}:text:${i}`, type: 'text', text: String(it.text), parentToolUseId: null }));
  // 没有用户文本的一轮不产出 user 行：宿主用 content 为空的标记表示它，但别的宿主读不出，
  // 留着会让同一会话在两类宿主里轮次数不等价（各家统一按「开轮必须有内容」）
  if (!userParts.length) return [];
  // 顶层同时给 role/text/timestamp：宿主两种代际都写过（一种只有 {parts}，一种带全套），
  // 而它的 SQL 里既有 COALESCE(role, json_extract(payload_json,'$.role')) 也有直接 json_extract 的，
  // 只给一种就会在某条路径上被当成「不是用户轮」。
  const rows = [{
    role: 'user',
    messageId: userUuid,
    turnId: userUuid,
    ts: userTs,
    payload: { id: userUuid, role: 'user', turnId: userUuid, text: userParts.map((x) => x.text).join(SENTENCE_SEP), timestamp: new Date(userTs).toISOString(), parts: userParts },
  }];

  const parts = [];
  let lastTs = userTs;
  const toolByCall = new Map();
  for (const it of items) {
    const ts = Number(it.ts) || lastTs;
    if (ts > lastTs) lastTs = ts;
    switch (it.kind) {
      case 'reasoning':
        if (String(it.text ?? '').trim()) parts.push({ id: `${userUuid}:thinking:${parts.length}`, type: 'thinking', text: String(it.text) });
        break;
      case 'message':
        if (it.role !== 'user' && String(it.text ?? '').trim()) parts.push({ id: `${userUuid}:text:${parts.length}`, type: 'text', text: String(it.text), parentToolUseId: null });
        break;
      case 'tool_call': {
        // 宿主迁移别人会话时把非 toolu_ 前缀的调用 id 规范成 toolu_migrated_*，跟着同一口径
        const raw = it.callId || newNodeId();
        const id = String(raw).startsWith('toolu_') ? String(raw) : `toolu_migrated_${String(raw).replace(/-/g, '').slice(0, 24)}`;
        const tool = { id, name: it.name || 'tool', input: it.input ?? null, status: 'completed', parentToolUseId: null, response: null };
        parts.push({ id: `tool:${id}`, type: 'tool', tool });
        if (it.callId) toolByCall.set(it.callId, tool);
        break;
      }
      case 'tool_result': {
        const tool = it.callId ? toolByCall.get(it.callId) : null;
        const out = outputText(it.output) ?? '';
        if (tool) {
          tool.response = out;
          tool.status = it.status === 'error' ? 'failed' : 'completed';
        } else {
          const id = `toolu_migrated_${String(it.callId || newNodeId()).replace(/-/g, '').slice(0, 24)}`;
          parts.push({ id: `tool:${id}`, type: 'tool', tool: { id, name: it.name || 'tool', input: null, status: it.status === 'error' ? 'failed' : 'completed', parentToolUseId: null, response: out } });
        }
        break;
      }
      case 'attachment':
        if (it.ref) parts.push({ id: `${userUuid}:file:${parts.length}`, type: 'text', text: `[attachment] ${it.ref}`, parentToolUseId: null });
        break;
      default:
        break;
    }
  }
  if (parts.length) {
    rows.push({
      role: 'assistant',
      messageId: `assistant:${userUuid}`,
      turnId: userUuid,
      ts: lastTs,
      payload: {
        id: `assistant:${userUuid}`,
        role: 'assistant',
        turnId: userUuid,
        text: parts.filter((x) => x.type === 'text').map((x) => x.text).join(SENTENCE_SEP),
        timestamp: new Date(lastTs).toISOString(),
        completedAt: new Date(lastTs).toISOString(),
        parts,
      },
    });
  }
  return rows;
}

// execution_target_json 里的 ws_ id 只做「同一目录恒得同一 id」的稳定占位：
// 宿主这个字段的哈希规则没取证到（sha256(cwd)、小写、正斜杠几种都不中），但它不参与侧栏分组
// （分组只看 chat_sessions.workspace_id，实测原生行这两列也不相等），占位不影响可见性。
function workspaceIdOf(cwd) {
  return `ws_${crypto.createHash('sha256').update(String(cwd ?? '')).digest('hex')}`;
}

// 宿主的 root_paths_json 存的是「realpath 归一 + 盘符大写 + 反斜杠」的原文（本机 4 行实测），
// 而它按 `getBySourceAndCwd` 里的 `root_paths_json[0] === path` 严格比较来复用项目行。
// 差一个字母大小写或一个分隔符，用户之后打开同一目录就会多出一行幽灵项目，所以登记前必须走同一归一。
// 目录不存在时 realpath 会抛：宿主自己（resolveWorkspaceRoots→cR）也是抛，此时不登记。
function canonicalWorkspaceRoot(cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return null;
  let real = null;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(path.resolve(raw)) : fs.realpathSync(path.resolve(raw));
  } catch {
    return null;
  }
  // 只给 Windows 盘符形态改分隔符与大小写；posix 路径保持 realpath 原样
  return /^[a-zA-Z]:[\\/]/.test(real) ? real.replace(/^([a-z])(:)/, (m, d) => `${d.toUpperCase()}:`).replace(/\//g, '\\') : real;
}

// 补登记项目行。列集与宿主 save() 对齐（列按实际库探测，老库没有 product_mode 就不写）；
// workspace_id 铸随机 v4——宿主 saveNewWorkspace 用的是随机 uuid，不存在「必须复刻路径哈希」这回事。
// 归档行不复活也不新建：宿主 list() 会滤掉 archived，插第二条只会在侧栏留下重复项。
function ensureWorkspaceRow(db, cwd, now) {
  const cols = tableColumns(db, 'workspaces');
  if (!cols.includes('workspace_id') || !cols.includes('root_paths_json')) return null;
  const root = canonicalWorkspaceRoot(cwd);
  if (!root) return null;
  const rootsOf = (text) => {
    try {
      const parsed = JSON.parse(String(text ?? '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  if (cols.includes('deleted_at')) {
    const holder = db.prepare('SELECT workspace_id, root_paths_json, archived FROM workspaces WHERE deleted_at IS NULL').all()
      .find((r) => rootsOf(r.root_paths_json)[0] === root);
    if (holder) return holder.archived ? null : { id: String(holder.workspace_id), created: false };
  }
  const id = crypto.randomUUID();
  const row = { workspace_id: id, name: baseNameOf(root) || root, workspace_source: 'local', root_paths_json: JSON.stringify([root]), created_at: now, updated_at: now };
  if (cols.includes('product_mode')) row.product_mode = 'coding';
  if (cols.includes('extra_json')) row.extra_json = '{}';
  if (cols.includes('archived')) row.archived = 0;
  try {
    insertRowFiltered(db, 'workspaces', row);
  } catch {
    return null;
  }
  return { id, created: true, root };
}

function normalizeMatchPath(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 2026-10-30 真机取证（CN 侧栏 SQL）：项目会话的分组条件是
// `SELECT … FROM chat_sessions WHERE workspace_id = ? AND registration_json IS NULL …`
// （listWorkspaceSessions），workspace_id 为 NULL 的项目会话不会出现在任何项目下。
// ws_ 占位 id 不能填进这一列——它必须等于 workspaces.workspace_id。这里按宿主登记的工作区
// 根目录认领（最长前缀、忽略分隔符与大小写）；没有匹配就不猜，留 NULL 交给调用方告警。
function matchWorkspaceId(db, cwd) {
  const cols = tableColumns(db, 'workspaces');
  if (!cols.includes('workspace_id') || !cols.includes('root_paths_json')) return null;
  const target = normalizeMatchPath(cwd);
  if (!target) return null;
  const filters = [];
  if (cols.includes('deleted_at')) filters.push('deleted_at IS NULL');
  if (cols.includes('archived')) filters.push('archived = 0');
  let rows;
  try {
    rows = db.prepare(`SELECT workspace_id, root_paths_json FROM workspaces${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`).all();
  } catch {
    return null;
  }
  let best = null;
  for (const row of rows) {
    let roots;
    try {
      roots = JSON.parse(String(row.root_paths_json ?? '[]'));
    } catch {
      continue;
    }
    if (!Array.isArray(roots)) continue;
    for (const root of roots) {
      const r = normalizeMatchPath(root);
      if (!r) continue;
      if (target !== r && !target.startsWith(`${r}/`)) continue;
      if (!best || r.length > best.length) best = { id: String(row.workspace_id), length: r.length };
    }
  }
  return best?.id ?? null;
}

const PROJECTION_WANT = ['session_id', 'message_id', 'turn_id', 'sequence', 'payload_json', 'status', 'source', 'created_at', 'updated_at', 'role', 'has_visible_content', 'payload_bytes', 'payload_hash', 'payload_schema_version'];

/**
 * 一行投影行的「列→值」（顺序即 PROJECTION_WANT）。
 * 以前这里是 projectionColumns + projectionValues 两份表：一份列名、一份值，加列时两边
 * 必须同时改，漏一处就串位（列在、值不认）。合并成 pairs 后加列只改一处，
 * 裁剪交给 insertRowFiltered（唯一出口）。
 */
function projectionPairs({ targetId, row, payload, seq, now }) {
  return PROJECTION_WANT.map((c) => [c, {
    session_id: targetId,
    message_id: row.messageId,
    turn_id: row.turnId,
    sequence: seq,
    payload_json: payload,
    status: 'completed',
    source: 'cli-import',
    created_at: row.ts || now,
    updated_at: now,
    role: row.role,
    has_visible_content: 1,
    payload_bytes: Buffer.byteLength(payload),
    payload_hash: crypto.createHash('sha256').update(payload).digest('hex'),
    payload_schema_version: 2,
  }[c]]);
}

// 顶层同时给 role/text/timestamp 时，多段文本的拼接分隔符
const SENTENCE_SEP = String.fromCharCode(10, 10);

function safeObj(text) {
  try { return JSON.parse(String(text ?? '{}')) || {}; } catch { return {}; }
}

export function createQoderWriter({ variant }) {
  const jsonl = createClaudeFamilyWriter({
    variant,
    label: VARIANTS[variant].label,
    rootFor: (ctx) => cliProjectsRoot(ctx, variant),
    header: headerLines,
    trailer: trailerLines,
  });

  function registryWrite(ctx, { session, targetId, mode, fromTurnIndex, provenance }) {
    const file = registryDbFile(ctx, variant);
    if (!file) return { skipped: 'registry-db-absent' };
    const backup = backupOnce(ctx, variant, file);
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 15000');
      const scols = new Set(tableColumns(db, 'chat_sessions'));
      if (!scols.has('session_id')) return { skipped: 'registry-schema-absent', backup };

      const now = nowMs();
      const existing = db.prepare('SELECT * FROM chat_sessions WHERE session_id = ?').get(String(targetId));
      // 认领判据：只有我们自己写过的行（带 session-sync 标记）才允许整行刷新；宿主原生的行只推进活动时间
      const owned = !!provenanceFromObject(safeObj(existing?.extra_json)['session-sync']);
      let workspaceId = scols.has('workspace_id') ? matchWorkspaceId(db, session.cwd) : null;
      // 认领不到就补登记：项目会话的分组键必须等于 workspaces.workspace_id，留 NULL 等于写进一个
      // 侧栏任何项目下都列不出来的黑洞（其余 17 家 writer 都会在写会话时把项目补上）
      let workspaceCreated = null;
      if (!workspaceId && session.scope === 'project') {
        const reg = ensureWorkspaceRow(db, session.cwd, now);
        if (reg) {
          workspaceId = reg.id;
          if (reg.created) workspaceCreated = reg.root;
        }
      }
      const values = {
        session_id: String(targetId),
        session_kind: 'standard',
        conversation_mode: 'normal',
        product_mode: 'coding',
        title: fitTitleFor(variant, normalizeText(String(session.title ?? ''))).value || 'session-sync 导入会话',
        cwd: String(session.cwd ?? ''),
        workspace_id: workspaceId,
        execution_kind: 'local',
        execution_target_json: JSON.stringify({
          mode: 'local',
          host: { id: 'local', kind: 'local', label: 'Local' },
          workspace: { id: workspaceIdOf(session.cwd), path: String(session.cwd ?? '') },
        }),
        additional_direcotries: '{}',
        extra_json: JSON.stringify({ source: 'workspace', importedFrom: 'session-sync', historyRecoveryBackgroundAgents: [], ...(provenance ? { 'session-sync': provenance } : {}) }),
        created_at: Number(session.createdAt) || now,
        updated_at: Number(session.updatedAt) || now,
        archived: 0,
        unread: 0,
        model: session.model ?? null,
        permission_mode: 'bypassPermissions',
        git_branch: session.meta?.gitBranch ?? null,
      };

      if (!existing) {
        insertRowFiltered(db, 'chat_sessions', values);
      } else if (owned) {
        // 标题只在第一次创建时拥有：续写时读回来的 session.title 是本地从首条用户文本推出来的，
        // 拿它覆盖会把宿主里更好的标题（导入时写的源会话标题 / 宿主生成的标题）降级成整段文本
        if (String(existing.title ?? '').trim()) delete values.title;
        const sets = { ...values };
        delete sets.session_id;
        delete sets.created_at;
        updateRowFiltered(db, 'chat_sessions', sets, { session_id: String(targetId) });
      } else if (scols.has('updated_at')) {
        db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?').run(values.updated_at, String(targetId));
      }

      const mcols = new Set(tableColumns(db, 'chat_session_messages'));
      if (!mcols.has('session_id')) return { skipped: 'registry-messages-absent', backup };
      // 重建（新建/分叉/续写我们自己建的会话）整份重投；追加宿主原生会话只补新增轮次，绝不动宿主的历史行
      const rebuild = mode !== 'append' || owned || !existing;
      if (rebuild) db.prepare('DELETE FROM chat_session_messages WHERE session_id = ?').run(String(targetId));
      let seq = rebuild ? 0 : db.prepare('SELECT COALESCE(MAX(sequence), 0) m FROM chat_session_messages WHERE session_id = ?').get(String(targetId)).m;
      const turns = rebuild ? (session.turns ?? []) : (session.turns ?? []).slice(fromTurnIndex);
      let written = 0;
      for (const turn of turns) {
        for (const row of turnToProjectedRows(turn, session)) {
          const payload = JSON.stringify(row.payload);
          seq += 1;
          written += 1;
          insertRowFiltered(db, 'chat_session_messages', projectionPairs({ targetId: String(targetId), row, payload, seq, now: values.updated_at }));
        }
      }
      if (tableColumns(db, 'chat_session_history_revisions').includes('session_id')) {
        insertRowFiltered(db, 'chat_session_history_revisions', [['session_id', String(targetId)], ['revision', seq]], { verb: 'INSERT OR REPLACE' });
      }
      return { ok: true, backup, rows: written, projection: rebuild ? 'rebuild' : 'append', created: !existing, workspaceId, workspaceCreated };
    } finally {
      db.close();
    }
  }

  return {
    variant,
    label: VARIANTS[variant].label,
    canWrite: (ctx) => jsonl.canWrite(ctx),
    targetPath: (ctx, session, targetId) => jsonl.targetPath(ctx, session, targetId),
    relocate: (ctx, args) => jsonl.relocate(ctx, args),

    write(ctx, args) {
      // 非项目会话的落点是宿主自生成的日期桶目录，而宿主是「按目录打开工作区」的：
      // 目录不存在时这条会话没有可用工作区（与 zcode 同一条规则：落点目录必须真实存在）
      if (args.session?.scope === 'none' && args.session?.cwd) ensureDir(String(args.session.cwd));
      // 追加到「只有注册表行、正文 jsonl 不存在」的原生会话时，必须整份物化：
      // 只写增量会让 jsonl 成为一份缺前缀的正文，而读侧 jsonl 优先 → 前面的轮次凭空消失
      let effective = args;
      if (args.mode === 'append') {
        const existingFile = jsonl.targetPath(ctx, args.session, args.targetId);
        if (!existingFile || !fs.existsSync(existingFile)) {
          effective = { ...args, mode: 'create', fromTurnIndex: 0, force: true };
        }
      }
      const res = jsonl.write(ctx, effective);
      if (!res.ok) return res;
      const warnings = [...(res.warnings ?? []), 'registry-refresh-needed: 外部写注册表不会触发宿主的列表推送，桌面侧栏要刷新或重开列表才出现'];
      let reg;
      try {
        reg = registryWrite(ctx, { ...effective, mode: effective.mode === 'create' && args.mode === 'append' ? 'append' : effective.mode });
      } catch (err) {
        return { ...res, warnings: [...warnings, `registry-write-failed: ${String(err?.message ?? err)}（正文已写入，桌面这一层没写成）`] };
      }
      if (reg.skipped) warnings.push(`${reg.skipped}: 桌面注册表这一层没写成，会话只在 CLI 侧可见`);
      else {
        warnings.push(`registry-${reg.projection}: ${reg.rows} 行投影`);
        if (reg.workspaceCreated) warnings.push(`workspace-created: 已在目标宿主注册表补登记该项目（${reg.workspaceCreated}）`);
        else if (effective.session?.scope === 'project' && !reg.workspaceId) {
          warnings.push('workspace-unmatched: 该目录盘上不存在（宿主登记项目要求目录真实存在），桌面侧栏的项目分组不会显示它（列表按 chat_sessions.workspace_id 过滤）');
        }
      }
      return { ...res, warnings, index: reg, backup: reg.backup ?? res.backup };
    },

    /**
     * 元数据漂移：源侧只改了标题（内容没变）时，把新名同步到目标。
     * qoder 的标题只住在桌面注册表 chat_sessions.title（CLI 明文 jsonl 里没有标题字段），
     * 所以只有一个 db 槽；正文不动。
     */
    syncTitle: makeTitleSyncer(() => [
      { kind: 'db-column', db: (c) => registryDbFile(c, variant), table: 'chat_sessions', idCol: 'session_id', col: 'title', maxLen: TITLE_MAX.qoder },
    ], variant),
  };
}

export const qoderCnWriter = createQoderWriter({ variant: 'qoder-cn' });
export const qoderIntlWriter = createQoderWriter({ variant: 'qoder-intl' });
