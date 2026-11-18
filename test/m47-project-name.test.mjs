// M47 测试：list 的「所属项目」按各宿主自己的项目名协议读取（不是目录名）
//
// 用户口径（2026-10-29）：所属项目要区分「项目名」和「目录」，项目名遵守各 agent 协议；
// 展示只给项目名不给路径，非项目会话固定显示「非项目会话」。
// 真机取证（本机）：
//   qoder  → main.sqlite workspaces.name（侧栏项目名）
//   codex  → .codex-global-state.json local-projects[*].name（经 thread-project-assignments 归属）
//   zcode  → v2/tasks-index.sqlite projects.name（经 tasks.project_id，task_id == session id 5/5 命中）
//   dsh    → storages/workspace.json tables.workspaces[*].title
//   opencode / mimo → project 表 name（本机全 NULL）→ 宿主 UI 回退 worktree 末段
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { mkOpencodeDb, mkMimoDb, mkZcodeDb, mkMinimaxDb } from './db-fixtures.mjs';
import { sandboxEnv } from './matrix-home.mjs';
import { readLocalStorage } from '../src/leveldb.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m47-${tag}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env });
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function rowOf(root, variant, id, env = {}) {
  const r = listSessions(variant, ctxFor(root, env), {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const row = r.sessions.find((s) => s.id === id);
  assert.ok(row, `会话 ${id} 必须被列出（${variant}）`);
  return row;
}

// ---------- codex ----------

test('codex：项目名取注册表 local-projects[*].name（按 thread-project-assignments 归属）', () => {
  const root = tmpRoot('codex');
  const id = '01a08522-5c5c-76a3-8a9c-3f74d46a7fc0';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '09', '03', `rollout-2026-09-03T00-00-00-${id}.jsonl`), [
    { timestamp: '2026-09-03T00:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-09-03T00:00:00.000Z', cwd: 'D:/00-demo-app', model: 'gpt-5' } },
    { timestamp: '2026-09-03T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } },
  ]);
  writeJson(path.join(root, '.codex', '.codex-global-state.json'), {
    'local-projects': { p1: { id: 'p1', name: '宿主项目名', rootPaths: ['D:/00-demo-app'] } },
    'thread-project-assignments': { [id]: { projectKind: 'local', projectId: 'p1' } },
    // 宿主历史脏数据：同一线程也挂在非项目名单里。归类只认 cwd/宿主自管根，不能被它改判
    'projectless-thread-ids': [id],
  });
  const row = rowOf(root, 'codex', id);
  assert.equal(row.projectName, '宿主项目名', `项目名必须取注册表，实际 ${row.projectName}`);
  assert.equal(row.scope, 'project', 'projectless-thread-ids 不能把带 git/项目目录的会话改判为非项目');
});

// ---------- qoder ----------

function qoderFixture(root) {
  const regFile = path.join(root, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite');
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  const db = new DatabaseSync(regFile);
  db.exec(`CREATE TABLE chat_sessions (
    session_id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, workspace_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, extra_json TEXT NOT NULL DEFAULT '{}',
    archived INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, owner_session_id TEXT, session_kind TEXT NOT NULL DEFAULT 'standard')`);
  db.exec('CREATE TABLE chat_session_messages (session_id TEXT NOT NULL, role TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT, workspace_source TEXT, root_paths_json TEXT)');
  db.prepare('INSERT INTO workspaces (workspace_id, name, workspace_source, root_paths_json) VALUES (?,?,?,?)').run('w1', '改过的项目名', 'local', '["D:/work/proj-dir"]');
  db.prepare('INSERT INTO workspaces (workspace_id, name, workspace_source, root_paths_json) VALUES (?,?,?,?)').run('w2', '', 'local', '["D:/work/no-name"]');
  db.prepare('INSERT INTO chat_sessions (session_id, title, cwd, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('qs-named', '改了名的项目会话', 'D:/work/proj-dir', 'w1', 1791484221000, 1791484221000);
  db.prepare('INSERT INTO chat_sessions (session_id, title, cwd, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('qs-noname', '没改名的项目会话', 'D:/work/no-name', 'w2', 1791484221000, 1791484221000);
  db.prepare('INSERT INTO chat_session_messages (session_id, role, payload_json, created_at) VALUES (?,?,?,?)')
    .run('qs-named', 'user', JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '你好' }] }), 1791484221000);
  db.prepare('INSERT INTO chat_session_messages (session_id, role, payload_json, created_at) VALUES (?,?,?,?)')
    .run('qs-noname', 'user', JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '你好' }] }), 1791484221000);
  db.close();
  return regFile;
}

