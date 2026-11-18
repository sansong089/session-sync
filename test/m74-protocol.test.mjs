// M74 测试：宿主存储规格（references/agent-storage.md）与程序规格（references/program-spec.md）的机械可校验约束
//
// 两份文档职责分离：A = 各家 agent 自身的数据组织（唯一宿主事实源，带验证状态标记），
// B = 本程序实现规格（不带状态标记）。这套棘轮保证拆分后不会烂掉：
// - 两份文档都在，旧 protocol.md / agents.md 不得复活（否则就是第二份事实源 = 一题多解）
// - 20 个变体在 A 都有落点；opencode v1/v2 各占一节、互不引用
// - 每变体 V1–V9 九节齐全、每节有状态标记；标记只许四态且不带日期/版本号
// - V2 必须有目录树与库全貌，有库的变体 V5 必须逐列表结构与关键约束（不放 SQL 原文，逐列表格为准）
// - 【待证】带编号且登记清单；取证脚本清单不许写空头支票
// - A 不得混入本程序符号、B 不得混入状态标记（防止两边再糊在一起）
// - 「改前必读、改后必写」的规则文本必须在 SKILL.md 与 README 里
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VARIANTS } from '../src/hosts.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const spec = read('references/agent-storage.md');
const program = read('references/program-spec.md');
const skill = read('SKILL.md');
const readme = read('README.md');

const DIMS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'];
const DDL_HEAD = '| 列 | 类型 | 约束 | 默认值 | 说明 |';
// 库形态变体：V2 必须列全库表、V5 必须逐列表结构（opencode-v1 用的是源码 DDL，也算）
const DB_SECTIONS = [
  '1. opencode-v1', '2. opencode-v2', '5. antigravity', '6. codex',
  '7–8. workbuddy', '9–10. qoder', '11. zcode', '12. mimo',
  '13. minimax', '16. cline', '19. cursor',
];

