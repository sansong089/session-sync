// M66 测试：标题改写不再抹掉宿主并发追加的轮次（review 2026-11-04 的 P0-1）
//
// 根因：标题同步走「读整份正文 → 改一行 → 整份覆盖」。宿主在这期间追加了一轮，
// 我们的覆盖会把它抹掉 —— 用户丢的是自己的对话内容，不是标题。
//
// 三道闸：
//   1) writeFileAtomic 支持 expectSize / expectMtimeMs：目标不是我们读到的那一版就拒写
//   2) rewriteFirstJsonlField 自带快照 + 命中冲突返回 retryable（不抛、不写）
//   3) updateBodyRow 重读重试 3 次；用尽仍冲突 → 记 warning，不让整条导入失败
//
// 同时锁定 pick 语义：first（宿主取第一条）/ last（宿主最后一条胜出）/ all（与取值顺序解耦）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewriteFirstJsonlField, writeFileAtomic } from '../src/writers/base.mjs';
import { applyTitleSlots } from '../src/writers/title-slots.mjs';

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ss-m66-${name}-`));
}

/** 造一份含标题行的 jsonl；返回 {file, read} */
function makeJsonl(home, rows) {
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, `${rows.map((o) => JSON.stringify(o)).join('\n')}\n`);
  return {
    file,
    read: () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test('writeFileAtomic：目标被改过就拒写，且不动磁盘上的现有内容', () => {
  const home = tmpHome('cas');
  try {
    const file = path.join(home, 'x.jsonl');
    fs.writeFileSync(file, 'old\n');
    const st = fs.statSync(file);
    // 模拟「读完之后别人改了这个文件」
    fs.writeFileSync(file, 'old\nsomeone-else\n');
    assert.throws(
      () => writeFileAtomic(file, 'mine\n', { expectSize: st.size }),
      (err) => err.code === 'CONCURRENT_MODIFICATION',
      '大小对不上必须抛 CONCURRENT_MODIFICATION',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old\nsomeone-else\n', '拒写后别人那份必须完好');
    const leftovers = fs.readdirSync(home).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '临时文件必须清掉，不留垃圾给宿主扫描');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeFileAtomic：mtime 变了也拒写（大小相同的原地重写靠它兜）', () => {
  const home = tmpHome('cas-mtime');
  try {
    const file = path.join(home, 'x.jsonl');
    fs.writeFileSync(file, 'a\n');
    const st = fs.statSync(file);
    fs.writeFileSync(file, 'b\n'); // 同长度、不同内容：只有 mtime 能看出变化
    // 同毫秒内的写入 mtime 可能相同（NTFS 报的是毫秒精度），显式拨开才能验证机制本身
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    assert.throws(
      () => writeFileAtomic(file, 'c\n', { expectMtimeMs: st.mtimeMs }),
      (err) => err.code === 'CONCURRENT_MODIFICATION',
      'mtime 对不上必须抛',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'b\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('标题改写：宿主在读取与写回之间追加了一轮 → 返回 retryable，且那一轮还在', () => {
  const home = tmpHome('race');
  try {
    const { file, read } = makeJsonl(home, [
      { type: 'ai-title', aiTitle: '旧名' },
      { type: 'message', id: 'm1', text: '第1轮' },
    ]);
    const realRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function (p, ...rest) {
      const out = realRead.call(this, p, ...rest);
      if (String(p) === file && !injected) {
        injected = true;
        // 宿主就在这一刻追加了一轮
        fs.appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'm2', text: '宿主刚写的第2轮' })}\n`);
      }
      return out;
    };
    let r;
    try {
      r = rewriteFirstJsonlField(file, 'ai-title', 'aiTitle', '新名', { ctx: { home }, variant: 'test' });
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(r.changed, false, '冲突时不许假装改成功');
    assert.equal(r.reason, 'concurrent-modification');
    assert.equal(r.retryable, true, '必须标成可重试，调用方才知道能再来一次');
    const rows = read();
    assert.ok(rows.some((x) => x.id === 'm2'), '宿主追加的那一轮必须还在（这正是原缺陷丢掉的）');
    assert.equal(rows.find((x) => x.type === 'ai-title').aiTitle, '旧名', '冲突时标题也不该被改');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('标题改写：冲突后重试能成功，且两次的内容都在', () => {
  const home = tmpHome('retry');
  try {
    const { file, read } = makeJsonl(home, [
      { type: 'ai-title', aiTitle: '旧名' },
      { type: 'message', id: 'm1', text: '第1轮' },
    ]);
    const realRead = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function (p, ...rest) {
      const out = realRead.call(this, p, ...rest);
      if (String(p) === file && !injected) {
        injected = true;
        fs.appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'm2', text: '第2轮' })}\n`);
      }
      return out;
    };
    let r;
    try {
      // 槽机制自带 3 次重试：第一次撞冲突，第二次重读（这次不注入了）成功
      r = applyTitleSlots({ home }, [{ kind: 'body-row', file: () => file, type: 'ai-title', field: 'aiTitle' }], {
        targetId: 's1',
        title: '新名',
        variant: 'test',
      });
    } finally {
      fs.readFileSync = realRead;
    }
    assert.equal(r.changed, true, '重试后必须真的改到');
    assert.deepEqual(r.warnings, [], '重试成功不算警告');
    const rows = read();
    assert.equal(rows.find((x) => x.type === 'ai-title').aiTitle, '新名');
    assert.ok(rows.some((x) => x.id === 'm2'), '重试也不能抹掉宿主那一轮');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('标题改写：同值不写盘（避免每次都重写整份正文）', () => {
  const home = tmpHome('noop');
  try {
    const { file } = makeJsonl(home, [{ type: 'ai-title', aiTitle: '同名' }]);
    const before = fs.statSync(file).mtimeMs;
    const r = rewriteFirstJsonlField(file, 'ai-title', 'aiTitle', '同名', { ctx: { home }, variant: 'test' });
    assert.equal(r.changed, false);
    assert.equal(r.reason, 'already-equal');
    assert.equal(fs.statSync(file).mtimeMs, before, '同值不该碰文件');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pick 语义：first 只改第一条 / last 只改最后一条 / all 全改', () => {
  const home = tmpHome('pick');
  try {
    const rows = () => [
      { type: 'ai-title', aiTitle: 'A' },
      { type: 'message', id: 'm1' },
      { type: 'ai-title', aiTitle: 'B' },
      { type: 'message', id: 'm2' },
      { type: 'ai-title', aiTitle: 'C' },
    ];
    const titles = (file) =>
      fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.type === 'ai-title').map((o) => o.aiTitle);

    const f1 = makeJsonl(home, rows()).file;
    rewriteFirstJsonlField(path.join(home, 'session.jsonl'), 'ai-title', 'aiTitle', 'X', { pick: 'first', ctx: { home }, variant: 'test' });
    assert.deepEqual(titles(f1), ['X', 'B', 'C'], 'first：宿主取第一条胜出（WorkBuddy 形态）');

    fs.writeFileSync(f1, `${rows().map((o) => JSON.stringify(o)).join('\n')}\n`);
    rewriteFirstJsonlField(f1, 'ai-title', 'aiTitle', 'X', { pick: 'last', ctx: { home }, variant: 'test' });
    assert.deepEqual(titles(f1), ['A', 'B', 'X'], 'last：宿主顺序消费最后一条胜出（claude 形态）');

    fs.writeFileSync(f1, `${rows().map((o) => JSON.stringify(o)).join('\n')}\n`);
    rewriteFirstJsonlField(f1, 'ai-title', 'aiTitle', 'X', { pick: 'all', ctx: { home }, variant: 'test' });
    assert.deepEqual(titles(f1), ['X', 'X', 'X'], 'all：与宿主取值顺序解耦（dsh 形态）');

    // 默认值仍是 first（既有调用方语义不变）
    fs.writeFileSync(f1, `${rows().map((o) => JSON.stringify(o)).join('\n')}\n`);
    rewriteFirstJsonlField(f1, 'ai-title', 'aiTitle', 'X', { ctx: { home }, variant: 'test' });
    assert.deepEqual(titles(f1), ['X', 'B', 'C'], '不传 pick 时默认 first');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('标题改写：坏行不参与也不被破坏（整份重写不许毁别人的历史）', () => {
  const home = tmpHome('badline');
  try {
    const file = path.join(home, 'session.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'message', id: 'm1' })}\n{坏行不是JSON\n${JSON.stringify({ type: 'ai-title', aiTitle: '旧名' })}\n`,
    );
    const r = rewriteFirstJsonlField(file, 'ai-title', 'aiTitle', '新名', { ctx: { home }, variant: 'test' });
    assert.equal(r.changed, true);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('{坏行不是JSON'), '坏行必须原样保留');
    assert.ok(text.includes('"aiTitle":"新名"'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
