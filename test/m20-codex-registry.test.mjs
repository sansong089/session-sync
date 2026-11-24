// M20 测试：codex 写侧 —— 非项目会话的 session_meta 形态 + 宿主注册表
//
// 实测依据（本机 .codex-global-state.json，2026-10-27 取证）：
//   非项目线程：projectless-thread-ids 含该 id；thread-workspace-root-hints[id] = 桶根字符串；
//              thread-projectless-output-directories[id] = `<桶根>/<日期>/<slug>/outputs`；
//              **不**出现在 thread-project-assignments，也不在 local-projects。
//   项目线程：  thread-project-assignments[id] = {projectKind:'local', projectId:<uuid>}，
//              local-projects[projectId] = {id,name,rootPaths:[<repo根>],createdAt,updatedAt}，
//              projectId 在 project-order 数组里。
//   桶内 session_meta 的真实键：cwd=桶内叶子、runtime_workspace_roots=[桶根]、**完全没有 git 键**。
// 只写 rollout 文件宿主不列（已实测），所以注册表是可见性的硬前置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { bucketRoot } from '../src/hosts.mjs';
import { backupsOf, strayBackups } from './backup-fixture.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');
const ROOT_JSON = (root) => path.join(root, '.codex', '.codex-global-state.json');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m20-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['codex'],
  );
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function claudeSource(root, id, cwd, texts) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: `2026-10-08T18:3${i}:21.000Z`, message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: `2026-10-08T18:3${i}:30.000Z`, message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  writeJsonl(path.join(root, '.claude', 'projects', 'src-p', `${id}.jsonl`), rows);
}
const firstLine = (file) => JSON.parse(fs.readFileSync(file, 'utf8').split('\n').find((l) => l.trim()));
const readRegistry = (root) => JSON.parse(fs.readFileSync(ROOT_JSON(root), 'utf8'));

// 宿主把注册表拆成「按账户分区」的 owner 空间（【源码】app.asar 26.1111.9664.0）：
// 路径提示两键在 electron-owner-value:<key>:<ownerId>，顶层裸键宿主读不到
const OWNER_VALUE_PREFIX = 'electron-owner-value:';
const CONTENT_OWNER_KEY = 'electron-renderer-content-owner';

/** 取一个键的现网形态：顶层裸键 + 所有 owner 空间的并集（owner 空间优先）。 */
function collectOwnerScoped(st, key) {
  const out = { ...(st[key] && typeof st[key] === 'object' ? st[key] : {}) };
  for (const k of Object.keys(st)) {
    if (k.startsWith(OWNER_VALUE_PREFIX) && k.slice(OWNER_VALUE_PREFIX.length).startsWith(`${key}:`)) {
      Object.assign(out, st[k]);
    }
  }
  return out;
}

function ownerSpaceKeys(st, key) {
  return Object.keys(st).filter((k) => k.startsWith(`${OWNER_VALUE_PREFIX}${key}:`));
}

test('codex 非项目：session_meta 无 git、cwd=桶内目录、runtime_workspace_roots=桶根，并写满三个注册表键', () => {
  const root = tmpRoot('codex-none');
  const bucketCwd = J(path.join(root, 'WorkBuddy', '2026-10-08-18-38-21'));
  claudeSource(root, 's1', bucketCwd, ['桶里的会话']);
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['codex'], account: 'user-FAKEFAKEFAKEFAKEFAKEFAKES' });
  const r = executePlan(ctx, plan, { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.placement.scope, 'none');

  const meta = firstLine(r.path);
  assert.equal(meta.type, 'session_meta');
  assert.ok(!('git' in meta.payload), `非项目绝不能带 git 键（105/105 实测一致）：${JSON.stringify(meta.payload.git)}`);
  assert.equal(J(meta.payload.cwd), J(r.placement.directory));
  assert.deepEqual(meta.payload.runtime_workspace_roots, [bucketRoot(ctx, 'codex')], '非项目的 workspace 根是桶根，不是桶内叶子');
  assert.equal(meta.payload.creator_user_id, 'user-FAKEFAKEFAKEFAKEFAKEFAKES');

  const st = readRegistry(root);
  assert.ok(st['projectless-thread-ids'].includes(r.targetId), '必须进非项目名单');
  assert.equal(st['thread-workspace-root-hints'][r.targetId], bucketRoot(ctx, 'codex'));
  assert.equal(J(st['thread-projectless-output-directories'][r.targetId]), J(path.join(r.placement.directory, 'outputs')));
  assert.equal(st['thread-project-assignments'][r.targetId], undefined, '非项目不得挂项目分配');

  // 读回来必须仍判非项目（round-trip）
  assert.equal(readSession('codex', ctx, r.targetId).session.scope, 'none');
});

