// readers/codex.mjs — Codex CLI
//
// 存储：sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl[.zst] + 扁平 archived_sessions/（已归档）
//
// 事件：session_meta / event_msg / response_item / world_state / turn_context
//      / token_usage_record / compacted
// 对话取 response_item 与 compacted；event_msg/item_completed 是重复投影。
//  response_item.payload.type:
//    message(role developer|user|assistant, content[{type:'input_text'|'output_text',text}])
//    reasoning(summary[], encrypted_content="ocxr1:<base64 JSON{txt}>")
//    custom_tool_call{call_id,name,input} / custom_tool_call_output{call_id,output[]}
//    function_call{call_id,name,arguments} / function_call_output{call_id,output}
// provenance 槽位：专用行 type="session-sync-provenance" + sidecar 兜底
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { candidateRoots } from '../roots.mjs';
import {
  makeSession,
  messageItem,
  reasoningItem,
  toolCallItem,
  toolResultItem,
  finalizeSession,
} from '../ir.mjs';
import { provenanceFromObject, applyProvenanceToIR, readSidecarProvenance } from '../provenance.mjs';
import { assembleTurns, deriveTitle, stripSystemInjections, walkFiles, parseJsonl, readHead, toMs, fileMtime, inTimeRange,
  parseArgs, pushAssistantItem, tableColumns, outputText } from './base.mjs';
import { previewTitle } from '../titles.mjs';
import { compactionInjectionKind, compactionSummaryText } from '../text.mjs';

// session_meta 首行含 base_instructions 全文，可达数百 KB，取身份时要读够窗口
const META_WINDOW = 2 * 1024 * 1024;
export const PROVENANCE_LINE_TYPE = 'session-sync-provenance';

// 归档根（archived_sessions）里的会话只用于「目标已存在」判定，不进导入候选（D1）
/**
 * 宿主的标题在 state_<N>.sqlite 的 threads 表（name = 用户改名，title = 自动摘要；侧栏优先显示 name）。
 * rollout 的 session_meta 没有标题字段 —— 不读这张表就只能拿首条消息凑。
 */
function sessionsRootOf(ctx) {
  return sessionDirs(ctx)[0]?.dir ?? null;
}

/**
 * 宿主的线程库 = <codex 根>/state_<N>.sqlite 里**最近改动**的那份（代际号会随升级递增）。
 * reader 取标题、writer 改 creator_* 都必须走同一个定位规则，两处各写一套就会指到不同的库。
 * @returns {string|null}
 */
export function threadsDbFile(ctx) {
  const dir = path.dirname(sessionsRootOf(ctx) ?? '');
  try {
    const files = fs.readdirSync(dir).filter((n) => /^state_\d+\.sqlite$/.test(n));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    return path.join(dir, files[0]);
  } catch {
    return null;
  }
}

function threadTitles(ctx) {
  const file = threadsDbFile(ctx);
  const map = new Map();
  if (!file) return map;
  try {
    const db = new DatabaseSync(file);
    try {
      const cols = tableColumns(db, 'threads');
      if (!cols.includes('id')) return map;
      const sel = ['id', cols.includes('name') ? 'name' : null, cols.includes('title') ? 'title' : null].filter(Boolean).join(',');
      for (const r of db.prepare(`SELECT ${sel} FROM threads`).all()) {
        const t = String(r.name ?? '').trim() || String(r.title ?? '').trim();
        if (t) map.set(String(r.id), t);
      }
    } finally { db.close(); }
  } catch { /* 表不存在/被占用 → 退回推导标题 */ }
  return map;
}

/**
 * 侧栏的项目名在 `.codex-global-state.json`：`thread-project-assignments[线程]` → 项目，
 * 项目显示名 = `local-projects[projectId].name`（宿主侧栏用的就是它）。
 *
 * 只取「有 assignment」这一正信号。`projectless-thread-ids` **不能**用来判 scope：
 * 本机实测有 112 条带 git 的项目会话也挂在这个名单里（宿主自己的历史脏数据），
 * 拿它改判会把项目会话错标成非项目 —— 分类仍以 cwd 是否落在宿主自管根为准。
 */
