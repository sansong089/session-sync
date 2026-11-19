// M10 测试：OpenCode v2 会话可见性契约（/sessions 列表 + 消息解码）
//
// 背景（opencode v2.1.4 源码实证）：
//   - TUI /sessions（dialog-session-list）按 (project_id, path, parent_id IS NULL) 精确过滤，
//     path = path.relative(project.directory, location.directory)（空则 ''，不是 NULL）；
//   - project.id 由 Project.resolve 决定：git remote → <commonDir>/opencode marker →
//     根提交哈希 → 'global'；非 git → sha1('directory:' + native realpath)；
//   - Session.ID 必须以 ses 开头，列表编码任何一行失败 → 整页 500；
//   - session_message 严格解码：assistant 必填 agent/model，tool 部件必填 time.created、
//     state.content 非空数组 —— 任一违规该会话打不开、session export 500。
// 本文件锁定：写出契约 + 历史脏行自愈（session 级与 message 级）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';
import { canonicalDirectory, canonicalNativePath, opencodeWriter, resolveProjectID } from '../src/writers/opencode.mjs';
import { mintNativeOpencodeId } from '../src/opencode-id.mjs';

const SRC_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

// 并行测试文件互抢同一个 target:<变体> 锁 key 会造成偶发假失败：本进程用独立锁目录
process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-locks-'));

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m10-${name}-`));
}

function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkOpencodeDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.close();
  return file;
}

function makeClaudeSource(home, cwd) {
  const file = path.join(home, '.claude', 'projects', 'D--proj', `${SRC_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第一轮问题' }] }, uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd },
    {
      parentUuid: 'u1',
      type: 'assistant',
      message: { role: 'assistant', model: 'm-1', content: [{ type: 'thinking', thinking: '先读文件' }, { type: 'text', text: '第一轮回答' }, { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.txt' } }] },
      uuid: 'a1',
      timestamp: '2026-01-01T00:00:02.000Z',
      sessionId: SRC_ID,
      cwd,
    },
    { parentUuid: 'a1', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'file body' }] }, uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', sessionId: SRC_ID, cwd },
    { parentUuid: 'u2', type: 'user', message: { role: 'user', content: [{ type: 'text', text: '第二轮问题' }] }, uuid: 'u3', timestamp: '2026-01-01T00:00:04.000Z', sessionId: SRC_ID, cwd },
    { parentUuid: 'u3', type: 'assistant', message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: '第二轮回答' }] }, uuid: 'a2', timestamp: '2026-01-01T00:00:05.000Z', sessionId: SRC_ID, cwd },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

function run(ctx, from, into) {
  const plan = planImport(ctx, { from, into });
  const results = executePlan(ctx, plan, { apply: true });
  return { plan, results };
}

function assertWrittenMessageContract(db, sessionId) {
  const rows = db.prepare('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq').all(sessionId);
  let assistants = 0;
  for (const m of rows) {
    assert.ok(m.type === 'user' || m.type === 'assistant' || m.type === 'compaction', `未知消息类型 ${m.type}`);
    const d = JSON.parse(m.data);
    if (m.type === 'compaction') {
      // 宿主注入的压缩摘要：最新一条 completed 行是历史边界，形状不对会让整条会话解码失败（orDie）
      assert.ok(!('type' in d), '判别器来自行的 type 列（上游 rowInput 注入），data 内不得放 type');
      assert.equal(d.status, 'completed');
      assert.ok(d.reason === 'auto' || d.reason === 'manual', `reason 必须是 auto/manual：${d.reason}`);
      assert.equal(typeof d.summary, 'string');
      assert.ok(d.summary.trim(), 'summary 必须有正文（空摘要读侧会跳过 → 丢一轮）');
      assert.ok(!('native' in d) && !('providerContext' in d), '本地摘要才无条件成边界');
      assert.ok(Number.isFinite(d.time?.created), 'compaction.time.created 必填');
      continue;
    }
    if (m.type === 'user') {
      assert.equal(typeof d.text, 'string');
      continue;
    }
    assistants++;
    assert.equal(typeof d.agent, 'string');
    assert.ok(d.agent, 'assistant.agent 必填');
    assert.equal(typeof d.model?.id, 'string');
    assert.ok(d.model.id, 'assistant.model.id 必填');
    assert.equal(typeof d.model?.providerID, 'string');
    assert.ok(d.model.providerID, 'assistant.model.providerID 必填');
    assert.ok(Number.isFinite(d.time?.created), 'assistant.time.created 必填');
    assert.ok(Number.isFinite(d.time?.completed), 'assistant.time.completed 必填（否则会被当成仍在生成：export/fork 丢弃、projector 认为是活动投影）');
    for (const c of d.content) {
      assert.ok(['text', 'reasoning', 'tool'].includes(c.type), `非法 content 类型 ${c.type}`);
      if (c.type === 'tool') {
        assert.ok(Number.isFinite(c.time?.created), 'tool.time.created 必填');
        assert.equal(c.state.status, 'completed');
        assert.ok(c.state.input && typeof c.state.input === 'object' && !Array.isArray(c.state.input));
        assert.ok(Array.isArray(c.state.content) && c.state.content.length > 0, 'state.content 必须非空数组');
      } else {
        assert.equal(typeof c.text, 'string');
      }
    }
  }
  assert.ok(assistants >= 2, '样例源至少应产出 2 条 assistant 消息');
}

