// readers/workbuddy.mjs — WorkBuddy 中文版 / 国际版
//
// 存储：<root>/projects/<project-slug>/<sessionId>.jsonl（一行一事件）
// 事件类型：message(user|assistant) / reasoning / function_call / function_call_result
//          / ai-title / session-meta / file-history-snapshot
// provenance 槽位：session-meta 行的 meta["session-sync"]（+ sidecar 兜底）
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS } from '../hosts.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  attachmentItem,
  finalizeSession,
} from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { cmpPath } from '../util.mjs';
import { outputText, compactionInjectionKind, compactionSummaryText } from '../text.mjs';
import { normalizeTitle, previewTitle } from '../titles.mjs';
import { roleRoots } from '../roots.mjs';
import { assembleTurns,
  deriveTitle,
  stripSystemInjections,
  walkFiles,
  listEvents,
  parseJsonl,
  toMs,
  fileMtime,
  openDb,
  tableColumns,
  tableExists,
  inTimeRange,
  parseArgs, pushAssistantItem } from './base.mjs';


function projectsDir(ctx, variant) {
  return roleRoots(variant, ctx, 'projects')[0]?.path ?? null;
}

function dbFile(ctx, variant) {
  const f = roleRoots(variant, ctx, 'sessionsIndex').find((x) => fs.existsSync(x.path));
  return f?.path ?? null;
}

/**
 * 侧栏工作区名（= 项目名）的唯一权威来源：宿主「Rename Workspace」把显示名写进
 * `<root>/workspace-display-names.json`，只改显示名、不改目录
 * （UI 原文：Only the display name changes. The actual folder path will stay the same.）。
 * 文件结构：{version:1, workspaces:{ <规范化路径>: {id, path, displayName, updatedAt} }}，
 * 键与宿主的 normalizeWorkspacePathForCompare 同口径（正斜杠 + win32 小写）。
 * 没有改名记录 → 返回空 map，展示层回退目录末段（宿主默认标签同口径）。
 */
function workspaceDisplayNames(ctx, variant) {
  const map = new Map();
  const projects = projectsDir(ctx, variant);
  const file = projects ? path.join(path.dirname(projects), 'workspace-display-names.json') : null;
  if (!file) return map;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return map;
  }
  for (const w of Object.values(j?.workspaces ?? {})) {
    const name = String(w?.displayName ?? '').trim();
    const key = cmpPath(w?.path || w?.id || '');
    if (name && key) map.set(key, name);
  }
  return map;
}

/**
 * 宿主库里的会话行 → 只作信号源：jsonl 缺 cwd 时兜底、取 user_id、取 deleted_at。
 * 一律不得当筛选条件（D3：源侧不分账户全部导入）。
 * 判据实测：project_id 全 NULL、is_playground 只覆盖 64/131（cn）与 22/69（intl），
 * 所以 scope 不靠这些列，交给 INTERNAL_ROOTS 对 cwd 的前缀匹配。
 */
function dbIndex(ctx, variant) {
  const map = new Map();
  const file = dbFile(ctx, variant);
  if (!file) return map;
  let db;
  try {
    db = openDb(file);
  } catch {
    return map;
  }
  try {
    if (!tableExists(db, 'sessions')) return map;
    const have = new Set(tableColumns(db, 'sessions'));
    const cols = ['id', 'cwd', 'user_id', 'deleted_at', 'title', 'custom_title'].filter((c) => have.has(c));
    if (!cols.includes('id')) return map;
    for (const r of db.prepare(`SELECT ${cols.join(',')} FROM sessions`).all()) {
      map.set(String(r.id), {
        // 宿主的标题裁决（真机取证 app.asar /main/database-factory.js 的 extractSessionInfoFromJsonl
        // 与 /main/conversations.js 的 resolveConversationTitle）：
        //   custom_title 列（用户在 WorkBuddy 里手动改的名，isUserDefinedTitle = customTitle 非空）
        //   > 正文 custom-title 行 > 正文 ai-title 行 > 首条用户文本
        // db 的 title 列只是生成标题的落点，不是裁决项 —— 用户改名后它是旧值。
        // 读侧**一律原样返回**：这里曾按预览长度(80)/落点容量(500)截断，结果是「读回来的
        // 比宿主里存的短」——列表显示的不是真相，drift 比对也永远不相等。
        // 容量只在写侧做校验（titles.checkTitleFits），读侧不参与。
        customTitle: normalizeTitle(r.custom_title),
        title: normalizeTitle(r.title),
        cwd: r.cwd ? String(r.cwd) : '',
        userId: r.user_id ? String(r.user_id) : null,
        deletedAt: r.deleted_at ? Number(r.deleted_at) : 0,
      });
    }
  } catch {
    return map;
  } finally {
    try {
      db.close();
    } catch {
      /* 已被宿主占用等情况 */
    }
  }
  return map;
}

