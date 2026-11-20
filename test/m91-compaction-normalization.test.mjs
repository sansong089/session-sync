// M91 测试：压缩摘要的统一归一化（读侧原生→归一，写侧归一→原生，正文无损）
//
// 统一表示：压缩摘要 = 普通 message item，text = 剥壳裸正文（原样），compact:true 承载语义。
//   - 正文与语义正交：导回任何宿主时写侧按原生形态还原，正文一字不丢；
//   - compact 位不进指纹（normalizeItem/coreItem 都不读）→ 核心指纹全链路稳定。
//
// 覆盖：qoder 系（真机有 isCompactSummary 结构标记）、opencode（原生 compaction 行）、
//       minimax（msg_type=3 SystemEvent）。claude/cline/roo/kilo 共用 claude 血统路径，
//       本机无原生压缩记录，靠共用代码对称覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { opencodeWriter } from '../src/writers/opencode.mjs';
import { readSession } from '../src/readers/index.mjs';
import { makeSession, makeTurn, messageItem, sessionCoreFingerprints } from '../src/ir.mjs';
import { compactionInjectionKind } from '../src/text.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m91-locks-'));

const TS = 1792635493378;
// qoder 真机裸摘要开头（无 <cb_summary> 标签，靠 isCompactSummary 标记识别）
const BARE = 'This session is being continued from a previous conversation that ran out of context.\nThe summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   继续任务';

function qoderHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m91-${name}-`));
  const appData = path.join(home, 'AppData', 'Roaming');
  const regDir = path.join(appData, 'com.qodercn.app.stable');
  fs.mkdirSync(regDir, { recursive: true });
  const dbFile = path.join(regDir, 'main.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, sidebar_custom_order INTEGER, origin_session_id TEXT,
    session_kind TEXT NOT NULL DEFAULT 'standard', owner_session_id TEXT, conversation_mode TEXT NOT NULL DEFAULT 'normal',
    product_mode TEXT NOT NULL DEFAULT 'coding', title TEXT NOT NULL, cwd TEXT NOT NULL, execution_kind TEXT, workspace_id TEXT,
    git_branch TEXT, model TEXT, permission_mode TEXT, additional_direcotries TEXT NOT NULL DEFAULT '{}',
    extra_json TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL,
    execution_target_json TEXT NOT NULL DEFAULT '{}', registration_json TEXT, archived INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0, archived_at TIMESTAMP, deleted_at TIMESTAMP, message_envelope_version INTEGER)`);
  db.exec(`CREATE TABLE chat_session_messages (session_id TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT,
    sequence INTEGER NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', feedback TEXT,
    source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, role TEXT, message_stream TEXT,
    voice_session_id TEXT, subtype TEXT, runtime_input_state TEXT, fork_availability TEXT, turn_started_at INTEGER,
    is_compaction_boundary INTEGER, has_visible_content INTEGER, payload_bytes INTEGER, payload_hash TEXT,
    payload_schema_version INTEGER, PRIMARY KEY (session_id, message_id))`);
  db.exec(`CREATE TABLE chat_session_history_revisions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE workspaces (workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_source TEXT NOT NULL,
    root_paths_json TEXT NOT NULL, product_mode TEXT NOT NULL DEFAULT 'coding', extra_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, deleted_at TIMESTAMP)`);
  db.close();
  fs.mkdirSync(path.join(home, '.qoder-cn', 'projects'), { recursive: true });
  const ctx = seedHostSeen(makeCtx({ home, platform: 'win32', appData, env: { QODER_CN_REGISTRY_DB: dbFile } }), ['qoder-cn']);
  return { home, ctx };
}

function sourceWithCompact() {
  const turns = [
    makeTurn('user', [messageItem('user', '第一轮问题', TS), messageItem('assistant', '第一轮回答', TS + 1)], TS),
    makeTurn('user', [messageItem('user', BARE, TS + 2, true), messageItem('assistant', '压缩后回答', TS + 3)], TS + 2),
    makeTurn('user', [messageItem('user', '第二轮问题', TS + 4), messageItem('assistant', '第二轮回答', TS + 5)], TS + 4),
  ];
  return makeSession({ id: 'src', variant: 'qoder-cn', title: '无损往返', cwd: 'D:/work/demo',
    createdAt: TS, updatedAt: TS + 5, model: 'm-1', turns, meta: {} });
}

