// writers/minimax.mjs — 写 MiniMax Code 的规范历史文件、索引与显示投影
//
// 正文源与物化（本机 app.asar 取证）：
//   - 正文源选择链：messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows → sqliteBlob，
//     文件缺失时回退到 DB 行；
//   - 外部预发布 messages.jsonl 时，当前宿主需要物化 checkpoint 才能直接续写。
// 列表可见性的 6 个硬门（缺一项就完全不可见，出自 repo/drizzle.js + repo/list-predicates.js）：
//   columnar_version=3、agent_name IN ('mavis','main')、archived=0、visibility<>'hidden'、
//   session_kind NOT IN ('peek','cron')、parent_session_id IS NULL。
// 枚举严格（违规即 SQLITE_CONSTRAINT）：runtime ∈ {pi-agent, opencode}、session_type ∈ {root, branch}、
//   status ∈ {idle, started, error, aborted, interrupted}。
// local_runtime_projects 不用我们写：AFTER INSERT 触发器（columnar_version=3 时）自动建行并回填 project_id。
//
// **一行 = 一条消息**（真机原生行口径）：行的 role 就是这条消息自己的角色，
// 同一轮的所有消息共享一个 turn_id。整轮压成一行会让助手正文在宿主里消失，
// 详见 turnToMessageGroups 的注释。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS, configRoot } from '../hosts.mjs';
import { tableExists, tableColumns, safeJson } from '../readers/base.mjs';
import { ensureDir, isFile, cmpPath, canonicalDirPath, sha256hex } from '../util.mjs';
import { writeRootOf, roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { buildProvenance, extractFromJsonObject, readSidecarProvenance, writeSidecarProvenance } from '../provenance.mjs';
import { resolvePlacement } from '../placement.mjs';
import { insertRowFiltered, newNodeId, updateRowFiltered, appendFileAtomic, writeFileAtomic } from './base.mjs';
import { firstExisting } from '../readers/base.mjs';
import { toNativeBlock, toolResultRowOfBlock } from '../pi-agent-blocks.mjs';
import { minimaxReader, planImportedTurnRepair, readPublishedMinimaxTurns } from '../readers/minimax.mjs';
import { makeSession, makeTurn, messageItem, sessionCoreFingerprints } from '../ir.mjs';
import { targetSessionId } from '../identity.mjs';
import { verifyImported } from '../verify.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';
import { compactionInjectionKind, compactionSummaryText } from '../text.mjs';
import { minimaxRevision, planMinimaxHistory, portableSummary, readMinimaxHistory } from '../minimax-history.mjs';
import { hasMinimaxPublication, pendingMinimaxHistory, recoverMinimaxPublications, registerMinimaxMaterialization,
  repairMinimaxMaterialization, stageMinimaxPublication, verifiedMinimaxImportPrefix } from '../minimax-publication.mjs';

function dbFile(ctx) {
  return firstExisting(roleRoots('minimax', ctx, 'db').filter((x) => x.kind === 'file'))?.path ?? null;
}

const p2 = (n) => String(n).padStart(2, '0');
const p3 = (n) => String(n).padStart(3, '0');

// 宿主自己的历史文件（reader 的首选正文源）。它存在时追加必须写进文件 ——
// 取数链是 messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows，
// 只写 DB 行会被文件遮蔽（真机实测：append 返回成功但读回轮次不变）。
function historyFileOf(ctx, db, targetId) {
  // 历史根按 role 取（声明层已登记 MINIMAX_HOME）：根被搬走时写侧跟着走
  const root = historyRootOf(ctx);
  if (!tableColumns(db, 'local_runtime_sessions').includes('history_relative_dir')) return null;
  const rel = db.prepare('SELECT history_relative_dir AS rel FROM local_runtime_sessions WHERE session_id = ?').get(targetId)?.rel;
  if (!rel) return null;
  const dir = path.resolve(root, String(rel));
  const located = path.relative(root, dir);
  if (!located || path.isAbsolute(located) || located === '..' || located.startsWith('..' + path.sep)) return null;
  const f = path.join(dir, 'messages.jsonl');
  return isFile(f) || readMinimaxHistory(dir).native ? f : null;
}

// 一轮 IR → 宿主消息帧（**唯一实现**，两条写入路径共用）。
//
// 帧 = 宿主的一个「模型响应」：一段思考 + 若干 (工具调用 + 工具回执) + 可选的正文。
// 依据是宿主真机原生行的形状：一轮里模型会多次发言，宿主把**每次发言**写成一行，
//   reasoning → tool_call → tool_result →（下一次发言）reasoning → 正文 → …
//   收到工具回执即表示模型要重新发言（帧断），正文也断一帧。
//
// 为什么不能按 role 归组（原先的做法）：
//   一轮里可能有几十段助手正文（真机样本：一轮 126 条 item、59 段正文），
//   按 role 归组会把它们全并进一条消息 → 宿主渲染成一个巨大气泡，模型回复读不出来；
//   而且「一行 = 一条消息」的宿主契约也被破坏（行的 role 只能有一个）。
//
// 为什么 user 消息单独成帧：用户提问与宿主注入的压缩摘要都是 user 侧消息，
//   各自独立成行，不能和助手内容混在一行里。
//   同一轮里的**连续** user 文本块算同一条消息（Anthropic 存成多块），必须并进同一帧 ——
//   拆成两帧会变成两条 user 消息，读回时 assembleTurns 会多开一轮（轮次口径就变了）。
function turnToMessageFrames(turn) {
  const turnRole = turn.role === 'user' ? 'user' : 'assistant';
  const frames = [];
  let cur = null;
  let hasResult = false; // 当前帧里已经收到过工具回执 → 模型要重新发言了
  const newFrame = (role) => {
    cur = { role, blocks: [] };
    frames.push(cur);
    return cur;
  };

  for (const it of turn.items ?? []) {
    const block = itemToBlock(it, turnRole);
    if (!block) continue;
    const { role: roleMark, ...rest } = block;
    const role = roleMark === 'user' || roleMark === 'assistant' ? roleMark : turnRole;
    if (role === 'user') {
      if (cur && cur.role === 'user') cur.blocks.push(rest);
      else newFrame('user').blocks.push(rest);
      hasResult = false;
      continue;
    }
    // 助手侧：当前帧不是助手帧（user 帧或已结束）→ 另起一帧
    if (!cur || cur.role !== 'assistant') newFrame('assistant');
    // 收到回执之后模型又开口（思考/正文）或又发起新调用 → 上一帧结束
    if (hasResult && (rest.type === 'thinking' || rest.type === 'text' || rest.type === 'tool_use')) {
      newFrame('assistant');
      hasResult = false;
    }
    cur.blocks.push(rest);
    if (rest.type === 'tool_result') hasResult = true;
    else if (rest.type === 'text') {
      // 正文结束一帧
      cur = null;
      hasResult = false;
    }
  }
  return frames;
}

// 消息帧 → 宿主 messages.jsonl 的行（**文件型原生形状**，见 src/pi-agent-blocks.mjs）。
//
// 与 DB 行路径的关键差别：原生把工具回执写成**独立一行**（`role='toolResult'`，带
// toolCallId/toolName/isError），不塞进助手行的块里 —— 塞进去宿主解不出回执，它自己界面里
// 那次调用只剩「发起」没有「结果」。同理块类型必须是 `toolCall`；`tool_use` / `tool_result`
// 是 π 词表，宿主一个都不认（写进去那几次调用在它界面上直接消失）。
function withReplayProvider(message) {
  return message.role === 'assistant' && message.provider === undefined ? { ...message, provider: 'session-sync' } : message;
}

function frameToHistoryLines(frame, turnId, ts) {
  const blocks = [];
  const results = [];
  for (const b of frame.blocks) (b.type === 'tool_result' ? results : blocks).push(b);
  const lines = [];
  const push = (role, message) =>
    lines.push({ message_id: `msg-${role}-v1-${newNodeId()}`, turn_id: turnId, message: withReplayProvider({ ...message, timestamp: ts }) });
  const nativeBlocks = [];
  for (const b of blocks) {
    const nb = toNativeBlock(b);
    if (!nb) continue;
    // 压缩摘要在文件形态里没有 compact 位（原生块只有 type/text），判据只能落在**内容**上：
    // 补回 <cb_summary> 壳（与 DB 行 msg_content 同一口径），读侧据此还原 compact 语义位、
    // 剥壳取裸正文 —— 否则文件路径读回的摘要退化成普通用户提问，正文与语义一起丢。
    if (nb.type === 'text' && b.compact === true && !compactionInjectionKind(nb.text)) {
      nb.text = `<cb_summary>${nb.text}</cb_summary>`;
    }
    nativeBlocks.push(nb);
  }
  if (nativeBlocks.length) push(frame.role, { role: frame.role, content: nativeBlocks });
  for (const r of results) push('toolResult', toolResultRowOfBlock(r));
  return lines;
}

/**
 * 宿主的历史目录相对路径（app.asar `session-history-paths.js` 的
 * `utcSessionHistoryRelativeDir` 原文）：`YYYY/MM/DD/HH-mm-ss-mmm-session_<base64url(sessionId)>`。
 *
 * 三条硬约束（宿主 `validateRelativeDir` 会拒）：
 *   ① **4 段斜杠**（年 / 月 / 日 / 时间-会话名）—— 早先写成 `YYYY-MM-DD/...` 是两段，宿主认不出；
 *   ② 不含反斜杠、不绝对；
 *   ③ 时间戳取 **UTC**（宿主自己的派生也是 UTC）。
 * 库里的 `history_relative_dir` 就是这个值，磁盘路径 = `<v2/sessions>/<该值>`。
 */
export function historyRelativeDir(sessionId, createdAtMs) {
  const d = new Date(Number(createdAtMs) || 0);
  const date = `${String(d.getUTCFullYear()).padStart(4, '0')}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}-${p3(d.getUTCMilliseconds())}`;
  const encoded = Buffer.from(String(sessionId), 'utf8').toString('base64url').slice(0, 180);
  return `${date}/${time}-session_${encoded}`;
}

/** 宿主规范历史的根目录（正文目录树） */
function historyRootOf(ctx) {
  return writeRootOf('minimax', ctx, 'history')?.path ?? path.join(configRoot(ctx, 'minimax'), 'v2', 'sessions');
}

function defaultWorkspaceOf(ctx, targetId) {
  return resolvePlacement(null, 'minimax', ctx, { placement: 'bucket', targetId }).directory;
}

/**
 * provenance 的**第二落点**：规范历史目录里的 sidecar。
 *
 * 为什么必须写（真机 2026-11-23）：宿主首次物化会话时用自己的一套默认值重写
 * `extra_data_json`，**来源标记槽被整个抹掉**。只靠那一列的话，第二次导入读回这条会话
 * 就认不出它属于哪个 origin → 判成「不同身份」→ 长出一条重复副本（真机：重跑导入多出
 * 一条 1307 行的 fork）。
 *
 * sidecar 是宿主不碰的文件（`messages.jsonl.session-sync.json` 不匹配宿主任何扫描规则），
 * 标记因此能活过宿主的重写；读侧本来就会在 extra_data_json 之后读它（兜底口径）。
 *
 * 注意：这只解决「标记丢了」，不解决「身份判定」—— 标记**整条**没有（连 sidecar 也没了）
 * 的同 id 行仍然按不同身份处理（fork + identity-mismatch），那是 m4 钉住的既有契约。
 *
 * @returns {string|null} sidecar 路径；失败返回 null（不阻断写入）
 */
function writeProvenanceSidecar(dir, provenance) {
  if (!dir || !provenance) return null;
  try {
    return writeSidecarProvenance(path.join(dir, 'messages.jsonl'), provenance);
  } catch {
    return null;
  }
}

const liveProbeTarget = Symbol('minimax-live-probe-target');

function nativeProbeEnabled(ctx, liveTarget) {
  if (!ctx.env?.MINIMAX_HOME || (!liveTarget && ctx.env.SESSION_SYNC_MINIMAX_NATIVE !== '1')) return false;
  if (!fs.existsSync(ctx.env.MINIMAX_HOME)) return false;
  const actual = fs.realpathSync(ctx.env.MINIMAX_HOME);
  const configured = path.resolve(ctx.env.MINIMAX_HOME);
  if (cmpPath(dbFile(ctx)) !== cmpPath(path.join(configured, 'v2', 'sqlite', 'runtime-state.sqlite')) ||
      cmpPath(historyRootOf(ctx)) !== cmpPath(path.join(configured, 'v2', 'sessions'))) return false;
  if ([dbFile(ctx), historyRootOf(ctx)].filter((file) => fs.existsSync(file)).some((file) => {
    const rel = path.relative(actual, fs.realpathSync(file));
    return path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep);
  })) return false;
  const userRoot = path.join(os.homedir(), '.minimax');
  const live = fs.existsSync(userRoot) ? fs.realpathSync(userRoot) : userRoot;
  if (liveTarget) return ctx[liveProbeTarget] === liveTarget && cmpPath(live) === cmpPath(actual);
  const relative = path.relative(live, actual);
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep);
}

