// writers/antigravity.mjs — 写 Antigravity 桌面 Hub
//
// 落点（与 VARIANTS.antigravity.readPaths 的 role 对应）：
//   hub/conversations/<id>.db          一会话一个 SQLite 库（正文）
//   hub/conversation_summaries.db      侧栏列表源 —— 只写正文库不会出现在 Antigravity 侧栏
//
// 正文不是明文 JSON：steps.step_payload 是按 step_type 分流的 protobuf。这里用
// readers/antigravity-proto.mjs 的编码器生成新库（与读侧共用同一份 schema 取证），
// 并按宿主真机形态补齐 trajectory_meta / trajectory_metadata_blob / 摘要行 / FTS 行。
//
// 只写 Hub（~/.gemini/antigravity）：IDE / backup 下是旧加密 .pb，CLI 库不会被 Hub 侧栏列出。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { roleRoots } from '../roots.mjs';
import { ensureDir, isDir, isFile, uuidv7 } from '../util.mjs';
import { tableExists } from '../readers/base.mjs';
import { insertRowFiltered } from './base.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';
import { writeSidecarProvenance } from '../provenance.mjs';
import {
  STEP_USER, STEP_ASSISTANT, STEP_TOOL, encodeStep, encodeWorkspaceBlob,
  workspaceUriOf,
} from '../readers/antigravity-proto.mjs';

const CONV_TABLES = [
  'CREATE TABLE IF NOT EXISTS `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE IF NOT EXISTS `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE IF NOT EXISTS `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE IF NOT EXISTS `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  `CREATE TABLE IF NOT EXISTS \`steps\` (\`idx\` integer,\`step_type\` integer NOT NULL DEFAULT 0,\`status\` integer NOT NULL DEFAULT 0,
     \`has_subtrajectory\` numeric NOT NULL DEFAULT false,\`metadata\` blob,\`error_details\` blob,\`permissions\` blob,
     \`task_details\` blob,\`render_info\` blob,\`step_payload\` blob,\`step_format\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`))`,
  'CREATE TABLE IF NOT EXISTS `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))',
  `CREATE TABLE IF NOT EXISTS \`trajectory_metadata_blob\` (\`id\` text DEFAULT "main",\`data\` blob,PRIMARY KEY (\`id\`))`,
];

function hubDir(ctx) {
  return roleRoots('antigravity', ctx, 'hub').find((r) => r.kind === 'dir')?.path ?? null;
}
function summaryDb(ctx) {
  return roleRoots('antigravity', ctx, 'aux').find((r) => r.kind === 'file')?.path ?? null;
}
const convFile = (ctx, id) => {
  const d = hubDir(ctx);
  return d ? path.join(d, `${id}.db`) : null;
};

/** 宿主时间串：2026-11-20 08:02:29.0478589+00:00（7 位小数，.NET tick 精度） */
function hostTime(ms) {
  const t = Number(ms) || Date.now();
  return new Date(t).toISOString().replace('T', ' ').replace(/\.(\d{3})Z$/, (_, m) => `.${m}0000+00:00`);
}

function safeId(id) {
  const s = String(id ?? '');
  return /^[A-Za-z0-9_.-]{1,128}$/.test(s) && !s.includes('..') ? s : null;
}

function outputTextOf(item) {
  const o = item?.output;
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') return JSON.stringify(o);
  return '';
}

/**
 * 一个 turn 的 items → 宿主步骤序列。
 * 顺序：user 消息各一步；助手段按 reasoning/message/tool_call 聚合，遇 tool_result
 * 先落一条助手步再落一条 type=132 的工具回执步（与真机 14→15→132→15 的节奏一致）。
 */