function projectRegistry(ctx) {
  const file = path.join(path.dirname(sessionsRootOf(ctx) ?? ''), '.codex-global-state.json');
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
  const projects = st?.['local-projects'] && typeof st['local-projects'] === 'object' ? st['local-projects'] : {};
  const assignments = st?.['thread-project-assignments'] && typeof st['thread-project-assignments'] === 'object' ? st['thread-project-assignments'] : {};
  const names = new Map();
  for (const [threadId, a] of Object.entries(assignments)) {
    const name = String(projects?.[a?.projectId]?.name ?? '').trim();
    if (name) names.set(String(threadId), name);
  }
  return names;
}

function sessionDirs(ctx) {
  // 归档判定走 role，不再靠目录名 basename（目录被搬走/改名就不会误判）
  return (candidateRoots('codex', ctx) ?? [])
    .filter((x) => x.kind === 'dir')
    .map((x) => ({ dir: x.path, archived: x.role === 'archive' }));
}

function isZst(file) {
  return String(file).endsWith('.zst');
}

function readText(file) {
  const buf = fs.readFileSync(file);
  return isZst(file) ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
}

// 全量解析：轮次要与 read 同口径（zst 本来就得整帧解压，普通 jsonl 也不再采样）
function eventsForList(file) {
  return parseJsonl(readText(file));
}

function listFiles(ctx) {
  const out = [];
  for (const { dir, archived } of sessionDirs(ctx)) {
    if (!dir) continue;
    for (const f of walkFiles(dir, { maxDepth: 5, match: (n) => /\.jsonl(\.zst)?$/i.test(n) && n.startsWith('rollout-') && !n.includes('.session-sync.') })) {
      out.push({ file: f, archived });
    }
  }
  return out;
}

// rollout-<本地时间>-<thread>[_<新uuid>].jsonl[.zst]：文件名时间段即分片顺序
function segmentKey(file) {
  const m = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(path.basename(file));
  return m ? m[1] : String(fileMtime(file)).padStart(20, '0');
}

// thread 身份 = session_meta 的 id（见 consumeMeta 注释）。会话每次续跑宿主新开一个分片文件
// `rollout-<本地时间>-<thread>[_<新分片uuid>].jsonl[.zst]`，同一个 thread 会有多个文件
// ⇒ 必须按 thread 分组并按时间顺序合并，否则导入时多个分片互相覆盖。
//
// 身份优先取文件名里的**首个** uuid：现场 453 个 rollout 文件全量比对，meta.id 与文件名首 uuid
// 0 例外相等，而读 meta 必须整帧解压 zst（一次 list 双份解压开销）。名字里没有 uuid 时才回落到内容。
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function threadIdOf(file) {
  const base = path.basename(file).replace(/\.jsonl\.zst$/i, '').replace(/\.jsonl$/i, '');
  const ids = base.match(UUID_RE);
  if (ids?.length) return ids[0];
  const head = isZst(file) ? readText(file) : readHead(file, META_WINDOW);
  for (const line of head.split('\n').slice(0, 8)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // session_meta 首行可能超过窗口，逐行试解析
    }
    if (o.type === 'session_meta') {
      const id = o.payload?.id ?? o.payload?.session_id;
      if (id) return String(id);
      break;
    }
  }
  return base;
}

function groupThreads(ctx) {
  const groups = new Map();
  for (const { file, archived } of listFiles(ctx)) {
    const id = threadIdOf(file);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, segments: [] }));
    g.segments.push({ file, archived, key: segmentKey(file) });
  }
  for (const g of groups.values()) {
    g.segments.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // 只有「每个分片都在归档区」才算归档：只要还有一份在 sessions/ 下，宿主就仍然列得到它，
    // 否则 D1 会把这条活着的会话误当成归档丢掉
    g.archived = g.segments.length > 0 && g.segments.every((s) => s.archived);
  }
  return groups;
}

