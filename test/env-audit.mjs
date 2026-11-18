// test/env-audit.mjs — 环境判别规则的只读审计器（不是测试文件：不带 .test，不进 npm test）
//
// 存在理由：判别规则写在 references/environment.md 里，如果只靠人读，就会在下次改动时失效。
// 这里把「文档里的两张表」变成唯一事实源，用纯文本手段核验 src/ 是否守住 R1–R6；
// `node test/env-audit.mjs` 直接打印按规则分组的违规清单，供人工看账。
//
// 刻意不做的事：不引解析器依赖（仓库零依赖）、不判断存储事实、不修任何东西。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

export const REACH_RANK = { family: 0, product: 1, edition: 2, form: 3, gen: 4, instance: 5 };
export const DIMS = ['family', 'product', 'edition', 'form', 'gen', 'instance'];
export const RULES = ['R1', 'R2', 'R3', 'R3-g', 'R4', 'R5', 'R6', 'R7'];

export function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 逐行取「表头之后、到第一个非表格行为止」的行，切成单元格。 */
function tableRows(text, header) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === header);
  if (i < 0) return [];
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (!l.startsWith('|')) break;
    if (/^\|[\s-]+\|/.test(l) || /^\|\s*-+/.test(l)) continue;
    out.push(l.split('|').slice(1, -1).map((s) => s.trim()));
  }
  return out;
}

export function parseDoc(text = readText('references/environment.md')) {
  const coords = tableRows(text, '| variant | family | product | edition | form | gen |').map((r) => ({
    variant: r[0], family: r[1], product: r[2], edition: r[3], form: r[4], gen: r[5],
  }));
  const registry = tableRows(text, '| 判据 | 层 | key / 模式 | 值匹配 | reach | 充分 | 归属变体 | 证据 |').map((r) => ({
    id: r[0],
    tier: r[1],
    key: r[2],
    match: r[3] === '—' ? null : r[3],
    reach: r[4],
    sufficient: r[5] === '是',
    variants: r[6].split(',').map((s) => s.trim()).filter(Boolean),
    evidence: r[7],
  }));
  return { coords, registry };
}

/** 从 start（指向 [ 或 {）开始做括号配对；跳过字符串与注释，正则字面量靠括号自平衡兜住。 */
export function sliceBalanced(text, start) {
  const close = { '[': ']', '{': '}', '(': ')' }[text[start]];
  if (!close) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i + 1), start, end: i };
    }
  }
  return null;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** HOST_ENV_MARKERS 数组里的每个顶层 { ... } 条目，带各自在文件里的起始偏移。 */
export function markerEntries(hostsText) {
  const anchor = hostsText.indexOf('const HOST_ENV_MARKERS = [');
  if (anchor < 0) return { block: null, entries: [] };
  const arrStart = hostsText.indexOf('[', anchor);
  const block = sliceBalanced(hostsText, arrStart);
  if (!block) return { block: null, entries: [] };
  const entries = [];
  for (let i = block.start + 1; i < block.end; i++) {
    const ch = hostsText[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      for (i++; i < block.end; i++) {
        if (hostsText[i] === '\\') { i++; continue; }
        if (hostsText[i] === quote) break;
      }
      continue;
    }
    if (ch === '/' && hostsText[i + 1] === '/') { const nl = hostsText.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (ch === '/' && hostsText[i + 1] === '*') { const e = hostsText.indexOf('*/', i + 2); if (e < 0) break; i = e + 1; continue; }
    if (ch === '{') {
      const obj = sliceBalanced(hostsText, i);
      if (!obj) break;
      entries.push({ text: obj.text, start: obj.start });
      i = obj.end;
    }
  }
  return { block, entries };
}

const quotedCaps = (t) => [...t.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1]);
const envRefs = (t) => [...t.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);