export function minimaxLiveProbeFixture(nonce, now = Date.now()) {
  if (!/^[0-9a-f]{12}$/u.test(nonce ?? '')) throw new Error('invalid-minimax-live-probe-nonce');
  const turns = ['covered', 'checkpoint', 'tail'].map((label, index) => {
    const token = sha256hex(nonce + ':' + label).slice(0, 12);
    const text = 'The literal value of ' + label.toUpperCase() + ' is ' + token + '.';
    const items = [messageItem('user', text, now + index, index === 1)];
    if (index !== 1) items.push(messageItem('assistant', 'Recorded.', now + index));
    return makeTurn('user', items, now + index);
  });
  const session = makeSession({ id: 'session-sync-minimax-probe-' + nonce, variant: 'workbuddy-cn',
    title: 'Session Sync MiniMax Probe ' + nonce, createdAt: now, updatedAt: now + 2, scope: 'none', turns });
  return { session, targetId: targetSessionId('minimax', session) };
}

export function createMinimaxLiveProbe(ctx, nonce) {
  const { session, targetId } = minimaxLiveProbeFixture(nonce);
  const probeCtx = { ...ctx, [liveProbeTarget]: targetId };
  if (!nativeProbeEnabled(probeCtx, targetId)) return { ok: false, error: 'minimax-live-probe-requires-default-root' };
  return minimaxWriter.write(probeCtx, { session, targetId, mode: 'create', scope: 'none',
    provenance: buildProvenance(session, session.createdAt, { scope: 'none' }) });
}

function standaloneSummary(turn) {
  const items = turn.items ?? [];
  const item = items[0];
  if (item?.role !== 'user' || item.kind !== 'message' || item.compact !== true) return undefined;
  if (items.slice(1).some((part) => part.role === 'user' || part.kind === 'attachment')) return undefined;
  const summary = compactionSummaryText(item.text);
  return summary.trim() && portableSummary({ role: 'compactionSummary', summary }) === summary ? summary : undefined;
}

function legacyGroups(records) {
  const groups = [];
  for (const record of records) {
    if (!groups.length || record.message?.role === 'user') groups.push({ records: [] });
    groups.at(-1).records.push({ ...record, message: withReplayProvider(record.message) });
  }
  for (const group of groups) {
    const [first, ...rest] = group.records;
    const content = first.message?.content;
    if (first.message?.role !== 'user' || content?.length !== 1 || content[0].type !== 'text' ||
        first.message.attachments?.length || first.turn_config ||
        rest.some((row) => row.message?.attachments?.length || row.message?.content?.some?.((block) => block.type === 'image')) ||
        !compactionInjectionKind(content[0].text)) continue;
    const summary = compactionSummaryText(content[0].text);
    if (summary.trim() && portableSummary({ role: 'compactionSummary', summary }) === summary) group.summary = summary;
  }
  return groups;
}

