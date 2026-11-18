// M11 测试：读取半径补齐（codex `.jsonl.zst` + 归档目录 / qoder CLI jsonl 正文 / cline 三代路径）
// fixtures 全部在临时目录构造，不触碰真实数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, VARIANTS } from '../src/hosts.mjs';
import { codexReader } from '../src/readers/codex.mjs';
import { claudeReader } from '../src/readers/claude.mjs';
import { createQoderReader } from '../src/readers/qoder.mjs';
import { createClineFamilyReader } from '../src/readers/cline-family.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-${name}-`));
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeJsonlZst(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')));
}

const codexRows = (id, cwd) => [
  { timestamp: '2026-10-14T00:03:14.687Z', type: 'session_meta', payload: { session_id: id, cwd, timestamp: '2026-10-14T00:03:14.017Z' } },
  { timestamp: '2026-10-14T00:03:21.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修一下 bug' }] } },
  { timestamp: '2026-10-14T00:03:39.244Z', type: 'response_item', payload: { type: 'reasoning', summary: [], content: null } },
  { timestamp: '2026-10-14T00:03:40.159Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_9', name: 'exec', input: '{"cmd":"ls"}' } },
  { timestamp: '2026-10-14T00:03:40.300Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '改好了' }] } },
];

// ---------- Codex：.jsonl.zst ----------
test('codex reader：.jsonl.zst 与 .jsonl 解出等价会话', () => {
  const root = tmpRoot('codex-zst');
  const plainId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const zstId = 'bbbbbbbb-2222-4222-8222-222222222222';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T08-03-14-${plainId}.jsonl`), codexRows(plainId, 'C:/work/plain'));
  writeJsonlZst(path.join(root, '.codex', 'sessions', '2026', '10', '15', `rollout-2026-10-15T08-03-14-${zstId}.jsonl.zst`), codexRows(zstId, 'C:/work/zst'));

  const ctx = ctxFor(root);
  const list = codexReader.list(ctx, {});
  assert.equal(list.length, 2, '一条明文 + 一条 zstd，都应被索引');
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.ok(byId[plainId], `明文会话 id 应解析为 uuid，实际: ${list.map((s) => s.id).join(',')}`);
  assert.ok(byId[zstId], `zst 会话 id 应去掉 .jsonl.zst 后缀解析为 uuid，实际: ${list.map((s) => s.id).join(',')}`);
  assert.equal(byId[zstId].cwd, 'C:/work/zst');
  assert.equal(byId[zstId].title, '修一下 bug');
  assert.equal(byId[zstId].turns, 1);

  const a = codexReader.read(ctx, plainId);
  const b = codexReader.read(ctx, zstId);
  assert.ok(b, 'read() 必须能按 id 取到 zst 会话');
  assert.deepEqual(
    b.turns.map((t) => t.items.map((i) => [i.kind, i.text ?? i.input ?? i.output ?? null])),
    a.turns.map((t) => t.items.map((i) => [i.kind, i.text ?? i.input ?? i.output ?? null])),
  );
  assert.equal(b.cwd, 'C:/work/zst');
});

test('codex reader：子代理线程用自己的 thread id，不得复用父会话 session_id', () => {
  const root = tmpRoot('codex-subagent');
  const parentId = 'eeeeeeee-5555-4555-8555-555555555555';
  const sub1 = '019f4ab5-08a2-71f2-b6a2-0f7a6eda4c16';
  const sub2 = '019f4ab5-1cff-7e23-bdbb-3f30f80170fc';
  const meta = (threadId, sessionId) => ({
    timestamp: '2026-07-10T00:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: sessionId, id: threadId, timestamp: '2026-07-10T00:00:00.000Z', cwd: 'D:/work/x' },
  });
  writeJsonlZst(path.join(root, '.codex', 'sessions', '2026', '07', '03', `rollout-2026-07-03T09-31-54-${parentId}.jsonl.zst`), [
    meta(parentId, parentId),
    ...codexRows(parentId, 'D:/work/x'),
  ]);
  // 宿主对 subagent 线程写的是「父的 session_id + 自己的 id」
  writeJsonlZst(path.join(root, '.codex', 'sessions', '2026', '07', '10', `rollout-2026-07-10T14-26-51-${sub1}.jsonl.zst`), [meta(sub1, parentId)]);
  writeJsonlZst(path.join(root, '.codex', 'sessions', '2026', '07', '10', `rollout-2026-07-10T14-26-56-${sub2}.jsonl.zst`), [meta(sub2, parentId)]);

  const ctx = ctxFor(root);
  const list = codexReader.list(ctx, {});
  const ids = list.map((s) => s.id).sort();
  assert.equal(list.length, 3);
  assert.deepEqual(ids, [parentId, sub1, sub2].sort(), '三条线程必须是三个不同 id（否则 list 出现重复 id，导入会互相覆盖）');
  assert.ok(codexReader.read(ctx, sub1), '按 thread id 必须能读回子代理会话');
});

test('codex reader：同一 thread 的多段 rollout（续跑分片）合并成一条会话', () => {
  const root = tmpRoot('codex-segments');
  const threadId = 'ffffffff-6666-4666-8666-666666666666';
  const seg = (id) => ({
    timestamp: '2026-10-09T06:53:34.620Z',
    type: 'session_meta',
    payload: { session_id: threadId, id: threadId, timestamp: '2026-10-09T06:53:34.000Z', cwd: 'D:/work/x' },
  });
  // 宿主续跑会新开一个 rollout-<时间>-<thread>_<新uuid> 文件，session_meta 里仍是同一个 thread id
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '09', `rollout-2026-10-09T14-53-28-${threadId}.jsonl`), [
    seg(),
    { timestamp: '2026-10-09T06:54:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一段的问题' }] } },
    { timestamp: '2026-10-09T06:54:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一段回答' }] } },
  ]);
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '09', `rollout-2026-10-09T16-13-12-${threadId}_01a11fb9-2f9f-7c03-a879-73e395633d74.jsonl`), [
    seg(),
    { timestamp: '2026-10-09T08:13:16.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二段的问题' }] } },
    { timestamp: '2026-10-09T08:13:20.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二段回答' }] } },
  ]);

  const ctx = ctxFor(root);
  const list = codexReader.list(ctx, {});
  assert.equal(list.length, 1, `同一 thread 的分片必须合并成一条，实际 ${list.length} 条: ${list.map((s) => s.id).join(',')}`);
  assert.equal(list[0].id, threadId);
  assert.equal(list[0].turns, 2, '两段各一个用户轮次');
  assert.equal(list[0].title, '第一段的问题', '标题取最早分片的首条用户消息');

  const s = codexReader.read(ctx, threadId);
  assert.ok(s, '按 thread id 必须能读到合并后的会话');
  assert.equal(s.turns.length, 2, '两段各一个 turn');
  assert.deepEqual(
    s.turns.flatMap((t) => t.items.map((i) => i.text)),
    ['第一段的问题', '第一段回答', '第二段的问题', '第二段回答'],
  );
});

test('codex reader：archived_sessions 归档行出现在 list 且带 archived 标记', () => {
  const root = tmpRoot('codex-archived');
  const liveId = 'cccccccc-3333-4333-8333-333333333333';
  const archId = 'dddddddd-4444-4444-8444-444444444444';
  writeJsonl(path.join(root, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T08-03-14-${liveId}.jsonl`), codexRows(liveId, 'C:/work/live'));
  writeJsonlZst(path.join(root, '.codex', 'archived_sessions', `rollout-2026-06-09T15-13-17-${archId}.jsonl.zst`), codexRows(archId, 'C:/work/arch'));

  const ctx = ctxFor(root);
  const list = codexReader.list(ctx, {});
  assert.equal(list.length, 2, '归档会话同样要能被读到（用于存在性判定，防重复创建）');
  const live = list.find((s) => s.id === liveId);
  const arch = list.find((s) => s.id === archId);
  assert.ok(arch, `archived_sessions 下的会话必须被索引，实际: ${list.map((s) => s.id).join(',')}`);
  assert.equal(arch.archived, true, '归档行必须带 archived:true 标记，供 planImport 过滤');
  assert.equal(live.archived, undefined);

  // hosts 侧：归档根必须登记（writer 的 findExistingByTargetId 依赖 readPaths）
  const dirs = VARIANTS.codex.readPaths(ctxFor(tmpRoot('codex-archived-paths'))).filter((x) => x.kind === 'dir').map((x) => x.path);
  assert.ok(dirs.some((d) => d.endsWith('archived_sessions')), `codex readPaths 必须登记 archived_sessions，实际: ${dirs.join(' | ')}`);
});

