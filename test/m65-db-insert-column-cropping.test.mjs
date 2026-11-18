// M65 测试：db 行写入只有**一个出口**（insertRowFiltered / updateRowFiltered）
//
// 历史：宿主 schema 会随版本加减列（真机取证：WorkBuddy baseline 没有
// transport / unread / thought_level），写死列名就会在老库上整条 INSERT 失败。
// 第一轮修复把「按实际列裁剪」补进了 7 家 writer —— 但每家各手写一份（约 27 处），
// 口径稍有出入就是串位或半写。第二轮（review 2026-11-04 P0-2）收敛为唯一出口，
// 这个文件就是防止它再长回去的棘轮。
//
// 主人铁律：同一件事两处实现 = 一题多解 = 必须修。所以断言的是「结构上不可能有第二份」，
// 不是「这几处写得对」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const WRITERS = path.join(SRC, 'writers');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

/** src 下所有 .mjs（含子目录），用于「定义唯一」这类全局断言 */
function allSources(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allSources(p));
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// 有 db 写入的 writer。cline 的 sessions 表是我们自己建的（CLINE_SESSIONS_DDL），
// 列集由我们决定，不存在「宿主换版本增删列」的风险 —— 唯一豁免，理由写在代码注释里。
const DB_WRITERS = ['workbuddy', 'opencode', 'opencode-classic', 'zcode', 'minimax', 'qoder', 'project', 'codex', 'cline'];
const SELF_BUILT_TABLE = new Set(['cline']);