export function upgradeMinimaxCompaction(ctx, targetId, { apply = false } = {}) {
  const dbPath = dbFile(ctx);
  if (!dbPath) return { ok: false, error: 'db-not-found' };
  const enabled = apply && nativeProbeEnabled(ctx);
  const root = historyRootOf(ctx);
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  let publishing = false;
  try {
    db.exec('PRAGMA busy_timeout = 8000');
    if (hasMinimaxPublication(dbPath, targetId)) {
      if (!apply) return { ok: false, targetId, error: pendingMinimaxHistory };
      if (!enabled) return { ok: false, targetId, error: 'minimax-native-history-write-unverified' };
      recoverMinimaxPublications(db, dbPath, root, targetId);
    }
    if (apply) db.exec('BEGIN IMMEDIATE');
    const file = historyFileOf(ctx, db, targetId);
    const session = minimaxReader.read(ctx, targetId);
    if (!file || !session?.origin || session.meta.fileIncomplete) return { ok: false, error: 'minimax-upgrade-requires-complete-import' };
    const dir = path.dirname(file);
    const history = readMinimaxHistory(dir);
    if (history.error) return { ok: false, error: history.error };
    let plan;
    let result;
    if (history.native) {
      const checkpoint = repairMinimaxMaterialization(db, root, { id: targetId, history, apply });
      const importedCount = verifiedMinimaxImportPrefix(db, targetId, history);
      let assistantProviderMissing = 0;
      const active = history.active.map((record, index) => {
        if (index >= importedCount) return record;
        const message = withReplayProvider(record.message);
        if (message === record.message) return record;
        assistantProviderMissing++;
        return { ...record, message };
      });
      result = { ok: true, targetId, upgraded: 0, reason: 'already-native', checkpoint, dryRun: !apply };
      if (!assistantProviderMissing || !apply) {
        if (apply) db.exec('COMMIT');
        return { ...result, assistantProviderMissing };
      }
      if (!enabled) return { ok: false, targetId, error: 'minimax-native-history-write-unverified', assistantProviderMissing };
      plan = { active, snapshots: [] };
      result.assistantProviderRepaired = assistantProviderMissing;
    } else {
      const groups = legacyGroups(history.active);
      const boundaries = groups.filter((group) => group.summary !== undefined).length;
      if (!boundaries || !apply) return { ok: true, targetId, boundaries, upgraded: 0, dryRun: !apply };
      if (!enabled) return { ok: false, targetId, error: 'minimax-native-history-write-unverified' };
      plan = planMinimaxHistory([], groups);
      result = { ok: true, targetId, boundaries, upgraded: boundaries };
    }
    const before = minimaxRevision(history.active);
    const fingerprints = sessionCoreFingerprints(session);
    publishing = true;
    const after = stageMinimaxPublication(db, dbPath, root, {
      id: targetId, relativeDir: path.relative(root, dir).split(path.sep).join('/'), expected: before, plan,
    });
    const checked = minimaxReader.read(ctx, targetId, { verifyPublication: true });
    const verified = checked && !checked.meta.historyError && checked.meta.historyRevision === after &&
      JSON.stringify(fingerprints) === JSON.stringify(sessionCoreFingerprints(checked)) &&
      JSON.stringify(session.origin) === JSON.stringify(checked.origin) && JSON.stringify(session.chain) === JSON.stringify(checked.chain);
    if (!verified) throw new Error('minimax-upgrade-verification-failed');
    db.exec('COMMIT');
    recoverMinimaxPublications(db, dbPath, root, targetId);
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (publishing) {
      try { recoverMinimaxPublications(db, dbPath, root, targetId); }
      catch (recovery) { return { ok: false, targetId, error: String(error.message), recoveryError: String(recovery.message) }; }
    }
    return { ok: false, targetId, error: String(error?.message ?? error) };
  } finally {
    db.close();
  }
}

/**
 * 自己落一份宿主的**规范历史文件**（新建会话时）。
 *
 * AgentHost 用规范文件作为续写历史。导入预发布文件后，索引事务负责登记首次物化。
 *
 * 文件形态照宿主真机：`{message_id, turn_id, message}` 一行一条消息；
 * 同目录还要有 `manifest.json`（宿主校验它与行的 sessionId / createdAtMs 一致）。
 *
 * @returns {{ok:boolean, relativeDir?:string, dir?:string, error?:string}}
 */
function writeCanonicalHistory(ctx, { sessionId, createdAtMs, updatedAtMs, lines, nativePlan }) {
  const relativeDir = historyRelativeDir(sessionId, createdAtMs);
  const root = historyRootOf(ctx);
  const dir = path.join(root, ...relativeDir.split('/'));
  try {
    ensureDir(dir);
    // 原子写：先写临时文件再改名 —— 宿主随时可能在读这个文件，半截 JSON 行会毁掉整份历史
    const messages = path.join(dir, 'messages.jsonl');
    if (nativePlan) {
      if (isFile(messages)) throw new Error('minimax-existing-canonical-history');
    } else {
      const existing = isFile(messages) ? readMinimaxHistory(dir) : null;
      if (existing?.native || existing?.error) throw new Error('minimax-existing-native-history');
      writeFileAtomic(messages, lines.map((line) => JSON.stringify(line) + '\n').join(''));
    }
    const manifest = {
      schemaVersion: 1,
      sessionId: String(sessionId),
      createdAtMs: Number(createdAtMs),
      updatedAtMs: Number(updatedAtMs),
      source: 'local-runtime',
      layout: 'v2-final-dated-session',
      paths: {
        sessionDir: dir,
        ledger: path.join(dir, 'ledger.jsonl'),
        display: path.join(dir, 'display.jsonl'),
        snapshot: path.join(dir, 'snapshot.json'),
        reports: path.join(dir, 'reports'),
        messages,
      },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    const tmpManifest = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpManifest, manifestPath);
    return { ok: true, relativeDir, dir };
  } catch (err) {
    return { ok: false, relativeDir, dir, error: `canonical-history-write-failed: ${String(err?.message ?? err)}` };
  }
}

// IR item → π content 块（宿主 messages.jsonl 用的块结构）。
// 块上带 role：读侧按块级 role 重新分组，才能把「user 提问 + assistant 回答」
// 还原成同一轮里的两个条目（否则全部按行 role 归一成 user，核心指纹就变了
// → 下一次导入判成 fork 而不是 append）。
function itemToBlock(it, turnRole) {
  const role = it.role === 'user' || it.role === 'assistant' ? it.role : it.kind === 'message' ? turnRole : 'assistant';
  switch (it.kind) {
    case 'message':
      // 携带 compact 语义位：minimax 无独立压缩语义列，写侧据此标 SystemEvent 并补回 <cb_summary> 壳，
      // 让读侧（靠内容标签认压缩）+ 宿主都能认出，正文一字不丢。
      return { type: 'text', text: it.text ?? '', role, ...(it.compact ? { compact: true } : {}) };
    case 'reasoning':
      return { type: 'thinking', thinking: it.text ?? '', role };
    case 'tool_call':
      return { type: 'tool_use', id: it.callId ?? null, name: it.name ?? 'tool', input: it.input ?? null, role };
    case 'tool_result':
      // 带 name：文件型历史把回执写成独立行，原生行里有 toolName（缺了就只能落 'tool'，工具名丢失）
      return { type: 'tool_result', tool_use_id: it.callId ?? null, name: it.name ?? 'tool', content: it.output ?? '', is_error: it.status === 'error', role };
    case 'attachment':
      return { type: 'image', path: it.ref ?? '', role };
    default:
      return null;
  }
}

