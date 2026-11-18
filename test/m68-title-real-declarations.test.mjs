// M68 测试：标题槽的**真实**声明能不能改到标题（不自造夹具）
//
// m61 的教训：用自造槽证明「机制对」，证明不了「这家真的这样声明」——
// dsh 的槽指向会话目录（正文却是 zstd 多帧二进制），自造明文夹具把它盖住了。
// 这个文件一律调 `WRITERS[v].syncTitle` 的真实声明，并且用宿主真实形态的产物。
//
// 覆盖（review 2026-11-04 P1）：
//   dsh            正文 zstd 多帧 → 走 io 钩子解帧/重编码
//   codebuddy-ide  index.json 的 conversations[].name（数组元素按 id 定位，不许新建条目）
//   zcode          title_overridden=1 → guard 生效，不同步
//   guard          fail-closed：读不出来就按「已定名」处理，绝不覆盖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { dshWriter } from '../src/writers/dsh.mjs';
import { claudeWriter } from '../src/writers/claude.mjs';
import { codexWriter } from '../src/writers/codex.mjs';
import { codebuddyIdeWriter } from '../src/writers/codebuddy-ide.mjs';
import { zcodeWriter } from '../src/writers/zcode.mjs';
import { applyTitleSlots } from '../src/writers/title-slots.mjs';
import { decodeZstdFramesAll } from '../src/readers/dsh.mjs';
import { makeSession, messageItem } from '../src/ir.mjs';
import { backupsOf, strayBackups } from './backup-fixture.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m68-${name}-`));
}

function ctxFor(home, variants, env = {}) {
  return seedHostSeen(
    makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env }),
    variants,
  );
}

// ---- dsh：正文是 zstd 多帧，槽必须走 io 钩子 ----

function writeDshSession(home, id, title) {
  const dir = path.join(home, '.dsh', 'sessions', '--D-work-x--', id);
  fs.mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id, cwd: 'D:/work/x', seq: 0 },
    { type: 'session/title', seq: 1, time: Date.now(), data: { title, source: { kind: 'fallback' } } },
    { type: 'user/message', seq: 2, data: { role: 'user', content: [{ type: 'text', text: '第一轮' }] } },
  ];
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))));
  return { dir, file };
}

