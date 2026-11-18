// writers/codebuddy.mjs — 写 CodeBuddy Code 原生会话
//
// 产出：<root>/projects/<compressPath(cwd)>/<targetId>.jsonl
// 行：{id, parentId?, timestamp(ms), type:'message', role, content:[block], sessionId, cwd}
//   user: input_text + tool_result（工具回执单独一条 user 项）
//   assistant: thinking / output_text / tool_use
// 标题：{type:'custom-title', customTitle, timestamp, sessionId}（宿主标题事实）
// provenance：sidecar（正文里不塞宿主不认识的行）
import fs from 'node:fs';
import path from 'node:path';
import { codebuddyProjectsRoot } from '../hosts.mjs';
import { writeRootOf } from '../roots.mjs';
import { outputText } from '../text.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import {
  newNodeId,
  writeJsonlFile,
  appendJsonlRebuild,
  backupIfExists,
  resolveSlugDir,
  findExistingByTargetId,
  lastNodeId,
  preflightOverwrite,
  relocateByTargetId,
  parseJsonlStrict,
  unreadableTarget,
} from './base.mjs';

// 宿主 PathUtils.compressPath（dist-server 源码原文）：[/\\:] → '-'，去首尾 '-'，折叠 '-+'；
// 超过 255 字节 → 截到 180 字节（按码点）+ '-' + djb2aBase36(完整规范化名)
const SLUG_MAX = 255;
const SLUG_TRUNC = 180;

function djb2aBase36(input) {
  const buf = Buffer.from(input, 'utf8');
  let hash = 5381;
  for (const b of buf) hash = ((33 * hash) ^ b) >>> 0;
  return hash.toString(36);
}

function truncateUtf8(input, limit) {
  let used = 0;
  let out = '';
  for (const ch of input) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > limit) break;
    used += n;
    out += ch;
  }
  return out;
}

function canonicalPath(cwd) {
  const abs = path.resolve(String(cwd || process.cwd()));
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export function slugForCodebuddy(cwd) {
  const raw = String(cwd ?? '').trim();
  if (!raw) return null;
  const base = canonicalPath(raw)
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  if (Buffer.byteLength(base, 'utf8') <= SLUG_MAX) return base;
  return `${truncateUtf8(base, SLUG_TRUNC)}-${djb2aBase36(base)}`;
}

function projectsRoot(ctx) {
  // 走 role：--data-root / probe 把根搬走后写侧也跟着走（原来直连 codebuddyProjectsRoot，读得到写不回）
  return writeRootOf('codebuddy', ctx, 'projects')?.path ?? codebuddyProjectsRoot(ctx).path;
}

function buildLines(session, turns, targetId, startParentId, opts = {}) {
  const lines = [];
  const cwd = session.cwd || '';
  let parentId = startParentId ?? null;

  const emit = (item) => {
    const id = newNodeId();
    lines.push({ id, parentId, timestamp: item.timestamp, type: 'message', role: item.role, content: item.content, sessionId: targetId, cwd });
    parentId = id;
  };

  for (const turn of turns) {
    let userBlocks = null;
    let userTs = 0;
    let assistantBlocks = null;
    let assistantTs = 0;

    const flushUser = () => {
      if (userBlocks && userBlocks.length) emit({ role: 'user', content: userBlocks, timestamp: userTs });
      userBlocks = null;
    };
    const flushAssistant = () => {
      if (assistantBlocks && assistantBlocks.length) emit({ role: 'assistant', content: assistantBlocks, timestamp: assistantTs });
      assistantBlocks = null;
    };
    const pushUser = (block, ts) => {
      if (!userBlocks) {
        userBlocks = [];
        userTs = ts;
      }
      userBlocks.push(block);
    };
    const pushAssistant = (block, ts) => {
      if (!assistantBlocks) {
        assistantBlocks = [];
        assistantTs = ts;
      }
      assistantBlocks.push(block);
    };

    for (const it of turn.items ?? []) {
      const ts = it.ts || session.updatedAt || session.createdAt || Date.now();
      const isUserText = it.kind === 'message' && it.role === 'user';
      if (isUserText) {
        // 同一轮的连续用户文本并进同一条 user 项：逐条发会把一轮拆成多轮
        flushAssistant();
        if (it.text) pushUser({ type: 'input_text', text: it.text }, ts);
        continue;
      }
      if (it.kind !== 'tool_result') flushUser();
      switch (it.kind) {
        case 'message':
          if (it.text) pushAssistant({ type: 'output_text', text: it.text }, ts);
          break;
        case 'reasoning':
          if (it.text) pushAssistant({ type: 'thinking', thinking: it.text }, ts);
          break;
        case 'tool_call':
          pushAssistant({ type: 'tool_use', id: it.callId || newNodeId(), name: it.name || 'tool', input: it.input ?? {} }, ts);
          break;
        case 'tool_result':
          flushAssistant();
          emit({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: it.callId || null, content: [{ type: 'text', text: outputText(it.output) ?? '' }], is_error: it.status === 'error' }],
            timestamp: ts,
          });
          break;
        case 'attachment':
          if (it.ref) pushAssistant({ type: 'output_text', text: `[attachment] ${it.ref}` }, ts);
          break;
        default:
          break;
      }
    }
    flushUser();
    flushAssistant();
  }

  // append 不写标题：读侧 custom-title 是「最后一条胜出」，追加时再塞一行等于把
  // 宿主/用户已经有的名字顶掉（标题同步有专门通道 syncTitle，那里才判断该不该改）
  if (session.title && opts.withTitle !== false) {
    lines.push({ type: 'custom-title', customTitle: session.title, timestamp: session.updatedAt || session.createdAt || Date.now(), sessionId: targetId });
  }
  return lines;
}

