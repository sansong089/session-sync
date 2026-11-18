// M16 测试：list / show 输出带出 scope 与 account 两列（改动清单 §14 尾句）
//
// 为什么必须显式打印：这两个信号只有 reader 知道，用户在终端看不到就等于没有 ——
// 导入前无法判断「这条会不会被当成项目会话挂到别的项目下」。
// 口径：JSON 里 scope 是 'project'|'none'|null，account 是 {variant,id,...}|null（D3：绝不按目录猜账号）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './matrix-home.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m16-${name}-`));
}

function cli(home, args) {
  const env = sandboxEnv(home);
  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function claudeFixture(home) {
  const bucket = path.join(home, 'Documents', 'Codex', '2026-10-15', 'chat-1');
  writeJsonl(path.join(home, '.claude', 'projects', 'A', 's-bucket.jsonl'), [
    { type: 'user', cwd: bucket, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: '桶里的会话' }, sessionId: 's-bucket', uuid: 'u1', parentUuid: null },
  ]);
  writeJsonl(path.join(home, '.claude', 'projects', 'B', 's-proj.jsonl'), [
    { type: 'user', cwd: 'D:/00-work/code/demo-app', timestamp: '2026-10-08T18:38:22.000Z', message: { role: 'user', content: '项目里的会话' }, sessionId: 's-proj', uuid: 'u1', parentUuid: null },
  ]);
}

function codexFixture(home) {
  const id = '01a13f28-22a1-7f20-9adc-062faf6271c9';
  writeJsonl(path.join(home, '.codex', 'sessions', '2026', '10', '15', `rollout-2026-10-15T00-03-14-${id}.jsonl`), [
    {
      timestamp: '2026-10-14T00:03:14.017Z',
      type: 'session_meta',
      payload: {
        creator_user_id: 'user-FAKEFAKEFAKEFAKEFAKEFAKES',
        creator_account_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        id,
        session_id: id,
        timestamp: '2026-10-14T00:03:14.017Z',
        cwd: 'D:/00-demo-app',
        model: 'gpt-5',
      },
    },
    { timestamp: '2026-10-14T00:03:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '了解助手身份' }] } },
    { timestamp: '2026-10-14T00:03:40.159Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我是…' }] } },
  ]);
  return id;
}

test('list --json：每条会话都带 scope，无账户信号的变体 account 为 null', () => {
  const home = tmpRoot('list-json');
  claudeFixture(home);
  const j = JSON.parse(cli(home, ['list', '--from', 'claude', '--json']));
  assert.equal(j.ok, true, JSON.stringify(j.errors));
  const byId = Object.fromEntries(j.sessions.map((s) => [s.id, s]));
  assert.equal(byId['s-bucket'].scope, 'none', JSON.stringify(byId['s-bucket']));
  assert.equal(byId['s-proj'].scope, 'project');
  assert.equal(byId['s-proj'].account, null);
});

test('list --json：account 透出源登录账号（codex creator_*），且不影响条数（D3 全量）', () => {
  const home = tmpRoot('list-account');
  codexFixture(home);
  const j = JSON.parse(cli(home, ['list', '--from', 'codex', '--json']));
  assert.equal(j.sessions.length, 1);
  assert.deepEqual(j.sessions[0].account, {
    variant: 'codex',
    id: 'user-FAKEFAKEFAKEFAKEFAKEFAKES',
    accountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.equal(j.sessions[0].scope, 'project');
});

test('list 文本视图：scope 与 account 直接可读', () => {
  const home = tmpRoot('list-text');
  claudeFixture(home);
  codexFixture(home);
  const text = cli(home, ['list', '--from', 'claude,codex']);
  const lines = text.split(/\r?\n/);
  const bucket = lines.find((l) => l.includes('s-bucket'));
  const proj = lines.find((l) => l.includes('s-proj'));
  const acct = lines.find((l) => l.includes('01a13f28'));
  assert.ok(bucket && proj && acct, text);
  assert.match(bucket, /\[none\]/);
  assert.match(proj, /\[project\]/);
  assert.match(acct, /\[acct user-FAKEFAK/);
});

test('show --json：单条会话同样带 scope/account', () => {
  const home = tmpRoot('show-json');
  const id = codexFixture(home);
  const j = JSON.parse(cli(home, ['show', '--from', 'codex', '--json', id]));
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.scope, 'project');
  assert.equal(j.account.id, 'user-FAKEFAKEFAKEFAKEFAKEFAKES');
});

test('show 文本视图：scope/account 两行可见', () => {
  const home = tmpRoot('show-text');
  const id = codexFixture(home);
  const text = cli(home, ['show', '--from', 'codex', id]);
  assert.match(text, /^scope: project \(project-dir\)$/m);
  assert.match(text, /^account: user-FAKEFAKEFAKEFAKEFAKEFAKES \/ dddddddd-dddd-4ddd-8ddd-dddddddddddd$/m);
});

test('list 带出所属项目：文本有 [proj …]，JSON 有 projectName（cwd 末两段）', () => {
  const home = tmpRoot('proj-col');
  claudeFixture(home);
  const txt = cli(home, ['list', '--from', 'claude']);
  assert.match(txt, /demo-app/, `文本应显示项目名（不含路径）：${txt}`);
  const j = JSON.parse(cli(home, ['list', '--from', 'claude', '--json']));
  const row = j.sessions.find((s) => s.id === 's-proj');
  assert.equal(row.projectName, 'demo-app', '项目名只给名字，不给路径');
  assert.equal(row.cwd, 'D:/00-work/code/demo-app', '完整 cwd 仍保留在 JSON');
  const bucket = j.sessions.find((s) => s.id === 's-bucket');
  assert.equal(bucket.projectName, '非项目会话', '非项目会话固定文案');
});

test('list 默认不列 0 轮会话；--include-empty 才显示（与 import 口径一致）', () => {
  const home = tmpRoot('empty-filter');
  writeJsonl(path.join(home, '.claude', 'projects', 'C', 's-empty.jsonl'), [
    { type: 'assistant', cwd: 'D:/w', timestamp: '2026-10-08T18:38:23.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '只有回答' }] }, sessionId: 's-empty', uuid: 'a1', parentUuid: null },
  ]);
  const def = cli(home, ['list', '--from', 'claude']);
  assert.ok(!def.includes('s-empty'), `0 轮会话默认不该出现：${def}`);
  const withEmpty = cli(home, ['list', '--from', 'claude', '--include-empty']);
  assert.ok(withEmpty.includes('s-empty'), `--include-empty 时必须出现：${withEmpty}`);
});