// 会话文件索引：id → 文件路径（同一 id 可能散落在多个 project 目录，取最新）
function indexSessions(dir) {
  const map = new Map();
  if (!dir) return map;
  const files = walkFiles(dir, {
    maxDepth: 2,
    match: (n) => n.endsWith('.jsonl') && !n.includes('.session-sync.'),
    skipDir: (n) => n === 'tool-results' || n === 'node_modules',
  });
  for (const f of files) {
    const id = path.basename(f, '.jsonl');
    const prev = map.get(id);
    if (!prev || fileMtime(f) > fileMtime(prev)) map.set(id, f);
  }
  return map;
}

// 工具输出 → 文本走 text.mjs 的唯一实现：它已经认 `{content: [...]}` 这层包装，
// 各家宿主的形态差异（文本块 / {text} / {content[]} / 裸 JSON）在那里一次归一。
// 这里曾有一份「WorkBuddy 专用」的实现，理由是「别的实现不认 content 数组」——
// 那是把「唯一出口没写好」当成了宿主差异，结果同一份输出在两处算出不同文本。


// 单行事件 → 会话级信息（title / cwd / model / provenance / 时间跨度）
function consumeMeta(ev, acc) {
  const ts = toMs(ev.timestamp);
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    if (ts > acc.updatedAt) acc.updatedAt = ts;
  }
  if (ev.cwd && !acc.cwd) acc.cwd = ev.cwd;
  if (ev.providerData?.model && !acc.model) acc.model = ev.providerData.model;
  if (ev.type === 'ai-title' && ev.aiTitle && !acc.title) acc.title = String(ev.aiTitle);
  // 用户在 WorkBuddy 里手动改的名（宿主写 custom-title 行；优先级高于 ai-title）
  if (ev.type === 'custom-title' && ev.customTitle) acc.customTitle = String(ev.customTitle);
  if (ev.type === 'session-meta') {
    const prov = provenanceFromObject(ev.meta && ev.meta['session-sync']);
    if (prov) acc.provenance = prov;
    if (ev.meta && typeof ev.meta === 'object') {
      for (const [k, v] of Object.entries(ev.meta)) if (!k.includes('session-sync')) acc.meta[k] = v;
    }
  }
}

// 消息类事件 → entries（顺序重放，保留 reasoning/tool 与 message 的真实交错）
function replayEntries(lines) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);

  for (const ev of lines) {
    const ts = toMs(ev.timestamp);
    switch (ev.type) {
      case 'message': {
        const role = ev.role === 'user' ? 'user' : ev.role === 'assistant' ? 'assistant' : null;
        if (!role) break;
        const compactRow = role === 'user' && ev.providerData?.isSummary === true &&
          (ev.providerData.isCompacted === true || String(ev.id ?? '').startsWith('cmp_'));
        const items = [];
        for (const c of Array.isArray(ev.content) ? ev.content : []) {
          const kind = String(c?.type ?? '');
          if (typeof c?.text === 'string' && c.text) {
            const text = role === 'user' ? stripSystemInjections(c.text) : c.text;
            if (text) {
              const compact = role === 'user' && (compactRow || compactionInjectionKind(text) !== null);
              const body = compact ? compactionSummaryText(text) : text;
              if (body.trim()) items.push(messageItem(role, body, ts, compact));
            }
          } else if (kind.includes('image') || kind.includes('file')) {
            items.push(attachmentItem(c.path ?? c.url ?? c.name ?? '', kind, ts));
          }
        }
        // 没有可展示内容的事件不开轮：宿主原生会用「content 为空的 user 事件」标记
        // 「只有助手继续输出」的一轮（实测 workbuddy 两家共 86 个），但别的宿主（claude/pi/codex…）
        // 读不出这种轮次。留着它就会让同一会话在不同宿主算出不同轮次数 → 续写误判分叉，
        // 所以按各家一致的口径：这类标记并进上一轮。
        if (items.length) entries.push({ role, ts, items });
        break;
      }
      case 'reasoning': {
        const parts = [];
        for (const c of ev.rawContent ?? []) if (c?.type === 'reasoning_text' && c.text) parts.push(c.text);
        if (parts.length === 0) for (const c of ev.content ?? []) if (c?.text) parts.push(c.text);
        const text = parts.join('\n\n').trim();
        if (text) pushItem(reasoningItem(text, ts), ts);
        break;
      }
      case 'function_call':
        pushItem(toolCallItem(ev.callId ?? ev.id ?? null, ev.name ?? 'tool', parseArgs(ev.arguments), ts), ts);
        break;
      case 'function_call_result':
        pushItem(toolResultItem(ev.callId ?? null, ev.name ?? 'tool', ev.status ?? 'unknown', outputText(ev.output), ts), ts);
        break;
      default:
        // file-history-snapshot / queue-operation / last-prompt 等机械事件
        break;
    }
  }
  return entries;
}

