// writers/opencode-classic.mjs — 写 OpenCode 血统三表（session + message + part）：MiMo Code
//
// session.permission 是 provenance 的自然槽位（JSON）
// message.data = {role, time:{created}, agent, model:{providerID,modelID}}
// part.data    = {type:'text'|'reasoning'|'tool', ...}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { VARIANTS } from '../hosts.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import { insertRowFiltered, newNodeId,
  outputText, slugOf, updateRowFiltered } from './base.mjs';
import { tableExists, firstExisting, tableColumns, TOOL_RESULT_ONLY } from '../readers/base.mjs';
import { isFile } from '../util.mjs';
import { candidateRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { insertProjectRow, ensureGlobalProject, GLOBAL_PROJECT } from './project.mjs';

function dbFile(ctx, variant) {
  const hit = firstExisting(candidateRoots(variant, ctx).filter((x) => x.kind === 'file'));
  return hit?.path ?? null;
}

// 一轮 turn → [{message:{role,ts,data}, parts:[{type,ts,data}]}]
export function turnToMessages(turn, session) {
  const items = turn.items ?? [];
  const tsOf = (it) => it.ts || session.updatedAt || session.createdAt;
  // 一轮的用户文本全部收进轮首的一条 user 消息：读侧「一条 user 消息 = 一轮」，
  // 用户文本与 reasoning/工具在同一轮里交错出现时逐条发出会把一轮拆成多轮
  const userParts = items
    .filter((it) => it.kind === 'message' && it.role === 'user')
    .map((it) => ({ type: 'text', ts: tsOf(it), data: { type: 'text', text: it.text } }));
  const out = userParts.length ? [{ role: 'user', ts: userParts[0].ts, parts: userParts }] : [];
  let parts = null;
  let partTs = 0;
  const role = 'assistant';
  const flush = () => {
    if (parts && parts.length) out.push({ role, ts: partTs, parts });
    parts = null;
  };
  const pushPart = (p, ts) => {
    if (!parts) {
      parts = [];
      partTs = ts;
    }
    parts.push(p);
  };
  const toolParts = new Map();

  for (const it of items) {
    if (it.kind === 'message' && it.role === 'user') continue;
    const ts = tsOf(it);
    switch (it.kind) {
      case 'message':
        if (it.text) pushPart({ type: 'text', ts, data: { type: 'text', text: it.text } }, ts);
        break;
      case 'reasoning':
        if (it.text) pushPart({ type: 'reasoning', ts, data: { type: 'reasoning', text: it.text } }, ts);
        break;
      case 'tool_call': {
        const callId = it.callId || newNodeId();
        const data = { type: 'tool', callID: callId, tool: it.name || 'tool', state: { status: 'completed', input: it.input ?? null, output: '' } };
        pushPart({ type: 'tool', ts, data }, ts);
        toolParts.set(callId, data);
        break;
      }
      case 'tool_result': {
        const d = it.callId ? toolParts.get(it.callId) : null;
        if (d) {
          d.state.status = it.status === 'error' ? 'error' : 'completed';
          d.state.output = outputText(it.output) ?? '';
        } else {
          // 孤儿结果：显式标 resultOnly，读侧据此不补 tool_call（输入为 null 的真实调用不会被误伤）
          pushPart({ type: 'tool', ts, data: { type: 'tool', callID: it.callId || newNodeId(), tool: it.name || 'tool', state: { status: it.status ?? 'completed', input: null, output: outputText(it.output) ?? '', [TOOL_RESULT_ONLY]: true } } }, ts);
        }
        break;
      }
      case 'attachment':
        if (it.ref) pushPart({ type: 'file', ts, data: { type: 'file', url: it.ref } }, ts);
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/**
 * 通用归属（opencode v1 / kilo 等 OpenCode 血统）：按 worktree 找最新的 project 行，没有就新建一条。
 * project_id 带真 FK，查不到也必须落一条真实行，否则 INSERT 直接失败。
 */
function ensureProject(db, directory) {
  const dir = String(directory ?? '');
  if (!dir) return ensureGlobalProject(db);
  try {
    const hit = db.prepare('SELECT id FROM project WHERE worktree = ? ORDER BY time_updated DESC LIMIT 1').get(dir);
    if (hit?.id) return String(hit.id);
    const id = newNodeId();
    if (insertProjectRow(db, id, dir)) return id;
  } catch {
    /* 建不了 project 行（老库/权限）→ 退回 global */
  }
  return ensureGlobalProject(db);
}

/**
 * 当前目录的 git 目录、common dir 与仓库根；`unavailable` = 目录里有 .git 但 git 读不动（不认这个仓库）。
 * linked worktree 实测（2026-10-29）：宿主把 mimocode-project-id 写在 **common dir**（<main>/.git），
 * 不是 per-worktree 的 .git/worktrees/<name>。
 */
function gitInfoOf(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const [gitDir, commonRaw, top] = String(r.stdout).split('\n').map((x) => x.trim()).filter(Boolean);
      if (gitDir) {
        const commonDir = commonRaw ? (path.isAbsolute(commonRaw) ? commonRaw : path.resolve(dir, commonRaw)) : gitDir;
        return { gitDir, commonDir, worktree: top || dir };
      }
    }
  } catch {
    /* 没有 git 可执行文件 */
  }
  return { unavailable: fs.existsSync(path.join(dir, '.git')) };
}

/**
 * MiMo 的项目归属是宿主的「id 文件」契约（本机实测 + 二进制取证 2026-10-28）：
 *   - 非 git 目录 → `global`（宿主列表在非项目目录下只返回 global 会话）
 *   - git 仓库   → `<gitdir>/mimocode-project-id`（36 字节 uuid、不带换行；没有时宿主会生成并写入）
 * 只按 worktree 匹配/新建随机行会让写进去的会话在宿主列表里永远不出现 —— 列表是按 project 过滤的。
 */
function mimoProjectId(db, directory, warnings) {
  const dir = String(directory ?? '');
  if (!dir) return ensureGlobalProject(db);
  const info = gitInfoOf(dir);
  if (!info.gitDir) {
    if (info.unavailable) {
      warnings.push(`mimo-git-unavailable: ${dir} 有 .git 但 git 读不动（safe.directory / 仓库损坏？）→ 退回 global，宿主可能不列这条`);
    }
    return ensureGlobalProject(db);
  }
  const idFile = path.join(info.commonDir, 'mimocode-project-id');
  const legacyFile = info.gitDir !== info.commonDir ? path.join(info.gitDir, 'mimocode-project-id') : null;
  let id = '';
  for (const candidate of [idFile, legacyFile].filter(Boolean)) {
    try {
      id = fs.readFileSync(candidate, 'utf8').trim();
      if (id) break;
    } catch {
      /* 没有就按宿主契约生成 */
    }
  }
  if (!id) {
    id = newNodeId();
    try {
      fs.mkdirSync(path.dirname(idFile), { recursive: true });
      // 宿主写的是 36 字节（uuid 原样、无换行）；wx 保证不覆盖宿主/别人刚建的文件
      fs.writeFileSync(idFile, id, { encoding: 'utf8', flag: 'wx' });
      warnings.push(`mimo-project-id-created: ${idFile}（宿主按这个文件认项目）`);
    } catch (err) {
      if (err?.code === 'EEXIST') {
        try {
          id = fs.readFileSync(idFile, 'utf8').trim();
        } catch {
          id = '';
        }
      }
      if (!id) {
        warnings.push(`mimo-project-id-unwritable: ${idFile}（${String(err?.message ?? err)}）→ 退回 global`);
        return ensureGlobalProject(db);
      }
    }
  }
  if (!db.prepare('SELECT id FROM project WHERE id = ?').get(id)) insertProjectRow(db, id, info.worktree, { vcs: 'git' });
  return id;
}

/** 变体分派：只有 MiMo 有 id 文件契约，其余 OpenCode 血统仍按 worktree 归属 */
function projectIdFor(db, variant, directory, warnings = []) {
  return variant === 'mimo' ? mimoProjectId(db, directory, warnings) : ensureProject(db, directory);
}

// version 要跟宿主同形态：现网全是 desktop-<git7>，我们写 session-sync/1 会和真实值混在一起。
// 取库里最近一条非导入行的 version；取不到才用自己的标记。
function hostVersion(db) {
  try {
    const row = db.prepare("SELECT version FROM session WHERE version IS NOT NULL AND version <> 'session-sync/1' ORDER BY time_updated DESC LIMIT 1").get();
    if (row?.version) return String(row.version);
  } catch {
    /* 老库无该列 */
  }
  return 'session-sync/1';
}

export function createOpencodeClassicWriter({ variant }) {
  return {
    variant,
    label: VARIANTS[variant].label,

    /**
     * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
     * 这一族的标题住在 db 的 session.title 列。
     */
    syncTitle: makeTitleSyncer((ctx) => [
      { kind: 'db-column', db: (c) => dbFile(c, variant), table: 'session', idCol: 'id', col: 'title' },
    ], variant),

    canWrite(ctx) {
      const f = dbFile(ctx, variant);
      return f && isFile(f) ? { ok: true } : { ok: false, reason: 'db-not-found' };
    },

    write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
      const warnings = [];
      const file = dbFile(ctx, variant);
      if (!file || !isFile(file)) return { ok: false, error: 'db-not-found' };

      const db = new DatabaseSync(file);
      try {
        try {
          db.exec('PRAGMA busy_timeout = 8000');
        } catch {
          /* ignore */
        }
        if (!tableExists(db, 'session') || !tableExists(db, 'message')) return { ok: false, error: 'session-or-message-missing' };
        db.exec('BEGIN IMMEDIATE');
        const hasPart = tableExists(db, 'part');

        const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
        const now = Date.now();
        let existing = db.prepare('SELECT id FROM session WHERE id = ?').get(targetId);

        if (existing && mode !== 'append') {
          if (!force) return { ok: false, error: 'target-exists', targetId, warnings };
          if (hasPart) db.prepare('DELETE FROM part WHERE session_id = ?').run(targetId);
          db.prepare('DELETE FROM message WHERE session_id = ?').run(targetId);
          db.prepare('DELETE FROM session WHERE id = ?').run(targetId);
          // 行已删：必须按「没有行」重插，否则只剩消息行成孤儿（列表里没有这条会话）
          existing = null;
        }

        if (!existing) {
          const projectId = projectIdFor(db, variant, session.cwd || '', warnings);
          const permission = provenance ? JSON.stringify({ 'session-sync': provenance }) : null;
          // 按库里实际存在的列裁剪（与 workbuddy 索引 / minimax / opencode 同一口径）：
          // 宿主换版本增删列时，硬编码列名会整条 INSERT 失败（行写不进去）。
          const all = [
            ['id', targetId],
            ['project_id', projectId],
            ['parent_id', null],
            ['slug', slugOf(session.title)],
            ['directory', session.cwd || ''],
            ['title', session.title || 'imported session'],
            ['version', hostVersion(db)],
            ['permission', permission],
            ['time_created', session.createdAt || now],
            ['time_updated', session.updatedAt || now],
          ];
          const ins = insertRowFiltered(db, 'session', all, { ifEmpty: 'skip' });
          if (!ins.ok || !ins.inserted) return { ok: false, error: 'session-table-absent', targetId, warnings };
        }

        if (mode !== 'append') {
          if (hasPart) db.prepare('DELETE FROM part WHERE session_id = ?').run(targetId);
          db.prepare('DELETE FROM message WHERE session_id = ?').run(targetId);
        }

        let inserted = 0;
        const providerID = 'session-sync';
        const modelID = session.model || 'unknown';
        // 读侧按 `time_created, id` 排序；同一毫秒内多个 part 若用随机 id 会顺序不稳，
        // 因此 id 带零填充序号，保证「同一时间戳内按写入顺序」稳定可复现。
        let seq = 0;
        // 读侧按 (time_created, id) 排序，而源里同一轮的部件时间戳并不单调
        // （宿主按消息分组，我们合并成一条消息后全局排序就会重排）。
        // 写入时把时间戳钳成「不低于前一条」，同值再靠零填充 id 定序 → 读回顺序 = 写入顺序。
        let lastMsgTs = 0;
        let lastPartTs = 0;
        const nextId = (prefix) => `${prefix}_${String(seq++).padStart(8, '0')}_${newNodeId().replace(/-/g, '').slice(0, 12)}`;
        for (const turn of turns) {
          for (const msg of turnToMessages(turn, session)) {
            const msgId = nextId('msg');
            const msgTs = Math.max(Number(msg.ts) || 0, lastMsgTs);
            lastMsgTs = msgTs;
            const msgAll = [
              ['id', msgId],
              ['session_id', targetId],
              ['agent_id', 'main'],
              ['time_created', msgTs],
              ['time_updated', msgTs],
              ['data', JSON.stringify({
                role: msg.role,
                time: { created: msgTs },
                agent: 'build',
                model: { providerID, modelID },
              })],
            ];
            const msgIns = insertRowFiltered(db, 'message', msgAll, { ifEmpty: 'skip' });
            if (!msgIns.ok || !msgIns.inserted) continue;
            inserted++;
            if (!hasPart) continue;
            for (const p of msg.parts) {
              const partTs = Math.max(Number(p.ts) || 0, lastPartTs);
              lastPartTs = partTs;
              const partAll = [
                ['id', nextId('prt')],
                ['message_id', msgId],
                ['session_id', targetId],
                ['time_created', partTs],
                ['time_updated', partTs],
                ['data', JSON.stringify(p.data)],
              ];
              insertRowFiltered(db, 'part', partAll, { ifEmpty: 'skip' });
            }
          }
        }
        if (!hasPart) warnings.push('目标库无 part 表，正文仅存于 message.data');
        // append 也要跟着落点走：--cwd / placement 改了，行不能还钉在旧项目/旧目录
        const sCols = tableColumns(db, 'session');
        const newDir = session.cwd || '';
        const setDir = sCols.includes('directory') && newDir && newDir !== String(existing?.directory ?? '');
        const touch = Math.max(now, session.updatedAt || 0);
        if (setDir) {
          const newProject = projectIdFor(db, variant, newDir, warnings);
          updateRowFiltered(
            db,
            'session',
            [
              ['time_updated', touch],
              ['directory', newDir],
              ['project_id', newProject],
              ['path', newDir],
            ],
            { id: targetId },
          );
        } else {
          updateRowFiltered(db, 'session', [['time_updated', touch]], { id: targetId });
        }
        db.exec('COMMIT');

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
          /* ignore */
        }
        return { ok: false, error: `db-write-failed: ${err?.message ?? err}` };
      } finally {
        db.close();
      }
    },
  };
}
