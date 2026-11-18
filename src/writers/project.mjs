// writers/project.mjs — project 行归属的共用机制
//
// 各家宿主的「项目 id 怎么算」是**各自的契约**（MiMo 用 id 文件、OpenCode v2 复刻 Project.resolve、
// ZCode 是目录的纯函数、MiniMax 靠宿主触发器），这部分必须各写各的；
// 但「把行插进去、找不到就落 global」是同一件机械活，只有这一份实现：
// 按实际列集插（老库列不全也能写），global 行固定 (id='global', worktree='/')。
import { GLOBAL_PROJECT, tableColumns } from '../readers/base.mjs';
import { baseNameOf } from '../util.mjs';
import { insertRowFiltered } from './base.mjs';

export { GLOBAL_PROJECT };

/**
 * 在 project 表里插一行（列集按实际库探测，未知列不写）。没有 worktree 列的老库返回 false。
 * 列裁剪本身交给 insertRowFiltered（唯一出口）；这里只保留 project 行的取值语义。
 */
export function insertProjectRow(db, id, worktree, { name = null, vcs = null, timeActive = null } = {}) {
  const cols = tableColumns(db, 'project');
  if (!cols.includes('worktree')) return false;
  const now = Date.now();
  const row = { id, worktree, time_created: now, time_updated: now };
  if (cols.includes('name')) row.name = name ?? (baseNameOf(worktree) || null);
  if (cols.includes('vcs')) row.vcs = vcs;
  if (cols.includes('sandboxes')) row.sandboxes = '[]';
  if (cols.includes('time_active')) row.time_active = timeActive ?? 0;
  insertRowFiltered(db, 'project', row);
  return true;
}

/**
 * **OpenCode-classic 血统（MiMo）**的非项目桶行：实测 worktree 固定为 "/"。
 * 注意：opencode v2 的 `global` 是「无 remote 的 git 仓库」，行形状是 `(worktree=<repo>, vcs=git)`，不要套这个。
 */
export function ensureGlobalProject(db) {
  if (!db.prepare('SELECT id FROM project WHERE id = ?').get(GLOBAL_PROJECT)) {
    insertProjectRow(db, GLOBAL_PROJECT, '/', { name: GLOBAL_PROJECT });
  }
  return GLOBAL_PROJECT;
}
