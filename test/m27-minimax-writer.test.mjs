// M27 测试：minimax 转可写（计划改动清单 10a）
//
// 原先「只读」的理由（activeRevision 算法未公开）已被本轮取证推翻：
//   - revision 算法在 app.asar 里明文可读（history-catalog/infra/file/canonical-history-jsonl.js
//     的 revisionOfNormalized() = sha256: + 对「递归键排序的规范化记录数组」取哈希）；
//   - 而且**根本不需要写文件**：正文源选择链是
//     messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows → sqliteBlob，
//     DB 行缺失文件时回退；canonical-history-materializer 还会自己把 sqlite 行物化成 messages.jsonl
//     并计算 revision ⇒ 只写 DB 就够，绕开 revision 算法。
// 表 DDL 与触发器全部照抄本机 `~/.minimax/v2/sqlite/runtime-state.sqlite`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { mkMinimaxDb as mkMinimaxDbAt } from './db-fixtures.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession, listSessions } from '../src/readers/index.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { cmpPath } from '../src/util.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m27-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}

function mkMinimaxDb(root) {
  return mkMinimaxDbAt(path.join(root, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'));
}

function mkClaudeSource(root, id, cwd, texts = ['第一轮']) {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: new Date(1791484221000 + i * 9000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: new Date(1791484230000 + i * 9000).toISOString(), message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const f = path.join(root, '.claude', 'projects', id, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const all = (file, sql, ...args) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};

function importToMinimax(root) {
  const ctx = ctxFor(root);
  const plan = planImport(ctx, { from: ['claude'], into: ['minimax'] });
  return { ctx, results: executePlan(ctx, plan, { apply: true, lock: false }) };
}

test('写出的行必须满足宿主的 6 个列表谓词（查询原文照抄 repo/list-predicates）', () => {
  const root = tmpHome('predicates');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's1', 'D:/00-work/code/demo-app');
  const { results } = importToMinimax(root);
  const r = results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.targetId, /^mvs_/);

  const hostQuery = `SELECT session_id FROM local_runtime_sessions
    WHERE columnar_version = 3
      AND agent_name IN ('mavis','main')
      AND archived = 0
      AND visibility <> 'hidden'
      AND session_kind NOT IN ('peek','cron')
      AND parent_session_id IS NULL`;
  const listed = all(file, hostQuery).map((x) => x.session_id);
  assert.ok(listed.includes(r.targetId), `宿主主列表查询必须命中：${JSON.stringify(listed)}`);

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', r.targetId)[0];
  assert.equal(row.runtime, 'pi-agent', 'runtime ∈ {pi-agent, opencode}');
  assert.equal(row.session_type, 'branch', '普通对话必须是 branch：root 是 Agent 内部主会话，踩它会被侧栏排除');
  assert.equal(row.status, 'idle');
  assert.equal(row.columnar_version, 3, '不是 3 时宿主 decodeSessionRow 直接 throw');
});

/**
 * 宿主侧栏 eligible 谓词的真机复刻。
 *
 * 来源（app.asar）：
 *   - service/session-system/projects/sidebar/predicate.js → eligible() / ordinarySidebarSession()
 *   - service/session-system/sessions/repo/filters.js → projectConversationRootPredicate()
 *   - service/session-system/sessions/internal-default-roots.js → listInternalDefaultRootIds()
 *
 * 关键一条：**内部主会话排除**。宿主把所有
 *   session_type='root' AND session_kind='conversation'
 *   且（不是 legacy IM 标记、extra_data_json 里没有 runLocation）
 *   且（is_default_workspace=1 或 落在 Agent 内部默认工作目录）
 * 的行当成 Agent 自己的 Main 会话，从侧栏里排除。
 * ⇒ 写侧把普通会话写成 session_type='root' 时，它在桌面侧栏**整条不可见**。
 */
const SIDEBAR_ELIGIBLE_SQL = `
SELECT s.session_id AS session_id FROM local_runtime_sessions s
JOIN local_runtime_projects p ON p.project_id = s.project_id
WHERE s.columnar_version = 3
  AND s.archived = 0
  AND s.parent_session_id IS NULL
  AND p.hidden = 0
  AND s.session_id NOT IN (
    SELECT x.session_id FROM local_runtime_sessions x
     WHERE x.session_type = 'root' AND x.session_kind = 'conversation'
       AND x.purpose IS NOT '[mavis:trusted-legacy-im-root]'
       AND json_extract(x.extra_data_json, '$.runLocation') IS NULL
       AND x.is_default_workspace = 1
  )
  AND (
    (s.session_type = 'branch' AND s.visibility <> 'hidden' AND s.session_kind NOT IN ('peek','task','channel'))
    OR (s.session_type = 'branch' AND s.session_kind = 'channel')
    OR (s.visibility <> 'hidden'
        AND s.session_type = 'root' AND s.session_kind = 'conversation'
        AND (s.purpose = '[mavis:trusted-legacy-im-root]'
             OR (s.purpose IS NOT NULL AND substr(s.purpose, 1, 5) <> 'cron:')))
  )`;

test('侧栏可见性：默认桶里的导入会话必须命中宿主侧栏谓词（老版本 root ⇒ 不可见）', () => {
  const root = tmpHome('sidebar-visible');
  const file = mkMinimaxDb(root);
  // 非项目会话（默认桶）—— 这正是老版本写成 root 后在桌面侧栏消失的那一类
  mkClaudeSource(root, 's7', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'));
  const { results } = importToMinimax(root);
  const id = results[0].targetId;

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', id)[0];
  assert.equal(row.is_default_workspace, 1, '非项目会话 → 默认桶');
  assert.equal(row.session_type, 'branch', 'root 会被宿主当成内部主会话排除');

  const visible = all(file, SIDEBAR_ELIGIBLE_SQL).map((x) => x.session_id);
  assert.ok(visible.includes(id), `宿主侧栏必须能看到这条会话：${JSON.stringify(visible)}`);
});

test('可见性自愈：老版本写出的 session_type=root 的行，重跑导入（skip）后被改成 branch', () => {
  const root = tmpHome('visibility-heal');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's9', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'));
  const first = importToMinimax(root);
  const id = first.results[0].targetId;

  // 模拟老版本留下的行：session_type='root' + 默认桶 ⇒ 桌面侧栏看不见
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET session_type = ? WHERE session_id = ?').run('root', id);
  db.close();

  const again = importToMinimax(root);
  assert.equal(again.results[0].action, 'skip', JSON.stringify(again.results[0]));
  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', id)[0];
  assert.equal(row.session_type, 'branch', '自愈必须把 root 改回 branch');
  const visible = all(file, SIDEBAR_ELIGIBLE_SQL).map((x) => x.session_id);
  assert.ok(visible.includes(id), '自愈后必须出现在宿主侧栏谓词里');
});

test('来源标记被宿主抹掉后重导仍判 skip（sidecar 兜底），不产生副本', () => {
  const root = tmpHome('marker-lost');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's11', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'));
  const first = importToMinimax(root);
  const id = first.results[0].targetId;
  assert.equal(first.results[0].action, 'create');

  // sidecar 必须落盘：宿主不碰这个文件
  const rel = String(all(file, 'SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?', id)[0].history_relative_dir);
  const dir = path.join(root, '.minimax', 'v2', 'sessions', ...rel.split('/'));
  const sidecar = path.join(dir, 'messages.jsonl.session-sync.json');
  assert.ok(fs.existsSync(sidecar), `provenance sidecar 必须落盘：${sidecar}`);

  // 真机症状：宿主首次物化会话时用自己的一套默认值重写 extra_data_json → 来源标记槽被抹掉。
  // 只靠那一列的话，这次重导认不出「这是我上次写的那条会话」→ 判成不同身份 → 长出一条重复副本。
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ? WHERE session_id = ?').run('{"runLocation":"local"}', id);
  db.close();

  const again = importToMinimax(root);
  assert.equal(again.results[0].action, 'skip', `重导必须判 skip（不得长出副本）：${JSON.stringify(again.results[0])}`);
  assert.equal(all(file, 'SELECT COUNT(*) AS c FROM local_runtime_sessions')[0].c, 1, '目标只能有一条会话');
});

test('规范历史文件被宿主物化遮住时：读侧以 DB 行为准，写侧 repair 把缺失的轮次补回文件', () => {
  const root = tmpHome('file-masked');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's12', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'), ['第一轮问题', '第二轮问题']);
  const { ctx, results } = importToMinimax(root);
  const id = results[0].targetId;
  const rel = String(all(file, 'SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?', id)[0].history_relative_dir);
  const dir = path.join(root, '.minimax', 'v2', 'sessions', ...rel.split('/'));
  const histFile = path.join(dir, 'messages.jsonl');

  // 宿主首次物化：只发布一个**空文件**（真机症状），并用自己的默认值重写 extra_data_json（来源标记被抹掉）
  fs.writeFileSync(histFile, '', 'utf8');
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ? WHERE session_id = ?').run('{"runLocation":"local"}', id);
  db.close();

  // 读侧：文件不完整 → 以 DB 行为准（导入正文一个字都不丢）
  const back = readSession('minimax', ctx, id).session;
  assert.equal(back.turns.length, 2, 'DB 行里那两轮必须读得回来');
  assert.equal(back.meta.fileIncomplete, true, '必须如实标出「文件不完整」');
  assert.equal(back.meta.storage, 'message-rows');

  // 写侧 repair：把我们自己写的那两轮补回规范文件（那才是模型上下文的来源）
  const writer = getWriter('minimax');
  const rep = writer.repair(ctx);
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.ok(rep.repaired.includes(id), `必须修好这条会话：${JSON.stringify(rep)}`);
  const lines = fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4, `两轮 = 4 行：${lines.length}`);

  // 修好之后读侧回到文件源，轮次不变
  const after = readSession('minimax', ctx, id).session;
  assert.equal(after.meta.storage, 'v2-files');
  assert.equal(after.turns.length, 2);
});

test('来源标记被抹掉 + 规范文件被遮住时重导：判 skip，不产生副本', () => {
  const root = tmpHome('masked-reimport');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's13', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'), ['第一轮问题']);
  const first = importToMinimax(root);
  const id = first.results[0].targetId;
  const rel = String(all(file, 'SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?', id)[0].history_relative_dir);
  const histFile = path.join(root, '.minimax', 'v2', 'sessions', ...rel.split('/'), 'messages.jsonl');

  // 宿主把两样都弄丢了：来源标记（extra_data_json 被重写）+ 规范历史文件（空文件遮住正文）
  fs.writeFileSync(histFile, '', 'utf8');
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ? WHERE session_id = ?').run('{"runLocation":"local"}', id);
  db.close();

  // 重导：身份旁证没了，但内容一致 ⇒ 只允许「已经在那儿」的结论（skip），绝不长副本
  const again = importToMinimax(root);
  assert.equal(again.results[0].action, 'skip', `重导必须判 skip：${JSON.stringify(again.results[0])}`);
  assert.equal(all(file, 'SELECT COUNT(*) AS c FROM local_runtime_sessions')[0].c, 1, '目标只能有一条会话');
  // 顺带把规范文件修回来（repair 在锁内、决策之前跑）
  assert.ok(fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).length > 0, '规范文件必须被补回内容');
});

test('project 行由宿主触发器建，project_id 被回填；默认工作区 → project_kind=default 且 workspace_dir 为 NULL', () => {
  const root = tmpHome('project-trigger');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's2', path.join(root, 'WorkBuddy', '2026-10-08-18-38-21').replace(/\\/g, '/'));
  const { results } = importToMinimax(root);
  const id = results[0].targetId;

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', id)[0];
  assert.equal(row.is_default_workspace, 1, '非项目会话 → 默认工作区');
  assert.ok(Number(row.project_id) > 0, `project_id 必须由触发器回填，实际 ${row.project_id}`);
  const proj = all(file, 'SELECT * FROM local_runtime_projects WHERE project_id = ?', row.project_id)[0];
  assert.equal(proj.project_kind, 'default');
  assert.equal(proj.workspace_dir, null);
});

