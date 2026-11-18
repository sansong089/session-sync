// M76 测试：环境判别规则的棘轮（规格 = references/environment.md）
//
// 为什么需要这份棘轮：「当前跑在哪个宿主里」的判定散在指纹表、兜底分支、mtime 启发式、
// CLI 默认目标与写根选择里，任何一处新增「判不出来就落默认」都会静默把会话导到另一个安装。
// 规则本身写在 references/environment.md（R1–R6），这里把它变成可执行断言，并把存量违规
// 登记成只减不增的债表 —— 新增违规立刻红，修好后不下调上限同样红。
//
// 本期边界：只立规矩，不改运行时代码（src/ 零改动是本期最硬的自证）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_VARIANTS, VARIANTS, detectHost, makeCtx, workbuddyRoot } from '../src/hosts.mjs';
import { auditSource, branchesOf, classify, markerEntries, parseDoc, ratchetDiff, readText, tally, RULES, REACH_RANK } from './env-audit.mjs';
import { WRITERS } from '../src/writers/index.mjs';
import { invalidateRoots } from '../src/roots.mjs';

const DOC = readText('references/environment.md');
const { coords, registry } = parseDoc(DOC);
const REPORT = auditSource();

// ---- 存量违规债表：只减不增；每条必须写明为什么还留着 ----
// 已全部清零，这张表必须保持为空 —— 任何一行新命中都要先写明理由才能合入。
//   R1/R3     中英判别改为带值匹配、排除法兜底删除
//   R6(hosts) heuristic 只回 hint 不产 variant；(cli) `--into` 缺省只认 identified；
//   R6(cb-ide) 写根改按账号/IDE 坐标（活动度只解释「哪个在用」，不决定「该写哪儿」）
//   R3-g      kilo 代际三态（db / tasks / 未安装），代际判定收敛成一个出口
const DEBT = {};

// 没有任何宿主指纹的变体：只能被判成 unknown（不是漏写用例）
const NO_SIGNAL_DEBT = ['antigravity', 'codebuddy-ide', 'roo', 'doubao'];

// 规格模型判 ambiguous/unknown，而运行时硬给出一个变体的用例。这是 R1/R3 缺陷的可执行证据。
// 已清空：workbuddy 版本号、qoder 自定义目录两处都不再产出变体 —— 一旦有人加回来，parity 用例立刻红。
const RUNTIME_OVERIDENTIFY = [];