test('codex 项目：写 local-projects + thread-project-assignments，且不进非项目名单', () => {
  const root = tmpRoot('codex-proj');
  const proj = 'D:/00-work/code/demo-app';
  claudeSource(root, 's2', proj, ['项目里的会话']);
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.placement.scope, 'project');

  const st = readRegistry(root);
  const asg = st['thread-project-assignments'][r.targetId];
  assert.equal(asg.projectKind, 'local');
  const projRow = st['local-projects'][asg.projectId];
  assert.ok(projRow, '必须建出项目行');
  assert.deepEqual(projRow.rootPaths, [proj]);
  assert.ok(st['project-order'].includes(asg.projectId), '项目要进排序数组，否则侧栏不显示');
  assert.ok(!st['projectless-thread-ids'].includes(r.targetId));
});

test('codex 注册表：保留未知键、幂等、不动别的线程', () => {
  const root = tmpRoot('codex-idem');
  fs.mkdirSync(path.dirname(ROOT_JSON(root)), { recursive: true });
  fs.writeFileSync(
    ROOT_JSON(root),
    JSON.stringify(
      {
        'some-unknown-flag': { keep: true },
        'projectless-thread-ids': ['other-thread'],
        'thread-workspace-root-hints': { 'other-thread': 'Z:/other' },
        'electron-persisted-atom-state': { n: 1 },
      },
      null,
      2,
    ),
    'utf8',
  );
  claudeSource(root, 's3', J(path.join(root, 'Documents', 'Codex', '2026-10-08', 'x')), ['桶会话']);
  const ctx = ctxFor(root);
  const first = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.equal(first.ok, true, JSON.stringify(first));
  const st = readRegistry(root);
  assert.deepEqual(st['some-unknown-flag'], { keep: true }, '未知键必须原样保留');
  assert.deepEqual(st['electron-persisted-atom-state'], { n: 1 });
  assert.deepEqual(st['projectless-thread-ids'].filter((x) => x === 'other-thread'), ['other-thread'], '别的线程不能动');
  assert.equal(st['thread-workspace-root-hints']['other-thread'], 'Z:/other');

  const second = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.ok(second.ok || second.action === 'skip', JSON.stringify(second));
  const st2 = readRegistry(root);
  assert.equal(st2['projectless-thread-ids'].filter((x) => x === first.targetId).length, 1, '重跑不得重复登记');
  // 备份只落在 ~/.session-sync/backups/<变体>/：宿主目录里留 .bak 会被宿主当成第二份注册表
  const backups = backupsOf(root, 'codex').filter((n) => n.includes('global-state'));
  assert.ok(backups.length >= 1, '注册表改写前必须留备份');
  assert.deepEqual(strayBackups(path.join(root, '.codex')), [], '宿主扫描根里不许留 .bak 残渣');
});

