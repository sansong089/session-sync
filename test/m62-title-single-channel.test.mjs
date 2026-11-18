// M62 测试：标题同步的四个缺陷回归（review 2026-11-03 抓出）
//
// 1) ensureIndex 不写标题：skip 分支还有 target-ahead（目标比源更新），
//    源侧标题是旧名 —— 若 ensureIndex 跟着写，就把目标侧自己的标题抹掉了。
//    标题有且只有一个负责人：drift 通道（判据窄：仅 identical）。
// 2) zcode 的 tasks 主键是 (workspace_key, task_id)：只按 task_id 定位会跨
//    workspace_key 误改所有同名行。
// 3) 目标侧已有用户自定名（custom_title 列 / 正文 custom-title 行）时，
//    源侧改名不得覆盖它 —— 用户的决定优先。
// 4) json-file 槽必须原子写：写中断不留半个 JSON。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyTitleSlots } from '../src/writers/title-slots.mjs';
import { upsertSessionIndex } from '../src/writers/workbuddy.mjs';
import { zcodeWriter } from '../src/writers/zcode.mjs';
import { createWorkbuddyWriter } from '../src/writers/workbuddy.mjs';
import { clineWriter } from '../src/writers/cline.mjs';
import { readFirstJsonlField } from '../src/writers/base.mjs';
import { makeCtx } from '../src/hosts.mjs';
import { parseDataRoots } from '../src/roots.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { backupsOf, strayBackups } from './backup-fixture.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m62-${name}-`));
}

/** workbuddy 形态的 ctx（根钉在沙箱里，索引库放 <root>/workbuddy.db） */
function wbCtx(home) {
  return makeCtx({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    env: {},
    dataRoots: parseDataRoots(`workbuddy-cn=${path.join(home, '.workbuddy')}`),
  });
}

// ---- 1) ensureIndex 不碰标题 ----

test('索引自愈不写标题：已有行的 title 不被 ensureIndex 改掉', () => {
  const home = tmpHome('ensure-title');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER)');
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('s1', 'D:/old', 'u1', '目标自己的标题', 'Completed', 1, 2, 2);
    db.close();

    // ensureIndex 传源侧标题（模拟改造前的 import 侧行为：title 传源侧的）
    const r = upsertSessionIndex(wbCtx(home), 'workbuddy-cn', {
      targetId: 's1',
      title: '源侧的旧名',
      cwd: 'D:/new',
      scope: null,
      model: null,
      createdAt: 1,
      updatedAt: 3,
    });
    assert.equal(r.ok, true);

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT title, cwd FROM sessions WHERE id = ?').get('s1');
    db2.close();
    assert.equal(row.cwd, 'D:/new', '索引自愈该修的（cwd）要修');
    assert.equal(row.title, '目标自己的标题', '索引自愈不该碰标题：标题只由 drift 通道负责');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('索引行新建时标题留空，不塞占位符（否则污染宿主列表）', () => {
  const home = tmpHome('ensure-insert');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    // 列名照真机库（app.asar 取证时的 workbuddy.db：id, cwd, user_id, title, custom_title, …）
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT,
               status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_playground INTEGER,
               model TEXT, mode TEXT, last_activity_at INTEGER, source_mode TEXT, thought_level TEXT,
               transport TEXT, unread INTEGER)`);
    db.close();

    const r = upsertSessionIndex(wbCtx(home), 'workbuddy-cn', {
      targetId: 's2', title: '', cwd: 'D:/w', scope: null, model: null, createdAt: 1, updatedAt: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.created, true);

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT title FROM sessions WHERE id = ?').get('s2');
    db2.close();
    assert.equal(row.title, '', '空标题就留空，不塞 imported session 之类的占位符');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- 2) zcode 复合主键 ----

/**
 * 造 zcode 的两个库：CLI db（session 表，正文事实）+ tasks-index（tasks 表，桌面侧栏）。
 * 走 zcodeWriter.syncTitle 的**真实声明** —— 不自造槽：
 * 自造槽只能证明机制对，证明不了「zcode 真的这样声明」。
 */