const DETECTION_CASES = [
  { id: 'opencode', env: { OPENCODE_BIN: '/usr/local/bin/opencode' }, expect: { state: 'identified', variant: 'opencode' }, evidence: '【源码】', why: 'OPENCODE_BIN 是 opencode 自己的进程变量，充分' },
  { id: 'claude', env: { CLAUDECODE: '1' }, expect: { state: 'identified', variant: 'claude' }, evidence: '【源码】', why: 'CLAUDECODE 只在 claude 进程里出现，充分' },
  { id: 'pi', env: { PI_HOME: 'C:/u/.pi' }, expect: { state: 'identified', variant: 'pi' }, evidence: '【源码】', why: 'PI_HOME 是 pi 的官方根变量，充分' },
  { id: 'codex', env: { CODEX_HOME: 'C:/u/.codex' }, expect: { state: 'identified', variant: 'codex' }, evidence: '【源码】', why: 'CODEX_HOME 是 codex 的官方根变量，充分' },
  { id: 'codebuddy', env: { CODEBUDDY_CONFIG_DIR: 'C:/u/.codebuddy' }, expect: { state: 'identified', variant: 'codebuddy' }, evidence: '【源码】', why: '值匹配 .codebuddy 才能判 CLI，光有键只到家族级' },
  { id: 'workbuddy-cn', env: { CODEBUDDY_CONFIG_DIR: 'C:/u/.workbuddy' }, expect: { state: 'identified', variant: 'workbuddy-cn' }, evidence: '【待证 待证-workbuddy-2】', why: '值匹配 .workbuddy 能区分中英，但是否真导出该变量待证' },
  { id: 'workbuddy-intl', env: { CODEBUDDY_CONFIG_DIR: 'C:/u/.workbuddy-ai' }, expect: { state: 'identified', variant: 'workbuddy-intl' }, evidence: '【源码】', why: '值匹配 .workbuddy-ai 才成立，不能靠版本号变量' },
  { id: 'workbuddy-cfg-dir-cn', env: { WORKBUDDY_CONFIG_DIR: 'C:/u/.workbuddy' }, expect: { state: 'identified', variant: 'workbuddy-cn' }, evidence: '【真机】', why: '本机中文版桌面进程导出的就是这条，根名 .workbuddy 是中文版的正面证据' },
  { id: 'workbuddy-cfg-dir-intl', env: { WORKBUDDY_CONFIG_DIR: 'C:/u/.workbuddy-ai' }, expect: { state: 'identified', variant: 'workbuddy-intl' }, evidence: '【待证 待证-workbuddy-3】', why: '值匹配 .workbuddy-ai 才是国际版的正面证据，缺真机样本' },
  { id: 'workbuddy-folder-cn', env: { WORKBUDDY_DATA_FOLDER_NAME: '.workbuddy' }, expect: { state: 'identified', variant: 'workbuddy-cn' }, evidence: '【真机】', why: '根名变量给的是目录名而不是路径，值 .workbuddy 同样能定中文版' },
  { id: 'qoder-cn', env: { QODER_CONFIG_DIR: 'C:/u/.qoder-cn' }, expect: { state: 'identified', variant: 'qoder-cn' }, evidence: '【真机】', why: 'QODER_CONFIG_DIR 指向 .qoder-cn 是中文版的正面证据' },
  { id: 'qoder-intl', env: { QODER_CONFIG_DIR: 'C:/u/.qoder' }, expect: { state: 'identified', variant: 'qoder-intl' }, evidence: '【待证 待证-qoder-1】', why: '值匹配 .qoder 才算国际版的正面证据，缺了就只能靠排除法' },
  { id: 'zcode', env: { ZCODE_HOME: 'C:/u/.zcode' }, expect: { state: 'identified', variant: 'zcode' }, evidence: '【源码】', why: 'ZCODE_HOME 是 zcode 的官方根变量，充分' },
  { id: 'mimo', env: { MIMOCODE_BIN_PATH: 'C:/m/mimo.exe' }, expect: { state: 'identified', variant: 'mimo' }, evidence: '【真机】', why: 'MIMOCODE_* 前缀是 MiMo 宿主的进程指纹' },
  { id: 'minimax', env: { MINIMAX_HOME: 'C:/u/.minimax' }, expect: { state: 'identified', variant: 'minimax' }, evidence: '【源码】', why: 'MINIMAX_HOME 是 minimax 的官方根变量，充分' },
  { id: 'dsh', env: { DSH_HOME: 'C:/u/.dsh' }, expect: { state: 'identified', variant: 'dsh' }, evidence: '【源码】', why: 'DSH_HOME 是 dsh 的官方根变量，充分' },
  { id: 'freebuff', env: { FREEBUFF_CONFIG_DIR: 'C:/u/.config/manicode' }, expect: { state: 'identified', variant: 'freebuff' }, evidence: '【源码】', why: 'FREEBUFF_CONFIG_DIR 是 freebuff 的根变量，充分' },
  { id: 'cline', env: { CLINE_TASKS_DIRS: 'C:/u/tasks' }, expect: { state: 'identified', variant: 'cline' }, evidence: '【源码】', why: 'CLINE_TASKS_DIRS 是我们认的钉住变量，能定 cline 产品' },
  { id: 'kilo', env: { KILO_DB: 'C:/u/.kilo/kilo.db' }, expect: { state: 'identified', variant: 'kilo' }, evidence: '【源码】', why: 'KILO_DB 是我们认的钉住变量，能定 kilo 产品' },
  { id: 'cursor', env: { CURSOR_AGENT: '1' }, expect: { state: 'identified', variant: 'cursor' }, evidence: '【源码】', why: 'CURSOR_AGENT 是 cursor 自己的进程变量，充分' },
  { id: 'workbuddy-version-only', env: { WORKBUDDY_APP_VERSION: '5.9.3' }, expect: { state: 'ambiguous', dim: 'edition' }, evidence: '【真机】', why: '版本号是两个版本共有的产品级信号，不能判中英，只能报无法确定' },
  { id: 'codebuddy-dir-edition-unknown', env: { CODEBUDDY_CONFIG_DIR: 'D:/custom/tool' }, expect: { state: 'ambiguous', dim: 'edition' }, evidence: '【源码】', why: 'CODEBUDDY_CONFIG_DIR 由 CLI 与 WorkBuddy 两版共用，目录名不像任何一家时只能定到产品家族' },
  { id: 'qoder-custom-dir', env: { QODER_CONFIG_DIR: 'D:/custom/qoder' }, expect: { state: 'unknown' }, evidence: '【源码】', why: '目录名既不是 .qoder-cn 也不是 .qoder，没有任何正面证据，不许猜' },
  { id: 'nothing', env: {}, expect: { state: 'unknown' }, evidence: '【源码】', why: '空环境必须明确报 unknown，落回默认变体就是静默写歪' },
];

