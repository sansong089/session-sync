// M64 测试：一题多解的结构棘轮 —— 同一件事只允许一个出口
//
// 主人的硬性规则：同一件事出现两处及以上实现，一律视为一题多解，必须收敛为唯一出口。
// 这条用例把「唯一出口」变成可执行断言，防止以后又长出第二套。
//
// 收敛记录（2026-11-03）：
//   PRAGMA table_info  5 处 → 1（readers/base.mjs 的 tableColumns；新增 tableHasColumn 供「查单列」）
//   inRange            12 处 → 0（8 个本地转发壳 + 4 个 import opencode 的；唯一出口 = base 的 inTimeRange）
//   slugOf             2 处 → 1（writers/base.mjs；opencode 与 opencode-classic 是同宿主两代，规则必须一致）
//   outputText         2 处 → 1（readers/base.mjs 的读侧口径；workbuddy 那份处理 content 数组，是宿主事实差异）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function srcFiles() {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) out.push(p);
    }
  })(SRC);
  return out;
}

const ALL = srcFiles().map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

/** 统计「在文件里定义了该名字的函数」的次数 */
function definitionsOf(name) {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, 'gm');
  return ALL.filter((f) => re.test(f.text)).map((f) => f.file);
}

test('一题多解棘轮：PRAGMA table_info 全仓只有一个出口', () => {
  const hits = ALL.filter((f) => f.text.includes('PRAGMA table_info')).map((f) => f.file);
  assert.deepEqual(hits, ['src\\readers\\base.mjs'], `「取表的列名」只允许一个出口，实际有：${hits.join(', ')}`);
});

test('一题多解棘轮：inRange 已归零（唯一出口是 base 的 inTimeRange）', () => {
  const hits = ALL.filter((f) => /\binRange\b/.test(f.text)).map((f) => f.file);
  assert.deepEqual(hits, [], `inRange 转发壳必须删干净，实际残留：${hits.join(', ')}`);
  // 唯一出口确实在 base 且被多家使用
  const base = ALL.find((f) => f.file.endsWith('readers\\base.mjs'));
  assert.match(base.text, /export function inTimeRange/);
});

test('一题多解棘轮：slugOf 只有一个定义（writers/base）', () => {
  const defs = definitionsOf('slugOf');
  assert.deepEqual(defs, ['src\\writers\\base.mjs'], `opencode 两代必须共用一份 slug 规则，实际定义在：${defs.join(', ')}`);
});

test('一题多解棘轮：工具输出转文本只有一份实现（src/text.mjs）', () => {
  // 曾经有四份：util.toolOutputText / readers-base.outputText / writers-base.outputToText
  // / readers-workbuddy 私有版，另加 claude、dsh、pi 三处内联展平。
  // 四份的数组分支逐字节相同，只在 null 与 {content[]} 上分岔 —— 典型的同体不同名，
  // 靠「同名同体」那道棘轮抓不到，所以这里直接盯**实现指纹**。
  const defs = definitionsOf('outputText');
  assert.deepEqual(defs, ['src\\text.mjs'], `「工具输出 → 文本」只允许一个实现，实际定义在：${defs.join(', ')}`);

  // 数组展平的指纹：任何地方再手写一遍展平都会被这条抓住
  const fingerprint = /typeof c === 'string' \? c : c\?\.text \?\? ''/;
  const hits = ALL.filter((f) => fingerprint.test(f.text)).map((f) => f.file);
  assert.deepEqual(hits, ['src\\text.mjs'], `展平文本块只允许在 text.mjs 里写一次，实际出现在：${hits.join(', ')}`);

  // 转发壳允许存在（util / readers-base / writers-base 保留旧导入名），但只能是转发
  for (const file of ['src\\util.mjs', 'src\\readers\\base.mjs', 'src\\writers\\base.mjs']) {
    const f = ALL.find((x) => x.file === file);
    assert.ok(f, `${file} 缺失`);
    assert.match(f.text, /export \{ outputText \} from '\.\.?\/text\.mjs'|export \{ outputText \}/, `${file}: 必须是从 text.mjs 转发`);
    assert.doesNotMatch(f.text, /function outputText\s*\(/, `${file}: 不许再有本地实现`);
  }
});

test('一题多解棘轮：复合键 WHERE 拼接只有一个出口（writers/base）', () => {
  // 复合主键定位（`a = ? AND b = ?`）曾经有三份手写：title-slots 的读 guard、title-slots
  // 的写分支（与前者同构）、zcode 的 tasks 查询。三份各漂各的，其中一处漏了「键算不出来
  // 要 fail-closed」的判定，就会拿半个键去命中别人的行。
  const pattern = /= \? AND \w+ = \?/;
  const hits = ALL.filter((f) => pattern.test(f.text)).map((f) => f.file);
  assert.deepEqual(hits, ['src\\writers\\base.mjs'], `复合条件拼接只允许在 base.mjs 里写一次，实际出现在：${hits.join(', ')}`);

  // 三处调用点必须真的走同一份解析：谁再手写一遍 idCols/idVals 就会在这里露出来
  for (const file of ['src\\writers\\title-slots.mjs', 'src\\writers\\zcode.mjs']) {
    const f = ALL.find((x) => x.file === file);
    assert.ok(f, `${file} 缺失`);
    assert.match(f.text, /keyWhereOf|resolveKeyWhere/, `${file}: 复合键定位必须走 base 的出口`);
    assert.doesNotMatch(f.text, /idCols\.map\(/, `${file}: 不许自己拼 WHERE`);
  }
});

test('一题多解棘轮：跨文件同名同体的函数实现不存在', () => {
  // 归一化函数体后找「同名 + 同实现 + 跨文件」的重复
  // 函数体的 `{` 必须跳过参数表里那些默认值对象（`opts = {}`）：
  // 直接找第一个 `{` 会把 `{}` 当成整个函数体，两个不同实现的函数归一化后都成了 `{}`，
  // 于是被误判成「同名同体」——假阳性比漏报更糟，它会把真实差异掩盖掉
  function bodyStartOf(text, parenIdx) {
    let depth = 0;
    for (let j = parenIdx; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) return text.indexOf('{', j);
      }
    }
    return -1;
  }
  function bodyOf(text, i) {
    if (i < 0) return '';
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
    }
    return '';
  }
  const norm = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, '');
  const byName = new Map();
  for (const f of ALL) {
    const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m;
    while ((m = re.exec(f.text)) !== null) {
      const name = m[1];
      const bi = bodyStartOf(f.text, m.index + m[0].length - 1);
      if (bi < 0) continue;
      const body = norm(bodyOf(f.text, bi));
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ file: f.file, body });
      re.lastIndex = bi;
    }
  }
  const dupes = [];
  for (const [name, list] of byName) {
    const uniq = new Set(list.map((x) => x.body));
    if (uniq.size !== 1) continue;
    if (new Set(list.map((x) => x.file)).size < 2) continue;
    dupes.push(`${name}（${list.map((x) => x.file).join(', ')}）`);
  }
  assert.deepEqual(dupes, [], `同一件事两套答案：${dupes.join('; ')}`);
});
