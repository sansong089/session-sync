// writers/opencode.mjs — 写 OpenCode 新 schema（session_v2 + session_message 内联 content）
//
// session_v2.metadata 是 provenance 的自然槽位
// session_message.type：user / assistant / compaction（宿主注入的压缩摘要；其余如 system 为机械事件）
// assistant.data.content[]：reasoning / text / tool{id,name,state{status,input,content}}
// project_id 必须指向真实 project 行（复刻 opencode Project.resolve），
// 否则 `opencode session list` / TUI 的 /sessions 按当前项目过滤后看不到导入的会话。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSidecarProvenance } from '../provenance.mjs';
import { insertProjectRow } from './project.mjs';
import { GLOBAL_PROJECT } from '../readers/base.mjs';
import { insertRowFiltered, newNodeId,
  outputText, slugOf, updateRowFiltered } from './base.mjs';
import { tableExists, tableColumns, firstExisting, safeJson, TOOL_RESULT_ONLY, TOOL_NULL_INPUT } from '../readers/base.mjs';
import { isNativeOpencodeId, importedNativeId } from '../opencode-id.mjs';
import { classifySource, resolvePlacement } from '../placement.mjs';
import { isFile } from '../util.mjs';
import { compactionInjectionKind, compactionSummaryText } from '../text.mjs';
import { roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';

function dbFile(ctx) {
  const hit = firstExisting(roleRoots('opencode', ctx, 'db').filter((x) => x.kind === 'file'));
  return hit?.path ?? null;
}

// assistant 消息的 agent/model 是 schema 必填项。
//
// provider 必须是**宿主真实 provider**（opencode），不能是占位值：上游
// to-llm-message.ts 用 sameProvider = message.model.providerID === model.providerID
// 决定要不要保留 providerMetadata。占位 provider 会让 sameProvider/sameModel
// 判 false → providerMetadata 被丢 → reasoning 从 reasoning + reasoning_details
// 退化成 reasoning_content，而 Zen 网关会丢弃 reasoning_content（真机抓包实测：
// 原生请求带 reasoning/reasoning_details，导入请求只有 reasoning_content）。
// 后果是导入会话的推理内容在网关侧整段失真。
function assistantMeta(session, modelRef) {
  const ref = modelRef && typeof modelRef.id === 'string' && modelRef.id ? modelRef : null;
  return {
    agent: String(session?.meta?.agent ?? '').trim() || 'build',
    model: ref
      ? { ...ref }
      : { id: String(session?.model ?? '').trim() || 'unknown', providerID: 'opencode' },
  };
}

function toolInput(input) {
  if (input == null) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  return { value: input };
}

function toolContent(output) {
  // ToolStateCompleted.content 是 NonEmptyArray
  return [{ type: 'text', text: outputText(output) ?? '' }];
}

// ---- user.files[] 必须是宿主 Prompt.FileAttachment（packages/schema/src/prompt.ts）----
// {data: Base64, mime: string, source: {type:'inline'} | {type:'uri', uri:string}}。
// 历史导入写的是 {url, type:'file'}，宿主解码整条 user 消息时直接抛错 →
// GET .../message 500、会话打不开。data 允许空串（Base64 正则接受），所以远端 URL /
// 读不到的大文件用 data:'' + 非媒体 mime + source.uri 兜底：消息可解码，也不会被当成空图片重放。
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 宿主 MAX_ATTACHMENT_BYTES
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.json': 'application/json', '.md': 'text/markdown', '.zip': 'application/zip',
};

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function localFilePath(ref, cwd) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  // Windows 绝对路径（C:\… / C:/…）也带 `C:` 前缀，必须先按绝对路径认，
  // 否则会被下面的 scheme 判据误当成远端 URL。
  if (path.isAbsolute(raw)) return raw;
  // http(s) / data: / 其它 scheme 一律当远端引用，不试图读本地文件
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  return cwd ? path.resolve(String(cwd), raw) : null;
}

function fileUriOf(file) {
  try {
    return pathToFileURL(path.resolve(file)).toString();
  } catch {
    return null;
  }
}

function fileAttachmentOf(ref, cwd) {
  const raw = String(ref ?? '').trim();
  // URL 的 query（OSS 签名参数）不是文件名，剥掉再取 basename
  const withoutQuery = raw.split(/[?#]/, 1)[0];
  const name = path.basename(withoutQuery.replace(/[\\/]+$/, '')) || 'attachment';
  const file = localFilePath(raw, cwd);
  let data = '';
  let mime = 'application/octet-stream';
  let source = { type: 'uri', uri: fileUriOf(file) ?? raw ?? 'attachment' };
  if (file) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_ATTACHMENT_BYTES) {
        data = fs.readFileSync(file).toString('base64');
        mime = mimeOf(file);
        source = /^image\//.test(mime) ? { type: 'inline' } : { type: 'uri', uri: fileUriOf(file) ?? source.uri };
      }
    } catch {
      /* 文件消失/无权限：保留 uri 引用，至少消息能解码 */
    }
  }
  return { data, mime, source, name };
}

function isValidFileAttachment(f) {
  return isPlainObject(f) && typeof f.data === 'string' && typeof f.mime === 'string' &&
    isPlainObject(f.source) &&
    (f.source.type === 'inline' || (f.source.type === 'uri' && typeof f.source.uri === 'string'));
}

function attachmentRefOf(f) {
  if (typeof f === 'string') return f;
  if (!isPlainObject(f)) return '';
  return f.url ?? f.path ?? f.uri ?? f.source?.uri ?? f.name ?? '';
}

// 上游 FinishReason（packages/schema/src/llm.ts）：stop | length | tool-calls |
// content-filter | error | unknown。
//
// 宿主靠 finish 判断「这条回复是不是被中断过」：上游把 `finish === undefined`
// 一律当成「被 Esc/崩溃/失败截断的流」，于是末尾内容块不重放、尾部 reasoning 被丢弃
// （packages/core/src/session/runner/to-llm-message.ts 的 cut 判定）。
// 导入的是**已经跑完**的历史轮次，必须把这个字段写上，否则续写时历史会被当成残缺流。
// 取值口径照真机原生行：回复以工具调用收尾 → tool-calls；以文本收尾 → stop。
function finishOf(content) {
  const last = Array.isArray(content) ? content.at(-1) : null;
  return last && last.type === 'tool' ? 'tool-calls' : 'stop';
}