// ---------- Claude / Qoder：subagents 侧链不计为会话 ----------
const claudeLikeRows = (id, cwd, userText) => [
  { type: 'workspace-directories', sessionId: id, directories: [cwd] },
  { type: 'runtime-config', sessionId: id, model: 'auto', timestamp: 1782963491476 },
  { type: 'user', timestamp: '2026-07-02T03:38:20.368Z', sessionId: id, cwd, message: { role: 'user', content: [{ type: 'text', text: userText }] } },
  { type: 'assistant', timestamp: '2026-07-02T03:38:27.231Z', sessionId: id, cwd, message: { role: 'assistant', model: 'auto', content: [{ type: 'thinking', thinking: '先读一下' }, { type: 'text', text: '好的' }] } },
];

test('claude reader：subagents/ 下的侧链 transcript 不算独立会话', () => {
  const root = tmpRoot('claude-side');
  const id = '99999999-1111-4111-8111-111111111111';
  writeJsonl(path.join(root, '.claude', 'projects', 'd--work-demo', `${id}.jsonl`), claudeLikeRows(id, 'D:/work/demo', '主会话的问题'));
  writeJsonl(
    path.join(root, '.claude', 'projects', 'd--work-demo', id, 'subagents', 'agent-a1b2.jsonl'),
    claudeLikeRows('agent-a1b2', 'D:/work/demo', '子代理的内部问答'),
  );

  const ctx = ctxFor(root);
  const list = claudeReader.list(ctx, {});
  assert.equal(list.length, 1, `subagents 目录必须跳过（现场 74 个文件里 41 个是侧链），实际: ${list.map((s) => s.id).join(',')}`);
  assert.equal(list[0].id, id);
  assert.equal(claudeReader.read(ctx, 'agent-a1b2'), null, '侧链 id 不该能被当成会话读出来');
});