// 变体小节切分：`## 1. xxx` / `## 7–8. xxx` … 到下一个 `## `；规格说明与文末全局节不在范围内。
function variantSections(src) {
  const lines = src.split('\n');
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^## [1-9]\d*[.–]/.test(l)) { cur = { head: l, body: [] }; out.push(cur); continue; }
    if (l.startsWith('## ')) { cur = null; continue; }
    if (cur) cur.body.push(l);
  }
  for (const s of out) s.text = s.body.join('\n');
  return out;
}
const secs = variantSections(spec);
const sec = (prefix) => {
  const hit = secs.find((s) => s.head.slice(3).startsWith(prefix));
  assert.ok(hit, `agent-storage.md 缺小节 ${prefix}`);
  return hit;
};
const dimText = (s, d) => {
  const chunks = s.text.split(/^### V[1-9] /m);
  const i = DIMS.indexOf(d);
  assert.ok(chunks[i + 1] !== undefined, `${s.head.slice(0, 30)} 缺 ${d}`);
  return chunks[i + 1];
};

test('两份文档职责分离：protocol.md / agents.md 不得复活', () => {
  assert.ok(exists('references/agent-storage.md'), '宿主存储规格必须存在');
  assert.ok(exists('references/program-spec.md'), '本程序规格必须存在');
  assert.ok(!exists('references/protocol.md'), 'protocol.md 已拆分，不许再建第二份事实源');
  assert.ok(!exists('references/agents.md'), 'agents.md 已并入 agent-storage.md，不许复活');
});

test('每个变体都在宿主存储规格里有落点，opencode 两节独立', () => {
  for (const v of Object.keys(VARIANTS)) {
    assert.ok(spec.includes(v), `agent-storage.md 缺变体 ${v} 的小节`);
  }
  assert.equal(secs.length, 20, `变体小节数异常：${secs.length}（21 变体、两处合并节、opencode 拆两节）`);
  const v1 = sec('1. opencode-v1');
  const v2 = sec('2. opencode-v2');
  assert.ok(!/session_v2|session_message|两表 schema/.test(v1.text), '三表 schema 小节不得混入两表 schema 的内容');
  assert.ok(!/\bv1\b|旧版|两代|opencode-classic/.test(v2.text), '两表 schema 小节不得再拿来跟三表 schema 对比');
});

test('每变体 V1–V9 九节齐全，且每节都有带状态标记的规格项', () => {
  for (const s of secs) {
    for (const d of DIMS) {
      assert.ok(s.text.includes(`### ${d} `), `${s.head.slice(0, 30)} 缺 ${d} 小节`);
    }
    const chunks = s.text.split(/^### V[1-9] /m).slice(1);
    assert.equal(chunks.length, 9, `${s.head.slice(0, 30)} 的 V 节数不是 9`);
    for (let i = 0; i < chunks.length; i++) {
      assert.ok(/【(真机|源码|确认|待证)/.test(chunks[i]),
        `${s.head.slice(0, 30)} 的 ${DIMS[i]} 缺带状态标记的规格项`);
      assert.ok(chunks[i].trim().length > 40, `${s.head.slice(0, 30)} 的 ${DIMS[i]} 内容过短`);
    }
  }
});

test('状态标记只许四种形态、不带日期或版本号，【待证】必须带编号', () => {
  const tags = secs.flatMap((s) => s.text.match(/【[^】]*】/g) ?? []);
  const legal = /^【(真机|源码|确认|待证)( [^】]*)?】$/;
  const bad = tags.filter((t) => !legal.test(t) || /\d{4}|\d+\.\d+\.\d+/.test(t));
  assert.deepEqual(bad, [], `非法状态标记（或又带了日期/版本号）：${bad.join(' ')}`);
  const pending = tags.filter((t) => t.startsWith('【待证'));
  for (const t of pending) {
    assert.match(t, /待证-[a-z0-9-]+-\d+/, `【待证】必须带编号（待证-<变体>-<序号>）：${t}`);
  }
  assert.ok(pending.length >= 1, '当前确有未取证项；待证清零后这条棘轮需要同步改成守护「清单为空」');
});

test('每个【待证】编号都登记进待证项清单', () => {
  const secText = spec.split('## 待证项清单')[1]?.split('## 真机取证脚本清单')[0] ?? '';
  const used = new Set();
  for (const s of secs) {
    for (const t of s.text.match(/【待证[^】]*】/g) ?? []) {
      const m = t.match(/待证-[a-z0-9-]+-\d+/);
      if (m) used.add(m[0]);
    }
  }
  for (const id of used) {
    assert.ok(secText.includes(`| ${id} `), `待证项 ${id} 用在了小节里但没登记进「待证项清单」`);
  }
  const listed = [...secText.matchAll(/^\| (待证-[a-z0-9-]+-\d+) /gm)].map((m) => m[1]);
  assert.equal(new Set(listed).size, listed.length, '待证项清单有重复编号');
});

test('真机取证脚本清单里列的脚本必须真实存在', () => {
  const tail = spec.split('## 真机取证脚本清单')[1] ?? '';
  assert.ok(tail, 'agent-storage.md 缺「真机取证脚本清单」小节');
  const scripts = [...tail.matchAll(/`(test\/real-host\/[^`]+\.mjs)`/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 5, `脚本清单行数异常：${scripts.length}`);
  for (const s of scripts) assert.ok(exists(s), `清单里的脚本不存在：${s}`);
});

test('目录全貌与表结构棘轮：V3 有树与库全貌，库形态 V6 逐列列出约束', () => {
  for (const s of secs) {
    const v3 = dimText(s, 'V3');
    assert.ok(/【(真机|源码)】 目录全貌/.test(v3), `${s.head.slice(0, 30)} 的 V3 缺目录全貌标记`);
    assert.ok(/```[\s\S]*├──|```[\s\S]*└──/.test(v3), `${s.head.slice(0, 30)} 的 V3 缺目录树`);
  }
  for (const prefix of DB_SECTIONS) {
    const s = sec(prefix);
    assert.ok(/库内共 \*\*\d+ 张表\*\*|同时存在以下七张表/.test(dimText(s, 'V3')),
      `${prefix} 的 V3 缺库内全表清单`);
    assert.ok(dimText(s, 'V6').includes(DDL_HEAD), `${prefix} 的 V6 缺逐列表结构`);
    assert.match(dimText(s, 'V6'), /(PK|NOT NULL|DEFAULT|UNIQUE|CHECK|varchar\()/, `${prefix} 的 V6 缺关键约束`);
  }
  // 字段长度这类约束一旦被抹掉就会让写入越界，单独钉住
  assert.match(dimText(sec('9–10. qoder'), 'V6'), /varchar\(\d+\)/, 'qoder 桌面库的字段长度约束不得丢');
});

test('写入检查单：20 家齐全，容忍性列必须带证据或明确不可写', () => {
  const tail = spec.split('## 写入检查单（按家）')[1]?.split('## 待证项清单')[0] ?? '';
  assert.ok(tail, '缺「写入检查单（按家）」章节');
  for (const s of secs) {
    const name = s.head.slice(3).split(' — ')[0];
    const row = tail.split('\n').find((l) => l.startsWith(`| ${name} `));
    assert.ok(row, `写入检查单缺变体 ${name}`);
    const cells = row.split('|').map((c) => c.trim());
    assert.ok(
      row.includes('不可写') || cells[3].length > 5,
      `${name} 的新会话最小落点为空（非不可写变体）`);
    assert.ok(
      /【(真机|源码)|【待证 待证-[a-z0-9-]+-\d+|—|N\/A/.test(cells[5]),
      `${name} 的容忍性列缺证据等级`);
  }
  // P0 负载结构棘轮：三家关键负载字段不得再丢
  assert.ok(/tool_result\{tool_use_id, content, is_error\}/.test(spec), 'claude 的 content 块字段结构缺失');
  assert.ok(/tool\/call\{turn, step, callId, name, arguments\}/.test(spec), 'dsh 的 data 内层结构缺失');
  assert.ok(/`step-finish`（`snapshot`）/.test(spec), 'opencode-v1 的 part.data 部件类型缺失');
});

test('规格项标准化：每维一张「规格项 | 内容 | 证据」表，行名全库统一', () => {
  const STD = {
    V1: ['默认根', '官方覆盖变量', '目录归属判据'],
    V2: ['登录态落点', '账号分区', '会话账号字段', '切换账号影响'],
    V3: ['会话正文载体', '列表索引与注册表', '非项目落点'],
    V4: ['会话边界', '会话 ID 形态', '命名与目录派生', '非项目桶'],
    V5: ['正文格式', '编码与加密', '压缩与多帧', '解码要点'],
    V6: ['存储实体', '关键列与约束', '标题落点'],
    V7: ['列表来源', '打开正文依赖', '标题裁决', '缺字段后果'],
    V8: ['项目判定', '会话归属键', '项目注册表', '非项目会话', '项目显示名'],
    V9: ['时间戳', '多副本与去重', '子代理与特殊会话', '宿主迁移机制'],
  };
  // 从某维文本中提取「规格项 | 内容 | 证据」表的行名（跳过树代码块与 DDL 表）
  const itemNames = (text) => {
    const i = text.indexOf('| 规格项 | 内容 | 证据 |');
    assert.ok(i !== -1, '缺标准化规格项表');
    const names = [];
    for (const l of text.slice(i).split('\n').slice(2)) {
      if (!l.startsWith('| ')) break;
      names.push(l.split('|')[1].trim());
    }
    return names;
  };
  for (const s of secs) {
    for (const d of DIMS) {
      assert.deepEqual(itemNames(dimText(s, d)), STD[d],
        `${s.head.slice(0, 30)} 的 ${d} 规格项名偏离标准集`);
    }
    assert.ok(/├──|└──/.test(dimText(s, 'V3')), `${s.head.slice(0, 30)} 的目录树缺树状图标（├── / └──）`);
  }
  assert.ok(spec.includes('### 规格项标准化'), '缺「规格项标准化」说明');
  assert.ok(spec.includes('### 类型与长度语义'), '缺「类型与长度语义」说明（TEXT/varchar 在 SQLite 不限长的语义）');
  assert.ok(spec.includes('CHECK(length(col) <= N)'), '缺长度强制语义说明');
  assert.ok(spec.includes('文本列没有数据库级长度限制'), '缺「文本列无数据库级长度限制」结论');
});

test('职责纯净：A 不混入本程序符号，B 不混入验证状态标记', () => {
  for (const token of ['src/', '--data-root', 'title-slots', 'import --apply', 'session-sync-provenance']) {
    assert.ok(!spec.includes(token), `agent-storage.md 混入了本程序符号：${token}`);
  }
  assert.ok(!/【(真机|源码|确认|待证)/.test(program), 'program-spec.md 不应带验证状态标记');
  assert.ok(!/本机实测|现网 \d+|mtime 停/.test(spec), '规格文档不得记录取证环境快照');
});

test('「改前必读 / 改后必写」规则必须在 SKILL.md 与 README 里，且维度骨架不回退', () => {
  assert.ok(skill.includes('references/agent-storage.md'), 'SKILL.md 缺宿主规格引用');
  assert.ok(skill.includes('协议先行'), 'SKILL.md 缺「协议先行」规则');
  assert.ok(readme.includes('references/agent-storage.md'), 'README 缺宿主规格引用');
  assert.ok(readme.includes('改前必读') || readme.includes('先读'), 'README 缺「改前必读」规则文本');
  for (const [file, text] of [['SKILL.md', skill], ['README.md', readme], ['host-onboarding.md', read('references/host-onboarding.md')]]) {
    assert.ok(!/V1–V8\b|八维度|八个维度|八节/.test(text), `${file} 还停在旧的八维度骨架`);
    assert.ok(/V1–V9|九维度|九节/.test(text), `${file} 缺九维度骨架措辞`);
  }
});
