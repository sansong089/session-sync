// m73 — 可观测性：采样标志、迁移落点、探测预算、备份落点
//
// 四件事的共同点是「内部算出来了但不说」：
//   ① `turnsApprox`：采样得到的轮数是近似值，不透出的话「0 轮」会被当成真的空会话
//   ② `placed`：迁移过的会话靠它解释「为什么在这个项目下」，list/show 却都没吐
//   ③ 探测预算烧光（本机实测 8000 目录上限真的会撞到）：此时「not installed」只代表没找到
//   ④ 备份曾散在宿主目录（`xxx.bak-<ts>`），dsh/freebuff 会把它读成第二条会话
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeStats } from '../src/roots.mjs';
import { sandboxEnv } from './matrix-home.mjs';
import { makeCtx } from '../src/hosts.mjs';
import { backupsOf, strayBackups } from './backup-fixture.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'session-sync.mjs');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m73-${name}-`));
}

function cli(home, args) {
  const env = sandboxEnv(home, { SESSION_SYNC_LOCK_DIR: path.join(home, 'locks') });
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') };
}

function cliJson(home, args) {
  const r = cli(home, args);
  let json = null;
  try {
    json = JSON.parse(r.out);
  } catch {
    /* 交给调用方断言 */
  }
  return { ...r, json };
}

function mkClaude(home, id, text) {
  const rows = [
    { parentUuid: null, type: 'user', sessionId: id, cwd: 'D:/w', uuid: `${id}-u1`, timestamp: '2026-10-08T18:38:21.000Z', message: { role: 'user', content: [{ type: 'text', text }] } },
    { parentUuid: `${id}-u1`, type: 'assistant', sessionId: id, cwd: 'D:/w', uuid: `${id}-a1`, timestamp: '2026-10-08T18:38:30.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答' }] } },
  ];
  const f = path.join(home, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}


