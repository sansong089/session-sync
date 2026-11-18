// M60 测试：改名后的标题同步（qoder 改名 → 导入 workbuddy → 复跑要更新目标标题）
//
// 背景（真机取证 + 复现）：
//   - qoder 的会话名只存在桌面注册表 chat_sessions.title（CLI jsonl 里没有标题字段）；
//   - WorkBuddy 的标题裁决（app.asar /main/database-factory.js extractSessionInfoFromJsonl
//     + /main/conversations.js resolveConversationTitle）：
//       custom_title 列（用户手动改名） > 正文 custom-title 行 > db title 列 > 正文 ai-title 行 > 首问
//   - 核心指纹只取消息文本与工具调用，**不含标题** → 改名不改变内容判定。
//   症状：先导入（改名前）→ 源侧改名 → 复跑判 identical/skip → 目标标题永远停在旧名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { parseDataRoots } from '../src/roots.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';
import { rewriteFirstJsonlField } from '../src/writers/base.mjs';

const SRC_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CWD = 'D:/work/demo';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m60-${name}-`));
}

/** 造一个「qoder 形态的源 + workbuddy 形态的目标」沙箱 */
function makeSandbox(name) {
  const home = tmpHome(name);
  const appData = path.join(home, 'AppData', 'Roaming');

  // 源：qoder-cn 的 CLI 明文 jsonl
  const projDir = path.join(home, '.qoder-cn', 'projects', 'D--work-demo');
  fs.mkdirSync(projDir, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', sessionId: SRC_ID, cwd: CWD, message: { role: 'user', content: '原始的第一句话' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:02.000Z', sessionId: SRC_ID, cwd: CWD, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '回答' }] } },
  ];
  fs.writeFileSync(path.join(projDir, `${SRC_ID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // 源：桌面注册表（标题住这儿）
  fs.mkdirSync(path.join(appData, 'com.qodercn.app.stable'), { recursive: true });
  const regPath = path.join(appData, 'com.qodercn.app.stable', 'main.sqlite');
  const reg = new DatabaseSync(regPath);
  reg.exec('CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, workspace_id TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, extra_json TEXT)');
  reg.prepare('INSERT INTO chat_sessions (session_id, title, cwd) VALUES (?,?,?)').run(SRC_ID, '原始的第一句话', CWD);
  reg.close();

  // 目标：workbuddy 的配置根（宿主装过的痕迹，让写门放行）
  fs.mkdirSync(path.join(home, '.workbuddy', 'projects'), { recursive: true });

  const ctx = makeCtx({
    home,
    platform: 'win32',
    appData,
    localAppData: path.join(home, 'AppData', 'Local'),
    env: {},
    dataRoots: parseDataRoots(`workbuddy-cn=${path.join(home, '.workbuddy')}`),
  });
  return { home, ctx, regPath };
}

function renameSource(regPath, title) {
  const db = new DatabaseSync(regPath);
  db.prepare('UPDATE chat_sessions SET title = ? WHERE session_id = ?').run(title, SRC_ID);
  db.close();
}

function workbuddyTitles(ctx) {
  const list = listSessions('workbuddy-cn', ctx, {});
  return list.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    readTitle: readSession('workbuddy-cn', ctx, s.id).session?.title ?? null,
  }));
}