function turnSteps(turn, ids) {
  const steps = [];
  const tsOf = (it, fallback) => Number(it?.ts) || fallback;
  // 一轮里多条 user 消息合成一步：宿主一步 = 一轮的用户输入，拆成多步会被读侧
  // 当成多轮（m53：同一轮的第二段文本导致 list/read 从 8 轮变 9 轮）。
  const userTexts = [];
  let userTs = 0;
  for (const it of turn?.items ?? []) {
    if (it?.kind !== 'message' || it.role !== 'user' || !String(it.text ?? '').trim()) continue;
    if (!userTs) userTs = tsOf(it, ids.ts);
    userTexts.push(String(it.text));
  }
  if (userTexts.length) steps.push({ type: STEP_USER, ts: userTs || ids.ts, content: userTexts.join('\n\n') });
  let pending = null;
  const flush = () => {
    if (pending && (pending.content || pending.thinking || pending.toolCalls.length)) steps.push(pending);
    pending = null;
  };
  for (const it of turn?.items ?? []) {
    const ts = tsOf(it, ids.ts);
    if (it?.kind === 'reasoning') {
      pending ??= { type: STEP_ASSISTANT, ts, content: '', thinking: '', toolCalls: [] };
      pending.thinking += (pending.thinking ? '\n' : '') + String(it.text ?? '');
    } else if (it?.kind === 'message' && it.role === 'assistant') {
      pending ??= { type: STEP_ASSISTANT, ts, content: '', thinking: '', toolCalls: [] };
      pending.content += (pending.content ? '\n\n' : '') + String(it.text ?? '');
    } else if (it?.kind === 'tool_call') {
      pending ??= { type: STEP_ASSISTANT, ts, content: '', thinking: '', toolCalls: [] };
      let input = it.input;
      if (input && typeof input === 'object' && Object.keys(input).length === 1 && Object.hasOwn(input, 'value')) input = input.value;
      pending.toolCalls.push({ id: it.callId || `call_${uuidv7()}`, name: it.name || 'tool', input: input ?? null });
    } else if (it?.kind === 'tool_result') {
      flush();
      const tc = { id: it.callId || null, name: it.name || 'tool', input: null };
      steps.push({ type: STEP_TOOL, ts, toolCall: tc, toolOutput: outputTextOf(it) });
    }
  }
  flush();
  return steps;
}

/** 从库里已有摘要挑一个 project_id（同一 workspace 复用，否则新建 UUID） */
function projectIdFor(ctx, cwd, summariesFile) {
  if (isFile(summariesFile)) {
    try {
      const db = new DatabaseSync(summariesFile, { readOnly: true });
      try {
        if (tableExists(db, 'conversation_summaries')) {
          const want = String(cwd || '').replace(/\\/g, '/').toLowerCase();
          for (const r of db.prepare("SELECT workspace_uris, project_id FROM conversation_summaries WHERE project_id <> '' AND project_id <> 'outside-of-project'").all()) {
            // 摘要里两种写法都有：file:///d%3A/00-lk-agent 与 file:///D:/00-lk-agent
            // 不解码就匹配不上，会给同一个工作区再造一个新 project_id
            let uris = String(r.workspace_uris ?? '').replace(/\\/g, '/');
            try {
              uris = decodeURIComponent(uris);
            } catch { /* 保留原样 */ }
            if (want && uris.toLowerCase().includes(want)) return String(r.project_id);
          }
        }
      } finally {
        db.close();
      }
    } catch { /* ignore */ }
  }
  return uuidv7();
}

