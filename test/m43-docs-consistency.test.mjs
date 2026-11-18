// M43 测试：文档里的「能力矩阵」必须与注册表一致
//
// 之前的口径是手写的：可写性汇总写「可写（14）」，实际 16；qoder 转可写后没进落点表；
// 变体数在三份文档里各写一遍。这类数字只要靠人同步，迟早会自相矛盾。
// 这里把「谁可写 / 谁只读 / 各类落点有哪些变体」全部从代码派生，再逐条核对文档。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VARIANTS } from '../src/hosts.mjs';
import { WRITABLE_VARIANTS } from '../src/writers/index.mjs';
import { NON_PROJECT_BUCKET } from '../src/placement.mjs';
import { PARTITIONED_VARIANTS, ACCOUNT_MODEL } from '../src/accounts.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const agentSpec = read('references/agent-storage.md');
const programSpec = read('references/program-spec.md');
const skill = read('SKILL.md');
const readme = read('README.md');

const writable = new Set(WRITABLE_VARIANTS);
const all = Object.keys(VARIANTS);
const readonly = all.filter((v) => !writable.has(v));
const family = (v) => v.replace(/-(cn|intl)$/, '');

test('变体数：三份文档都必须等于注册表条目数', () => {
  const n = all.length;
  assert.equal(n, 21, '注册表变体数变了就得同步改这份测试与文档');
  assert.ok(agentSpec.startsWith(`# ${n} 个变体`), `agent-storage.md 标题：${agentSpec.slice(0, 30)}`);
  assert.ok(skill.includes(`支持 ${n} 个变体`), 'SKILL.md 的「支持 N 个变体」过期');
  assert.ok(skill.includes(`${n} 个变体（含各变种）`), 'SKILL.md 的变体数过期');
});

test('可写性汇总：数量与名单都必须由 WRITABLE_VARIANTS 派生', () => {
  const sec = programSpec.split('## 可写性汇总')[1]?.split(/^---$/m)[0] ?? '';
  assert.ok(sec, 'program-spec.md 缺「可写性汇总」小节');
  const head = sec.match(/可写（(\d+)）\s*\|\s*只读（(\d+)）/);
  assert.ok(head, `表头应为「可写（N） | 只读（M）」：${sec.slice(0, 80)}`);
  assert.equal(Number(head[1]), writable.size, '可写数量过期');
  assert.equal(Number(head[2]), readonly.length, '只读数量过期');

  const body = sec.split('\n').filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('可写（'));
  assert.ok(body.length >= 1, '可写性汇总缺表格行');
  const cells = body[0].split('|').map((s) => s.trim());
  const listed = (s) => new Set(s.split('、').map((x) => x.trim()).filter(Boolean));
  assert.deepEqual([...listed(cells[1])].sort(), [...writable].sort(), `可写名单不一致：${cells[1]}`);
  assert.deepEqual([...listed(cells[2])].sort(), readonly.sort(), `只读名单不一致：${cells[2]}`);
});

test('落点表：生成的 / 共享的 / 没有非项目落点的变体，各自只出现在自己那一行', () => {
  const sec = programSpec.split('桶的三种形态')[1]?.split(/^---$/m)[0] ?? '';
  assert.ok(sec, 'program-spec.md 缺「桶的三种形态」表');
  const rowOf = (kind) => sec.split('\n').find((l) => l.startsWith(`| \`${kind}\` |`)) ?? '';
  const rows = { generated: rowOf('generated'), shared: rowOf('shared'), none: rowOf('none') };
  for (const r of Object.values(rows)) assert.ok(r, '三行形态表缺行');

  for (const [variant, spec] of Object.entries(NON_PROJECT_BUCKET)) {
    const hits = Object.entries(rows).filter(([, row]) => row.includes(family(variant))).map(([k]) => k);
    assert.deepEqual(hits, [spec.kind], `${variant} 在落点表里应属于 ${spec.kind}，实际出现在 ${JSON.stringify(hits)}`);
  }
});

