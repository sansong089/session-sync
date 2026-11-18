// M69 测试：append 导入时源侧标题变了，目标标题必须跟着改（主人 2026-11-04 明确指出）
//
// 曾经的错误设计：append 的正文写入「顺手把标题写进正文」，标题同步通道只服务 skip 分支。
// 于是把「顺手写」去掉后，源侧改名 + 同时有新轮次这条路径永远不同步标题。
//
// 现在的口径：正文写入**不写标题**（那会让标题有两个写入口，且绕过 guard），
// 标题只有一条通道 —— 写完正文后按「源 != 目标」补一次（syncTitleIfChanged）。
// 本文件钉死三种情形：
//   1) append + 源改名            → 标题更新
//   2) append + 源没改名          → 目标标题一字不动（不写才算对的）
//   3) append + 用户已定名(guard) → 用户的名字不被顶掉
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m69-${name}-`));
}

function ctxFor(home, variants) {
  return seedHostSeen(
    makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {} }),
    variants,
  );
}

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** 源：claude 会话。title 用 ai-title 行（读侧最后一条胜出）表达 */
function mkClaudeSource(home, id, { title, turns }) {
  const dir = path.join(home, '.claude', 'projects', 'D-work-ws');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const rows = [];
  if (title) rows.push({ type: 'ai-title', aiTitle: title, uuid: `${id}-t`, sessionId: id, cwd: 'D:/work/ws', timestamp: '2026-10-01T12:00:00.000Z' });
  turns.forEach((t, i) => {
    rows.push({ type: 'user', sessionId: id, cwd: 'D:/work/ws', uuid: `${id}-u${i}`, parentUuid: null, timestamp: new Date(T0 + i * 60000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ type: 'assistant', sessionId: id, cwd: 'D:/work/ws', uuid: `${id}-a${i}`, parentUuid: `${id}-u${i}`, timestamp: new Date(T0 + i * 60000 + 30000).toISOString(), message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
  });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

/** 目标：zcode（标题在 session.title / tasks.cli_title，带 title_overridden guard） */
function mkZcodeTarget(home) {
  const zroot = path.join(home, '.zcode');
  fs.mkdirSync(path.join(zroot, 'cli', 'db'), { recursive: true });
  fs.mkdirSync(path.join(zroot, 'v2'), { recursive: true });
  const cli = path.join(zroot, 'cli', 'db', 'db.sqlite');
  const cdb = new DatabaseSync(cli);
  cdb.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, permission TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT, title_source TEXT, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, path TEXT)');
  cdb.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, time_created INTEGER, time_updated INTEGER, sequence INTEGER, data TEXT)');
  cdb.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, type TEXT, time_created INTEGER, sequence INTEGER, data TEXT)');
  // provenance 落这张表：没有它，第二次导入认不出「这是我上次写的那条会话」，
  // 决策会判成 fork + identity-mismatch（本文件要测的是 append 的标题同步，不是首次导入）
  cdb.exec('CREATE TABLE session_entry (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  cdb.close();
  const idx = path.join(zroot, 'v2', 'tasks-index.sqlite');
  const idb = new DatabaseSync(idx);
  idb.exec('CREATE TABLE tasks (workspace_key TEXT, task_id TEXT, title TEXT, cli_title TEXT, title_overridden INTEGER, task_status TEXT, workspace_path TEXT, workspace_identity TEXT, provider TEXT, mode TEXT, model TEXT, migration_source TEXT, forked_from_task_id TEXT, created_at INTEGER, updated_at INTEGER, pinned INTEGER, archived INTEGER, deleted INTEGER, meta_json TEXT, searchable_text TEXT, PRIMARY KEY (workspace_key, task_id))');
  idb.close();
  return { cli, idx };
}

/** 把 zcode 目标里那条会话的显示名改成「用户自己起的」，并把 title_overridden 置 1 */
function userRenamedInZcode(idx, targetId, name) {
  const db = new DatabaseSync(idx);
  db.prepare('UPDATE tasks SET title = ?, cli_title = ?, title_overridden = 1 WHERE task_id = ?').run(name, name, targetId);
  db.close();
}

function runImport(ctx, into) {
  const plan = planImport(ctx, { from: ['claude'], into: [into] });
  assert.equal(plan.pairs.length, 1, `本次应产出一条 pair：${JSON.stringify(plan.pairs.map((p) => p.action))}`);
  return executePlan(ctx, plan, { apply: true, lock: false });
}

test('append + 源侧改名 → 目标标题必须跟着更新（不能只在 create 时写一次）', () => {
  const home = tmpHome('append-rename');
  try {
    const ctx = ctxFor(home, ['claude', 'zcode']);
    mkZcodeTarget(home);
    mkClaudeSource(home, 'src1', { title: '第一版标题', turns: ['第一轮'] });

    const first = runImport(ctx, 'zcode');
    assert.equal(first[0].ok, true, JSON.stringify(first[0]));
    assert.equal(first[0].action, 'create');
    const created = readSession('zcode', ctx, first[0].targetId).session;
    assert.equal(created.title, '第一版标题', `create 应写入源标题，实际 ${created.title}`);

    // 源侧改名 + 新增一轮 → 下一次是 append（正文有变化，不走 skip 通道）
    mkClaudeSource(home, 'src1', { title: '改名后的新标题', turns: ['第一轮', '第二轮'] });
    const second = runImport(ctx, 'zcode');
    assert.equal(second[0].ok, true, JSON.stringify(second[0]));
    assert.equal(second[0].action, 'append', `应判 append，实际 ${second[0].action}`);
    assert.equal(second[0].titleSynced, true, `append 也必须同步标题：${JSON.stringify(second[0])}`);

    const after = readSession('zcode', ctx, second[0].targetId).session;
    assert.equal(after.title, '改名后的新标题', `append 后目标标题应更新，实际 ${after.title}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('append + 源侧没改名 → 目标标题一字不动（不写才算对的）', () => {
  const home = tmpHome('append-same');
  try {
    const ctx = ctxFor(home, ['claude', 'zcode']);
    mkZcodeTarget(home);
    mkClaudeSource(home, 'src2', { title: '同一个标题', turns: ['第一轮'] });
    const first = runImport(ctx, 'zcode');
    assert.equal(first[0].ok, true, JSON.stringify(first[0]));

    mkClaudeSource(home, 'src2', { title: '同一个标题', turns: ['第一轮', '第二轮'] });
    const second = runImport(ctx, 'zcode');
    assert.equal(second[0].action, 'append', JSON.stringify(second[0]));
    assert.equal(second[0].titleSynced, undefined, `标题没变就不该写：${JSON.stringify(second[0])}`);
    assert.equal(readSession('zcode', ctx, second[0].targetId).session.title, '同一个标题');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('append + 用户已定名（guard）→ 源侧改名也不顶掉用户的名字', () => {
  const home = tmpHome('append-guard');
  try {
    const ctx = ctxFor(home, ['claude', 'zcode']);
    const { idx } = mkZcodeTarget(home);
    mkClaudeSource(home, 'src3', { title: '源侧标题', turns: ['第一轮'] });
    const first = runImport(ctx, 'zcode');
    assert.equal(first[0].ok, true, JSON.stringify(first[0]));

    userRenamedInZcode(idx, first[0].targetId, '用户自己起的');

    mkClaudeSource(home, 'src3', { title: '源侧改名了', turns: ['第一轮', '第二轮'] });
    const second = runImport(ctx, 'zcode');
    assert.equal(second[0].action, 'append', JSON.stringify(second[0]));
    assert.equal(second[0].titleSynced, undefined, `guard 命中就不该算同步成功：${JSON.stringify(second[0])}`);
    // 不是失败、也不该静默：结果里必须写清「为什么这次没改名」
    assert.equal(second[0].titleSkipped, 'user-defined-title', `必须如实透出跳过原因：${JSON.stringify(second[0])}`);

    const db = new DatabaseSync(idx);
    const row = db.prepare('SELECT title, cli_title, title_overridden FROM tasks WHERE task_id = ?').get(first[0].targetId);
    db.close();
    assert.equal(row.title, '用户自己起的', '用户的名字不许被顶掉');
    assert.equal(row.cli_title, '用户自己起的');
    assert.equal(row.title_overridden, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