test('源侧改名后复跑：目标标题要同步为新名（skip 不等于什么都不做）', () => {
  const { ctx, regPath } = makeSandbox('sync');
  try {
    // 首次导入
    const first = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(first[0].action, 'create');
    assert.equal(workbuddyTitles(ctx)[0].title, '原始的第一句话');

    // 源侧改名
    renameSource(regPath, '改名后的标题');

    // 复跑：内容没变 → 判 identical，但标题必须同步
    const second = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(second[0].action, 'skip', '内容没变就该是 skip');
    assert.equal(second[0].reason, 'identical');
    assert.equal(second[0].titleSynced, true, '标题漂移必须被同步');
    assert.equal(workbuddyTitles(ctx)[0].title, '改名后的标题', 'list 读到的必须是新名');
    assert.equal(workbuddyTitles(ctx)[0].readTitle, '改名后的标题', 'read 读到的必须是新名');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('改名后复跑：正文内容不动（只改标题，不重写轮次）', () => {
  const { ctx, regPath } = makeSandbox('content');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    const before = workbuddyTitles(ctx)[0];
    const file = findTargetFile(ctx.home);
    const beforeBody = fs.readFileSync(file, 'utf8');

    renameSource(regPath, '改名后的标题');
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });

    const afterBody = fs.readFileSync(file, 'utf8');
    const bodyLines = (t) => t.split('\n').filter((l) => {
      if (!l.trim()) return false;
      const o = JSON.parse(l);
      return o.type !== 'ai-title';
    });
    assert.deepEqual(bodyLines(afterBody), bodyLines(beforeBody), '除标题行外，正文必须一字不动');
    assert.notEqual(beforeBody, afterBody, '标题行必须被改写');
    assert.ok(afterBody.includes('改名后的标题'), 'ai-title 行必须更新为新名');
    assert.ok(!afterBody.includes('custom-title'), '不许写 custom-title 行：那是用户手动改名的标记');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('标题变化不算内容变化：改名不会让复跑长出新副本', () => {
  const { ctx, regPath } = makeSandbox('no-fork');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    renameSource(regPath, '改名后的标题');
    const second = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(second[0].action, 'skip', '改名不该触发 fork');
    assert.equal(workbuddyTitles(ctx).length, 1, '目标仍然只有一条会话（改名不产生副本）');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('标题没变时不做多余写入（无漂移就不碰目标）', () => {
  const { ctx } = makeSandbox('noop');
  try {
    executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    const second = executePlan(ctx, planImport(ctx, { from: ['qoder-cn'], into: ['workbuddy-cn'] }), { apply: true });
    assert.equal(second[0].action, 'skip');
    assert.notEqual(second[0].titleSynced, true, '标题没变就不该报同步');
  } finally {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  }
});

test('读侧按宿主口径取标题：custom_title 列 > 正文 custom-title 行 > db title 列 > ai-title 行', () => {
  const home = tmpHome('read-semantics');
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    const jsonl = path.join(home, '.workbuddy', 'projects', 'p', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(jsonl), { recursive: true });
    fs.writeFileSync(jsonl, [
      { type: 'message', timestamp: 1791484221000, message: { role: 'user', content: [{ type: 'input_text', text: '首条消息' }] } },
      { type: 'ai-title', timestamp: 1791484222000, aiTitle: 'ai 生成的标题' },
      { type: 'message', timestamp: 1791484223000, message: { role: 'assistant', content: [{ type: 'output_text', text: '答' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const db = new DatabaseSync(path.join(home, '.workbuddy', 'workbuddy.db'));
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, custom_title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER, transport TEXT, unread INTEGER)');
    db.prepare('INSERT INTO sessions (id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, transport, unread) VALUES (?,?,?,?,?,?,?,?,?,0,?,0)')
      .run(id, 'D:/work/demo', 'u1', 'db 生成标题', '用户手动改的名', 'Completed', 1791484221000, 1791484223000, 1791484223000, 'local');
    db.close();

    const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: {} });
    const row = listSessions('workbuddy-cn', ctx, {}).sessions.find((s) => s.id === id);
    assert.equal(row.title, '用户手动改的名', 'custom_title 列是宿主的第一优先级');
    assert.equal(readSession('workbuddy-cn', ctx, id).session.title, '用户手动改的名');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rewriteFirstJsonlField：只改第一个匹配行、其余行不动、找不到就不造行', () => {
  const home = tmpHome('rewrite');
  try {
    const f = path.join(home, 'x.jsonl');
    fs.writeFileSync(f, [
      { id: '1', type: 'session-meta', meta: {} },
      { id: '2', type: 'ai-title', aiTitle: '旧标题' },
      { id: '3', type: 'ai-title', aiTitle: '第二条（不该被改）' },
      { id: '4', type: 'message', message: { role: 'user', content: '正文' } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');

    const r = rewriteFirstJsonlField(f, 'ai-title', 'aiTitle', '新标题', { ctx: { home }, variant: 'test' });
    assert.equal(r.changed, true);
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines[1].aiTitle, '新标题', '第一个标题行被改');
    assert.equal(lines[2].aiTitle, '第二条（不该被改）', '第二个标题行不动');
    assert.equal(lines[3].message.content, '正文', '正文不动');

    const again = rewriteFirstJsonlField(f, 'ai-title', 'aiTitle', '新标题', { ctx: { home }, variant: 'test' });
    assert.equal(again.changed, false, '同值不重复写');
    const missing = rewriteFirstJsonlField(f, 'custom-title', 'customTitle', 'x', { ctx: { home }, variant: 'test' });
    assert.equal(missing.changed, false, '没有该类型的行就不造行');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function findTargetFile(home) {
  const dir = path.join(home, '.workbuddy', 'projects');
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.name.endsWith('.jsonl') && !e.name.includes('.session-sync.')) return f;
    }
  }
  return null;
}
