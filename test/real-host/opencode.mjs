// 真机验收（可复跑）：OpenCode v2 —— 写入必须被宿主自己的会话列表识别
//
//   node test/real-host/opencode.mjs          # 镜像验收：真实库只读快照 → 沙箱里真 --apply → 宿主 CLI 当 oracle
//   node test/real-host/opencode.mjs --keep   # 保留沙箱目录
//
// 验收口径：宿主 `opencode session list --format json`（在会话目录下跑）能列出新会话、
// 本工具读回轮次核心指纹一致、真实库行数不变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../../src/hosts.mjs';
import { listSessions, readSession } from '../../src/readers/index.mjs';
import { planImport, executePlan } from '../../src/import.mjs';
import { sessionCoreFingerprints } from '../../src/ir.mjs';

const N = (s) => String(s ?? '').replace(/\\/g, '/');
const keep = process.argv.includes('--keep');
const realDb = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
// Windows 上 PATH 里只有 .cmd/.ps1 壳（Node 18+ 不允许直接 spawn .cmd），直接找 npm 全局安装的 .exe
const npmExe = path.join(path.dirname(process.execPath), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
const opencodeCli = process.env.OPENCODE_CLI || (process.platform === 'win32' && fs.existsSync(npmExe) ? npmExe : 'opencode');

const probe = spawnSync(opencodeCli, ['--version'], { encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32' && opencodeCli === 'opencode' });
if (!fs.existsSync(realDb) || probe.status !== 0) {
  console.log(`跳过：没找到 ${realDb} 或 opencode CLI（${opencodeCli}）`);
  process.exit(0);
}

// ---- 1) 一致性快照（只读连接 + VACUUM INTO）----
const sbx = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-real-opencode-'));
fs.mkdirSync(path.join(sbx, 'opencode'), { recursive: true });
const mirror = path.join(sbx, 'opencode', 'opencode.db');
const real = new DatabaseSync(realDb, { readOnly: true });
real.exec(`VACUUM INTO '${mirror.replace(/'/g, "''")}'`);
const beforeRows = real.prepare('SELECT COUNT(*) c FROM session_v2').get().c;
real.close();

const ctx = makeCtx({ env: { ...process.env, XDG_DATA_HOME: sbx } });
const cliEnv = { ...process.env, XDG_DATA_HOME: sbx, XDG_CONFIG_HOME: path.join(sbx, 'config') };
const runCli = (args, cwd) => {
  const r = spawnSync(opencodeCli, args, { cwd, env: cliEnv, encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32' && opencodeCli === 'opencode' });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
};
const isGit = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).status === 0;

console.log(`真实库快照: ${mirror}（session_v2 行 ${beforeRows}）`);

// ---- 2) 两类源各测一条：非 git 目录与 git 仓库（project 解析规则不同）----
const candidates = (listSessions('claude', ctx, {}).sessions ?? [])
  .filter((x) => (x.turns ?? 0) >= 2 && (x.turns ?? 0) <= 12 && x.cwd && fs.existsSync(x.cwd))
  .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const pick = (wantGit) => candidates.find((x) => isGit(x.cwd) === wantGit);

let failures = 0;
const fail = (msg) => { failures += 1; console.log('  ✗ ' + msg); };

for (const [label, wantGit] of [['非 git 目录', false], ['git 仓库', true]]) {
  const cand = pick(wantGit);
  if (!cand) { console.log(`\n== ${label}：没有可用源会话，跳过`); continue; }
  const src = readSession('claude', ctx, cand.id).session;
  console.log(`\n== ${label}：claude:${src.id}  ${src.turns.length} 轮  cwd=${N(src.cwd)}`);

  const plan = planImport(ctx, { from: ['claude'], into: ['opencode'], ids: [src.id] });
  const res = executePlan(ctx, plan, { apply: true, lock: false })[0];
  if (!res?.ok) { fail(`写入失败: ${res?.error}`); continue; }
  console.log(`  写入 ok: target=${res.targetId} warnings=${JSON.stringify(res.warnings ?? [])}`);

  let listed = [];
  // 默认模式会连后台常驻服务（它绑定的是真实数据目录，不认 XDG 覆盖）；验收必须用 --standalone 的私有服务
  const listRun = runCli(['session', 'list', '--format', 'json', '--standalone'], src.cwd);
  try { listed = JSON.parse(listRun.out); } catch { /* 下面按失败处理 */ }
  const hit = listed.find((x) => String(x.id) === String(res.targetId));
  if (hit) console.log(`  宿主列表: ✓ 命中（共 ${listed.length} 条）title=${String(hit.title).slice(0, 30)}`);
  else fail(`宿主列表未命中（共 ${listed.length} 条；stderr: ${listRun.err.slice(0, 160)}）`);

  const back = readSession('opencode', ctx, res.targetId).session;
  const same = back && JSON.stringify(sessionCoreFingerprints(back)) === JSON.stringify(sessionCoreFingerprints(src));
  if (same) console.log(`  本工具读回: ✓ ${back.turns.length} 轮，核心指纹一致`);
  else fail(`本工具读回指纹不一致（${back?.turns.length ?? 0} 轮）`);
}

// ---- 3) 真实库必须没被写过 ----
const after = new DatabaseSync(realDb, { readOnly: true });
const afterRows = after.prepare('SELECT COUNT(*) c FROM session_v2').get().c;
after.close();
if (afterRows === beforeRows) console.log(`\n真实库: ✓ 未改动（session_v2 行仍为 ${afterRows}）`);
else fail(`真实库 session_v2 行变了：${beforeRows} → ${afterRows}`);

if (keep) console.log(`\n沙箱保留: ${sbx}`);
else fs.rmSync(sbx, { recursive: true, force: true });

console.log(failures === 0 ? '\n结果: 通过' : `\n结果: ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