test('qoder：项目名取 workspaces.name（不是 cwd 目录名）；名字为空才回退目录名', () => {
  const root = tmpRoot('qoder');
  const regFile = qoderFixture(root);
  const env = { QODER_CN_REGISTRY_DB: regFile };
  const named = rowOf(root, 'qoder-cn', 'qs-named', env);
  assert.equal(named.projectName, '改过的项目名', `宿主名优先于目录名，实际 ${named.projectName}`);
  assert.equal(named.scope, 'project');
  const noname = rowOf(root, 'qoder-cn', 'qs-noname', env);
  assert.equal(noname.projectName, '', '宿主名字为空时 reader 不编造，由展示层回退目录名');
});

// ---------- opencode v2 ----------

test('opencode v2：project.name 优先；为空时按宿主 UI 取 worktree 末段（不是会话子目录名）', () => {
  const root = tmpRoot('opencode');
  const dataDir = path.join(root, 'oc');
  mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const db = new DatabaseSync(path.join(dataDir, 'opencode.db'));
  const insProject = db.prepare('INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?,?)');
  insProject.run('pdir', 'D:/work/repo', 'git', null, 1, 1, '[]');
  insProject.run('pname', 'D:/work/other', 'git', '自定义项目', 1, 1, '[]');
  const insSession = db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)`);
  insSession.run('sess_sub', 'pdir', 'a', 'D:/work/repo/packages/app', 'packages/app', '子目录会话', '1', 1, 1);
  insSession.run('sess_named', 'pname', 'b', 'D:/work/other', '', '有名项目会话', '1', 1, 1);
  db.close();

  const env = { OPENCODE_DATA_DIR: dataDir };
  assert.equal(rowOf(root, 'opencode', 'sess_sub', env).projectName, 'repo', '显示项目根的名字，不是 packages/app');
  assert.equal(rowOf(root, 'opencode', 'sess_named', env).projectName, '自定义项目');
});

// ---------- mimo（OpenCode 血统 classic） ----------

test('mimo：项目名取 project.name / worktree 末段', () => {
  const root = tmpRoot('mimo');
  const dataDir = path.join(root, 'mi');
  mkMimoDb(path.join(dataDir, 'mimocode.db'));
  const db = new DatabaseSync(path.join(dataDir, 'mimocode.db'));
  db.prepare('INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?,?,?,?,?,?,?)')
    .run('g1', 'D:/work/deep-repo', 'git', null, 1, 1, '[]');
  db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)')
    .run('ses_mimo1', 'g1', 'a', 'D:/work/deep-repo/sub', 'MiMo 会话', '1', 1, 1);
  db.close();

  const env = { MIMO_HOME: dataDir };
  assert.equal(rowOf(root, 'mimo', 'ses_mimo1', env).projectName, 'deep-repo');
});

// ---------- zcode ----------

test('zcode：项目名取任务索引 projects.name（tasks.task_id == session id）', () => {
  const root = tmpRoot('zcode');
  const zhome = path.join(root, 'zc');
  const cliFile = path.join(zhome, 'cli', 'db', 'db.sqlite');
  const idxFile = path.join(zhome, 'v2', 'tasks-index.sqlite');
  mkZcodeDb(cliFile, idxFile);
  const cli = new DatabaseSync(cliFile);
  cli.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)')
    .run('sess_z1', 'dirhash', 'a', 'D:/00-demo-app', 'ZCode 会话', '1', 1, 1);
  cli.close();
  const idx = new DatabaseSync(idxFile);
  idx.prepare('INSERT INTO projects (project_id, host_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').run('z1', 'local', 'ZCode项目', 1, 1);
  idx.prepare('INSERT INTO project_roots (project_id, root_path, position, is_primary) VALUES (?,?,?,?)').run('z1', 'D:\\00-demo-app', 0, 1);
  idx.prepare('INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, project_id) VALUES (?,?,?,?,?,?,?)')
    .run('k', 'D:\\00-demo-app', 'sess_z1', 'ZCode 会话', 1, 1, 'z1');
  idx.close();

  const env = { ZCODE_HOME: zhome };
  assert.equal(rowOf(root, 'zcode', 'sess_z1', env).projectName, 'ZCode项目');
});

// ---------- dsh ----------

test('dsh：项目名取 workspace.json 的 workspaces[*].title', () => {
  const root = tmpRoot('dsh');
  const dhome = path.join(root, 'dh');
  const id = 'dsh-1';
  const dir = path.join(dhome, 'sessions', 'slug', id);
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', id, cwd: 'D:/00-demo-app', createdAt: '2026-10-01T00:00:00.000Z' },
    { type: 'user/message', time: '2026-10-01T00:00:01.000Z', data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', time: '2026-10-01T00:00:02.000Z', data: { message: { content: [{ type: 'text', text: '答' }] } } },
  ];
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')));
  writeJson(path.join(dhome, 'storages', 'workspace.json'), {
    global: { defaultWorkspaceId: 'w2' },
    tables: {
      workspaces: {
        w1: { id: 'w1', path: 'D:\\00-demo-app', title: '自定义工作区', sessionIds: [id] },
      },
    },
  });

  const env = { DSH_HOME: dhome };
  const row = rowOf(root, 'dsh', id, env);
  assert.equal(row.projectName, '自定义工作区');
  assert.equal(row.scope, 'project');
});

// ---------- workbuddy ----------

function workbuddyFixture(root, { rename = true } = {}) {
  const home = path.join(root, '.workbuddy');
  const id = 'wb-renamed';
  writeJsonl(path.join(home, 'projects', 'p', `${id}.jsonl`), [
    { type: 'message', timestamp: '2026-10-01T00:00:01.000Z', role: 'user', content: [{ type: 'text', text: '你好' }], cwd: 'C:\\Users\\x\\WorkBuddy\\automation-20260330182149' },
    { type: 'message', timestamp: '2026-10-01T00:00:02.000Z', role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ]);
  writeJsonl(path.join(home, 'projects', 'p', 'wb-plain.jsonl'), [
    { type: 'message', timestamp: '2026-10-01T00:00:03.000Z', role: 'user', content: [{ type: 'text', text: '你好2' }], cwd: 'C:\\Users\\x\\WorkBuddy\\20260401000000' },
    { type: 'message', timestamp: '2026-10-01T00:00:04.000Z', role: 'assistant', content: [{ type: 'text', text: '答2' }] },
  ]);
  if (rename) {
    // 宿主「Rename Workspace」的落盘形态（真机 ~/.workbuddy/workspace-display-names.json 原文）：
    // workspaces 以规范化路径为键，displayName 只改显示名，不动目录
    writeJson(path.join(home, 'workspace-display-names.json'), {
      version: 1,
      workspaces: {
        'c:/users/x/workbuddy/automation-20260330182149': {
          id: 'c:/users/x/workbuddy/automation-20260330182149',
          path: 'C:\\Users\\x\\WorkBuddy\\automation-20260330182149',
          displayName: '改过名的工作区',
          updatedAt: 1791525823691,
        },
      },
    });
  }
  return id;
}

test('workbuddy：工作区改名取 workspace-display-names.json 的 displayName（不是目录名）', () => {
  const root = tmpRoot('workbuddy');
  const id = workbuddyFixture(root);
  assert.equal(rowOf(root, 'workbuddy-cn', id).projectName, '改过名的工作区');
  // 没改名的工作区不编造名字，由展示层回退目录名
  assert.equal(rowOf(root, 'workbuddy-cn', 'wb-plain').projectName, '');
});

test('workbuddy：没有改名文件时回退目录名（宿主默认标签同口径）', () => {
  const root = tmpRoot('workbuddy-norename');
  const id = workbuddyFixture(root, { rename: false });
  assert.equal(rowOf(root, 'workbuddy-cn', id).projectName, '');
});

test('CLI：workbuddy 文本行显示改名后的工作区名', () => {
  const root = tmpRoot('workbuddy-cli');
  workbuddyFixture(root);
  const env = sandboxEnv(root);
  const text = execFileSync(process.execPath, [BIN, 'list', '--from', 'workbuddy-cn'], { env, encoding: 'utf8' });
  const line = text.split(/\r?\n/).find((l) => l.includes('wb-renamed'));
  assert.ok(line, text);
  assert.ok(line.includes('改过名的工作区'), `应显示宿主工作区名：${line}`);
  assert.ok(!line.includes('automation-20260330182149'), `不应显示目录名：${line}`);
});

// ---------- minimax ----------

// 构造 Chromium Local Storage 的 LevelDB WAL（FULL 记录 + WriteBatch，读侧不校验 CRC）
function writeLevelDbLog(dir, batches) {
  fs.mkdirSync(dir, { recursive: true });
  const lenVar = (n) => {
    const out = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const chunks = [];
  for (const { seq, entries } of batches) {
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64LE(BigInt(seq));
    const count = Buffer.alloc(4);
    count.writeUInt32LE(entries.length);
    const trailer = Buffer.alloc(8);
    trailer.writeBigUInt64LE((BigInt(seq) << 8n) | 1n);
    const parts = [seqBuf, count];
    for (const e of entries) {
      const kb = Buffer.concat([Buffer.from(`_app://.\u0000\u0001${e.key}`, 'utf8'), trailer]);
      const value = e.del ? null : Buffer.concat([Buffer.from([1]), Buffer.from(e.value, 'utf8')]);
      parts.push(Buffer.from([e.del ? 0 : 1]), lenVar(kb.length), kb);
      if (value) parts.push(lenVar(value.length), value);
    }
    const body = Buffer.concat(parts);
    const header = Buffer.alloc(7);
    header.writeUInt32LE(0, 0);
    header.writeUInt16LE(body.length, 4);
    header.writeUInt8(1, 6);
    chunks.push(header, body);
  }
  fs.writeFileSync(path.join(dir, '000001.log'), Buffer.concat(chunks));
}

