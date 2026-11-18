// M49 测试：CodeBuddy IDE / VS Code 插件（共用 tencent-cloud.coding-copilot 扩展）
//
// 真机取证（2026-10-29，本机 %LOCALAPPDATA%/CodeBuddyExtension/Data）：
//   <Data>/<user>/<ide>/<uid>/history/<md5(workspace)>/index.json
//   <conversationId>/index.json + messages/<messageId>.json
//   message.content[]：text / reasoning / tool-call / tool-result
//   cwd：首条 user 文本里的 <user_info> Workspace Folder: ...
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { codebuddyIdeWriter } from '../src/writers/codebuddy-ide.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, sessionCoreFingerprints } from '../src/ir.mjs';
import { stripSystemInjections } from '../src/readers/base.mjs';

const T0 = 1791484221000;
// 宿主公式：md5(normalize(路径))，路径取**宿主自己的 URI 形态**（盘符小写 + 正斜杠）。
// 真机核对（本机 %LOCALAPPDATA%/CodeBuddyExtension/Data）：现网 60 个 history 目录里
// 58 个与「md5(normalize(小写盘符路径))」逐字相等；VS Code 登记的 folder URI 一律小写盘符
// （368 条实测）。盘符大小写对不上 = 另一个 md5 = 另一个 history 目录。
// 这里**独立转写**宿主公式（不用被测模块的函数，避免自证）。
const hostPathForm = (s) => path.normalize(String(s).replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`));
const md5 = (s) => crypto.createHash('md5').update(hostPathForm(s)).digest('hex');

function tmpData(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m49-${tag}-`));
  const data = path.join(root, 'Data');
  const history = path.join(data, 'default', 'CodeBuddyIDE', 'history');
  fs.mkdirSync(history, { recursive: true });
  const ctx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), localAppData: path.join(root, 'AppData', 'Local'), env: { CODEBUDDY_EXTENSION_DATA: data, CODEBUDDY_EXTENSION_HISTORY: history } });
  return { root, data, history, ctx };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeConversation(data, { user = 'u1', ide = 'CodeBuddyIDE', uid = 'u1', cwd, id = 'conv-1', name = '宿主标题', messages }) {
  const wsKey = md5(cwd);
  const base = path.join(data, user, ide, uid, 'history', wsKey);
  const convDir = path.join(base, id);
  writeJson(path.join(base, 'index.json'), {
    conversations: [{ id, type: 'craft', name, createdAt: new Date(T0).toISOString(), lastMessageAt: new Date(T0 + messages.length * 1000).toISOString() }],
    current: id,
  });
  const indexMessages = [];
  fs.mkdirSync(path.join(convDir, 'messages'), { recursive: true });
  messages.forEach((m, i) => {
    const mid = `m${i}`;
    indexMessages.push({ id: mid, type: 'text', role: m.role, isComplete: true });
    writeJson(path.join(convDir, 'messages', `${mid}.json`), {
      role: m.role,
      id: mid,
      message: JSON.stringify({ role: m.role, content: m.content }),
      extra: JSON.stringify({ modelId: 'hy3' }),
    });
  });
  writeJson(path.join(convDir, 'index.json'), { messages: indexMessages, requests: [] });
  return { base, convDir };
}

function userText(query) {
  return [
    {
      type: 'text',
      text: `<user_info>\nOS Version: win32\nWorkspace Folder: ${''}</user_info>\n<git_status>\nOn branch main\n</git_status>\n<user_query>\n${query}\n</user_query>`,
    },
  ];
}

