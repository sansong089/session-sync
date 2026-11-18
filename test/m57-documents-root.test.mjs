// M57 测试：已知文件夹（Windows「文档」）重定向下的桶根判定
//
// 这一处原先是纯字符串拼 <home>\Documents\<宿主目录>。不少人把 Documents 重定向到 D 盘，
// 于是同一个错会往两个方向犯：写侧在没人看的目录里建孤儿桶；读侧认不出宿主自生成的桶，
// 把非项目会话误判成项目会话。规则：**只有确实重定向、且那儿没有本家自生成目录时才算不可信**；
// 注册表读不到只是「不知道」，不等于「搬走过」，不能据此拒绝写入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx, documentsRoot } from '../src/hosts.mjs';
import { resolveRoot } from '../src/roots.mjs';
import { resolvePlacement, INTERNAL_ROOTS } from '../src/placement.mjs';

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m57-${name}-`));
}
const ctxAt = (home, extra = {}) => makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {}, ...extra });
const session = (cwd) => ({ cwd, variant: 'claude', id: 's1', createdAt: Date.parse('2026-01-02T00:00:00Z'), updatedAt: Date.parse('2026-01-02T00:00:00Z'), turns: [] });

test('未重定向：桶根就是 home 下的 Documents（沿用历史位置，不受“读不到注册表”影响）', () => {
  const home = tmpRoot('plain');
  const ctx = ctxAt(home);
  const docs = documentsRoot(ctx);
  assert.equal(docs.redirected, false);
  const b = resolveRoot('codex', ctx).bucketRoot;
  assert.equal(path.normalize(b.path), path.normalize(path.join(home, 'Documents', 'Codex')));
  assert.equal(b.validated, true, '没证据说它被搬走时不能拒绝写入');
  assert.ok(docs.source === 'fallback' || docs.source === 'registry' || docs.source === 'home-relative', `source 要如实反映来源，实际 ${docs.source}`);
});

test('重定向且那儿确有宿主自生成目录：认新位置（写侧与判定都跟过去）', () => {
  const home = tmpRoot('redirect-hit');
  const moved = path.join(home, 'D-drive', 'Docs');
  fs.mkdirSync(path.join(moved, 'Codex'), { recursive: true });
  const ctx = ctxAt(home, { documents: moved });
  const b = resolveRoot('codex', ctx).bucketRoot;
  assert.equal(path.normalize(b.path), path.normalize(path.join(moved, 'Codex')));
  assert.equal(b.validated, true);
  assert.ok(INTERNAL_ROOTS(ctx).some((r) => r.variant === 'codex' && path.normalize(r.path) === path.normalize(path.join(moved, 'Codex'))), '判定用的宿主自管根必须同时换到新位置');
  const placed = resolvePlacement(session(path.join(moved, 'Codex', '2026-01-02', 'x')), 'codex', ctx, { targetId: 't1' });
  assert.equal(placed.scope, 'none', '落在重定向后的桶里仍要判成非项目');
});

test('重定向但那儿没有本家目录：判不可信，写侧走 requires-cwd，一个目录都不建', () => {
  const home = tmpRoot('redirect-miss');
  const moved = path.join(home, 'D-drive', 'Docs');
  fs.mkdirSync(moved, { recursive: true });
  const ctx = ctxAt(home, { documents: moved });
  const before = fs.readdirSync(home).sort();
  const b = resolveRoot('codex', ctx).bucketRoot;
  assert.equal(b.validated, false, '重定向过去而宿主从未在那儿生成目录 = 未证实');

  const placed = resolvePlacement(session(''), 'codex', ctx, { targetId: 't1' });
  assert.equal(placed.directory, null);
  assert.equal(placed.source, 'requires-cwd');
  assert.match(placed.hint, /桶根没能证实/);
  assert.ok(placed.warnings.some((w) => w.startsWith('documents-unvalidated')), JSON.stringify(placed.warnings));
  assert.deepEqual(fs.readdirSync(home).sort(), before, '不可信时不得在盘上新建任何目录');

  // 用户点名目录后照写不误（这是 requires-cwd 的既有出口，不是新机制）
  const forced = resolvePlacement(session(''), 'codex', ctx, { targetId: 't1', cwd: path.join(home, 'given') });
  assert.equal(forced.directory, path.join(home, 'given'));
  assert.equal(forced.source, 'flag:cwd');
});

test('桶根不落在「文档」里的家不受影响（workbuddy / zcode 在 home 下）', () => {
  const home = tmpRoot('no-docs');
  const ctx = ctxAt(home, { documents: path.join(home, 'somewhere-else') });
  assert.equal(resolveRoot('workbuddy-cn', ctx).bucketRoot.validated, true);
  assert.equal(path.normalize(resolveRoot('workbuddy-cn', ctx).bucketRoot.path), path.normalize(path.join(home, 'WorkBuddy')));
  assert.equal(resolveRoot('zcode', ctx).bucketRoot.validated, true);
});

test('注册表真读到的重定向：认新位置，并且必须被宿主标记证实', () => {
  const home = tmpRoot('reg-redirect');
  const real = path.join(home, 'E-drive', '我的文档');
  const ctx = ctxAt(home, { documentsProbe: () => real });
  const d = documentsRoot(ctx);
  assert.equal(d.source, 'registry');
  assert.equal(d.redirected, true, '注册表给出的位置与 home 默认不同就必须算重定向');
  assert.equal(resolveRoot('codex', ctx).bucketRoot.validated, false, '那儿还没有 Codex 目录 = 未证实');
  fs.mkdirSync(path.join(real, 'Codex'), { recursive: true });
  assert.equal(resolveRoot('codex', ctxAt(home, { documentsProbe: () => real })).bucketRoot.validated, true);
  assert.equal(path.dirname(path.normalize(resolveRoot('codex', ctxAt(home, { documentsProbe: () => real })).bucketRoot.path)), path.normalize(real));
});

test('注册表读不到（受限环境）：沿用 home 默认位置，不能当成被搬走', () => {
  const home = tmpRoot('reg-miss');
  const ctx = ctxAt(home, { documentsProbe: () => null });
  const d = documentsRoot(ctx);
  assert.equal(d.source, 'fallback');
  assert.equal(d.redirected, false);
  assert.equal(resolveRoot('codex', ctx).bucketRoot.validated, true, '「不知道」不等于「搬走过」');
});

test('dsh 的桶根同样受重定向规则约束', () => {
  const home = tmpRoot('dsh');
  const moved = path.join(home, 'D-drive', 'Docs');
  const ctx = ctxAt(home, { documents: moved });
  assert.equal(resolveRoot('dsh', ctx).bucketRoot.validated, false);
  fs.mkdirSync(path.join(moved, 'deepseek-harness'), { recursive: true });
  assert.equal(resolveRoot('dsh', ctx).bucketRoot.validated, true, '宿主自生成标记一出现就该转为可信');
});