export const antigravityWriter = {
  variant: 'antigravity',
  label: 'Antigravity',

  canWrite(ctx) {
    const d = hubDir(ctx);
    const s = summaryDb(ctx);
    if (!d || !isDir(d) || !s || !isFile(s)) {
      return { ok: false, reason: 'hub-store-absent: 需要 ~/.gemini/antigravity/conversations 与 conversation_summaries.db' };
    }
    return { ok: true };
  },

  targetPath(ctx, session, targetId) {
    const f = convFile(ctx, targetId);
    return f ? `${f}#${targetId}` : null;
  },

  syncTitle: makeTitleSyncer((ctx) => [
    { kind: 'db-column', db: (c) => summaryDb(c), table: 'conversation_summaries', idCol: 'conversation_id', col: 'title', maxLen: TITLE_MAX.antigravity },
  ], 'antigravity'),

  write(ctx, { session, targetId, mode = 'create', fromTurnIndex = 0, provenance, force = false } = {}) {
    const warnings = [];
    const id = safeId(targetId);
    if (!id) return { ok: false, error: 'invalid-target-id' };
    const dir = hubDir(ctx);
    const sums = summaryDb(ctx);
    if (!dir || !sums || !isDir(dir) || !isFile(sums)) return { ok: false, error: 'hub-store-absent' };
    const file = convFile(ctx, id);
    const exists = isFile(file);
    if (exists && mode !== 'append' && !force) return { ok: false, error: 'target-exists', targetId: id };

    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const now = Date.now();
    const createdAt = Number(session.createdAt) || now;
    const updatedAt = Number(session.updatedAt) || createdAt;
    const title = fitTitleFor('antigravity', session.title).value || 'imported session';
    const cwd = String(session.cwd ?? '');
    const directory = cwd || path.join(path.dirname(dir), 'antigravity-imports');
    try {
      ensureDir(directory);
    } catch (err) {
      warnings.push(`mkdir-failed: ${String(err?.message ?? err)}`);
    }
    const baseTime = mode === 'append' ? updatedAt : createdAt;
    const ids = { ts: baseTime };
    const steps = [];
    for (const turn of turns) {
      for (const st of turnSteps(turn, ids)) steps.push({ ...st, ts: st.ts || baseTime });
    }
    if (!steps.length) return { ok: false, error: 'no-content', targetId: id };

    const userId = uuidv7();
    const projectId = projectIdFor(ctx, directory, sums);
    let trajectoryId = uuidv7();

    let db;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 8000');
      db.exec('BEGIN IMMEDIATE');
      for (const sql of CONV_TABLES) db.exec(sql);

      if (exists && mode !== 'append') {
        db.exec('DELETE FROM steps');
        db.exec('DELETE FROM trajectory_meta');
        db.exec('DELETE FROM trajectory_metadata_blob');
      }
      if (mode === 'append' && tableExists(db, 'trajectory_meta')) {
        const prev = db.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get();
        if (prev?.trajectory_id) trajectoryId = String(prev.trajectory_id);
      }
      if (!tableExists(db, 'trajectory_meta')) {
        // 理论上不会发生（CONV_TABLES 已建），留一道兜底防止老库结构不同
        db.exec('CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id))');
      }
      db.prepare('DELETE FROM trajectory_meta WHERE trajectory_id = ?').run(trajectoryId);
      db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?,?,?,?)')
        .run(trajectoryId, id, 4, 1);

      let idx = 0;
      if (mode === 'append' && tableExists(db, 'steps')) {
        const row = db.prepare('SELECT COALESCE(MAX(idx), -1) AS m FROM steps').get();
        idx = Number(row?.m ?? -1) + 1;
      } else {
        db.exec('DELETE FROM steps');
      }
      for (const st of steps) {
        const enc = encodeStep({
          type: st.type,
          ts: st.ts,
          trajectoryId,
          cascadeId: id,
          userId,
          content: st.content,
          thinking: st.thinking,
          toolCalls: st.toolCalls,
          toolCall: st.toolCall,
          toolOutput: st.toolOutput,
        });
        const r = insertRowFiltered(db, 'steps', {
          idx,
          step_type: st.type,
          status: 3,
          has_subtrajectory: 0,
          metadata: enc.metadata,
          step_payload: enc.step_payload,
          step_format: 0,
        });
        if (!r.ok) throw new Error(r.error);
        idx++;
      }

      const blob = encodeWorkspaceBlob({
        uris: [workspaceUriOf(directory)],
        cascadeId: id,
        projectId,
        userId,
        ts: updatedAt,
      });
      db.prepare('DELETE FROM trajectory_metadata_blob WHERE id = ?').run('main');
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', blob);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db?.exec('ROLLBACK');
      } catch { /* ignore */ }
      try {
        db?.close();
      } catch { /* ignore */ }
      return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, targetId: id, warnings };
    } finally {
      try {
        db?.close();
      } catch { /* ignore */ }
    }

    // 侧栏列表源：写在正文库之后，失败要让调用方看见（正文在、侧栏看不见最难排查）
    const sd = new DatabaseSync(sums);
    try {
      sd.exec('PRAGMA busy_timeout = 8000');
      sd.exec('BEGIN IMMEDIATE');
      const firstUser = (session.turns ?? []).find((t) => t.role === 'user');
      const preview = String(firstUser?.items?.find((i) => i?.kind === 'message' && i.role === 'user')?.text ?? title)
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      const uris = JSON.stringify([workspaceUriOf(directory)]);
      const prev = tableExists(sd, 'conversation_summaries')
        ? sd.prepare('SELECT title FROM conversation_summaries WHERE conversation_id = ?').get(id)
        : null;
      const displayTitle = mode === 'append' && String(prev?.title ?? '').trim() ? String(prev.title) : title;
      const totalSteps = isFile(file)
        ? (() => {
            try {
              const c = new DatabaseSync(file, { readOnly: true });
              try {
                return Number(c.prepare('SELECT COUNT(*) c FROM steps').get().c) || steps.length;
              } finally {
                c.close();
              }
            } catch {
              return steps.length;
            }
          })()
        : steps.length;
      const srow = {
        conversation_id: id,
        title: displayTitle,
        preview,
        step_count: totalSteps,
        last_modified_time: hostTime(updatedAt),
        workspace_uris: uris,
        status: 'CASCADE_RUN_STATUS_IDLE',
        source: '',
        project_id: projectId,
        agent_name: '',
        parent_conversation_id: '',
        nesting_depth: 0,
        battle_id: '',
        winning_conversation_id: '',
        not_fully_idle: 0,
        killed: 0,
        last_user_input_time: hostTime(updatedAt),
        last_user_input_step_index: 0,
        app_data_dir: 'antigravity',
        raw_summary: null,
        group_id: '',
      };
      const ins = insertRowFiltered(sd, 'conversation_summaries', srow, {
        onConflict: {
          conflictCols: ['conversation_id'],
          updateCols: Object.keys(srow).filter((k) => k !== 'conversation_id' && !(mode === 'append' && k === 'title')),
        },
      });
      if (!ins.ok || !ins.inserted) throw new Error(ins.error || 'summary-insert-skipped');

      if (tableExists(sd, 'conversations_fts')) {
        const userBody = turns.flatMap((t) => (t.items ?? []).filter((i) => i?.kind === 'message' && i.role === 'user').map((i) => String(i.text ?? ''))).join('\n');
        const agentBody = turns.flatMap((t) => (t.items ?? []).filter((i) => i?.kind === 'message' && i.role === 'assistant').map((i) => String(i.text ?? ''))).join('\n');
        sd.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id);
        insertRowFiltered(sd, 'conversations_fts', {
          conversation_id: id,
          chunk_index: 0,
          chunk_first_step: 0,
          chunk_last_step: totalSteps - 1,
          last_modified_time: hostTime(updatedAt),
          step_count: totalSteps,
          last_step_created_at: hostTime(updatedAt),
          archived: 0,
          user_step_byte_offsets: '',
          agent_step_byte_offsets: '',
          title: displayTitle,
          workspace: directory,
          project: projectId,
          user_body: userBody,
          agent_body: agentBody,
        });
      }
      sd.exec('COMMIT');
    } catch (err) {
      try {
        sd.exec('ROLLBACK');
      } catch { /* ignore */ }
      return { ok: false, error: `summary-write-failed: ${String(err?.message ?? err)}`, targetId: id, warnings };
    } finally {
      try {
        sd.close();
      } catch { /* ignore */ }
    }

    if (provenance) {
      try {
        writeSidecarProvenance(file, provenance);
      } catch (err) {
        warnings.push(`provenance-sidecar-failed: ${String(err?.message ?? err)}`);
      }
    }

    return { ok: true, targetId: id, path: file, lines: steps.length, mode, warnings, directory };
  },
};
