// M19 测试：先按 id 定位既有正文，再把文件搬到新落点（计划改动清单 6）
//
// 回归的是「目录一变就判成不存在 → 在新目录另起一份」：
//   decide 用的是 reader（全根扫），所以能认出同一 targetId 要 append；
//   但 writer 用 slugFor*(cwd) 拼路径去找文件，旧目录里的完整历史就成了孤儿，
//   新目录只写出增量 → reader 按 mtime 取最新 → 会话变成「只剩新轮次」的残缺副本。
// 因此 append 前必须：按 id 找回既有文件 → 不在目标目录就先整体搬过去（先备份）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCtx } from '../src/hosts.mjs';
import { seedHostSeen } from './matrix-home.mjs';
import { planImport, executePlan } from '../src/import.mjs';
import { readSession } from '../src/readers/index.mjs';
import { findExistingByTargetId, relocateByTargetId } from '../src/writers/base.mjs';

const J = (s) => String(s ?? '').replace(/\\/g, '/');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m19-${name}-`));
}
function ctxFor(root) {
  return seedHostSeen(
    makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: {} }),
    ['pi', 'claude', 'dsh', 'freebuff', 'workbuddy-cn'],
  );
}

/** 源会话：claude 形态（放 claude 目标变体之外，避免和被搬迁的目标正文混在一起） */
function writeClaudeSource(root, id, texts, cwd = 'D:/00-work/code/demo-app') {
  const rows = [];
  let prev = null;
  texts.forEach((t, i) => {
    rows.push({ parentUuid: prev, type: 'user', sessionId: id, cwd, uuid: `${id}-u${i}`, timestamp: `2026-10-08T18:3${i}:21.000Z`, message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ parentUuid: `${id}-u${i}`, type: 'assistant', sessionId: id, cwd, uuid: `${id}-a${i}`, timestamp: `2026-10-08T18:3${i}:30.000Z`, message: { role: 'assistant', model: 'm-1', content: [{ type: 'text', text: `答${t}` }] } });
    prev = `${id}-a${i}`;
  });
  const file = path.join(root, '.claude', 'projects', 'src-p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

/** 源会话：pi 形态（target=claude 时用，源与目标不在同一个根） */
function writePiSource(root, id, texts, cwd = 'D:/00-work/code/demo-app') {
  const slug = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const rows = [{ type: 'session', version: 3, id, cwd, timestamp: '2026-10-08T18:30:21.000Z' }];
  texts.forEach((t, i) => {
    rows.push({ type: 'message', timestamp: `2026-10-08T18:3${i}:21.000Z`, message: { role: 'user', content: [{ type: 'text', text: t }] } });
    rows.push({ type: 'message', timestamp: `2026-10-08T18:3${i}:30.000Z`, message: { role: 'assistant', content: [{ type: 'text', text: `答${t}` }] } });
  });
  const file = path.join(root, '.pi', 'agent', 'sessions', slug, `2026-10-08T18-30-21-000Z_${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

function pathsWithId(root, id) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name.includes(id)) out.push(J(f));
        stack.push(f);
      } else if (e.name.includes(id)) out.push(J(f));
    }
  }
  return out.sort();
}

/** 导一次到目标变体，返回 results */
function importOnce(ctx, from, into, extra = {}) {
  const plan = planImport(ctx, { from: [from], into: [into], ...extra });
  return executePlan(ctx, plan, { apply: true, lock: false });
}

const DIR_A = 'D:/work/dir-a';
const DIR_B = 'D:/work/dir-b';

for (const [target, expectTurns] of [
  ['claude', 2],
  ['pi', 2],
  ['dsh', 2],
  ['freebuff', 2],
  ['workbuddy-cn', 2],
]) {
  test(`${target}：改了落点再 append，正文只能有一份且必须在新目录（含全部轮次）`, () => {
    const root = tmpRoot(`relocate-${target}`);
    // 源与目标不能是同一个变体，否则「源文件」就是「目标文件」，append 永远判成 skip
    const srcVariant = target === 'pi' ? 'claude' : 'pi';
    const writeSource = srcVariant === 'claude' ? writeClaudeSource : writePiSource;
    writeSource(root, 's1', ['第一轮']);
    const ctx = ctxFor(root);

    const first = importOnce(ctx, srcVariant, target, { cwd: DIR_A, placement: 'cwd' });
    assert.equal(first[0]?.ok, true, JSON.stringify(first));
    const targetId = first[0].targetId;
    const rootDir = { claude: path.join(root, '.claude', 'projects'), pi: path.join(root, '.pi', 'agent', 'sessions'), dsh: path.join(root, '.dsh', 'sessions'), freebuff: path.join(root, '.config', 'manicode', 'projects'), 'workbuddy-cn': path.join(root, '.workbuddy', 'projects') }[target];

    // 源长出第二轮 → 第二次导入是 append，且落点已换到 B
    writeSource(root, 's1', ['第一轮', '第二轮']);
    const second = importOnce(ctx, srcVariant, target, { cwd: DIR_B, placement: 'cwd' });
    const r = second.find((x) => x.targetId === targetId);
    assert.equal(r?.ok, true, JSON.stringify(r));
    assert.equal(r.action, 'append', `第二次必须是 append，实际 ${JSON.stringify(r.action)}`);
    assert.ok((r.warnings ?? []).some((w) => /relocat/i.test(String(w))), `必须有搬迁警告：${JSON.stringify(r.warnings)}`);

    const found = pathsWithId(rootDir, targetId);
    // 只算「正文」：宿主按 *.jsonl / 会话目录 取正文，sidecar 与 append 的 .bak 不算第二份
    const bodies = found.filter((p) => {
      const base = p.split('/').pop();
      return base === `${targetId}.jsonl` || base.endsWith(`_${targetId}.jsonl`) || base === String(targetId);
    });
    assert.equal(bodies.length, 1, `同一会话只能有一份正文，实际：${JSON.stringify(found)}`);
    assert.ok(J(bodies[0]).includes('dir-b'), `唯一那份必须在 B 落点下：${bodies[0]}`);

    const back = readSession(target, ctx, targetId).session;
    assert.equal(back.turns.length, expectTurns, `读回必须有 ${expectTurns} 轮（残缺副本就是这个断言抓的）`);
    // 搬迁只改「文件在哪」，不回写历史行里的 cwd（那会动到宿主已成型的事件流）；
    // 新 append 的行用的是本次落点，所以两侧都能接得上。
    assert.ok([J(DIR_A), J(DIR_B)].includes(J(back.cwd)), `读回 cwd 应是新旧落点之一：${back.cwd}`);
    assert.ok(J(bodies[0]).includes('dir-b'), '正文位置必须是本次落点');
  });
}