test('opencode（v2）：写出的行满足 /sessions 过滤与消息解码契约', () => {
  const home = tmpHome('vis');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // 源 cwd 故意用小写盘符 + 反斜杠形式：写出时必须规范化成 native realpath 形态
  const messyCwd = canonicalNativePath(proj).toLowerCase();
  makeClaudeSource(home, messyCwd);
  const dataDir = path.join(home, 'ocdata');
  const file = mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const { results } = run(ctx, ['claude'], ['opencode']);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify));

  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(r.targetId);
  assert.match(row.id, /^ses/);
  const expectedDirectory = canonicalDirectory(proj);
  const project = resolveProjectID(expectedDirectory);
  assert.equal(row.directory, expectedDirectory, 'directory 必须是 native realpath 的 forward-slash 形态');
  assert.equal(row.id, r.targetId);
  assert.equal(row.project_id, project.id);
  assert.ok(db.prepare('SELECT 1 FROM project WHERE id = ?').get(row.project_id), 'project 行必须存在');
  assert.equal(row.path, project.subpath);
  assert.equal(row.path, '', '同一目录的 subpath 必须为空串（store 用 = 精确匹配，NULL 不匹配）');
  assert.equal(row.model, null, '来源无 provider 信息时 model 必须是完整 Ref 或 NULL，不能是半截 JSON');

  // TUI 语义查询（dialog-session-list：project + subpath + parentID null）
  const visible = db
    .prepare('SELECT id FROM session_v2 WHERE project_id = ? AND path = ? AND parent_id IS NULL')
    .all(row.project_id, project.subpath);
  assert.deepEqual(visible.map((x) => x.id), [row.id]);

  assertWrittenMessageContract(db, row.id);
  db.close();

  // 读回 IR：cwd 是 forward-slash 规范化形态
  const dst = readSession('opencode', ctx, r.targetId).session;
  assert.equal(dst.cwd, expectedDirectory);
});

