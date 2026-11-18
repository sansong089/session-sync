// M17 测试：slug 派生必须与宿主等价（不允许「用我们自己的函数自证」）
//
// 期望值只有两个合法来源，本文件全部标注：
//   ① 现网真实目录名：`fs.readdir` 宿主目录 → 从会话正文里反解 cwd → 断言 slugFor*(cwd) === 目录名；
//   ② 宿主原文（本机安装包内实际代码，坐标写在每条 oracle 上）：
//      - claude  `@anthropic-ai/claude-code/bin/claude.exe` 内 `x0(e)`：
//                `e.replace(/[^a-zA-Z0-9]/g,"-")`，长度 >200 时 `slice(0,200)+"-"+Math.abs(srt(e)).toString(36)`
//                （`srt` = Java 风格 hashCode：`t=(t<<5)-t+c|0`；常量 `ixt=200`）
//      - pi      `@earendil-works/pi-coding-agent/dist/core/session-manager.js:293`：
//                `` `--${resolvedCwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` ``
//      - dsh     本机实测 `~/.dsh/sessions/--D-00-demo-app--`（同一 cwd 在 pi 下是 `--D--00-demo-app--`）
//                → 冒号被**丢弃**，`/ \` 变 `-`。dsh 安装包内未能取到原文，故其余字符按实测保守处理。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { slugForClaude, slugForPi, slugForWorkbuddy } from '../src/writers/base.mjs';
import { slugForDsh } from '../src/writers/dsh.mjs';

const home = os.homedir();

// ---- 宿主原文 oracle（逐字转写，不是我们的实现）----

function hostJavaHash(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) t = (t << 5) - t + s.charCodeAt(i) | 0;
  return t;
}
function claudeOracle(cwd) {
  const t = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return t.length <= 200 ? t : `${t.slice(0, 200)}-${Math.abs(hostJavaHash(cwd)).toString(36)}`;
}
function piOracle(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// ---- 现网真实目录名反推 ----

function firstCwdFromJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
    } catch {
      /* 坏行跳过 */
    }
  }
  return null;
}

function dshCwdFromSessionFile(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  if (buf.indexOf(MAGIC) !== 0) return null;
  for (let end = buf.length; end > MAGIC.length; end = Math.max(MAGIC.length + 1, end - 4096)) {
    let text = null;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(0, end)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        const cwd = o?.cwd ?? o?.data?.cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        /* 坏行跳过 */
      }
    }
    break;
  }
  return null;
}

/**
 * 通用：某宿主根下每个目录名 = slugFor*(该目录内会话的 cwd)
 * @param root    宿主根
 * @param slug    我们的实现
 * @param findCwd (dir) => cwd|null（取不到正文的目录跳过）
 */
function assertDirNamesMatch(t, root, slug, findCwd, { depth = 1 } = {}) {
  if (!fs.existsSync(root)) {
    t.skip(`${root} 不存在（本机未装该宿主），现网等值断言跳过`);
    return 0;
  }
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.length > 0, `${root} 下没有任何目录，无从取证`);
  let checked = 0;
  const unmatched = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    // 我们自己写过的目录不是宿主约定的证据：那是**旧版本照抄源侧 cwd**留下的残留
    // （源侧盘符大小写与宿主自己记的不一致 → 算出了另一个目录名）。
    // 这类残留正是本轮要修的东西，不能拿来反推宿主的命名约定。
    if (fs.readdirSync(full).some((n) => n.endsWith('.session-sync.json'))) continue;
    const cwd = findCwd(full, depth);
    if (!cwd) continue;
    checked++;
    if (slug(cwd) !== d) unmatched.push(`${d}  <=  ${cwd}  我们得到 ${slug(cwd)}`);
  }
  assert.deepEqual(unmatched, [], `现网目录名与派生结果不等的样本（共取证 ${checked} 个）`);
  assert.ok(checked > 0, `${root} 有 ${dirs.length} 个目录却一条 cwd 都没取到 —— 取证空跑`);
  return checked;
}

function jsonlCwdInDir(dir) {
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  for (const f of files) {
    const c = firstCwdFromJsonl(path.join(dir, f));
    if (c) return c;
  }
  return null;
}

function walkForFile(dir, maxDepth, match) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: d, depth } = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: f, depth: depth + 1 });
      else if (e.isFile() && match(e.name)) return f;
    }
  }
  return null;
}

test('claude：现网 ~/.claude/projects 目录名逐条反推相等', (t) => {
  assertDirNamesMatch(t, path.join(home, '.claude', 'projects'), slugForClaude, jsonlCwdInDir);
});

