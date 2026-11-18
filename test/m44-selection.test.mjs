// M44 测试：按会话导（--id）/ 按工作区导（--project）+ 时间参数
//
// 三处口径原来各缺一块：
//   1) --id 指向「被源侧去重折叠掉的副本」时，plan 里一条都找不到（用户以为导了，其实 0 条）；
//   2) --project + --since/--until：updatedAt=0 的会话直接绕过时间过滤（等于时间对它失效）；
//   3) --until 2026-10-01 解析成当天 00:00，把这一天整个排除掉（用户说的是「到这天为止」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { sandboxEnv } from './matrix-home.mjs';
import { planImport } from '../src/import.mjs';
import { parseUntilSpec } from '../src/util.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m44-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
function cli(home, args) {
  const env = sandboxEnv(home, { SESSION_SYNC_LOCK_DIR: path.join(home, 'locks') });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

/** claude 会话：updatedAt 取文件 mtime，用 mtime 精确控制时间口径 */
function mkClaude(root, id, texts, { cwd = 'D:/work/ws-a', mtimeMs = Date.UTC(2026, 9, 1, 12, 0, 0) } = {}) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: `2026-10-01T12:0${i}:00.000Z`, message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: `2026-10-01T12:0${i}:30.000Z`, message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const file = path.join(root, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

/** codex 副本：同一条原始会话（provenance 指向 claude:s-dup）的两份不同长度拷贝 */
function mkCodexCopy(root, id, texts, originId = 's-dup') {
  const rows = [{ type: 'session_meta', id, payload: { id, cwd: 'D:/work/ws-a', timestamp: '2026-10-01T12:00:00.000Z', model: 'gpt-5' } }];
  for (const t of texts) {
    rows.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] }, timestamp: '2026-10-01T12:00:10.000Z' });
    rows.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `答${t}` }] }, timestamp: '2026-10-01T12:00:20.000Z' });
  }
  rows.push({ type: 'session-sync-provenance', timestamp: '2026-10-01T12:00:30.000Z', 'session-sync': { tool: 'session-sync', v: 1, origin: { variant: 'claude', sessionId: originId }, chain: [] } });
  const file = path.join(root, '.codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T12-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

test('--id 指向被源侧去重折叠的副本时，导的是保留的那一份（不能静默 0 条）', () => {
  const root = tmpRoot('id-folded');
  mkCodexCopy(root, 'copy-short', ['第一轮']);
  mkCodexCopy(root, 'copy-long', ['第一轮', '第二轮']);
  const ctx = ctxFor(root);

  const all = planImport(ctx, { from: ['codex'], into: ['claude'] });
  assert.equal(all.sourceDuplicates.length, 1, '短副本应被折叠');
  assert.equal(all.pairs.length, 1, '不指定 id 时只导保留的那份');

  const byShort = planImport(ctx, { from: ['codex'], into: ['claude'], ids: ['copy-short'] });
  assert.equal(byShort.pairs.length, 1, `指定的 id 被折叠后必须映射到保留副本，实际 ${JSON.stringify(byShort.pairs.map((p) => p.sourceId))}`);
  assert.equal(byShort.pairs[0].sourceId, 'copy-long', '导的应是内容更全的那份');
  assert.deepEqual(byShort.missingIds ?? [], [], '映射成功就不算缺失');
});

test('--id 指向不存在的会话：0 条且明确报告缺失，而不是静默跑空', () => {
  const root = tmpRoot('id-missing');
  mkClaude(root, 's-one', ['第一轮']);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['pi'], ids: ['s-one', 's-nope'] });
  assert.equal(plan.pairs.length, 1);
  assert.deepEqual(plan.missingIds, ['s-nope'], `缺失的 id 必须报出来：${JSON.stringify(plan.missingIds)}`);
});

test('--project（工作区）+ 时间：范围外的与「没有时间戳」的都不导，后者单独计数', () => {
  const root = tmpRoot('ws-time');
  mkClaude(root, 'in-range', ['范围内'], { mtimeMs: Date.UTC(2026, 9, 1, 12, 0, 0) });
  mkClaude(root, 'too-old', ['太旧'], { mtimeMs: Date.UTC(2026, 8, 1, 12, 0, 0) });
  mkClaude(root, 'no-ts', ['无时间戳'], { mtimeMs: 0 });
  mkClaude(root, 'other-ws', ['别的工作区'], { cwd: 'D:/work/ws-b', mtimeMs: Date.UTC(2026, 9, 1, 12, 0, 0) });
  const ctx = ctxFor(root);

  const ranged = planImport(ctx, { from: ['claude'], into: ['pi'], project: 'ws-a', since: Date.UTC(2026, 8, 30) });
  assert.deepEqual(ranged.pairs.map((p) => p.sourceId).sort(), ['in-range'], JSON.stringify(ranged.pairs.map((p) => p.sourceId)));
  assert.equal(ranged.timeUnknownSkipped, 1, `无时间戳的一条应被排除并计数，实际 ${ranged.timeUnknownSkipped}`);

  // 不给时间范围时，无时间戳的照常参与（只有时间过滤才谈得上「排不掉」）
  const plain = planImport(ctx, { from: ['claude'], into: ['pi'], project: 'ws-a' });
  assert.deepEqual(plain.pairs.map((p) => p.sourceId).sort(), ['in-range', 'no-ts', 'too-old']);
  assert.equal(plain.timeUnknownSkipped ?? 0, 0);
});

test('--until 纯日期含当天（到这天为止，不是到这天 00:00 为止）', () => {
  assert.equal(parseUntilSpec('2026-10-01'), Date.UTC(2026, 9, 1) + 86400000 - 1, '日期应解析成当天 23:59:59.999');
  const root = tmpRoot('until-day');
  mkClaude(root, 'noon', ['当天中午'], { mtimeMs: Date.UTC(2026, 9, 1, 12, 0, 0) });
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['pi'], until: parseUntilSpec('2026-10-01') });
  assert.deepEqual(plan.pairs.map((p) => p.sourceId), ['noon'], '当天中午的会话必须在范围内');
});

test('list 也认 --id：只列指定的那几条，方便导入前先核对', () => {
  const root = tmpRoot('list-id');
  mkClaude(root, 's-one', ['第一条']);
  mkClaude(root, 's-two', ['第二条']);
  const r = cli(root, ['list', '--from', 'claude', '--id', 's-one,s-two', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.sessions.map((s) => s.id).sort(), ['s-one', 's-two']);

  const only = JSON.parse(cli(root, ['list', '--from', 'claude', '--id', 's-two', '--json']).out);
  assert.deepEqual(only.sessions.map((s) => s.id), ['s-two']);
  assert.deepEqual(only.missingIds ?? [], []);
});
