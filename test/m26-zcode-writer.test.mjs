// M26 测试：zcode 由只读改为可写（计划改动清单 9）
//
// 本轮源码取证的硬结论（全部实测，宿主已开源 ZCode，schema 直接抄自本机库）：
//   1. 可见性要写**两个库**：正文在 `~/.zcode/cli/db/db.sqlite`（session/message/part/session_entry），
//      桌面侧栏列表读 `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表
//      （`SELECT * FROM tasks WHERE workspace_key=?`，主键 (workspace_key, task_id)）—— 只写 CLI db 不会出现在侧栏；
//   2. `project_id` 是 `directory` 的纯函数：`proj_` + slugify(directory).slice(0,80)，
//      slugify = 转小写 → `[^a-z0-9._-]+` 连续段压成单个 `-` → 去首尾 `-`；实测两组：
//        `C:\Users\you\ZCodeProject` → `proj_c-users-you-zcodeproject`
//        `D:\00-demo-app`             → `proj_d-00-demo-app`
//      所以 ZCode 侧没有「幽灵项目」可污染，落点只要对同一 targetId 稳定即可；
//   3. ID 形态必须是 `sess_<uuid>`（原生 5/5 行如此），且 `slug === id`（不是标题 slug）；
//   4. `message.sequence` / `part.sequence` 原生按 0..n 递增，不写就退化成插入序；
//   5. `title_source` 有 CHECK 枚举，用 `custom`；`migration_source` 是宿主严格 zod 枚举 → 写 NULL；
//   6. `version` 是 CLI 版本串（实测 0.14.5/0.16.1/0.16.3），取库里最大值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { mkZcodeDb } from './db-fixtures.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { zcodeProjectId } from '../src/writers/zcode.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m26-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkZcodeHomes(root, { hostRows = 0 } = {}) {
  const cliFile = path.join(root, '.zcode', 'cli', 'db', 'db.sqlite');
  const idxFile = path.join(root, '.zcode', 'v2', 'tasks-index.sqlite');
  mkZcodeDb(cliFile, idxFile);
  const cli = new DatabaseSync(cliFile);
  for (let i = 0; i < hostRows; i++) {
    cli.exec(
      `INSERT INTO session (id, project_id, slug, directory, path, title, version, time_created, time_updated, task_type, title_source)
       VALUES ('sess_host${i}', 'proj_host', 'sess_host${i}', 'C:\\\\Users\\\\you\\\\ZCodeProject', 'C:\\\\Users\\\\you\\\\ZCodeProject', '宿主会话', '0.16.3', 1, 2, 'interactive', 'first_input')`,
    );
  }
  cli.close();
  return { cliFile, idxFile };
}

function mkClaudeSource(root, id, cwd, texts = ['第一轮问题']) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: new Date(1791484221000 + i * 9000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: new Date(1791484230000 + i * 9000).toISOString(), message: { role: 'assistant', model: 'glm-5.2', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const read = (file, sql, ...args) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};

function importToZcode(root, from = ['claude']) {
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from, into: ['zcode'] });
  return { ctx, plan, results: executePlan(ctx, plan, { apply: true, lock: false }) };
}

test('project_id 必须是 directory 的纯函数（两组现网实测值当期望）', () => {
  assert.equal(zcodeProjectId('C:\\Users\\you\\ZCodeProject'), 'proj_c-users-you-zcodeproject');
  assert.equal(zcodeProjectId('D:\\00-demo-app'), 'proj_d-00-demo-app');
  // 连续非法段压成单个 -，中文这类非 [a-z0-9._-] 的字符整段折叠
  const cn = zcodeProjectId('D:\\工作 目录\\子目录');
  assert.ok(cn.startsWith('proj_') && !/--/.test(cn) && !/[-_]$/.test(cn), cn);
  const long = 'C:\\' + 'a'.repeat(120);
  assert.ok(zcodeProjectId(long).length <= 'proj_'.length + 80, zcodeProjectId(long));
});

test('导入必须同时写两个库：CLI 正文 + tasks-index（桌面侧栏的唯一列表源）', () => {
  const root = tmpHome('dual-db');
  const { cliFile, idxFile } = mkZcodeHomes(root);
  mkClaudeSource(root, 's1', 'D:/00-work/code/demo-app');
  const { ctx, results } = importToZcode(root);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.targetId, /^sess_[0-9a-f-]{36}$/, `ID 形态必须是 sess_<uuid>，实际 ${r.targetId}`);

  const sess = read(cliFile, 'SELECT * FROM session WHERE id = ?', r.targetId);
  assert.equal(sess.length, 1, JSON.stringify(sess));
  const msgs = read(cliFile, 'SELECT * FROM message WHERE session_id = ? ORDER BY sequence', r.targetId);
  assert.ok(msgs.length >= 2, `至少两条消息，实际 ${msgs.length}`);
  const parts = read(cliFile, 'SELECT * FROM part WHERE session_id = ?', r.targetId);
  assert.ok(parts.length >= 2, JSON.stringify(parts.length));

  // 桌面列表查询（taskIndexRepo 的谓词）
  const workspaceKey = sess[0].directory;
  const listed = read(idxFile, 'SELECT * FROM tasks WHERE workspace_key = ? AND deleted = 0', workspaceKey);
  assert.deepEqual(listed.map((x) => x.task_id), [r.targetId], `侧栏必须列出来：workspace_key=${workspaceKey}`);
  assert.equal(listed[0].title, sess[0].title);

  const back = readSession('zcode', ctx, r.targetId).session;
  assert.equal(back.title, sess[0].title, '读回的标题必须与写出的 title 一致（round-trip）');
  assert.equal(back.turns.length, 1);
});

