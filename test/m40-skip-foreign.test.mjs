// M40 测试：skip 分支不能动「别人家的」会话
//
// 场景（本机真实形态）：宿主自己写的非项目会话，桶内叶子名取自首条消息转写（如 `修一下登录报错`），
// 而我们给同一条会话算出来的落点是 `<桶根>/<日期>/<targetId>`。于是 codex→codex（或全量互导）
// 每次 --apply 都会命中 skip 分支的「落点自愈」：改写 session_meta.cwd + 翻转注册表归属。
// 内容一个字没变，却替用户改了他原生会话的归属 —— 而且下次宿主自己会写回去，来回拉扯。
// 规则：自愈只作用于我们写过的行（targetSummary.provenance 存在）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, bucketRoot } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { PROVENANCE_LINE_TYPE } from '../src/readers/codex.mjs';
import { TOOL_NAME, PROVENANCE_VERSION } from '../src/provenance.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');
const ID = 'b0cb7f6e-0000-5000-8000-abcdef012345';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m40-${name}-`));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}
const regFile = (root) => path.join(root, '.codex', '.codex-global-state.json');

/** 手写一条「宿主原生」的非项目 codex 会话：正文在 .codex/sessions 下，归属字段指向桶内宿主自铸的叶子名 */
function writeNativeCodex(root, ctx) {
  const leaf = path.join(bucketRoot(ctx, 'codex'), '2026-10-08', '修一下登录报错');
  const sessDir = path.join(root, '.codex', 'sessions', '2026', '10', '08');
  const file = path.join(sessDir, `rollout-2026-10-08T18-30-21-${ID}.jsonl`);
  fs.mkdirSync(sessDir, { recursive: true });
  const rows = [
    {
      type: 'session_meta',
      id: ID,
      payload: { id: ID, cwd: J(leaf), originator: 'session-sync-test', cli_version: '1.0.0', source: 'cli', model: 'm-1', runtime_workspace_roots: [bucketRoot(ctx, 'codex')], timestamp: '2026-10-08T18:30:21.000Z' },
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮' }] }, timestamp: '2026-10-08T18:30:21.000Z' },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '想一想' }] }, timestamp: '2026-10-08T18:30:25.000Z' },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答第一轮' }] }, timestamp: '2026-10-08T18:30:30.000Z' },
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  fs.mkdirSync(path.dirname(regFile(root)), { recursive: true });
  fs.writeFileSync(
    regFile(root),
    JSON.stringify(
      {
        'projectless-thread-ids': [ID],
        'thread-workspace-root-hints': { [ID]: bucketRoot(ctx, 'codex') },
        'thread-projectless-output-directories': { [ID]: path.join(J(leaf), 'outputs') },
        'electron-persisted-atom-state': { keep: 1 },
      },
      null,
      2,
    ),
    'utf8',
  );
  return { file, leaf };
}
function snap(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function treeOf(root, ctx) {
  const out = [];
  for (const base of [path.join(root, '.codex', 'sessions'), bucketRoot(ctx, 'codex')]) {
    if (fs.existsSync(base)) for (const e of fs.readdirSync(base, { recursive: true })) out.push(String(e));
  }
  return out.sort();
}

test('宿主原生会话在 skip 时一个字节都不动（正文 + 注册表）', () => {
  const root = tmpRoot('codex-native');
  const ctx = ctxFor(root);
  const { file } = writeNativeCodex(root, ctx);

  const before = { rollout: snap(file), registry: snap(regFile(root)), tree: treeOf(root, ctx) };
  const r = executePlan(ctx, planImport(ctx, { from: ['codex'], into: ['codex'] }), { apply: true, lock: false })[0];

  assert.equal(r?.action, 'skip', `应判 skip：${JSON.stringify(r)}`);
  assert.equal(r.reason, 'round-trip-self', `源与目标是同一条会话，理由不能写成归档：${r.reason}`);
  assert.ok((r.warnings ?? []).some((w) => /relocate-foreign/.test(String(w))), `必须说明「没动宿主原生会话」：${JSON.stringify(r.warnings)}`);
  assert.equal(r.relocated, undefined, '不能报告搬迁成功');

  const after = { rollout: snap(file), registry: snap(regFile(root)), tree: treeOf(root, ctx) };
  assert.deepEqual(after, before, '原生会话的正文/注册表/目录树必须逐字节不变');

  // 我们写过的行仍要自愈：给同一条会话补上 session-sync 标记行后重跑，落点变了就该搬
  const rows = before.rollout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.push({ timestamp: '2026-10-08T18:30:31.000Z', ordinal: 0, type: PROVENANCE_LINE_TYPE, 'session-sync': { tool: TOOL_NAME, v: PROVENANCE_VERSION, origin: { variant: 'codex', sessionId: ID } } });
  fs.writeFileSync(file, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
  const r2 = executePlan(ctx, planImport(ctx, { from: ['codex'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.equal(r2?.action, 'skip', JSON.stringify(r2));
  assert.equal(r2.relocated, true, `自己写的行要跟着落点搬：${JSON.stringify(r2)}`);
  const meta2 = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  assert.equal(J(meta2.payload.cwd), J(path.join(bucketRoot(ctx, 'codex'), '2026-10-08', ID)), '标记过的行才允许改写归属字段');
});
