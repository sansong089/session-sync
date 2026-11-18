// M81 测试：豆包（Doubao）agent 模式只读接入
//
// 夹具按真机样本形状重建（agent-storage.md §22）：assignment.md 的 `## [ISO] 需求` 块、
// trajectory.jsonl 的 {role, content, tool_calls?, tool_call_id?} 行、多 agent 角色目录。
// 重点覆盖：首轮只在 assignment 不丢、次轮两边都有不重、arguments 不二次序列化、
// tool 行 id→name 回填与报错推断、多 agent 归一、空 agent / 空轨迹跳过、scope=none。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, VARIANTS, doubaoProfiles, doubaoSessionRoots } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { classifySource } from '../src/placement.mjs';
import { NON_PROJECT_BUCKET } from '../src/placement.mjs';
import { ACCOUNT_MODEL } from '../src/accounts.mjs';

const tmpHome = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `ss-m81-${name}-`));
const ctxFor = (home) =>
  makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {} });
const userDataDir = (home) => path.join(home, 'AppData', 'Local', 'Doubao', 'User Data');
const sessionsDir = (home) => path.join(userDataDir(home), 'Default', '.doubao', 'agent_mode', 'workspace', '.sessions');

function seedProfile(home, workspaceMap = {}, profiles = ['Default']) {
  const ud = userDataDir(home);
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'Local State'), JSON.stringify({ profile: { info_cache: Object.fromEntries(profiles.map((p) => [p, {}])) } }));
  for (const profile of profiles) {
    const kv = {};
    for (const [chatId, dir] of Object.entries(workspaceMap)) kv[`general-agent:new-chat-workspace:${chatId}`] = dir;
    // 真机形态：saman.local_storage_for_web.home 是**字符串化**的 KV JSON
    fs.mkdirSync(path.join(ud, profile), { recursive: true });
    fs.writeFileSync(path.join(ud, profile, 'Preferences'), JSON.stringify({ saman: { local_storage_for_web: { home: JSON.stringify(kv) } } }));
  }
}

function writeAgent(home, chatId, agentId, { role = '', assignedBy = 'user', blocks = [], trajectory = [] } = {}) {
  const system = path.join(sessionsDir(home), chatId, 'agents', agentId, 'system');
  fs.mkdirSync(system, { recursive: true });
  const head = `# Assignment\n- Agent ID: ${agentId}\n- Role: ${role}\n- Assigned by: ${assignedBy}\n- Created: 2026-11-02T10:17:50.408225915Z\n\n> append-only: 每个 turn 的需求按时间戳追加在下方，最新在末尾。\n`;
  const body = blocks.map((b) => `## [${b.ts}] 需求\n${b.text}`).join('\n');
  fs.writeFileSync(path.join(system, 'assignment.md'), head + (body ? `${body}\n` : ''));
  fs.writeFileSync(path.join(system, 'trajectory.jsonl'), trajectory.map((r) => JSON.stringify(r)).join('\n') + (trajectory.length ? '\n' : ''));
  return system;
}

// 样本 B（真机形状）：4 个真实需求，首轮只在 assignment；第 3 轮含报错 / 续试 / 并行工具调用
const CHAT = '38451198482893826';
const T1 = '2026-11-02T10:17:50.408225915Z';
const T2 = '2026-11-02T10:18:08.038405029Z';
const T3 = '2026-11-02T10:21:27.593552652Z';
const T4 = '2026-11-02T10:25:09.666666702Z';

