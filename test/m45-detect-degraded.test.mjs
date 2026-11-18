// M45 测试：宿主探测（MiMo / qoder 中英）与「密文会话默认不导」
//
// 背景（2026-10-29 真机排查）：
//   1) 在 MiMo 里跑本工具时，--into 被探测成 qoder-cn —— 因为 MiMo 没有环境指纹，
//      回落到「最近改动的库」启发式，而 qoder-cn 的库刚被改过。MiMo 自己用 MIMOCODE_* 前缀。
//   2) qoder 中文版的 QODER_CONFIG_DIR 是 `~/.qoder-cn`，旧正则只认 `QoderCN` → 中/英互串。
//   3) qoder 旧代 local.db 的正文是密文：以前会把它当正常会话导成一个「22 轮占位说明」的空壳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeCtx, detectHost } from '../src/hosts.mjs';
import { planImport } from '../src/import.mjs';
import { opencodeSessionLabel } from '../src/readers/base.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m45-${name}-`));
}
function ctxFor(root, env = {}) {
  return makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env });
}
const baseEnv = () => ({ PATH: process.env.PATH });

test('宿主探测：MiMo 认 MIMOCODE_* 前缀与 MIMO_HOME；qoder 中/英按目录名区分', () => {
  const home = tmpRoot('detect');
  const probe = (env) => detectHost(ctxFor(home, { ...baseEnv(), ...env })).variant;
  assert.equal(probe({ MIMOCODE_BIN_PATH: 'C:/x/mimo.exe' }), 'mimo', 'MiMo 的 MIMOCODE_* 前缀必须被认出');
  assert.equal(probe({ MIMOCODE_CONFIG_DIR: 'C:/m/.mimocode' }), 'mimo');
  assert.equal(probe({ MIMO_HOME: 'C:/m' }), 'mimo', '我们自己的覆盖变量也算宿主信号');
  assert.equal(probe({ QODER_CONFIG_DIR: 'C:/Users/x/.qoder-cn' }), 'qoder-cn', '.qoder-cn 是中文版');
  assert.equal(probe({ QODER_CONFIG_DIR: 'C:/Users/x/.qoder' }), 'qoder-intl', '.qoder 是国际版');
  assert.equal(probe({ QODER_HOME: 'C:/Users/x/.qoder-cn' }), 'qoder-cn');
});

test('密文会话（qoder 旧代 local.db）默认不导；--include-degraded 才放行', () => {
  const root = tmpRoot('degraded');
  const dbFile = path.join(root, 'AppData', 'Roaming', 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE chat_session (session_id TEXT, session_title TEXT, project_id TEXT, project_uri TEXT, gmt_create INTEGER, gmt_modified INTEGER, session_type TEXT, mode TEXT, preferred_model_info TEXT, extra TEXT, parent_session_id TEXT)');
  db.exec('CREATE TABLE chat_message (id TEXT, session_id TEXT, role TEXT, content TEXT, token_info TEXT, model_info TEXT, gmt_create INTEGER)');
  db.prepare('INSERT INTO chat_session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('task-1', '电话机器人方案', 'p', 'd:/q/proj', 1791963971021, 1792028293221, 'quest', 'long_running', null, null, null);
  const cipher = Buffer.from('x'.repeat(200)).toString('base64');
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,?,?,?,?)').run('m1', 'task-1', 'user', cipher, '', '', 1791963971021);
  db.prepare('INSERT INTO chat_message VALUES (?,?,?,?,?,?,?)').run('m2', 'task-1', 'assistant', cipher, '', '', 1791963972021);
  db.close();

  const ctx = ctxFor(root, { PATH: process.env.PATH });
  const skipped = planImport(ctx, { from: ['qoder-cn'], into: ['claude'] });
  assert.equal(skipped.pairs.length, 0, `密文会话默认不能进计划：${JSON.stringify(skipped.pairs)}`);
  assert.equal(skipped.degradedSkipped, 1, '必须单独计数，不能当成“没有会话”');

  const forced = planImport(ctx, { from: ['qoder-cn'], into: ['claude'], includeDegraded: true });
  assert.equal(forced.pairs.length, 1, '显式允许时才导（内容仍是占位说明）');
});

test('OpenCode 血统标题口径：空标题→New/Child session，历史时间戳标题折叠（宿主源码原文）', () => {
  assert.equal(opencodeSessionLabel(null, null), 'New session');
  assert.equal(opencodeSessionLabel('', undefined), 'New session');
  assert.equal(opencodeSessionLabel(null, 'ses_parent'), 'Child session');
  assert.equal(opencodeSessionLabel('New session - 2026-10-28T01:54:00.000Z', null), 'New session');
  assert.equal(opencodeSessionLabel('Child session - 2026-10-28T01:54:00.000Z', 'p'), 'Child session');
  assert.equal(opencodeSessionLabel('排查 RabbitMQ 报错', null), '排查 RabbitMQ 报错');
});
