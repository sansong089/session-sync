// M39 测试：目标正文「读不懂」时必须中止，绝不把整段历史压成增量
//
// 真机形态复现：宿主把 rollout 压成 .jsonl.zst，其中一行被截断/写坏 →
// 旧实现 readTargetLines 的 catch 返回 []，append 把「空历史 + 增量」重新压回同一文件，
// 实测 11 行变 2 行且仍返回 ok:true。同一形状在 cline 会话库 / cline 任务目录 / freebuff / dsh 各一份
// （凡是从解析结果整份重写文件/库的写法都有这个风险；纯 O_APPEND 的没有）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeCtx } from '../src/hosts.mjs';
import { getWriter } from '../src/writers/index.mjs';
import { makeSession, messageItem } from '../src/ir.mjs';

process.env.SESSION_SYNC_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m39-locks-'));

const T0 = 1791484221000;
function mk(variant, cwd, n) {
  return makeSession({
    id: 's1', variant, title: '坏数据不覆盖', cwd,
    createdAt: T0, updatedAt: T0 + n * 1000, model: 'm-1',
    turns: Array.from({ length: n }, (_, i) => ({
      index: i, role: 'user', startedAt: T0 + i * 1000,
      items: [messageItem('user', `问${i}`, T0 + i * 1000), messageItem('assistant', `答${i}`, T0 + i * 1000)],
    })),
    meta: {},
  });
}
function home(name, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ss-m39-${name}-`));
  return { root, ctx: makeCtx({ home: root, platform: 'win32', appData: path.join(root, 'AppData', 'Roaming'), env: extra, cwd: root }) };
}
function bytes(file) { return fs.readFileSync(file); }
function assertIntact(before, file, label) {
  const after = bytes(file);
  assert.deepEqual(after, before, `${label}：中止时目标文件必须逐字节不变`);
}

test('codex：.jsonl.zst 里有坏行 → 中止且不覆盖历史', () => {
  const { ctx } = home('codex', { CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m39-codexhome-')) });
  const w = getWriter('codex');
  const r1 = w.write(ctx, { session: mk('codex', 'D:/work/demo', 5), targetId: 't1', mode: 'create', provenance: null, force: true });
  const plain = r1.path;
  const zst = `${plain}.zst`;
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(fs.readFileSync(plain, 'utf8'), 'utf8')));
  fs.rmSync(plain);
  const lines = zlib.zstdDecompressSync(fs.readFileSync(zst)).toString('utf8').split('\n').filter(Boolean);
  lines[3] = '{"parentUuid": "broken';
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));

  const before = bytes(zst);
  const r2 = w.write(ctx, { session: mk('codex', 'D:/work/demo', 6), targetId: 't1', mode: 'append', fromTurnIndex: 5, provenance: null });
  assert.equal(r2.ok, false, `必须失败，实际 ok=${r2.ok}`);
  assert.match(String(r2.error), /unreadable-target/, `错误码必须是 unreadable-target：${r2.error}`);
  assertIntact(before, zst, 'codex .zst');
});

test('cline 会话库：messages.json 畸形 → 中止且不覆盖', () => {
  const { ctx } = home('cline');
  ctx.env.CLINE_DATA_DIR = path.join(ctx.home, '.cline', 'data');
  const w = getWriter('cline');
  const r1 = w.write(ctx, { session: mk('cline', 'D:/work/demo', 4), targetId: '1739441239770_x1', mode: 'create', provenance: null, force: true });
  const mf = r1.path;
  const text = fs.readFileSync(mf, 'utf8');
  fs.writeFileSync(mf, `${text.slice(0, Math.floor(text.length / 2))}…截断…`);
  const before = bytes(mf);
  const r2 = w.write(ctx, { session: mk('cline', 'D:/work/demo', 5), targetId: '1739441239770_x1', mode: 'append', fromTurnIndex: 4, provenance: null });
  assert.equal(r2.ok, false, '必须失败');
  assert.match(String(r2.error), /unreadable-target/);
  assertIntact(before, mf, 'cline messages.json');
});

test('cline 任务目录：api_conversation_history.json 畸形 → 中止且不覆盖', () => {
  const { ctx } = home('kilo-legacy');
  const w = getWriter('kilo');
  const dir = path.join(ctx.appData, 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks', '1739441239771');
  fs.mkdirSync(dir, { recursive: true });
  const apiFile = path.join(dir, 'api_conversation_history.json');
  const good = JSON.stringify([
    { role: 'user', ts: T0, content: [{ type: 'text', text: '问1' }] },
    { role: 'assistant', ts: T0, content: [{ type: 'text', text: '答1' }] },
    { role: 'user', ts: T0, content: [{ type: 'text', text: '问2' }] },
    { role: 'assistant', ts: T0, content: [{ type: 'text', text: '答2' }] },
  ]);
  fs.writeFileSync(apiFile, `${good.slice(0, good.length - 6)}XXX]`);
  const before = bytes(apiFile);
  const r = w.write(ctx, { session: mk('kilo', 'D:/work/demo', 3), targetId: '1739441239771', mode: 'append', fromTurnIndex: 2, provenance: null });
  assert.equal(r.ok, false, `必须失败，实际 ${JSON.stringify(r)}`);
  assert.match(String(r.error), /unreadable-target/);
  assertIntact(before, apiFile, 'cline api_conversation_history.json');
});

test('freebuff：chat-messages.json 畸形 → 中止且不覆盖', () => {
  const { ctx } = home('freebuff');
  ctx.env.FREEBUFF_CONFIG_DIR = path.join(ctx.home, '.config', 'manicode');
  const w = getWriter('freebuff');
  const r1 = w.write(ctx, { session: mk('freebuff', 'D:/work/demo', 4), targetId: '2026-08-05T01-30-13.033Z', mode: 'create', provenance: null, force: true });
  const mf = path.join(r1.path, 'chat-messages.json');
  const text = fs.readFileSync(mf, 'utf8');
  fs.writeFileSync(mf, `${text.slice(0, Math.floor(text.length / 2))}坏尾`);
  const before = bytes(mf);
  const r2 = w.write(ctx, { session: mk('freebuff', 'D:/work/demo', 5), targetId: '2026-08-05T01-30-13.033Z', mode: 'append', fromTurnIndex: 4, provenance: null });
  assert.equal(r2.ok, false, '必须失败');
  assert.match(String(r2.error), /unreadable-target/);
  assertIntact(before, mf, 'freebuff chat-messages.json');
});

test('dsh：整帧解不开 → 中止且不覆盖', () => {
  const root = path.join(os.tmpdir(), `ss-m39-dsh-${process.pid}`);
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const { ctx } = home('dsh');
  ctx.env.DSH_HOME = root;
  const w = getWriter('dsh');
  const r1 = w.write(ctx, { session: mk('dsh', 'D:/work/demo', 4), targetId: 'session-dsh-1', mode: 'create', provenance: null, force: true });
  fs.writeFileSync(r1.path, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('这不是可解的 zstd 载荷'.repeat(20))]));
  const before = bytes(r1.path);
  const r2 = w.write(ctx, { session: mk('dsh', 'D:/work/demo', 5), targetId: 'session-dsh-1', mode: 'append', fromTurnIndex: 4, provenance: null });
  assert.equal(r2.ok, false, '必须失败');
  assert.match(String(r2.error), /unreadable-target/);
  assertIntact(before, r1.path, 'dsh session.v4.jsonl.zstd');
});

test('codex：--force 覆盖压缩目标时保持压缩态（别把明文写进 .zst 名字里）', () => {
  const { ctx } = home('codex-force', { CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m39-codexhome-')) });
  const w = getWriter('codex');
  const r1 = w.write(ctx, { session: mk('codex', 'D:/work/demo', 3), targetId: 't2', mode: 'create', provenance: null, force: true });
  const zst = `${r1.path}.zst`;
  fs.writeFileSync(zst, zlib.zstdCompressSync(fs.readFileSync(r1.path)));
  fs.rmSync(r1.path);

  const r2 = w.write(ctx, { session: mk('codex', 'D:/work/demo', 4), targetId: 't2', mode: 'create', provenance: null, force: true });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.path, zst, '应复用既有 .zst，不是另起一份同 id 明文');
  const text = zlib.zstdDecompressSync(fs.readFileSync(zst)).toString('utf8');
  assert.match(text, /"type":"session_meta"/, '解压后必须是完整 JSONL 正文');
});

test('claude 系（pi / workbuddy / qoder 同一条规则）：目标每行都解不开 → create 不覆盖', () => {
  for (const variant of ['claude', 'pi', 'workbuddy-cn', 'qoder-cn']) {
    const { ctx } = home(variant);
    const w = getWriter(variant);
    const r1 = w.write(ctx, { session: mk(variant, 'D:/work/demo', 3), targetId: 't3', mode: 'create', provenance: null, force: true });
    const file = r1.path && fs.existsSync(r1.path) ? r1.path : null;
    assert.ok(file, `${variant}：create 应落正文文件（实际 path=${r1.path}）`);
    fs.writeFileSync(file, '这不是 JSON\n也不是 JSON\n');
    const before = bytes(file);
    const r2 = w.write(ctx, { session: mk(variant, 'D:/work/demo', 4), targetId: 't3', mode: 'create', provenance: null });
    assert.equal(r2.ok, false, `${variant}：必须失败，实际 ${JSON.stringify(r2)}`);
    assert.match(String(r2.error), /unreadable-target/, `${variant}：应报 unreadable-target，实际 ${r2.error}`);
    assertIntact(before, file, `${variant} jsonl`);
  }
});

test('空目标仍可追加（不能把「真的没内容」也拒了）', () => {
  const { ctx } = home('codex-empty');
  const w = getWriter('codex');
  const r = w.write(ctx, { session: mk('codex', 'D:/work/demo', 2), targetId: 't-empty', mode: 'append', fromTurnIndex: 0, provenance: null });
  assert.equal(r.ok, true, JSON.stringify(r));
});