// encrypted_content 形如 "ocxr1:<base64(JSON{txt})>" —— 可无损还原推理文本
function decodeReasoning(payload) {
  const summary = Array.isArray(payload?.summary) ? payload.summary.map((s) => s?.text ?? '').filter(Boolean) : [];
  if (Array.isArray(payload?.content)) {
    const inline = payload.content.map((c) => c?.text ?? '').filter(Boolean);
    if (inline.length) return inline.join('\n\n');
  }
  const enc = payload?.encrypted_content;
  if (typeof enc === 'string' && enc.length > 8) {
    let s = enc;
    const i = s.indexOf(':');
    if (i > 0 && i <= 12) s = s.slice(i + 1);
    try {
      const obj = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
      if (typeof obj?.txt === 'string' && obj.txt) return obj.txt;
      if (typeof obj?.text === 'string' && obj.text) return obj.text;
    } catch {
      /* 非可解封装 */
    }
  }
  return summary.join('\n\n');
}

// Codex 把 AGENTS.md、环境快照、中断/页面事件都塞进 role=user 的 message 里，
// 这些是上下文注入而非用户发言，必须剔除，否则会污染轮次与标题
const CODEX_INJECTION_PATTERNS = [
  /^#\s*AGENTS\.md instructions/i,
  /^#\s*Instructions\b/i,
  /^<turn_aborted>/,
  /^<external_codex_apps_open_page>/,
  /^<environment_context>/,
  /^<user_instructions>/,
  /^<permissions instructions>/i,
  /^<automation_context>/,
];

function isInjection(text) {
  const t = String(text ?? '').trimStart();
  if (!t) return true;
  return CODEX_INJECTION_PATTERNS.some((re) => re.test(t));
}

function codexUserItems(payload, ts) {
  const parts = (Array.isArray(payload.content) ? payload.content : [])
    .map((part) => part?.text).filter((text) => typeof text === 'string' && text);
  if (!parts.some(compactionInjectionKind)) {
    const text = parts.join('\n\n');
    const body = isInjection(text) ? '' : stripSystemInjections(text);
    return body ? [messageItem('user', body, ts)] : [];
  }
  return parts.flatMap((text) => {
    const compact = compactionInjectionKind(text) !== null;
    const body = compact ? compactionSummaryText(text) : isInjection(text) ? '' : stripSystemInjections(text);
    return body.trim() ? [messageItem('user', body, ts, compact)] : [];
  });
}

function userItemsForEvent(ev, previous) {
  const ts = toMs(ev.timestamp);
  if (ev.type === 'compacted') {
    const text = plaintextSummary(ev.payload);
    const mirror = previous?.type === 'response_item' && previous.timestamp === ev.timestamp &&
      previous.payload?.type === 'message' && previous.payload.role === 'user' &&
      previous.payload.content?.every?.((part) => /^<(?:cb_summary|conversation_history_summary)>/u.test(part?.text ?? '')) &&
      text === compactText(codexUserItems(previous.payload, ts));
    return text.trim() && !mirror ? [messageItem('user', text, ts, true)] : [];
  }
  if (ev.type === 'response_item' && ev.payload?.type === 'message' && ev.payload.role === 'user') {
    return codexUserItems(ev.payload, ts);
  }
  return null;
}

function plaintextSummary(payload) {
  const text = payload?.message;
  return typeof text === 'string' ? compactionSummaryText(text) : '';
}

function compactText(items) {
  return items.length && items.every((item) => item.compact) ? items.map((item) => item.text).join('\n\n') : '';
}

function previousBodyEvent(previous, event) {
  if (event.type === 'event_msg' && event.payload?.type === 'user_message' &&
      previous?.timestamp === event.timestamp && previous.payload?.role === 'user') return previous;
  return event;
}