const ctxFor = (env) => makeCtx({ home: path.join(os.tmpdir(), 'ss-m76-no-such-home'), platform: 'win32', env });

function ratchet(rule) {
  const actual = tally(REPORT[rule]);
  const { grew, shrank } = ratchetDiff(actual, DEBT[rule] ?? {});
  assert.deepEqual(grew, [], `${rule} 新增违规：${grew.join('; ')} —— 要么改回唯一出口，要么在 DEBT.${rule} 登记理由（只许登记一次）`);
  assert.deepEqual(shrank, [], `${rule} 违规变少必须同步下调上限：${shrank.join('; ')} —— 棘轮只能收紧一次记录一次`);
}

test('判据登记表与指纹表双向绑定：代码用的键必须登记，登记的必须被用到', () => {
  assert.ok(registry.length >= 30, `判据登记表行数异常：${registry.length}`);
  assert.deepEqual(REPORT.R5, [], `登记表与代码不一致：${REPORT.R5.map((v) => v.detail).join('; ')}`);
});

test('六维坐标表覆盖全部 21 个变体，且每维取值合法', () => {
  assert.deepEqual(coords.map((c) => c.variant).sort(), ALL_VARIANTS.slice().sort(), '坐标表与注册表必须一一对应');
  const legalForm = new Set(['cli', 'desktop', 'ide-plugin']);
  for (const c of coords) {
    assert.ok(REACH_RANK[c.family] === undefined, `${c.variant} 的 family 列写成了维度名：${c.family}`);
    assert.ok(['cn', 'intl', 'n/a'].includes(c.edition), `${c.variant} 的 edition 非法：${c.edition}`);
    const forms = c.form.split('+').map((s) => s.trim());
    assert.ok(forms.length >= 1, `${c.variant} 缺形态`);
    for (const f of forms) assert.ok(legalForm.has(f), `${c.variant} 的形态取值非法：${f}（只允许 cli / desktop / ide-plugin，多形态用 + 连接）`);
    assert.equal(new Set(forms).size, forms.length, `${c.variant} 的形态有重复`);
    assert.ok(c.gen && c.gen.trim().length > 0, `${c.variant} 缺 gen 维度取值`);
  }
  const opencode = coords.find((c) => c.variant === 'opencode');
  assert.match(opencode.gen, /v1\/v2/, 'opencode 的 v1/v2 必须落在 gen 维（版代），不能塞进 edition 或变体名');
  assert.equal(opencode.edition, 'n/a', 'opencode 没有发行版之分，edition 只能是 n/a');
  const multi = coords.filter((c) => c.form.includes('+')).map((c) => c.variant);
  assert.ok(multi.length >= 6, `多形态变体应有 6 个以上（当前只标了 ${multi.join(',')}）—— 形态是并存事实，不是二选一`);
});