function readDshEvents(file) {
  const dec = decodeZstdFramesAll(fs.readFileSync(file));
  assert.equal(dec.ok, true, '产物必须能被 reader 解开');
  return dec.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('dsh：正文是 zstd 多帧时标题必须真的改到（槽不能指向目录）', () => {
  const home = tmpHome('dsh');
  try {
    const { file } = writeDshSession(home, 'dsh_1', '旧名');
    const ctx = ctxFor(home, ['dsh']);
    const r = dshWriter.syncTitle(ctx, { targetId: 'dsh_1', title: '新名' });
    assert.equal(r.changed, true, `必须改到：${JSON.stringify(r)}`);
    assert.deepEqual(r.warnings, [], `不该有告警：${JSON.stringify(r.warnings)}`);
    const events = readDshEvents(file);
    assert.equal(events.find((e) => e.type === 'session/title').data.title, '新名');
    assert.equal(events.find((e) => e.type === 'user/message').data.content[0].text, '第一轮', '其它事件必须逐字不动');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dsh：多条 session/title 时全部改写（读侧最后一条胜出）', () => {
  const home = tmpHome('dsh-multi');
  try {
    const dir = path.join(home, '.dsh', 'sessions', '--D-work-x--', 'dsh_2');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const events = [
      { type: 'session', version: 4, id: 'dsh_2', cwd: 'D:/work/x', seq: 0 },
      { type: 'session/title', seq: 1, data: { title: '旧名1' } },
      { type: 'session/title', seq: 2, data: { title: '旧名2' } },
      { type: 'session/title', seq: 3, data: { title: '旧名3' } },
    ];
    fs.writeFileSync(file, Buffer.concat(events.map((e) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))));
    const ctx = ctxFor(home, ['dsh']);
    const r = dshWriter.syncTitle(ctx, { targetId: 'dsh_2', title: '新名' });
    assert.equal(r.changed, true, JSON.stringify(r));
    const titles = readDshEvents(file).filter((e) => e.type === 'session/title').map((e) => e.data.title);
    assert.deepEqual(titles, ['新名', '新名', '新名'], '只改第一条会在宿主重写后显示旧名');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dsh：正文解不开时不同步（不把坏文件当空重写）', () => {
  const home = tmpHome('dsh-bad');
  try {
    const dir = path.join(home, '.dsh', 'sessions', '--D-work-x--', 'dsh_3');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, Buffer.from('这不是 zstd'));
    const ctx = ctxFor(home, ['dsh']);
    const r = dshWriter.syncTitle(ctx, { targetId: 'dsh_3', title: '新名' });
    assert.equal(r.changed, false);
    assert.ok(r.warnings.some((w) => /decode-failed/.test(String(w))), `必须说明解帧失败：${JSON.stringify(r.warnings)}`);
    assert.deepEqual(fs.readFileSync(file), Buffer.from('这不是 zstd'), '坏文件必须原样保留');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- codebuddy-ide：index.json 的 conversations[].name ----

// 真实形态：history 在 <Data>/<user>/<ide>[/<uid>]/history 之下（m49 同款）。
// 只给 CODEBUDDY_EXTENSION_HISTORY 而不给 DATA 是不够的 —— reader 扫的是 data 根，
// findConversation 找不到会话，槽会静默落到 json-file-absent（假绿）。
function makeIdeSandbox(home, id, name) {
  const data = path.join(home, 'Data');
  const hist = path.join(data, 'default', 'CodeBuddyIDE', 'history');
  const ws = 'ws-hash-1';
  fs.mkdirSync(path.join(hist, ws, id), { recursive: true });
  fs.writeFileSync(
    path.join(hist, ws, 'index.json'),
    `${JSON.stringify({ conversations: [{ id, type: 'craft', name, createdAt: '2026-10-01T00:00:00.000Z', lastMessageAt: '2026-10-01T00:00:00.000Z' }, { id: 'other', name: '别人的' }], current: id }, null, 2)}\n`,
  );
  return { data, hist, ws, indexFile: path.join(hist, ws, 'index.json') };
}

test('codebuddy-ide：改工作区索引里那条会话的 name，别人的条目不动', () => {
  const home = tmpHome('ide');
  try {
    const { data, hist, ws, indexFile } = makeIdeSandbox(home, 'conv-1', '旧名');
    const ctx = ctxFor(home, ['codebuddy-ide'], { CODEBUDDY_EXTENSION_DATA: data, CODEBUDDY_EXTENSION_HISTORY: hist });
    const r = codebuddyIdeWriter.syncTitle(ctx, { targetId: 'conv-1', title: '新名' });
    assert.equal(r.changed, true, JSON.stringify(r));
    const obj = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.equal(obj.conversations.length, 2, '不许凭空多出条目');
    assert.equal(obj.conversations.find((c) => c.id === 'conv-1').name, '新名');
    assert.equal(obj.conversations.find((c) => c.id === 'other').name, '别人的');
    assert.equal(obj.current, 'conv-1', '其它字段必须原样保留');
    const backups = backupsOf(home, 'codebuddy-ide').filter((n) => n.includes('index.json'));
    assert.ok(backups.length >= 1, '写前必须留备份');
    assert.deepEqual(strayBackups(path.join(hist, ws)), [], '宿主扫描根里不许留 .bak 残渣');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('codebuddy-ide：索引里没有这条会话时不新建条目', () => {
  const home = tmpHome('ide-miss');
  try {
    const { data, hist, indexFile } = makeIdeSandbox(home, 'conv-1', '旧名');
    const ctx = ctxFor(home, ['codebuddy-ide'], { CODEBUDDY_EXTENSION_DATA: data, CODEBUDDY_EXTENSION_HISTORY: hist });
    const before = fs.readFileSync(indexFile, 'utf8');
    // 会话目录存在（findConversation 能找到），但索引数组里没有对应 id
    const r = applyTitleSlots(ctx, [{ kind: 'json-file', file: () => indexFile, field: ['conversations', { by: 'id', eq: '$targetId' }, 'name'] }], {
      targetId: 'not-in-index',
      title: '新名',
    });
    assert.equal(r.changed, false);
    assert.ok(r.warnings.some((w) => /array-entry-absent/.test(String(w))), `必须说明条目不存在：${JSON.stringify(r.warnings)}`);
    assert.equal(fs.readFileSync(indexFile, 'utf8'), before, '索引必须一字不动');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- zcode：title_overridden 作为 guard ----

function makeZcode(home, { overridden }) {
  const zroot = path.join(home, '.zcode');
  fs.mkdirSync(path.join(zroot, 'cli', 'db'), { recursive: true });
  fs.mkdirSync(path.join(zroot, 'v2'), { recursive: true });
  const cli = path.join(zroot, 'cli', 'db', 'db.sqlite');
  const cdb = new DatabaseSync(cli);
  cdb.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT)');
  cdb.prepare('INSERT INTO session (id, directory, title) VALUES (?,?,?)').run('t1', 'D:/work', 'CLI旧名');
  cdb.close();
  const idx = path.join(zroot, 'v2', 'tasks-index.sqlite');
  const idb = new DatabaseSync(idx);
  idb.exec('CREATE TABLE tasks (workspace_key TEXT, task_id TEXT, title TEXT, cli_title TEXT, title_overridden INTEGER, PRIMARY KEY (workspace_key, task_id))');
  idb.prepare('INSERT INTO tasks (workspace_key, task_id, title, cli_title, title_overridden) VALUES (?,?,?,?,?)').run('D:/work', 't1', '用户改的名', '旧显示名', overridden);
  idb.close();
  return { ctx: ctxFor(home, ['zcode'], { ZCODE_HOME: zroot }), cli, idx };
}

test('zcode：用户在宿主改过名（title_overridden=1）→ 整条不同步', () => {
  const home = tmpHome('zcode-guard');
  try {
    const { ctx, cli, idx } = makeZcode(home, { overridden: 1 });
    const r = zcodeWriter.syncTitle(ctx, { targetId: 't1', title: '源侧新名' });
    assert.equal(r.changed, false);
    assert.equal(r.skipped, 'user-defined-title');
    const idb = new DatabaseSync(idx);
    assert.equal(idb.prepare('SELECT title FROM tasks').get().title, '用户改的名', '用户的名字不许被覆盖');
    assert.equal(idb.prepare('SELECT cli_title FROM tasks').get().cli_title, '旧显示名');
    idb.close();
    const cdb = new DatabaseSync(cli);
    assert.equal(cdb.prepare('SELECT title FROM session').get().title, 'CLI旧名', 'CLI 侧也不许动');
    cdb.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- guard fail-closed ----

test('guard：读不出来时按「已定名」处理（不覆盖），并如实告警', () => {
  const home = tmpHome('guard-fail');
  try {
    // 库文件存在但是坏的：打开/查询会失败 —— 这正是「一次锁库就覆盖用户名字」的场景
    const badDb = path.join(home, 'bad.sqlite');
    fs.writeFileSync(badDb, 'definitely not a sqlite file');
    const target = path.join(home, 'session.jsonl');
    fs.writeFileSync(target, `${JSON.stringify({ type: 'ai-title', aiTitle: '目标自己的名' })}\n`);

    const r = applyTitleSlots(
      null,
      [
        { kind: 'db-column', db: () => badDb, table: 'sessions', idCol: 'id', col: 'custom_title', guard: true },
        { kind: 'body-row', file: () => target, type: 'ai-title', field: 'aiTitle' },
      ],
      { targetId: 's1', title: '源侧新名' },
    );
    assert.equal(r.changed, false, '读不出 guard 就不能写');
    assert.equal(r.skipped, 'guard-unreadable');
    assert.ok(r.warnings.some((w) => /title-guard-unreadable/.test(String(w))), JSON.stringify(r.warnings));
    assert.equal(
      JSON.parse(fs.readFileSync(target, 'utf8').trim()).aiTitle,
      '目标自己的名',
      '目标正文必须一字不动',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('guard：数字位 0 视为「没定名」（title_overridden=0 不能永久挡住同步）', () => {
  const home = tmpHome('guard-zero');
  try {
    const dbFile = path.join(home, 'x.sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, title_overridden INTEGER)');
    db.prepare('INSERT INTO tasks (id, title, title_overridden) VALUES (?,?,?)').run('t1', '旧名', 0);
    db.close();
    const slot = { kind: 'db-column', db: () => dbFile, table: 'tasks', idCol: 'id', col: 'title_overridden', guard: true };
    const r = applyTitleSlots(null, [slot, { kind: 'db-column', db: () => dbFile, table: 'tasks', idCol: 'id', col: 'title' }], {
      targetId: 't1',
      title: '新名',
    });
    assert.equal(r.changed, true, '0 = 没被用户改过，应该允许同步');
    const db2 = new DatabaseSync(dbFile);
    assert.equal(db2.prepare('SELECT title FROM tasks WHERE id = ?').get('t1').title, '新名');
    db2.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- claude：正文的 ai-title 行（每会话多条，读侧最后一条胜出） ----

function writeClaudeBody(home, id, titles) {
  const dir = path.join(home, '.claude', 'projects', 'D-work-x');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: 'user', uuid: 'u1', sessionId: id, cwd: 'D:/work/x', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: '第一问' } },
    ...titles.map((t, i) => ({ type: 'ai-title', aiTitle: t, uuid: `t${i}`, sessionId: id, cwd: 'D:/work/x' })),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('claude：改最后一条 ai-title（读侧最后一条胜出，改第一条等于没改）', () => {
  const home = tmpHome('claude');
  try {
    const file = writeClaudeBody(home, 'c1', ['第一版', '第二版', '最新名']);
    const ctx = ctxFor(home, ['claude']);
    const r = claudeWriter.syncTitle(ctx, { targetId: 'c1', title: '源侧新名' });
    assert.equal(r.changed, true, JSON.stringify(r));
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const titles = rows.filter((x) => x.type === 'ai-title').map((x) => x.aiTitle);
    assert.deepEqual(titles, ['第一版', '第二版', '源侧新名'], '只动最后一条，历史标题保持原样');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('claude：新建会话时正文里就带上源标题（宿主立刻能显示，不必等它自己生成）', () => {
  const home = tmpHome('claude-create');
  try {
    const session = makeSession({
      id: 'c2',
      variant: 'claude',
      title: '导入的源标题',
      cwd: 'D:/work/x',
      createdAt: 1791484221000,
      updatedAt: 1791484221000,
      turns: [{ items: [messageItem('user', '第一问', 1791484221000), messageItem('assistant', '答', 1791484221500)] }],
    });
    const ctx = ctxFor(home, ['claude']);
    const res = claudeWriter.write(ctx, { session, targetId: 'c2', mode: 'create', provenance: null });
    assert.equal(res.ok, true, JSON.stringify(res));
    const rows = fs.readFileSync(res.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const titleRow = rows.find((x) => x.type === 'ai-title');
    assert.ok(titleRow, `新建正文必须带 ai-title 行：${JSON.stringify(rows.map((r) => r.type))}`);
    assert.equal(titleRow.aiTitle, '导入的源标题');
    // 槽也要能改到它（同一份真实声明）
    const r = claudeWriter.syncTitle(ctx, { targetId: 'c2', title: '改名后' });
    assert.equal(r.changed, true, JSON.stringify(r));
    const after = fs.readFileSync(res.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(after.find((x) => x.type === 'ai-title').aiTitle, '改名后');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- codex：线程库 threads.title，threads.name 作 guard ----

function makeCodexThreads(home, rows) {
  const root = path.join(home, '.codex');
  fs.mkdirSync(path.join(root, 'sessions', '2026', '10', '14'), { recursive: true });
  const file = path.join(root, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  for (const r of rows) db.prepare('INSERT INTO threads (id, name, title) VALUES (?,?,?)').run(r.id, r.name ?? null, r.title ?? null);
  db.close();
  return file;
}

test('codex：改 threads.title，且不替宿主新建线程行', () => {
  const home = tmpHome('codex');
  try {
    const file = makeCodexThreads(home, [{ id: 'x1', name: null, title: '旧标题' }]);
    const ctx = ctxFor(home, ['codex']);
    const r = codexWriter.syncTitle(ctx, { targetId: 'x1', title: '源侧新名' });
    assert.equal(r.changed, true, JSON.stringify(r));
    let db = new DatabaseSync(file);
    assert.equal(db.prepare('SELECT title FROM threads WHERE id = ?').get('x1').title, '源侧新名');
    db.close();
    // 库里没有的线程：只告警，不许 INSERT 一条打不开的会话
    const miss = codexWriter.syncTitle(ctx, { targetId: 'nope', title: '不该出现' });
    assert.equal(miss.changed, false, JSON.stringify(miss));
    db = new DatabaseSync(file);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM threads').get().c, 1, '不许凭空多出线程行');
    db.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('codex：用户在宿主里改过名（threads.name 非空）→ 整条不同步', () => {
  const home = tmpHome('codex-guard');
  try {
    const file = makeCodexThreads(home, [{ id: 'x2', name: '用户自己起的', title: '自动摘要' }]);
    const ctx = ctxFor(home, ['codex']);
    const r = codexWriter.syncTitle(ctx, { targetId: 'x2', title: '源侧新名' });
    assert.equal(r.changed, false, JSON.stringify(r));
    assert.equal(r.skipped, 'user-defined-title', JSON.stringify(r));
    const db = new DatabaseSync(file);
    const row = db.prepare('SELECT name, title FROM threads WHERE id = ?').get('x2');
    db.close();
    assert.equal(row.name, '用户自己起的', '用户定名不许动');
    assert.equal(row.title, '自动摘要', 'guard 命中时 title 也不许动');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
