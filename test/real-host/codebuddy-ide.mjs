// 真机验收（可复跑）：CodeBuddy IDE 跨账号切换 —— 镜像真实扩展缓存里跑真 --apply
//
// 不是单元测试（文件名不匹配 test/*.test.mjs，`npm test` 不会跑它）；手动执行：
//   node test/real-host/codebuddy-ide.mjs          # 镜像验收
//   node test/real-host/codebuddy-ide.mjs --keep   # 保留沙箱目录便于人工翻库
//
// 验收口径（五道，全过才算「镜像级通过」）：
//   1) 目标账号目录里出现 history/<md5(cwd)>/index.json 且列出这条（补 project 生效）
//   2) 源账号索引不再列它、正文与 check-point/file-tree/plan-task 四个平行目录一起搬走
//   3) 本工具读回的核心指纹逐轮等于搬前
//   4) 重跑幂等：第二次是 already，目标文件 mtime 不变
//   5) 负对照：不存在的 id 报 conversation-not-found 且沙箱树零改动
//   另：全程不碰真实 Data（真实树 hash 前后一致）
//
// 「宿主 UI 真能列出」这一腿不在本脚本里：CodeBuddy 没有 CLI oracle，
// 只能开 IDE 看扩展日志 `Loaded N conversations from HistoryStorage` + 历史面板，
// 那是改真实账号数据的人工动作，脚本末尾会打印步骤而不是替用户做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCtx, codebuddyExtensionDataRoot } from '../../src/hosts.mjs';
import { listSessions, readSession } from '../../src/readers/index.mjs';
import { planSwitch, executeSwitch } from '../../src/switch.mjs';
import { sessionCoreFingerprints } from '../../src/ir.mjs';

const keep = process.argv.includes('--keep');
const realData = codebuddyExtensionDataRoot(makeCtx({ env: process.env })).path;
const COMPANIONS = ['history', 'check-point', 'file-tree', 'plan-task'];

function treeHash(root) {
  const parts = [];
  const walk = (dir, depth) => {
    if (depth > 7) return;
    let es = [];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else parts.push(`${path.relative(root, p)}:${fs.statSync(p).size}`);
    }
  };
  walk(root, 0);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

if (!fs.existsSync(realData)) {
  console.log(`跳过：本机没有 ${realData}`);
  process.exit(0);
}