function consumeMeta(ev, acc) {
  const ts = toMs(ev.timestamp);
  if (ts) {
    if (!acc.createdAt) acc.createdAt = ts;
    if (ts > acc.updatedAt) acc.updatedAt = ts;
  }
  if (ev.type === 'session_meta') {
    const p = ev.payload ?? {};
    // 身份取 thread id（payload.id，与文件名一致）：subagent 线程的 session_id 是**父会话**的，
    // 用它当身份会让多条线程在 list 里塌成同一 id（现场 453 个文件实测有 10 组如此）
    if (p.id || p.session_id) acc.sessionId = String(p.id ?? p.session_id);
    if (p.cwd) acc.cwd = p.cwd;
    if (p.timestamp) acc.createdAt = toMs(p.timestamp) || acc.createdAt;
    if (p.model) acc.model = p.model;
    // git 有没有 = 宿主自己认不认它是项目会话（实测落 ~/Documents/Codex 桶的 105 条全部无 git）。
    // 写侧要用它决定「不写 git 字段」，所以两个方向都得带出来。
    if (p.git && typeof p.git === 'object') {
      acc.hasGit = true;
      acc.git = { commit_hash: p.git.commit_hash ?? null, branch: p.git.branch ?? null, repository_url: p.git.repository_url ?? null };
    }
    if (p.creator_user_id || p.creator_account_id) {
      acc.account = { variant: 'codex', id: String(p.creator_user_id ?? ''), accountId: p.creator_account_id ? String(p.creator_account_id) : null };
    }
  }
  if (ev.type === 'turn_context' && ev.payload?.model && !acc.model) acc.model = ev.payload.model;
  if (ev.type === 'event_msg' && ev.payload?.type === 'thread_settings_applied' && ev.payload.thread_settings?.model && !acc.model) {
    acc.model = ev.payload.thread_settings.model;
  }
  if (ev.type === PROVENANCE_LINE_TYPE) {
    // 兼容两种落点：顶层字段（推荐）或 payload 内
    const prov = provenanceFromObject(ev['session-sync']) || provenanceFromObject(ev.payload?.['session-sync']);
    if (prov) acc.provenance = prov;
  }
}

function replayEntries(lines) {
  const entries = [];
  const pushItem = (item, ts) => pushAssistantItem(entries, item, ts);
  // 工具结果行（custom_tool_call_output / function_call_output）本身不带 name，
  // 只按「调用名回落成 tool」会把源侧读成 tool、而写侧按 callId 合并后回读成真实调用名（exec）——
  // 同一会话两套名字 → 指纹分歧 → 复跑判 fork 而不是收敛。记住配对的名字即可。
  const toolNames = new Map();
  let previous;

  for (const ev of lines) {
    const userItems = userItemsForEvent(ev, previous);
    previous = previousBodyEvent(previous, ev);
    if (userItems) {
      if (userItems.length) {
        entries.push({ role: 'user', ts: userItems[0].ts, items: userItems });
      }
      continue;
    }
    if (ev.type !== 'response_item') continue;
    const p = ev.payload ?? {};
    const ts = toMs(ev.timestamp);

    if (p.type === 'message') {
      if (p.role !== 'assistant') continue;
      const parts = [];
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (typeof c?.text === 'string' && c.text) parts.push(c.text);
      }
      const text = parts.join('\n\n');
      if (!text) continue;
      entries.push({ role: 'assistant', ts, items: [messageItem('assistant', text, ts)] });
      continue;
    }

    if (p.type === 'reasoning') {
      const text = decodeReasoning(p);
      if (text) pushItem(reasoningItem(text, ts), ts);
      continue;
    }

    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const callId = p.call_id ?? p.id ?? null;
      const name = p.name ?? 'tool';
      if (callId) toolNames.set(String(callId), name);
      pushItem(toolCallItem(callId, name, parseArgs(p.input ?? p.arguments), ts), ts);
      continue;
    }

    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const callId = p.call_id ?? null;
      const name = (callId && toolNames.get(String(callId))) || p.name || 'tool';
      pushItem(toolResultItem(callId, name, 'ok', outputText(p.output), ts), ts);
      continue;
    }
    // 其它 response_item 子类型（web_search_call / local_shell_call …）忽略
  }
  return entries;
}