test('规范历史文件：写侧自己落盘（宿主的物化器只会发布空文件，空文件会把导入正文遮住）', () => {
  const root = tmpHome('canonical-history');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's10', path.join(root, 'WorkBuddy', '2026-11-23-10-09-23').replace(/\\/g, '/'), ['第一轮问题', '第二轮问题']);
  const { results } = importToMinimax(root);
  const id = results[0].targetId;

  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', id)[0];
  // 宿主的 utcSessionHistoryRelativeDir 形态：4 段斜杠 + UTC 时间戳
  assert.match(
    String(row.history_relative_dir),
    /^\d{4}\/\d{2}\/\d{2}\/\d{2}-\d{2}-\d{2}-\d{3}-session_[\w-]+$/,
    `history_relative_dir 必须是宿主形态：${row.history_relative_dir}`,
  );
  const dir = path.join(root, '.minimax', 'v2', 'sessions', ...String(row.history_relative_dir).split('/'));
  const histFile = path.join(dir, 'messages.jsonl');
  assert.ok(fs.existsSync(histFile), `规范历史文件必须落盘：${histFile}`);

  // 正文：宿主规范形态（{message_id, turn_id, message}），一轮 = user 行 + assistant 行
  const lines = fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 4, `两轮 = 4 行：${lines.length}`);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['message', 'message_id', 'turn_id']);
  assert.equal(lines[0].message.role, 'user');
  assert.equal(lines[1].message.role, 'assistant');
  assert.equal(lines[0].message.content[0].type, 'text');
  assert.equal(lines[0].message.content[0].text, '第一轮问题');
  assert.equal(lines[1].turn_id, lines[0].turn_id, '同一轮共享 turn_id');

  // manifest：宿主会校验它与行的 sessionId / createdAtMs 一致
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessionId, id);
  assert.equal(manifest.createdAtMs, row.created_at_ms);
  assert.equal(manifest.layout, 'v2-final-dated-session');

  // 读侧首选源就是这个文件 → 读回来的轮次与源一致
  assert.equal(readSession('minimax', ctxFor(root), id).session.turns.length, 2);
});

