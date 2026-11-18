// M61 测试：标题同步的**统一方案** —— 一份槽机制 + 各家只声明落点
//
// 通性（主人 2026-11-03 明确）：标题问题是通性问题，不能一家一份 syncTitle。
// 统一方案 = 「槽声明 + 一份更新逻辑」：
//   - 槽的三种形状：db-column（表里的一列）/ body-row（正文某类行的一个字段）/ json-file（独立 JSON 文件的字段）
//   - 各家 writer 只声明自己的槽（表名列名行类型是各家的固有事实，不是策略）
//   - 更新逻辑只在 writers/title-slots.mjs 一份
//
// 这个文件钉死两件事：
//   1) 结构门禁：所有 writer 的 syncTitle 必须来自 makeTitleSyncer（不许再手写一份）；
//   2) 表驱动：每家声明的槽都真的能改到标题（夹具按声明形状造，验证改后能读回）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { WRITERS } from '../src/writers/index.mjs';
import { applyTitleSlots, makeTitleSyncer } from '../src/writers/title-slots.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m61-${name}-`));
}

test('结构门禁：没有 writer 手写 syncTitle —— 全部走 makeTitleSyncer（统一方案的唯一出口）', () => {
  for (const [variant, w] of Object.entries(WRITERS)) {
    if (!w?.syncTitle) continue;
    assert.equal(w.syncTitle.__fromTitleSlots, true, `${variant}: syncTitle 必须来自 makeTitleSyncer（统一方案，不许第二套）`);
  }
});

test('makeTitleSyncer 造出的函数带来源标记（结构门禁据此判定）', () => {
  const f = makeTitleSyncer(() => []);
  assert.equal(f.__fromTitleSlots, true);
  const g = (ctx, { targetId, title }) => ({ ok: true });
  assert.notEqual(g.__fromTitleSlots, true, '手写函数不得带这个标记');
});

