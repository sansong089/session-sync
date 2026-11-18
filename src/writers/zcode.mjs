// writers/zcode.mjs — 写 ZCode（CLI db 正文 + 桌面 tasks-index 双库）
//
// 为什么必须写两个库（本机实测 + 宿主源码 taskIndexRepo）：
//   - 正文事实：`~/.zcode/cli/db/db.sqlite` 的 session / message / part / session_entry；
//   - 桌面侧栏列表读 `~/.zcode/v2/tasks-index.sqlite` 的 `tasks`（`SELECT * FROM tasks WHERE workspace_key=?`）；
//     **只写 CLI db 不会出现在侧栏**。宿主自己也是两边都写（zcodeTaskIndexSyncer + upsert）。
// 列形态全部照抄现网行（取证见 test/m26-zcode-writer.test.mjs 头部注释）：
//   slug === id、message/part.sequence 连续、title_source='custom'、
//   migration_source=NULL（宿主对它是严格 zod 枚举，造值会让校验失败）、
//   version 取库内宿主形态、provenance 放 session_entry（reader 按 provenanceSlot:'session_entry' 读）。
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { turnToMessages } from './opencode-classic.mjs';
import { tableExists, firstExisting } from '../readers/base.mjs';
import { ensureDir, isFile } from '../util.mjs';
import { roleRoots } from '../roots.mjs';
import { makeTitleSyncer } from './title-slots.mjs';
import { insertRowFiltered, newNodeId, resolveKeyWhere, updateRowFiltered } from './base.mjs';
import { fitTitleFor, TITLE_MAX } from '../titles.mjs';

const FALLBACK_VERSION = '0.16.3'; // 现网实测的最大版本串；库里一行都没有时用它

function cliDb(ctx) {
  // 正文库只认 db role：否则 aux 的 tasks-index.sqlite 会抢在第一个被选中
  return firstExisting(roleRoots('zcode', ctx, 'db').filter((x) => x.kind === 'file'))?.path ?? null;
}

function indexDb(ctx) {
  // 走 roleRoots：--data-root / probe 搬根后侧栏索引才跟着走（原来直读 auxPaths，搬根后写回旧位置）
  return roleRoots('zcode', ctx, 'aux').filter((x) => x.kind === 'file')[0]?.path ?? null;
}

/**
 * project_id 是 directory 的纯函数，不是外键：
 * `proj_` + lowercase → `[^a-z0-9._-]+` 连续段压成单个 '-' → 去首尾 '-' → 截 80。
 * 实测：`C:\Users\you\ZCodeProject` → `proj_c-users-you-zcodeproject`；`D:\00-demo-app` → `proj_d-00-demo-app`。
 */
