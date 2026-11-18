// M46 测试：标题语义 = 宿主侧栏显示的名字（不是我们推导的）
//
// 真机实测（2026-10-29）：WorkBuddy 两家的 db `sessions.title` 与 jsonl 的 ai-title/首条消息常不一致
// （cn 32/106、intl 102/132）。侧栏读的是 db.title，所以读侧必须以它为准，jsonl 推导只兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { listSessions, readSession } from '../src/readers/index.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m46-'));
}
function ctxFor(root) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} });
}

test('WorkBuddy：list/read 的标题取 db sessions.title，jsonl 的 ai-title 只兜底', () => {
  const root = tmpRoot();
  const id = '11111111-2222-3333-4444-555555555555';
  const jsonl = path.join(root, '.workbuddy', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.writeFileSync(jsonl, [
    { type: 'message', timestamp: 1791484221000, message: { role: 'user', content: [{ type: 'input_text', text: '首条消息' }] } },
    { type: 'ai-title', timestamp: 1791484222000, title: 'jsonl 里的标题' },
    { type: 'message', timestamp: 1791484223000, message: { role: 'assistant', content: [{ type: 'output_text', text: '答' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const db = new DatabaseSync(path.join(root, '.workbuddy', 'workbuddy.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, user_id TEXT, title TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER, is_playground INTEGER, transport TEXT, unread INTEGER)');
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, is_playground, transport, unread) VALUES (?,?,?,?,?,?,?,?,0,?,0)')
    .run(id, 'D:/work/demo', 'u1', '宿主侧栏标题', 'Completed', 1791484221000, 1791484223000, 1791484223000, 'local');
  db.close();

  const ctx = ctxFor(root);
  const row = listSessions('workbuddy-cn', ctx, {}).sessions.find((s) => s.id === id);
  assert.ok(row, '会话必须被列出');
  assert.equal(row.title, '宿主侧栏标题', `list 标题应等于宿主 db.title，实际 ${row.title}`);

  const s = readSession('workbuddy-cn', ctx, id).session;
  assert.equal(s.title, '宿主侧栏标题', `read 标题应等于宿主 db.title，实际 ${s.title}`);
});
