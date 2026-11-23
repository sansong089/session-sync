// 标题口径的唯一实现。三个概念必须分开，混在一起就会互相打架：
//
//   1. 读侧标题 —— 宿主自己存着的那一列 / 那一段（`title` 列、正文 `ai-title` 行…）。
//      **一律原样返回，绝不按长度截断**：读的职责是如实反映事实，读的时候截一刀，
//      用户看到的就已经不是宿主里的内容了。
//
//   2. 写侧标题 —— 落到目标宿主之前的最后一道加工：归一化 + 按**目标宿主的原生容量**
//      截断（`fitTitleFor`）。装不下就截，不报错：目标是「把这条会话连同它的名字搬过去」，
//      为一个超长标题让整条导入失败是本末倒置。
//      但截断必须**幂等可复现**：drift 比对要用同一个函数算出期望值，否则「源 300 字、
//      目标存 120 字」会被判成每轮都改名，同步永远做不完。
//
//   3. 首问预览（`previewTitle`）—— 宿主没有落点标题时，从第一条用户消息截一段当名字。
//      这是**我们构造的显示值**，截断就是它的语义，与任何落点容量无关。
//
// 归一化本身只有一套规则：折叠连续空白（含换行）→ trim。不折叠的话，带换行的标题
// 写进目标后会被宿主读侧折叠，读回来又 ≠ 源值，同样永远漂移。

/**
 * 落点标题的每宿主原生容量。**写侧唯一依据，读侧不截断**。
 * 加一家就在这里加一行；没登记的家视为「无上限」（新增宿主忘了登记时不该平白截断它）。
 */
export const TITLE_MAX = Object.freeze({
  workbuddy: 500,
  zcode: 300,
  qoder: 120,
  minimax: 300,
  codebuddy: 500,
  dsh: 500,
  claude: 500,
  codex: 500,
  opencode: 500,
  mimo: 500,
  pi: 500,
  freebuff: 500,
  'codebuddy-ide': 200,
  antigravity: 500,
  cline: 200,
  kilo: 200,
  roo: 200,
});

/** 首问预览的长度（显示用，不是落点容量） */
export const PREVIEW_LEN = 80;

/**
 * 标题归一化：折叠连续空白 → trim。**不截断，也不接受截断参数**。
 *
 * 空值一律返回 `''`：兜底文案（`'untitled'` / `'imported session'`）是**调用方的语义**，
 * 不是归一化的一部分 —— 读侧「没标题」和写侧「首次导入需要一个占位名」是两件事。
 */
export function normalizeTitle(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

/** 首问预览：归一化后按 code point 截断。预览之外的标题不做无依据的截断 */
export function previewTitle(raw, maxLen = PREVIEW_LEN) {
  return truncateCodePoints(normalizeTitle(raw), maxLen);
}

/**
 * 取某家的落点容量；没登记的家返回 0（= 不设限）。
 *
 * 变体名带区域后缀是常态（`workbuddy-cn` / `qoder-intl` / `codebuddy-ide`），
 * 直接查表会全部落空 → 容量变 0 → 既不截断、drift 期望值也错。所以先精确命中，
 * 再按 `-` 从最长前缀往下退（`codebuddy-ide` 精确命中 200，不会被退成 codebuddy 的 500）。
 */
export function titleMaxOf(variant) {
  const v = String(variant ?? '');
  if (Object.hasOwn(TITLE_MAX, v)) return TITLE_MAX[v];
  const parts = v.split('-');
  for (let i = parts.length - 1; i > 0; i--) {
    const key = parts.slice(0, i).join('-');
    if (Object.hasOwn(TITLE_MAX, key)) return TITLE_MAX[key];
  }
  return 0;
}

/**
 * 写侧标题的唯一出口：归一化 + 按目标宿主容量截断。
 *
 * 不截断的后果是宿主自己截（截在 UTF-16 code unit 上，emoji 会被劈成半个代理对，
 * 存进库再读出来是乱码方块）；不按同一套算期望值则是每日重写的 drift 死循环。
 *
 * @returns {{value:string, maxLen:number, length:number, truncated:boolean}}
 */
export function fitTitleFor(variant, raw, maxLen = null) {
  const value0 = normalizeTitle(raw);
  const cap = maxLen ?? titleMaxOf(variant);
  const value = cap ? truncateCodePoints(value0, cap) : value0;
  return { value, maxLen: cap, length: Array.from(value0).length, truncated: value !== value0 };
}

/**
 * 按 code point 截断。
 *
 * `slice(0, n)` 数的是 UTF-16 code unit：把 emoji 劈成半个代理对后，
 * 写进 SQLite / JSON 再读出来就是一个乱码方块，而且长度校验也跟着错位。
 */
function truncateCodePoints(s, n) {
  const arr = Array.from(s);
  return arr.length <= n ? s : arr.slice(0, n).join('');
}