test('写出形态逐列对齐宿主：slug==id、sequence 连续、title_source=custom、migration_source NULL、version 宿主形态', () => {
  const root = tmpHome('shapes');
  const { cliFile, idxFile } = mkZcodeHomes(root, { hostRows: 1 });
  mkClaudeSource(root, 's2', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const { results } = importToZcode(root);
  const r = results[0];
  const sess = read(cliFile, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];

  assert.equal(sess.slug, r.targetId, 'slug 列就是会话 id（原生 5/5 如此），不是标题 slug');
  assert.equal(sess.title_source, 'custom');
  assert.equal(sess.task_type, 'interactive');
  assert.equal(sess.version, '0.16.3', 'version 必须取宿主库里的形态，不能写 session-sync/1');
  assert.equal(sess.project_id, 'proj_d-00-work-code-demo-app', JSON.stringify(sess));

  const msgs = read(cliFile, 'SELECT sequence FROM message WHERE session_id = ? ORDER BY sequence', r.targetId).map((m) => m.sequence);
  assert.deepEqual(msgs, msgs.map((_, i) => i), `message.sequence 必须 0..n 连续：${JSON.stringify(msgs)}`);
  const parts = read(cliFile, 'SELECT message_id, sequence FROM part WHERE session_id = ? ORDER BY sequence', r.targetId);
  const byMsg = new Map();
  for (const p of parts) byMsg.set(p.message_id, [...(byMsg.get(p.message_id) ?? []), p.sequence]);
  for (const [mid, seqs] of byMsg) assert.deepEqual(seqs, seqs.map((_, i) => i), `part.sequence 也要连续：${mid}`);

  const task = read(idxFile, 'SELECT * FROM tasks WHERE task_id = ?', r.targetId)[0];
  assert.equal(task.migration_source, null, '宿主对它是严格 zod 枚举，绝不能造值');
  assert.equal(task.workspace_identity, null, '本地会话 identity 恒为 NULL');
  assert.equal(task.workspace_key, task.workspace_path, '实测 5/5 行 workspace_key === workspace_path');

  // provenance 落 session_entry：type 带标记、data 就是 provenance 本体（reader 按这个契约读）
  const entries = read(cliFile, "SELECT type, data FROM session_entry WHERE session_id = ? AND type = 'session-sync/provenance'", r.targetId);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(JSON.parse(entries[0].data).origin.variant, 'claude', entries[0].data);
});

test('非项目会话落 shared 桶：目录必须 mkdir -p（宿主自己也是 recursive mkdir），读回 scope=none', () => {
  const root = tmpHome('bucket');
  const { cliFile } = mkZcodeHomes(root);
  mkClaudeSource(root, 's3', path.join(root, 'WorkBuddy', '2026-10-08-18-38-21').replace(/\\/g, '/'));
  const { ctx, results } = importToZcode(root);
  const r = results[0];
  assert.equal(r.placement.scope, 'none');
  assert.equal(r.placement.source, 'bucket:shared');

  const sess = read(cliFile, 'SELECT * FROM session WHERE id = ?', r.targetId)[0];
  const dir = process.platform === 'win32' ? sess.directory.replace(/\//g, '\\') : sess.directory;
  assert.ok(fs.existsSync(dir), `落点目录必须真实存在（宿主按目录打开）：${sess.directory}`);
  assert.equal(sess.directory, r.placement.directory);

  const back = readSession('zcode', ctx, r.targetId).session;
  assert.equal(back.scope, 'none', '桶内会话读回必须仍判非项目');
  assert.equal(back.turns.length, 1);
});

test('幂等与 append：同一源重跑不重复插行，源长一轮后 append 进同一会话', () => {
  const root = tmpHome('idem');
  const { cliFile, idxFile } = mkZcodeHomes(root);
  mkClaudeSource(root, 's4', 'D:/00-work/code/demo-app', ['第一轮']);
  const first = importToZcode(root);
  const targetId = first.results[0].targetId;

  const again = importToZcode(root);
  assert.equal(again.results[0].action, 'skip', JSON.stringify(again.results[0]));
  assert.equal(read(cliFile, 'SELECT COUNT(*) AS c FROM session WHERE id = ?', targetId)[0].c, 1);
  assert.equal(read(idxFile, 'SELECT COUNT(*) AS c FROM tasks WHERE task_id = ?', targetId)[0].c, 1, 'tasks 主键是 (workspace_key,task_id)，不能插重');

  mkClaudeSource(root, 's4', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const grown = importToZcode(root);
  assert.equal(grown.results[0].action, 'append', JSON.stringify(grown.results[0]));
  const back = readSession('zcode', grown.ctx, targetId).session;
  assert.equal(back.turns.length, 2, `append 后应有两轮，实际 ${back.turns.length}`);
  assert.equal(read(cliFile, 'SELECT COUNT(*) AS c FROM session WHERE id = ?', targetId)[0].c, 1);

  const list = listSessions('zcode', grown.ctx, {});
  assert.deepEqual(list.sessions.map((s) => s.id), [targetId], JSON.stringify(list.sessions));
});