test('codex：改判落点时注册表要跟着翻转（非项目 → 项目 → 非项目）', () => {
  const root = tmpRoot('codex-flip');
  const bucketCwd = J(path.join(root, 'Documents', 'Codex', '2026-10-08', 'flip'));
  claudeSource(root, 's4', bucketCwd, ['换落点']);
  const ctx = ctxFor(root);

  const asNone = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  let st = readRegistry(root);
  assert.ok(st['projectless-thread-ids'].includes(asNone.targetId));

  const asProject = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'], placement: 'project' }), { apply: true, lock: false })[0];
  assert.equal(asProject.ok, true, JSON.stringify(asProject));
  st = readRegistry(root);
  assert.ok(!st['projectless-thread-ids'].includes(asNone.targetId), '转成项目后必须从非项目名单摘掉');
  assert.equal(st['thread-workspace-root-hints'][asNone.targetId], undefined);
  assert.equal(st['thread-projectless-output-directories'][asNone.targetId], undefined);
  assert.ok(st['thread-project-assignments'][asNone.targetId], '要挂上项目分配');
});

test('现网等值：宿主自己登记的非项目线程，三个键的形状必须与我们写的一致（只读取证）', (t) => {
  const real = makeCtx();
  const file = ROOT_JSON(real.home);
  if (!fs.existsSync(file)) {
    t.skip('本机没有 .codex-global-state.json');
    return;
  }
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = (st['projectless-thread-ids'] ?? []).slice(0, 20);
  assert.ok(ids.length > 0, '本机没有非项目线程，无从对照');
  const root = bucketRoot(real, 'codex');
  // 现网形态：路径提示两键可能已被宿主迁进 owner 空间，顶层裸键要一并看
  const hints = collectOwnerScoped(st, 'thread-workspace-root-hints');
  const outs = collectOwnerScoped(st, 'thread-projectless-output-directories');
  let checked = 0;
  for (const id of ids) {
    const hint = hints[id];
    if (hint === undefined) continue;
    assert.equal(hint, root, `hints[${id}] 必须是桶根（实测形态）`);
    checked++;
  }
  assert.ok(checked > 0, '对照样本为空');
  const dirs = Object.values(outs);
  assert.ok(dirs.length > 0);
  assert.ok(dirs.every((d) => String(d).endsWith('outputs')), '输出目录一律以 outputs 结尾');
  // 现网若已切到 owner 空间，顶层裸键就该是空的（有则说明宿主还在用旧形态）
  const hintSpaces = ownerSpaceKeys(st, 'thread-workspace-root-hints');
  if (hintSpaces.length > 0) {
    assert.ok(!st['thread-workspace-root-hints'], '宿主已切 owner 空间，顶层裸键不该再有路径提示');
    assert.ok(typeof st[CONTENT_OWNER_KEY] === 'string', 'owner 空间形态必须有 content-owner 标记');
  }
});

test('codex owner 空间形态：路径提示必须写进 electron-owner-value:<key>:<ownerId>，顶层裸键不写', () => {
  const root = tmpRoot('codex-owner');
  const OWNER = 'a'.repeat(64);
  fs.mkdirSync(path.dirname(ROOT_JSON(root)), { recursive: true });
  fs.writeFileSync(
    ROOT_JSON(root),
    JSON.stringify(
      {
        'projectless-thread-ids': [],
        [CONTENT_OWNER_KEY]: OWNER,
        [`electron-owner-atoms:${OWNER}`]: { 'seen-model-upgrade-list': [] },
        [`${OWNER_VALUE_PREFIX}thread-workspace-root-hints:${OWNER}`]: {},
        'some-unknown-flag': { keep: true },
      },
      null,
      2,
    ),
    'utf8',
  );
  const bucketCwd = J(path.join(root, 'Documents', 'Codex', '2026-11-24', 'demo'));
  claudeSource(root, 's9', bucketCwd, ['桶里的会话']);
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.placement.scope, 'none');

  const st = readRegistry(root);
  const hints = st[`${OWNER_VALUE_PREFIX}thread-workspace-root-hints:${OWNER}`];
  const outs = st[`${OWNER_VALUE_PREFIX}thread-projectless-output-directories:${OWNER}`];
  assert.equal(hints?.[r.targetId], bucketRoot(ctx, 'codex'), '路径提示必须落在 owner 分区键（宿主只读它）');
  assert.equal(J(outs?.[r.targetId]), J(path.join(r.placement.directory, 'outputs')));
  assert.equal(st['thread-workspace-root-hints']?.[r.targetId], undefined, '顶层裸键宿主读不到，不许再写');
  assert.equal(st['thread-projectless-output-directories']?.[r.targetId], undefined, '顶层裸键宿主读不到，不许再写');
  assert.ok(st['projectless-thread-ids'].includes(r.targetId), '非项目名单仍在顶层（宿主没迁它）');
  assert.deepEqual(st['some-unknown-flag'], { keep: true }, '未知键必须原样保留');
});