test('项目会话 → is_default_workspace=0 且按 project_workspace_dir 建 workspace 项目行', () => {
  const root = tmpHome('project-workspace');
  const file = mkMinimaxDb(root);
  const proj = 'D:/00-work/code/demo-app';
  mkClaudeSource(root, 's3', proj);
  const { results } = importToMinimax(root);
  const row = all(file, 'SELECT * FROM local_runtime_sessions WHERE session_id = ?', results[0].targetId)[0];
  assert.equal(row.is_default_workspace, 0);
  // 落库形态是**规范化的原生路径**，不再照抄源侧的写法：
  // 宿主的项目键是字节级目录串，照抄「D:/a/b」这种写法会和宿主自己记的「D:\a\b」分成两个项目
  assert.notEqual(row.project_workspace_dir, proj, '不能再照抄源侧的目录写法');
  assert.equal(cmpPath(row.project_workspace_dir), cmpPath(proj), '同一个目录');
  if (process.platform === 'win32') {
    assert.match(row.project_workspace_dir, /^[A-Z]:\\/, `必须是宿主同形的原生路径：${row.project_workspace_dir}`);
    assert.ok(!row.project_workspace_dir.includes('/'), `分隔符必须原生：${row.project_workspace_dir}`);
  }
  const p = all(file, 'SELECT * FROM local_runtime_projects WHERE project_id = ?', row.project_id)[0];
  assert.equal(p.project_kind, 'workspace');
  assert.equal(p.workspace_dir, row.project_workspace_dir, '项目行的目录串必须与会话行一致');
  // 侧栏按项目分组的查询（listProjectRootPage）也依赖 project_id 列
  assert.ok(all(file, 'SELECT session_id FROM local_runtime_sessions WHERE columnar_version = 3 AND project_id = ?', row.project_id).length >= 1);
});

