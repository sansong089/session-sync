// M48 测试：CodeBuddy Code（CLI）
//
// 真机取证（2026-10-29，@tencent-ai/codebuddy-code 2.178.1 实跑）：
//   <root>/projects/<compressPath(cwd)>/<sessionId>.jsonl，一行一条历史项：
//   {id,parentId?,timestamp(ms),type:'message',role,content:[block],sessionId,cwd}
//   标题事实行：custom-title / ai-title / topic
//   宿主 `codebuddy -r <id>` 能识别我们写出的会话（本机以未登录的 auth 报错当「已加载」的 oracle）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, detectHost, VARIANTS } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { codebuddyReader } from '../src/readers/codebuddy.mjs';
import { codebuddyWriter, slugForCodebuddy } from '../src/writers/codebuddy.mjs';
import { makeSession, messageItem, reasoningItem, toolCallItem, toolResultItem, sessionCoreFingerprints } from '../src/ir.mjs';

const T0 = 1791484221000;

function tmpRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m48-${tag}-`));
  const cfg = path.join(root, '.codebuddy');
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  const ctx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { CODEBUDDY_CONFIG_DIR: cfg } });
  return { root, cfg, ctx };
}

// 与真机样本同形的行（消息项 + 标题事实 + 机械事件）
function writeHostSession(cfg, cwd, id, { title = '' } = {}) {
  const dir = path.join(cfg, 'projects', slugForCodebuddy(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { id: 'u-1', timestamp: T0, type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮问题' }], sessionId: id, cwd },
    { timestamp: T0 + 1, type: 'file-history-snapshot', messageId: 'u-1', isSnapshotUpdate: false, snapshot: { messageId: 'u-1', trackedFileBackups: {} }, cwd },
    {
      id: 'a-1',
      parentId: 'u-1',
      timestamp: T0 + 100,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '想一想' },
        { type: 'output_text', text: '第一轮回答' },
        { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } },
      ],
      sessionId: id,
      cwd,
    },
    { id: 'u-2', parentId: 'a-1', timestamp: T0 + 200, type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'file body' }] }], sessionId: id, cwd },
    { id: 'u-3', parentId: 'u-2', timestamp: T0 + 300, type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮问题' }], sessionId: id, cwd },
    { id: 'a-2', parentId: 'u-3', timestamp: T0 + 400, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二轮回答' }], sessionId: id, cwd },
  ];
  if (title) rows.push({ type: 'custom-title', customTitle: title, timestamp: T0 + 500, sessionId: id });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

test('codebuddy reader：按宿主 JSONL 读标题/轮次/cwd，tool_result 归上一轮', () => {
  const { cfg, ctx } = tmpRoot('read');
  const cwd = 'D:\\work\\demo';
  writeHostSession(cfg, cwd, 'cb-1', { title: '宿主标题' });
  const row = listSessions('codebuddy', ctx, {}).sessions.find((s) => s.id === 'cb-1');
  assert.ok(row, '会话必须被列出');
  assert.equal(row.title, '宿主标题');
  assert.equal(row.turns, 2, '两轮用户输入（tool_result 不开新轮）');
  assert.equal(row.cwd, cwd);
  const s = readSession('codebuddy', ctx, 'cb-1').session;
  assert.equal(s.turns.length, 2);
  const items = s.turns[0].items.map((i) => i.kind);
  assert.ok(items.includes('tool_call') && items.includes('tool_result'));
});

test('codebuddy reader：标题优先级 custom > ai > topic；子代理目录不进主列表', () => {
  const { cfg, ctx } = tmpRoot('title');
  const cwd = 'D:\\work\\demo';
  const file = writeHostSession(cfg, cwd, 'cb-title');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'AI 标题', timestamp: T0 + 600, sessionId: 'cb-title' })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'topic', topic: '主题标题', timestamp: T0 + 700, sessionId: 'cb-title' })}\n`);
  assert.equal(listSessions('codebuddy', ctx, {}).sessions[0].title, 'AI 标题');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: '自定义标题', timestamp: T0 + 800, sessionId: 'cb-title' })}\n`);
  assert.equal(listSessions('codebuddy', ctx, {}).sessions[0].title, '自定义标题');

  const sub = path.join(path.dirname(file), 'cb-title', 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, `${JSON.stringify({ id: 'u', timestamp: T0, type: 'message', role: 'user', content: [{ type: 'input_text', text: '子代理' }], sessionId: 'agent-x', cwd })}\n`);
  assert.equal(listSessions('codebuddy', ctx, {}).sessions.filter((s) => s.id === 'agent-x').length, 0);
});

test('codebuddy slug：与宿主 compressPath 等价（冒号/斜杠→-、折叠、大小写保留）', () => {
  assert.equal(slugForCodebuddy('D:\\00-work\\code\\demo'), 'D-00-work-code-demo');
  assert.equal(slugForCodebuddy('c:\\Users\\you\\WorkBuddy AI\\x'), 'c-Users-you-WorkBuddy AI-x');
  const long = `D:\\${'a'.repeat(300)}`;
  const slug = slugForCodebuddy(long);
  assert.ok(Buffer.byteLength(slug, 'utf8') <= 180 + 1 + 7, `长路径应截到 180 字节并带哈希后缀：${Buffer.byteLength(slug, 'utf8')}`);
  assert.match(slug, /-[0-9a-z]+$/);
});

test('codebuddy writer：create + append 往返核心指纹一致，provenance 走 sidecar', () => {
  const { cfg, ctx } = tmpRoot('write');
  const cwd = path.join(path.dirname(cfg), 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const turns = [
    { index: 0, role: 'user', startedAt: T0, items: [messageItem('user', '第一轮问题', T0), reasoningItem('想一想', T0 + 50), messageItem('assistant', '第一轮回答', T0 + 100), toolCallItem('call_a', 'Read', { file_path: 'a.txt' }, T0 + 150), toolResultItem('call_a', 'Read', 'ok', 'file body', T0 + 200)] },
    { index: 1, role: 'user', startedAt: T0 + 300, items: [messageItem('user', '第二轮问题', T0 + 300), messageItem('assistant', '第二轮回答', T0 + 400)] },
  ];
  const session = makeSession({ id: 'src', variant: 'claude', title: 'CodeBuddy 写入', cwd, createdAt: T0, updatedAt: T0 + 400, turns });
  const targetId = '01a18651-7777-7888-8999-aaaaaaaaaaaa';
  const prov = { origin: { variant: 'claude', sessionId: 'src' }, chain: [{ variant: 'claude', sessionId: 'src', at: T0 }], tool: 'session-sync', v: 1 };
  const w = codebuddyWriter.write(ctx, { session, targetId, mode: 'create', provenance: prov });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.ok(fs.existsSync(w.path));
  const sidecar = `${w.path}.session-sync.json`;
  assert.ok(fs.existsSync(sidecar), 'provenance 必须写 sidecar');
  const first = readSession('codebuddy', ctx, targetId).session;
  assert.ok(first.origin, '读回必须恢复 provenance');
  assert.deepEqual(sessionCoreFingerprints(first), sessionCoreFingerprints(session));

  const third = { index: 2, role: 'user', startedAt: T0 + 500, items: [messageItem('user', '第三轮问题', T0 + 500), messageItem('assistant', '第三轮回答', T0 + 600)] };
  const extended = { ...session, turns: [...turns, third], updatedAt: T0 + 600 };
  const a = codebuddyWriter.write(ctx, { session: extended, targetId, mode: 'append', fromTurnIndex: 2, provenance: prov });
  assert.equal(a.ok, true, JSON.stringify(a));
  const back = readSession('codebuddy', ctx, targetId).session;
  assert.equal(back.turns.length, 3);
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(extended));
});

test('codebuddy writer：relocate 时 sidecar 跟着走，provenance 不丢', () => {
  const { cfg, ctx } = tmpRoot('relocate');
  const cwdA = path.join(path.dirname(cfg), 'a');
  const cwdB = path.join(path.dirname(cfg), 'b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const targetId = '01a18651-7777-7888-8999-eeeeeeeeeeee';
  const prov = { origin: { variant: 'claude', sessionId: 'src' }, chain: [{ variant: 'claude', sessionId: 'src', at: T0 }], tool: 'session-sync', v: 1 };
  const session = makeSession({ id: 'src', variant: 'claude', title: '搬迁', cwd: cwdA, createdAt: T0, updatedAt: T0 + 100, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const w = codebuddyWriter.write(ctx, { session, targetId, mode: 'create', provenance: prov });
  assert.equal(w.ok, true, JSON.stringify(w));
  const oldSidecar = `${w.path}.session-sync.json`;
  assert.ok(fs.existsSync(oldSidecar));

  const r = codebuddyWriter.relocate(ctx, { targetId, directory: cwdB });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.moved);
  assert.equal(fs.existsSync(w.path), false, '旧 slug 里的正文应搬走');
  assert.equal(fs.existsSync(oldSidecar), false, '旧 slug 里的 sidecar 应搬走');
  assert.ok(fs.existsSync(`${r.path}.session-sync.json`), '新 slug 必须有 sidecar');
  const back = readSession('codebuddy', ctx, targetId).session;
  assert.deepEqual(back.origin, prov.origin, '搬迁后 provenance 必须还在');
});

test('codebuddy writer：目标读不懂时中止，一字不改', () => {
  const { cfg, ctx } = tmpRoot('guarded');
  const cwd = path.join(path.dirname(cfg), 'work2');
  fs.mkdirSync(cwd, { recursive: true });
  const targetId = '01a18651-7777-7888-8999-bbbbbbbbbbbb';
  const dir = path.join(cfg, 'projects', slugForCodebuddy(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${targetId}.jsonl`);
  const dirty = '{"broken":\n';
  fs.writeFileSync(file, dirty);
  const session = makeSession({ id: 'src', variant: 'claude', title: 'x', cwd, createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  const r = codebuddyWriter.write(ctx, { session, targetId, mode: 'append', fromTurnIndex: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /unreadable-target/);
  assert.equal(fs.readFileSync(file, 'utf8'), dirty, '坏目标必须逐字节不变');
});

test('codebuddy reader：空 cwd 的会话归非项目（导入时需要 --cwd）', () => {
  const { cfg, ctx } = tmpRoot('nocwd');
  const dir = path.join(cfg, 'projects', 'unknown');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cb-nocwd.jsonl'), `${JSON.stringify({ id: 'u', timestamp: T0, type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }], sessionId: 'cb-nocwd' })}\n`);
  const row = listSessions('codebuddy', ctx, {}).sessions.find((s) => s.id === 'cb-nocwd');
  assert.equal(row.scope, 'none');
});

test('codebuddy writer：空 cwd 直接拒绝，避免落进调用目录', () => {
  const { cfg, ctx } = tmpRoot('write-nocwd');
  const session = makeSession({ id: 'src', variant: 'claude', title: 'x', cwd: '', createdAt: T0, updatedAt: T0, turns: [{ index: 0, role: 'user', startedAt: T0, items: [messageItem('user', 'hi', T0)] }] });
  assert.equal(slugForCodebuddy(''), null);
  const r = codebuddyWriter.write(ctx, { session, targetId: '01a18651-7777-7888-8999-dddddddddddd', mode: 'create' });
  assert.equal(r.ok, false);
  assert.match(r.error, /cwd-required/);
  assert.equal(fs.readdirSync(path.join(cfg, 'projects')).length, 0, '空 cwd 不能造目录');
});

test('codebuddy reader：字符串 content 的 user 行也计轮', () => {
  const { cfg, ctx } = tmpRoot('strcontent');
  const cwd = 'D:\\work\\demo';
  const dir = path.join(cfg, 'projects', slugForCodebuddy(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cb-str.jsonl'), `${JSON.stringify({ id: 'u', timestamp: T0, type: 'message', role: 'user', content: '字符串正文', sessionId: 'cb-str', cwd })}\n`);
  const row = listSessions('codebuddy', ctx, {}).sessions.find((s) => s.id === 'cb-str');
  assert.equal(row.turns, 1);
  assert.equal(readSession('codebuddy', ctx, 'cb-str').session.turns.length, 1);
});

test('codebuddy 与 WorkBuddy 的 CODEBUDDY_CONFIG_DIR 隔离：.codebuddy 才认', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m48-env-'));
  const wbDir = path.join(root, '.workbuddy');
  const cbDir = path.join(root, '.codebuddy');
  fs.mkdirSync(path.join(wbDir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(cbDir, 'projects'), { recursive: true });

  const wbCtx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData'), env: { CODEBUDDY_CONFIG_DIR: wbDir } });
  assert.equal(detectHost(wbCtx).variant, 'workbuddy-cn');
  assert.equal(VARIANTS.codebuddy.readPaths(wbCtx)[0].path, path.join(root, '.codebuddy', 'projects'), 'WorkBuddy 的根不能被当成 CodeBuddy');

  const cbCtx = makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData'), env: { CODEBUDDY_CONFIG_DIR: cbDir } });
  assert.equal(detectHost(cbCtx).variant, 'codebuddy');
  assert.equal(VARIANTS.codebuddy.readPaths(cbCtx)[0].path, path.join(cbDir, 'projects'));
});
