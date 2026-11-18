// readers/zcode.mjs — ZCode：正文在 cli/db/db.sqlite（OpenCode 同构），
// 侧栏项目名在 v2/tasks-index.sqlite（桌面分组：tasks.project_id → projects.name）。
//
// cli 库的 session.project_id 是 OpenCode 血统的目录哈希（project 表不在该库里），
// 不能当显示名；任务索引的 task_id 与 session id 同值（本机 5/5），才是项目归属的权威来源。
// 索引库缺失/坏掉时退回基类行为（CLI 侧按目录名兜底）。
import { VARIANTS } from '../hosts.mjs';
import { roleRoots } from '../roots.mjs';
import { createOpencodeClassicReader } from './opencode-classic.mjs';
import { openDb, tableExists, tableColumns, firstExisting } from './base.mjs';
import { cmpPath } from '../util.mjs';

const base = createOpencodeClassicReader({ variant: 'zcode', provenanceSlot: 'session_entry' });

function projectNames(ctx) {
  const empty = { byTask: new Map(), byTaskOnly: new Map(), roots: [] };
  const hit = firstExisting(roleRoots('zcode', ctx, 'aux').filter((x) => x.kind === 'file'));
  if (!hit) return empty;
  let db;
  try {
    db = openDb(hit.path);
  } catch {
    return empty;
  }
  try {
    if (!tableExists(db, 'projects') || !tableExists(db, 'tasks')) return empty;
    if (!tableColumns(db, 'projects').includes('name') || !tableColumns(db, 'tasks').includes('project_id')) return empty;
    const names = new Map(db.prepare('SELECT project_id, name FROM projects').all().map((r) => [String(r.project_id), String(r.name ?? '').trim()]));
    // tasks 的主键是 (workspace_key, task_id)。只按 task_id 建索引时，同一个 id 落在
    // 两个 workspace 下会互相覆盖 —— 会话会被标上别人的项目名。
    // 所以同时存两份：复合键一份（精确），单键一份但**只在该 task_id 全局唯一时**才可用。
    const taskCols = tableColumns(db, 'tasks');
    const hasWs = taskCols.includes('workspace_key');
    const selectSql = hasWs
      ? 'SELECT workspace_key, task_id, project_id FROM tasks'
      : 'SELECT task_id, project_id FROM tasks';
    const byTask = new Map();
    const byTaskOnly = new Map();
    const ambiguous = new Set();
    for (const r of db.prepare(selectSql).all()) {
      const name = r.project_id ? names.get(String(r.project_id)) : '';
      if (!name) continue;
      const tid = String(r.task_id);
      if (hasWs) byTask.set(`${cmpPath(r.workspace_key)}\u0000${tid}`, name);
      const prev = byTaskOnly.get(tid);
      if (prev === undefined) byTaskOnly.set(tid, name);
      else if (prev !== name) ambiguous.add(tid);
    }
    for (const tid of ambiguous) byTaskOnly.delete(tid);
    const roots = tableExists(db, 'project_roots') && tableColumns(db, 'project_roots').includes('root_path')
      ? db
          .prepare('SELECT project_id, root_path FROM project_roots')
          .all()
          .map((r) => ({ name: names.get(String(r.project_id)) ?? '', root: cmpPath(r.root_path) }))
          .filter((x) => x.name && x.root)
      : [];
    return { byTask, byTaskOnly, roots };
  } catch {
    return empty;
  } finally {
    db.close();
  }
}

// 先按任务直接命中；没有任务行时用项目根做最长前缀匹配（目录可能在项目根的子目录里）
function nameFor(s, idx) {
  const tid = String(s.id);
  // 先按 (workspace, task) 整键命中：同一个 task_id 存在两个 workspace 下时，
  // 只有整键才知道这条会话属于哪个项目，单键会串
  const ws = cmpPath(s.cwd);
  const exact = ws ? idx.byTask.get(`${ws}\u0000${tid}`) : '';
  if (exact) return exact;
  const direct = idx.byTaskOnly.get(tid);
  if (direct) return direct;
  const cwd = cmpPath(s.cwd);
  if (!cwd) return '';
  let best = null;
  for (const r of idx.roots) {
    if ((cwd === r.root || cwd.startsWith(`${r.root}/`)) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best?.name ?? '';
}

export const zcodeReader = {
  variant: 'zcode',
  label: VARIANTS.zcode.label,

  available(ctx) {
    return base.available(ctx);
  },

  list(ctx, opts = {}) {
    const idx = projectNames(ctx);
    return base.list(ctx, opts).map((s) => {
      const name = nameFor(s, idx);
      return name ? { ...s, projectName: name } : s;
    });
  },

  read(ctx, id) {
    return base.read(ctx, id);
  },
};
