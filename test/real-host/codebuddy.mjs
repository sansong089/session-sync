// 真机验收（可复跑）：CodeBuddy Code CLI —— 写入的会话必须被宿主自己加载
//
//   CODEBUDDY_CLI=/path/to/codebuddy node test/real-host/codebuddy.mjs
//   CODEBUDDY_CLI=/path/to/bin/codebuddy node test/real-host/codebuddy.mjs --keep
//
// CODEBUDDY_CLI 可以是可执行文件，也可以是 CLI 的 .js 入口（自动用 node 启动）。
// 未安装/未设置时跳过。
//
// 验收口径：在沙箱 HOME 里用本工具写一条会话 → 在对应 cwd 下执行 `codebuddy -r <id> -p probe`：
//   - 输出 "No conversation found" = 宿主没认出会话（失败）
//   - 输出 "Authentication required" = 会话已加载，停在登录（通过；本脚本不保存任何登录态）
// 另外用本工具读回，核心指纹必须一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeCtx } from '../../src/hosts.mjs';
import { codebuddyReader } from '../../src/readers/codebuddy.mjs';
import { codebuddyWriter } from '../../src/writers/codebuddy.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, sessionCoreFingerprints } from '../../src/ir.mjs';
import { mintTargetId } from '../../src/identity.mjs';

const keep = process.argv.includes('--keep');
const cli = process.env.CODEBUDDY_CLI || 'codebuddy';

function cliArgs(args) {
  return cli.endsWith('.js') || cli.endsWith('.mjs') ? [process.execPath, cli, ...args] : [cli, ...args];
}
function runCli(args, cwd, env) {
  return spawnSync(cliArgs(args)[0], cliArgs(args).slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
    shell: process.platform === 'win32' && !cli.endsWith('.js') && !cli.endsWith('.mjs'),
  });
}

const probe = runCli(['--version'], process.cwd(), process.env);
if (probe.error || probe.status !== 0) {
  console.log(`跳过：没找到可用的 CodeBuddy CLI（${cli}）。设置 CODEBUDDY_CLI 后重跑。`);
  process.exit(0);
}
console.log(`CLI: ${String(probe.stdout ?? '').trim() || 'unknown'}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-real-codebuddy-'));
const work = path.join(root, 'work');
const cfg = path.join(root, 'home', '.codebuddy');
fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
fs.mkdirSync(work, { recursive: true });

const T0 = Date.now();
const turns = [
  { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '真机验收：第一轮', T0), reasoningItem('想一想', T0 + 100), messageItem('assistant', '第一轮回答', T0 + 200), toolCallItem('call_a', 'Read', { file_path: 'a.txt' }, T0 + 300), toolResultItem('call_a', 'Read', 'ok', 'file body', T0 + 400)] },
  { index: 1, role: 'user', startedAt: T0 + 1000, items: [messageItem('user', '第二轮', T0 + 1000), messageItem('assistant', '第二轮回答', T0 + 1100)] },
];
const targetId = mintTargetId('codebuddy', 'codebuddy:probe-src');
const session = makeSession({ id: 'probe-src', variant: 'claude', title: 'CodeBuddy 真机验收', cwd: work, createdAt: T0, updatedAt: T0 + 1100, turns });

const ctx = makeCtx({ home: root, platform: process.platform, appData: path.join(root, 'AppData'), env: { CODEBUDDY_CONFIG_DIR: cfg } });
const written = codebuddyWriter.write(ctx, { session, targetId, mode: 'create', provenance: null });
if (!written.ok) {
  console.log(`失败：写入失败 ${written.error}`);
  process.exit(1);
}
console.log(`写入: ${written.path}`);

const back = codebuddyReader.read(ctx, targetId);
const same = back && JSON.stringify(sessionCoreFingerprints(back)) === JSON.stringify(sessionCoreFingerprints(session));
console.log(`${same ? '✓' : '✗'} 读回核心指纹一致`);

// append：宿主侧同一会话续写，读回仍应一致
const appendedTurns = [
  ...turns,
  { index: 2, role: 'user', startedAt: T0 + 2000, items: [messageItem('user', '第三轮（append）', T0 + 2000), messageItem('assistant', '第三轮回答', T0 + 2100)] },
];
const extended = { ...session, turns: appendedTurns, updatedAt: T0 + 2100 };
const ap = codebuddyWriter.write(ctx, { session: extended, targetId, mode: 'append', fromTurnIndex: 2, provenance: null });
const backAppend = ap.ok ? codebuddyReader.read(ctx, targetId) : null;
const appendSame = !!backAppend && JSON.stringify(sessionCoreFingerprints(backAppend)) === JSON.stringify(sessionCoreFingerprints(extended));
console.log(`${appendSame ? '✓' : '✗'} append 后读回核心指纹一致${ap.ok ? '' : `（写入失败：${ap.error}）`}`);

// relocate：换 cwd 后会话应整份搬到新 slug 目录，且宿主仍能按 id 加载
const work2 = path.join(root, 'work2');
fs.mkdirSync(work2, { recursive: true });
const rl = codebuddyWriter.relocate(ctx, { targetId, directory: work2 });
const backMoved = rl.ok ? codebuddyReader.read(ctx, targetId) : null;
const movedSame = !!backMoved && String(backMoved.cwd) === work2 && JSON.stringify(sessionCoreFingerprints(backMoved)) === JSON.stringify(sessionCoreFingerprints(extended));
console.log(`${movedSame ? '✓' : '✗'} relocate 后正文搬到新目录且指纹不变${rl.ok ? '' : `（搬迁失败：${rl.error}）`}`);

const r = runCli(['-r', targetId, '-p', 'probe'], work2, { ...process.env, CODEBUDDY_CONFIG_DIR: cfg });
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const missing = /No conversation found with session ID/i.test(out);
const loaded = !missing && (r.status === 0 || /Authentication required|Please use \/login/i.test(out));

// 负对照：一个不存在的 id 必须报 missing，否则「没报 missing」不能证明会话被加载
const bogusId = mintTargetId('codebuddy', 'codebuddy:definitely-missing');
const neg = runCli(['-r', bogusId, '-p', 'probe'], work, { ...process.env, CODEBUDDY_CONFIG_DIR: cfg });
const negMissing = /No conversation found with session ID/i.test(`${neg.stdout ?? ''}\n${neg.stderr ?? ''}`);
console.log(`${negMissing ? '✓' : '✗'} 负对照：不存在的会话报 missing`);
console.log(`${loaded ? '✓' : '✗'} 宿主 CLI 识别到会话${loaded ? '（停在登录提示 = 已加载）' : `（退出码 ${r.status}）`}`);

if (!keep) fs.rmSync(root, { recursive: true, force: true });
process.exit(same && appendSame && movedSame && loaded && negMissing ? 0 : 1);