function seedSampleB(home) {
  seedProfile(home, { [CHAT]: 'C:\\Users\\tester\\Doubao\\chats\\2026-11-02\\new-chat' });
  writeAgent(home, CHAT, 'm_testMain', {
    role: 'main',
    blocks: [
      { ts: T1, text: '什么模型' },
      { ts: T2, text: '你可以编程吗？' },
      { ts: T3, text: '这个项目是干什么的？' },
      { ts: T4, text: '并发多个agent探索项目' },
      // 宿主注入块：剥完为空，不算一轮
      { ts: T4, text: '<system-reminder>\n<current-state>organizer has completed its task.</current-state>\n</system-reminder>' },
    ],
    trajectory: [
      { role: 'assistant', content: '我是豆包办公助手，专注于帮你完成各类办公任务。' },
      { role: 'user', content: '你可以编程吗？' },
      { role: 'assistant', content: '可以的。' },
      { role: 'user', content: '这个项目是干什么的？' },
      {
        role: 'assistant',
        content: '我先看一下项目目录里有什么内容。',
        tool_calls: [{ id: 'call_bash', type: 'function', function: { name: 'Bash', arguments: { command: 'Get-ChildItem -Force' } } }],
      },
      { role: 'tool', content: 'Error: Bash is not available in this session — this is a Windows host.', tool_call_id: 'call_bash' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_ps', type: 'function', function: { name: 'PowerShell', arguments: { command: 'Get-ChildItem -Force' } } }],
      },
      { role: 'tool', content: "Command 'Get-ChildItem -Force' exited with code 0. stdout: bin src", tool_call_id: 'call_ps' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_read_a', type: 'function', function: { name: 'Read', arguments: { file_path: 'README.md' } } },
          { id: 'call_read_b', type: 'function', function: { name: 'Read', arguments: { file_path: 'package.json' } } },
        ],
      },
      { role: 'tool', content: '1\t# session-sync', tool_call_id: 'call_read_a' },
      { role: 'tool', content: '1\t{\n2\t  "name": "session-sync"', tool_call_id: 'call_read_b' },
      { role: 'assistant', content: '这是一个 session-sync 项目。' },
      { role: 'user', content: '并发多个agent探索项目' },
      {
        role: 'assistant',
        content: '好，我把它委派给 OrganizeAgent。',
        tool_calls: [{ id: 'call_agent', type: 'function', function: { name: 'create_agent', arguments: { agent_type: 'OrganizeAgent' } } }],
      },
      { role: 'tool', content: 'create_agent ok\nagent_id: o_1', tool_call_id: 'call_agent' },
      { role: 'assistant', content: '已委派，任务在后台跑着。' },
      { role: 'assistant', content: '四路探索完成，整合结论如下。' },
    ],
  });
  // 多 agent：organizer 有轨迹、subagent 有轨迹、另一个 subagent 是空壳（应被跳过）
  writeAgent(home, CHAT, 'o_testOrg', {
    role: 'organizer',
    assignedBy: 'm_testMain',
    blocks: [{ ts: T4, text: '<system-reminder> The user\'s original query was: 并发多个agent探索项目 </system-reminder>' }],
    trajectory: [{ role: 'assistant', content: '我先快速核对项目实际结构。' }],
  });
  writeAgent(home, CHAT, 's_testSub', {
    role: 'subagent',
    assignedBy: 'o_testOrg',
    trajectory: [{ role: 'user', content: '只读探索项目，负责「CLI 表面」切片。' }],
  });
  fs.mkdirSync(path.join(sessionsDir(home), CHAT, 'agents', 's_emptyShell'), { recursive: true });
}

test('list：所有 agent 目录归一为一条会话，标题/轮次/cwd/scope 就位', () => {
  const home = tmpHome('list');
  seedSampleB(home);
  const ctx = ctxFor(home);
  const r = listSessions('doubao', ctx);
  assert.equal(r.ok, true);
  assert.equal(r.available, true);
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.id, CHAT);
  assert.equal(s.variant, 'doubao');
  assert.equal(s.title, '什么模型', '标题取 assignment 首个需求块');
  assert.equal(s.turns, 4, '四个真实需求各一轮（注入块与重复 user 行不得多算）');
  assert.equal(s.cwd, 'C:\\Users\\tester\\Doubao\\chats\\2026-11-02\\new-chat', 'cwd 取 Preferences 的 workspace 映射');
  assert.equal(s.scope, 'none');
  assert.equal(s.source, 'sessions');
});

test('read：首轮只在 assignment 不丢、次轮两边都有不重、工具语义完整', () => {
  const home = tmpHome('read');
  seedSampleB(home);
  const ctx = ctxFor(home);
  const r = readSession('doubao', ctx, CHAT);
  assert.equal(r.ok, true);
  const s = r.session;
  assert.equal(s.turns.length, 4);
  assert.equal(s.title, '什么模型');

  // 第 1 轮：用户文本只在 assignment，助手问候来自 trajectory
  assert.equal(s.turns[0].role, 'user');
  assert.equal(s.turns[0].items[0].text, '什么模型');
  assert.ok(s.turns[0].items.some((i) => i.kind === 'message' && i.text.includes('豆包办公助手')));

  // 第 2 轮：user 行与 assignment 块同文本 → 只出现一次
  const userTexts = jsonlOf(s);
  assert.deepEqual(
    userTexts,
    ['什么模型', '你可以编程吗？', '这个项目是干什么的？', '并发多个agent探索项目'],
    '用户轮必须恰好四条、顺序正确、无重复',
  );

  // 第 3 轮：报错 / 成功 / 并行调用（arguments 是对象，不能二次序列化）
  const turn3 = s.turns[2];
  const calls = turn3.items.filter((i) => i.kind === 'tool_call');
  const results = turn3.items.filter((i) => i.kind === 'tool_result');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['Bash', 'PowerShell', 'Read', 'Read'],
  );
  assert.equal(typeof calls[0].input, 'object');
  assert.equal(calls[0].input.command, 'Get-ChildItem -Force');
  assert.deepEqual(calls[2].input, { file_path: 'README.md' }, '并行调用的参数按各自 id 保留');
  assert.deepEqual(results.map((x) => x.name), ['Bash', 'PowerShell', 'Read', 'Read'], 'tool 行必须按 tool_call_id 回填工具名');
  assert.deepEqual(results.map((x) => x.status), ['error', 'ok', 'ok', 'ok'], '报错按前缀推断，exited with code 0 是成功');
  assert.equal(results[0].callId, 'call_bash');

  // 多 agent 名册：主线之外只收有内容的 agent（空壳跳过）
  assert.deepEqual(
    s.meta.agents.map((a) => a.id),
    ['m_testMain', 'o_testOrg', 's_testSub'],
  );
  // reader 显式非项目信号（不靠目录猜）
  const cls = classifySource(s, ctx);
  assert.equal(cls.scope, 'none');
  assert.equal(cls.reason, 'reader');
});

