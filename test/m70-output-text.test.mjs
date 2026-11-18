// m70 — 「工具输出 → 文本」唯一出口的行为契约
//
// 这条通道决定跨宿主指纹：同一份工具输出在 A 家读出 '甲\n乙'、在 B 家读出
// '{"content":[...]}' 的话，同一条会话会被算成两份内容不同的报告，凭空长出 fork 副本。
// 所以这里不测「各家能不能读」，只测这一段文本归一的口径，以及**全仓只有一个引用**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { outputText } from '../src/text.mjs';
import * as util from '../src/util.mjs';
import * as readersBase from '../src/readers/base.mjs';
import * as writersBase from '../src/writers/base.mjs';

test('三种形态归一成同一段文本：字符串 / 文本块数组 / {text} / {content[]}', () => {
  assert.equal(outputText('甲'), '甲');
  assert.equal(outputText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲\n乙');
  assert.equal(outputText({ text: '丙' }), '丙');
  assert.equal(outputText({ content: [{ type: 'text', text: '丁' }] }), '丁');
  // 混排：字符串块与对象块可以同时出现（宿主写入时不做归一）
  assert.equal(outputText(['甲', { text: '乙' }, { type: 'text', text: '丙' }]), '甲\n乙\n丙');
  // 空块剔除：宿主常用 '' 占位，留着会在指纹里多出空行
  assert.equal(outputText(['甲', '', { text: '' }, null, '乙']), '甲\n乙');
});

test('{content[]} 这层包装必须认：它是 workbuddy 曾拒绝合并的唯一理由', () => {
  // 这条不是「顺带支持一下」—— 曾经有一个「WorkBuddy 专用」的平行实现，
  // 借口就是「别的实现不认 content 数组」。现在唯一出口认了它，那份平行实现就没有存在理由。
  assert.equal(outputText({ content: ['甲', { text: '乙' }] }), '甲\n乙');
  assert.equal(outputText({ content: [] }), '', '空 content = 没有文本，不能 stringify 成 {"content":[]}');
});

test('null 表示「没有输出」，与「输出是空串」区分开', () => {
  assert.equal(outputText(null), null);
  assert.equal(outputText(undefined), null);
  assert.equal(outputText(''), '', '空串是「有输出但为空」，不能被并列成 null');
  // 写侧要字符串：用 ?? '' 表达，而不是再开一个 outputToText 函数
  assert.equal(outputText(null) ?? '', '');
});

test('text 非字符串时不许把非字符串透出去（IR 的 text 字段约定是 string）', () => {
  // 旧读侧实现是 `out.text ?? JSON.stringify(out)`，{text: 0} 会原样返回数字 0，
  // 下游一律按字符串处理（trim/match/拼接），类型静默错乱比丢字段更难查
  assert.equal(typeof outputText({ text: 0 }), 'string');
  assert.equal(typeof outputText({ text: false }), 'string');
  assert.equal(outputText({ text: { nested: 1 } }), '{"text":{"nested":1}}');
});

test('无法展平的对象退化为 JSON 文本，循环引用不许抛', () => {
  assert.equal(outputText({ status: 'success' }), '{"status":"success"}');
  const cyc = { a: 1 };
  cyc.self = cyc;
  assert.equal(typeof outputText(cyc), 'string', '一条坏数据不能把整次 list 打断');
  assert.equal(outputText(0), '0', '原始数字走 String()');
});

test('空数组 = 没有文本（不 stringify 成 "[]"）', () => {
  assert.equal(outputText([]), '');
});

test('三处转发壳与唯一出口是同一个函数引用（不是各自复制一份）', () => {
  // 允许保留旧导出名以减少调用点改动，但必须是同一个函数对象：
  // 引用相等才证明「改一处、全仓生效」，复制出来的副本会各自漂移
  assert.equal(util.outputText, outputText, 'util.mjs 必须转发同一个实现');
  assert.equal(readersBase.outputText, outputText, 'readers/base.mjs 必须转发同一个实现');
  assert.equal(writersBase.outputText, outputText, 'writers/base.mjs 必须转发同一个实现');
});