// 值匹配：条件里自己做比对，或调用本仓唯一的根名判据（`wbNameMatches`，判别与根定位共用）。
// 后者必须同等承认 —— 否则「把重复的正则收敛成一个函数」会被棘轮当成「没有值匹配」，
// 逼着人把正则再抄回来，棘轮于是成了重复实现的护栏。
const HAS_MATCH = /\.test\(|\.startsWith\(|\.endsWith\(|\.includes\(|wbNameMatches\(/;

/** 一个条目里的所有「产出变体」分支：if-return、三元两支、裸 return。 */
export function branchesOf(entry) {
  const out = [];
  const lines = entry.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mIf = line.match(/if\s*\(([^\n]*?)\)\s*\{?\s*return\s+'([a-z][a-z0-9-]*)'/);
    if (mIf) { out.push({ cond: mIf[1], variant: mIf[2], line, offset: i }); continue; }
    const mTern = line.match(/\?\s*'([a-z][a-z0-9-]*)'\s*:\s*'([a-z][a-z0-9-]*)'/);
    if (mTern) {
      const before = line.slice(0, line.indexOf('?'));
      out.push({ cond: before, variant: mTern[1], line, offset: i });
      // 三元假支没有条件 —— 这就是「不是 A 就是 B」的兜底形态
      out.push({ cond: null, variant: mTern[2], line, offset: i });
      continue;
    }
    // 三元一支是 null 的形态（`cond ? 'x' : null`）同样是「只在有值匹配时才认」
    const mTernNull = line.match(/\?\s*'([a-z][a-z0-9-]*)'\s*:\s*null/);
    if (mTernNull) {
      const before = line.slice(0, line.indexOf('?'));
      out.push({ cond: before, variant: mTernNull[1], line, offset: i });
      continue;
    }
    const mRet = line.match(/return\s+'([a-z][a-z0-9-]*)'/);
    if (mRet) { out.push({ cond: null, variant: mRet[1], line, offset: i }); continue; }
    // 箭头直接返回字面量（`variant: () => 'claude'`）
    const mArrow = line.match(/=>\s*'([a-z][a-z0-9-]*)'/);
    if (mArrow) out.push({ cond: null, variant: mArrow[1], line, offset: i });
  }
  return out;
}

/**
 * 该分支「必须达到」的维度：把「这条判据还能指向哪些别的变体」全部拉出来，
 * 取能把这组候选分开的最浅一维。只返回一个候选时不需要任何区分力（返回 0）。
 * 这样 codebuddy 的 `.codebuddy` 值匹配不会被 codebuddy-ide 的形态差异误伤，
 * 而 WorkBuddy 用两版共有的版本号变量去判中英则一定被判为越权。
 */
export function needDim(condKeys, registry, coords) {
  const vs = new Set();
  for (const r of registry) if (condKeys.includes(r.key) || condKeys.some((k) => k.startsWith(r.key))) r.variants.forEach((v) => vs.add(v));
  const list = [...vs];
  if (list.length < 2) return 0;
  for (const d of DIMS) {
    if (new Set(list.map((v) => coords.find((c) => c.variant === v)?.[d])).size > 1) return REACH_RANK[d];
  }
  return 0;
}

const keyReach = (key, registry) => {
  const rows = registry.filter((r) => r.key === key || (r.key.endsWith('_') && key.startsWith(r.key)));
  if (!rows.length) return -1;
  return Math.max(...rows.map((r) => REACH_RANK[r.reach] ?? -1));
};

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

export { walk as walkSrc };

/** 只读审计：返回 { R1: [{file,line,detail}], ... } */
export function auditSource(opts = {}) {
  const hostsText = opts.hostsText ?? readText('src/hosts.mjs');
  const cliText = opts.cliText ?? readText('src/cli.mjs');
  const writersIndex = opts.writersIndex ?? readText('src/writers/index.mjs');
  const cbIde = opts.cbIde ?? readText('src/writers/codebuddy-ide.mjs');
  const { coords, registry } = opts.doc ?? parseDoc();
  const out = Object.fromEntries(RULES.map((r) => [r, []]));

  const { block, entries } = markerEntries(hostsText);
  const base = { file: 'src/hosts.mjs' };
  const blockLine = block ? lineAt(hostsText, block.start) : 0;

  for (const entry of entries) {
    const { text } = entry;
    const keys = quotedCaps((text.match(/keys:\s*\[[^\]]*\]/g) ?? []).join(' '));
    const sessionKeys = quotedCaps((text.match(/sessionKeys:\s*\[[^\]]*\]/g) ?? []).join(' '));
    const prefix = (text.match(/prefix:\s*'([^']+)'/) ?? [])[1] ?? null;
    const branches = branchesOf(entry);
    const returned = [...new Set(branches.map((b) => b.variant))];
    const markerKeys = [...keys, ...sessionKeys, ...(prefix ? [prefix] : [])];
    const markerMax = Math.max(
      -1,
      ...[...keys, ...sessionKeys].map((k) => keyReach(k, registry)),
      ...(prefix ? [keyReach(prefix, registry)] : []),
    );
    const entryLine = lineAt(hostsText, entry.start);

    for (const b of branches) {
      const cond = b.cond ?? '';
      const hasMatch = HAS_MATCH.test(cond);
      const condKeys = envRefs(cond);
      let reach = condKeys.length
        ? Math.max(...condKeys.map((k) => keyReach(k, registry)))
        : (returned.length > 1 ? 0 : markerMax);
      if (hasMatch) reach = Math.max(reach, REACH_RANK.edition);
      const need = needDim(condKeys.length ? condKeys : markerKeys, registry, coords);
      const line = entryLine + b.offset;

      if (reach < 0) continue; // 未登记判据由 R5 负责，这里不重复计账

      // R1：家族共有信号不得产出更细的维度结论
      if (reach < need) {
        out.R1.push({
          ...base,
          line,
          detail: `${b.variant}（需 ${DIMS[need]} 级证据）只凭 ${condKeys.join('|') || prefix || '存在性'} 这类 ${DIMS[reach] ?? '未登记'} 级信号`,
        });
      }

      // R3：同一 marker 返回多个变体时，分支必须含值匹配
      if (returned.length > 1 && !hasMatch) {
        out.R3.push({ ...base, line, detail: `${cond ? `if (${cond})` : '三元假支/裸 return'} → '${b.variant}' 无值匹配，属排除法兜底` });
      }
    }
  }

  // R2：判定只有一个出口，结论不得被外部改写
  const srcFiles = opts.srcFiles ?? walk(path.join(ROOT, 'src'));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  for (const f of srcFiles) {
    const t = fs.readFileSync(f, 'utf8');
    const defs = [...t.matchAll(/function\s+detectHost\s*\(/g)].length;
    if (defs > 1) out.R2.push({ file: rel(f), line: lineAt(t, t.indexOf('function detectHost')), detail: `detectHost 定义了 ${defs} 次` });
    if (rel(f) !== 'src/hosts.mjs' && t.includes('HOST_ENV_MARKERS')) out.R2.push({ file: rel(f), line: 1, detail: '指纹表只许在 hosts.mjs 里存在' });
    for (const m of t.matchAll(/host\.variant\s*=[^=]/g)) out.R2.push({ file: rel(f), line: lineAt(t, m.index), detail: '判定结果被外部改写' });
  }

  // R4：产出变体的 marker 必须至少有一条「充分=是」的判据
  const sufficientVariants = new Set(registry.filter((r) => r.sufficient).flatMap((r) => r.variants));
  for (const v of new Set(entries.flatMap((e) => branchesOf(e).map((b) => b.variant)))) {
    if (!sufficientVariants.has(v)) out.R4.push({ ...base, line: 0, detail: `${v} 被判出但没有一条充分判据（只能算猜测）` });
  }

  // R5：代码用到的判据键与登记表双向绑定（只看指纹表的 S1 行；S2 是安装路径判据，不在 env 里）
  const keyArrays = (block?.text ?? '').match(/(?:keys|sessionKeys):\s*\[[^\]]*\]/g) ?? [];
  const usedKeys = new Set([...envRefs(block?.text ?? ''), ...quotedCaps(keyArrays.join(' '))]);
  const usedPrefix = [...(block?.text ?? '').matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1]);
  const registered = new Set(registry.filter((r) => r.tier === 'S1').map((r) => r.key));
  for (const k of usedKeys) if (!registered.has(k)) out.R5.push({ ...base, line: blockLine, detail: `${k} 被指纹表使用但登记表里没有` });
  for (const p of usedPrefix) if (!registered.has(p)) out.R5.push({ ...base, line: blockLine, detail: `前缀 ${p} 被使用但登记表里没有` });
  const usedAll = new Set([...usedKeys, ...usedPrefix]);
  for (const k of registered) {
    const hit = usedAll.has(k) || [...usedAll].some((u) => u.startsWith(k) || k.startsWith(u));
    if (!hit) out.R5.push({ ...base, line: blockLine, detail: `登记了 ${k} 但没有任何代码读取它（假覆盖）` });
  }

  // R6：活动度不得出现在决策里
  // 函数体要从「签名那一行的最后一个 {」起算：按「签名后的第一个 {」找，一旦参数里出现
  // 解构默认值（`{ entry = false } = {}`）就会截到参数对象，整条 mtime 检查随即静默空转。
  const dhIdx = hostsText.indexOf('export function detectHost');
  const dhSigEnd = dhIdx >= 0 ? hostsText.indexOf('\n', dhIdx) : -1;
  const dhBodyAt = dhSigEnd >= 0 ? hostsText.lastIndexOf('{', dhSigEnd) : -1;
  const dh = dhBodyAt >= 0 ? sliceBalanced(hostsText, dhBodyAt) : null;
  if (dh && /newestMtime|mtimeMs|statSync/.test(dh.text) && /variant:\s*best\.variant/.test(dh.text)) {
    const at = hostsText.indexOf('newest-store', dh.start);
    out.R6.push({ ...base, line: lineAt(hostsText, at > 0 ? at : dh.start), detail: 'detectHost 用 mtime 最新者直接产出 variant' });
  }
  // R6 的自检：函数体必须真被截到（否则上面那条永远不响）
  if (dh && !/state:/.test(dh.text)) {
    out.R6.push({ ...base, line: lineAt(hostsText, dh.start), detail: 'detectHost 函数体没被截到，R6/R7 的检查在空转' });
  }

  // R7：入口证据只能作正面证据，不得成为第二个兜底
  const entryIdx = hostsText.indexOf('const HOST_ENTRY_MARKERS');
  const entryBlock = entryIdx >= 0 ? sliceBalanced(hostsText, hostsText.indexOf('[', entryIdx)) : null;
  if (entryBlock && /newestMtime|mtimeMs|statSync/.test(entryBlock.text)) {
    out.R7.push({ ...base, line: lineAt(hostsText, entryBlock.start), detail: '入口层里出现活动度：判不出时它会变成新的兜底' });
  }
  const chainIdx = hostsText.indexOf('export function entryChain');
  const chainSigEnd = chainIdx >= 0 ? hostsText.indexOf('\n', chainIdx) : -1;
  const chainBodyAt = chainSigEnd >= 0 ? hostsText.lastIndexOf('{', chainSigEnd) : -1;
  const chainBody = chainBodyAt >= 0 ? sliceBalanced(hostsText, chainBodyAt) : null;
  if (chainBody) {
    if (!/timeout:/.test(chainBody.text)) out.R7.push({ ...base, line: lineAt(hostsText, chainBody.start), detail: '链查询没有超时：一次外部调用能挂死 detect/import' });
    if (/variant:/.test(chainBody.text)) out.R7.push({ ...base, line: lineAt(hostsText, chainBody.start), detail: '链查询里直接产出变体：结论必须只在正面匹配后给出' });
  }
  if (dh && entryBlock) {
    const markerAt = dh.text.indexOf('for (const marker of HOST_ENV_MARKERS)');
    const entryAt = dh.text.indexOf('entryEvidence(ctx)');
    if (entryAt >= 0 && (markerAt < 0 || entryAt < markerAt)) {
      out.R7.push({ ...base, line: lineAt(hostsText, dh.start + entryAt), detail: '入口证据在 S1 之前查询：env 已能定身份时白付一次外部查询，还会顶掉高层结论（R2）' });
    }
  }
  for (const f of srcFiles) {
    const t = fs.readFileSync(f, 'utf8');
    if (rel(f) !== 'src/hosts.mjs' && t.includes('HOST_ENTRY_MARKERS')) {
      out.R7.push({ file: rel(f), line: 1, detail: '入口表只许在 hosts.mjs 里存在（一处声明）' });
    }
  }
  for (const [i, line] of cliText.split('\n').entries()) {
    if (/host\.variant\s*\?(?!\?)/.test(line) && !/host\.confidence/.test(line)) {
      out.R6.push({ file: 'src/cli.mjs', line: i + 1, detail: '取 host.variant 作默认目标却没校验 confidence' });
    }
  }
  const hrIdx = cbIde.indexOf('function historyRootFor');
  const hr = hrIdx >= 0 ? sliceBalanced(cbIde, cbIde.indexOf('{', hrIdx)) : null;
  if (hr && /mtimeMs/.test(hr.text)) {
    out.R6.push({ file: 'src/writers/codebuddy-ide.mjs', line: lineAt(cbIde, hr.start), detail: '写根按 index.json mtime 选（冷数据会被判成不存在）' });
  }

  // R3-g：gen 维的排除法兜底（kilo 两代）
  for (const [i, line] of writersIndex.split('\n').entries()) {
    if (/kiloDbFile\(ctx\)\s*\?/.test(line)) {
      out['R3-g'].push({ file: 'src/writers/index.mjs', line: i + 1, detail: 'kilo 以「db 不存在」隐式判旧代，缺第三态' });
    }
  }

  return out;
}

/** 按文件汇总 {file: n}，喂给棘轮。 */
export function tally(list) {
  const out = {};
  for (const v of list) out[v.file] = (out[v.file] ?? 0) + 1;
  return out;
}

/** 只减不增：变多红、变少也要红（必须同步下调上限）。 */
export function ratchetDiff(actual, debt) {
  const grew = [];
  const shrank = [];
  for (const f of new Set([...Object.keys(actual), ...Object.keys(debt)])) {
    const a = actual[f] ?? 0;
    const cap = debt[f]?.n ?? 0;
    if (a > cap) grew.push(`${f}(${a} 处 > 上限 ${cap})`);
    else if (a < cap) shrank.push(`${f}: ${cap} → ${a}`);
  }
  return { grew, shrank };
}

const regexOf = (literal) => {
  const m = String(literal).match(/^\/(.*)\/([gimsuy]*)$/);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`); } catch { return null; }
};

/** 规格模型：只读登记表，不碰文件系统、不看 mtime —— 所以天然不违反 R6。 */
export function classify(env = {}, registry = parseDoc().registry) {
  const matched = [];
  for (const r of registry) {
    const isPrefix = r.key.endsWith('_');
    if (isPrefix) {
      if (Object.keys(env).some((k) => k.startsWith(r.key) && String(env[k] ?? '') !== '')) matched.push(r);
      continue;
    }
    const raw = String(env[r.key] ?? '').trim();
    if (!raw) continue;
    if (r.match) {
      const re = regexOf(r.match);
      if (!re || !re.test(raw)) continue;
    }
    matched.push(r);
  }
  if (!matched.length) return { state: 'unknown', variant: null };
  const suff = [...new Set(matched.filter((r) => r.sufficient).flatMap((r) => r.variants))];
  if (suff.length === 1) return { state: 'identified', variant: suff[0] };
  const cands = [...new Set(matched.flatMap((r) => r.variants))];
  const coords = parseDoc().coords;
  const dimOf = (vs) => {
    for (const d of DIMS) if (new Set(vs.map((v) => coords.find((c) => c.variant === v)?.[d])).size > 1) return d;
    return 'instance';
  };
  if (suff.length > 1) return { state: 'ambiguous', variant: null, dim: dimOf(suff), candidates: suff };
  return { state: 'ambiguous', variant: null, dim: dimOf(cands), candidates: cands };
}

function main() {
  const report = auditSource();
  let total = 0;
  for (const rule of RULES) {
    const list = report[rule];
    total += list.length;
    console.log(`${rule}  ${String(list.length).padStart(2)} 处`);
    for (const v of list) console.log(`   ${v.file}:${v.line}  ${v.detail}`);
  }
  console.log(`合计 ${total} 处`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
