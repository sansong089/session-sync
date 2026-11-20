// M89 测试：opencode v2 的 user.files[] 必须是宿主 Prompt.FileAttachment
//
// 真机故障：qoder-intl 导入的会话里有一条 user 消息写了 {url:'https://…png', type:'file'}，
// 宿主解码时抛 "failed to decode session message" → GET /api/session/.../message 500，
// 整个会话打不开。宿主 schema（packages/schema/src/prompt.ts）：
//   FileAttachment = { data: Base64, mime: string,
//     source: {type:'inline'} | {type:'uri', uri:string}, name?, description?, mention? }
// 修复口径：写侧把 IR 附件转成该形状（本地图片 inline、本地其它文件 uri、
// 远端/不可读的 data:'' + application/octet-stream + source.uri）；
// repair 对历史坏行做同样转换；读侧优先认 source.uri。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';
import { opencodeReader } from '../src/readers/opencode.mjs';

const TS = 1792635493378;
const TARGET = 'ses_e1729a950ffeAttach00000001';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m89-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: { ...env } });
}
function mkDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, time_active INTEGER DEFAULT 0 NOT NULL, time_archived INTEGER, sandboxes TEXT NOT NULL, commands TEXT)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT NOT NULL PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`);
  db.close();
  return file;
}
function rowsOf(file, sessionId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT id, type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq').all(sessionId)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  } finally {
    db.close();
  }
}
function validFile(f) {
  return f && typeof f.data === 'string' && typeof f.mime === 'string' && f.source &&
    (f.source.type === 'inline' || (f.source.type === 'uri' && typeof f.source.uri === 'string'));
}
function sessionOf(cwd) {
  return {
    id: 'src-1', title: '附件会话', cwd, createdAt: TS, updatedAt: TS + 10, model: 'm-1',
    turns: [{
      items: [
        { kind: 'message', role: 'user', text: '看图', ts: TS },
        { kind: 'attachment', ref: path.join(cwd, 'shot.png'), ts: TS },
        { kind: 'attachment', ref: 'https://example.com/remote.png', ts: TS },
        { kind: 'message', role: 'assistant', text: '收到', ts: TS + 1 },
      ],
    }],
  };
}

test('写入路径：本地图片 inline（Base64 真内容），远端 URL 用 source.uri 兜底', () => {
  const home = tmpHome('write');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  const session = sessionOf(home);
  fs.writeFileSync(path.join(home, 'shot.png'), PNG);

  const out = opencodeWriter.write(ctx, { session, targetId: TARGET, mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));

  const user = rowsOf(file, TARGET).find((r) => r.type === 'user');
  assert.ok(user, '必须有 user 消息');
  assert.equal(user.data.files.length, 2);
  for (const f of user.data.files) assert.ok(validFile(f), `附件必须是 Prompt.FileAttachment：${JSON.stringify(f)}`);

  const [local, remote] = user.data.files;
  assert.deepEqual(local.source, { type: 'inline' }, '本地图片走 inline');
  assert.equal(local.mime, 'image/png');
  assert.equal(Buffer.from(local.data, 'base64').toString('hex'), PNG.toString('hex'), 'inline 携带真实图片字节');
  assert.equal(local.name, 'shot.png');

  assert.equal(remote.source.type, 'uri', '远端 URL 走 source.uri');
  assert.equal(remote.source.uri, 'https://example.com/remote.png');
  assert.equal(remote.data, '', '远端引用没有可内联的字节，data 为空串（schema 合法）');
  assert.equal(remote.mime, 'application/octet-stream', '空 data 不得谎称是图片');
});

test('自愈路径：历史 {url,type:file} 转成合法附件，合法附件逐字节不变，且幂等', () => {
  const home = tmpHome('repair');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  fs.writeFileSync(path.join(home, 'shot.png'), PNG);

  const legacy = {
    time: { created: TS },
    text: '附件引用',
    files: [{ url: 'https://example.com/remote.png', type: 'file' }],
    agents: [],
  };
  const native = {
    time: { created: TS },
    text: '原生',
    files: [{ data: PNG.toString('base64'), mime: 'image/png', source: { type: 'inline' }, name: 'native.png' }],
    agents: [],
  };
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1',?, 'git',?,?,0,'[]')`).run(home, TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(TARGET, 'p1', 'x', home, '', '旧导入', 'session-sync/1', 'build', null, TS, TS);
  for (const [id, data] of [['msg_bad', legacy], ['msg_native', native]]) {
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
      .run(id, TARGET, 'user', id === 'msg_bad' ? 0 : 1, TS, TS, JSON.stringify(data));
  }
  db.close();

  const first = opencodeWriter.repair(ctx);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.msgFixed >= 1, `必须修复坏附件行：${JSON.stringify(first)}`);

  const fixed = rowsOf(file, TARGET);
  const bad = fixed.find((r) => r.id === 'msg_bad');
  const good = fixed.find((r) => r.id === 'msg_native');
  assert.ok(validFile(bad.data.files[0]), `坏附件要转成 FileAttachment：${JSON.stringify(bad.data.files[0])}`);
  assert.equal(bad.data.files[0].source.uri, 'https://example.com/remote.png', '原 URL 不丢');
  assert.equal(bad.data.files[0].mime, 'application/octet-stream');
  assert.deepEqual(good.data.files[0], native.files[0], '已合法的附件不得被改写');

  const again = opencodeWriter.repair(ctx);
  assert.equal(again.msgFixed, 0, `二次自愈应幂等：${JSON.stringify(again)}`);
  assert.deepEqual(rowsOf(file, TARGET).find((r) => r.id === 'msg_bad').data, bad.data);
});

test('读回路径：优先从 source.uri 还原附件引用，兼容历史 url', () => {
  const home = tmpHome('read');
  const dataDir = path.join(home, 'ocdata');
  const file = mkDb(path.join(dataDir, 'opencode.db'));
  const ctx = ctxFor(home, { OPENCODE_DATA_DIR: dataDir });
  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO project (id, worktree, vcs, time_created, time_updated, time_active, sandboxes) VALUES ('p1',?, 'git',?,?,0,'[]')`).run(home, TS, TS);
  db.prepare(`INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(TARGET, 'p1', 'x', home, '', '附件会话', 'session-sync/1', 'build', null, TS, TS);
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)')
    .run('msg_1', TARGET, 'user', 0, TS, TS, JSON.stringify({
      time: { created: TS }, text: '看图',
      files: [
        { data: '', mime: 'application/octet-stream', source: { type: 'uri', uri: 'https://example.com/remote.png' } },
        { url: 'https://example.com/legacy.png', type: 'file' },
      ],
    }));
  db.close();

  const ir = opencodeReader.read(ctx, TARGET);
  assert.ok(ir, '会话必须能读出来');
  const refs = ir.turns[0].items.filter((i) => i.kind === 'attachment').map((i) => i.ref);
  assert.deepEqual(refs, ['https://example.com/remote.png', 'https://example.com/legacy.png']);
});
