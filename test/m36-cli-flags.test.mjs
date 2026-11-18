// M36 测试：CLI 参数校验（拼错的开关不能静默生效）+ --id 过滤 + --strict 接线
//
// 起因：真机验证时误用 `--ids`（正确是 `--id`），CLI 不报错、按计划全量跑了 ——
// 在真实宿主上这就是「本想只导一条、结果导了整库」的事故面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './matrix-home.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m36-${name}-`));
}
function cli(home, args) {
  const env = sandboxEnv(home, { SESSION_SYNC_LOCK_DIR: path.join(home, 'locks') });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}
function mkClaude(home, id, text) {
  const rows = [
    { parentUuid: null, type: 'user', sessionId: id, cwd: 'D:/w', uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text }] } },
    { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd: 'D:/w', uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答' }] } },
  ];
  const f = path.join(home, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('拼错的开关必须报错，不能被静默忽略后跑全量', () => {
  const home = tmpRoot('typo');
  mkClaude(home, 's-one', '第一条');
  mkClaude(home, 's-two', '第二条');
  const r = cli(home, ['import', '--from', 'claude', '--into', 'pi', '--ids', 's-one', '--dry-run']);
  assert.equal(r.code, 1, `未知参数应判用法错：${r.out}`);
  assert.match(r.out + r.err, /--ids/);
  assert.match(r.out + r.err, /未知参数/);
});

test('`--id` 是真正的按会话过滤：只导指定的那一条', () => {
  const home = tmpRoot('id-filter');
  mkClaude(home, 's-one', '第一条');
  mkClaude(home, 's-two', '第二条');
  const j = JSON.parse(cli(home, ['import', '--from', 'claude', '--into', 'pi', '--id', 's-one', '--dry-run', '--json']).out);
  assert.equal(j.ok, true);
  assert.deepEqual([...new Set(j.results.map((r) => r.sourceId))], ['s-one'], JSON.stringify(j.results.map((r) => r.sourceId)));
});

test('每个子命令的合法开关都能用（不误伤现有用法）', () => {
  const home = tmpRoot('known-flags');
  mkClaude(home, 's-one', '第一条');
  const cases = [
    ['list', ['--from', 'claude', '--since', '7d', '--until', '2030-01-01', '--project', 'w', '--limit', '5']],
    ['status', ['--from', 'claude', '--into', 'pi', '--id', 's-one', '--include-empty', '--include-subagents', '--include-degraded']],
    ['import', ['--from', 'claude', '--into', 'pi', '--dry-run', '--cwd', 'D:/x', '--placement', 'cwd', '--account', 'u1', '--lock-timeout', '1000', '--no-lock']],
    ['verify', ['--into', 'claude', 's-one', '--expect', 'claude:s-one', '--mode', 'create', '--strict']],
    ['install', ['--dry-run', '--no-bridge']],
    ['uninstall', ['--dry-run', '--purge']],
    ['detect', []],
    ['selftest', []],
  ];
  for (const [cmd, flags] of cases) {
    const r = cli(home, [cmd, ...flags]);
    assert.ok(!(r.out + r.err).includes('未知参数'), `${cmd} ${flags.join(' ')} → ${r.out}${r.err}`);
  }
});

test('--strict 已接线：verify 走全量指纹而不是被忽略', () => {
  const home = tmpRoot('strict-wired');
  mkClaude(home, 's-one', '第一条');
  const plain = JSON.parse(cli(home, ['verify', '--into', 'claude', 's-one', '--json']).out);
  assert.equal(plain.strict, false);
  const strict = JSON.parse(cli(home, ['verify', '--into', 'claude', 's-one', '--strict', '--json']).out);
  assert.equal(strict.strict, true);
});