test('qoder reader：CLI 明文 jsonl 正文可读（local.db 是密文，不是唯一来源）', () => {
  const root = tmpRoot('qoder-cli');
  const bucketId = '2a718acb-2f03-43c9-b314-4275157f2f85';
  const projectId = '3b718acb-2f03-43c9-b314-4275157f2f86';
  writeJsonl(
    path.join(root, '.qoder-cn', 'projects', 'c--users-you-documents-qodercn-2026-10-14-chat-2', `${bucketId}.jsonl`),
    claudeLikeRows(bucketId, 'C:\\Users\\you\\Documents\\QoderCN\\2026-10-14\\chat-2', '非项目桶里的问题'),
  );
  writeJsonl(
    path.join(root, '.qoder-cn', 'projects', 'd--00-demo-app', `${projectId}.jsonl`),
    claudeLikeRows(projectId, 'D:\\00-demo-app', '项目里的问题'),
  );
  writeJsonl(
    path.join(root, '.qoder-cn', 'projects', 'd--00-demo-app', projectId, 'subagents', 'agent-x.jsonl'),
    claudeLikeRows('agent-x', 'D:\\00-demo-app', '侧链不该出现在列表'),
  );

  const ctx = ctxFor(root);
  const reader = createQoderReader({ variant: 'qoder-cn' });
  assert.equal(reader.available(ctx), true, '只有 CLI jsonl、没有 local.db 时也算可用');
  const list = reader.list(ctx, {});
  assert.equal(list.length, 2, `两条 CLI 会话都要列出，实际: ${list.map((s) => s.id).join(',')}`);
  const found = list.find((s) => s.id === bucketId);
  assert.ok(found, '非项目桶会话必须能列出');
  assert.equal(String(found.cwd).replace(/\//g, '\\').toLowerCase(), 'c:\\users\\you\\documents\\qodercn\\2026-10-14\\chat-2');
  assert.equal(found.source, 'cli-jsonl', '摘要要标明这条来自 CLI jsonl 而非密文库');

  const s = reader.read(ctx, bucketId);
  assert.ok(s, 'read() 必须能从 jsonl 取正文');
  assert.equal(s.turns.length, 1);
  assert.deepEqual(
    s.turns[0].items.map((i) => [i.kind, i.text]),
    [['message', '非项目桶里的问题'], ['reasoning', '先读一下'], ['message', '好的']],
  );
  assert.equal(s.variant, 'qoder-cn');
  assert.equal(s.origin, null, 'CLI 原生会话不是导入产物，origin 必须为空（落点/身份判定依赖这一点）');
});

test('qoder cache/projects 是派生缓存，不重复列为会话', () => {
  const root = tmpRoot('qoder-cache');
  const projectId = '3b718acb-2f03-43c9-b314-4275157f2f86';
  const projectsDir = path.join(root, '.qoder-cn', 'projects');
  writeJsonl(
    path.join(projectsDir, 'd--00-demo-app', `${projectId}.jsonl`),
    claudeLikeRows(projectId, 'D:\\00-demo-app', '项目里的问题'),
  );
  // 现网形态：<cliRoot>/cache/projects/<slug>/conversation-history/<task>/<task>.jsonl
  // 实测 9 条里 8 条与 projects/ 下的会话首条用户消息相同（同一份历史的派生缓存，换了个 id）
  writeJsonl(path.join(root, '.qoder-cn', 'cache', 'projects', 'd--00-demo-app', 'conversation-history', 'taskId-1', 'taskId-1.jsonl'), [
    { role: 'user', message: { content: [{ type: 'text', text: '项目里的问题' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '回答' }] } },
  ]);

  const ctx = ctxFor(root);
  const reader = createQoderReader({ variant: 'qoder-cn' });
  const list = reader.list(ctx, {});
  assert.deepEqual(list.map((s) => s.id), [projectId], `派生缓存不得作为独立会话列出（否则同一会话裂成两条），实际: ${list.map((s) => s.id).join(',')}`);

  const cnPaths = VARIANTS['qoder-cn'].readPaths(ctx);
  const cli = cnPaths.filter((x) => x.role === 'cliProjects').map((x) => x.path);
  assert.ok(cli.every((p) => !/[\\/]cache[\\/]/.test(p)), `cliProjects 角色不能包含 cache 目录，实际: ${cli.join(' | ')}`);
  assert.ok(cnPaths.some((x) => /[\\/]cache[\\/]/.test(x.path)), 'cache 路径仍要登记（供 detect/取证），只是不作为会话来源');
});

test('qoder 变体根硬隔离：不跟随 QODER_CONFIG_DIR 串到另一版数据', () => {
  const root = tmpRoot('qoder-isolate');
  const ctx = ctxFor(root, { QODER_CONFIG_DIR: path.join(root, 'somewhere-else') });
  const cn = VARIANTS['qoder-cn'].readPaths(ctx).map((x) => x.path);
  const intl = VARIANTS['qoder-intl'].readPaths(ctx).map((x) => x.path);
  assert.ok(cn.some((p) => p === path.join(root, '.qoder-cn', 'projects')), `cn 必须固定读 .qoder-cn/projects，实际: ${cn.join(' | ')}`);
  assert.ok(!cn.some((p) => p.includes('somewhere-else')), 'cn 不得跟随 QODER_CONFIG_DIR');
  assert.ok(intl.some((p) => p === path.join(root, '.qoder', 'projects')), `intl 必须固定读 .qoder/projects，实际: ${intl.join(' | ')}`);
  assert.ok(!intl.some((p) => p.includes('.qoder-cn')), 'intl 不得读到 cn 根');
});

// ---------- Cline：CLI 侧三代落点（data/tasks / data/sessions）----------
function writeClineTask(dir, ts) {
  writeJson(path.join(dir, 'api_conversation_history.json'), [
    { role: 'user', content: [{ type: 'text', text: '<task>帮我改下登录页</task><environment_details>x</environment_details>' }], ts },
    { role: 'assistant', content: [{ type: 'text', text: '改好了' }], ts: ts + 1000 },
  ]);
  writeJson(path.join(dir, 'ui_messages.json'), [{ ts, type: 'say', say: 'task', text: '帮我改下登录页' }]);
  writeJson(path.join(dir, 'task_metadata.json'), { model: { modelId: 'glm-5' } });
}

// 现网实测 <id>.messages.json 与 Claude Code 同构：thinking 字段名就是 thinking，
// tool_result.content 可以是任意 JSON 结构（cline 自己家的工具回执形态）
function writeClineSession(dir, id, cwd) {
  writeJson(path.join(dir, `${id}.json`), {
    version: 1,
    session_id: id,
    source: 'cli',
    started_at: '2026-08-04T08:00:00.000Z',
    ended_at: '2026-08-04T09:00:00.000Z',
    status: 'completed',
    model: 'z-ai/glm-5.3-flash',
    cwd,
    workspace_root: cwd,
    prompt: `<user_input mode="act">${id} 的任务描述</user_input>`,
    metadata: { title: `${id} 的会话标题` },
    messages_path: path.join(dir, `${id}.messages.json`),
  });
  writeJson(path.join(dir, `${id}.messages.json`), {
    version: 1,
    sessionId: id,
    agent: 'lead',
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '<user_input mode="act">review 未提交代码</user_input>' }], ts: 1785824646227 },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看任务情况' },
          { type: 'text', text: '我来 review' },
          { type: 'tool_use', id: 't1', name: 'run_commands', input: { commands: ['git status'] } },
        ],
        ts: 1785824650000,
      },
      { id: 'm3', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', name: 'run_commands', content: [{ query: 'git status', result: 'clean', success: true }] }], ts: 1785824652000 },
    ],
  });
}