test('skip 也要跟落点走：内容没变但目录换了，正文必须搬过去（claude）', () => {
  const root = tmpRoot('skip-move');
  writePiSource(root, 's9', ['只有一轮']);
  const ctx = ctxFor(root);

  const first = importOnce(ctx, 'pi', 'claude', { cwd: DIR_A, placement: 'cwd' });
  assert.equal(first[0]?.ok, true, JSON.stringify(first));
  const targetId = first[0].targetId;

  // 内容一字不改，只把落点换到 B → decide 是 skip，但文件必须跟着搬
  const second = importOnce(ctx, 'pi', 'claude', { cwd: DIR_B, placement: 'cwd' });
  const r = second.find((x) => x.targetId === targetId);
  assert.equal(r.action, 'skip', JSON.stringify(r));
  const bodies = pathsWithId(path.join(root, '.claude', 'projects'), targetId).filter((p) => p.endsWith(`${targetId}.jsonl`));
  assert.equal(bodies.length, 1, `只应有一份正文：${JSON.stringify(bodies)}`);
  assert.ok(J(bodies[0]).includes('dir-b'), `正文应已在新落点：${bodies[0]}`);
});

test('findExistingByTargetId：能找回 <id>.jsonl / <ISO>_<id>.jsonl / <id> 目录三种形态', () => {
  const root = tmpRoot('find');
  const slug = path.join(root, '--D--work-dir-a--');
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, '2026-10-08T18-38-21-000Z_tgt_1.jsonl'), '{}\n', 'utf8');
  fs.mkdirSync(path.join(root, 'plain', 'tgt_2'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other', 'unrelated.jsonl'), '{}\n', 'utf8');

  assert.equal(J(findExistingByTargetId(root, 'tgt_1')), J(path.join(slug, '2026-10-08T18-38-21-000Z_tgt_1.jsonl')));
  assert.equal(J(findExistingByTargetId(root, 'tgt_2')), J(path.join(root, 'plain', 'tgt_2')));
  assert.equal(findExistingByTargetId(root, 'tgt_missing'), null);
});

test('relocateByTargetId：先备份再整文件搬，源位置不留残档；已在目标目录时不动', () => {
  const root = tmpRoot('reloc');
  const from = path.join(root, 'slugA');
  const to = path.join(root, 'slugB');
  // 备份根必须在被测根之外，否则「宿主根内零残留」这条就测不出来
  const ctx = { home: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m19-home-')) };
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 't1.jsonl'), '{"a":1}\n', 'utf8');

  const moved = relocateByTargetId(root, 't1', to, { ctx, variant: 'test' });
  assert.equal(moved.moved, true);
  assert.equal(J(moved.path), J(path.join(to, 't1.jsonl')));
  assert.ok(!fs.existsSync(path.join(from, 't1.jsonl')), '旧位置不能再有正文（否则 reader 会挑到陈旧那份）');
  // 备份只允许落在 ~/.session-sync/backups/<变体>/ 下，宿主扫描根里零残留
  assert.ok(moved.backup && J(moved.backup).startsWith(J(path.join(ctx.home, '.session-sync', 'backups', 'test'))), `备份必须落在 session-sync 自己的备份根：${moved.backup}`);
  assert.equal(pathsWithId(root, 't1').filter((p) => p.includes('.bak-')).length, 0, '宿主扫描根内不许留 .bak 残渣');
  assert.equal(pathsWithId(root, 't1').filter((p) => p.endsWith('t1.jsonl')).length, 1, '搬完只剩一份正文');

  const again = relocateByTargetId(root, 't1', to, { ctx, variant: 'test' });
  assert.equal(again.moved, false, '已在目标目录 → 幂等，不重复搬');
});

test('relocateByTargetId：目录形态（dsh / freebuff）整目录搬走', () => {
  const root = tmpRoot('reloc-dir');
  const sessDir = path.join(root, 'slugA', 'dsh_1');
  fs.mkdirSync(path.join(sessDir, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), 'x', 'utf8');

  const moved = relocateByTargetId(root, 'dsh_1', path.join(root, 'slugB'), { ctx: { home: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m19-home2-')) }, variant: 'test' });
  assert.equal(moved.moved, true);
  assert.equal(J(moved.path), J(path.join(root, 'slugB', 'dsh_1')));
  assert.ok(fs.existsSync(path.join(root, 'slugB', 'dsh_1', 'inner')), '目录内层结构必须一起走');
  assert.ok(!fs.existsSync(sessDir));
});
