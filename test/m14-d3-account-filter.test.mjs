// M14 测试：D3 铁律「源侧读取绝不按账户过滤」的静态锁
// 口径：这条规则适用于所有 agent。任何 reader 里出现「按 user_id/account_id 筛 SQL」
// 或「按当前登录用户筛文件」，都会让别的账户的会话静默消失 —— 本测试把它钉死。
// 行为面已有 m13 覆盖（workbuddy 两账户同列 / codex creator_* 只进 account 字段）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readersDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'readers');
const files = fs.readdirSync(readersDir).filter((n) => n.endsWith('.mjs'));

// SQL 里 WHERE/ON 段引用账户列 = 按账户过滤（SELECT 出来当信号不算）
const ACCOUNT_COLS = String.raw`user_id|user_name|account_id|creator_user_id|creator_account_id|org_id|tenant_id`;
const sqlFilter = new RegExp(String.raw`\b(?:WHERE|ON|AND)\b[^;'"\`]{0,160}?\b(?:${ACCOUNT_COLS})\b\s*(?:=|<>|!=|IN|IS|LIKE)`, 'i');
// 按「当前登录用户」收窄读取范围的环境/系统调用
const hostUserFilter = /\b(os\.userInfo|USERNAME|LOGNAME|USERPROFILE)\b/;

test('锁本身有效：能抓住按账户过滤的写法，又不会误伤取信号的写法', () => {
  for (const bad of [
    'SELECT * FROM sessions WHERE user_id = ?',
    "prepare(`SELECT id FROM chat_session WHERE creator_account_id IN ('x')`)",
    "const where = 'WHERE is_playground = 1 AND user_id = ' + uid",
  ]) {
    assert.ok(sqlFilter.test(bad), `静态锁漏掉了这条：${bad}`);
  }
  for (const fine of [
    'SELECT id, cwd, user_id FROM sessions',
    'if (!row?.user_id) return null;',
    'userId: r.user_id ? String(r.user_id) : null',
  ]) {
    assert.equal(sqlFilter.test(fine), false, `静态锁误伤了这条：${fine}`);
  }
});

test('readers 目录非空且逐家都被扫描到', () => {
  assert.ok(files.length >= 15, `应扫到全部 reader 文件，实际 ${files.length}：${files.join(',')}`);
});

for (const name of files) {
  test(`${name}：没有按账户过滤的 SQL`, () => {
    const src = fs.readFileSync(path.join(readersDir, name), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      assert.doesNotMatch(line, sqlFilter, `${name}:${i + 1} 出现按账户过滤的 SQL 片段：${line.trim()}`);
    }
  });

  test(`${name}：不读当前登录用户名来收窄范围`, () => {
    const src = fs.readFileSync(path.join(readersDir, name), 'utf8');
    assert.doesNotMatch(src, hostUserFilter, `${name} 里出现了按宿主登录用户过滤的痕迹`);
  });
}