// π 块 → 宿主 tool_calls 结构（真机原生行口径，见 app.asar 取证）：
//   {tool_name, tool_call_id, tool_call_status(1 Start/2 Finished/3 Failed),
//    tool_call_args: JSON 串, tool_call_result_data: JSON 串}
//
// IR 的「调用」与「回执」是两件，宿主的一条 tool_call 自带入参与结果 —— 这里合成一件。
// 读回时靠 session-sync-content 里的 π 块还原成两件，所以这里只负责宿主渲染，不负责无损。
function hostToolCalls(blocks) {
  const out = [];
  const byId = new Map();
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      const id = b.id ?? null;
      const entry = {
        tool_name: b.name ?? 'tool',
        tool_call_id: id ?? newNodeId(),
        tool_call_status: 2,
        tool_call_args: JSON.stringify(b.input ?? null),
      };
      if (id) byId.set(id, entry);
      out.push(entry);
    } else if (b.type === 'tool_result') {
      const id = b.tool_use_id ?? null;
      const payload = JSON.stringify({ content: [{ type: 'text', text: String(b.content ?? '') }] });
      const entry = id ? byId.get(id) : null;
      if (entry) {
        entry.tool_call_status = b.is_error ? 3 : 2;
        entry.tool_call_result_data = payload;
      } else {
        out.push({ tool_name: 'tool', tool_call_id: id ?? newNodeId(), tool_call_status: b.is_error ? 3 : 2, tool_call_result_data: payload });
      }
    }
  }
  return out;
}

// π 块 → 宿主 attachments 结构（toAttachmentView 的容错口径：filePath / fileName / type）
function hostAttachments(blocks) {
  return blocks
    .filter((b) => b.type === 'image')
    .map((b) => {
      const p = String(b.path ?? '');
      return { type: 'image', filePath: p, fileName: p.split(/[\\/]/).pop() ?? '' };
    });
}

