// M52 测试：账号模型的覆盖完整性 + 不可切宿主的诚实性 + CLI 口径
//
// 这一份存在的首要理由是一次真实事故式的取证错误：扫描脚本的深度参数写错，
// `~/.minimax/v2/sqlite/…`、`~/.zcode/v2/…` 这类三层深的库整批没被打开过，
// 于是「没扫到」被写成了「没有账号概念」。所以这里第一条断言就是：
// **每个变体都必须有一条带证据路径的账号模型结论，缺项直接失败。**
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_VARIANTS } from '../src/hosts.mjs';
import { makeCtx } from '../src/hosts.mjs';
import { sandboxEnv } from './matrix-home.mjs';
import { ACCOUNT_MODEL, PARTITIONED_VARIANTS, describeAccounts, accountModelOf } from '../src/accounts.mjs';
import { planSwitch, executeSwitch } from '../src/switch.mjs';
import { getWriter } from '../src/writers/index.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');
const KINDS = new Set(['partition', 'single-account', 'none']);
// 证据里必须出现「去哪看的」——路径、库名、键名之一，不能只写一句结论
const EVIDENCE_SHAPE = /(~|%APPDATA%|%LOCALAPPDATA%|\.sqlite|\.db|\.json|\.yaml|sessions\/|leveldb|state_|chat_sessions|workspaces)/i;

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m52-${name}-`));
}
function cli(home, args) {
  const env = sandboxEnv(home, { SESSION_SYNC_LOCK_DIR: path.join(home, 'locks') });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}
function treeHash(root) {
  const parts = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
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
  return parts.join('|');
}

test('每个变体都有账号模型结论，且结论带取证路径（防「没扫到」被写成「没有」）', () => {
  const missing = ALL_VARIANTS.filter((v) => !ACCOUNT_MODEL[v]);
  assert.deepEqual(missing, [], `这些变体没有账号模型条目：${missing.join(',')}`);
  assert.equal(Object.keys(ACCOUNT_MODEL).length, ALL_VARIANTS.length, '登记表里有多余/漏项变体');
  for (const v of ALL_VARIANTS) {
    const m = ACCOUNT_MODEL[v];
    assert.ok(KINDS.has(m.kind), `${v}.kind 非法：${m.kind}`);
    assert.ok(String(m.evidence ?? '').length > 20, `${v} 缺取证依据`);
    assert.ok(EVIDENCE_SHAPE.test(m.evidence), `${v} 的证据里没有可核对的路径/库名/键名：${m.evidence.slice(0, 60)}`);
  }
  for (const v of ALL_VARIANTS) assert.equal(accountModelOf(v).kind, ACCOUNT_MODEL[v].kind, `${v} 模型读不出`);
});

test('可切（partition）的宿主必须有能用的写侧实现', () => {
  assert.deepEqual([...PARTITIONED_VARIANTS].sort(), ['codebuddy-ide', 'codex', 'workbuddy-cn', 'workbuddy-intl'].sort(), '账号分区名单变了要同时改文档与这份断言');
  for (const v of PARTITIONED_VARIANTS) {
    const w = getWriter(v);
    assert.ok(w, `${v} 是 partition 但没有 writer`);
    assert.equal(typeof w.listAccounts, 'function', `${v} 缺 listAccounts`);
    assert.equal(typeof w.switchAccount, 'function', `${v} 缺 switchAccount`);
  }
});

test('不可切的宿主给出 switch-unsupported + 依据，且一个字节都不写', () => {
  const root = tmpHome('unsupported');
  const ctx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
  const before = treeHash(root);
  for (const v of ['qoder-cn', 'minimax', 'mimo', 'zcode', 'dsh', 'freebuff', 'codebuddy', 'opencode']) {
    const plan = planSwitch(ctx, { variant: v, ids: ['x'], account: 'someone' });
    assert.equal(plan.supported, false, `${v} 被当成可切`);
    assert.match(String(plan.fatal), /switch-unsupported/, `${v} 的 fatal：${plan.fatal}`);
    assert.ok(String(plan.fatal).length > 60, `${v} 的原因太短，不可核对`);
    const res = executeSwitch(ctx, plan, { apply: true, lock: false });
    assert.equal(res[0].ok, false, `${v} 不该报告成功`);
    assert.equal(res[0].fatal, true, `${v} 应作为整变体级失败返回`);
  }
  assert.equal(treeHash(root), before, '不可切路径上不允许产生任何文件');
});

test('none 类宿主也走同一条不可切出口（不是 writer 缺失那种含糊报错）', () => {
  const root = tmpHome('none');
  const ctx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
  const plan = planSwitch(ctx, { variant: 'claude', ids: ['x'], account: 'someone' });
  assert.equal(plan.accountModel, 'none');
  assert.match(String(plan.fatal), /switch-unsupported.*kind is none|switch-unsupported/, plan.fatal);
});

test('缺 --id / 缺 --account / 拼错开关都在写之前就被挡住', () => {
  const root = tmpHome('usage');
  const noId = cli(root, ['switch-account', '--into', 'claude', '--account', 'uid']);
  assert.equal(noId.code, 1, noId.out + noId.err);
  assert.match(noId.out + noId.err, /--id/, noId.out);
  const noAcct = cli(root, ['switch-account', '--into', 'claude', '--id', 'x']);
  assert.equal(noAcct.code, 1, noAcct.out);
  assert.match(noAcct.out, /--account/, noAcct.out);
  const typo = cli(root, ['switch-account', '--into', 'claude', '--id', 'x', '--account', 'y', '--keep-src']);
  assert.equal(typo.code, 1, typo.out + typo.err);
  assert.match(typo.out, /未知参数/, typo.out);
  assert.equal(treeHash(root), '', '用法错误不能留下任何痕迹（锁目录除外）');
});

test('accounts 命令：只读，逐变体报账号模型；--into 缺省时按已安装范围', () => {
  const root = tmpHome('accounts-cli');
  const r = cli(root, ['accounts', '--into', 'claude', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.command, 'accounts');
  assert.equal(j.variants.length, 1);
  assert.equal(j.variants[0].variant, 'claude');
  assert.equal(j.variants[0].accountModel, 'none');
  assert.ok(EVIDENCE_SHAPE.test(j.variants[0].evidence), j.variants[0].evidence);
  const text = cli(root, ['accounts', '--into', 'claude']);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /claude\s+\[none\]/, text.out);
});

test('describeAccounts 不猜当前登录账号：CodeBuddy IDE 必须报 current=null 并说明', () => {
  const root = tmpHome('no-guess-current');
  const localAppData = path.join(root, 'AppData', 'Local');
  const uid = 'aaaaaaaa-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(localAppData, 'CodeBuddyExtension', 'Data', uid, 'CodeBuddyIDE', uid, 'history'), { recursive: true });
  const ctx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData, env: {} });
  const d = describeAccounts('codebuddy-ide', ctx, { getWriter });
  assert.equal(d.accountModel, 'partition', JSON.stringify(d));
  assert.equal(d.current, null, '这一家的登录态没有可信落点，猜了就等于把会话钉到错账号');
  assert.ok(d.notes.some((n) => /current-account-unmeasured/.test(n)), JSON.stringify(d.notes));
});

test('detect/list 之外新增的两个命令必须进 HELP 与未知命令提示', () => {
  const root = tmpHome('help');
  const help = cli(root, ['help']);
  assert.match(help.out, /session-sync accounts /, help.out);
  assert.match(help.out, /switch-account/, help.out);
  const bad = cli(root, ['nope']);
  assert.match(bad.out, /accounts.*switch-account|switch-account/, bad.out);
});