test('round-trip：正文从 local_runtime_message_rows 读回，provenance 走 extra_data_json 槽位', () => {
  const root = tmpHome('roundtrip');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's4', 'D:/00-work/code/demo-app', ['第一轮问题']);
  const { ctx, results } = importToMinimax(root);
  const id = results[0].targetId;

  // 一行 = 一条消息（宿主 display message 契约）：一轮 = user 提问行 + assistant 回答行
  const msgs = all(file, 'SELECT * FROM local_runtime_message_rows WHERE session_id = ? ORDER BY id', id);
  assert.equal(msgs.length, 2, JSON.stringify(msgs.map((m) => m.role)));
  for (const m of msgs) {
    const d = JSON.parse(m.data_json);
    assert.ok(Array.isArray(d['session-sync-content']) && d['session-sync-content'].length >= 1, `必须带完整部件数组：${m.data_json.slice(0, 160)}`);
    assert.equal(d.role, m.role);
  }
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');

  const back = readSession('minimax', ctx, id).session;
  assert.equal(back.turns.length, 1, JSON.stringify(back.turns.length));
  assert.equal(back.origin?.variant, 'claude', 'provenance 必须从 extra_data_json["session-sync"] 读回');
  assert.equal(listSessions('minimax', ctx, {}).sessions.length, 1);
});