test('列裁剪只有一个实现：insertRowFiltered / updateRowFiltered 各自只在 writers/base.mjs 定义一次', () => {
  const files = allSources();
  const defs = { insertRowFiltered: [], updateRowFiltered: [] };
  for (const f of files) {
    const src = read(f);
    for (const name of Object.keys(defs)) {
      const re = new RegExp(`export function ${name}\\s*\\(`, 'g');
      if (re.test(src)) defs[name].push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(defs.insertRowFiltered, ['src/writers/base.mjs'], `insertRowFiltered 必须只有一处定义：${defs.insertRowFiltered.join(', ')}`);
  assert.deepEqual(defs.updateRowFiltered, ['src/writers/base.mjs'], `updateRowFiltered 必须只有一处定义：${defs.updateRowFiltered.join(', ')}`);
});

test('db writer 里不许再手写 INSERT（一律走 insertRowFiltered）', () => {
  const offenders = [];
  for (const name of DB_WRITERS) {
    if (SELF_BUILT_TABLE.has(name)) continue;
    const src = read(path.join(WRITERS, `${name}.mjs`));
    const hits = [...src.matchAll(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+\w+/g)].map((m) => m[0]);
    if (hits.length) offenders.push(`${name}.mjs → ${hits.join(' | ')}`);
  }
  assert.deepEqual(offenders, [], `这些 writer 还在手写 INSERT（列裁剪会重新分叉）：\n  ${offenders.join('\n  ')}`);
});

test('db writer 里不许再手写「动态 SET」UPDATE（一律走 updateRowFiltered）', () => {
  const offenders = [];
  for (const name of DB_WRITERS) {
    if (SELF_BUILT_TABLE.has(name)) continue;
    const src = read(path.join(WRITERS, `${name}.mjs`));
    // 动态列集的写法：`UPDATE t SET ${...}`（固定列名的 `SET a = ?` 不算 —— 那不是裁剪）
    const hits = [...src.matchAll(/UPDATE\s+\w+\s+SET\s+\$\{/g)].map((m) => m[0]);
    if (hits.length) offenders.push(`${name}.mjs → ${hits.join(' | ')}`);
  }
  assert.deepEqual(offenders, [], `这些 writer 还在拼动态 SET 列表：\n  ${offenders.join('\n  ')}`);
});

test('用到 db 写入的 writer 必须导入唯一出口', () => {
  const missing = [];
  for (const name of DB_WRITERS) {
    const src = read(path.join(WRITERS, `${name}.mjs`));
    const uses = /\b(insertRowFiltered|updateRowFiltered)\(/.test(src);
    const imports = /import \{[^}]*\b(insertRowFiltered|updateRowFiltered)\b[^}]*\} from '\.\/base\.mjs'/.test(src);
    if (uses && !imports) missing.push(name);
    if (!uses) missing.push(`${name}（没有调用任何出口 —— 核查它的 db 写入去哪了）`);
  }
  assert.deepEqual(missing, [], `这些 writer 没走唯一出口：${missing.join(', ')}`);
});

test('cline 的自建表豁免必须写明理由', () => {
  const src = read(path.join(WRITERS, 'cline.mjs'));
  assert.match(src, /自建表/, 'cline 走自建表豁免，代码里必须写明理由（否则以后有人以为可以随便硬编码）');
});

test('writer 不许自己写 PRAGMA table_info（列名只有一个来源）', () => {
  const offenders = [];
  for (const e of fs.readdirSync(WRITERS)) {
    if (!e.endsWith('.mjs')) continue;
    if (read(path.join(WRITERS, e)).includes('PRAGMA table_info')) offenders.push(e);
  }
  assert.deepEqual(offenders, [], `这些 writer 自己写了 PRAGMA table_info（应走 readers/base 的 tableColumns）：${offenders.join(', ')}`);
});

test('唯一出口支持三种真实形态：数组 pairs / 对象 / ON CONFLICT 裁剪', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { insertRowFiltered, updateRowFiltered } = await import('../src/writers/base.mjs');
  const home = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'ss-m65-'));
  try {
    const db = new DatabaseSync(path.join(home, 'x.sqlite'));
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, a TEXT, b TEXT)');
    try {
      // 数组 pairs：不存在的列被裁掉，不报错
      const r1 = insertRowFiltered(db, 't', [['id', 'x1'], ['a', 'A'], ['missing_col', 'Z']]);
      assert.equal(r1.ok, true);
      assert.deepEqual(r1.cols, ['id', 'a'], '只写实际存在的列');
      assert.deepEqual({ ...db.prepare('SELECT * FROM t WHERE id = ?').get('x1') }, { id: 'x1', a: 'A', b: null });

      // 对象形态
      const r2 = insertRowFiltered(db, 't', { id: 'x2', b: 'B', nope: 1 });
      assert.deepEqual(r2.cols, ['id', 'b']);

      // ON CONFLICT 的 DO UPDATE 也要裁剪（zcode tasks 就栽在这）
      const r3 = insertRowFiltered(db, 't', [['id', 'x1'], ['a', 'A2'], ['missing_col', 'Z']], {
        onConflict: { conflictCols: ['id'], updateCols: ['a', 'missing_col'] },
      });
      assert.equal(r3.ok, true);
      assert.equal(db.prepare('SELECT a FROM t WHERE id = ?').get('x1').a, 'A2', 'upsert 必须真的更新');

      // 一列都不剩：默认报错，ifEmpty:skip 时交给调用方
      assert.equal(insertRowFiltered(db, 't', [['nope', 1]]).ok, false);
      assert.equal(insertRowFiltered(db, 't', [['nope', 1]], { ifEmpty: 'skip' }).inserted, false);

      // UPDATE 同样裁剪
      const u = updateRowFiltered(db, 't', [['a', 'A3'], ['missing_col', 1]], { id: 'x1' });
      assert.deepEqual(u.cols, ['a']);
      assert.equal(db.prepare('SELECT a FROM t WHERE id = ?').get('x1').a, 'A3');

      // returnRowId 透传（minimax 的 projects 需要）
      db.exec('CREATE TABLE auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
      const r4 = insertRowFiltered(db, 'auto', [['v', 'v1']], { returnRowId: true });
      assert.equal(Number(r4.lastInsertRowid), 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('老库缺列时仍能写（行为底线：m63 的通用版）', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { insertRowFiltered } = await import('../src/writers/base.mjs');
  const home = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'ss-m65-old-'));
  try {
    const db = new DatabaseSync(path.join(home, 'old.sqlite'));
    // 老版本 shape：只有 baseline 的列
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT)');
    try {
      const r = insertRowFiltered(db, 'sessions', [
        ['id', 's1'],
        ['cwd', 'D:/w'],
        ['title', 'T'],
        ['transport', 'local'], // 新版本才有的列
        ['thought_level', null],
      ]);
      assert.equal(r.ok, true);
      assert.deepEqual(r.cols, ['id', 'cwd', 'title']);
      assert.deepEqual({ ...db.prepare('SELECT * FROM sessions').get() }, { id: 's1', cwd: 'D:/w', title: 'T' });
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