function makeZcodeSandbox(name) {
  const home = tmpHome(name);
  const zroot = path.join(home, '.zcode');
  fs.mkdirSync(path.join(zroot, 'cli', 'db'), { recursive: true });
  fs.mkdirSync(path.join(zroot, 'v2'), { recursive: true });

  const cli = path.join(zroot, 'cli', 'db', 'db.sqlite');
  const cdb = new DatabaseSync(cli);
  cdb.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT, title_source TEXT)');
  cdb.close();

  const idx = path.join(zroot, 'v2', 'tasks-index.sqlite');
  const idb = new DatabaseSync(idx);
  idb.exec('CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT, title TEXT, cli_title TEXT, task_status TEXT, provider TEXT, mode TEXT, model TEXT, migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER, updated_at INTEGER, pinned INTEGER, archived INTEGER, deleted INTEGER, title_overridden INTEGER, meta_json TEXT, searchable_text TEXT, PRIMARY KEY (workspace_key, task_id))');
  idb.close();

  const ctx = makeCtx({
    home,
    platform: 'win32',
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    env: { ZCODE_HOME: zroot },
  });
  return { home, ctx, cli, idx };
}

test('zcode 槽用复合主键：两个 workspace_key 下同 task_id 只改对应那行', () => {
  const { ctx, cli, idx } = makeZcodeSandbox('zcode-composite');
  try {
    // CLI db：session 行给出目录（= workspace_key）
    const cdb = new DatabaseSync(cli);
    cdb.prepare('INSERT INTO session (id, directory, title) VALUES (?,?,?)').run('same-id', 'D:/work-b', 'CLI旧名');
    cdb.close();

    // tasks-index：两个 workspace_key 下同 task_id
    const idb = new DatabaseSync(idx);
    idb.prepare('INSERT INTO tasks (workspace_key, task_id, title) VALUES (?,?,?)').run('D:/work-a', 'same-id', 'A的名字');
    idb.prepare('INSERT INTO tasks (workspace_key, task_id, title, cli_title, title_overridden) VALUES (?,?,?,?,0)').run('D:/work-b', 'same-id', 'B的名字', 'B的名字');
    idb.close();

    const r = zcodeWriter.syncTitle(ctx, { targetId: 'same-id', title: '新名' });
    assert.equal(r.changed, true, '真实声明必须能改到标题');

    const db2 = new DatabaseSync(idx);
    const rows = db2.prepare('SELECT workspace_key, title, cli_title, title_overridden FROM tasks ORDER BY workspace_key').all();
    db2.close();
    assert.equal(rows.length, 2);
    assert.equal(rows.find((x) => x.workspace_key === 'D:/work-b').title, '新名', '目标行必须被改');
    // 宿主在 title_overridden=0 时显示 cli_title：只改 title 等于「同步了但 UI 还是旧名」
    assert.equal(rows.find((x) => x.workspace_key === 'D:/work-b').cli_title, '新名', 'cli_title 也必须改（否则侧栏看不见）');
    assert.equal(rows.find((x) => x.workspace_key === 'D:/work-b').title_overridden, 0, '我们不该改动「用户是否定名」这一位');
    assert.equal(rows.find((x) => x.workspace_key === 'D:/work-a').title, 'A的名字', '同名行不该被误改');
    assert.equal(rows.find((x) => x.workspace_key === 'D:/work-a').cli_title, null, '同名行的其余列也不该被碰');

    // CLI 侧自己的 session.title 也要跟上（CLI 列表读它）
    const cdb2 = new DatabaseSync(cli);
    assert.equal(cdb2.prepare('SELECT title FROM session WHERE id = ?').get('same-id').title, '新名', 'CLI 库的 session.title 必须同步');
    cdb2.close();
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('zcode：CLI db 里查不到目录时不同步（宁可不动也不误改）', () => {
  const { ctx, idx } = makeZcodeSandbox('zcode-unresolved');
  try {
    const idb = new DatabaseSync(idx);
    idb.prepare('INSERT INTO tasks (workspace_key, task_id, title) VALUES (?,?,?)').run('D:/work-a', 'same-id', 'A的名字');
    idb.close();

    // CLI db 没有该 session 行 → workspace_key 解析不出来
    const r = zcodeWriter.syncTitle(ctx, { targetId: 'same-id', title: '新名' });
    assert.equal(r.changed, false, '键解析不出来就不能写');

    const db2 = new DatabaseSync(idx);
    const row = db2.prepare('SELECT title FROM tasks').get();
    db2.close();
    assert.equal(row.title, 'A的名字', '原值必须保持不变');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

// ---- 3) 用户已定名 → 不覆盖 ----

test('guard 槽（db custom_title 列）非空时整个同步跳过', () => {
  const home = tmpHome('guard-db');
  try {
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER)');
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('s1', 'D:/w', 'u1', '源侧旧名', '用户手动改的名', 'Completed', 1, 2, 2);
    db.close();

    const body = path.join(home, 'x.jsonl');
    fs.writeFileSync(body, JSON.stringify({ type: 'ai-title', aiTitle: '源侧旧名' }) + '\n');

    // 走真实 writer 声明：guard 槽是 workbuddy 自己声明的，不自造
    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const r = writer.syncTitle(wbCtx(home), { targetId: 's1', title: '源侧新名' });
    assert.equal(r.changed, false, '用户已定名 → 不同步');
    assert.equal(r.skipped, 'user-defined-title');

    const db2 = new DatabaseSync(dbFile);
    const row = db2.prepare('SELECT title, custom_title FROM sessions WHERE id = ?').get('s1');
    db2.close();
    assert.equal(row.title, '源侧旧名', '目标侧标题不被源侧覆盖');
    assert.equal(row.custom_title, '用户手动改的名', '用户的名字分毫不动');
    const aiTitle = JSON.parse(fs.readFileSync(body, 'utf8').trim()).aiTitle;
    assert.equal(aiTitle, '源侧旧名', 'ai-title 行也不被无声改写');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guard 槽（正文 custom-title 行）非空时整个同步跳过', () => {
  const home = tmpHome('guard-body');
  try {
    const body = path.join(home, '.workbuddy', 'projects', 'p', 's1.jsonl');
    fs.mkdirSync(path.dirname(body), { recursive: true });
    fs.writeFileSync(body, [
      { type: 'ai-title', aiTitle: '源侧旧名' },
      { type: 'custom-title', customTitle: '用户在WorkBuddy改的名' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');

    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const r = writer.syncTitle(wbCtx(home), { targetId: 's1', title: '源侧新名' });
    assert.equal(r.changed, false);
    assert.equal(r.skipped, 'user-defined-title');

    const rows = fs.readFileSync(body, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.find((x) => x.type === 'ai-title').aiTitle, '源侧旧名', 'ai-title 不被改写');
    assert.equal(rows.find((x) => x.type === 'custom-title').customTitle, '用户在WorkBuddy改的名');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guard 槽为空（用户没改过名）时正常同步', () => {
  const home = tmpHome('guard-empty');
  try {
    const body = path.join(home, '.workbuddy', 'projects', 'p', 's1.jsonl');
    fs.mkdirSync(path.dirname(body), { recursive: true });
    fs.writeFileSync(body, JSON.stringify({ type: 'ai-title', aiTitle: '源侧旧名' }) + '\n');
    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const r = writer.syncTitle(wbCtx(home), { targetId: 's1', title: '源侧新名' });
    assert.equal(r.changed, true, '用户没改过名 → 该同步');
    const aiTitle = JSON.parse(fs.readFileSync(body, 'utf8').trim()).aiTitle;
    assert.equal(aiTitle, '源侧新名');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- 4) json-file 槽原子写 ----

test('json-file 槽：写前有备份、坏文件不覆盖、正常写走原子路径', () => {
  const home = tmpHome('json-file');
  try {
    const f = path.join(home, '.cline', 'data', 'sessions', 's1', 's1.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ metadata: { title: '旧名' }, other: 1 }, null, 2) + '\n');

    const ctx = makeCtx({
      home, platform: 'win32',
      appData: path.join(home, 'AppData', 'Roaming'),
      localAppData: path.join(home, 'AppData', 'Local'),
      env: {},
    });
    const r = clineWriter.syncTitle(ctx, { targetId: 's1', title: '新名' });
    assert.equal(r.changed, true);
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(obj.metadata.title, '新名');
    assert.equal(obj.other, 1, '其它字段必须保留');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('json-file 槽：文件读不懂时不写（不破坏原文件）', () => {
  const home = tmpHome('json-broken');
  try {
    const f = path.join(home, '.cline', 'data', 'sessions', 's1', 's1.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{ 这不是 JSON');
    const ctx = makeCtx({
      home, platform: 'win32',
      appData: path.join(home, 'AppData', 'Roaming'),
      localAppData: path.join(home, 'AppData', 'Local'),
      env: {},
    });
    const r = clineWriter.syncTitle(ctx, { targetId: 's1', title: '新名' });
    assert.equal(r.changed, false);
    assert.match(r.details[0].reason, /json-parse-failed/);
    assert.equal(fs.readFileSync(f, 'utf8'), '{ 这不是 JSON', '原文件必须原样保留');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('json-file 槽：写前留备份（裸 writeFileSync 没有，宿主读坏 manifest 时能还原）', () => {
  const home = tmpHome('json-backup');
  try {
    const f = path.join(home, '.cline', 'data', 'sessions', 's1', 's1.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ metadata: { title: '旧名' } }, null, 2) + '\n');
    const ctx = makeCtx({
      home, platform: 'win32',
      appData: path.join(home, 'AppData', 'Roaming'),
      localAppData: path.join(home, 'AppData', 'Local'),
      env: {},
    });
    const r = clineWriter.syncTitle(ctx, { targetId: 's1', title: '新名' });
    assert.equal(r.changed, true);

    const backups = backupsOf(home, 'cline');
    assert.equal(backups.length, 1, '写前必须留一份备份');
    assert.deepEqual(strayBackups(path.dirname(f)), [], '宿主扫描根里不许留 .bak 残渣');
    const bak = JSON.parse(fs.readFileSync(backups[0], 'utf8'));
    assert.equal(bak.metadata.title, '旧名', '备份里是改动前的值');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- 附带：readFirstJsonlField 只读不改 ----

test('readFirstJsonlField：只读第一个匹配行，不改文件', () => {
  const home = tmpHome('read-first');
  try {
    const f = path.join(home, 'x.jsonl');
    const body = [
      { type: 'custom-title', customTitle: '第一个' },
      { type: 'custom-title', customTitle: '第二个' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n';
    fs.writeFileSync(f, body);
    const r = readFirstJsonlField(f, 'custom-title', 'customTitle');
    assert.equal(r.found, true);
    assert.equal(r.value, '第一个');
    assert.equal(fs.readFileSync(f, 'utf8'), body, '只读不改文件');

    const nested = readFirstJsonlField(f, 'custom-title', 'data.title');
    assert.equal(nested.found, false, '嵌套路径取不到就说取不到');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('端到端：索引自愈不覆盖目标索引行的标题（target-ahead 场景的核心防线）', () => {
  const { ctx, regPath, SRC, idxFile } = makeWbSandbox('ensure-title-e2e');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });

    // 目标侧索引行：模拟「目标有自己的标题」（例如用户在 WorkBuddy 侧栏看到的名字）
    const db0 = new DatabaseSync(idxFile);
    const row0 = db0.prepare('SELECT id, title FROM sessions').get();
    assert.ok(row0, '导入后应有索引行');
    db0.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('目标自己的标题', row0.id);
    db0.close();

    // 目标侧多一轮 → 判 target-ahead；源侧同时改名（源侧标题是旧名）
    const body = targetBodyFile(ctx.home);
    fs.appendFileSync(body, JSON.stringify({
      type: 'message', role: 'user', timestamp: '2026-01-01T00:00:03.000Z',
      content: [{ type: 'input_text', text: '目标侧多的一轮' }],
    }) + '\n');
    const db = new DatabaseSync(regPath);
    db.prepare('UPDATE chat_sessions SET title = ? WHERE session_id = ?').run('源侧改名后的标题', SRC);
    db.close();

    const r = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(r[0].reason, 'target-ahead');

    const db2 = new DatabaseSync(idxFile);
    const row2 = db2.prepare('SELECT title FROM sessions WHERE id = ?').get(row0.id);
    db2.close();
    assert.equal(
      row2.title,
      '目标自己的标题',
      '索引自愈（ensureIndex）不得覆盖目标索引行的标题 —— 那是绕过 drift 窄判据的旁路',
    );
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

// ---- 端到端：target-ahead 与用户改名两个场景（修复 #1/#3 的核心证据） ----

/** 造「qoder 形态的源 + workbuddy 形态的目标」沙箱 */
function makeWbSandbox(name) {
  const home = tmpHome(name);
  const appData = path.join(home, 'AppData', 'Roaming');
  const SRC = 'aaaaaaaa-1111-2222-3333-444444444444';
  const CWD = 'D:/work/demo';

  const projDir = path.join(home, '.qoder-cn', 'projects', 'D--work-demo');
  fs.mkdirSync(projDir, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC, cwd: CWD, message: { role: 'user', content: '原始的第一句话' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', sessionId: SRC, cwd: CWD, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '回答' }] } },
  ];
  fs.writeFileSync(path.join(projDir, `${SRC}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  fs.mkdirSync(path.join(appData, 'com.qodercn.app.stable'), { recursive: true });
  const regPath = path.join(appData, 'com.qodercn.app.stable', 'main.sqlite');
  const reg = new DatabaseSync(regPath);
  reg.exec('CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, workspace_id TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, extra_json TEXT)');
  reg.prepare('INSERT INTO chat_sessions (session_id, title, cwd) VALUES (?,?,?)').run(SRC, '原始的第一句话', CWD);
  reg.close();

  fs.mkdirSync(path.join(home, '.workbuddy', 'projects'), { recursive: true });
  // 索引库：没有它 ensureIndex 会直接 skipped（index-db-absent），
  // 标题那条路径根本不会被执行 —— 覆盖不到就等于没测。
  const idxFile = path.join(home, '.workbuddy', 'workbuddy.db');
  const idx = new DatabaseSync(idxFile);
  idx.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT,
              status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, is_playground INTEGER,
              model TEXT, mode TEXT, last_activity_at INTEGER, source_mode TEXT, thought_level TEXT,
              transport TEXT, unread INTEGER)`);
  idx.close();

  const ctx = makeCtx({
    home, platform: 'win32', appData,
    localAppData: path.join(home, 'AppData', 'Local'),
    env: {},
    dataRoots: parseDataRoots(`workbuddy-cn=${path.join(home, '.workbuddy')}`),
  });
  return { home, ctx, regPath, SRC, idxFile };
}

function targetBodyFile(home) {
  const dir = path.join(home, '.workbuddy', 'projects');
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.name.endsWith('.jsonl') && !e.name.includes('.session-sync.')) return f;
    }
  }
  return null;
}

test('端到端：target-ahead（目标比源更新）时源侧改名不得覆盖目标标题', () => {
  const { ctx, regPath, SRC } = makeWbSandbox('ahead');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });

    // 目标侧多一轮（用户在 WorkBuddy 里继续聊）→ 目标 ⊋ 源 → 判 target-ahead
    const body = targetBodyFile(ctx.home);
    fs.appendFileSync(body, JSON.stringify({
      type: 'message', role: 'user', timestamp: '2026-01-01T00:00:03.000Z',
      content: [{ type: 'input_text', text: '目标侧多的一轮' }],
    }) + '\n');

    // 源侧改名（内容不变）
    const db = new DatabaseSync(regPath);
    db.prepare('UPDATE chat_sessions SET title = ? WHERE session_id = ?').run('源侧改名后的标题', SRC);
    db.close();

    const r = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(r[0].action, 'skip');
    assert.equal(r[0].reason, 'target-ahead', '目标比源更新 → 判 target-ahead');
    assert.notEqual(r[0].titleSynced, true, 'target-ahead 不是 identical，不该同步标题');
    assert.equal(
      listSessions('workbuddy-cn', ctx, {}).sessions[0].title,
      '原始的第一句话',
      '目标侧标题必须保持自己的，源侧旧名不得覆盖（这正是 ensureIndex 剥离前会踩的坑）',
    );
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('端到端：用户已在 WorkBuddy 改名（custom-title 行）→ 源侧改名不夺走用户的名字', () => {
  const { ctx, regPath, SRC } = makeWbSandbox('user-named');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });

    // 宿主写 custom-title 行（用户在 WorkBuddy 里手动改名）
    const body = targetBodyFile(ctx.home);
    const lines = fs.readFileSync(body, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 0, JSON.stringify({ type: 'custom-title', customTitle: '用户在WorkBuddy改的名', timestamp: Date.now() }));
    fs.writeFileSync(body, lines.join('\n') + '\n');

    // 源侧再改名
    const db = new DatabaseSync(regPath);
    db.prepare('UPDATE chat_sessions SET title = ? WHERE session_id = ?').run('源侧第二个名字', SRC);
    db.close();

    const r = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(r[0].reason, 'identical');
    assert.notEqual(r[0].titleSynced, true, '用户已定名 → 不同步');
    assert.equal(
      listSessions('workbuddy-cn', ctx, {}).sessions[0].title,
      '用户在WorkBuddy改的名',
      '读到的必须是用户的名字',
    );
    const aiTitle = fs.readFileSync(body, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o.type === 'ai-title');
    assert.equal(aiTitle.aiTitle, '原始的第一句话', 'ai-title 行也不被无声改写');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});
