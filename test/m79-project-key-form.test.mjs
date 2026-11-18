// M79 测试：项目键的**目录形态**必须与各宿主自己的记法一致
//
// 背景：各家宿主都按「自己记的 cwd」现算项目键（slug / md5 / 原串）。
// 源 agent 记的盘符大小写（或分隔符）与宿主自己记的不一致时，算出来是**另一个键**
// → 写进另一个目录 / 另一行项目 → 侧栏两个同名项目（MiniMax 那次就是这么现形的）。
//
// 盘符大小写是**每家自己的约定**（本机真机实测，见 util.mjs 的 canonicalDirPath 注释）：
//   - 大写：claude（13/13）、pi（4/4）、minimax、dsh —— 都按 process.cwd() 记
//   - 小写：workbuddy（46/47）、codebuddy-ide（URI 形态 `d:/...`，368 条）
// 所以这一层不能全局一刀切，必须由各家按自己的约定传参。
//
// 本文件钉住四件事：
//   1) claude / pi：源侧盘符小写 → 必须落进宿主那个**大写盘符**的既有目录；
//   2) workbuddy：源侧盘符大写 → 必须落进宿主那个**小写盘符**的既有目录；
//   3) codebuddy-ide：源侧盘符大写 → 必须落进宿主的**小写盘符** md5 目录（md5 不可逆，只能认领）；
//   4) 目录名本身的大小写不同 → 靠宿主登记的「md5 → 目录」对照表认领，不新算一个键。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { claudeWriter } from '../src/writers/claude.mjs';
import { piWriter } from '../src/writers/pi.mjs';
import { codebuddyIdeWriter } from '../src/writers/codebuddy-ide.mjs';
import { slugForClaude, slugForPi, slugForWorkbuddy } from '../src/writers/base.mjs';
// 命名空间导入：行为断言不依赖新导出（老代码上要能跑出「行为不对」而不是「导入就炸」）
import * as cbidReader from '../src/readers/codebuddy-ide.mjs';
const codebuddyWorkspaceKey = cbidReader.codebuddyWorkspaceKey;
const resolveCodebuddyWorkspaceKey = cbidReader.resolveCodebuddyWorkspaceKey;

const T0 = 1791484221000;

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m79-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { ...env } });
}

// 源会话（claude jsonl），cwd 由调用方给
function mkClaudeSource(root, id, cwd, texts = ['第一轮']) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: new Date(T0 + i * 9000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: new Date(T0 + i * 9000 + 100).toISOString(), message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function importInto(root, into) {
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: [into] });
  return { ctx, results: executePlan(ctx, plan, { apply: true, lock: false }) };
}