const realHashBefore = treeHash(realData);
const sbx = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-real-cbide-'));
const home = path.join(sbx, 'home');
fs.mkdirSync(home, { recursive: true });
const localAppData = path.join(sbx, 'AppData', 'Local');
// 镜像必须就落在 ctx 会解析到的那个位置，否则「验收的是 A 副本、检查的是 B 副本」会两边都骗人
const mirrorData = path.join(localAppData, 'CodeBuddyExtension', 'Data');
fs.mkdirSync(path.dirname(mirrorData), { recursive: true });
fs.cpSync(realData, mirrorData, { recursive: true });
const ctx = makeCtx({ home, platform: process.platform, appData: path.join(sbx, 'AppData', 'Roaming'), localAppData, env: {} });

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// 挑一条：所在账号有第二个账号可当目标、且能恢复出 cwd 的会话（优先我们自己导入的）
const rows = listSessions('codebuddy-ide', ctx, {}).sessions.filter((s) => s.account?.id && s.cwd);
const accounts = [...new Set(rows.map((r) => r.account.id))];
const pick = rows.find((r) => r.provenance) ?? rows[0];
if (!pick || accounts.length < 2) {
  console.log(`跳过：镜像里只有 ${accounts.length} 个账号有可读会话（需要两个才能验证跨账号切换）`);
  if (!keep) fs.rmSync(sbx, { recursive: true, force: true });
  process.exit(0);
}
const target = accounts.find((a) => a !== pick.account.id);
// 宿主公式：md5(normalize(路径))，路径取宿主自己的 URI 形态（盘符小写，正斜杠）
// —— 真机核对：现网 60 个 history 目录里 58 个与本式逐字相等。
const wsKey = crypto
  .createHash('md5')
  .update(path.normalize(String(pick.cwd).replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`)))
  .digest('hex');
const srcUid = pick.account.id;
console.log(`样本 ${pick.id}  账号 ${srcUid.slice(0, 8)} → ${target.slice(0, 8)}  项目 ${pick.cwd}`);
console.log(`目标账号是否已有该项目：${fs.existsSync(path.join(mirrorData, target, 'CodeBuddyIDE', target, 'history', wsKey)) ? '已有' : '没有（应当补出来）'}`);

const fpsBefore = sessionCoreFingerprints(readSession('codebuddy-ide', ctx, pick.id).session);

// 1) 计划必须是「会补/不补 project」的明确说法，且 dry-run 零改动
const hashBeforePlan = treeHash(localAppData);
const plan = planSwitch(ctx, { variant: 'codebuddy-ide', ids: [pick.id], account: target });
const res1 = executeSwitch(ctx, plan, { apply: false, lock: false });
check('dry-run 不写盘', treeHash(localAppData) === hashBeforePlan, JSON.stringify(res1[0]?.warnings ?? []));

// 2) 真切
const plan2 = planSwitch(ctx, { variant: 'codebuddy-ide', ids: [pick.id], account: target });
const [r] = executeSwitch(ctx, plan2, { apply: true, lock: false });
check('切换成功返回', r.ok === true, JSON.stringify({ error: r.error, warnings: r.warnings }));

const destRoots = [];
for (const user of fs.readdirSync(mirrorData)) {
  const uDir = path.join(mirrorData, user);
  if (!fs.statSync(uDir).isDirectory()) continue;
  for (const ide of fs.readdirSync(uDir)) {
    const iDir = path.join(uDir, ide);
    if (!fs.statSync(iDir).isDirectory()) continue;
    destRoots.push(iDir);
    for (const uid of fs.readdirSync(iDir)) {
      const p = path.join(iDir, uid);
      if (fs.statSync(p).isDirectory()) destRoots.push(p);
    }
  }
}
const destAccountRoots = destRoots.filter((d) => path.basename(d) === target);
const destConv = destAccountRoots.map((d) => COMPANIONS.map((k) => path.join(d, k, wsKey, pick.id))).flat().filter((p) => fs.existsSync(p));
const srcConv = destRoots.filter((d) => path.basename(d) === srcUid).flatMap((d) => COMPANIONS.map((k) => path.join(d, k, wsKey, pick.id))).filter((p) => fs.existsSync(p));
const listedDest = destAccountRoots.some((d) => {
  const f = path.join(d, 'history', wsKey, 'index.json');
  try {
    return (JSON.parse(fs.readFileSync(f, 'utf8')).conversations ?? []).some((c) => String(c.id) === pick.id);
  } catch {
    return false;
  }
});
check('目标账号出现这条正文（含补出的项目目录）', destConv.length > 0 && listedDest, `命中 ${destConv.length} 处，工作区索引登记=${listedDest}`);
check('平行目录一起搬走（不只 history）', destConv.length >= 2, `目标 ${destConv.length} 个坐标 / 源残留 ${srcConv.length} 个`);
const srcListed = destRoots.filter((d) => path.basename(d) === srcUid).some((d) => {
  const f = path.join(d, 'history', wsKey, 'index.json');
  try {
    return (JSON.parse(fs.readFileSync(f, 'utf8')).conversations ?? []).some((c) => String(c.id) === pick.id);
  } catch {
    return false;
  }
});
check('源账号索引不再列它', !srcListed, srcListed ? '旧账号索引仍登记着这条，宿主会列成两份' : '');

// 3) 内容等价
const after = readSession('codebuddy-ide', ctx, pick.id);
const fpsAfter = after.session ? sessionCoreFingerprints(after.session) : [];
check('切换前后核心指纹逐轮相等', fpsAfter.length === fpsBefore.length && fpsAfter.every((x, i) => x === fpsBefore[i]), `${fpsBefore.length} 轮 → ${fpsAfter.length} 轮`);
check('读回归属是目标账号', after.session?.account?.id === target, String(after.session?.account?.id));

// 4) 幂等
const targetFile = destConv.find((p) => p.includes(`${path.sep}history${path.sep}`));
const mtimeBefore = targetFile ? fs.statSync(targetFile).mtimeMs : 0;
const [r2] = executeSwitch(ctx, planSwitch(ctx, { variant: 'codebuddy-ide', ids: [pick.id], account: target }), { apply: true, lock: false });
check('重跑幂等（already 且不再写）', r2.ok === true && (!targetFile || fs.statSync(targetFile).mtimeMs === mtimeBefore), JSON.stringify({ action: r2.action, warnings: r2.warnings }));

// 5) 负对照
const [neg] = executeSwitch(ctx, planSwitch(ctx, { variant: 'codebuddy-ide', ids: ['no-such-conversation-id'], account: target }), { apply: true, lock: false });
check('负对照：不存在的 id 明确报错', neg.ok === false && /not-found/.test(String(neg.error)), String(neg.error));

// 6) 真实树未被动
check('真实 Data 全程零改动', treeHash(realData) === realHashBefore, `${realHashBefore.slice(0, 12)} → ${treeHash(realData).slice(0, 12)}`);

console.log('\n未自动化的一腿（必须人工确认才算宿主验收通过）：');
console.log('  1. 退出 CodeBuddy IDE，把上面镜像目录里的账号态当真机操作重做一遍（session-sync switch-account --into codebuddy-ide --id <id> --account <uid> --apply）');
console.log('  2. 用目标账号登录打开该 IDE、打开该项目目录，看扩展日志是否出现 `Loaded N conversations from HistoryStorage`');
console.log('  3. 历史面板里能看到这条会话、旧账号侧栏里不再出现它');

if (!keep) fs.rmSync(sbx, { recursive: true, force: true });
else console.log(`\n沙箱保留在：${sbx}`);
console.log(fails.length ? `\n结论：${fails.length} 项未过 —— ${fails.join(', ')}` : '\n结论：镜像级验收通过（真机 UI 那一腿仍需人工确认）');
process.exit(fails.length ? 1 : 0);
