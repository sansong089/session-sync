// m72 — 标题口径：读侧零截断 / 写侧按容量截断 / 比对用截断后的期望值
//
// 三轮真 bug 取证串起来就是这文件：
//   ① 起初读侧按 80 字截、写侧按 500 字截 → 超过 80 字的标题读回来永远比写进去的短，
//      每轮都判「源侧改过名」，同步永远做不完。
//   ② 把读侧上限抬到 500 后仍不对：**读的职责是如实反映事实**，读的时候截一刀，
//      用户看到的就已经不是宿主里的内容了。
//   ③ 写侧超容量当然是截断（不是报错：为一个超长标题让整条导入失败本末倒置），
//      但比对必须拿「截断后的期望值」去比，否则「源 600 字、目标存 500 字」永远不相等。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeTitle, previewTitle, fitTitleFor, TITLE_MAX, titleMaxOf, PREVIEW_LEN } from '../src/titles.mjs';
import { makeCtx } from '../src/hosts.mjs';
import { parseDataRoots } from '../src/roots.mjs';
import { listSessions } from '../src/readers/index.mjs';
import { createWorkbuddyWriter } from '../src/writers/workbuddy.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m72-${name}-`));
}

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

/** 造一个只有一条空壳会话的 workbuddy 沙箱 */
function seedWorkbuddy(home, id) {
  const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT,
             status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER)`);
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'D:/work', 'u1', '', 'Completed', 1, 2);
  db.close();
  const body = path.join(home, '.workbuddy', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(body), { recursive: true });
  fs.writeFileSync(body, [
    { type: 'session-meta', id, sessionId: id, cwd: 'D:/work', timestamp: '2026-10-01T00:00:00.000Z' },
    { type: 'message', role: 'user', content: '第一问', timestamp: '2026-10-01T00:00:01.000Z' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// ---------- 归一化：只折叠空白，永不截断 ----------

test('归一化：折叠连续空白（含换行）后 trim', () => {
  assert.equal(normalizeTitle('  甲\n\n乙\t丙  '), '甲 乙 丙');
  assert.equal(normalizeTitle('单行'), '单行');
});

test('归一化：空值一律给空串，兜底文案留给调用方', () => {
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(undefined), '');
  assert.equal(normalizeTitle('   '), '');
  assert.equal(normalizeTitle(0), '0', '数字标题不该被当空值丢掉');
});

test('归一化：读侧能力上就没有截断——传 maxLen 也不许截（防止旧口径复辟）', () => {
  const long = 'a'.repeat(2000);
  assert.equal(normalizeTitle(long).length, 2000);
  assert.equal(normalizeTitle(long, { maxLen: 5 }).length, 2000, '读侧截断已移除，传了参数也不许生效');
  const cn = '字'.repeat(800);
  assert.equal(Array.from(normalizeTitle(cn)).length, 800);
});

// ---------- 预览：只有它才截断 ----------

test('预览：按 code point 截断，不劈开 emoji 代理对', () => {
  const s = '🙂'.repeat(10);
  const cut = previewTitle(s, 5);
  assert.equal(Array.from(cut).length, 5);
  assert.equal(cut, '🙂'.repeat(5), '按 UTF-16 切会把 emoji 劈成半个代理对，读出来是乱码方块');
  assert.equal(previewTitle('一二三四五', 3), '一二三');
  assert.equal(previewTitle('abcde', 3), 'abc');
});

test('预览：默认长度 PREVIEW_LEN，且先折叠空白再截', () => {
  const text = `第一行\n第二行${'字'.repeat(200)}`;
  const p = previewTitle(text);
  assert.equal(Array.from(p).length, PREVIEW_LEN);
  assert.ok(!p.includes('\n'), '预览里不许留换行（列表是一行显示）');
});

// ---------- 写侧：按目标容量截断 ----------

test('写侧：按目标宿主原生容量截断，未登记的宿主不截断', () => {
  const long = 'x'.repeat(900);
  const wb = fitTitleFor('workbuddy', long);
  assert.equal(Array.from(wb.value).length, TITLE_MAX.workbuddy);
  assert.equal(wb.truncated, true);
  // 未登记 → 容量 0 → 原样保留（新增宿主忘了登记不该平白截断它）
  const unknown = fitTitleFor('还没接入的宿主', long);
  assert.equal(unknown.value, long);
  assert.equal(unknown.truncated, false);
});

test('写侧：变体区域后缀要能退回家族容量（workbuddy-cn / qoder-intl）', () => {
  assert.equal(titleMaxOf('workbuddy-cn'), TITLE_MAX.workbuddy);
  assert.equal(titleMaxOf('qoder-intl'), TITLE_MAX.qoder);
  // 精确名优先：codebuddy-ide 是 200，不许被退化成 codebuddy 的 500
  assert.equal(titleMaxOf('codebuddy-ide'), TITLE_MAX['codebuddy-ide']);
  assert.equal(titleMaxOf('还没接入的宿主'), 0);
  assert.ok(PREVIEW_LEN > 0 && PREVIEW_LEN < TITLE_MAX.workbuddy);
});

test('写侧：截断同样按 code point，不劈 emoji', () => {
  const fit = fitTitleFor('qoder', '🙂'.repeat(200));
  assert.equal(Array.from(fit.value).length, TITLE_MAX.qoder);
  assert.equal(fit.value, '🙂'.repeat(TITLE_MAX.qoder));
});

// ---------- 往返：读回来的必须正好是写进去的那一段 ----------

test('workbuddy：200 字标题写入后读回来一字不少（旧实现读侧只留 80 字 → 永远漂移）', () => {
  const home = tmpHome('roundtrip');
  try {
    const longTitle = `长标题${'字'.repeat(197)}`; // 200 字，小于 workbuddy 的 500 容量
    seedWorkbuddy(home, 's1');
    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const w = writer.syncTitle(wbCtx(home), { targetId: 's1', title: longTitle });
    assert.equal(w.changed, true, JSON.stringify(w));

    const r = listSessions('workbuddy-cn', wbCtx(home), {});
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const row = r.sessions.find((s) => s.id === 's1');
    assert.ok(row, '会话必须被列出');
    assert.equal(row.title, longTitle, `读回来的标题被截短了（写入 ${longTitle.length} 字 / 读回 ${row.title.length} 字）`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('workbuddy：600 字标题写进去只存 500 字，读回来就是那 500 字，再同步判「无变化」', () => {
  const home = tmpHome('overflow');
  try {
    const over = `头${'字'.repeat(599)}`; // 600 字 > 500 容量
    const expect = Array.from(over).slice(0, TITLE_MAX.workbuddy).join('');
    seedWorkbuddy(home, 's3');
    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const w = writer.syncTitle(wbCtx(home), { targetId: 's3', title: over });
    assert.equal(w.changed, true, JSON.stringify(w));

    const r = listSessions('workbuddy-cn', wbCtx(home), {});
    const row = r.sessions.find((s) => s.id === 's3');
    // 读侧不截断：宿主里就是这 500 字，读出来必须一字不差（不是再被读侧砍一刀）
    assert.equal(row.title, expect);

    // 关键：同一份源标题再同步一次必须判「没变化」。
    // 若比对拿的是未截断的 600 字源值，这里会永远 changed=true —— 每轮重写一遍。
    const again = writer.syncTitle(wbCtx(home), { targetId: 's3', title: over });
    assert.equal(again.changed, false, `超容量标题重复同步不许反复写盘：${JSON.stringify(again)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('workbuddy：带换行的标题写入后读回值与写入值相等（两侧同一套折叠规则）', () => {
  const home = tmpHome('fold');
  try {
    seedWorkbuddy(home, 's2');
    const writer = createWorkbuddyWriter({ variant: 'workbuddy-cn' });
    const messy = '  第一行\n第二行   第三段  ';
    const w = writer.syncTitle(wbCtx(home), { targetId: 's2', title: messy });
    assert.equal(w.changed, true, JSON.stringify(w));

    const r = listSessions('workbuddy-cn', wbCtx(home), {});
    assert.equal(r.sessions.find((s) => s.id === 's2').title, '第一行 第二行 第三段');
    // 再同步一次同样的名字必须判定「没变化」—— 否则每轮都在写同一个值
    const again = writer.syncTitle(wbCtx(home), { targetId: 's2', title: messy });
    assert.equal(again.changed, false, `同名重复同步不许反复写盘：${JSON.stringify(again)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 结构棘轮 ----------

function srcFiles(root = path.join(import.meta.dirname, '..', 'src'), dir = root) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(root, p));
    else if (e.name.endsWith('.mjs')) out.push({ file: path.relative(root, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

test('一题多解棘轮：标题归一化/预览/容量截断各只有一份实现（src/titles.mjs）', () => {
  const files = srcFiles();
  for (const name of ['normalizeTitle', 'previewTitle', 'fitTitleFor', 'titleMaxOf']) {
    const defs = files.filter((f) => new RegExp(`export function ${name}\\s*\\(`).test(f.text)).map((f) => f.file);
    assert.deepEqual(defs, ['titles.mjs'], `${name} 只允许一个实现，实际：${defs.join(', ')}`);
  }
});

test('读侧不许出现容量表：读取是如实反映，不是按落点容量加工', () => {
  const bad = srcFiles().filter((f) => f.file.startsWith('readers/') && /\bTITLE_MAX\b/.test(f.text)).map((f) => f.file);
  assert.deepEqual(bad, [], `读侧引用了 TITLE_MAX（说明又在按容量截断），这几处：${bad.join(', ')}`);
});

test('一题多解棘轮：落点 maxLen 一律取自 TITLE_MAX，不许写数字', () => {
  // 长度散在各处就会重演「读 80 / 写 500」—— 改了一处另一处不知道
  const bad = srcFiles().filter((f) => /maxLen:\s*\d/.test(f.text)).map((f) => f.file);
  assert.deepEqual(bad, [], `maxLen 必须引用 TITLE_MAX，这几处还写死了数字：${bad.join(', ')}`);
});

test('标题截断只发生在 titles.mjs 里（显示层除外）', () => {
  // 显示层按列宽截断是另一件事（cli.mjs 的表格排版），不在这条范围内
  // 只盯「title 这个标识符本身」被裸截断：`displayTitle}`、`searchable` 这类同名前缀不算
  const pattern = /(^|[^\w])title\s*(?:\|\|[^;\n]*)?\.slice\(0, *\d+\)/i;
  const hits = srcFiles().filter((f) => pattern.test(f.text) && f.file !== 'cli.mjs').map((f) => f.file);
  assert.deepEqual(hits, [], `标题截断必须走 titles.mjs，这几处还在裸 slice：${hits.join(', ')}`);
});