test('槽机制：db-column —— 只改目标那一行，其他行不动', () => {
  const home = tmpHome('db');
  try {
    const dbPath = path.join(home, 'x.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT)');
    db.prepare('INSERT INTO sessions (id, title, cwd) VALUES (?,?,?)').run('a1', '旧名', 'D:/x');
    db.prepare('INSERT INTO sessions (id, title, cwd) VALUES (?,?,?)').run('b2', '别人的', 'D:/y');
    db.close();

    const r = applyTitleSlots(null, [{ kind: 'db-column', db: () => dbPath, table: 'sessions', idCol: 'id', col: 'title' }], { targetId: 'a1', title: '新名' });
    assert.equal(r.changed, true);
    const db2 = new DatabaseSync(dbPath);
    assert.equal(db2.prepare('SELECT title FROM sessions WHERE id = ?').get('a1').title, '新名');
    assert.equal(db2.prepare('SELECT title FROM sessions WHERE id = ?').get('b2').title, '别人的', '别的行不能被改');
    db2.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('槽机制：body-row —— 只改第一条匹配行，且支持嵌套字段路径', () => {
  const home = tmpHome('body');
  try {
    const f = path.join(home, 'x.jsonl');
    fs.writeFileSync(f, [
      { id: '1', type: 'session/title', data: { title: '旧名' } },
      { id: '2', type: 'session/title', data: { title: '第二条' } },
      { id: '3', type: 'message', message: { role: 'user', content: '正文' } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const r = applyTitleSlots({ home }, [{ kind: 'body-row', file: () => f, type: 'session/title', field: 'data.title' }], { targetId: 'x', title: '新名', variant: 'test' });
    assert.equal(r.changed, true);
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines[0].data.title, '新名', '嵌套字段被改');
    assert.equal(lines[1].data.title, '第二条', '第二条不动');
    assert.equal(lines[2].message.content, '正文', '正文不动');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('槽机制：json-file —— 独立 JSON 文件的字段路径', () => {
  const home = tmpHome('json');
  try {
    const f = path.join(home, 'id.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, metadata: { title: '旧名', totalCost: 0 } }, null, 2));
    const r = applyTitleSlots({ home }, [{ kind: 'json-file', file: () => f, field: 'metadata.title' }], { targetId: 'x', title: '新名', variant: 'test' });
    assert.equal(r.changed, true);
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(obj.metadata.title, '新名');
    assert.equal(obj.metadata.totalCost, 0, '同对象的其他字段不动');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('槽机制：复合主键（zcode 的 tasks 按 workspace_key + task_id）', () => {
  const home = tmpHome('composite');
  try {
    const dbPath = path.join(home, 't.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE tasks (workspace_key TEXT, task_id TEXT, title TEXT, PRIMARY KEY (workspace_key, task_id))');
    db.prepare('INSERT INTO tasks (workspace_key, task_id, title) VALUES (?,?,?)').run('D:/work', 't1', '旧名');
    db.close();
    const r = applyTitleSlots(null, [{ kind: 'db-column', db: () => dbPath, table: 'tasks', idCol: ['workspace_key', 'task_id'], idVals: ['D:/work', 't1'], col: 'title' }], { targetId: 't1', title: '新名' });
    assert.equal(r.changed, true);
    const db2 = new DatabaseSync(dbPath);
    assert.equal(db2.prepare('SELECT title FROM tasks WHERE workspace_key = ? AND task_id = ?').get('D:/work', 't1').title, '新名');
    db2.close();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('槽机制：值没变就不写（同值不重复落盘）', () => {
  const home = tmpHome('noop');
  try {
    const dbPath = path.join(home, 'x.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
    db.prepare('INSERT INTO sessions (id, title) VALUES (?,?)').run('a1', '同名');
    db.close();
    const r = applyTitleSlots(null, [{ kind: 'db-column', db: () => dbPath, table: 'sessions', idCol: 'id', col: 'title' }], { targetId: 'a1', title: '同名' });
    assert.equal(r.changed, false);
    assert.deepEqual(r.warnings, [], '同值不算警告');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 归类门禁：**有落点就必须声明槽**，没落点的必须逐家写明原因。
 *
 * 上一版这里是两份人肉名单，结果把 codebuddy-ide（index.json conversations[].name）、
 * claude（ai-title 行）、codex（threads.title）都误归类成「首问派生、无处可落」，
 * 于是三家明明能同步却一直不同步。教训：名单必须**自校验** ——
 * 「暂无落点」名单里的变体若已经有 syncTitle，立刻判红（名单过期必须被逼着改），
 * 反过来「没有 syncTitle 又不在名单里」也判红（新加宿主不能漏登记）。
 */
const NO_SLOT_REASONS = {
  // 标题就是首问的截断派生，宿主不落盘任何独立标题字段 —— 没有地方可写
  pi: '首问派生，无独立标题落点',
  freebuff: '首问派生，无独立标题落点',
};

test('归类门禁：没声明槽的必须逐家写明原因，且名单不许过期', () => {
  const declared = [];
  const silent = [];
  for (const [variant, w] of Object.entries(WRITERS)) {
    if (typeof w?.syncTitle === 'function') declared.push(variant);
    else silent.push(variant);
  }
  for (const v of silent) {
    assert.ok(NO_SLOT_REASONS[v], `${v}: 没声明标题槽，必须在 NO_SLOT_REASONS 里写明为什么没地方可落`);
  }
  for (const [v, reason] of Object.entries(NO_SLOT_REASONS)) {
    assert.ok(reason.trim().length > 0, `${v}: 原因不能是空话`);
    assert.equal(typeof WRITERS[v]?.syncTitle, 'undefined', `${v}: 已经声明了标题槽，必须从「暂无落点」名单里移出（名单过期）`);
  }
  // 反向：有落点的宿主必须真的能安全返回（目标全不存在时 ok:true、不抛）
  // 用真实 ctx 而不是 `{}`：各家解析落点要读 home / appData，空对象抛路径错误
  // 是「测试夹具不像话」，不是「生产路径有问题」
  const home = tmpHome('gate');
  try {
    const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {} });
    for (const v of declared) {
      const r = WRITERS[v].syncTitle(ctx, { targetId: 'x', title: 'y' });
      assert.equal(r?.ok, true, `${v}: syncTitle 在无落点时必须安全返回 ok:true`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
// 说明：「槽声明能不能真改到标题」不在这里用自造槽证明（自造槽只能证明机制对，
// 证明不了这家真的这样声明 —— dsh 的槽曾指向会话目录而正文是 zstd 多帧，自造明文夹具
// 把问题盖住了）。逐家真实声明的验证在 m68-title-real-declarations.test.mjs。