test('codex 多 owner 空间且未标当前账户：退回顶层旧键并告警', () => {
  const root = tmpRoot('codex-multi-owner');
  const O1 = 'b'.repeat(64);
  const O2 = 'c'.repeat(64);
  fs.mkdirSync(path.dirname(ROOT_JSON(root)), { recursive: true });
  fs.writeFileSync(
    ROOT_JSON(root),
    JSON.stringify(
      {
        'projectless-thread-ids': [],
        [`electron-owner-atoms:${O1}`]: {},
        [`electron-owner-atoms:${O2}`]: {},
      },
      null,
      2,
    ),
    'utf8',
  );
  const bucketCwd = J(path.join(root, 'Documents', 'Codex', '2026-11-24', 'demo2'));
  claudeSource(root, 's10', bucketCwd, ['多账户场景']);
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['codex'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(
    (r.warnings ?? []).some((w) => String(w).includes('registry-owner-unresolved')),
    `必须告警说明退回顶层旧键：${JSON.stringify(r.warnings)}`,
  );
  const st = readRegistry(root);
  assert.equal(st['thread-workspace-root-hints']?.[r.targetId], bucketRoot(ctx, 'codex'), '退回顶层旧键（保底）');
  assert.equal(st[`${OWNER_VALUE_PREFIX}thread-workspace-root-hints:${O1}`]?.[r.targetId], undefined, '不许乱写 owner 空间');
  assert.equal(st[`${OWNER_VALUE_PREFIX}thread-workspace-root-hints:${O2}`]?.[r.targetId], undefined, '不许乱写 owner 空间');
});

test('codex 标题取 state_<N>.sqlite 的 threads（name 优先，其次 title），不是首条消息', () => {
  const root = tmpRoot('codex-title');
  const id = '01a13f23-0000-7000-8000-000000000000';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T00-03-14-${id}.jsonl`), [
    { type: 'session_meta', id, payload: { id, timestamp: '2026-10-14T00:03:14.017Z', cwd: 'D:/00-demo-app', model: 'gpt-5' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看下这个目录' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] } },
  ]);
  const db = new DatabaseSync(path.join(root, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT)');
  db.prepare('INSERT INTO threads (id, name, title, first_user_message) VALUES (?,?,?,?)').run(id, '用户改的名字', '自动摘要标题', '看下这个目录');
  db.close();

  const ctx = ctxFor(root);
  const row = listSessions('codex', ctx, {}).sessions.find((s) => String(s.id) === id);
  assert.ok(row, '会话必须被列出');
  assert.equal(row.title, '用户改的名字', `list 标题应为宿主 name，实际 ${row.title}`);
  assert.equal(readSession('codex', ctx, id).session.title, '用户改的名字', 'read 同一口径');

  const db2 = new DatabaseSync(path.join(root, '.codex', 'state_5.sqlite'));
  db2.prepare('UPDATE threads SET name = NULL WHERE id = ?').run(id);
  db2.close();
  const row2 = listSessions('codex', ctx, {}).sessions.find((s) => String(s.id) === id);
  assert.equal(row2.title, '自动摘要标题', '没有自定义 name 时退回宿主 title');
});
