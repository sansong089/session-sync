// 测试用的各家库夹具：DDL 抄自本机库（与 m5/m7/m26/m27 里原来的私有副本同源）
// 放这里是为了「一张表只定义一次」—— 之前每个测试文件各抄一份，字段漂移时只有先跑的那份会报错。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function mk(file, ddls) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const d of ddls) db.exec(d);
  db.close();
  return file;
}

export const OPENCODE_DDL = {
  project: `CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`,
  session_v2: `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER NOT NULL DEFAULT 0, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`,
  session_message: `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
};

export const mkOpencodeDb = (file) => mk(file, Object.values(OPENCODE_DDL));

export const mkMimoDb = (file) => mk(file, [
  `CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`,
  `CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT, context_from TEXT, context_watermark TEXT, last_checkpoint_message_id TEXT, prompt TEXT, auto_worktree_hint_sent INTEGER, title_source TEXT NOT NULL DEFAULT 'user', title_revision INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE message (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'main', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
]);

export const mkZcodeDb = (cliFile, tasksFile) => {
  mk(cliFile, [
    `CREATE TABLE session (id text primary key, project_id text not null, workspace_id text, parent_id text, slug text not null, directory text not null, path text, title text not null, version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text, permission text, time_created integer not null, time_updated integer not null, time_compacting integer, time_archived integer, task_type text not null default 'interactive', title_source text not null default 'first_input' check(title_source in ('default','first_input','generated','custom')), title_message_id text, time_title_updated integer, trace_id text)`,
    `CREATE TABLE message (id text primary key, session_id text not null references session(id) on delete cascade, time_created integer not null, time_updated integer not null, data text not null, sequence integer)`,
    `CREATE TABLE part (id text primary key, message_id text not null references message(id) on delete cascade, session_id text not null, time_created integer not null, time_updated integer not null, data text not null, sequence integer)`,
    `CREATE TABLE session_entry (id text primary key, session_id text not null references session(id) on delete cascade, type text not null, time_created integer not null, time_updated integer not null, data text not null)`,
  ]);
  return mk(tasksFile, [
    `CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT, mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}', searchable_text TEXT NOT NULL DEFAULT '', last_unread_at INTEGER NOT NULL DEFAULT 0, cron_automation_id TEXT, off_peak_task_id TEXT, project_id TEXT, PRIMARY KEY (workspace_key, task_id))`,
    // 桌面侧栏的项目名协议（真机库同构）：tasks.project_id → projects.name，project_roots 是目录归属
    `CREATE TABLE projects (project_id TEXT PRIMARY KEY, host_id TEXT, name TEXT NOT NULL, name_overridden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE project_roots (project_id TEXT NOT NULL, root_path TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, is_primary INTEGER NOT NULL DEFAULT 0)`,
  ]);
};

export const mkMinimaxDb = (file) => mk(file, [
  `CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, columnar_version INTEGER NOT NULL DEFAULT 0, agent_name TEXT, runtime TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (session_kind IN ('conversation','task','peek','channel','cron','unknown')), purpose TEXT, purpose_kind TEXT NOT NULL DEFAULT '', origin_cron_id TEXT, parent_session_id TEXT, workspace_dir TEXT, project_workspace_dir TEXT, is_default_workspace INTEGER NOT NULL DEFAULT 0 CHECK (is_default_workspace IN (0,1)), title TEXT, created_at_ms INTEGER, error_message TEXT, error_code INTEGER, extra_data_json TEXT NOT NULL DEFAULT '{}', project_id INTEGER, history_relative_dir TEXT)`,
  `CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL, role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL, source TEXT, source_context_json TEXT, UNIQUE(session_id, msg_id))`,
  `CREATE TABLE local_runtime_projects (project_id INTEGER PRIMARY KEY AUTOINCREMENT, project_kind TEXT NOT NULL CHECK(project_kind IN ('default', 'workspace')), workspace_dir TEXT, pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, order_index INTEGER NOT NULL DEFAULT 2147483647, recent_at_ms INTEGER, latest_activity_at_ms INTEGER NOT NULL DEFAULT 0, session_count INTEGER NOT NULL DEFAULT 0, extra_data_json TEXT NOT NULL DEFAULT '{}', created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, CHECK ((project_kind = 'default' AND workspace_dir IS NULL) OR (project_kind = 'workspace' AND workspace_dir IS NOT NULL AND trim(workspace_dir) <> '')))`,
  // 宿主自己的建库触发器原文：建 project 行并回填 project_id（写侧不该重复实现这套归属逻辑）
  `CREATE TRIGGER trg_local_runtime_project_session_insert_v5 AFTER INSERT ON local_runtime_sessions WHEN NEW.columnar_version = 3 BEGIN INSERT INTO local_runtime_projects(project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms) SELECT CASE WHEN NEW.is_default_workspace = 1 THEN 'default' ELSE 'workspace' END, CASE WHEN NEW.is_default_workspace = 1 THEN NULL ELSE NEW.project_workspace_dir END, CASE WHEN NEW.archived = 0 AND NEW.visibility <> 'hidden' AND NEW.session_kind NOT IN ('peek','channel','cron') THEN NEW.updated_at_ms ELSE 0 END, COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0), COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0) WHERE NEW.is_default_workspace = 1 OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '') ON CONFLICT DO NOTHING; UPDATE local_runtime_sessions SET project_id = COALESCE((SELECT p.project_id FROM local_runtime_projects p WHERE (p.project_kind = 'default' AND NEW.is_default_workspace = 1) OR (p.project_kind = 'workspace' AND NOT (NEW.is_default_workspace = 1) AND p.workspace_dir = NEW.project_workspace_dir)), 0) WHERE session_id = NEW.session_id; END`,
  // 宿主的两个部分唯一索引（真机原文）：项目键是**字节级**目录串 ——
  // 同一个目录的大小写/分隔符不同写法在宿主眼里是两行，触发器的等值比较也只认字节相等。
  // fixture 少了这两个索引时，「重复项目行」这类缺陷在测试里根本看不见。
  `CREATE UNIQUE INDEX idx_local_runtime_projects_workspace_v1 ON local_runtime_projects(workspace_dir) WHERE project_kind = 'workspace'`,
  `CREATE UNIQUE INDEX idx_local_runtime_projects_one_default_v1 ON local_runtime_projects(project_kind) WHERE project_kind = 'default'`,
]);