test('claude：>200 截断 + Java hashCode(原 cwd) 的 base36 后缀（宿主原文 x0）', () => {
  const long = `D:\\00-work\\code-active\\demo-app\\src\\main\\java\\com\\example\\deep\\nested\\module\\${'x'.repeat(120)}\\中文目录`;
  assert.ok(long.replace(/[^a-zA-Z0-9]/g, '-').length > 200, `样本必须超过 200 才测得到截断分支，实际 ${long.replace(/[^a-zA-Z0-9]/g, '-').length}`);
  const got = slugForClaude(long);
  assert.equal(got, claudeOracle(long));
  assert.equal(got.slice(0, 200), long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200), '前缀是截断后的 200 字符');
  assert.equal(got, `${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-${Math.abs(hostJavaHash(long)).toString(36)}`);
});

test('claude：中文/空格/点号一律变成单字符 - 且不折叠、不转小写（现网形态）', () => {
  // 现网真实样本：C:\Users\you → C--Users-you（冒号+反斜杠各成一个 -，原有 - 保留）
  assert.equal(slugForClaude('C:\\Users\\you'), 'C--Users-you');
  assert.equal(slugForClaude('D:\\01-github\\Gpt-Agreement-Payment'), 'D--01-github-Gpt-Agreement-Payment');
  // 宿主按「每个非字母数字字符一个 -」，不折叠、不转小写：':' '\' 工 作 ' ' 项 目 '\' '.' '_' 各占一位
  assert.equal(slugForClaude('D:\\工作 项目\\a.b_c'), 'D--------a-b-c');
  assert.equal(slugForClaude('D:\\工作 项目\\a.b_c'), claudeOracle('D:\\工作 项目\\a.b_c'));
});

test('pi：现网 ~/.pi/agent/sessions 目录名逐条反推相等', (t) => {
  assertDirNamesMatch(t, path.join(home, '.pi', 'agent', 'sessions'), slugForPi, jsonlCwdInDir);
});

test('pi：宿主只替换 / \\ : 三个字符（session-manager.js:293），点/下划线/空格/中文原样保留', () => {
  assert.equal(slugForPi('D:\\00-demo-app'), piOracle('D:\\00-demo-app'));
  assert.equal(slugForPi('D:\\00-demo-app'), '--D--00-demo-app--');
  assert.equal(slugForPi('C:\\Users\\you\\Documents\\Codex\\2026-08-07\\gei'), '--C--Users-you-Documents-Codex-2026-08-07-gei--');
  // 与 claude 的分界线：反斜杠仍变 '-'，但点/下划线/空格/中文原样保留（claude 会全部吃掉）
  assert.equal(slugForPi('D:\\a.b_c\\d e\\中文'), '--D--a.b_c-d e-中文--');
  assert.notEqual(slugForPi('D:\\a.b_c\\d e\\中文'), `--${slugForClaude('D:\\a.b_c\\d e\\中文')}--`);
  // 宿主会先去掉一个开头的 / 或 \（POSIX 根 /home/x → home-x）
  assert.equal(slugForPi('/home/you/proj'), '--home-you-proj--');
});

test('dsh：现网 ~/.dsh/sessions 目录名逐条反推相等', (t) => {
  const root = path.join(home, '.dsh', 'sessions');
  assertDirNamesMatch(t, root, slugForDsh, (dir) => {
    const f = walkForFile(dir, 2, (n) => n.startsWith('session.') && n.endsWith('.jsonl.zstd'));
    return f ? dshCwdFromSessionFile(f) : null;
  });
});

test('dsh：冒号被丢弃（与 pi 不等价），同一 cwd 两家目录名必须不同', () => {
  const cwd = 'D:\\00-demo-app';
  assert.equal(slugForDsh(cwd), '--D-00-demo-app--', '宿主真实目录名（本机存在）');
  assert.equal(slugForPi(cwd), '--D--00-demo-app--');
  assert.notEqual(slugForDsh(cwd), slugForPi(cwd));
  assert.equal(slugForDsh('C:\\Users\\you\\Documents\\deepseek-harness\\default-workspace'), '--C-Users-you-Documents-deepseek-harness-default-workspace--');
});

test('workbuddy：现网 ~/.workbuddy/projects slug 逐条反推相等', (t) => {
  assertDirNamesMatch(t, path.join(home, '.workbuddy', 'projects'), slugForWorkbuddy, jsonlCwdInDir);
});

test('空 cwd 不得产出宿主不认的 default 目录（改走 requires-cwd）', () => {
  assert.equal(slugForClaude(''), null);
  assert.equal(slugForClaude('   '), null);
  assert.equal(slugForPi(''), null);
  assert.equal(slugForDsh(''), null);
  assert.equal(slugForWorkbuddy(''), null);
});