test('轮次口径：list.turns 必须等于 read 的轮次数（不许两套算法）', () => {
  const home = tmpHome('turns');
  seedSampleB(home);
  const ctx = ctxFor(home);
  const listed = listSessions('doubao', ctx).sessions[0];
  const read = readSession('doubao', ctx, CHAT).session;
  assert.equal(listed.turns, read.turns.length);
});

test('空轨迹的会话不列；没有 workspace 映射时 cwd 留空', () => {
  const home = tmpHome('empty');
  seedProfile(home); // 无映射
  writeAgent(home, '111', 'm_a', { role: 'main', blocks: [{ ts: T1, text: '只建了任务书' }], trajectory: [] });
  writeAgent(home, '222', 'm_b', { role: 'main', blocks: [{ ts: T1, text: '有回复' }], trajectory: [{ role: 'assistant', content: '在' }] });
  const r = listSessions('doubao', ctxFor(home));
  assert.deepEqual(
    r.sessions.map((s) => s.id),
    ['222'],
    '空 trajectory 的目录不构成可导入会话',
  );
  assert.equal(r.sessions[0].cwd, '');
});

test('Profile 枚举：Local State 的 info_cache 优先，读不到回落 Default', () => {
  const home = tmpHome('profiles');
  seedProfile(home, {}, ['Default', 'Profile 1']);
  assert.deepEqual(doubaoProfiles(ctxFor(home)), ['Default', 'Profile 1']);
  const bare = tmpHome('profiles-bare');
  assert.deepEqual(doubaoProfiles(ctxFor(bare)), ['Default']);
  assert.ok(doubaoSessionRoots(ctxFor(home)).every((x) => x.path.endsWith(path.join('.doubao', 'agent_mode', 'workspace', '.sessions'))));
});

// 根被钉住时的落点：树种在**独立临时目录**（不在 home / localAppData 之下），
// 探测索引扫不到它 —— 于是「读得到」只可能来自 --data-root 那条 flag 候选，而不是被探测救回来。
// 钉的是锚点目录本身（<锚点>=…\Doubao），形状与 detect 提示里可粘贴的串一致。
test('根被 --data-root 钉住时读侧必须跟着走（reader 只许走 candidateRoots 唯一入口）', () => {
  const home = tmpHome('pin');
  const anchor = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m81-pin-target-')), 'Doubao');
  const ud = path.join(anchor, 'User Data', 'Default');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(anchor, 'User Data', 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }));
  const kv = JSON.stringify({ 'general-agent:new-chat-workspace:pinnedChat': 'D:\\moved-workspace' });
  fs.writeFileSync(path.join(ud, 'Preferences'), JSON.stringify({ saman: { local_storage_for_web: { home: kv } } }));
  const sys = path.join(ud, '.doubao', 'agent_mode', 'workspace', '.sessions', 'pinnedChat', 'agents', 'm_p', 'system');
  fs.mkdirSync(sys, { recursive: true });
  fs.writeFileSync(
    path.join(sys, 'assignment.md'),
    `# Assignment\n- Agent ID: m_p\n- Role: main\n- Assigned by: user\n- Created: ${T1}\n\n> append-only\n\n## [${T1}] 需求\n钉住位置的会话\n`,
  );
  fs.writeFileSync(path.join(sys, 'trajectory.jsonl'), JSON.stringify({ role: 'assistant', content: '在' }) + '\n');

  const ctx = { ...ctxFor(home), dataRoots: new Map([['doubao', anchor]]) };
  const r = listSessions('doubao', ctx);
  assert.deepEqual(r.sessions.map((s) => s.id), ['pinnedChat'], '钉住的根没被读侧采纳（reader 绕过了 candidateRoots）');
  assert.equal(r.sessions[0].cwd, 'D:\\moved-workspace', '钉住后 Preferences 仍要从钉住根上的 profile 读');
  assert.ok(readSession('doubao', ctx, 'pinnedChat'), '按 id 打开正文也必须走同一套候选');
});

test('能力登记：只读、无桶、账号模型 single-account 且证据带路径', () => {
  assert.equal(VARIANTS.doubao.read, true);
  assert.equal(VARIANTS.doubao.write, false);
  assert.equal(NON_PROJECT_BUCKET.doubao.kind, 'none');
  assert.equal(ACCOUNT_MODEL.doubao.kind, 'single-account');
  assert.match(ACCOUNT_MODEL.doubao.evidence, /LOCALAPPDATA|\.sessions/);
});

function jsonlOf(session) {
  const out = [];
  for (const turn of session.turns) {
    for (const item of turn.items) if (item.kind === 'message' && item.role === 'user') out.push(item.text);
  }
  return out;
}
