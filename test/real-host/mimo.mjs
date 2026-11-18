// 真机验收（可复跑）：MiMo Code —— 写入必须被宿主自己识别
//
// 不是单元测试（文件名不匹配 test/*.test.mjs，`npm test` 不会跑它）；手动执行：
//   node test/real-host/mimo.mjs            # 镜像验收：真实库只读快照 → 沙箱里跑真 --apply → 宿主 CLI 当 oracle
//   node test/real-host/mimo.mjs --keep     # 保留沙箱目录，便于人工翻库
//
// 验收口径（四项全过才算通过）：
//   1) 宿主自己的 `mimo session list --format json`（在会话目录下跑）能列出新会话
//   2) 宿主自己的 `mimo export <id>` 能读出这条会话
//   3) 本工具读回的轮次核心指纹与源一致（不依赖宿主读口）
//   4) 真实库的 session 行数与快照前一致（测试全程只读真实库）
//
// 依赖：本机装了 MiMo（默认 `~/.mimocode/bin/mimo.exe`，可用 MIMO_CLI 覆盖）。
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
const mimoCli = process.env.MIMO_CLI || path.join(os.homedir(), '.mimocode', 'bin', 'mimo.exe');
const realDb = path.join(os.homedir(), '.local', 'share', 'mimocode', 'mimocode.db');

if (!fs.existsSync(mimoCli) || !fs.existsSync(realDb)) {
  console.log(`跳过：没找到 ${mimoCli} 或 ${realDb}`);
  process.exit(0);
}

// ---- 1) 一致性快照（只读连接 + VACUUM INTO）----
const sbx = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-real-mimo-'));
fs.mkdirSync(path.join(sbx, 'mimocode'), { recursive: true });
const mirror = path.join(sbx, 'mimocode', 'mimocode.db');
const real = new DatabaseSync(realDb, { readOnly: true });
real.exec(`VACUUM INTO '${mirror.replace(/'/g, "''")}'`);
const beforeRows = real.prepare('SELECT COUNT(*) c FROM session').get().c;
real.close();

const ctx = makeCtx({ env: { ...process.env, XDG_DATA_HOME: sbx } });
const cliEnv = { ...process.env, XDG_DATA_HOME: sbx, XDG_CONFIG_HOME: path.join(sbx, 'config') };
const runCli = (args, cwd) => {
  const r = spawnSync(mimoCli, args, { cwd, env: cliEnv, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
};
const isGit = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).status === 0;

console.log(`真实库快照: ${mirror}（session 行 ${beforeRows}）`);

// ---- 2) 两类源各测一条：非 git 目录（→ global）与 git 仓库（→ <gitdir>/mimocode-project-id）----
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

  const plan = planImport(ctx, { from: ['claude'], into: ['mimo'], ids: [src.id] });
  const res = executePlan(ctx, plan, { apply: true, lock: false })[0];
  if (!res?.ok) { fail(`写入失败: ${res?.error}`); continue; }
  console.log(`  写入 ok: target=${res.targetId} warnings=${JSON.stringify(res.warnings ?? [])}`);

  let listed = [];
  const listRun = runCli(['session', 'list', '--format', 'json'], src.cwd);
  try { listed = JSON.parse(listRun.out); } catch { /* 下面按失败处理 */ }
  const hit = listed.find((x) => String(x.id) === String(res.targetId));
  if (hit) console.log(`  宿主列表: ✓ 命中（共 ${listed.length} 条）title=${String(hit.title).slice(0, 30)}`);
  else fail(`宿主列表未命中（共 ${listed.length} 条；stderr: ${listRun.err.slice(0, 160)}）`);

  const exp = runCli(['export', String(res.targetId)], src.cwd);
  if (exp.code === 0 && exp.out.length > 0) console.log(`  宿主 export: ✓ ${exp.out.length} 字节`);
  else fail(`宿主 export 失败（exit=${exp.code}）`);

  const back = readSession('mimo', ctx, res.targetId).session;
  const same = back && JSON.stringify(sessionCoreFingerprints(back)) === JSON.stringify(sessionCoreFingerprints(src));
  if (same) console.log(`  本工具读回: ✓ ${back.turns.length} 轮，核心指纹一致`);
  else fail(`本工具读回指纹不一致（${back?.turns.length ?? 0} 轮）`);
}

// ---- 3) 真实库必须没被写过 ----
const after = new DatabaseSync(realDb, { readOnly: true });
const afterRows = after.prepare('SELECT COUNT(*) c FROM session').get().c;
after.close();
if (afterRows === beforeRows) console.log(`\n真实库: ✓ 未改动（session 行仍为 ${afterRows}）`);
else fail(`真实库 session 行变了：${beforeRows} → ${afterRows}`);

if (keep) console.log(`\n沙箱保留: ${sbx}`);
else fs.rmSync(sbx, { recursive: true, force: true });

console.log(failures === 0 ? '\n结果: 通过' : `\n结果: ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