test('宿主已物化 messages.jsonl 时，append 必须写进文件（reader 取数链文件优先，只写 DB 会被遮蔽）', () => {
  const root = tmpHome('hist-file-append');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's6', 'D:/00-work/code/demo-app', ['第一轮']);
  const first = importToMinimax(root);
  const id = first.results[0].targetId;

  // 模拟宿主把 DB 行物化成文件型历史，并把列指过去（此后 reader 首选文件）
  const rel = '2026/09/08/05-47-43-992-session_x';
  const dir = path.join(root, '.minimax', 'v2', 'sessions', rel);
  fs.mkdirSync(dir, { recursive: true });
  const histFile = path.join(dir, 'messages.jsonl');
  fs.writeFileSync(histFile, [
    { message_id: 'msg-user-v1-1', turn_id: 'turn_0000_1', message: { role: 'user', content: [{ type: 'text', text: '第一轮' }] } },
    { message_id: 'msg-assistant-v1-1', turn_id: 'turn_0000_1', message: { role: 'assistant', content: [{ type: 'text', text: '答第一轮' }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  const db = new DatabaseSync(file);
  db.prepare('UPDATE local_runtime_sessions SET history_relative_dir = ? WHERE session_id = ?').run(rel, id);
  db.close();

  assert.equal(readSession('minimax', ctxFor(root), id).session.turns.length, 1, '文件源读回必须已是 1 轮');

  mkClaudeSource(root, 's6', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const grown = importToMinimax(root);
  const res = grown.results[0];
  assert.equal(res.action, 'append', JSON.stringify(res));
  assert.ok((res.warnings ?? []).some((w) => String(w).startsWith('append-history-file')), JSON.stringify(res.warnings));
  assert.equal(readSession('minimax', grown.ctx, id).session.turns.length, 2, '追加的轮次必须读得回来');
  assert.equal(fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).length, 4, '文件要长出两行');
  assert.equal(all(file, 'SELECT COUNT(*) AS c FROM local_runtime_message_rows WHERE session_id = ?', id)[0].c, 2, '已有文件时不再插 DB 行，避免宿主二次物化');
});

test('幂等与 append：重跑 skip 不重复插行，源长一轮后 append 进同一会话', () => {
  const root = tmpHome('idem');
  const file = mkMinimaxDb(root);
  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮']);
  const first = importToMinimax(root);
  const id = first.results[0].targetId;
  const histFile = path.join(root, '.minimax', 'v2', 'sessions', ...String(all(file, 'SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?', id)[0].history_relative_dir).split('/'), 'messages.jsonl');
  const fileLines = () => fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).length;

  const again = importToMinimax(root);
  assert.equal(again.results[0].action, 'skip', JSON.stringify(again.results[0]));
  assert.equal(all(file, 'SELECT COUNT(*) AS c FROM local_runtime_sessions WHERE session_id = ?', id)[0].c, 1);
  const before = fileLines();

  mkClaudeSource(root, 's5', 'D:/00-work/code/demo-app', ['第一轮', '第二轮']);
  const grown = importToMinimax(root);
  assert.equal(grown.results[0].action, 'append', JSON.stringify(grown.results[0]));
  assert.equal(all(file, 'SELECT COUNT(*) AS c FROM local_runtime_sessions WHERE session_id = ?', id)[0].c, 1);
  const after = fileLines();
  assert.ok(after > before, `append 必须让规范历史文件长出内容：${before} → ${after}`);
  assert.equal(readSession('minimax', grown.ctx, id).session.turns.length, 2);
});