function readTargetLines(file) {
  if (!fs.existsSync(file)) return { ok: true, lines: [] };
  return parseJsonlStrict(fs.readFileSync(file, 'utf8'));
}

export const codebuddyWriter = {
  variant: 'codebuddy',
  label: 'CodeBuddy Code',

  canWrite() {
    return { ok: true };
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
   * codebuddy 的标题是正文里的 custom-title 行（宿主标题事实，见文件头注释）。
   */
  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'body-row', file: (c, targetId) => {
      const root = projectsRoot(c);
      return root ? findExistingByTargetId(root, String(targetId)) : null;
    }, type: 'custom-title', field: 'customTitle' },
  ], 'codebuddy'),

  targetPath(ctx, session, targetId) {
    const slug = slugForCodebuddy(session.cwd);
    if (!slug) return null;
    const root = projectsRoot(ctx);
    const found = findExistingByTargetId(root, targetId);
    if (found) return found;
    return path.join(resolveSlugDir(root, slug), `${targetId}.jsonl`);
  },

  relocate(ctx, { targetId, directory }) {
    const slug = slugForCodebuddy(directory);
    if (!slug) return { ok: false, error: 'cwd-required', moved: false, path: null, warnings: [] };
    const root = projectsRoot(ctx);
    const dir = resolveSlugDir(root, slug);
    const r = relocateByTargetId(root, targetId, dir, { ctx, variant: 'codebuddy' });
    return { ok: true, moved: r.moved, path: r.path, warnings: r.warning ? [r.warning] : [] };
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const slug = slugForCodebuddy(session.cwd);
    if (!slug) return { ok: false, error: 'cwd-required: 空 cwd 无法确定 CodeBuddy 项目目录', targetId, warnings };
    const root = projectsRoot(ctx);
    const dir = resolveSlugDir(root, slug);
    const reloc = relocateByTargetId(root, targetId, dir, { ctx, variant: 'codebuddy' });
    if (reloc.moved) warnings.push(reloc.warning);
    const file = reloc.path ?? path.join(dir, `${targetId}.jsonl`);
    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);

    if (mode === 'append') {
      const prev = readTargetLines(file);
      if (!prev.ok) return { ok: false, error: unreadableTarget(file, prev.reason), path: file, targetId, warnings };
      const backup = backupIfExists(file, ctx, 'codebuddy');
      let warnedEmpty = false;
      const res = appendJsonlRebuild(file, () => {
        if (fs.existsSync(file) && fs.statSync(file).size === 0 && !warnedEmpty) {
          warnings.push('目标文件为空，追加将缺少会话头');
          warnedEmpty = true;
        }
        return buildLines(session, turns, targetId, lastNodeId(file, 'id'), { withTitle: false });
      });
      if (provenance) writeSidecarProvenance(file, provenance);
      return { ok: true, targetId, path: file, lines: res.lines, mode, backup, warnings, concurrentRetries: res.concurrentRetries };
    }

    const pre = preflightOverwrite(file, { force, read: readTargetLines });
    if (pre) return { ok: false, ...pre, path: file, targetId, warnings };
    const lines = buildLines(session, turns, targetId, null);
    const backup = backupIfExists(file, ctx, 'codebuddy');
    writeJsonlFile(file, lines);
    if (provenance) writeSidecarProvenance(file, provenance);
    return { ok: true, targetId, path: file, lines: lines.length, mode, backup, warnings };
  },
};
