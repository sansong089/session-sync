// M82 测试：入口证据层（S2 进程链 + 宿主按 pid 自生成的归属文件）与「同族双装 + 无 env」那一格
//
// 为什么单独一份：2026-11-10 在豆包里发起的导入被判成 workbuddy-cn，真写了 320 行进去
// （轨迹里白纸黑字 `host: workbuddy-cn [newest-store]`）。那不是我挑错了判据，而是**判不出时
// 结构上只剩 mtime 一条路**；而「中英双装 + 一个 env 信号都没有」这一格此前零覆盖 ——
// 历次修复分别落在定位层/文档层/测试层，判定层一直跑旧代码，所以反复不解决。
// 这里锁两侧：判不出时必须**拒绝写入且零副作用**，正面证据必须真能定 edition（且不互相压住）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectHost, makeCtx } from '../src/hosts.mjs';
import { sandboxEnv } from './matrix-home.mjs';

const tmpHome = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ss-m82-${name}-`));

// 归属文件：WorkBuddy 自己写的东西，形状按真机（<数据根>/cache/acc-product-config-v3-<pid>-<guid>.json，
// 文件里 dataFolderName 是它对数据根的自声明）
function seedPidFile(home, root, pid, declare) {
  const dir = path.join(home, root, 'cache');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `acc-product-config-v3-${pid}-00000000-0000-0000-0000-000000000000.json`);
  fs.writeFileSync(f, JSON.stringify({ productName: declare === '.workbuddy-ai' ? 'WorkBuddy AI' : 'WorkBuddy', dataFolderName: declare, endpoint: 'https://example.invalid' }));
  return f;
}

const ctxOf = (home, { env = {}, chain, platform = 'win32' } = {}) =>
  makeCtx({ home, platform, env, procChain: chain === undefined ? [] : chain });

test('归属文件命中：链上 pid 出现在哪一版的数据根里，就是哪一版在调用', () => {
  const home = tmpHome('pidfile');
  seedPidFile(home, '.workbuddy', 777, '.workbuddy');
  const hit = detectHost(ctxOf(home, { chain: [{ pid: 1, exe: 'C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, { pid: 777, exe: 'C:\\x\\WorkBuddy.exe' }] }), { entry: true });
  assert.equal(hit.state, 'identified', `应该判得出中文版，实际 ${JSON.stringify(hit)}`);
  assert.equal(hit.variant, 'workbuddy-cn');
  assert.equal(hit.confidence, 'entry', '结论来源必须记成入口，不能冒充 env');

  seedPidFile(home, '.workbuddy-ai', 888, '.workbuddy-ai');
  const intl = detectHost(ctxOf(home, { chain: [{ pid: 888, exe: 'C:\\y\\WorkBuddyAI.exe' }] }), { entry: true });
  assert.equal(intl.variant, 'workbuddy-intl');

  // 两个 pid 分别落在两版 → 谁也不许压住谁，只能报候选
  const both = detectHost(ctxOf(home, { chain: [{ pid: 777, exe: 'a' }, { pid: 888, exe: 'b' }] }), { entry: true });
  assert.equal(both.state, 'ambiguous');
  assert.deepEqual(both.candidates.slice().sort(), ['workbuddy-cn', 'workbuddy-intl']);
});

test('归属文件自己声明的根名与所在目录不一致时不作证据（不靠文件名猜）', () => {
  const home = tmpHome('mismatch');
  // 文件躺在 .workbuddy 里，却声明 .workbuddy-ai：内容读不通就不算命中
  seedPidFile(home, '.workbuddy', 999, '.workbuddy-ai');
  const r = detectHost(ctxOf(home, { chain: [{ pid: 999, exe: 'C:\\x\\WorkBuddy.exe' }] }), { entry: true });
  assert.equal(r.state, 'unknown', `声明与位置矛盾却给出结论：${JSON.stringify(r)}`);
  assert.equal(r.variant, null);
});

test('链上的可执行文件路径能定豆包；判出来后写入仍被拒（豆包只读）', () => {
  const home = tmpHome('doubao-exe');
  const chain = [{ pid: 21, exe: 'C:\\Users\\t\\AppData\\Local\\Doubao\\User Data\\sandbox_runtime\\bases\\deadbeef\\pwsh\\pwsh.exe' }, { pid: 20, exe: 'C:\\Users\\t\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe' }];
  const r = detectHost(ctxOf(home, { chain }), { entry: true });
  assert.equal(r.state, 'identified');
  assert.equal(r.variant, 'doubao');
  // 形状近似但不相等的路径不许算命中（整段匹配）
  const fake = detectHost(ctxOf(home, { chain: [{ pid: 5, exe: 'D:\\tools\\notDoubao\\Application\\app\\Doubao.exe' }] }), { entry: true });
  assert.equal(fake.state, 'unknown', `近似路径被当成豆包：${JSON.stringify(fake)}`);
});

test('S1 只到家族级时入口证据可以细化；S1 已定身份时入口不得推翻（R2）', () => {
  const home = tmpHome('refine');
  seedPidFile(home, '.workbuddy-ai', 4242, '.workbuddy-ai');
  const chain = [{ pid: 4242, exe: 'C:\\x\\e.exe' }];
  // WORKBUDDY_APP_VERSION 两版共用 → S1 只能到家族级；入口证据把范围收到 intl
  const refined = detectHost(ctxOf(home, { env: { WORKBUDDY_APP_VERSION: '37.10.3' }, chain }), { entry: true });
  assert.equal(refined.state, 'identified', `家族级 + 入口证据应当能定 edition：${JSON.stringify(refined)}`);
  assert.equal(refined.variant, 'workbuddy-intl');
  assert.match(refined.evidence, /WORKBUDDY_APP_VERSION\+entry:/, '结论必须把两层证据都记下来，不许只留最后一条');

  // 同一条链落在没声明过的根里 → 仍只能 ambiguous，不许"不是 cn 就 intl"（R3）
  const bare = detectHost(ctxOf(home, { env: { WORKBUDDY_APP_VERSION: '37.10.3' } }), { entry: true });
  assert.equal(bare.state, 'ambiguous');
  assert.equal(bare.variant, null);
});

test('env 已定身份时根本不查进程链（不白付一次外部查询）', () => {
  const home = tmpHome('cheap');
  seedPidFile(home, '.workbuddy', 111, '.workbuddy');
  const r = detectHost(ctxOf(home, { env: { WORKBUDDY_CONFIG_DIR: `${home}/.workbuddy` }, chain: [{ pid: 111, exe: 'x' }] }), { entry: true });
  assert.equal(r.confidence, 'env');
  assert.ok(!('chain' in r), 'env 出结论时不该把链算出来带回去');
});

test('链查不到（空）时只能 unknown，且活动度只作解释不作目标', () => {
  const home = tmpHome('nochain');
  const r = detectHost(ctxOf(home, { chain: [] }), { entry: true });
  assert.equal(r.state, 'unknown');
  assert.equal(r.variant, null);
  assert.ok(r.hint === undefined || typeof r.hint === 'string', 'hint 只能是一个说明用的变体名');
});

// ---- 事故回归：这一格必须"一个字节都不写" ----
const treeHash = (dir) => {
  const acc = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, `${rel}${e.name}/`);
      else acc.push(`${rel}${e.name}:${fs.statSync(f).size}`);
    }
  };
  walk(dir, '');
  return acc.join('|');
};

test('同族双装 + 无 env 信号：省略 --into 的 import 必须退出 1 且沙箱树零改动', () => {
  const home = tmpHome('incident');
  // 两版数据根都在，cn 侧「最近被改动」—— 旧代码正是靠这一点把目标定成 workbuddy-cn
  const cn = path.join(home, '.workbuddy');
  const intl = path.join(home, '.workbuddy-ai');
  for (const [root, age] of [[intl, 1], [cn, 0]]) {
    fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
    const f = path.join(root, 'projects', 'p', 's.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', sessionId: 's', cwd: home, message: { role: 'user', content: '占位' } }) + '\n');
    fs.utimesSync(f, new Date(2026, 10, 1, 0, 0, age), new Date(2026, 10, 1, 0, 0, age));
  }
  const before = treeHash(home);
  // 整套目录变量都关进沙箱：只抹 HOME 的话 LOCALAPPDATA 仍指向真机，
  // 万一这条回归失败，测试就会往真实宿主里写东西；断言也会变成「看这台机器装了什么」。
  const env = {
    ...sandboxEnv(home),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PROGRAMFILES: path.join(home, 'Programs'),
    ProgramFiles: path.join(home, 'Programs'),
    'PROGRAMFILES(X86)': path.join(home, 'Programs (x86)'),
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, ['bin/session-sync.mjs', 'import', '--from', 'claude', '--id', 'does-not-matter'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  assert.equal(code, 1, `判不出宿主却没能拦住写入（exit ${code}）：${out}`);
  assert.match(out, /身份信号/, `拒绝时得说清为什么，实际：${out}`);
  assert.doesNotMatch(out, /→ workbuddy-(cn|intl):/, `把某版当默认目标端出来了：${out}`);
  assert.equal(treeHash(home), before, '被拒绝的一次运行必须零副作用');

  // 上面只证明了 CLI 层的拒绝；这里必须直接打判定层：沙箱里两版都「装过」，
  // 活动度确实会指向 cn —— 一旦有人把 hint 当结论返回，这条就要红。
  const ctx = makeCtx({ home, platform: 'win32', env, procChain: [], appData: env.APPDATA, localAppData: env.LOCALAPPDATA, xdgConfig: env.XDG_CONFIG_HOME, xdgData: env.XDG_DATA_HOME, programFiles: env.PROGRAMFILES });
  const h = detectHost(ctx, { entry: true });
  assert.equal(h.variant, null, `判不出时不许产出任何变体，实际给了 ${h.variant}（证据 ${h.evidence}）`);
  assert.equal(h.state, 'unknown');
  assert.ok(h.hint === null || h.hint === undefined || typeof h.hint === 'string', 'hint 只能是说明，不能是目标');
});