function minimaxFixture(root, aliases) {
  const dataDir = path.join(root, 'AppData', 'Roaming', 'MiniMax');
  const dbFile = path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite');
  mkMinimaxDb(dbFile);
  const db = new DatabaseSync(dbFile);
  db.prepare(`INSERT INTO local_runtime_sessions
    (session_id, record_json, updated_at_ms, columnar_version, agent_name, visibility, session_kind,
     is_default_workspace, workspace_dir, project_workspace_dir, title, created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'mm-1', '{}', 1791484221000, 3, 'mavis', 'visible', 'conversation',
    0, 'D:\\work\\renamed', 'D:\\work\\renamed', '改名项目会话', 1791484221000,
  );
  db.prepare('INSERT INTO local_runtime_message_rows (session_id, msg_id, role, created_at_ms, data_json) VALUES (?,?,?,?,?)')
    .run('mm-1', 'm1', 'user', 1791484221000, JSON.stringify({ msg_content: '你好' }));
  db.close();
  writeLevelDbLog(path.join(dataDir, 'Local Storage', 'leveldb'), [
    { seq: 10, entries: [{ key: 'mavis:sidebar:projectGroupPrefs:v1', value: JSON.stringify({ aliases }) }] },
  ]);
  return dataDir;
}

test('minimax：本地项目组改名取 localStorage 的 aliases（Chromium LevelDB）', () => {
  const root = tmpRoot('minimax');
  minimaxFixture(root, { 'd:/work/renamed': 'MiniMax改名项目' });
  const row = rowOf(root, 'minimax', 'mm-1');
  assert.equal(row.projectName, 'MiniMax改名项目', `应读出宿主 localStorage 的项目名，实际 ${row.projectName}`);
});

test('minimax：远端项目别名（<bindingId>:<path>）也认；旧值被新 seq 覆盖、删除项不生效', () => {
  const root = tmpRoot('minimax-remote');
  const dir = minimaxFixture(root, {});
  writeLevelDbLog(path.join(dir, 'Local Storage', 'leveldb'), [
    { seq: 20, entries: [{ key: 'mavis.remote-control.project-aliases.v1:u1', value: JSON.stringify({ 'bind-1:d:/work/renamed': '旧名字' }) }] },
    { seq: 21, entries: [{ key: 'mavis.remote-control.project-aliases.v1:u1', value: JSON.stringify({ 'bind-1:d:/work/renamed': '远端项目名' }) }] },
  ]);
  assert.equal(rowOf(root, 'minimax', 'mm-1').projectName, '远端项目名');
});

test('minimax：没有改名记录时 projectName 为空（展示层回退目录名）', () => {
  const root = tmpRoot('minimax-none');
  minimaxFixture(root, {});
  assert.equal(rowOf(root, 'minimax', 'mm-1').projectName, '');
});

test('leveldb：真实 MiniMax localStorage 能解出已知键（本机无宿主数据时跳过）', (t) => {
  const dir = path.join(process.env.APPDATA || '', 'MiniMax', 'Local Storage', 'leveldb');
  if (!fs.existsSync(dir)) return t.skip('本机没有 MiniMax Local Storage');
  const entries = readLocalStorage(dir);
  const model = entries.get('mavis:model-selection');
  assert.ok(model, '必须解出 mavis:model-selection');
  const parsed = JSON.parse(model);
  assert.equal(parsed.providerId, 'minimax');
});

// ---------- CLI 展示 ----------

test('CLI：文本/JSON 只显示项目名（宿主协议名），不显示路径', () => {
  const root = tmpRoot('cli');
  const regFile = qoderFixture(root);
  const env = sandboxEnv(root, { QODER_CN_REGISTRY_DB: regFile });
  const text = execFileSync(process.execPath, [BIN, 'list', '--from', 'qoder-cn'], { env, encoding: 'utf8' });
  const line = text.split(/\r?\n/).find((l) => l.includes('qs-named'));
  assert.ok(line, text);
  assert.ok(line.includes('改过的项目名'), `文本行应显示宿主项目名：${line}`);
  assert.ok(!line.includes('proj-dir'), `文本行不应出现目录路径：${line}`);

  const j = JSON.parse(execFileSync(process.execPath, [BIN, 'list', '--from', 'qoder-cn', '--json'], { env, encoding: 'utf8' }));
  const row = j.sessions.find((s) => s.id === 'qs-named');
  assert.equal(row.projectName, '改过的项目名');
  assert.equal(row.cwd, 'D:/work/proj-dir', '完整 cwd 仍保留在 JSON（核心功能不受影响）');
});

test('CLI：非项目会话的项目名固定显示「非项目会话」', () => {
  const root = tmpRoot('cli-none');
  const bucket = path.join(root, 'Documents', 'Codex', '2026-10-15', 'chat-1');
  writeJsonl(path.join(root, '.claude', 'projects', 'A', 's-bucket.jsonl'), [
    { type: 'user', cwd: bucket, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: '桶里的会话' }, sessionId: 's-bucket', uuid: 'u1', parentUuid: null },
  ]);
  const env = sandboxEnv(root);
  const j = JSON.parse(execFileSync(process.execPath, [BIN, 'list', '--from', 'claude', '--json'], { env, encoding: 'utf8' }));
  assert.equal(j.sessions[0].projectName, '非项目会话');
});