test('全矩阵用例覆盖的目标数 = 可写目标数 - 1（claude 自导单独断言）', () => {
  const m7 = read('test/m7-matrix.test.mjs');
  const n = WRITABLE_VARIANTS.length - 1;
  assert.ok(m7.includes(`可写目标全矩阵：${n} 个目标`), `m7 标题里的目标数应为 ${n}`);
  assert.ok(readme.includes(`${n} 个可写目标全矩阵`), `README 矩阵行应为 ${n} 个可写目标`);
});

test('README 能力矩阵：Agent 行与「读/写」列必须由注册表派生', () => {
  const sec = readme.split('## 支持矩阵')[1]?.split(/^---$/m)[0] ?? '';
  assert.ok(sec, 'README 缺「支持矩阵」小节');
  const rows = sec.split('\n').filter((l) => l.startsWith('|')).slice(2);
  const parsed = new Map();
  for (const line of rows) {
    const cells = line.split('|').map((s) => s.trim());
    const agent = cells[1];
    if (!agent) continue;
    parsed.set(agent, { read: cells[3] ?? '', write: cells[4] ?? '' });
  }
  assert.deepEqual([...parsed.keys()].sort(), all.slice().sort(), `矩阵 Agent 行要与注册表一致：${[...parsed.keys()].join(',')}`);
  for (const [v, rw] of parsed) {
    assert.ok(rw.read.startsWith('✅'), `${v} 的「读」应为 ✅（本仓 21 家全部可读）：${rw.read}`);
    assert.equal(rw.write.startsWith('✅'), writable.has(v), `${v} 的「写」与 WRITABLE_VARIANTS 不一致：${rw.write}`);
  }
});

// ---- 账号切换：文档里的「可切名单」必须由 ACCOUNT_MODEL 派生（不靠手抄）----
const cliDoc = read('references/cli.md');
const expand = (name) => (name === 'workbuddy' ? ['workbuddy-cn', 'workbuddy-intl'] : [name]);

test('program-spec.md 标了「可切」的变体集合必须等于 ACCOUNT_MODEL 的 partition 名单', () => {
  const rows = programSpec.split('\n').filter((l) => l.startsWith('| ') && (l.includes('**可切**') || l.includes('不可切')));
  assert.ok(rows.length >= 10, `落点表没解析到账号行，只有 ${rows.length} 行`);
  const switchable = new Set();
  for (const l of rows) {
    if (!l.includes('**可切**')) continue;
    for (const v of expand(l.split('|')[1].trim())) {
      assert.ok(ACCOUNT_MODEL[v], `${v} 不在注册表里`);
      assert.equal(ACCOUNT_MODEL[v].kind, 'partition', `${v} 被文档说成可切，但模型不是 partition`);
      switchable.add(v);
    }
  }
  assert.deepEqual([...switchable].sort(), [...PARTITIONED_VARIANTS].sort(), 'program-spec.md 的可切名单与代码不一致');
});

test('README 换账号段与 SKILL 能力边界都要按 partition 名单说话', () => {
  const sec = readme.split('## 换账号')[1]?.split(/^---$/m)[0] ?? '';
  assert.ok(sec, 'README 缺「换账号」小节');
  const aliases = { 'codebuddy-ide': 'CodeBuddy IDE', 'workbuddy-cn': 'WorkBuddy', 'workbuddy-intl': 'WorkBuddy', codex: 'Codex' };
  for (const v of PARTITIONED_VARIANTS) {
    assert.ok(sec.includes(aliases[v] ?? v), `README 换账号段没提 ${v}`);
  }
  assert.ok(skill.includes(`只有 ${PARTITIONED_VARIANTS.length} 个变体可做`), 'SKILL.md 的「换账号可做数量」过期');
});

test('references/cli.md 的 switch-account 写入动作表要覆盖每个 partition 变体', () => {
  const sec = cliDoc.split('## switch-account')[1]?.split(/^---$/m)[0] ?? '';
  assert.ok(sec, 'cli.md 缺 switch-account 小节');
  for (const v of PARTITIONED_VARIANTS) assert.ok(sec.includes('`' + v + '`'), `按宿主动什么表缺 ${v}`);
  assert.match(sec, /codebuddy-ide[\s\S]{0,600}?补[^\n]*project|会补 project/, '必须写清 codebuddy-ide 切换时要补项目（用户提的那个坑）');
});

