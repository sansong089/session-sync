// M24 测试：freebuff 的 ID 形态与项目重名（计划改动清单 10c 的收尾两条）
//
// 现网取证：宿主列表 = 纯目录枚举 + mtime 倒序取前 500 + `messageCount > 0`
//（`freebuff.exe` @105950291 的 FXH/TXH），所以：
//   - 只有 `log.jsonl` 没有 `chat-messages.json` 的目录会被隐藏（现网确有 2 个这样的活证据）；
//   - `chat-meta.json.messageCount` 必须 > 0，否则 `if(f>0)` 直接跳过；
//   - 项目维度由「当前打开的 projectRoot」决定，与目录名以外的东西无关 →
//     `basename` 天然冲突（D:\a\demo-app 与 D:\b\demo-app 同名），跨机器导入会串项目。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m24-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['freebuff'],
  );
}

function mkClaudeSource(root, id, cwd) {
  const rows = [
    { parentUuid: null, type: 'user', sessionId: id, cwd, uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text: `会话 ${id}` }] } },
    { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '乙' }] } },
  ];
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('写入后必须能用同一种 ID 读回（writer 不能返回 project/chatDir 而 reader 只认 chatsName）', () => {
  const root = tmpRoot('id-shape');
  mkClaudeSource(root, 's1', 'D:/work/proj-a');
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));

  // 直接问 writer 本身的返回值（编排层会覆盖成 fresh.targetId，光看 result 抓不到形态不一致）
  const src = readSession('claude', ctx, 's1').session;
  const direct = getWriter('freebuff').write(ctx, { session: src, targetId: 'direct-id-1', mode: 'create', provenance: null, force: true });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(direct.targetId, 'direct-id-1', `writer 的 ID 必须就是 chats 目录名，实际 ${direct.targetId}`);

  const back = readSession('freebuff', ctx, 'direct-id-1');
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.ok(back.session, '按写出的 ID 必须能读回（round-trip）');

  const list = listSessions('freebuff', ctx, {});
  assert.ok(list.sessions.some((s) => s.id === 'direct-id-1'), JSON.stringify(list.sessions.map((x) => x.id)));
});

test('宿主可见性的硬条件：chat-messages.json 非空数组 + chat-meta.json.messageCount>0', () => {
  const root = tmpRoot('visible');
  mkClaudeSource(root, 's2', 'D:/work/proj-b');
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false })[0];
  const dir = r.path;
  const messages = JSON.parse(fs.readFileSync(path.join(dir, 'chat-messages.json'), 'utf8'));
  assert.ok(Array.isArray(messages) && messages.length > 0, '必须是**非空 JSON 数组**（缺 → messageCount=0 → 被宿主跳过）');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'chat-meta.json'), 'utf8'));
  assert.ok(meta.messageCount > 0, JSON.stringify(meta));
  assert.ok(String(meta.firstPrompt).length > 0, 'firstPrompt 供侧栏标题');
});

test('两个不同父目录同名时给 project-name-collision 警告', () => {
  const root = tmpRoot('collision');
  mkClaudeSource(root, 's3', 'D:/team-a/demo-app');
  mkClaudeSource(root, 's4', 'D:/team-b/demo-app');
  const ctx = ctxFor(root);
  const rs = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false });
  assert.equal(rs.length, 2, JSON.stringify(rs.map((x) => [x.sourceId, x.ok])));
  const warned = rs.filter((x) => (x.warnings ?? []).some((w) => /project-name-collision/.test(String(w))));
  assert.equal(warned.length, 1, `第二条应提示同名项目：${JSON.stringify(rs.map((x) => x.warnings))}`);
  // 两条会话本身都还在（目录同名 ≠ 会话同名）
  assert.ok(J(warned[0].path).includes('projects/demo-app/chats/'), warned[0].path);
});

// —— 项目注册（recent-projects.json）——
// 宿主的项目选择器只读这个注册表（freebuff.exe 的 SJA/rjL，agent-storage §15 V8）：
// 只建 projects/<project>/ 目录不会进选择器列表。形状按宿主自己的 save：
// 目录在盘上存在才登记、{path,lastOpened} 按 path 去重置顶、上限 10、2 空格 JSON。

function registryFile(root) {
  return path.join(root, '.config', 'manicode', 'recent-projects.json');
}
function readRegistry(root) {
  return JSON.parse(fs.readFileSync(registryFile(root), 'utf8'));
}
function mkProjDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('项目会话写入时登记 recent-projects.json（项目选择器的唯一列表来源）', () => {
  const root = tmpRoot('register');
  const projDir = mkProjDir(root, 'real-proj');
  mkClaudeSource(root, 's-reg', projDir);
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((r.warnings ?? []).some((w) => /project-registered/.test(String(w))), JSON.stringify(r.warnings));
  const entries = readRegistry(root);
  assert.ok(Array.isArray(entries) && entries.length === 1, JSON.stringify(entries));
  assert.equal(entries[0].path, path.resolve(projDir));
  assert.ok(Number.isFinite(entries[0].lastOpened) && entries[0].lastOpened > 0, JSON.stringify(entries[0]));
  const text = fs.readFileSync(registryFile(root), 'utf8');
  assert.ok(text.includes('\n  {'), `应是 2 空格 JSON（宿主 save 形状）：${text.slice(0, 80)}`);
});

