// M25 测试：CLI 的 placement 开关与 dry-run 落点打印（计划改动清单 11）
//
// 三条硬要求：
//   1. dry-run（含 --json）逐 pair 打印 `scope → directory [source]`，且**无副作用**；
//   2. D4：requires-cwd 单列一节「待用户指定目录」，不失败整批、不做交互式追问（管道场景必须安静）；
//   3. 末尾给可见性条件提示（项目会话要在该项目目录跑宿主；OpenCode 可切「全部项目」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './matrix-home.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');
const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m25-${name}-`));
}
function cli(home, args) {
  const env = sandboxEnv(home);
  return execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
}

function fixtures(root) {
  const mk = (id, cwd, text) => {
    const rows = [
      { parentUuid: null, type: 'user', sessionId: id, cwd, uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text }] } },
      { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '乙' }] } },
    ];
    const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  };
  mk('s-none', J(path.join(root, 'WorkBuddy', '2026-10-08-18-38-21')), '桶里的会话');
  mk('s-proj', 'D:/00-work/code/demo-app', 'demo-app 项目会话');
}

test('dry-run --json：每个 pair 带 placement，requires-cwd 单列 pendingCwd 且不写任何文件', () => {
  const root = tmpRoot('dry-json');
  fixtures(root);
  const projDir = path.join(root, '.freebuff', 'projects');
  const before = fs.existsSync(projDir) ? fs.readdirSync(projDir).length : 0;
  const j = JSON.parse(cli(root, ['import', '--from', 'claude', '--into', 'freebuff', '--dry-run', '--json']));
  assert.equal(j.ok, true, JSON.stringify(j).slice(0, 400));
  assert.equal(j.apply, false);
  for (const r of j.results) assert.ok(r.placement, `每条都要有 placement：${JSON.stringify(r).slice(0, 200)}`);
  const pending = j.results.filter((r) => r.placement.source === 'requires-cwd');
  assert.equal(pending.length, 1, JSON.stringify(j.results.map((r) => [r.sourceId, r.placement.source])));
  assert.match(pending[0].hint, /--cwd/);
  assert.equal(j.summary['skipped:requires-cwd'], 1, JSON.stringify(j.summary));
  const after = fs.existsSync(path.join(root, '.freebuff', 'projects')) ? fs.readdirSync(path.join(root, '.freebuff', 'projects')).length : 0;
  assert.equal(after, before, 'dry-run 必须无副作用');
});

test('dry-run 文本视图：逐 pair 打印 scope → directory [source]，末尾有可见性提示', () => {
  const root = tmpRoot('dry-text');
  fixtures(root);
  const text = cli(root, ['import', '--from', 'claude', '--into', 'codex', '--dry-run']);
  assert.match(text, /none → .*Documents[\\/]Codex[\\/]2026-10-08[\\/][^ ]+ \[bucket:generated\]/);
  assert.match(text, /project → D:\/00-work\/code\/demo-app \[project-dir\]/);
  assert.match(text, /可见性条件/, text.slice(-700));
});

test('--cwd 只兜底「宿主没有非项目落点」的那批；--account 对全部生效；非法 --placement 报用法错', () => {
  const root = tmpRoot('flags');
  fixtures(root);
  const chosen = J(path.join(root, 'chosen'));
  const j = JSON.parse(cli(root, ['import', '--from', 'claude', '--into', 'freebuff', '--dry-run', '--json', '--cwd', chosen, '--account', 'uid-xyz']));
  const none = j.results.find((r) => r.sourceId === 's-none');
  assert.equal(J(none.placement.directory), chosen, `没桶的变体要吃 --cwd：${JSON.stringify(none.placement)}`);
  assert.equal(none.placement.source, 'flag:cwd');
  assert.equal(j.results.find((r) => r.sourceId === 's-proj').placement.source, 'project-dir', '项目会话不该被 --cwd 抢走');
  assert.ok(j.results.every((r) => r.placement.account === 'uid-xyz'), JSON.stringify(j.results.map((r) => r.placement.account)));

  const bucket = JSON.parse(cli(root, ['import', '--from', 'claude', '--into', 'codex', '--dry-run', '--json', '--placement', 'bucket']));
  assert.ok(bucket.results.every((r) => r.placement.scope === 'none'), JSON.stringify(bucket.results.map((r) => r.placement.scope)));

  let failed = false;
  try {
    cli(root, ['import', '--from', 'claude', '--into', 'codex', '--placement', 'nonsense']);
  } catch (err) {
    failed = true;
    assert.match(String(err.stdout ?? '') + String(err.stderr ?? ''), /placement/);
  }
  assert.ok(failed, '非法 --placement 必须非零退出');
});

test('--project 同时匹配当前目录与落点记录的源目录，并在输出里标明命中哪个（规则 4）', () => {
  const root = tmpRoot('project-flag');
  // 一条已被搬进桶的导入会话：现在的 cwd 是桶目录，provenance.placed 记着它自己的落点
  const bucket = J(path.join(root, 'Documents', 'Codex', '2026-10-08', 'moved-1'));
  const rows = [
    { parentUuid: null, type: 'user', sessionId: 'moved-1', cwd: bucket, uuid: 'u1', timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: '搬走过' }] } },
    { parentUuid: 'u1', type: 'assistant', sessionId: 'moved-1', cwd: bucket, uuid: 'a1', timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '乙' }] } },
    { timestamp: '2026-10-08T18:38:31.000Z', ordinal: 99, type: 'session-sync-provenance', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: 'moved-1' }, placed: { directory: bucket, scope: 'none' } } },
  ];
  const f = path.join(root, '.claude', 'projects', 'moved', 'moved-1.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  // 按「当前 cwd」命中
  const byCwd = JSON.parse(cli(root, ['list', '--from', 'claude', '--project', 'Documents/Codex', '--json']));
  assert.deepEqual(byCwd.sessions.map((s) => s.id), ['moved-1'], JSON.stringify(byCwd));
  assert.equal(byCwd.sessions[0].matchedBy, 'cwd');

  // 按「落点记录」命中 —— 迁移过的会话仍要按那个名字搜得到
  const byPlaced = JSON.parse(cli(root, ['list', '--from', 'claude', '--project', 'moved-1', '--json']));
  assert.deepEqual(byPlaced.sessions.map((s) => s.id), ['moved-1']);
  assert.ok(['cwd', 'placed', 'origin-dir'].includes(byPlaced.sessions[0].matchedBy), JSON.stringify(byPlaced.sessions[0]));
});