export const codexReader = {
  variant: 'codex',
  label: 'Codex CLI',

  available(ctx) {
    return sessionDirs(ctx).some((d) => d.dir && fs.existsSync(d.dir));
  },

  list(ctx, opts = {}) {
    const out = [];
    const hostTitles = threadTitles(ctx);
    const projectNames = projectRegistry(ctx);
    for (const g of groupThreads(ctx).values()) {
      const acc = { createdAt: 0, updatedAt: 0, cwd: '', model: null, provenance: null, sessionId: g.id, hasGit: false, git: null, account: null };
      let userMsgs = 0;
      let preview = '';
      for (const seg of g.segments) {
        const file = seg.file;
        let previous;
        for (const ev of eventsForList(file)) {
          consumeMeta(ev, acc);
          const items = userItemsForEvent(ev, previous);
          previous = previousBodyEvent(previous, ev);
          if (items?.length) {
            userMsgs++;
            preview ||= items.map((item) => item.text).join('\n');
          }
        }
      }
      const first = g.segments[0];
      const tid = String(acc.sessionId || g.id);
      out.push({
        id: tid,
        variant: 'codex',
        title: hostTitles.get(tid) || previewTitle(preview) || 'untitled',
        preview: preview.replace(/\s+/g, ' ').slice(0, 120),
        cwd: acc.cwd,
        projectName: projectNames.get(tid) ?? '',
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt || fileMtime(first.file),
        turns: userMsgs,
        turnsApprox: false,
        model: acc.model,
        account: acc.account,
        hasGit: !!acc.hasGit,
        provenance: acc.provenance,
        sourcePath: first.file,
        segments: g.segments.map((s) => s.file),
        ...(g.archived ? { archived: true } : {}),
      });
    }
    return out.filter((s) => inTimeRange(s, opts));
  },

  read(ctx, id) {
    const hostTitles = threadTitles(ctx);
    const g = groupThreads(ctx).get(String(id));
    if (!g) return null;
    const lines = g.segments.flatMap((seg) => parseJsonl(readText(seg.file)));
    const acc = { createdAt: 0, updatedAt: 0, cwd: '', model: null, provenance: null, sessionId: String(id), hasGit: false, git: null, account: null };
    for (const ev of lines) consumeMeta(ev, acc);

    const turns = assembleTurns(replayEntries(lines));
    const compactions = lines.filter((ev) => ev.type === 'compacted').map((ev) => {
      const encrypted = Array.isArray(ev.payload?.replacement_history) &&
        ev.payload.replacement_history.some((item) => item?.type === 'compaction' && item.encrypted_content);
      return { timestamp: toMs(ev.timestamp), kind: plaintextSummary(ev.payload).trim() ? 'plaintext' : encrypted ? 'encrypted' : 'opaque' };
    });
    const session = makeSession({
      id: String(id),
      variant: 'codex',
      title: deriveTitle(hostTitles.get(String(id)) ?? '', turns),
      cwd: acc.cwd,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
      model: acc.model,
      account: acc.account,
      turns,
      meta: {
        sourcePath: g.segments[0].file,
        segments: g.segments.map((s) => s.file),
        hasGit: !!acc.hasGit,
        git: acc.git,
        ...(compactions.length ? { compactions } : {}),
        ...(g.archived ? { archived: true } : {}),
      },
    });
    applyProvenanceToIR(session, acc.provenance || readSidecarProvenance(g.segments[0].file));
    return finalizeSession(session);
  },
};