test('登记按 path 去重置顶、上限 10 条，挤掉最旧、其余保序', () => {
  const root = tmpRoot('cap');
  const projDir = mkProjDir(root, 'new-proj');
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = Array.from({ length: 10 }, (_, i) => ({ path: path.join(root, `old-${i}`), lastOpened: 1000 + i }));
  fs.writeFileSync(file, JSON.stringify(old, null, 2), 'utf8');
  mkClaudeSource(root, 's-cap1', projDir);
  mkClaudeSource(root, 's-cap2', projDir);
  const ctx = ctxFor(root);
  const rs = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false });
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.map((r) => r.error)));
  const entries = readRegistry(root);
  assert.equal(entries.length, 10, '上限 10 条');
  assert.equal(entries[0].path, path.resolve(projDir), '新登记置顶');
  assert.equal(entries.filter((e) => e.path === path.resolve(projDir)).length, 1, '同项目两条会话只占一条');
  assert.deepEqual(entries.slice(1).map((e) => e.path), old.slice(0, 9).map((e) => e.path), '挤掉最旧一条，其余保序（不存在的旧条目也不删，宿主读时自己过滤）');
});

test('去重按路径等价匹配（大小写/分隔符），不产生同目录双条目', () => {
  const root = tmpRoot('dedupe');
  const projDir = mkProjDir(root, 'case-proj');
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 宿主记的是它收到的字符串形态；我们写的形态与之不同则精确匹配会漏 → 双条目
  const variant = path.resolve(projDir).toLowerCase().replace(/\\/g, '/');
  fs.writeFileSync(file, JSON.stringify([{ path: variant, lastOpened: 123 }], null, 2), 'utf8');
  mkClaudeSource(root, 's-case', projDir);
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  const entries = readRegistry(root);
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].path, path.resolve(projDir));
});

test('项目目录不在盘上：正文照写，不造假条目，告警 project-unmatched', () => {
  const root = tmpRoot('unmatched');
  mkClaudeSource(root, 's-gone', path.join(root, 'not-on-disk'));
  const ctx = ctxFor(root);
  const r = executePlan(ctx, planImport(ctx, { from: ['claude'], into: ['freebuff'] }), { apply: true, lock: false })[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((r.warnings ?? []).some((w) => /project-unmatched/.test(String(w))), JSON.stringify(r.warnings));
  assert.equal(fs.existsSync(registryFile(root)), false, '不应创建注册表');
});

test('历史导入缺登记：复跑走 skip 自愈补上；幂等再跑不动既有列表', () => {
  const root = tmpRoot('selfheal');
  const projDir = mkProjDir(root, 'heal-proj');
  mkClaudeSource(root, 's-heal', projDir);
  const ctx = ctxFor(root);
  const opts = { from: ['claude'], into: ['freebuff'] };
  const r1 = executePlan(ctx, planImport(ctx, opts), { apply: true, lock: false })[0];
  assert.equal(r1.ok, true, JSON.stringify(r1));
  fs.unlinkSync(registryFile(root)); // 模拟老版本导入：只建了目录、没登记
  const r2 = executePlan(ctx, planImport(ctx, opts), { apply: true, lock: false })[0];
  assert.equal(r2.action, 'skip', JSON.stringify(r2));
  assert.ok((r2.warnings ?? []).some((w) => /project-registered/.test(String(w))), JSON.stringify(r2));
  assert.equal(readRegistry(root)[0].path, path.resolve(projDir));
  const before = fs.readFileSync(registryFile(root), 'utf8');
  const r3 = executePlan(ctx, planImport(ctx, opts), { apply: true, lock: false })[0];
  assert.equal(r3.action, 'skip');
  assert.equal(fs.readFileSync(registryFile(root), 'utf8'), before, '幂等复跑不得重排/刷新用户的最近项目列表');
});

test('ensureIndex 只补缺：已有条目不置顶、不刷 lastOpened', () => {
  const root = tmpRoot('no-refresh');
  const projDir = mkProjDir(root, 'keep-pos');
  const other = mkProjDir(root, 'other-proj');
  const file = registryFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = [
    { path: path.resolve(other), lastOpened: 2000 },
    { path: path.resolve(projDir), lastOpened: 1000 },
  ];
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
  const ctx = ctxFor(root);
  const r = getWriter('freebuff').ensureIndex(ctx, { targetId: 'x', cwd: projDir });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, false);
  assert.deepEqual(readRegistry(root), entries, '位置与 lastOpened 都不动');
});