// 一个消息帧 → 一行宿主 display message。
//
// 字段口径全部照宿主真机原生行：
//   col.msg_id === data.msg_id —— 不相等时 decodeDisplayMessage 直接抛 MessageDataCorruptionError
//   col.turn_id === data.turn_id === data.turnId —— 一轮的所有消息共享同一个 turn_id
//   col.role === data.role —— 这条消息自己的角色
//   data.msg_type：1=AgentContent / 2=AgentToolCall / 3=SystemEvent
//   data.msg_content / thinking_content / tool_calls —— 宿主的解码链只看这三个
//   data['session-sync-content'] —— 本工具的私有键，存全量 π 块（含块级 role）：
//     宿主不读它，但自己必须能靠它无损读回 tool_call / tool_result / 附件。
//     （少了它，读回只剩正文，工具调用会在核心指纹里消失 → 往返被判成 fork。）
function messageRowOf(frame, { turnId, ts, targetId }) {
  const msgId = newNodeId();
  const text = frame.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const thinking = frame.blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
  const toolCalls = hostToolCalls(frame.blocks);
  const attachments = hostAttachments(frame.blocks);
  // 宿主注入的压缩摘要是「系统事件」，不是用户提问：标 SystemEvent，宿主才不会把它显示成用户气泡。
  // minimax 无独立压缩语义列，读侧靠内容标签认 → 写侧两件事都要做：
  //   ① isSystemEvent 认 compact 位（归一化新口径）或内容标签（旧 reader / 兼容回退）；
  //   ② 正文是归一化裸正文（compact 位）时补回 <cb_summary> 壳，让宿主/读侧认得出。
  // 'session-sync-content' 里保留裸正文，读侧据此无损还原（不丢字）。
  const compactBlock = frame.blocks.find((b) => b.type === 'text' && b.compact === true);
  const isSystemEvent = !!compactBlock || frame.blocks.some((b) => b.type === 'text' && compactionInjectionKind(b.text));
  const msgType = isSystemEvent ? 3 : toolCalls.length ? 2 : 1;
  const msgContent = compactBlock && !compactionInjectionKind(text) ? `<cb_summary>${text}</cb_summary>` : text;
  return [
    ['session_id', String(targetId)],
    ['msg_id', msgId],
    ['role', frame.role],
    ['turn_id', turnId],
    ['created_at_ms', ts],
    ['data_json', JSON.stringify({
      msg_id: msgId,
      turn_id: turnId,
      turnId,
      timestamp: ts,
      role: frame.role,
      msg_type: msgType,
      msg_content: msgContent,
      ...(thinking ? { thinking_content: thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(attachments.length ? { attachments } : {}),
      'session-sync-content': frame.blocks.map((b) => ({ ...b, role: frame.role })),
    })],
    ['source', 'session-sync'],
  ];
}

const LISTABLE = {
  columnar_version: 3,
  agent_name: 'mavis',
  runtime: 'pi-agent',
  // session_type 必须是 'branch'（真机取证 2026-11-23）：
  //   宿主自己创建的普通对话全是 'branch'；'root' 是 Agent 的 Main 会话（内部主会话）。
  //   写成 'root' 会踩宿主侧栏的**内部主会话排除规则**（listInternalDefaultRootIds）：
  //   session_type='root' AND session_kind='conversation' 且 is_default_workspace=1
  //   ⇒ 被当成 Agent 内部 Main 会话，从侧栏 eligible 集合里排除 ⇒ 整条会话在桌面侧栏看不见。
  //   真机症状：导入的会话库里有、运行时 list 得到，桌面侧栏没有。
  session_type: 'branch',
  status: 'idle',
  visibility: 'visible',
  session_kind: 'conversation',
};

// 标题搜索文档（`local_runtime_sessions_fts`）**不由写侧预写**，交给宿主：
//   宿主在会话首次被打开/物化时自己写这份搜索文档（app.asar repo/search.js 的
//   writeSessionSearchDocument），并且 FTS 文档的 rowid 必须与
//   `local_runtime_session_fts_keys.fts_rowid` 一一对应 —— 那张表是 AUTOINCREMENT，
//   宿主按它分配 rowid 给新会话。写侧预写会占掉宿主下一次要用的 rowid，
//   宿主再建会话时就会撞 FTS 的 rowid 唯一约束（比「搜不到」严重得多）。
//   代价：会话在被打开之前搜不到（宿主自己补上后就能搜）。


/**
 * 盘上已有的标题：先看 title 列（宿主列表读它），列空再退回 record_json 快照。
 * 两个都是标题落点，只认一个会在另一半丢名字。
 */
function existingTitleOf(row) {
  const col = String(row?.title ?? '').trim();
  if (col) return col;
  try {
    return String(JSON.parse(String(row?.record_json ?? '{}'))?.title ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * append 不会触发宿主那条 AFTER INSERT 触发器，所以项目行/回填要自己补：
 * 与 trg_local_runtime_project_session_insert_v5 同语义（default 唯一、workspace 按目录）。
 */
function ensureProjectRow(db, { workspace, isDefault, createdAt, updatedAt }) {
  if (!tableExists(db, 'local_runtime_projects')) return null;
  const find = () => {
    const row = db
      .prepare(
        `SELECT project_id FROM local_runtime_projects
         WHERE (project_kind = 'default' AND ? = 1)
            OR (project_kind = 'workspace' AND ? = 0 AND workspace_dir = ?)
         ORDER BY project_id LIMIT 1`,
      )
      .get(isDefault, isDefault, workspace);
    return row ? Number(row.project_id) : null;
  };
  try {
    const found = find();
    if (found != null) return found;
    const projAll = [
      ['project_kind', isDefault ? 'default' : 'workspace'],
      ['workspace_dir', isDefault ? null : workspace],
      ['latest_activity_at_ms', updatedAt],
      ['created_at_ms', createdAt],
      ['updated_at_ms', updatedAt],
    ];
    const projHave = tableColumns(db, 'local_runtime_projects');
    if (!projHave.length) return null;
    // INSERT OR IGNORE：宿主库在 workspace_dir 上有 UNIQUE 索引，
    // 裸 INSERT 撞重复会抛约束错误、把整条写入带崩
    const info = insertRowFiltered(db, 'local_runtime_projects', projAll, { verb: 'INSERT OR IGNORE', returnRowId: true, ifEmpty: 'skip' });
    if (!info.ok) return null;
    // 冲突时（OR IGNORE 什么都没插）回查已有行，保证拿到的是真实 project_id
    return find() ?? (Number(info.changes) > 0 ? Number(info.lastInsertRowid) : null);
  } catch {
    return null;
  }
}

/**
 * 规范历史文件现状：原始行文本 + 每行的 turn_id / 时间戳 + 文件的 size/mtime。
 *
 * 保留**原始行文本**（不重新序列化）：宿主自己写的那些行必须逐字节不变 ——
 * 我们只往里补内容，不重排、不改写宿主写过的任何一行。
 */
function readHistoryFileState(file) {
  try {
    const st = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const recordLines = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const record = safeJson(line, null);
      if (!record || typeof record !== 'object' || Array.isArray(record)) return { invalid: true };
      recordLines.push(index);
    }
    return { lines, recordLines, expectSize: st.size, expectMtimeMs: st.mtimeMs };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { lines: [], recordLines: [], expectSize: -1 };
  }
}

/** 我们自己的 DB 行按 turn_id 分组（保持首次出现的顺序 = 时间顺序） */
function groupOurTurns(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.turn_id ?? '');
    if (!key) continue;
    const g = map.get(key) ?? { turnId: key, rows: [] };
    g.rows.push(r);
    map.set(key, g);
  }
  return [...map.values()];
}

/**
 * 规范历史文件自愈：把我们自己写的那几轮补回文件。
 *
 * 背景（真机 2026-11-23）：老版本导入 minimax 时只写 DB 行、不写规范历史文件 ——
 * 宿主首次物化会话时只发布一个**空文件**，空文件就是模型上下文的唯一来源，
 * 于是导入正文在模型上下文里消失（界面消息列表仍看得到，它读 DB 行）。
 * 本机现场：4 条会话的规范文件少了 1–64 轮导入正文（其中一条少了整整 64 轮）。
 *
 * 判据与补写内容都问读侧：按有序核心指纹定位缺失轮及补写位置。
 * 宿主可能用自己的 turn_id 把我们的行重新物化进文件（内容一样、id 不同），
 * 按 id 判会把同一轮再补一遍，文件里就出现两次同样的内容。
 *
 * 只补我们自己的轮次；宿主自己写的内容**逐字节保留**（按原始行文本归并）。
 *
 * 并发：宿主随时可能在追加这个文件 —— 写前校验 size 与 mtime，对不上就**放弃这次修复**
 * （不覆盖宿主的追加），下次重跑再试。宁可晚点补上，也不吃掉宿主刚写的轮次。
 */
function repairCanonicalHistories(ctx) {
  const warnings = [];
  const file = dbFile(ctx);
  if (!file || !isFile(file)) return { ok: false, error: 'db-not-found', warnings };
  const db = new DatabaseSync(file, { readOnly: true });
  const repaired = [];
  try {
    if (!tableExists(db, 'local_runtime_sessions') || !tableExists(db, 'local_runtime_message_rows')) {
      return { ok: true, skipped: 'tables-absent', warnings };
    }
    const root = historyRootOf(ctx);
    const sessions = db.prepare('SELECT session_id, history_relative_dir FROM local_runtime_sessions').all();
    for (const s of sessions) {
      if (!s.history_relative_dir || hasMinimaxPublication(file, s.session_id)) continue;
      const dir = path.join(root, ...String(s.history_relative_dir).split('/'));
      const histFile = path.join(dir, 'messages.jsonl');
      const state = readHistoryFileState(histFile);
      const { missing, ambiguous } = planImportedTurnRepair(db, s.session_id, dir);
      if (!missing.length) continue;
      if (ambiguous || state.invalid) {
        warnings.push('canonical-history-repair-ambiguous: ' + s.session_id);
        continue;
      }

      // 缺失轮次 → 宿主规范形状的行（与新建时同一套转换：IR → 帧 → 行）
      const insertions = new Map();
      for (const { turn, beforeLine } of missing) {
        const ts = Number(turn.startedAt) || 0;
        const turnId = `turn_repair_${String(newNodeId())}`;
        const lines = [];
        for (const frame of turnToMessageFrames(turn)) {
          for (const l of frameToHistoryLines(frame, turnId, ts)) {
            lines.push(JSON.stringify(l));
          }
        }
        const at = state.recordLines[beforeLine] ?? state.lines.length;
        if (!insertions.has(at)) insertions.set(at, []);
        insertions.get(at).push(...lines);
      }
      const merged = state.lines.flatMap((line, index) => [...(insertions.get(index) ?? []), line]);
      merged.push(...(insertions.get(state.lines.length) ?? []));
      const content = merged.join('\n') + '\n';
      try {
        writeFileAtomic(histFile, content, state);
      } catch (err) {
        if (err?.code === 'CONCURRENT_MODIFICATION') {
          warnings.push(`canonical-history-repair-skipped: ${histFile}（宿主刚追加过这个文件，本次不覆盖，下次重跑再试）`);
          continue;
        }
        throw err;
      }
      repaired.push(s.session_id);
      warnings.push(`canonical-history-repaired: ${s.session_id} 补回 ${missing.length} 轮导入正文（${histFile}）`);
    }
    return { ok: true, repaired, warnings };
  } catch (err) {
    return { ok: false, error: `repair-failed: ${String(err?.message ?? err)}`, warnings };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- 项目键（workspace_dir）的落库形态 ----
//
// 宿主的项目键是**字节级**目录串，两处都按等值比较：
//   - `local_runtime_projects.workspace_dir` 上有 UNIQUE 索引（仅 workspace 类）
//   - 宿主触发器回填 project_id 用 `p.workspace_dir = NEW.project_workspace_dir`
// 同一个目录的两种写法（Windows 上 `d:\work` 与 `D:\work` 是同一个目录）在宿主眼里是两行
// → 侧栏两个同名分组。真机样本：源 agent 记的是小写盘符，宿主自己记的是大写，
// 导入后 local_runtime_projects 出现同一目录的两行。

/**
 * 落库形态的目录串：宿主已有的那一串优先（精确命中直接用；忽略大小写/分隔符命中则用宿主那串）
 * —— 只有宿主自己的串能和它的 UNIQUE 索引、触发器等值比较对上；
 * 宿主没有对应行时取**盘符大写 + 原生分隔符**的形态（与宿主 process.cwd() 同形，见 util.mjs）。
 * @param {string} input 源侧记的 cwd
 * @returns {string} 规范形态（非空时）
 */
export function canonicalWorkspaceDir(input) {
  return canonicalDirPath(input);
}

function workspaceProjectRows(db) {
  try {
    return db.prepare("SELECT project_id, workspace_dir FROM local_runtime_projects WHERE project_kind = 'workspace'").all();
  } catch {
    return [];
  }
}

/** 权威行的计数重算（照宿主触发器的口径：列式版本 3、未归档、可见、非 peek/cron） */
function refreshProjectCounters(db, projectId) {
  try {
    db.prepare(
      `UPDATE local_runtime_projects SET
         latest_activity_at_ms = COALESCE((SELECT MAX(s.updated_at_ms) FROM local_runtime_sessions s
            WHERE s.project_id = ? AND s.columnar_version = 3 AND s.archived = 0
              AND s.visibility <> 'hidden' AND s.session_kind NOT IN ('peek','cron')), 0),
         session_count = (SELECT COUNT(*) FROM local_runtime_sessions s
            WHERE s.project_id = ? AND s.columnar_version = 3 AND s.archived = 0
              AND s.visibility <> 'hidden' AND s.session_kind NOT IN ('peek','cron')
              AND s.parent_session_id IS NULL)
       WHERE project_id = ?`,
    ).run(projectId, projectId, projectId);
  } catch {
    /* 计数只是显示口径，拿不到就算了 */
  }
}

/**
 * 合并同一个目录的重复项目行。
 * 只并 cmpPath 相同的目录 —— 那是同一个目录的不同写法，合并只是把分组归位，不丢会话。
 * 权威行 = 与规范形态精确命中的那行；没有就取最早建的那行。
 * @returns {Array<{kept:number, dropped:number, dir:string, droppedDir:string}>}
 */
export function mergeDuplicateProjects(db, { onlyDir = null } = {}) {
  if (!tableExists(db, 'local_runtime_projects')) return [];
  const want = onlyDir ? cmpPath(onlyDir) : null;
  const groups = new Map();
  for (const r of workspaceProjectRows(db)) {
    const key = cmpPath(r.workspace_dir);
    if (!key) continue;
    if (want && key !== want) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const merged = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Number(a.project_id) - Number(b.project_id));
    const keep = group[0];
    for (const dup of group.slice(1)) {
      // 会话改挂到权威行，目录串一并对齐（读侧读回的 cwd 跟着归位）
      db.prepare('UPDATE local_runtime_sessions SET workspace_dir = ?, project_workspace_dir = ?, project_id = ? WHERE project_id = ?')
        .run(keep.workspace_dir, keep.workspace_dir, keep.project_id, dup.project_id);
      db.prepare('DELETE FROM local_runtime_projects WHERE project_id = ?').run(dup.project_id);
      merged.push({ kept: Number(keep.project_id), dropped: Number(dup.project_id), dir: String(keep.workspace_dir), droppedDir: String(dup.workspace_dir) });
    }
    refreshProjectCounters(db, keep.project_id);
  }
  return merged;
}

/**
 * 把落点目录对齐到宿主已有的项目行。
 * @returns {{dir: string, projectId: number|null, merged: Array}}
 */
export function resolveWorkspaceDir(db, raw) {
  const canonical = canonicalWorkspaceDir(raw);
  if (!canonical) return { dir: '', projectId: null, merged: [] };
  if (!tableExists(db, 'local_runtime_projects')) return { dir: canonical, projectId: null, merged: [] };
  // 先把同一个目录的重复行并掉（大小写不同写法各建了一行的历史残留）
  const merged = mergeDuplicateProjects(db, { onlyDir: canonical });
  const hit = workspaceProjectRows(db).filter((r) => cmpPath(r.workspace_dir) === cmpPath(canonical));
  if (!hit.length) return { dir: canonical, projectId: null, merged };
  // 精确命中优先（那就是宿主自己记的那一串），否则取最早建的那行
  const exact = hit.find((r) => String(r.workspace_dir) === canonical);
  const row = exact ?? hit.sort((a, b) => Number(a.project_id) - Number(b.project_id))[0];
  return { dir: String(row.workspace_dir), projectId: Number(row.project_id), merged };
}


export const minimaxWriter = {
  variant: 'minimax',
  label: 'MiniMax Code',

  canWrite(ctx) {
    const f = dbFile(ctx);
    return f && isFile(f) ? { ok: true } : { ok: false, reason: 'db-not-found' };
  },

  /**
   * 目标级自愈（导入时、锁内、决策之前调用）：把规范历史文件里缺了的那几轮导入正文补回去。
   *
   * 为什么必须在决策之前：宿主物化出来的空文件会把 DB 行里的导入正文整个遮住 ——
   * 读侧因此看到的是「只有宿主自己那几轮」的会话，内容对不上源 → 判成分叉 → 长出重复副本。
   * 先把文件补齐，读侧与决策看到的才是同一条完整会话。
   */
  repair(ctx) {
    if (nativeProbeEnabled(ctx)) {
      const file = dbFile(ctx);
      const db = new DatabaseSync(file);
      try {
        db.exec('PRAGMA busy_timeout = 8000');
        recoverMinimaxPublications(db, file, historyRootOf(ctx));
      } catch (error) {
        return { ok: false, error: String(error.message), warnings: [] };
      } finally {
        db.close();
      }
    }
    return repairCanonicalHistories(ctx);
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
   * minimax 的标题住在 local_runtime_sessions.title 列。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'db-column', db: (c) => dbFile(c), table: 'local_runtime_sessions', idCol: 'session_id', col: 'title', maxLen: TITLE_MAX.minimax },
  ], 'minimax'),

  targetPath(ctx, session, targetId) {
    const f = dbFile(ctx);
    return f ? `${f}#${targetId}` : null;
  },

  /**
   * 索引自愈（供 import 的 skip 分支调用）：minimax 的索引行就是 sessions 表的那一行，
   * 这里只做一件事 —— 把归属对齐到**宿主已有的项目行**。
   *
   * 为什么必须做：项目键是字节级目录串，同一个目录的大小写写法不同 = 两个项目行
   * = 侧栏两个同名分组。落库时对齐过一次，但历史残留（老版本写进去的）只有自愈能收拾。
   * 行不在 → 交给 write 建，这里不越权。
   */
  ensureIndex(ctx, { targetId, cwd, scope = null } = {}) {
    const warnings = [];
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found', warnings };
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      if (!tableExists(db, 'local_runtime_sessions')) return { ok: false, error: 'sessions-table-absent', warnings };
      const row = db
        .prepare('SELECT workspace_dir, project_workspace_dir, is_default_workspace, project_id, session_type, extra_data_json FROM local_runtime_sessions WHERE session_id = ?')
        .get(String(targetId));
      if (!row) return { ok: false, error: 'target-missing', warnings };

      // ---- 可见性自愈：老版本写进来的 session_type='root' ----
      // 宿主把「root + conversation + 默认桶」的行当成 Agent 内部 Main 会话，
      // 从侧栏 eligible 集合里排除（listInternalDefaultRootIds）⇒ 桌面侧栏看不见。
      // 只修**我们自己写过的行**（extra_data_json 里有 session-sync 标记）；
      // 宿主原生行（哪怕也是 root）一个字都不动（relocate-foreign 口径）。
      const own = /"session-sync"\s*:/.test(String(row.extra_data_json ?? ''));
      if (own) {
        const sets = [];
        if (String(row.session_type) === 'root') sets.push(['session_type', LISTABLE.session_type]);
        if (sets.length) {
          db.exec('BEGIN IMMEDIATE');
          try {
            updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
            db.exec('COMMIT');
            warnings.push(`visibility-healed: session_type ${row.session_type} → ${LISTABLE.session_type}（宿主侧栏的内部主会话排除规则）`);
          } catch (err) {
            try {
              db.exec('ROLLBACK');
            } catch {
              /* ignore */
            }
            warnings.push(`visibility-heal-failed: ${String(err?.message ?? err)}`);
          }
        }
      }
      const isDefault = Number(row.is_default_workspace) === 1 || scope === 'none';
      const want = String(cwd ?? row.workspace_dir ?? '').trim();
      if (Number(row.is_default_workspace) === 1 && !String(row.workspace_dir ?? '').trim()) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT workspace_dir, is_default_workspace, record_json, extra_data_json FROM local_runtime_sessions WHERE session_id = ?').get(String(targetId));
          if (Number(current?.is_default_workspace) !== 1 || String(current.workspace_dir ?? '').trim()) {
            return { ok: true, changed: false, warnings };
          }
          const historyFile = historyFileOf(ctx, db, targetId);
          if (!extractFromJsonObject(safeJson(current.extra_data_json)) && !(historyFile && readSidecarProvenance(historyFile))) {
            return { ok: true, changed: false, warnings };
          }
          const record = safeJson(current.record_json);
          if (!record || record.sessionId !== String(targetId)) throw new Error('minimax-invalid-session-record');
          const workspace = defaultWorkspaceOf(ctx, targetId);
          if (!workspace) throw new Error('minimax-default-workspace-required');
          ensureDir(workspace);
          const sets = [['workspace_dir', workspace], ['project_workspace_dir', workspace],
            ['record_json', JSON.stringify({ ...record, workspaceDir: workspace })]];
          updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
          db.exec('COMMIT');
          return { ok: true, changed: true, dir: workspace, warnings };
        } finally {
          if (db.isTransaction) db.exec('ROLLBACK');
        }
      }
      if (!want || isDefault) return { ok: true, changed: false, warnings };
      db.exec('BEGIN IMMEDIATE');
      try {
        const resolved = resolveWorkspaceDir(db, want);
        const dir = resolved.dir || want;
        for (const m of resolved.merged) {
          warnings.push(`project-merged: 同一个目录的重复项目行已合并（${m.droppedDir} → ${m.kept}）`);
        }
        const changed =
          String(row.workspace_dir ?? '') !== dir ||
          String(row.project_workspace_dir ?? '') !== dir ||
          (resolved.projectId != null && Number(row.project_id ?? 0) !== Number(resolved.projectId));
        if (changed) {
          const sets = [['workspace_dir', dir], ['project_workspace_dir', dir]];
          if (resolved.projectId != null) sets.push(['project_id', resolved.projectId]);
          updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
        }
        db.exec('COMMIT');
        return { ok: true, changed, dir, projectId: resolved.projectId, warnings };
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, warnings };
      }
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false, scope = null }) {
    const warnings = [];
    const file = dbFile(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found' };
    const liveTarget = mode === 'create' && !force && ctx[liveProbeTarget] === targetId ? targetId : null;

    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const now = Date.now();
    const createdAt = Number(session.createdAt) || now;
    const updatedAt = Number(session.updatedAt) || createdAt;
    let workspace = String(session.cwd ?? '').trim();
    let isDefault = (scope ?? session.scope) === 'none' ? 1 : 0;
    if (!workspace && mode === 'append') {
      // 非项目 reader 隐藏内部 cwd，追加时从目标行取回实际运行目录。
      const cur = new DatabaseSync(file, { readOnly: true });
      try {
        const row = cur.prepare('SELECT workspace_dir, is_default_workspace FROM local_runtime_sessions WHERE session_id = ?').get(String(targetId));
        if (row) {
          workspace = String(row.workspace_dir ?? '').trim();
          isDefault = Number(row.is_default_workspace) === 1 ? 1 : 0;
        }
      } catch {
        /* 读不到就仍按缺 cwd 处理 */
      } finally {
        cur.close();
      }
    }
    if (!workspace && isDefault) workspace = defaultWorkspaceOf(ctx, targetId) ?? '';
    if (!workspace) return { ok: false, error: 'cwd-required: minimax 的行必须有 workspace_dir' };

    const db = new DatabaseSync(file);
    let inserted = 0;
    let canonicalRel = null;
    let publishing = false;
    const root = historyRootOf(ctx);
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      const nativeEnabled = nativeProbeEnabled(ctx, liveTarget);
      if (liveTarget && !nativeEnabled) return { ok: false, error: 'minimax-live-probe-requires-default-root' };
      if (!tableExists(db, 'local_runtime_sessions') || !tableExists(db, 'local_runtime_message_rows')) {
        return { ok: false, error: 'sessions-or-message-rows-missing' };
      }
      if (hasMinimaxPublication(file, targetId)) {
        if (!nativeEnabled || liveTarget) throw new Error(pendingMinimaxHistory);
        recoverMinimaxPublications(db, file, root, targetId);
      }
      db.exec('BEGIN IMMEDIATE');
      // 落点目录对齐到宿主已有的项目行：项目键是字节级目录串，
      // 源 agent 记的大小写与宿主自己记的不一致时，照抄会多出一个项目行
      // → 侧栏两个同名分组。这里换成宿主那一串，触发器的等值比较才命中同一行。
      if (workspace && !isDefault) {
        const resolved = resolveWorkspaceDir(db, workspace);
        if (resolved.dir) workspace = resolved.dir;
        if (resolved.merged.length) {
          warnings.push(`project-merged: 同一个目录的重复项目行已合并（${resolved.merged.map((m) => `${m.droppedDir} → ${m.kept}`).join('；')}）`);
        }
      }
      try {
        ensureDir(workspace);
      } catch (err) {
        if (isDefault) throw err;
        warnings.push(`mkdir-failed: ${String(err?.message ?? err)}`);
      }
      // 连标题一起读回来：append 时要保留宿主/用户已有的名字（见下面 record.title 的判定）
      let existing = db.prepare('SELECT session_id, title, record_json FROM local_runtime_sessions WHERE session_id = ?').get(targetId);

      if (existing && mode !== 'append') {
        if (!force) {
          db.exec('ROLLBACK');
          return { ok: false, error: 'target-exists', targetId, warnings };
        }
        db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(targetId);
        db.prepare('DELETE FROM local_runtime_sessions WHERE session_id = ?').run(targetId);
        // 整份重建后按「没有行」走：`!existing || force` 在 append+force 时会重复插主键
        existing = null;
      }

      // append 到已有会话时沿用盘上已有的标题：源侧读回来的标题是首条用户文本推的，
      // 拿它覆盖会把宿主生成/用户改过的名字降级（record_json 是宿主的列表快照，同样算标题落点）
      const keptTitle = existing && mode === 'append' ? existingTitleOf(existing) : '';
      const record = {
        sessionId: String(targetId),
        agentName: LISTABLE.agent_name,
        workspaceDir: workspace,
        runtime: LISTABLE.runtime,
        sessionType: LISTABLE.session_type,
        status: LISTABLE.status,
        title: fitTitleFor('minimax', keptTitle || session.title).value,
        createdAt: createdAt,
        updatedAt: updatedAt,
        ...(session.model ? { model: session.model } : {}),
      };
      const extra = provenance ? { 'session-sync': provenance } : {};

      // 先把轮次转成帧（纯函数）：文件载体与 DB 行载体共用同一批帧。
      // 一轮一个 turn_id，这一轮的所有消息共享它（宿主原生行就是这个形状）。
      const prepared = [];
      let turnSeq = 0;
      for (const turn of turns) {
        const frames = turnToMessageFrames(turn);
        if (!frames.length) continue;
        const turnId = `turn_${String(turnSeq).padStart(4, '0')}_${newNodeId()}`;
        turnSeq += 1;
        const ts = Number(turn.startedAt) || updatedAt;
        prepared.push({ frames, turnId, ts, summary: standaloneSummary(turn),
          records: frames.flatMap((frame) => frameToHistoryLines(frame, turnId, ts)) });
      }

      // 宿主已有 messages.jsonl → 追加写进文件（reader 首选源），不再插 DB 行避免双份
      const histFile = mode === 'append' ? historyFileOf(ctx, db, targetId) : null;
      const currentHistory = histFile ? readMinimaxHistory(path.dirname(histFile)) : null;
      if (currentHistory?.error) throw new Error(currentHistory.error);
      const useNative = (currentHistory?.native || prepared.some((group) => group.summary !== undefined)) && nativeEnabled;
      if (currentHistory?.native && !useNative) throw new Error('minimax-native-history-write-unverified');
      if (existing && mode === 'append' && !histFile && useNative) throw new Error('minimax-canonical-history-required');
      const nativePlan = useNative ? planMinimaxHistory(currentHistory?.active ?? [], prepared) : null;
      for (const [offset, turn] of turns.entries()) {
        if (turn.items?.some((item) => item.compact) && (!nativePlan || standaloneSummary(turn) === undefined)) {
          warnings.push('minimax-compaction-tagged: turn ' + (offset + fromTurnIndex + 1));
        }
      }

      // 新建会话：自己落一份宿主规范历史文件。
      // 不落的后果：宿主物化器只发布**空文件**，空文件成为正文首选源 → 导入正文在界面上消失。
      // 落盘失败则退回 DB 行载体，并把 history_relative_dir 留 NULL 交给宿主绑定。
      if (!existing) {
        if (liveTarget) {
          const dir = path.join(root, historyRelativeDir(targetId, createdAt));
          if (fs.existsSync(dir)) throw new Error('minimax-existing-canonical-history');
          let parent = path.dirname(dir);
          while (!fs.existsSync(parent)) parent = path.dirname(parent);
          const expected = path.join(fs.realpathSync(root), path.relative(root, parent));
          if (cmpPath(fs.realpathSync(parent)) !== cmpPath(expected)) throw new Error('minimax-live-probe-redirected-history');
        }
        const lines = prepared.flatMap(({ records }) => records);
        const ch = writeCanonicalHistory(ctx, {
          sessionId: String(targetId),
          createdAtMs: createdAt,
          updatedAtMs: updatedAt,
          lines,
          nativePlan,
        });
        if (!ch.ok && (nativePlan || ch.error.includes('minimax-existing-native-history'))) throw new Error(ch.error);
        if (ch.ok) {
          canonicalRel = ch.relativeDir;
          warnings.push(`canonical-history: ${ch.dir}`);
          // 来源标记的第二个落点：宿主会重写 extra_data_json，sidecar 才是活过那次重写的那一份
          const sc = nativePlan ? null : writeProvenanceSidecar(ch.dir, provenance);
          if (sc) warnings.push(`provenance-sidecar: ${sc}`);
        } else {
          warnings.push(ch.error);
        }
      }

      if (!existing) {
        // 显式列表 + 等长占位符：手写 ? 数很容易与列数错位（SQLite 只报「N values for M columns」）
        // 列名与值一一对应；按库里**实际存在**的列过滤（与 workbuddy 索引同一口径）——
        // 宿主换版本增删列时，硬编码列名会整条 INSERT 失败（行写不进去）。
        const all = [
          ['session_id', String(targetId)],
          ['record_json', JSON.stringify(record)],
          ['updated_at_ms', updatedAt],
          ['columnar_version', LISTABLE.columnar_version],
          ['agent_name', LISTABLE.agent_name],
          ['runtime', LISTABLE.runtime],
          ['session_type', LISTABLE.session_type],
          ['status', LISTABLE.status],
          ['archived', 0],
          ['visibility', LISTABLE.visibility],
          ['session_kind', LISTABLE.session_kind],
          ['purpose', ''],
          ['purpose_kind', ''],
          ['origin_cron_id', null],
          ['parent_session_id', null],
          ['workspace_dir', workspace],
          ['project_workspace_dir', workspace],
          ['is_default_workspace', isDefault],
          ['title', fitTitleFor('minimax', record.title).value],
          ['created_at_ms', createdAt],
          ['error_message', null],
          ['error_code', null],
          ['extra_data_json', JSON.stringify(extra)],
          ['history_relative_dir', canonicalRel],
        ];
        const ins = insertRowFiltered(db, 'local_runtime_sessions', all, { ifEmpty: 'skip' });
        if (!ins.ok || !ins.inserted) return { ok: false, error: 'local_runtime_sessions-table-absent', targetId, warnings };
      } else {
        // append 也要跟着落点走：workspace / is_default_workspace 变了，行不能还钉在旧桶/旧项目
        const scols = tableColumns(db, 'local_runtime_sessions');
        // append **不动标题**：读回来的 session.title 是从首条用户文本推的，
        // 拿它覆盖会把宿主自己生成的更好的名字降级成半句话（标题同步走 syncTitle 专用通道）。
        // 连「把旧值写回去」都不做：用户改名可能只落在 record_json 里，写回 title 列
        // 等于用另一个落点的值顶掉他的决定（zcode 栽过同一个坑，m69 抓到）。
        const sets = [
          ['updated_at_ms', updatedAt],
          ['record_json', JSON.stringify(record)],
          ['extra_data_json', JSON.stringify(extra)],
        ];
        if (scols.includes('workspace_dir')) {
          sets.push(['workspace_dir', workspace], ['project_workspace_dir', workspace], ['is_default_workspace', isDefault]);
          const pid = ensureProjectRow(db, { workspace, isDefault, createdAt, updatedAt });
          if (pid != null && scols.includes('project_id')) sets.push(['project_id', pid]);
        }
        updateRowFiltered(db, 'local_runtime_sessions', sets, { session_id: String(targetId) });
      }

      // 正文载体：
      //   · 新建 → **两处都写**：规范历史文件（宿主看的那份）+ DB 行（我们自己的无损副本，
      //     带 session-sync-content 全量部件；文件里放不下这个槽）。文件是首选源，DB 行是兜底。
      //   · 追加进已有文件 → 只写文件：文件已是首选源，再插 DB 行会双份。
      const histLines = [];
      for (const { frames, turnId, ts, records } of prepared) {
        if (histFile) {
          histLines.push(...records);
          inserted += records.length;
          continue;
        }
        for (const f of frames) {
          const rowAll = messageRowOf(f, { turnId, ts, targetId });
          const rowIns = insertRowFiltered(db, 'local_runtime_message_rows', rowAll, { ifEmpty: 'skip' });
          if (!rowIns.ok || !rowIns.inserted) continue;
          inserted++;
        }
      }
      if (nativePlan && (canonicalRel || histLines.length)) {
        const dir = histFile ? path.dirname(histFile) : path.join(root, canonicalRel);
        publishing = true;
        stageMinimaxPublication(db, file, root, {
          id: targetId,
          relativeDir: canonicalRel ?? path.relative(root, dir).split(path.sep).join('/'),
          expected: currentHistory ? minimaxRevision(currentHistory.active) : null,
          plan: nativePlan,
          provenance,
        });
        const readback = verifyImported({ readSession: () => ({ turns: readPublishedMinimaxTurns(dir) }),
          variant: 'minimax', sessionId: targetId, expectSource: session, mode, fromTurnIndex });
        if (!readback.ok) throw new Error('minimax-native-readback-failed: ' + readback.reason);
      } else if (canonicalRel) {
        const active = prepared.flatMap(({ records }) => records);
        registerMinimaxMaterialization(db, root, { id: targetId, relativeDir: canonicalRel,
          revision: minimaxRevision(active), messageCount: active.length });
      }
      db.exec('COMMIT');
      if (publishing) recoverMinimaxPublications(db, file, root, targetId);
      if (histFile && histLines.length) {
        // 走 base 的单次 O_APPEND 原子追加：裸 appendFileSync 在多行时可能被宿主读到半截 JSON 行，
        // 而这一行正是宿主下一轮的上下文输入
        if (!nativePlan) appendFileAtomic(histFile, histLines.map((line) => JSON.stringify(line) + '\n').join(''));
        warnings.push(`append-history-file: ${histFile}`);
        // 追加时同样刷新 sidecar：宿主的 extra_data_json 随时可能被重写，sidecar 是兜底那份
        const sc = nativePlan ? null : writeProvenanceSidecar(path.dirname(histFile), provenance);
        if (sc) warnings.push(`provenance-sidecar: ${sc}`);
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      if (publishing) {
        try { recoverMinimaxPublications(db, file, root, targetId); }
        catch (recovery) { warnings.push('minimax-publication-recovery-failed: ' + recovery.message); }
      }
      return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, targetId, warnings };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    if (isDefault && !canonicalRel) {
      // 规范历史文件没落成（宿主侧仍可物化，但正文会先被空文件遮住）：把宿主将用的目录告诉调用方
      warnings.push(`history-dir-for-host: ${historyRelativeDir(targetId, createdAt)}（该列留 NULL，由宿主物化时绑定）`);
    }
    return { ok: true, targetId, path: file, lines: inserted, mode, warnings, directory: workspace };
  },
};