// reasoning 部件的 provider 原生包裹。上游 sameModel=true 时把 item.native 作为
// providerMetadata 发成 reasoning + reasoning_details（to-llm-message.ts 的 reasoning 分支）；
// 缺了它，即便 providerID 改对，providerMetadata(key, undefined) 仍返回 undefined，
// reasoning 照样降级成被 Zen 网关丢弃的 reasoning_content。文本是源侧真实 reasoning，
// 这里只是补回宿主 canonical 的包裹格式（format 未知，与真机原生行同值 'unknown'）。
function reasoningNative(text) {
  return { reasoningField: 'reasoning', reasoningDetails: [{ type: 'reasoning.text', text, format: 'unknown', index: 0 }] };
}

//  imported assistant 行与原生行同形的统计/收尾字段（宿主 schema 不强制，但原生行都有）。
//  tokens 取零：源侧没留下计数，零是诚实的「未知」，宿主续写时自行重算。
function assistantStats(finish) {
  return { rawFinish: finish, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
}

// 一轮 turn → session_message 事件
function turnToEvents(turn, session, modelRef) {
  const events = [];
  // 一轮的用户文本/附件全部收进轮首的一条 user 事件：读侧「一条 user 消息 = 一轮」，
  // 用户文本与 reasoning/工具在同一轮里交错时逐段发出会把一轮拆成多轮
  const userMsgs = (turn.items ?? []).filter((it) => it.kind === 'message' && it.role === 'user');
  const userFiles = (turn.items ?? []).filter((it) => it.kind === 'attachment' && it.ref).map((it) => fileAttachmentOf(it.ref, session.cwd));
  const firstUserTs = Number((turn.items ?? []).find((it) => it.ts)?.ts) || session.updatedAt || session.createdAt;
  // 宿主注入的压缩摘要落成**原生 compaction 行**：宿主把最新一条 completed 摘要当历史边界，
  // 只读它之后的消息（上游 history.ts latestCompaction / messageEntries），上下文估算随之变小。
  // 写成普通 user 消息的话，超大导入会话续写时会被整体压平成一条超模型上下文的请求（400003）。
  // 摘要正文一个字不丢，只是不再冒充用户提问。
  //
  // 归一化的两条来源（统一成裸正文存 data.summary）：
  //   ① 读侧新口径：message.compact===true，text 已是剥壳裸正文 —— 原样取；
  //   ② 兼容回退：旧 reader / 其它源把摘要带标签塞在 text 里（`compactionInjectionKind` 命中），剥壳取。
  // 每段要么带 compact 位、要么是带标签摘要、要么是「请基于摘要继续」无标签提示 → 整轮都是压缩注入。
  // 混排真实用户文本 / 带附件 / 剥壳后为空 → 仍走普通 user 行：空摘要会被读侧跳过，写出去就丢一轮。
  const isCompactSegment = (it) => it?.compact === true || compactionInjectionKind(it?.text) !== null;
  const allCompaction = userMsgs.length > 0 && userMsgs.every(isCompactSegment);
  const summaryText = userMsgs.map((it) => compactionSummaryText(it.text)).join('\n\n');
  if (allCompaction && !userFiles.length && summaryText.trim()) {
    events.push({
      type: 'compaction',
      ts: firstUserTs,
      // 判别器来自行的 type 列（上游 rowInput 注入），data 内不放 type；键集是原生 compaction 行的子集
      data: {
        time: { created: firstUserTs },
        status: 'completed',
        reason: 'auto',
        summary: summaryText,
        ...(modelRef ? { model: modelRef } : {}),
      },
    });
  } else if (userMsgs.length || userFiles.length) {
    events.push({ type: 'user', ts: firstUserTs, data: { time: { created: firstUserTs }, text: userMsgs.map((it) => it.text).join('\n\n'), files: userFiles, agents: [] } });
  }

  let content = null;
  let contentTs = 0;
  const flushAssistant = () => {
    if (content && content.length) {
      const finish = finishOf(content);
      events.push({
        type: 'assistant',
        ts: contentTs,
        data: {
          time: { created: contentTs, streamed: contentTs, completed: contentTs },
          ...assistantMeta(session, modelRef),
          content,
          finish,
          ...assistantStats(finish),
        },
      });
    }
    content = null;
  };
  const pushContent = (c, ts) => {
    if (!content) {
      content = [];
      contentTs = ts;
    }
    content.push(c);
  };
  const toolStates = new Map();

  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    // 用户文本与附件已在轮首的 user 事件里落位（v2 的助手内容只允许 text/reasoning/tool），
    // 这里只处理助手侧
    if ((it.kind === 'message' && it.role === 'user') || it.kind === 'attachment') continue;
    switch (it.kind) {
      case 'message':
        if (it.text) pushContent({ type: 'text', text: it.text }, ts);
        break;
      case 'reasoning':
        if (it.text) pushContent({ type: 'reasoning', text: it.text, native: reasoningNative(it.text), time: { created: ts, completed: ts } }, ts);
        break;
      case 'tool_call': {
        const callId = it.callId || newNodeId();
        const c = {
          type: 'tool',
          id: callId,
          name: it.name || 'tool',
          // executed=false：工具是源侧本地跑出来的（结果已固化在 state.content），
          // 不是 provider 侧托管的内建工具。真机原生行也是 false。
          executed: false,
          state: { status: 'completed', input: toolInput(it.input), content: toolContent(null), ...(it.input == null ? { [TOOL_NULL_INPUT]: true } : {}) },
          // ran：宿主靠「created 或 ran 有值」判定这个工具真的跑过
          // （上游 to-llm-message.ts 的 ranTool）。源侧只有条目级时间戳，取同一值。
          time: { created: ts, ran: ts },
        };
        pushContent(c, ts);
        toolStates.set(callId, c);
        break;
      }
      case 'tool_result': {
        const c = it.callId ? toolStates.get(it.callId) : null;
        if (c) {
          c.state.status = 'completed';
          c.state.content = toolContent(it.output);
          c.time.completed = ts;
        } else {
          pushContent(
            {
              type: 'tool',
              id: it.callId || newNodeId(),
              name: it.name || 'tool',
              executed: false,
              state: { status: 'completed', input: {}, content: toolContent(it.output), [TOOL_RESULT_ONLY]: true },
              time: { created: ts, ran: ts, completed: ts },
            },
            ts,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  flushAssistant();
  return events;
}

/**
 * 复刻 opencode 的 Project.resolve（源码 packages/core/src/project.ts）：
 *   - 目录在 git 仓库内：优先 `sha1('git-remote:' + 归一化 remote url)`，
 *     否则 `<gitCommonDir>/opencode` 文件内容，否则首个根提交哈希；
 *     三者都没有（如刚 `git init`、没有 remote 也没有提交）→ `global`。
 *   - 否则：`sha1('directory:' + realpath)`
 * 项目行必须真实存在，UI 的会话列表按 project_id 过滤
 * （`opencode session list` = location.get(cwd).project.id + parentID:null）。
 * 非 git 目录的 ID 对路径大小写敏感（opencode 的 fs.resolve 只做 path.resolve
 * + realpath，不会纠正大小写），所以这里统一用真实文件系统大小写。
 */
function windowsPath(input) {
  if (process.platform !== 'win32') return String(input);
  return String(input)
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
}

function toNativePath(forward) {
  return process.platform === 'win32' ? String(forward).replace(/\//g, '\\') : String(forward);
}

function toForwardPath(input) {
  return String(input).replace(/\\/g, '/');
}

// opencode 的 fs.resolve 返回平台原生路径（Windows 上反斜杠），
// 非 git 项目的 ID 直接 sha1('directory:' + 这个原生路径)，对大小写敏感。
// 目录已被删除（WorkBuddy 沙箱等）时保留 resolve 结果，仅把盘符统一成大写。
// 复刻 opencode 的 FSUtil.resolve：path.resolve(windowsPath(input)) + realpath
// （必须用 native realpath：非 native 版本保留输入大小写，会让目录哈希与
// opencode 的 Hash.fast(`directory:${realpath}`) 不一致 → 会话从列表消失）
export function canonicalNativePath(input) {
  const raw = String(input ?? '').trim() || process.cwd();
  let abs;
  try {
    abs = path.resolve(toNativePath(windowsPath(raw)));
  } catch {
    abs = raw;
  }
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    // 目录不存在时 opencode 用 path.resolve 原样结果（不修正盘符大小写）
    return abs;
  }
}

// 入库形态：opencode 的 absoluteColumn 在 Windows 上把反斜杠换成正斜杠。
export function canonicalDirectory(input) {
  return toForwardPath(canonicalNativePath(input));
}

// session_v2.path = 会话目录相对项目根的子路径（项目根为 ''），会话列表按它过滤。
function subpathOf(worktree, directory) {
  const rel = path.posix.relative(toForwardPath(worktree), toForwardPath(directory));
  if (!rel || rel === '.') return '';
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return '';
  return rel;
}

function normalizeRemoteUrl(input) {
  const value = String(input ?? '').trim();
  if (!value) return null;
  let host = null;
  let name = null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' && parsed.hostname) {
      host = parsed.hostname;
      name = parsed.pathname;
    }
  } catch {
    /* 非 URL 形式 */
  }
  if (!host) {
    const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/);
    if (scp) {
      host = scp[2];
      name = scp[3];
    }
  }
  if (!host) return null;
  const pathname = String(name ?? '')
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
  if (!host || !pathname) return null;
  return `${host.toLowerCase()}/${pathname}`;
}

function sha1Hex(input) {
  return createHash('sha1').update(input).digest('hex');
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

function runHg(cwd, args) {
  try {
    return execFileSync('hg', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: { ...process.env, HGPLAIN: '1' } })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

function readMarkerFile(dir) {
  try {
    const value = fs.readFileSync(path.join(dir, 'opencode'), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

// 只在真正能跑 git 的仓库上认 .git（空 .git 目录不是仓库，opencode 会退化到目录哈希）
function isGitRepo(worktree) {
  return runGit(worktree, ['rev-parse', '--git-dir']) != null;
}

function discoverNative(directory) {
  let cur = toNativePath(directory);
  while (true) {
    const dotGit = path.join(cur, '.git');
    const dotHg = path.join(cur, '.hg');
    if (fs.existsSync(dotGit) && isGitRepo(cur)) return { kind: 'git', worktree: cur };
    if (fs.existsSync(dotHg)) return { kind: 'hg', worktree: cur, store: dotHg };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// 目录缓存，避免同一 cwd 反复跑 git
const projectCache = new Map();

export function resolveProjectID(cwd) {
  const nativeDirectory = canonicalNativePath(cwd);
  const directory = toForwardPath(nativeDirectory);
  if (projectCache.has(directory)) return projectCache.get(directory);

  let id = null;
  let worktree = directory;
  try {
    const native = discoverNative(directory);
    if (native?.kind === 'git') {
      worktree = canonicalDirectory(native.worktree);
      const origin = runGit(native.worktree, ['remote', 'get-url', 'origin']);
      const normalized = normalizeRemoteUrl(origin);
      if (normalized) {
        id = sha1Hex(`git-remote:${normalized}`);
      } else {
        // opencode 的 cached()：读 <gitCommonDir>/opencode
        const common = runGit(native.worktree, ['rev-parse', '--git-common-dir']);
        const commonDir = common ? path.resolve(native.worktree, common) : path.join(native.worktree, '.git');
        id = readMarkerFile(commonDir);
        if (!id) {
          const roots = (runGit(native.worktree, ['rev-list', '--max-parents=0', 'HEAD']) ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
          id = roots[0] ?? null;
        }
        // 没 remote、没 marker、没根提交 → opencode 用 global 项目
        if (!id) id = GLOBAL_PROJECT;
      }
    } else if (native?.kind === 'hg') {
      worktree = canonicalDirectory(native.worktree);
      id = readMarkerFile(native.store);
      if (!id) {
        const roots = (runHg(native.worktree, ['log', '-r', 'roots(all())', '-T', '{node}\n']) ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .sort();
        id = roots[0] ?? GLOBAL_PROJECT;
      }
    } else {
      id = sha1Hex(`directory:${nativeDirectory}`);
    }
  } catch {
    id = sha1Hex(`directory:${nativeDirectory}`);
  }

  const result = { id, worktree, directory, subpath: subpathOf(worktree, directory) };
  projectCache.set(directory, result);
  return result;
}

// project 行 upsert：opencode 的 project 表是 UI 会话列表的归属来源。
// 插入走 writers/project.mjs 的共用实现（按实际列集）；但**行形状按本家契约**：
// opencode 的 `global` 是「没有 remote / marker / 根提交的 git 仓库」，实测行是 (worktree=<repo>, vcs=git)，
// 不是 MiMo 那种「无项目桶」的 (global, "/") —— 这里绝不能套 ensureGlobalProject。
function ensureProjectRow(db, projectID, worktree, now) {
  const existing = db.prepare('SELECT id FROM project WHERE id = ?').get(projectID);
  if (existing) {
    updateRowFiltered(
      db,
      'project',
      [
        ['time_updated', now],
        ['time_active', now],
      ],
      { id: projectID },
      { ifEmpty: 'skip' },
    );
    return false;
  }
  insertProjectRow(db, projectID, worktree, { timeActive: now });
  return true;
}

function isImportedRow(row) {
  if (row?.version === 'session-sync/1') return true;
  const meta = safeJson(row?.metadata, null);
  return !!meta && !!meta['session-sync'];
}

// ---------------------------------------------------------------------------
// event_sequence：宿主分配消息 seq 的计数器
//
// 宿主写新消息前先读这一行（packages/core/src/bus.ts 的 commitDurableEvent）：
//   latest = row?.seq ?? -1  →  seq = latest + 1
// 我们导入的会话把 seq 0..N 占满了，却**没有这一行** → 宿主以为从 0 开始，
// 分配出 0 → 撞上 session_message 的唯一索引 (session_id, seq)
// → UNIQUE constraint failed → 该会话再也续写不了（上游 issue #56528 同族）。
//
// 修法对齐上游 fork 路径（packages/core/src/session/projector.ts 的 projectFork
// 末尾调 Bus.reserveSequence(db, sessionID, copiedSeq)）：把计数器抬到已占用 seq
// 之上。语义是 max(现值, 目标值)——只进不退，绝不把宿主已推进的计数器拉低
// （宿主有些事件不投影成 session_message 行，计数器本就可以高于消息最大 seq）。
// ---------------------------------------------------------------------------

/** 该会话已占用的最大消息 seq（没有消息时 -1） */
function maxMessageSeq(db, sessionId) {
  try {
    const row = db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM session_message WHERE session_id = ?')
      .get(String(sessionId));
    return Number(row?.m ?? -1);
  } catch {
    return -1;
  }
}

/** 宿主事件计数器当前值（没有这一行时 -1，与上游 latest 的缺省一致） */
function currentEventSequence(db, sessionId) {
  if (!tableExists(db, 'event_sequence')) return -1;
  try {
    const row = db.prepare('SELECT seq FROM event_sequence WHERE aggregate_id = ?').get(String(sessionId));
    return Number(row?.seq ?? -1);
  } catch {
    return -1;
  }
}

/**
 * 把 event_sequence 计数器抬到 seq（只进不退）。
 *
 * 形状对齐上游 Bus.reserveSequence：`INSERT ... ON CONFLICT(aggregate_id) DO UPDATE
 * SET seq = max(现值, 目标值)`。这里拆成「读 → 有则改 / 无则插」两步走
 * writers/base.mjs 的行写入出口（insertRowFiltered / updateRowFiltered），
 * 调用方保证在 BEGIN IMMEDIATE 事务内，读改之间不会被别人插进来。
 *
 * @returns {{ok:boolean, changed?:boolean, seq?:number, skipped?:string, error?:string}}
 */
function reserveEventSequence(db, sessionId, seq) {
  const id = String(sessionId ?? '');
  if (!id) return { ok: false, skipped: 'id-absent' };
  if (!tableExists(db, 'event_sequence')) return { ok: false, skipped: 'table-absent' };
  const cols = tableColumns(db, 'event_sequence');
  if (!cols.includes('aggregate_id') || !cols.includes('seq')) return { ok: false, skipped: 'columns-absent' };
  const target = Number(seq);
  if (!Number.isFinite(target) || target < 0) return { ok: false, skipped: 'seq-invalid' };
  const before = currentEventSequence(db, id);
  if (before >= target) return { ok: true, changed: false, seq: before };
  if (before >= 0) {
    const upd = updateRowFiltered(db, 'event_sequence', [['seq', target]], { aggregate_id: id });
    if (!upd.ok) return { ok: false, error: upd.error ?? 'event_sequence-update-failed' };
  } else {
    const ins = insertRowFiltered(db, 'event_sequence', [['aggregate_id', id], ['seq', target]], { ifEmpty: 'skip' });
    if (!ins.ok || !ins.inserted) return { ok: false, error: ins.error ?? 'event_sequence-insert-failed' };
  }
  const after = currentEventSequence(db, id);
  return { ok: true, changed: after > before, seq: after };
}

/**
 * 找出「event_sequence 计数器落后于该会话已占用消息 seq」的导入会话。
 *
 * 这些会话一旦被宿主继续写，宿主就会分配出与导入行重复的 seq → 500。
 * 按改名后的 id 预判（aggregate id 就是会话 id，改名后才是宿主认的那个）。
 */
function collectStaleSeqSessions(db, imported) {
  if (!tableExists(db, 'event_sequence')) return [];
  const out = [];
  for (const row of imported) {
    const oldId = String(row.id);
    const newId = isNativeOpencodeId(oldId) ? oldId : nativeIdForImportedRow(row);
    const maxSeq = maxMessageSeq(db, oldId);
    if (maxSeq < 0) continue;
    if (currentEventSequence(db, newId) < maxSeq) out.push({ oldId, newId, maxSeq });
  }
  return out;
}

// session_v2.model 必须是完整的 Model.Ref（id + providerID）；旧版只写
// {id} 会让 /api/session 编码失败，等价于整个列表 500。
function normalizeModelJson(raw) {
  const model = safeJson(raw, null);
  if (model && typeof model.id === 'string' && model.id && typeof model.providerID === 'string' && model.providerID) {
    return typeof raw === 'string' ? raw : JSON.stringify(model);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 宿主同形：session 版本与 Model.Ref
//
// 导入行要跟宿主自己写出的行同形，否则宿主把这段历史当「外来物」：
//   - session_v2.version：宿主原生行写的是应用版本（如 2.1.4）。我们原来写
//     'session-sync/1'，宿主认不出的外来值。宿主本身不按它分支（读侧判定
//     「这是不是我们写的行」靠它 + metadata 标记），但同形才谈得上原生。
//   - assistant.model：必须写真实 provider（opencode）+ variant。占位
//     provider 会让上游 sameProvider/sameModel 判 false（见 assistantMeta）。
// ---------------------------------------------------------------------------

/** 宿主当前应用版本：取库里原生行出现最多的那个 version */
function hostVersion(db) {
  try {
    const row = db
      .prepare(
        "SELECT version, COUNT(*) n FROM session_v2 WHERE version IS NOT NULL AND version <> 'session-sync/1' GROUP BY version ORDER BY n DESC LIMIT 1",
      )
      .get();
    return row?.version ? String(row.version) : null;
  } catch {
    return null;
  }
}

function modelRefOf(obj) {
  const ref = { id: String(obj.id), providerID: String(obj.providerID) };
  if (typeof obj.variant === 'string' && obj.variant) ref.variant = obj.variant;
  return ref;
}

/**
 * assistant 行 / 会话行要用的 Model.Ref。
 *
 * 取值顺序：
 *   1) 会话自己那一行的 model（宿主选定模型后写进去的就是真实 provider + variant）
 *   2) 原生行里 id 相同的那一行
 *   3) 库里最近更新的原生行
 * 都取不到就只给 provider（opencode 是宿主内置的 Zen provider）。
 *
 * 刻意不把源侧模型名塞进来：源侧模型多半不在宿主的模型表里，写进去会话
 * 就带了一个宿主解析不了的 model。
 */
function hostModelRef(db, sessionModel) {
  const own = safeJson(normalizeModelJson(sessionModel), null);
  if (own && typeof own.id === 'string' && own.id && typeof own.providerID === 'string' && own.providerID) {
    return modelRefOf(own);
  }
  let rows = [];
  try {
    rows = db.prepare("SELECT model, time_updated FROM session_v2 WHERE model IS NOT NULL AND model <> ''").all();
  } catch {
    rows = [];
  }
  const parsed = rows
    .map((r) => ({ m: safeJson(r.model, null), t: Number(r.time_updated ?? 0) }))
    .filter((x) => x.m && typeof x.m.id === 'string' && x.m.id && typeof x.m.providerID === 'string' && x.m.providerID);
  if (!parsed.length) return null;
  const newest = parsed.slice().sort((a, b) => b.t - a.t)[0];
  return modelRefOf(newest.m);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function completeModelRef(model) {
  if (isPlainObject(model) && typeof model.id === 'string' && model.id && typeof model.providerID === 'string' && model.providerID) {
    return model;
  }
  const id = isPlainObject(model) && typeof model.id === 'string' && model.id ? model.id : 'unknown';
  return { id, providerID: 'session-sync' };
}

function isValidToolContentItem(c) {
  if (!isPlainObject(c)) return false;
  if (c.type === 'text') return typeof c.text === 'string';
  if (c.type === 'file') return typeof c.uri === 'string' && typeof c.mime === 'string';
  return false;
}

// 历史导入的 session_message 也有 schema 违规：assistant 缺 agent/model（v2 必填）、
// tool 部件缺 time.created。任一处不合 schema → 整条消息解码失败 → 会话打不开、
// session export 500（server 日志 "failed to decode session message"）。
// 只修复我们自己写出的 user/assistant 行；返回 null = 无需改动。
function repairMessageData(type, data, fallbackTime = 0, modelRef = null, cwd = null) {
  if (!isPlainObject(data)) return null;
  let changed = false;
  const tick = Number.isFinite(data.time?.created) ? data.time.created : fallbackTime;

  if (type === 'assistant') {
    if (typeof data.agent !== 'string' || !data.agent) {
      data.agent = 'build';
      changed = true;
    }
    const model = completeModelRef(data.model);
    if (model !== data.model) {
      data.model = model;
      changed = true;
    }
    // 占位 provider（早期导入写的是 'session-sync'）→ 换成宿主真实 provider。
    // 上游 sameProvider/sameModel 判 false 会让 providerMetadata 被丢，
    // reasoning 从 reasoning + reasoning_details 退化成会被网关丢弃的 reasoning_content。
    if (isPlainObject(data.model) && data.model.providerID === 'session-sync') {
      data.model = modelRef
        ? { ...modelRef }
        : { id: String(data.model.id ?? '').trim() || 'unknown', providerID: 'opencode' };
      changed = true;
    }
    // 没有 time.completed 的 assistant 会被宿主当成「仍在生成」：
    // export/fork 过滤掉它，projector 会把它当作活动投影去续写。
    // 导入的都是历史消息，统一按已结束处理。
    if (!Number.isFinite(data.time?.completed)) {
      data.time = { ...(isPlainObject(data.time) ? data.time : {}), created: tick, completed: tick };
      changed = true;
    }
    const kept = [];
    for (const part of Array.isArray(data.content) ? data.content : []) {
      if (!isPlainObject(part)) {
        changed = true;
        continue;
      }
      if (part.type === 'text' || part.type === 'reasoning') {
        if (typeof part.text !== 'string') {
          changed = true;
          continue;
        }
        if (part.type === 'reasoning') {
          // 缺 native 包裹 → 续写时 reasoning 降级成被网关丢弃的 reasoning_content（见 reasoningNative）
          if (part.native === undefined) {
            part.native = reasoningNative(part.text);
            changed = true;
          }
          if (!isPlainObject(part.time)) {
            part.time = { created: tick, completed: Number.isFinite(data.time?.completed) ? data.time.completed : tick };
            changed = true;
          }
        }
        kept.push(part);
        continue;
      }
      if (part.type === 'tool') {
        if (typeof part.id !== 'string' || !part.id || typeof part.name !== 'string' || !part.name) {
          changed = true;
          continue;
        }
        if (!Number.isFinite(part.time?.created)) {
          part.time = { ...(isPlainObject(part.time) ? part.time : {}), created: tick };
          changed = true;
        }
        // executed=false：源侧本地执行的工具，不是 provider 侧托管的内建工具（真机原生行同值）
        if (part.executed === undefined || part.executed === null) {
          part.executed = false;
          changed = true;
        }
        // ran：宿主靠「created 或 ran 有值」判定工具真的跑过（上游 ranTool）
        if (!Number.isFinite(part.time?.ran)) {
          const ran = Number.isFinite(part.time?.created) ? part.time.created : tick;
          part.time = { ...(isPlainObject(part.time) ? part.time : {}), ran };
          changed = true;
        }
        const state = isPlainObject(part.state) ? part.state : {};
        const content = (Array.isArray(state.content) ? state.content : []).filter(isValidToolContentItem);
        if (!content.length) content.push({ type: 'text', text: '' });
        const next = { status: 'completed', input: isPlainObject(state.input) ? state.input : {}, content };
        if (isPlainObject(state.metadata)) next.metadata = state.metadata;
        if (JSON.stringify(next) !== JSON.stringify(state)) changed = true;
        part.state = next;
        kept.push(part);
        continue;
      }
      changed = true;
    }
    if (!Array.isArray(data.content) || kept.length !== data.content.length) changed = true;
    data.content = kept;
    // finish 缺失 → 上游判为「被中断的流」（cut = finish === undefined），
    // 续写时末尾内容块不重放、尾部 reasoning 被丢弃。导入的都是跑完的历史轮次，
    // 按末块类型补齐：工具收尾 → tool-calls，文本收尾 → stop（与真机原生行同口径）。
    if (data.finish === undefined || data.finish === null) {
      data.finish = finishOf(kept);
      changed = true;
    }
    // 与原生行同形的收尾/统计字段（缺则补，已有不动 → 幂等）
    const stats = assistantStats(data.finish);
    for (const k of ['rawFinish', 'cost', 'tokens']) {
      if (data[k] === undefined) {
        data[k] = stats[k];
        changed = true;
      }
    }
    if (isPlainObject(data.time) && data.time.streamed === undefined) {
      data.time.streamed = Number.isFinite(data.time.completed) ? data.time.completed : tick;
      changed = true;
    }
  } else if (type === 'user') {
    if (typeof data.text !== 'string') {
      data.text = data.text == null ? '' : String(data.text);
      changed = true;
    }
    for (const field of ['files', 'agents', 'skills']) {
      if (data[field] !== undefined && !Array.isArray(data[field])) {
        delete data[field];
        changed = true;
      }
    }
    // 历史违规的 {url,type:'file'} 会让整条 user 消息解码失败（会话打开 500）。
    // 合法附件原样保留；非法的按与写侧相同的口径转成 FileAttachment。
    if (Array.isArray(data.files)) {
      const files = data.files.map((f) => (isValidFileAttachment(f) ? f : fileAttachmentOf(attachmentRefOf(f), cwd)));
      if (JSON.stringify(files) !== JSON.stringify(data.files)) {
        data.files = files;
        changed = true;
      }
    }
  } else {
    return null;
  }

  return changed ? data : null;
}

// 扫描导入会话的消息行，收集需要改写的 JSON（读阶段不写库）
function collectMessageFixes(db, importedRows, modelRefs = new Map()) {
  const fixes = [];
  const stmt = db.prepare('SELECT id, type, data, time_created FROM session_message WHERE session_id = ?');
  for (const row of importedRows) {
    const ref = modelRefs.get(String(row.id)) ?? null;
    for (const m of stmt.all(row.id)) {
      let parsed;
      try {
        parsed = JSON.parse(m.data);
      } catch {
        continue;
      }
      const fixed = repairMessageData(m.type, parsed, Number(m.time_created) || 0, ref, row.directory ? String(row.directory) : null);
      if (fixed) fixes.push({ id: String(m.id), data: JSON.stringify(fixed) });
    }
  }
  return fixes;
}

// 自愈历史导入：裸 uuid → ses_ 前缀、悬空/错误 project_id、非法 model、
// 非规范 directory（反斜杠/盘符小写）、缺失 path(subpath)、消息级缺字段。
// 这些字段任意一个不对，opencode 的 /sessions 列表就会整页 500 或漏掉该会话；
// 消息级违规会让会话打不开、导出 500。
// 返回修复计数，供 import 的 skip/写入路径复用。
/**
 * 历史导入行的目录重算：目录命中宿主自管根（早期版本把 WorkBuddy/Codex 的沙箱目录原样写了进来）
 * → 换成 OpenCode 自己的非项目桶。判据是纯状态的，搬完就不再命中 → 幂等。
 * 只作用于我们写过的行（调用方已用 isImportedRow 过滤）。
 */
function repairDirectory(ctx, row) {
  const raw = String(row.directory ?? '');
  if (!raw.trim()) return canonicalDirectory(raw);
  if (classifySource({ cwd: raw }, ctx).scope !== 'none') return canonicalDirectory(raw);
  const place = resolvePlacement({ cwd: raw, scope: 'none', createdAt: row.time_created, id: row.id }, 'opencode', ctx, { targetId: row.id });
  return canonicalDirectory(place.directory || raw);
}

// 存量导入行（裸 uuid / ses_<32hex>）→ 网关接受的原生确定性 ID（口径见 opencode-id.importedNativeId）
function nativeIdForImportedRow(row) {
  return importedNativeId(row);
}

function repairImportedSessions(ctx) {
  const file = dbFile(ctx);
  const empty = { renamed: 0, projectFixed: 0, modelFixed: 0, dirFixed: 0, pathFixed: 0, msgFixed: 0, seqFixed: 0, versionFixed: 0, warnings: [] };
  if (!file || !isFile(file)) return { ok: true, skipped: 'db-absent', ...empty };
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 8000');
    if (!tableExists(db, 'session_v2') || !tableExists(db, 'project')) {
      return { ok: true, skipped: 'schema-absent', ...empty };
    }
    const imported = db.prepare('SELECT * FROM session_v2').all().filter(isImportedRow);
    if (!imported.length) return { ok: true, ...empty };

    // 消息级修复要用的真实 Model.Ref（含 variant）：按会话取宿主模型，缺省回退库里最新原生行。
    const modelRefs = new Map(imported.map((r) => [String(r.id), hostModelRef(db, r.model)]));
    const hostVer = hostVersion(db);
    const hasProv = (row) => {
      const m = safeJson(row.metadata, null);
      return !!(m && m['session-sync']);
    };

    const plan = [];
    for (const row of imported) {
      // 网关只认原生 Identifier 形态；ses_<32hex> 列表可见但续写 429，一并迁移
      const newId = isNativeOpencodeId(row.id) ? String(row.id) : nativeIdForImportedRow(row);
      if (!newId) continue;
      const directory = repairDirectory(ctx, row);
      const project = resolveProjectID(directory);
      const model = normalizeModelJson(row.model);
      const path = project.subpath;
      // version 同形：只对带 provenance 的行对齐到宿主版本（识别改靠 metadata 标记，仍认得出）；
      // 无 metadata 的行（appendToNative）version 是唯一识别标记，必须保留 session-sync/1。
      const version = hasProv(row) ? hostVer ?? row.version : row.version;
      if (
        newId !== row.id ||
        project.id !== row.project_id ||
        model !== row.model ||
        directory !== row.directory ||
        path !== row.path ||
        version !== row.version
      ) {
        plan.push({ row, newId, project, model, directory, path, version });
      }
    }
    const msgFixes = tableExists(db, 'session_message') ? collectMessageFixes(db, imported, modelRefs) : [];
    // seq 计数器落后于该会话已占用的消息 seq → 宿主再写消息时分配出重复 seq →
    // UNIQUE(session_id, seq) → 会话再也续写不了。
    // 这项与其它字段无关：字段全都对的会话也必须登记，所以要参与早退判定。
    const seqStale = collectStaleSeqSessions(db, imported);
    if (!plan.length && !msgFixes.length && !seqStale.length) return { ok: true, ...empty };

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    const warnings = [];
    let renamed = 0;
    let projectFixed = 0;
    let modelFixed = 0;
    let dirFixed = 0;
    let pathFixed = 0;
    let msgFixed = 0;
    let seqFixed = 0;
    let versionFixed = 0;
    // 改名映射：旧 id → 当前 id（撞 id 改名失败时保持旧 id）
    const idAfter = new Map(imported.map((r) => [String(r.id), String(r.id)]));
    const now = Date.now();
    for (const item of plan) {
      const { row, newId, project, model, directory, path, version } = item;
      if (newId !== row.id) {
        const clash = db.prepare('SELECT id FROM session_v2 WHERE id = ?').get(newId);
        if (clash) {
          warnings.push(`id-collision:${row.id}->${newId}`);
          continue;
        }
        db.prepare('UPDATE session_message SET session_id = ? WHERE session_id = ?').run(newId, row.id);
        db.prepare('UPDATE session_v2 SET id = ? WHERE id = ?').run(newId, row.id);
        db.prepare('UPDATE session_v2 SET parent_id = ? WHERE parent_id = ?').run(newId, row.id);
        db.prepare('UPDATE session_v2 SET fork_session_id = ? WHERE fork_session_id = ?').run(newId, row.id);
        if (tableExists(db, 'event_sequence')) {
          db.prepare('UPDATE event_sequence SET aggregate_id = ? WHERE aggregate_id = ?').run(newId, row.id);
        }
        idAfter.set(String(row.id), newId);
        renamed++;
      }
      ensureProjectRow(db, project.id, project.worktree, now);
      if (project.id !== row.project_id) {
        db.prepare('UPDATE session_v2 SET project_id = ? WHERE id = ?').run(project.id, newId);
        projectFixed++;
      }
      if (directory !== row.directory) {
        db.prepare('UPDATE session_v2 SET directory = ? WHERE id = ?').run(directory, newId);
        dirFixed++;
      }
      if (path !== row.path) {
        db.prepare('UPDATE session_v2 SET path = ? WHERE id = ?').run(path, newId);
        pathFixed++;
      }
      if (model !== row.model) {
        db.prepare('UPDATE session_v2 SET model = ? WHERE id = ?').run(model, newId);
        modelFixed++;
      }
      if (version !== row.version) {
        db.prepare('UPDATE session_v2 SET version = ? WHERE id = ?').run(version, newId);
        versionFixed++;
      }
    }
    // 消息级修复按消息主键更新（会话 id 重命名不影响 message id）
    const msgUpd = db.prepare('UPDATE session_message SET data = ? WHERE id = ?');
    for (const fix of msgFixes) {
      msgUpd.run(fix.data, fix.id);
      msgFixed++;
    }
    // seq 计数器自愈：宿主按 event_sequence 分配后续消息 seq，
    // 导入的会话没登记过 → 宿主从 0 重新分配 → 撞唯一索引 → 会话再也续写不了。
    // 必须在改名之后做：aggregate id 就是会话 id。
    for (const row of imported) {
      const sid = idAfter.get(String(row.id)) ?? String(row.id);
      const res = reserveEventSequence(db, sid, maxMessageSeq(db, sid));
      if (res.changed) seqFixed++;
      else if (!res.ok && res.error) warnings.push(`seq-reserve-failed:${sid}:${res.error}`);
    }
    db.exec('COMMIT');
    return { ok: true, renamed, projectFixed, modelFixed, dirFixed, pathFixed, msgFixed, seqFixed, versionFixed, warnings };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    return { ok: false, error: `repair-failed: ${err?.message ?? err}`, ...empty };
  } finally {
    db.close();
  }
}

export const opencodeWriter = {
  variant: 'opencode',
  label: 'OpenCode',

  canWrite(ctx) {
    const f = dbFile(ctx);
    return f && isFile(f) ? { ok: true } : { ok: false, reason: 'db-not-found' };
  },

  // 一次性迁移历史导入（旧版本写出的裸 uuid / 错误 project / 非法 model）
  repair(ctx) {
    return repairImportedSessions(ctx);
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时，把新名同步到目标。
   * opencode 的标题住在 session_v2.title 列（列表与 UI 都读它），一个 db 槽就够。
   */
  syncTitle: makeTitleSyncer(() => [
    { kind: 'db-column', db: (c) => dbFile(c), table: 'session_v2', idCol: 'id', col: 'title' },
  ], 'opencode'),

  // skip 分支的自愈：先迁移历史行，再复核当前 target 的 project_id
  ensureIndex(ctx, info) {
    const repair = repairImportedSessions(ctx);
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: true, skipped: 'db-absent', repair };
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      if (!tableExists(db, 'session_v2') || !tableExists(db, 'project')) return { ok: true, skipped: 'schema-absent', repair };
      const row = db.prepare('SELECT project_id, directory, path FROM session_v2 WHERE id = ?').get(String(info.targetId));
      if (!row) return { ok: true, skipped: 'session-absent', repair };
      const directory = canonicalDirectory(info.cwd || row.directory || '');
      const project = resolveProjectID(directory);
      const path = project.subpath;
      if (row.project_id === project.id && row.directory === directory && row.path === path) {
        return { ok: true, unchanged: true, repair };
      }
      db.exec('BEGIN IMMEDIATE');
      ensureProjectRow(db, project.id, project.worktree, Date.now());
      db.prepare('UPDATE session_v2 SET project_id = ?, directory = ?, path = ? WHERE id = ?').run(
        project.id,
        directory,
        path,
        String(info.targetId),
      );
      db.exec('COMMIT');
      return { ok: true, fixed: true, projectID: project.id, repair };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      return { ok: false, error: `index-fix-failed: ${err?.message ?? err}`, repair };
    } finally {
      db.close();
    }
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found' };

    const db = new DatabaseSync(file);
    try {
      try {
        db.exec('PRAGMA busy_timeout = 8000');
      } catch {
        /* ignore */
      }
      if (!tableExists(db, 'session_v2')) return { ok: false, error: 'session_v2-missing' };
      // 宿主可能在运行中写同一库：整段写入放一个 IMMEDIATE 事务里，失败整体回滚
      db.exec('BEGIN IMMEDIATE');

      const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
      const now = Date.now();
      let existing = db.prepare('SELECT id, model FROM session_v2 WHERE id = ?').get(targetId);

      if (existing && mode !== 'append') {
        if (!force) return { ok: false, error: 'target-exists', targetId, warnings };
        db.prepare('DELETE FROM session_message WHERE session_id = ?').run(targetId);
        db.prepare('DELETE FROM session_v2 WHERE id = ?').run(targetId);
        // 整份重建：行已经被删掉，后面的分支必须按「没有行」走，否则只剩消息行成孤儿
        existing = null;
      }

      const directory = canonicalDirectory(session.cwd || '');
      const project = resolveProjectID(directory);
      const subpath = project.subpath;
      ensureProjectRow(db, project.id, project.worktree, now);

      // assistant 行与会话行用同一个 Model.Ref：宿主判 sameProvider/sameModel
      // 用的是「消息里的 model」与「会话当前 model」，两边不一致就丢 providerMetadata。
      const modelRef = hostModelRef(db, existing?.model ?? null);

      if (!existing) {
        const metadata = provenance ? { 'session-sync': provenance } : null;
        // version 与宿主原生行同形（原生行写的是应用版本，如 2.1.4）。
        // 没有 provenance 时保留 'session-sync/1'：那是「这行是我们写的」的
        // 识别标记（metadata 为空时不能丢，否则读侧认不出导入行）。
        const version = provenance ? hostVersion(db) ?? 'session-sync/1' : 'session-sync/1';
        // 按库里实际存在的列裁剪（与 workbuddy 索引 / minimax 同一口径）：
        // 宿主换版本增删列时，硬编码列名会整条 INSERT 失败（行写不进去，宿主列表看不到）。
        const all = [
          ['id', targetId],
          ['project_id', project.id],
          ['parent_id', null],
          ['slug', slugOf(session.title)],
          ['directory', directory],
          ['path', subpath],
          ['title', session.title || 'imported session'],
          ['version', version],
          ['metadata', metadata ? JSON.stringify(metadata) : null],
          ['agent', 'build'],
          // Model.Ref 要带真实 provider（opencode）+ variant：占位 provider 会让
          // 上游 sameProvider/sameModel 判 false，导入历史的 reasoning 被降级丢弃。
          ['model', modelRef ? JSON.stringify(modelRef) : null],
          ['time_created', session.createdAt || now],
          ['time_updated', session.updatedAt || now],
        ];
        const ins = insertRowFiltered(db, 'session_v2', all, { ifEmpty: 'skip' });
        if (!ins.ok || !ins.inserted) return { ok: false, error: 'session_v2-table-absent', targetId, warnings };
      } else {
        // 修复旧版导入写坏的 project_id / directory / path / 非法 model（UI 列表编码要求）
        updateRowFiltered(
          db,
          'session_v2',
          [
            ['project_id', project.id],
            ['directory', directory],
            ['path', subpath],
            // 会话已有合法 model 就别动（用户可能在宿主里切过模型）；缺了才补
            ['model', normalizeModelJson(existing.model) ?? (modelRef ? JSON.stringify(modelRef) : null)],
          ],
          { id: targetId },
        );
      }

      let seq = 0;
      if (mode === 'append') {
        const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM session_message WHERE session_id = ?').get(targetId);
        seq = Number(row?.m ?? -1) + 1;
      } else {
        db.prepare('DELETE FROM session_message WHERE session_id = ?').run(targetId);
      }

      let inserted = 0;
      // 同样按实际存在的列裁剪（session_message 的列集也可能随宿主版本变）
      for (const turn of turns) {
        for (const ev of turnToEvents(turn, session, modelRef)) {
          const all = [
            ['id', `msg_${String(seq).padStart(8, '0')}_${newNodeId().replace(/-/g, '').slice(0, 12)}`],
            ['session_id', targetId],
            ['type', ev.type],
            ['seq', seq++],
            ['time_created', ev.ts],
            ['time_updated', ev.ts],
            ['data', JSON.stringify(ev.data)],
          ];
          // 一列都不剩说明这张表不是我们认识的形状：停止插消息（继续插只会全失败）
          const msgIns = insertRowFiltered(db, 'session_message', all, { ifEmpty: 'skip' });
          if (!msgIns.ok || !msgIns.inserted) break;
          inserted++;
        }
      }
      // 登记 seq 计数器（宿主写新消息时读它来分配 seq）：
      // 导入的消息已经占用了 0..N，不登记的话宿主会从 0 重新分配 →
      // 撞 session_message 的唯一索引 (session_id, seq) → 会话再也续写不了。
      // 计数器只进不退（对齐上游 Bus.reserveSequence）。
      const reserve = reserveEventSequence(db, targetId, maxMessageSeq(db, targetId));
      if (!reserve.ok && reserve.error) throw new Error(reserve.error);
      updateRowFiltered(db, 'session_v2', [['time_updated', Math.max(now, session.updatedAt || 0)]], { id: targetId });
      db.exec('COMMIT');

      // provenance sidecar 兜底（db 内已写 metadata）
      try {
        if (provenance) writeSidecarProvenance(file, provenance);
      } catch {
        /* ignore */
      }
      return { ok: true, targetId, path: file, lines: inserted, mode, warnings };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务可能未开启 */
      }
      return { ok: false, error: `db-write-failed: ${err?.message ?? err}` };
    } finally {
      db.close();
    }
  },
};