test('形态矩阵按产品登记（唯一事实源），与坐标表双向一致，且能反查到每个变体', () => {
  const spec = readText('references/agent-storage.md');
  const lines = spec.split('\n');
  const head = lines.findIndex((l) => l.trim().startsWith('| 产品 | 形态 | 形态改变落点'));
  assert.ok(head >= 0, 'agent-storage.md 缺「变体形态矩阵」（形态与版次的唯一事实源）');
  const rows = [];
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) break;
    if (/^\|[\s-]+\|/.test(l)) continue;
    rows.push(l.split('|').slice(1, -1).map((x) => x.trim()));
  }
  const matrix = new Map(rows.map((c) => [c[0], { forms: c[1], moves: c[2], map: c[3], entry: c[4], roots: c[5], covered: c[6], evidence: c[7] }]));

  const products = [...new Set(coords.map((c) => c.product))].sort();
  assert.deepEqual([...matrix.keys()].sort(), products,
    `形态矩阵必须按产品登记（${products.length} 行），一个产品的形态不因变体而变`);

  const norm = (s) => s.split('+').map((x) => x.trim()).sort().join('+');
  for (const p of products) {
    const m = matrix.get(p);
    const variants = coords.filter((c) => c.product === p);
    const expectForms = norm([...new Set(variants.flatMap((v) => v.form.split('+').map((x) => x.trim())))].join('+'));
    assert.equal(norm(m.forms), expectForms, `${p} 的形态在矩阵与坐标表里不一致`);
    for (const v of variants) {
      assert.ok(m.map.includes(v.variant), `${p} 的「形态→变体」列没有映射到 ${v.variant}（读某一家时反查不到形态）`);
    }
    assert.ok(m.entry && m.entry !== '—', `${p} 缺入口证据（形态必须由入口判定）`);
    assert.ok(m.roots && m.roots !== '—', `${p} 缺各形态数据根`);
    assert.ok(['是', '否', '待证'].includes(m.moves), `${p} 的「形态改变落点」取值非法：${m.moves}`);
    assert.match(m.evidence, /^【(真机|源码|确认|待证 待证-[a-z0-9-]+-\d+)】/, `${p} 的形态证据标记不合规：${m.evidence}`);
  }
});

const MATRIX = (() => {
  const spec = readText('references/agent-storage.md');
  const lines = spec.split('\n');
  const head = lines.findIndex((l) => l.trim().startsWith('| 产品 | 形态 | 形态改变落点'));
  const out = new Map();
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) break;
    if (/^\|[\s-]+\|/.test(l)) continue;
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    out.set(c[0], { forms: c[1].split('+').map((f) => f.trim()), moves: c[2] });
  }
  return out;
})();

test('C 判别层：form 级判据只在「形态改变落点」的产品上登记，且判别力齐备', () => {
  const formRows = registry.filter((r) => r.reach === 'form');
  assert.ok(formRows.length >= 8, `form 级判据太少（${formRows.length} 条）—— 多形态产品没有判据就只能猜`);
  const byProduct = new Map();
  for (const r of formRows) {
    const products = new Set(r.variants.map((v) => coords.find((c) => c.variant === v)?.product));
    assert.equal(products.size, 1, `${r.id} 的归属变体跨了多个产品：${[...products].join(',')}`);
    const prod = [...products][0];
    assert.ok(['是', '待证'].includes(MATRIX.get(prod)?.moves), `${r.id} 给「形态不改变落点」的产品 ${prod} 登记了 form 判据，只会制造噪音`);
    const cur = byProduct.get(prod) ?? { total: 0, suff: 0 };
    byProduct.set(prod, { total: cur.total + 1, suff: cur.suff + (r.sufficient ? 1 : 0) });
  }
  for (const [prod, m] of MATRIX) {
    const hit = byProduct.get(prod);
    if (m.moves === '否') {
      assert.ok(!hit, `${prod} 的形态不改变落点，不该有 form 判据`);
      continue;
    }
    assert.ok(hit?.total > 0, `${prod} 的形态改变落点（${m.moves}），但一条 form 级判据都没有`);
    if (m.moves === '是') assert.ok(hit.suff > 0, `${prod} 标了「是」却没有一条充分（能唯一定形态）的判据`);
  }
});