export function zcodeProjectId(directory) {
  const slug = String(directory ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `proj_${slug}`;
}

function hostVersion(db) {
  try {
    const row = db.prepare("SELECT version FROM session WHERE version IS NOT NULL AND version <> 'session-sync/1' ORDER BY time_updated DESC LIMIT 1").get();
    if (row?.version) return String(row.version);
  } catch {
    /* 老库无该列 */
  }
  return FALLBACK_VERSION;
}

const nextSeq = (db, table, sessionId) => {
  try {
    const row = db.prepare(`SELECT COALESCE(MAX(sequence), -1) AS m FROM ${table} WHERE session_id = ?`).get(sessionId);
    return Number(row?.m ?? -1) + 1;
  } catch {
    return 0;
  }
};

/**
 * 桌面列表行（tasks）：主键 (workspace_key, task_id)，本地会话 identity 恒 NULL。
 *
 * keepTitle：append 时**不动显示名**（title / cli_title / meta_json.title 三处都是名字）。
 * 不能用「另一个落点的值」来保：用户在侧栏改的名常常只落在 tasks，session.title 还是旧值，
 * 拿它覆盖等于用旧值顶掉用户的决定（m69 抓到过）。
 */
function upsertTaskRow(db, row, { keepTitle = false } = {}) {
  if (!tableExists(db, 'tasks')) return false;
  // 复合主键定位走 base 的唯一出口：只按 task_id 查会跨 workspace 命中同名的另一行
  const keyWhere = resolveKeyWhere(['workspace_key', 'task_id'], [row.directory, row.taskId]);
  if (!keyWhere.ok) return false;
  const prevRow = keepTitle
    ? (db.prepare(`SELECT * FROM tasks WHERE ${keyWhere.sql}`).get(...keyWhere.vals) ?? null)
    : null;
  const displayTitle = (keepTitle && String(prevRow?.title ?? '').trim()) || row.title;
  // 按库里实际存在的列裁剪（与 session/message/part/session_entry 同一口径）：
  // 宿主换版本增删列时，硬编码列名会整条 INSERT 失败（侧栏列表里就少这条会话）。
  const metaJson = JSON.stringify({
    taskId: row.taskId,
    title: displayTitle,
    workspacePath: row.directory,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mode: 'build',
  });
  const searchable = `${displayTitle} ${row.searchable}`.trim().slice(0, 2000);
  const all = [
    ['workspace_key', row.directory],
    ['workspace_path', row.directory],
    ['workspace_identity', null],
    ['task_id', row.taskId],
    ['title', displayTitle],
    // 侧栏显示的是「title_overridden=0 时的 cli_title」：只写 title 会同步了却看不见
    ['cli_title', displayTitle],
    ['task_status', 'completed'],
    ['provider', null],
    ['mode', 'build'],
    ['model', null],
    ['migration_source', null],
    ['forked_from_task_id', null],
    ['created_at', row.createdAt],
    ['updated_at', row.updatedAt],
    ['pinned', 0],
    ['archived', 0],
    ['deleted', 0],
    ['title_overridden', 0],
    ['meta_json', metaJson],
    ['searchable_text', searchable],
  ];
  const ins = insertRowFiltered(db, 'tasks', all, {
    onConflict: {
      conflictCols: ['workspace_key', 'task_id'],
      // DO UPDATE 的列也必须裁剪：zcode 就是栽在「INSERT 裁了、SET 写死」——
      // 老库缺 searchable_text 时，插入成功但 SET 子句报错，整条 upsert 失败
      // append 时把三处名字列从更新集里摘掉（见 keepTitle 注释）
      updateCols: (keepTitle && String(prevRow?.title ?? '').trim()
        ? ['task_status', 'updated_at', 'searchable_text', 'deleted', 'archived']
        : ['title', 'cli_title', 'task_status', 'updated_at', 'meta_json', 'searchable_text', 'deleted', 'archived']),
    },
    ifEmpty: 'skip',
  });
  return Boolean(ins.ok && ins.inserted);
}

/**
 * 反查会话目录（= tasks 表的 workspace_key）。
 *
 * tasks 表的主键是 (workspace_key, task_id)，只按 task_id 定位会跨 workspace_key
 * 误改所有同名行（实测：两个 workspace_key 下同 task_id 会被一起改）。
 * workspace_key = 写入时的会话目录，CLI db 的 session.directory 就是它 ——
 * 那是同一次写入留下的权威值，比在 tasks 库里猜更可靠。
 */
function workspaceKeyOf(ctx, targetId) {
  const file = cliDb(ctx);
  if (!file || !isFile(file)) return '';
  let db;
  try {
    db = new DatabaseSync(file);
  } catch {
    return '';
  }
  try {
    if (!tableExists(db, 'session')) return '';
    const row = db.prepare('SELECT directory FROM session WHERE id = ?').get(String(targetId));
    return String(row?.directory ?? '').trim();
  } catch {
    return '';
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export const zcodeWriter = {
  variant: 'zcode',
  label: 'ZCode',

  canWrite(ctx) {
    const f = cliDb(ctx);
    const ok = !!f && isFile(f);
    return ok ? { ok: true } : { ok: false, reason: 'db-not-found' };
  },

  /**
   * 元数据漂移：源侧只改了标题（内容没变）时同步到目标。
   *
   * 宿主事实（真机取证）：侧栏在 `title_overridden = 0` 时显示 `cli_title`，= 1 时显示 `title`，
   * 而本机全部是 0 —— 只写 tasks.title 等于「同步成功了但 UI 还是旧名」。
   * 所以 title / cli_title 两个显示列都要写。
   *
   * 主键是 (workspace_key, task_id)：只按 task_id 匹配会跨 workspace_key 误改同名行。
   *
   * guard 用 title_overridden（数字位）：= 1 表示用户在宿主里改过名。
   * **不能用 cli_title_source='custom'**：我们自己在 create 时就写 title_source='custom'
   * （:242），宿主 syncer 会把它镜像成 cli_title_source='custom' → guard 永久成立、drift 永久失效。
   */
  syncTitle: makeTitleSyncer((ctx) => {
    const key = ['workspace_key', 'task_id'];
    const idVals = (c, targetId) => [workspaceKeyOf(c, targetId), String(targetId)];
    const task = (col, extra = {}) => ({ kind: 'db-column', db: (c) => indexDb(c), table: 'tasks', idCol: key, idVals, col, ...extra });
    return [
      // CLI 自己的 session.title（CLI 侧列表读它）
      { kind: 'db-column', db: (c) => cliDb(c), table: 'session', idCol: 'id', col: 'title', maxLen: TITLE_MAX.zcode },
      task('title', { maxLen: TITLE_MAX.zcode }),
      task('cli_title', { maxLen: TITLE_MAX.zcode }),
      task('title_overridden', { guard: true }),
    ];
  }, 'zcode'),

  targetPath(ctx, session, targetId) {
    const f = cliDb(ctx);
    return f ? `${f}#${targetId}` : null;
  },

  write(ctx, { session, targetId, mode, fromTurnIndex = 0, provenance, force = false }) {
    const warnings = [];
    const file = cliDb(ctx);
    if (!file || !isFile(file)) return { ok: false, error: 'db-not-found' };

    const directory = String(session.cwd ?? '');
    if (!directory) return { ok: false, error: 'cwd-required: zcode 的会话必须落在真实存在的目录' };
    // 宿主自己也是 recursive mkdir（startupWorkspace.ts:138）——落点目录不存在时它不会列
    try {
      ensureDir(directory);
    } catch (err) {
      return { ok: false, error: `mkdir-failed: ${String(err?.message ?? err)}` };
    }

    const turns = mode === 'append' ? (session.turns ?? []).slice(fromTurnIndex) : (session.turns ?? []);
    const now = Date.now();
    const createdAt = Number(session.createdAt) || now;
    const updatedAt = Number(session.updatedAt) || createdAt;
    // create 与 syncTitle 必须同一口径：create 不截、sync 截 300 的话，
    // 首次导入后立刻处于「检测到漂移」状态，每轮都在改一个本来就对的名字
    const title = fitTitleFor('zcode', session.title).value || 'imported session';

    const db = new DatabaseSync(file);
    let inserted = 0;
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      if (!tableExists(db, 'session') || !tableExists(db, 'message')) return { ok: false, error: 'session-or-message-missing' };
      db.exec('BEGIN IMMEDIATE');
      const hasPart = tableExists(db, 'part');
      const hasEntry = tableExists(db, 'session_entry');
      // 连标题一起读回来：append 时要沿用盘上已有的名字（见下面 title 的判定）
      let existing = db.prepare('SELECT id, title FROM session WHERE id = ?').get(targetId);

      if (existing && mode !== 'append') {
        if (!force) {
          db.exec('ROLLBACK');
          return { ok: false, error: 'target-exists', targetId, warnings };
        }
        if (hasEntry) db.prepare('DELETE FROM session_entry WHERE session_id = ?').run(targetId);
        if (hasPart) db.prepare('DELETE FROM part WHERE session_id = ?').run(targetId);
        db.prepare('DELETE FROM message WHERE session_id = ?').run(targetId);
        db.prepare('DELETE FROM session WHERE id = ?').run(targetId);
        // 整份重建后按「没有行」走：只认 existing 会漏插，只认 force 会在 append 时重复插
        existing = null;
      }

      if (!existing) {
        // 按库里实际存在的列裁剪（与 workbuddy 索引 / minimax / opencode 同一口径）
        const all = [
          ['id', targetId],
          ['project_id', zcodeProjectId(directory)],
          ['workspace_id', null],
          ['parent_id', null],
          ['slug', targetId],
          ['directory', directory],
          ['path', directory],
          ['title', title],
          ['version', hostVersion(db)],
          ['permission', null],
          ['time_created', createdAt],
          ['time_updated', updatedAt],
          ['task_type', 'interactive'],
          ['title_source', 'custom'],
        ];
        const ins = insertRowFiltered(db, 'session', all, { ifEmpty: 'skip' });
        if (!ins.ok || !ins.inserted) return { ok: false, error: 'session-table-absent', targetId, warnings };
      } else {
        // append **不动标题**：读侧回填的 session.title 是从首条用户文本推的，
        // 覆盖会把宿主生成/用户改过的名字降级；标题只走 syncTitle 通道（带 guard 判定）
        const sets = [
          ['time_updated', updatedAt],
          ['directory', directory],
          ['path', directory],
          ['project_id', zcodeProjectId(directory)],
        ];
        if (mode !== 'append') sets.push(['title', title]);
        updateRowFiltered(db, 'session', sets, { id: targetId });
      }

      let msgSeq = nextSeq(db, 'message', targetId);
      for (const turn of turns) {
        for (const msg of turnToMessages(turn, session)) {
          const msgId = `msg_${newNodeId().slice(0, 8)}_${newNodeId()}`;
          const ts = msg.ts || updatedAt;
          const msgAll = [
            ['id', msgId],
            ['session_id', targetId],
            ['time_created', ts],
            ['time_updated', ts],
            ['data', JSON.stringify({ role: msg.role, time: { created: ts }, agent: 'build', model: { providerID: 'session-sync', modelID: session.model || 'unknown' } })],
            ['sequence', msgSeq++],
          ];
          const msgIns = insertRowFiltered(db, 'message', msgAll, { ifEmpty: 'skip' });
          if (!msgIns.ok || !msgIns.inserted) continue;
          inserted++;
          if (!hasPart) continue;
          // part.sequence 是**每条消息内**从 0 递增（实测宿主即如此），不是全会话连续
          let partSeq = 0;
          for (const p of msg.parts) {
            const partAll = [
              ['id', `prt_${newNodeId().slice(0, 8)}_${newNodeId()}`],
              ['message_id', msgId],
              ['session_id', targetId],
              ['time_created', p.ts ?? ts],
              ['time_updated', p.ts ?? ts],
              ['data', JSON.stringify(p.data)],
              ['sequence', partSeq++],
            ];
            insertRowFiltered(db, 'part', partAll, { ifEmpty: 'skip' });
          }
        }
      }

      if (provenance && hasEntry) {
        const entryAll = [
          ['id', `sentry_${newNodeId()}`],
          ['session_id', targetId],
          ['type', 'session-sync/provenance'],
          ['time_created', now],
          ['time_updated', now],
          ['data', JSON.stringify(provenance)],
        ];
        insertRowFiltered(db, 'session_entry', entryAll, { ifEmpty: 'skip' });
      } else if (provenance) {
        warnings.push('session-entry-slot-absent: 该库没有 session_entry 表，provenance 未落库');
      }

      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      return { ok: false, error: `write-failed: ${String(err?.message ?? err)}`, targetId, warnings };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }

    // 第二个库：桌面侧栏的列表源。写失败必须报错——正文在、侧栏看不见是最难排查的状态
    const idxFile = indexDb(ctx);
    if (!isFile(idxFile)) {
      warnings.push('tasks-index-absent: 没有 ~/.zcode/v2/tasks-index.sqlite，侧栏暂时看不到这条（正文已写）');
    } else {
      const idb = new DatabaseSync(idxFile);
      try {
        idb.exec('PRAGMA busy_timeout = 8000');
        idb.exec('BEGIN IMMEDIATE');
        const firstUser = (session.turns ?? []).find((t) => t.role === 'user');
        const searchable = JSON.stringify(firstUser?.items ?? '').slice(0, 600);
        // append 不动侧栏显示名：标题只由 syncTitle 通道写（带 title_overridden guard）
        if (!upsertTaskRow(idb, { directory, taskId: String(targetId), title, createdAt, updatedAt, searchable }, { keepTitle: mode === 'append' })) {
          warnings.push('tasks-table-absent: tasks-index 里没有 tasks 表，侧栏不会列出');
        }
        idb.exec('COMMIT');
      } catch (err) {
        try {
          idb.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        return { ok: false, error: `tasks-index-write-failed: ${String(err?.message ?? err)}`, targetId, warnings };
      } finally {
        try {
          idb.close();
        } catch {
          /* ignore */
        }
      }
    }

    return { ok: true, targetId, path: file, lines: inserted, mode, warnings, directory };
  },
};