test('cline reader：CLI 侧 data/tasks 与 data/sessions 都在读取半径内', () => {
  const root = tmpRoot('cline-cli');
  writeClineTask(path.join(root, '.cline', 'data', 'tasks', '1766291178276'), 1766291178276);
  writeClineSession(path.join(root, '.cline', 'data', 'sessions', '1785824485225_px5yk'), '1785824485225_px5yk', 'D:\\00-demo-app');

  const ctx = ctxFor(root);
  const reader = createClineFamilyReader({ variant: 'cline' });
  assert.equal(reader.available(ctx), true, '只有 ~/.cline/data 时也算可用');
  const ids = reader.list(ctx, {}).map((s) => s.id).sort();
  assert.deepEqual(ids, ['1766291178276', '1785824485225_px5yk'], `两代落点的会话都要列出，实际: ${ids.join(',')}`);

  const row = reader.list(ctx, {}).find((s) => s.id === '1785824485225_px5yk');
  assert.equal(row.cwd, 'D:\\00-demo-app', '二代 session 的 cwd 必须进摘要（落点判定要用）');
  assert.equal(row.turns, 1, 'tool_result 不开新轮次');
});

test('cline reader：data/sessions 消息流按 Claude 同构解析，正文与工具回执齐全', () => {
  const root = tmpRoot('cline-sessions');
  writeClineSession(path.join(root, '.cline', 'data', 'sessions', '1788252431693_t2kzj'), '1788252431693_t2kzj', 'D:\\00-demo-app');

  const ctx = ctxFor(root);
  const s = createClineFamilyReader({ variant: 'cline' }).read(ctx, '1788252431693_t2kzj');
  assert.ok(s, 'read() 必须能从 data/sessions 取正文');
  assert.equal(s.cwd, 'D:\\00-demo-app');
  assert.equal(s.title, '1788252431693_t2kzj 的会话标题');
  assert.equal(s.turns.length, 1);
  assert.deepEqual(
    s.turns[0].items.map((i) => i.kind),
    ['message', 'reasoning', 'message', 'tool_call', 'tool_result'],
  );
  assert.equal(s.turns[0].items[0].text, 'review 未提交代码', '<user_input> 包装要剥掉只留正文');
  assert.equal(s.turns[0].items[4].callId, 't1');
});