test('B 映射层：形态 → role → 根 → 读写覆盖必须逐形态登记，且 role 真的存在于声明层', () => {
  const spec = readText('references/program-spec.md');
  const lines = spec.split('\n');
  const head = lines.findIndex((l) => l.trim() === '| 产品 | 形态 | role | 根 | 读 | 写 | 备注 |');
  assert.ok(head >= 0, 'program-spec.md 缺「形态 → 落点 → 读写覆盖」表（B 映射层）');
  const rows = [];
  for (const l of lines.slice(head + 1)) {
    if (!l.startsWith('|')) break;
    if (/^\|[\s-]+\|/.test(l)) continue;
    rows.push(l.split('|').slice(1, -1).map((x) => x.trim()));
  }
  const ctx = makeCtx({ home: path.join(os.tmpdir(), 'ss-m76-roles'), platform: 'win32', env: {} });
  const codeRoles = new Set();
  for (const v of ALL_VARIANTS) for (const x of VARIANTS[v].readPaths?.(ctx) ?? []) if (x.role) codeRoles.add(x.role);

  const byProduct = new Map();
  for (const r of rows) {
    const [prod, form, role, root, rd, wr] = r;
    assert.ok(['✅', '❌', '条件'].includes(rd), `${prod}/${form} 的「读」取值非法：${rd}`);
    assert.ok(['✅', '❌', '条件'].includes(wr), `${prod}/${form} 的「写」取值非法：${wr}`);
    assert.ok(root && root !== '—', `${prod}/${form} 缺根`);
    if (role !== '未声明') {
      for (const one of role.split('+').map((x) => x.trim())) {
        assert.ok(codeRoles.has(one), `${prod}/${form} 的 role「${one}」在声明层里不存在（readPaths 没有这个 role）`);
      }
    }
    const list = byProduct.get(prod) ?? [];
    list.push(form);
    byProduct.set(prod, list);
  }
  for (const [prod, m] of MATRIX) {
    if (m.moves === '否') continue;
    const listed = (byProduct.get(prod) ?? []).slice().sort();
    assert.deepEqual(listed, m.forms.slice().sort(), `${prod} 的形态覆盖不全：矩阵有 ${m.forms.join('+')}，映射表有 ${listed.join('+') || '无'}`);
  }
});