function mkClaude2(home, id, texts) {
  const rows = [];
  let parent = null;
  texts.forEach((text, i) => {
    const u = `${id}-u${i}`;
    const a = `${id}-a${i}`;
    rows.push({ parentUuid: parent, type: 'user', sessionId: id, cwd: 'D:/w', uuid: u, timestamp: `2026-10-08T18:3${i}:21.000Z`, message: { role: 'user', content: [{ type: 'text', text }] } });
    rows.push({ parentUuid: u, type: 'assistant', sessionId: id, cwd: 'D:/w', uuid: a, timestamp: `2026-10-08T18:3${i}:30.000Z`, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: '答' }] } });
    parent = a;
  });
  const f = path.join(home, '.claude', 'projects', 'p', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('list --json 必须透出 turnsApprox 与 placed（否则调用方无法区分「空会话」和「没读完」）', () => {
  const home = tmpRoot('list-json');
  try {
    mkClaude(home, 's1', '第一问');
    const r = cliJson(home, ['list', '--from', 'claude', '--json']);
    assert.equal(r.code, 0, r.out + r.err);
    const row = r.json.sessions.find((s) => s.id === 's1');
    assert.ok(row, JSON.stringify(r.json.sessions));
    assert.equal(row.turnsApprox, false, '精确读取必须是 false（不是缺字段）');
    assert.ok('placed' in row, 'placed 字段必须在（未迁移时为 null）');
    assert.equal(row.placed, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('导入到非原生宿主后：placed 记账随 list/show 一起透出', () => {
  const home = tmpRoot('placed');
  try {
    mkClaude(home, 's2', '第一问');
    // 沙箱里 pi 没有落点，写侧要给钉住的根（否则 write-root-unpinned，什么都不会落）
    const imp = cliJson(home, ['import', '--from', 'claude', '--into', 'pi', '--data-root', `pi=${path.join(home, '.pi')}`, '--apply', '--json']);
    assert.equal(imp.code, 0, imp.out + imp.err);
    const targetId = imp.json.results?.[0]?.targetId;
    assert.ok(targetId, JSON.stringify(imp.json));

    const list = cliJson(home, ['list', '--from', 'pi', '--json']);
    const row = list.json.sessions.find((s) => s.id === targetId);
    assert.ok(row, JSON.stringify(list.json.sessions));
    assert.ok(row.placed, `迁移过的会话必须带落点记账：${JSON.stringify(row)}`);
    assert.equal(typeof row.placed.directory, 'string');
    assert.ok(row.placed.scope === 'project' || row.placed.scope === 'none');

    const show = cliJson(home, ['show', '--from', 'pi', targetId, '--json']);
    assert.equal(show.code, 0, show.out + show.err);
    assert.deepEqual(show.json.placed, row.placed, 'show 与 list 的落点口径必须一致');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('detect 必须透出探测预算状态；沙箱小目录下不算耗尽', () => {
  const home = tmpRoot('probe');
  try {
    mkClaude(home, 's3', '第一问');
    const r = cliJson(home, ['detect', '--json']);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.json.probe, 'detect --json 必须带 probe 记账');
    assert.equal(typeof r.json.probe.visited, 'number');
    assert.equal(typeof r.json.probe.truncated, 'boolean');
    assert.ok(r.json.probe.maxDirs > 0 && r.json.probe.budgetMs > 0);
    // 是否耗尽取决于真实环境的目录规模（本机实测会撞 8000 上限），所以只断言「说了实话」：
    // 文本里出现「预算耗尽」就必须同时点明「没找到 ≠ 没装」，不出现就说明没耗尽。
    const txt = cli(home, ['detect']);
    assert.equal(txt.code, 0);
    const said = txt.out.includes('probe: 预算耗尽');
    assert.equal(said, r.json.probe.truncated, 'JSON 的 truncated 与文本提示必须一致（不能一个说耗尽、一个不说）');
    if (said) assert.match(txt.out, /只代表没找到/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probeStats 未探测时给零值而不是抛（detect 在没有 ctx 缓存的路径上也安全）', () => {
  const ctx = makeCtx({ home: tmpRoot('probe-empty'), env: {} });
  const s = probeStats(ctx);
  assert.equal(s.visited, 0);
  assert.equal(s.truncated, false);
});

test('备份只落在 ~/.session-sync/backups/<变体>/，宿主扫描根里零 .bak 残渣', () => {
  const home = tmpRoot('backup-loc');
  try {
    mkClaude(home, 's4', '第一问');
    const first = cliJson(home, ['import', '--from', 'claude', '--into', 'pi', '--data-root', `pi=${path.join(home, '.pi')}`, '--apply', '--json']);
    assert.equal(first.code, 0, first.out + first.err);
    const targetId = first.json.results[0].targetId;

    // 源侧新增一轮 → 复跑走 append（覆盖已有正文前必须留快照），这才会有备份产生
    mkClaude2(home, 's4', ['第一问', '第二问']);
    const again = cliJson(home, ['import', '--from', 'claude', '--into', 'pi', '--data-root', `pi=${path.join(home, '.pi')}`, '--apply', '--json']);
    assert.ok(again.json.ok !== false, again.out);
    assert.equal(again.json.summary?.['written:append'], 1, `复跑必须走 append：${JSON.stringify(again.json.summary)}`);

    const stray = strayBackups(path.join(home, '.pi'));
    assert.deepEqual(stray, [], `宿主扫描根内不许留 .bak：${stray.join(', ')}`);
    assert.ok(fs.existsSync(path.join(home, '.session-sync', 'backups')), '备份根必须建在 session-sync 自己的目录下');
    // 有备份就必须在备份根里（不能既说备份了、又找不到）
    const all = [...backupsOf(home, 'pi'), ...backupsOf(home, 'claude')];
    for (const f of all) {
      assert.ok(f.startsWith(path.join(home, '.session-sync', 'backups')), `备份落在备份根之外：${f}`);
    }
    assert.ok(all.length >= 1, `写前快照必须真的落盘：targetId=${targetId}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