test('codebuddy-ide reader：读宿主真实结构（标题/轮次/cwd/工具/推理），并剥掉注入块', () => {
  const { data, ctx } = tmpData('read');
  const cwd = 'D:/00-work/code/sqt-recording-service';
  const first = userText('使用redis锁');
  first[0].text = first[0].text.replace('Workspace Folder: ', `Workspace Folder: ${cwd}`);
  writeConversation(data, {
    cwd,
    name: '使用redis锁',
    messages: [
      { role: 'user', content: first },
      { role: 'assistant', content: [{ type: 'reasoning', text: '先搜一下 Redis' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'search_content', args: { pattern: 'RedisTemplate' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'search_content', result: { status: 'success' }, isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: '已加分布式锁' }] },
      { role: 'user', content: [{ type: 'text', text: '<user_query>继续</user_query>' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完成' }] },
    ],
  });

  const row = listSessions('codebuddy-ide', ctx, {}).sessions.find((s) => s.id === 'conv-1');
  assert.ok(row, '会话必须被列出');
  assert.equal(row.title, '使用redis锁');
  assert.equal(row.cwd, cwd);
  assert.equal(row.turns, 2);
  assert.equal(row.model, 'hy3');

  const s = readSession('codebuddy-ide', ctx, 'conv-1').session;
  assert.equal(s.turns.length, 2);
  const userTexts = s.turns[0].items.filter((i) => i.kind === 'message' && i.role === 'user').map((i) => i.text);
  assert.deepEqual(userTexts, ['使用redis锁'], 'user_info/git_status 注入块必须剥离');
  const kinds = s.turns[0].items.map((i) => i.kind);
  assert.ok(kinds.includes('reasoning') && kinds.includes('tool_call') && kinds.includes('tool_result'));
});

test('codebuddy-ide reader：user_info 缺失时用 md5→workspace 反查 cwd', () => {
  const { root, data, ctx } = tmpData('map');
  const cwd = 'D:/00-work/code/freewitch-scripts';
  // v1 genie-history 的 base64 目录是可逆的工作区来源
  const b64 = Buffer.from(cwd, 'utf8').toString('base64').replace(/[/+=]/g, '_');
  fs.mkdirSync(path.join(root, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'tencent-cloud.coding-copilot', 'genie-history', b64), { recursive: true });
  writeConversation(data, {
    cwd,
    name: '旧格式会话',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '没有 user_info 的旧会话' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    ],
  });
  const row = listSessions('codebuddy-ide', ctx, {}).sessions.find((s) => s.id === 'conv-1');
  assert.equal(row.cwd, cwd, 'workspace hash 必须反查到真实目录');
});

test('codebuddy-ide reader：同一会话出现在 IDE 与插件两份缓存时取更完整的一份', () => {
  const { data, ctx } = tmpData('dedupe');
  const cwd = 'D:/work/demo';
  writeConversation(data, { ide: 'VSCode', cwd, id: 'dup-1', name: '短副本', messages: [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ] });
  writeConversation(data, { ide: 'CodeBuddyIDE', cwd, id: 'dup-1', name: '长副本', messages: [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答2' }] },
  ] });
  const rows = listSessions('codebuddy-ide', ctx, {}).sessions.filter((s) => s.id === 'dup-1');
  assert.equal(rows.length, 1, '同一 id 只出一行');
  assert.equal(rows[0].turns, 2, '保留消息更全的副本');
});

test('codebuddy-ide writer：create 写入 index/messages，读回核心指纹一致且 cwd 可恢复', () => {
  const { root, history, ctx } = tmpData('write');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const turns = [
    { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮', T0), reasoningItem('想', T0 + 1), messageItem('assistant', '答', T0 + 2), toolCallItem('c1', 'Read', { file_path: 'a' }, T0 + 3), toolResultItem('c1', 'Read', 'ok', 'body', T0 + 4)] },
    { index: 1, role: 'user', startedAt: T0 + 10, items: [messageItem('user', '第二轮', T0 + 10), messageItem('assistant', '答2', T0 + 11)] },
  ];
  const src = makeSession({ id: 'src', variant: 'claude', title: 'IDE 写入', cwd, createdAt: T0, updatedAt: T0 + 11, model: 'm-1', turns });
  const targetId = '0123456789abcdef0123456789abcdef';
  const prov = { origin: { variant: 'claude', sessionId: 'src' }, chain: [{ variant: 'claude', sessionId: 'src', at: T0 }], tool: 'session-sync', v: 1 };
  const w = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create', provenance: prov });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.ok(fs.existsSync(path.join(w.path, 'index.json')));
  assert.ok(fs.existsSync(`${path.join(w.path, 'index.json')}.session-sync.json`), 'provenance 走 sidecar');

  const wsIndex = JSON.parse(fs.readFileSync(path.join(history, path.basename(path.dirname(w.path)), 'index.json'), 'utf8'));
  assert.equal(wsIndex.conversations.length, 1);
  assert.equal(wsIndex.conversations[0].name, 'IDE 写入');
  const convIndex = JSON.parse(fs.readFileSync(path.join(w.path, 'index.json'), 'utf8'));
  assert.equal(convIndex.requests.length, 2, '每轮一条 request');
  assert.equal(convIndex.messages.length, convIndex.requests.flatMap((r) => r.messages).length);

  const row = listSessions('codebuddy-ide', ctx, {}).sessions.find((s) => s.id === targetId);
  assert.equal(row.cwd, cwd, 'cwd 必须能从写出的 user_info 恢复');
  assert.equal(row.turns, 2);
  const back = readSession('codebuddy-ide', ctx, targetId).session;
  assert.deepEqual(back.origin, prov.origin);
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src));
});

test('codebuddy-ide writer：append 只追加新轮；target-exists 需 --force 且备份在宿主扫描根外', () => {
  const { root, history, ctx } = tmpData('write-append');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const t0 = { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮', T0), messageItem('assistant', '答', T0 + 1)] };
  const src = makeSession({ id: 'src', variant: 'claude', title: 'append', cwd, createdAt: T0, updatedAt: T0 + 1, turns: [t0] });
  const targetId = 'fedcba9876543210fedcba9876543210';
  assert.equal(codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' }).ok, true);
  assert.equal(codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' }).error, 'target-exists');

  const t1 = { index: 1, role: 'user', startedAt: T0 + 10, items: [messageItem('user', '第二轮', T0 + 10), messageItem('assistant', '答2', T0 + 11)] };
  const extended = { ...src, turns: [t0, t1], updatedAt: T0 + 11 };
  const a = codebuddyIdeWriter.write(ctx, { session: extended, targetId, mode: 'append', fromTurnIndex: 1 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(readSession('codebuddy-ide', ctx, targetId).session.turns.length, 2);

  const forced = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create', force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.ok(forced.backup && fs.existsSync(forced.backup), 'force 必须在宿主扫描根外留备份');
  assert.equal(fs.existsSync(path.join(history, path.basename(path.dirname(forced.path)), `${targetId}.bak`)), false);
  assert.equal(readSession('codebuddy-ide', ctx, targetId).session.turns.length, 1, 'force 重建后回到 sources 的轮数');
});

test('codebuddy-ide writer：relocate 移动会话目录并同步新旧工作区索引', () => {
  const { root, ctx } = tmpData('write-relocate');
  const cwdA = path.join(root, 'a');
  const cwdB = path.join(root, 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const targetId = '00112233445566778899aabbccddeeff';
  const src = makeSession({ id: 'src', variant: 'claude', title: '搬', cwd: cwdA, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const w = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create', provenance: { origin: { variant: 'claude', sessionId: 'src' }, chain: [], tool: 'session-sync', v: 1 } });
  assert.equal(w.ok, true);
  const r = codebuddyIdeWriter.relocate(ctx, { targetId, directory: cwdB });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.moved, true);
  assert.equal(fs.existsSync(w.path), false);
  assert.ok(fs.existsSync(r.path));
  const row = listSessions('codebuddy-ide', ctx, {}).sessions.find((s) => s.id === targetId);
  assert.equal(row.cwd, cwdB);
  assert.equal(readSession('codebuddy-ide', ctx, targetId).session.origin.variant, 'claude');
});

test('codebuddy-ide：read 与 list 选同一份副本（短副本排在前面也不影响）', () => {
  const { data, ctx } = tmpData('dedupe-read');
  const cwd = 'D:/work/demo';
  // 目录排序里 CodeBuddyIDE 在 VSCode 之前：旧实现 read 会命中短副本
  const short = writeConversation(data, { ide: 'CodeBuddyIDE', cwd, id: 'dup-2', name: '短副本', messages: [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ] });
  const long = writeConversation(data, { ide: 'VSCode', cwd, id: 'dup-2', name: '长副本', messages: [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答2' }] },
  ] });
  const row = listSessions('codebuddy-ide', ctx, {}).sessions.find((s) => s.id === 'dup-2');
  assert.equal(row.turns, 2);
  assert.equal(row.title, '长副本');
  const back = readSession('codebuddy-ide', ctx, 'dup-2').session;
  assert.equal(back.turns.length, 2, 'read 必须跟随 list 选更完整的副本');
  assert.equal(back.title, '长副本');
  assert.equal(back.meta.sourcePath, path.join(long.convDir, 'index.json'));
  assert.notEqual(back.meta.sourcePath, path.join(short.convDir, 'index.json'));
});

test('codebuddy-ide writer：append 目标缺失时报错，不新建半截会话', () => {
  const { root, history, ctx } = tmpData('append-missing');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const src = makeSession({ id: 'src', variant: 'claude', title: 'x', cwd, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const targetId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const r = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'append', fromTurnIndex: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /target-missing/);
  assert.equal(fs.existsSync(path.join(history, md5(cwd), targetId)), false);
});

test('codebuddy-ide writer：append 保留工作区索引既有字段/未知键，且不给新消息注入 user_info', () => {
  const { root, history, ctx } = tmpData('append-preserve');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const t0 = { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮', T0), messageItem('assistant', '答', T0 + 1)] };
  const t1 = { index: 1, role: 'user', startedAt: T0 + 10, items: [messageItem('user', '第二轮', T0 + 10), messageItem('assistant', '答2', T0 + 11)] };
  const src = makeSession({ id: 'src', variant: 'claude', title: '原标题', cwd, createdAt: T0, updatedAt: T0 + 1, turns: [t0, t1] });
  const targetId = 'b1c2d3e4f5061728394a5b6c7d8e9f01';
  assert.equal(codebuddyIdeWriter.write(ctx, { session: { ...src, turns: [t0] }, targetId, mode: 'create' }).ok, true);

  const wsFile = path.join(history, md5(cwd), 'index.json');
  const ws = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  ws.conversations[0].name = '用户在宿主里改的名字';
  ws.conversations[0].pinned = true;
  ws.extraTopLevel = 'keep-me';
  writeJson(wsFile, ws);

  const a = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'append', fromTurnIndex: 1 });
  assert.equal(a.ok, true, JSON.stringify(a));
  const after = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
  assert.equal(after.conversations.length, 1);
  assert.equal(after.conversations[0].name, '用户在宿主里改的名字', 'append 不得用源标题覆盖宿主侧名称');
  assert.equal(after.conversations[0].createdAt, ws.conversations[0].createdAt);
  assert.equal(after.conversations[0].pinned, true);
  assert.equal(after.extraTopLevel, 'keep-me');

  const convIndex = JSON.parse(fs.readFileSync(path.join(a.path, 'index.json'), 'utf8'));
  const appendedUser = convIndex.messages.filter((m) => m.role === 'user').slice(-1)[0];
  const raw = JSON.parse(fs.readFileSync(path.join(a.path, 'messages', `${appendedUser.id}.json`), 'utf8'));
  assert.equal(JSON.parse(raw.message).content.some((b) => String(b.text || '').includes('<user_info>')), false, '追加消息不该再带 Workspace Folder');
});

test('codebuddy-ide writer：append 时落点变化先搬迁，首条消息 cwd 跟着改写', () => {
  const { root, history, ctx } = tmpData('append-move');
  const cwdA = path.join(root, 'a');
  const cwdB = path.join(root, 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const t0 = { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮', T0), messageItem('assistant', '答', T0 + 1)] };
  const t1 = { index: 1, role: 'user', startedAt: T0 + 10, items: [messageItem('user', '第二轮', T0 + 10), messageItem('assistant', '答2', T0 + 11)] };
  const targetId = 'c1d2e3f40516273849a5b6c7d8e9f001';
  const src = makeSession({ id: 'src', variant: 'claude', title: '搬', cwd: cwdA, createdAt: T0, updatedAt: T0 + 1, turns: [t0, t1] });
  assert.equal(codebuddyIdeWriter.write(ctx, { session: { ...src, turns: [t0] }, targetId, mode: 'create' }).ok, true);
  const oldDir = path.join(history, md5(cwdA), targetId);

  const a = codebuddyIdeWriter.write(ctx, { session: { ...src, cwd: cwdB }, targetId, mode: 'append', fromTurnIndex: 1 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(fs.existsSync(oldDir), false, '旧落点目录应已搬走');
  assert.ok(a.path.startsWith(path.join(history, md5(cwdB))));
  assert.ok(a.warnings.some((w) => /relocated/.test(w)));
  assert.equal(readSession('codebuddy-ide', ctx, targetId).session.cwd, cwdB);
  assert.equal(readSession('codebuddy-ide', ctx, targetId).session.turns.length, 2, '追加后轮次必须是 2');
});

test('codebuddy-ide writer：create 换目录后仍按 targetId 找回，不产生第二份', () => {
  const { root, history, ctx } = tmpData('create-dup');
  const cwdA = path.join(root, 'a');
  const cwdB = path.join(root, 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const targetId = 'd1e2f3040516273849a5b6c7d8e9f012';
  const mk = (cwd) => makeSession({ id: 'src', variant: 'claude', title: 't', cwd, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  assert.equal(codebuddyIdeWriter.write(ctx, { session: mk(cwdA), targetId, mode: 'create' }).ok, true);
  const again = codebuddyIdeWriter.write(ctx, { session: mk(cwdB), targetId, mode: 'create' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'target-exists');
  assert.equal(fs.existsSync(path.join(history, md5(cwdA), targetId)), false);
  assert.ok(fs.existsSync(path.join(history, md5(cwdB), targetId)), '既有会话应已搬到新落点');
  const forced = codebuddyIdeWriter.write(ctx, { session: mk(cwdB), targetId, mode: 'create', force: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.ok(forced.backup && fs.existsSync(forced.backup));
  assert.ok(forced.backup.startsWith(path.join(root, '.session-sync', 'backups', 'codebuddy-ide')));
  assert.equal(fs.existsSync(path.join(history, md5(cwdA), targetId)), false);
});

test('codebuddy-ide writer：relocate 在宿主扫描根外留目录备份', () => {
  const { root, ctx } = tmpData('relocate-backup');
  const cwdA = path.join(root, 'a');
  const cwdB = path.join(root, 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const targetId = 'e1f2031425364758697a8b9c0d1e2f34';
  const src = makeSession({ id: 'src', variant: 'claude', title: '搬', cwd: cwdA, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  assert.equal(codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' }).ok, true);
  const r = codebuddyIdeWriter.relocate(ctx, { targetId, directory: cwdB });
  assert.equal(r.moved, true);
  assert.ok(r.backup && fs.existsSync(r.backup), 'relocate 必须先备份会话目录');
  assert.ok(r.backup.startsWith(path.join(root, '.session-sync', 'backups', 'codebuddy-ide')));
  assert.ok(fs.existsSync(path.join(r.backup, 'index.json')));
});

test('stripSystemInjections 只剥完整注入块，正文里提到标签名不受影响', () => {
  assert.equal(stripSystemInjections('讲讲 <git_status> 这个标签的用法'), '讲讲 <git_status> 这个标签的用法');
  assert.equal(stripSystemInjections('<git_status>\nOn branch main\n</git_status>\n正文'), '正文');
  assert.equal(stripSystemInjections('<user_info>\nWorkspace Folder: D:/x\n</user_info>\n\n<html>页面</html>'), '<html>页面</html>');
});

test('codebuddy-ide writer：conversation 索引损坏时仍按目录找回，不产生第二份', () => {
  const { root, history, ctx } = tmpData('unreadable');
  const cwdA = path.join(root, 'a');
  const cwdB = path.join(root, 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const targetId = 'f102132435465768798a9b0c1d2e3f45';
  const conv = path.join(history, md5(cwdA), targetId);
  fs.mkdirSync(path.join(conv, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(conv, 'index.json'), '{broken', 'utf8');
  const src = makeSession({ id: 'src', variant: 'claude', title: 't', cwd: cwdB, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const r = codebuddyIdeWriter.write(ctx, { session: src, targetId, mode: 'create' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'target-exists', '既有目录必须先被找回，不能被当成不存在');
  assert.equal(fs.existsSync(path.join(history, md5(cwdA), targetId)), false);
  assert.equal(fs.existsSync(path.join(history, md5(cwdB), targetId, 'index.json')), true);
});

test('codebuddy-ide reader：tool-result 的文本块数组归一成一段文本', () => {
  const { data, ctx } = tmpData('tool-output');
  const cwd = 'D:/work/demo';
  writeConversation(data, { cwd, name: '工具结果', messages: [
    { role: 'user', content: [{ type: 'text', text: '查一下' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Read', result: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }], isError: false }] },
  ] });
  const s = readSession('codebuddy-ide', ctx, 'conv-1').session;
  const output = s.turns.flatMap((t) => t.items).find((i) => i.kind === 'tool_result')?.output;
  assert.equal(output, '第一行\n第二行');
});

test('codebuddy-ide writer：空 cwd 拒绝；扩展数据目录不存在时 canWrite=false', () => {
  const { root, ctx } = tmpData('write-guard');
  const src = makeSession({ id: 'src', variant: 'claude', title: 'x', cwd: '', createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const r = codebuddyIdeWriter.write(ctx, { session: src, targetId: 'a'.repeat(32), mode: 'create' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cwd-required/);

  const empty = makeCtx({ home: path.join(root, 'empty'), platform: 'win32', localAppData: path.join(root, 'empty', 'AppData', 'Local'), env: {} });
  assert.equal(codebuddyIdeWriter.canWrite(empty).ok, false);
});

test('codebuddy-ide：真实本机扩展数据能列出会话（无数据时跳过）', (t) => {
  const real = path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data');
  if (!fs.existsSync(real)) return t.skip('本机没有 CodeBuddyExtension 数据');
  const ctx = makeCtx({ home: os.homedir(), localAppData: process.env.LOCALAPPDATA, env: { ...process.env, CODEBUDDY_EXTENSION_DATA: real } });
  const r = listSessions('codebuddy-ide', ctx, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  if (r.sessions.length === 0) return t.skip('真实扩展目录里暂无会话');
  assert.ok(r.sessions.some((s) => s.title && s.title !== 'untitled'), '标题应来自宿主索引');
});
