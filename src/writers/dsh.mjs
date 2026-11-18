// writers/dsh.mjs — 写 DSH (DeepSeek Harness) 原生会话
//
// 产出：<root>/sessions/<slug>/<targetId>/
//   session.v4.jsonl.zstd   多帧 zstd 拼接（每事件一帧，与宿主一致）
//   provenance.session-sync.json  provenance sidecar（reader 同位置读取）
// 事件：session(头) / session/title / user/message / assistant/message / tool/result
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeSidecarProvenance } from '../provenance.mjs';
import { newNodeId, backupIfExists, writeFileAtomic, parseJsonlStrict, unreadableTarget,
  findExistingByTargetId, relocateByTargetId,
  resolveFieldPath, outputText,
} from './base.mjs';
import { decodeZstdFramesAll } from '../readers/dsh.mjs';
import { ensureDir, isDir } from '../util.mjs';
import { roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';

function sessionsRoot(ctx) {
  return roleRoots('dsh', ctx, 'sessions')[0]?.path ?? null;
}

// DSH 实测（~/.dsh/sessions/--D-00-demo-app--）：冒号被**丢弃**，/ 与 \ 变成 -。
// 与 Pi 只差在冒号（同一 cwd 下 pi 是 --D--00-demo-app--），所以两家不能共用一个函数。
// 其余字符本机无带 . / _ / 空格的现网样本可取证，按实测保守只动这三类。
function slugForDsh(cwd) {
  const c = String(cwd ?? '').trim();
  if (!c) return null;
  return `--${c.replace(/:/g, '').replace(/[/\\]/g, '-')}--`;
}

// 一轮 turn → 事件体（不含 seq/time，由调用方补）
function turnToEvents(turn, session, turnIndex) {
  const events = [];
  let step = 0;
  let content = null;
  let contentTs = 0;
  let userBlocks = null;
  let userTs = 0;
  const flushAssistant = () => {
    if (content && content.length) {
      events.push({
        type: 'assistant/message',
        time: contentTs,
        data: {
          turn: turnIndex + 1,
          step,
          message: {
            role: 'assistant',
            content,
            source: { kind: 'model', provider: 'session-sync', model: session.model || 'unknown' },
          },
        },
      });
      step++;
    }
    content = null;
  };
  // 读侧「一条 user/message = 一轮」，而宿主把同一轮的多个文本块放在一条事件里。
  // 逐块各发一条会把一轮拆成多轮 → 同变体副本读出更多轮 → 续写误判成分叉。
  const flushUser = () => {
    if (userBlocks && userBlocks.length) {
      events.push({
        type: 'user/message',
        time: userTs,
        data: { content: userBlocks, source: { kind: 'user' }, role: 'user', id: newNodeId() },
      });
    }
    userBlocks = null;
  };
  const pushUser = (c, ts) => {
    if (!userBlocks) {
      userBlocks = [];
      userTs = ts;
    }
    userBlocks.push(c);
  };
  const pushContent = (c, ts) => {
    flushUser();
    if (!content) {
      content = [];
      contentTs = ts;
    }
    content.push(c);
  };
  const toolResults = [];

  for (const it of turn.items ?? []) {
    const ts = it.ts || session.updatedAt || session.createdAt;
    if (it.kind === 'message' && it.role === 'user') {
      flushAssistant();
      pushUser({ type: 'text', text: it.text }, ts);
      continue;
    }
    switch (it.kind) {
      case 'message':
        if (it.text) pushContent({ type: 'text', text: it.text }, ts);
        break;
      case 'reasoning':
        if (it.text) pushContent({ type: 'reasoning', text: it.text }, ts);
        break;
      case 'tool_call':
        pushContent({ type: 'tool-call', id: it.callId || newNodeId(), name: it.name || 'tool', arguments: JSON.stringify(it.input ?? {}) }, ts);
        break;
      case 'tool_result':
        flushUser();
        toolResults.push({
          type: 'tool/result',
          time: ts,
          data: {
            message: {
              role: 'tool',
              toolCallId: it.callId || null,
              content: [{ type: 'text', text: outputText(it.output) ?? '' }],
              isError: it.status === 'error',
              id: newNodeId(),
            },
          },
        });
        break;
      case 'attachment':
        if (it.ref) pushContent({ type: 'text', text: `[attachment] ${it.ref}` }, ts);
        break;
      default:
        break;
    }
  }
  flushAssistant();
  flushUser();
  // tool/result 必须紧跟其 assistant/message 之后，保持调用-结果相邻
  events.push(...toolResults);
  return events;
}

function encodeFrames(events) {
  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')));
  return Buffer.concat(frames);
}

// 追加要「整帧重写」：解不开的一律当失败，不能当成空（否则丢掉宿主已有事件）
function readExistingEvents(file) {
  if (!fs.existsSync(file)) return { ok: true, events: [] };
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return { ok: true, events: [] };
  const dec = decodeZstdFramesAll(buf);
  if (!dec.ok) return dec;
  const res = parseJsonlStrict(dec.text);
  if (!res.ok) return res;
  // 有字节却一帧都没解出来 = 解不开，不是「真的没内容」
  if (res.lines.length === 0) return { ok: false, reason: `${buf.length} 字节里没解出任何事件` };
  return { ok: true, events: res.lines };
}

/**
 * 会话正文的真实文件。`findExistingByTargetId` 对 dsh 命中「会话目录」
 * （`<root>/<slug>/<id>/`），正文在目录内固定文件名 —— 上一个版本的槽直接拿目录去
 * 当文件读，永远 file-absent（m61 的自造夹具把它盖住了）。
 */
function zstdBodyFor(ctx, targetId) {
  const root = sessionsRoot(ctx);
  if (!root) return null;
  const found = findExistingByTargetId(root, String(targetId));
  if (!found) return null;
  return isDir(found) ? path.join(found, 'session.v4.jsonl.zstd') : found;
}

/**
 * 正文是 zstd 多帧二进制，通用 JSONL 读写器在这里必然读不出东西。
 * 所以格式知识留在 writer：title-slots 只调 io 钩子，不 import 解帧器
 * （只写不读的宿主不该为了标题同步把 reader 的二进制解析拖进来）。
 */
const dshIo = {
  readFirst(file, type, field) {
    const r = readExistingEvents(file);
    if (!r.ok) return { ok: false, reason: `decode-failed: ${r.reason}` };
    const hit = r.events.find((e) => e?.type === type);
    if (!hit) return { ok: true, found: false, reason: 'row-absent' };
    const p = resolveFieldPath(hit, field);
    if (!p.ok) return { ok: true, found: false, reason: p.reason };
    return { ok: true, found: true, value: p.holder[p.key] };
  },
  /**
   * 写全部同类型行（槽声明 pick:'all'）：读侧按顺序消费、最后一条胜出，
   * 只改第一条在宿主重写过标题后就会「改了但显示旧名」。
   */
  rewriteFirst(file, type, field, value, ctx) {
    let st0;
    try {
      st0 = fs.statSync(file);
    } catch (err) {
      return { changed: false, reason: `stat-failed: ${err?.message ?? err}` };
    }
    const r = readExistingEvents(file);
    if (!r.ok) return { changed: false, reason: `decode-failed: ${r.reason}` };
    let changed = false;
    for (const ev of r.events) {
      if (ev?.type !== type) continue;
      const p = resolveFieldPath(ev, field);
      if (!p.ok) return { changed: false, reason: p.reason };
      if (p.holder[p.key] === value) continue;
      p.holder[p.key] = value;
      changed = true;
    }
    if (!changed) return { changed: false, reason: 'already-equal' };
    const backup = backupIfExists(file, ctx, 'dsh');
    try {
      // 解帧→重编码是整份覆盖，必须带 CAS：否则会抹掉宿主在这期间追加的事件
      writeFileAtomic(file, encodeFrames(r.events), { expectSize: st0.size });
    } catch (err) {
      if (err?.code === 'CONCURRENT_MODIFICATION') return { changed: false, reason: 'concurrent-modification', retryable: true };
      throw err;
    }
    return { changed: true, backup };
  },
};

export const dshWriter = {
  variant: 'dsh',
  label: 'DSH (DeepSeek Harness)',

  canWrite(ctx) {
    return sessionsRoot(ctx) ? { ok: true } : { ok: false, reason: 'sessions-dir-unresolved' };
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
   * dsh 的标题是正文里的 session/title 行，值嵌在 data.title，正文本身是 zstd 多帧。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'body-row', file: zstdBodyFor, type: 'session/title', field: 'data.title', pick: 'all', io: dshIo },
  ], 'dsh'),

  targetPath(ctx, session, targetId) {
    const root = sessionsRoot(ctx);
    const slug = slugForDsh(session.cwd);
    if (!root || !slug) return null;
    const found = findExistingByTargetId(root, targetId);
    return path.join(found ? path.dirname(found) : path.join(root, slug), String(targetId));
  },

  relocate(ctx, { targetId, directory }) {
    const root = sessionsRoot(ctx);
    const slug = slugForDsh(directory);
    if (!root || !slug) return { ok: false, warnings: ['cwd-required: 空落点无法搬迁 dsh 会话目录'] };
    const r = relocateByTargetId(root, targetId, path.join(root, slug), { ctx, variant: 'dsh' });
    return { ok: true, moved: r.moved, path: r.path, warnings: r.warning ? [r.warning] : [] };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const root = sessionsRoot(ctx);
    if (!root) return { ok: false, error: 'sessions-dir-unresolved' };
    const dshSlug = slugForDsh(session.cwd);
    if (!dshSlug) return { ok: false, error: 'cwd-required: 空 cwd 不能落进宿主不会列出的 --default-- 目录' };

    // dsh 的正文是「会话目录」，换落点要把整个目录搬走（旧目录留着会被宿主列成两条）
    const slugDir = path.join(root, dshSlug);
    const reloc = relocateByTargetId(root, targetId, slugDir, { ctx, variant: 'dsh' });
    if (reloc.moved) warnings.push(reloc.warning);
    const dir = reloc.path ?? path.join(slugDir, String(targetId));
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);

    let events = [];
    let seq = 0;

    if (mode === 'append') {
      const prev = readExistingEvents(file);
      if (!prev.ok) return { ok: false, error: unreadableTarget(file, prev.reason), path: file, targetId, warnings };
      events = prev.events;
      if (events.length === 0) warnings.push('目标文件为空，追加将缺少 session 头');
      for (const e of events) if (typeof e.seq === 'number' && e.seq >= seq) seq = e.seq + 1;
      for (let i = 0; i < turns.length; i++) {
        for (const ev of turnToEvents(turns[i], session, fromTurnIndex + i)) {
          events.push({ ...ev, seq: seq++ });
        }
      }
    } else {
      if (fs.existsSync(file) && !force) return { ok: false, error: 'target-exists', path: file, targetId, warnings };
      events = [
        {
          type: 'session',
          version: 4,
          id: String(targetId),
          createdAt: session.createdAt || Date.now(),
          cwd: session.cwd || '',
          parentSession: null,
          isSeeded: false,
          delegationDepth: 0,
          agentPreset: 'standard',
          seq: seq++,
        },
        ...(session.title
          ? [{ type: 'session/title', seq: seq++, time: session.createdAt || Date.now(), data: { title: String(session.title), source: { kind: 'fallback' } } }]
          : []),
      ];
      for (let i = 0; i < turns.length; i++) {
        for (const ev of turnToEvents(turns[i], session, i)) {
          events.push({ ...ev, seq: seq++ });
        }
      }
    }

    ensureDir(dir);
    const backup = backupIfExists(file, ctx, 'dsh');
    writeFileAtomic(file, encodeFrames(events));
    if (provenance) writeSidecarProvenance(path.join(dir, 'provenance'), provenance);

    return { ok: true, targetId, path: file, lines: events.length, mode, backup, warnings };
  },
};

export { slugForDsh };