test('claude：源侧盘符小写 → 必须落进宿主那个大写盘符的既有目录', () => {
  const root = tmpHome('claude');
  const projects = path.join(root, '.claude', 'projects');
  // 宿主自己开的项目目录（大写盘符，本机 13/13 实测的约定）
  const hostDir = path.join(projects, 'D--02-mywork-session-sync');
  fs.mkdirSync(hostDir, { recursive: true });

  const ctx = ctxFor(root);
  // 源 agent 记的是小写盘符
  const src = {
    id: 'src', variant: 'codex', title: 'x', cwd: 'd:\\02-mywork\\session-sync',
    createdAt: T0, updatedAt: T0,
    turns: [{ index: 0, role: 'user', startedAt: T0, items: [{ kind: 'message', role: 'user', text: '第一轮', ts: T0 }] }],
  };
  const r = claudeWriter.write(ctx, { session: src, targetId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', mode: 'create' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.includes('D--02-mywork-session-sync'), `必须复用宿主既有目录，实际 ${dirs.join(',')}`);
  const lowerTwin = dirs.find((d) => d.toLowerCase() === 'd--02-mywork-session-sync' && d !== 'D--02-mywork-session-sync');
  assert.equal(lowerTwin, undefined, `不得另建小写盘符的孪生目录（侧栏两个同名项目）：${dirs.join(',')}`);
  // 正文必须落在宿主那个目录里
  const written = fs.readdirSync(hostDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(written.length, 1, `正文必须写进宿主目录：${fs.readdirSync(hostDir).join(',')}`);
});

test('pi：源侧盘符小写 → 必须落进宿主那个大写盘符的既有目录', () => {
  const root = tmpHome('pi');
  const sessions = path.join(root, '.pi', 'agent', 'sessions');
  const hostDir = path.join(sessions, '--D--02-mywork-session-sync--');
  fs.mkdirSync(hostDir, { recursive: true });
  mkClaudeSource(root, 's1', 'd:\\02-mywork\\session-sync');

  const ctx = ctxFor(root, { PI_CODING_AGENT_DIR: path.join(root, '.pi') });
  const plan = planImport(ctx, { from: ['claude'], into: ['pi'] });
  const results = executePlan(ctx, plan, { apply: true, lock: false });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const dirs = fs.readdirSync(sessions, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.includes('--D--02-mywork-session-sync--'), `必须复用宿主既有目录，实际 ${dirs.join(',')}`);
  assert.equal(dirs.filter((d) => d.toLowerCase() === '--d--02-mywork-session-sync--' && d !== '--D--02-mywork-session-sync--').length, 0, '不得另建小写盘符的孪生目录');
});

test('workbuddy：源侧盘符大写 → 必须落进宿主那个小写盘符的既有目录', () => {
  const root = tmpHome('workbuddy');
  const projects = path.join(root, '.workbuddy', 'projects');
  // workbuddy 记自己的 cwd：小写盘符（本机 46/47 实测）
  const hostDir = path.join(projects, 'd-02-mywork-session-sync');
  fs.mkdirSync(hostDir, { recursive: true });
  mkClaudeSource(root, 's1', 'D:\\02-mywork\\session-sync');

  const { results } = importInto(root, 'workbuddy-cn');
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(dirs.includes('d-02-mywork-session-sync'), `必须复用宿主既有目录，实际 ${dirs.join(',')}`);
  assert.equal(dirs.filter((d) => d.toLowerCase() === 'd-02-mywork-session-sync' && d !== 'd-02-mywork-session-sync').length, 0, '不得另建大写盘符的孪生目录');
});

test('slug 派生：盘符大小写按各家约定，其余字母大小写不动', () => {
  // claude / pi：大写；workbuddy：小写
  assert.equal(slugForClaude('d:\\02-mywork\\session-sync'), 'D--02-mywork-session-sync');
  assert.equal(slugForPi('d:\\02-mywork\\session-sync'), '--D--02-mywork-session-sync--');
  assert.equal(slugForWorkbuddy('D:\\02-mywork\\session-sync'), 'd-02-mywork-session-sync');
  // 其余字母大小写保持原样（宿主记什么就是什么）
  assert.equal(slugForClaude('D:\\02-mywork\\SessionSync'), 'D--02-mywork-SessionSync');
  assert.equal(slugForWorkbuddy('D:\\02-mywork\\SessionSync'), 'd-02-mywork-SessionSync');
});

test('codebuddy-ide：源侧盘符大写 → 必须落进宿主那个小写盘符的 md5 目录', () => {
  const root = tmpHome('cbid');
  const data = path.join(root, 'Data');
  const history = path.join(data, 'default', 'CodeBuddyIDE', 'history');
  fs.mkdirSync(history, { recursive: true });
  // 宿主自己的项目目录：md5(小写盘符形态)
  const hostKey = codebuddyWorkspaceKey('d:/02-mywork/session-sync');
  fs.mkdirSync(path.join(history, hostKey), { recursive: true });
  // 宿主登记过的目录（genie-history 的 base64 目录名可逆）
  const gh = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot', 'genie-history');
  const b64 = Buffer.from('d:/02-mywork/session-sync', 'utf8').toString('base64').replace(/[/+=]/g, '_');
  fs.mkdirSync(path.join(gh, b64), { recursive: true });

  const ctx = ctxFor(root, { CODEBUDDY_EXTENSION_DATA: data, CODEBUDDY_EXTENSION_HISTORY: history });
  const src = {
    id: 'src', variant: 'claude', title: 'x', cwd: 'D:/02-mywork/session-sync',
    createdAt: T0, updatedAt: T0,
    turns: [{ index: 0, role: 'user', startedAt: T0, items: [{ kind: 'message', role: 'user', text: '第一轮', ts: T0 }] }],
  };
  const targetId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const r = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const dirs = fs.readdirSync(history, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(dirs, [hostKey], `只能有宿主那一个项目目录，实际 ${dirs.join(',')}`);
});

test('codebuddy-ide：目录名大小写不同 → 认领宿主登记过的那一行，不新算一个键', () => {
  assert.equal(typeof resolveCodebuddyWorkspaceKey, 'function', '读侧必须导出工作区键解析函数');
  const root = tmpHome('cbid-case');
  const data = path.join(root, 'Data');
  const history = path.join(data, 'default', 'CodeBuddyIDE', 'history');
  fs.mkdirSync(history, { recursive: true });
  // 宿主登记的是 .../SessionSync（这个大小写）
  const hostPath = 'd:/02-mywork/SessionSync';
  const hostKey = crypto.createHash('md5').update(path.normalize(hostPath)).digest('hex');
  fs.mkdirSync(path.join(history, hostKey), { recursive: true });
  const gh = path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot', 'genie-history');
  const b64 = Buffer.from(hostPath, 'utf8').toString('base64').replace(/[/+=]/g, '_');
  fs.mkdirSync(path.join(gh, b64), { recursive: true });

  const ctx = ctxFor(root, { CODEBUDDY_EXTENSION_DATA: data, CODEBUDDY_EXTENSION_HISTORY: history });
  // 源侧记的是另一种大小写
  const key = resolveCodebuddyWorkspaceKey(ctx, history, 'd:/02-mywork/sessionsync');
  assert.equal(key, hostKey, '必须认领宿主登记过的那一行');

  const src = {
    id: 'src', variant: 'claude', title: 'x', cwd: 'd:/02-mywork/sessionsync',
    createdAt: T0, updatedAt: T0,
    turns: [{ index: 0, role: 'user', startedAt: T0, items: [{ kind: 'message', role: 'user', text: '第一轮', ts: T0 }] }],
  };
  const targetId = 'b1c2d3e4f5061728394a5b6c7d8e9f01';
  const r = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const dirs = fs.readdirSync(history, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(dirs, [hostKey], `不得新算一个键另建目录，实际 ${dirs.join(',')}`);
});