test('形态与版次字眼不进正文标题：只留在矩阵（实现完全不同的才独立成章）', () => {
  const spec = readText('references/agent-storage.md');
  const heads = spec.split('\n').filter((l) => /^## \d/.test(l));
  assert.equal(heads.length, 20, `变体小节数异常：${heads.length}`);
  const bad = [];
  for (const h of heads) {
    const tail = h.includes(' — ') ? h.slice(h.indexOf(' — ') + 3) : '';
    if (/（[^）]*(CLI|IDE|桌面|插件)[^）]*）/.test(tail)) bad.push(h);
    if (/中文版\s*\/\s*国际版|VS Code 插件/.test(tail)) bad.push(h);
  }
  assert.deepEqual(bad, [], `标题里还留着形态/版次字眼（应进「变体形态矩阵」或以矩阵为唯一事实源）：${bad.join(' | ')}`);
  for (const gen of ['opencode-v1', 'opencode-v2']) {
    const h = heads.find((x) => x.includes(gen));
    assert.ok(/schema/.test(h), `${gen} 属于「实现完全不同」，必须独立成章并在标题里说明 schema 差异`);
  }
});

test('正文每节都能指到矩阵：不允许只写存储事实而不给形态出处', () => {
  const spec = readText('references/agent-storage.md');
  const secs = spec.split(/^## (?=\d)/m).slice(1);
  const missing = secs.filter((x) => !x.includes('变体形态矩阵')).map((x) => x.split('\n')[0].slice(0, 40));
  assert.deepEqual(missing, [], `这些小节没指向「变体形态矩阵」：${missing.join(' | ')}`);
});

test('写侧形态策略：默认取调用方 agent 的形态，判不出报 form-ambiguous，不写多份', () => {
  const skill = readText('SKILL.md');
  const doc = readText('references/environment.md');
  const spec = readText('references/program-spec.md');
  for (const [f, t] of [['SKILL.md', skill], ['references/environment.md', doc]]) {
    assert.ok(/调用(本 skill 的|方) agent 的形态/.test(t), `${f} 缺「用户没明示时默认 = 调用方 agent 的形态」`);
    assert.ok(t.includes('form-ambiguous'), `${f} 缺判不出时的终态，会退化成静默挑一份写`);
    assert.ok(t.includes('不写多份'), `${f} 缺「不写多份」—— 多份会让幂等与跨链路去重失效`);
  }
  assert.ok(/§4\.1/.test(spec) && spec.includes('environment.md'), 'program-spec.md 必须指到 environment.md §4.1，不许另写一版策略');
});

test('R1 锁自身有效：产品级信号落 edition 必中，带值匹配不误伤', () => {
  const bad = auditSource({
    hostsText: `const HOST_ENV_MARKERS = [
  { variant: (env) => { if (env.WORKBUDDY_APP_VERSION) return 'workbuddy-intl'; return null; }, keys: ['WORKBUDDY_APP_VERSION'] },
];`,
    cliText: '', writersIndex: '', cbIde: '', srcFiles: [],
  });
  assert.equal(bad.R1.length, 1, `产品级信号产出 edition 结论必须被抓住：${JSON.stringify(bad.R1)}`);
  const good = auditSource({
    hostsText: `const HOST_ENV_MARKERS = [
  { variant: (env) => {
      const dir = String(env.CODEBUDDY_CONFIG_DIR || '');
      if (/\\.workbuddy-ai$/i.test(dir)) return 'workbuddy-intl';
      if (/\\.workbuddy$/i.test(dir)) return 'workbuddy-cn';
      return null;
    }, keys: ['CODEBUDDY_CONFIG_DIR'] },
];`,
    cliText: '', writersIndex: '', cbIde: '', srcFiles: [],
  });
  assert.deepEqual(good.R1, [], `带值匹配的分支不该被误伤：${JSON.stringify(good.R1)}`);
});

test('R1 真实扫描：维度越权只减不增', () => ratchet('R1'));

test('R2 判定只有一个出口：detectHost 唯一定义、指纹表独占、结果不被外部改写', () => {
  assert.deepEqual(REPORT.R2, [], `判定出口被破坏：${REPORT.R2.map((v) => `${v.file}:${v.line} ${v.detail}`).join('; ')}`);
});

test('R2 层序：高层信号先命中，低层信号不能推翻它', () => {
  const high = detectHost(ctxFor({ CODEBUDDY_CONFIG_DIR: 'C:/u/.workbuddy' }));
  const mixed = detectHost(ctxFor({ CODEBUDDY_CONFIG_DIR: 'C:/u/.workbuddy', MIMO_HOME: 'C:/m', CLAUDECODE: '1' }));
  assert.equal(high.variant, 'workbuddy-cn');
  assert.equal(mixed.variant, high.variant, '叠加低层/后面的信号不得改写已命中的结论');
});

test('R3 锁自身有效：三元假支必须被抓住', () => {
  const bad = auditSource({
    hostsText: `const HOST_ENV_MARKERS = [
  { variant: (env) => (/\\.qoder-cn$/i.test(String(env.QODER_CONFIG_DIR || '')) ? 'qoder-cn' : 'qoder-intl'), keys: ['QODER_CONFIG_DIR'] },
];`,
    cliText: '', writersIndex: '', cbIde: '', srcFiles: [],
  });
  assert.equal(bad.R3.length, 1, `「不是 cn 就是 intl」必须被抓住：${JSON.stringify(bad.R3)}`);
});

test('R3 真实扫描：排除法兜底只减不增（含 gen 维的 kilo 两代）', () => {
  ratchet('R3');
  ratchet('R3-g');
});

test('R4 负面证据必须是 unknown；每条被认出的变体都要有充分判据', () => {
  assert.deepEqual(REPORT.R4, [], `有变体只凭猜测被认出：${REPORT.R4.map((v) => v.detail).join('; ')}`);
  const none = detectHost(ctxFor({}));
  assert.equal(none.variant, null, '空环境不得给出任何变体');
  assert.equal(none.confidence, 'none', '空环境必须报 none，不能退回启发式');
});

test('R5 判据必须带 reach / 充分 / 四态证据，【待证】要有编号并进清单', () => {
  const reachLegal = new Set(Object.keys(REACH_RANK));
  const tag = /^【(真机|源码|确认|待证 待证-[a-z0-9-]+-\d+)】$/;
  const pendingSec = DOC.split('## 8. 待证项清单')[1] ?? '';
  for (const r of registry) {
    assert.ok(reachLegal.has(r.reach), `${r.id} 的 reach 非法：${r.reach}`);
    assert.ok(typeof r.sufficient === 'boolean', `${r.id} 缺充分性`);
    assert.match(r.evidence, tag, `${r.id} 的证据标记不合规（四态、待证带编号、不带日期版本）：${r.evidence}`);
    const m = r.evidence.match(/待证-[a-z0-9-]+-\d+/);
    if (m) assert.ok(pendingSec.includes(`| ${m[0]} `), `待证项 ${m[0]} 没登记进清单`);
  }
});

test('R6 锁自身有效：决策函数体里出现 mtime 必须被抓住', () => {
  const bad = auditSource({
    hostsText: `const HOST_ENV_MARKERS = [];
export function detectHost(ctx) {
  const best = newestMtime(ctx);
  return { variant: best.variant, confidence: 'heuristic' };
}`,
    cliText: 'const into = host.variant ? [host.variant] : [];',
    writersIndex: '', cbIde: '', srcFiles: [],
  });
  assert.ok(bad.R6.length >= 2, `活动度参与决策必须被抓住：${JSON.stringify(bad.R6)}`);
});

test('R6 真实扫描：活动度只解释不决策，只减不增', () => ratchet('R6'));

test('三终态覆盖：能判的变体必须有 identified 用例，同族多版本必须有 ambiguous 用例', () => {
  const identified = new Set(DETECTION_CASES.filter((c) => c.expect.state === 'identified').map((c) => c.expect.variant));
  const covered = new Set([...identified, ...NO_SIGNAL_DEBT]);
  assert.deepEqual([...ALL_VARIANTS].filter((v) => !covered.has(v)), [], '有变体既没有 identified 用例也没登记进 NO_SIGNAL_DEBT');

  const keys = new Set(registry.map((r) => r.key));
  for (const c of DETECTION_CASES) {
    assert.ok(Object.keys(c.env).length > 0 || c.id === 'nothing', `${c.id} 用了空环境却声称有结论`);
    for (const k of Object.keys(c.env)) assert.ok(keys.has(k) || [...keys].some((u) => k.startsWith(u)), `${c.id} 用了登记表里没有的 key：${k}`);
    assert.ok(c.why.length > 12, `${c.id} 的 why 太短，等于没解释`);
    assert.match(c.evidence, /^【(真机|源码|确认|待证 待证-[a-z0-9-]+-\d+)】$/, `${c.id} 的证据标记不合规`);
  }

  const ambiguousFamilies = new Set(DETECTION_CASES.filter((c) => c.expect.state === 'ambiguous').map((c) => c.env.CODEBUDDY_CONFIG_DIR || c.env.WORKBUDDY_APP_VERSION || c.env.QODER_CONFIG_DIR || ''));
  assert.ok(ambiguousFamilies.size >= 1, '至少要有一条 ambiguous 用例（同族多版本判不出来时必须报无法确定）');
});

test('parity：identified 用例必须与运行时判定一致；运行时的过度识别必须登记', () => {
  const over = [];
  for (const c of DETECTION_CASES) {
    const model = classify(c.env, registry);
    const runtime = detectHost(ctxFor(c.env)).variant;
    assert.equal(model.state, c.expect.state, `${c.id} 规格模型的终态不符：${model.state} ≠ ${c.expect.state}`);
    if (c.expect.state === 'identified') {
      assert.equal(model.variant, c.expect.variant, `${c.id} 规格模型判出的变体不符`);
      assert.equal(runtime, c.expect.variant, `${c.id} 运行时与规格模型不一致（parity 破）：运行时 ${runtime}`);
    }
    if (c.expect.state !== 'identified' && runtime) over.push(`${c.id}:${runtime}`);
  }
  assert.deepEqual(over.sort(), RUNTIME_OVERIDENTIFY.slice().sort(),
    `运行时在「判不出来」的场景仍给出变体，必须逐条登记：${over.join(', ')}`);
});

test('判别与根定位共用同一个根名判据：同一个值不许在两个出口得到相反答案', () => {
  const home = path.join(os.tmpdir(), 'ss-m76-no-such-home');
  const mk = (value) => makeCtx({ home, platform: 'win32', env: { WORKBUDDY_CONFIG_DIR: value } });
  // 尾分隔符：定位认它（就是那个根），判别也必须认 —— 两边各写一份正则时这里判不出
  for (const [value, variant] of [
    ['C:/u/.workbuddy/', 'workbuddy-cn'],
    ['C:\\u\\.workbuddy\\', 'workbuddy-cn'],
    ['C:/u/.workbuddy-ai', 'workbuddy-intl'],
  ]) {
    const ctx = mk(value);
    assert.equal(detectHost(ctx).variant, variant, `${value} 的 edition 必须判得出（${variant}）`);
    assert.equal(workbuddyRoot(ctx, variant).path, value, `${value} 既然判成 ${variant}，根定位就必须用同一个值`);
  }
  // 近似根名不是本家的根：按后缀认出 intl 就会「识别为 intl 却写进默认目录」
  const bogus = mk('C:/u/my-workbuddy-ai');
  assert.notEqual(detectHost(bogus).variant, 'workbuddy-intl', '根名只认整段 .workbuddy-ai，my-workbuddy-ai 不算');
  assert.equal(
    path.normalize(workbuddyRoot(bogus, 'workbuddy-intl').path),
    path.normalize(path.join(home, '.workbuddy-ai')),
    '近似根名不得被当成 intl 的根',
  );
});

test('棘轮算法：变多红、变少也红、文件消失红、未登记必红', () => {
  const d = (n, why = '存量登记：这里写清为什么还留着') => ({ n, why });
  assert.deepEqual(ratchetDiff({ a: 4 }, { a: d(3) }).grew, ['a(4 处 > 上限 3)']);
  assert.deepEqual(ratchetDiff({ a: 2 }, { a: d(3) }).shrank, ['a: 3 → 2']);
  assert.deepEqual(ratchetDiff({}, { a: d(2) }).shrank, ['a: 2 → 0']);
  assert.deepEqual(ratchetDiff({ b: 1 }, {}).grew, ['b(1 处 > 上限 0)']);
});

test('债表本身合法：规则号已定义、文件真实存在、理由够长', () => {
  for (const [rule, files] of Object.entries(DEBT)) {
    assert.ok(RULES.includes(rule), `DEBT 里有未定义的规则号：${rule}`);
    for (const [file, d] of Object.entries(files)) {
      assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', file)), `DEBT 登记了不存在的文件：${file}`);
      assert.ok(String(d.why).length > 12, `${rule}/${file} 的债必须有理由（>12 字），否则等于默认放行`);
      assert.ok(Number.isInteger(d.n) && d.n > 0, `${rule}/${file} 的上限必须是正整数`);
    }
  }
});

test('规格文档必须被登记：SKILL.md 与 README 都指向 references/environment.md', () => {
  for (const f of ['SKILL.md', 'README.md']) {
    assert.ok(readText(f).includes('references/environment.md'), `${f} 没有登记环境判别规格，等于没人会读到它`);
  }
});

test('无信号变体登记与指纹表一致：不许靠漏写用例蒙混', () => {
  const { entries } = markerEntries(readText('src/hosts.mjs'));
  const returned = new Set(entries.flatMap((e) => branchesOf(e).map((b) => b.variant)));
  const noSignal = ALL_VARIANTS.filter((v) => !returned.has(v));
  assert.deepEqual(noSignal.sort(), NO_SIGNAL_DEBT.slice().sort(), `没有宿主指纹的变体集合变了：${noSignal.join(', ')}`);
});

test('kilo 代际三态：两代存储都没有且配置根不在 → 明确不可写，而不是偷偷造任务目录', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-m76-kilo-'));
  try {
    const ctx = makeCtx({ home, platform: 'win32', appData: path.join(home, 'AppData', 'Roaming'), localAppData: path.join(home, 'AppData', 'Local'), env: {} });
    const kilo = WRITERS.kilo;
    // 第三态：这台机器上没有 Kilo。原来会一路走到任务目录写侧，造出宿主永远不会看的会话
    assert.deepEqual(kilo.canWrite(ctx), { ok: false, reason: 'kilo-store-absent' });
    assert.equal(kilo.targetPath(ctx, { cwd: home }, 'x'), null, '没落点就不该给出目标路径');

    // 装过但一次都没跑（配置根在）：新建会话该能写，落任务目录代
    fs.mkdirSync(path.join(home, '.kilo'), { recursive: true });
    invalidateRoots(ctx);
    assert.equal(kilo.canWrite(ctx).ok, true, '配置根在说明装过，第一次新建不能被拦');

    // 库代出现后以库为准（升级不删旧任务目录，新版宿主只读库）
    const db = path.join(home, '.local', 'share', 'kilo', 'kilo.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, '');
    invalidateRoots(ctx);
    assert.equal(kilo.canWrite(ctx).ok, true);
    assert.ok(!String(kilo.targetPath(ctx, { cwd: home, turns: [] }, 'x')).includes('tasks'), '有库时不该再落任务目录代');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