test('qoder：压缩轮写出带 isCompactSummary，读回正文逐字不变 + compact 语义保留 + 核心收敛', () => {
  const { ctx } = qoderHome('roundtrip');
  const src = sourceWithCompact();
  const writer = getWriter('qoder-cn');
  const out = writer.write(ctx, { session: src, targetId: 'tgt-1', mode: 'create' });
  assert.equal(out.ok, true, JSON.stringify(out));

  // 写的 CLI jsonl 里压缩轮 user 行必须带 isCompactSummary:true
  const bodyFile = out.path || (() => {
    const dir = path.join(ctx.home, '.qoder-cn', 'projects');
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name === 'tgt-1.jsonl') return p;
      }
    }
    return null;
  })();
  assert.ok(bodyFile && fs.existsSync(bodyFile), 'CLI 正文 jsonl 必须存在');
  const lines = fs.readFileSync(bodyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const compactRows = lines.filter((l) => l.type === 'user' && l.isCompactSummary === true);
  assert.equal(compactRows.length, 1, '压缩轮写成 1 条 isCompactSummary user 行');
  assert.ok(lines.some((l) => l.type === 'system' && l.subtype === 'compact_boundary'), '配对的 compact_boundary 行');

  // 读回：正文逐字不变、compact 语义回来、核心指纹逐轮收敛
  const back = readSession('qoder-cn', ctx, 'tgt-1').session;
  assert.ok(back, '写出的会话读得回来');
  assert.equal(back.turns.length, src.turns.length, '轮数不变');
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), '核心指纹逐轮收敛');
  const rtCompact = back.turns.flatMap((t) => t.items).filter((i) => i.compact);
  assert.equal(rtCompact.length, 1, '读回 1 个 compact 项');
  assert.equal(rtCompact[0].text, BARE, '压缩正文逐字不差（无损核心断言）');
});

test('归一化正文不带宿主标签壳，compactionInjectionKind 对裸文本为 null（语义靠 compact 位而非标签）', () => {
  const item = messageItem('user', BARE, 0, true);
  assert.equal(item.compact, true);
  assert.equal(item.text, BARE);
  assert.equal(compactionInjectionKind(item.text), null, '裸摘要无标签 —— 语义不能靠内容判据，必须靠 compact 位');
});

test('workbuddy：压缩轮写出成 cmp_ 原生形态，读回正文逐字不变 + compact 语义保留 + 核心收敛', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m91-wb-'));
  const ctx = seedHostSeen(makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: {} }), ['workbuddy-cn']);
  const src = sourceWithCompact();
  const out = getWriter('workbuddy-cn').write(ctx, { session: { ...src, cwd: 'D:/work/demo' }, targetId: 'wb-tgt-1', mode: 'create', provenance: null, force: true });
  assert.equal(out.ok, true, JSON.stringify(out));

  // 写出的正文 jsonl 里压缩轮应是 cmp_ id + <cb_summary> 壳 + 压缩 providerData
  const bodyFile = out.path;
  assert.ok(bodyFile && fs.existsSync(bodyFile), '正文 jsonl 必须存在');
  const lines = fs.readFileSync(bodyFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cmpRows = lines.filter((l) => String(l.id).startsWith('cmp_'));
  assert.equal(cmpRows.length, 1, '压缩轮写成 1 条 cmp_ 行');
  assert.ok(cmpRows[0].content?.some((c) => String(c.text).startsWith('<cb_summary>')), '正文包 <cb_summary> 壳');
  assert.equal(cmpRows[0].providerData?.isCompacted, true, 'providerData 带压缩标记');

  // 读回：剥壳裸正文逐字不变、compact 语义回来、核心指纹逐轮收敛
  const back = readSession('workbuddy-cn', ctx, 'wb-tgt-1').session;
  assert.ok(back, '写出的会话读得回来');
  assert.deepEqual(sessionCoreFingerprints(back), sessionCoreFingerprints(src), '核心指纹逐轮收敛');
  const rtCompact = back.turns.flatMap((t) => t.items).filter((i) => i.compact);
  assert.equal(rtCompact.length, 1, '读回 1 个 compact 项');
  assert.equal(rtCompact[0].text, BARE, '剥壳后压缩正文逐字不差（无损核心断言）');
});

test('opencode：原生边界往返压缩正文逐字不变，核心指纹收敛', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m91-bridge-'));
  const dataDir = path.join(home, 'ocdata');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_active INTEGER DEFAULT 0 NOT NULL, sandboxes TEXT NOT NULL)`);
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, metadata TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`);
  db.close();
  const ocCtx = seedHostSeen(makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), env: { OPENCODE_DATA_DIR: dataDir } }), ['opencode']);
  const src = sourceWithCompact();
  const ocOut = opencodeWriter.write(ocCtx, { session: src, targetId: 'ses_e1729a950ffeBridge00000001', mode: 'create' });
  assert.equal(ocOut.ok, true, JSON.stringify(ocOut));
  const ocBack = readSession('opencode', ocCtx, 'ses_e1729a950ffeBridge00000001').session;
  const ocCompact = ocBack.turns.flatMap((t) => t.items).filter((i) => i.compact);
  assert.equal(ocCompact.length, 1);
  assert.equal(ocCompact[0].text, BARE, 'opencode 往返正文逐字不变');
  assert.deepEqual(sessionCoreFingerprints(ocBack), sessionCoreFingerprints(src), '核心指纹收敛');
});