export function createWorkbuddyReader({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    available(ctx) {
      const d = projectsDir(ctx, variant);
      return !!d && fs.existsSync(d);
    },

    list(ctx, opts = {}) {
      const dir = projectsDir(ctx, variant);
      const rows = dbIndex(ctx, variant);
      const displayNames = workspaceDisplayNames(ctx, variant);
      const out = [];
      for (const [id, file] of indexSessions(dir)) {
        // list 优化：
        //  - 只采样头部（首条用户消息/标题/cwd/model 通常都在开头）
        //  - updatedAt 用文件 mtime（比解析尾部更准也更快，排序用途足够）
        const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', customTitle: '', model: null, meta: {}, provenance: null };
        let userMsgs = 0;
        let preview = '';
        for (const ev of listEvents(file)) {
          consumeMeta(ev, acc);
          if (ev.type === 'message' && ev.role === 'user') {
            // 与 read 同一判据：可展示内容（去注入后的文本，或图片/文件）才算开一轮。
            // 宿主原生用「content 为空的 user 事件」标记助手继续输出（实测两家共 86 个），
            // 这些并进上一轮；list 若照数就会比 read 多数。
            const blocks = Array.isArray(ev.content) ? ev.content : [];
            let text = '';
            let displayable = 0;
            for (const c of blocks) {
              const kind = String(c?.type ?? '');
              if (typeof c?.text === 'string' && c.text) {
                const clean = stripSystemInjections(c.text);
                if (clean) { displayable++; if (!text) text = clean; }
              } else if (kind.includes('image') || kind.includes('file')) displayable++;
            }
            if (!displayable) continue;
            userMsgs++;
            if (!preview) preview = text;
          }
        }
        const row = rows.get(id);
        const cwd = acc.cwd || row?.cwd || '';
        out.push({
          id,
          variant,
          // 宿主侧栏显示的是 db sessions.title（可能被用户改过/宿主重新生成）；jsonl 的 ai-title 只兜底，且不截断
          // 宿主口径（真机取证 app.asar）：custom_title 列 > 正文 custom-title 行 > db title 列 > 正文 ai-title 行 > 首问
          title: row?.customTitle || acc.customTitle || row?.title || acc.title || previewTitle(preview) || 'untitled',
          preview: preview.replace(/\s+/g, ' ').slice(0, 120),
          cwd,
          projectName: displayNames.get(cmpPath(cwd)) ?? '',
          createdAt: acc.createdAt,
          updatedAt: fileMtime(file),
          turns: userMsgs,
          turnsApprox: false,
          model: acc.model,
          provenance: acc.provenance,
          sourcePath: file,
          account: row?.userId ? { variant, id: row.userId } : null,
          archived: !!row?.deletedAt,
        });
      }
      return out.filter((s) => inTimeRange(s, opts));
    },

    read(ctx, id) {
      const dir = projectsDir(ctx, variant);
      const file = indexSessions(dir).get(String(id));
      if (!file) return null;

      const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
      const acc = { createdAt: 0, updatedAt: 0, cwd: '', title: '', customTitle: '', model: null, meta: {}, provenance: null };
      for (const ev of lines) consumeMeta(ev, acc);
      const row = dbIndex(ctx, variant).get(String(id));

      const turns = assembleTurns(replayEntries(lines));
      const session = makeSession({
        id: String(id),
        variant,
        // 宿主口径（真机取证 app.asar）：custom_title 列 > 正文 custom-title 行 > db title 列 > 正文 ai-title 行 > 首问
        title: deriveTitle(row?.customTitle || acc.customTitle || row?.title || acc.title, turns),
        cwd: acc.cwd || row?.cwd || '',
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
        model: acc.model,
        account: row?.userId ? { variant, id: row.userId } : null,
        turns,
        meta: { sourcePath: file, ...acc.meta },
      });
      applyProvenanceToIR(session, acc.provenance || readSidecarProvenance(file));
      return finalizeSession(session);
    },
  };
}