test('opencode（v2）：历史脏行自愈（session 级 + message 级），且不碰原生会话', () => {
  const home = tmpHome('repair');
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const dataDir = path.join(home, 'ocdata');
  const file = mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });

  const legacyId = '11111111-2222-3333-4444-555555555555';
  const ts = 1792635493378;
  // 无 provenance 的存量行：迁移 key 回退为旧 id 本身，ts 取该行 time_created
  const canonicalId = mintNativeOpencodeId(legacyId, ts);
  // 旧版导入的脏形态：裸 uuid、错误 project、反斜杠 + 小写盘符目录、NULL path、半截 model
  const dirtyDir = canonicalNativePath(proj).toLowerCase();
  const db = new DatabaseSync(file);
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
     VALUES (?,?,?,?,NULL,?,?,NULL,?,?,?,?)`,
  ).run(legacyId, 'bogus-project', 'legacy', dirtyDir, '旧会话', 'session-sync/1', null, JSON.stringify({ id: 'm-only' }), ts, ts);
  // 原生会话（非导入）：任何修复都不得触碰
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, metadata, agent, model, time_created, time_updated)
     VALUES (?,?,?,?,NULL,?,?,NULL,?,?,?,?)`,
  ).run('ses_native000000000000000000000000', 'native-project', 'native', dirtyDir, '原生会话', '2.1.4', null, null, ts, ts);
  const insMsg = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  insMsg.run('msg_l1', legacyId, 'user', 0, ts, ts, JSON.stringify({ time: { created: ts }, text: 123, files: 'nope' }));
  insMsg.run('msg_l2', legacyId, 'assistant', 1, ts, ts, JSON.stringify({
    time: { created: ts },
    content: [
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'r' },
      { type: 'tool', id: 'c1', name: 'Read', state: { status: 'completed', input: { a: 1 }, content: [] } },
      { type: 'tool', id: 'c2', name: 'Bash', state: { status: 'streaming', input: 'partial' }, time: { created: ts } },
      { type: 'weird' },
    ],
  }));
  insMsg.run('msg_native', 'ses_native000000000000000000000000', 'assistant', 0, ts, ts, JSON.stringify({ time: { created: ts }, content: [] }));
  db.close();

  // 无源会话（pairs 为空），但 --apply 仍会对目标做一次性自愈
  const plan = planImport(ctx, { from: ['claude'], into: ['opencode'] });
  assert.equal(plan.pairs.length, 0);
  executePlan(ctx, plan, { apply: true });

  const check = new DatabaseSync(file, { readOnly: true });
  const row = check.prepare('SELECT * FROM session_v2 WHERE id = ?').get(canonicalId);
  assert.ok(row, '裸 uuid 必须改名成 ses_<hex32>');
  const project = resolveProjectID(canonicalDirectory(proj));
  assert.equal(row.project_id, project.id, 'project_id 必须重算');
  assert.equal(row.directory, canonicalDirectory(proj), 'directory 必须规范化为 native realpath + forward slash');
  assert.equal(row.path, '', 'NULL path 必须补成空串');
  assert.equal(row.model, null, '半截 model（无 providerID）必须清成 NULL');
  assert.ok(check.prepare('SELECT 1 FROM project WHERE id = ?').get(project.id), '项目行由修复补建');

  const u = JSON.parse(check.prepare('SELECT data FROM session_message WHERE id = ?').get('msg_l1').data);
  assert.equal(u.text, '123', '非字符串 text 归一为字符串');
  assert.equal(u.files, undefined, '非法 files 字段剔除');

  const a = JSON.parse(check.prepare('SELECT data FROM session_message WHERE id = ?').get('msg_l2').data);
  assert.equal(a.agent, 'build');
  assert.deepEqual(a.model, { id: 'unknown', providerID: 'opencode' }, '占位 provider 必须换成宿主真实 provider（否则 reasoning 降级被网关丢弃）');
  assert.equal(a.time.completed, ts, '历史 assistant 消息补 time.completed（否则永远算「生成中」）');
  assert.equal(a.time.streamed, ts, '补 time.streamed 与原生行同形');
  assert.deepEqual(a.content.map((c) => c.type), ['text', 'reasoning', 'tool', 'tool'], '非法 content 项剔除');
  assert.deepEqual(a.content[1].native, { reasoningField: 'reasoning', reasoningDetails: [{ type: 'reasoning.text', text: 'r', format: 'unknown', index: 0 }] }, 'reasoning 补 native 包裹（sameModel=true 时发成 reasoning+reasoning_details）');
  assert.deepEqual(a.content[1].time, { created: ts, completed: ts }, 'reasoning 部件补 time');
  assert.equal(a.finish, 'tool-calls', '工具收尾 → tool-calls');
  assert.equal(a.rawFinish, 'tool-calls', 'rawFinish 与 finish 同值');
  assert.equal(a.cost, 0);
  assert.deepEqual(a.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.equal(a.content[2].time.created, ts, 'tool 部件补 time.created');
  assert.deepEqual(a.content[2].state, { status: 'completed', input: { a: 1 }, content: [{ type: 'text', text: '' }] }, '空 content 补占位文本');
  assert.equal(a.content[3].state.status, 'completed', '非 completed 状态归一化');
  assert.deepEqual(a.content[3].state.input, {}, 'streaming 的字符串 input 归一为空对象');
  assert.ok(a.content[3].state.content.length > 0);

  const native = check.prepare('SELECT * FROM session_v2 WHERE id = ?').get('ses_native000000000000000000000000');
  assert.equal(native.project_id, 'native-project');
  assert.equal(native.path, null);
  const nativeMsg = JSON.parse(check.prepare('SELECT data FROM session_message WHERE id = ?').get('msg_native').data);
  assert.equal(nativeMsg.agent, undefined, '原生会话的消息绝不能被改写');
  check.close();

  // 幂等：二次自愈没有可改的东西
  const again = opencodeWriter.repair(ctxFor(home, { OPENCODE_DATA_DIR: dataDir }));
  assert.deepEqual(again, { ok: true, renamed: 0, projectFixed: 0, modelFixed: 0, dirFixed: 0, pathFixed: 0, msgFixed: 0, seqFixed: 0, versionFixed: 0, warnings: [] });
});

test('opencode（v2）：git 项目 id 契约（无 remote/无提交 → global；有提交 → 根提交哈希 + subpath）', (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git 不可用');
    return;
  }

  const home = tmpHome('git');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });

  // 无 remote、无提交：opencode 用 Project.ID.global
  assert.equal(resolveProjectID(repo).id, 'global');

  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const rootHash = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  // 子目录解析：项 id = 根提交哈希，worktree 提升到仓库根，subpath = 相对子路径
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  const sub = resolveProjectID(path.join(repo, 'sub'));
  assert.equal(sub.id, rootHash);
  assert.equal(sub.worktree, canonicalDirectory(repo));
  assert.equal(sub.subpath, 'sub');

  // 端到端：写进子目录的会话必须有 path='sub'（TUI 按 subpath 精确过滤）
  const dataDir = path.join(home, 'ocdata');
  const file = mkOpencodeDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  makeClaudeSource(home, path.join(repo, 'sub'));
  const { results } = run(ctx, ['claude'], ['opencode']);
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));

  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare('SELECT * FROM session_v2 WHERE id = ?').get(results[0].targetId);
  assert.equal(row.project_id, rootHash);
  assert.equal(row.directory, canonicalDirectory(path.join(repo, 'sub')));
  assert.equal(row.path, 'sub');
  db.close();
});