// 「宿主输出 → 一段文本」的唯一实现。
//
// 各宿主把工具结果/消息内容存成：字符串 / 文本块数组 / {text} / {content[]} / 别的 JSON。
// 同一份结果必须归一成同一段文本，否则跨宿主指纹、去重与 show 输出会各说各话
// —— 同一个文件在两台机器上算出不同指纹，就会凭空长出 fork 副本。
//
// 这里曾经有四份平行实现：util.toolOutputText、readers/base.outputText、
// writers/base.outputToText、readers/workbuddy 的私有 outputText，另加 claude/dsh/pi
// 三处内联展平。四份的数组分支逐字节相同，只在 null 策略与 {content[]} 支持上分岔。
// 现在只有这一份，null 的策略由调用方用 `?? ''` 表达 —— 两个函数回答同一个问题
// 就是一题多解，那种「策略不同」用表达式就能说清，不值得再开一个函数。
export function outputText(out) {
  if (out == null) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return joinParts(out);
  if (typeof out === 'object') {
    // text 必须是**字符串**才直出：`{text: 0}` 这种会把 number 塞进 IR 的 text 字段，
    // 下游一律按字符串处理，静默类型错乱比丢一个字段更难查。非字符串走下面的 stringify。
    if (typeof out.text === 'string') return out.text;
    if (Array.isArray(out.content)) return joinParts(out.content);
    return safeStringify(out);
  }
  return String(out);
}

/** 文本块数组 → 换行拼接的纯文本；空块丢弃（宿主常用空串占位） */
function joinParts(arr) {
  return arr.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
}

/** 循环引用会让 JSON.stringify 抛错，这里必须兜住：读一条坏会话不能把整次 list 打断 */
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---- 宿主注入的「上下文压缩摘要」：跨宿主的**内容级**判据 ----
//
// WorkBuddy 在上下文压缩时，往 user 消息里注入一段
//   <cb_summary>…</cb_summary> / <conversation_history_summary>…</conversation_history_summary>
// 并在 providerData 上打 isCompacted / isCompactInternal / isSummary ——
// 但那几个标记是 **WorkBuddy 私有**的，换个宿主就没了。
//
// 为什么判据必须落在**内容**上（而不是各宿主的私有标记）：
//   判据若依赖私有标记，同一条会话换个宿主就退化成「普通用户提问」，
//   两侧算出的轮次与核心指纹不同 → 循环导入时被判成分叉，而不是 skip/append。
//   按内容判则两侧一致：写侧据此标 SystemEvent（宿主不把它显示成用户提问气泡），
//   读侧据此还原同一个 IR → 往返稳定、正文一个字不丢。
//
// 判据只回答「这段 user 文本是不是宿主注入的压缩摘要」，不回答「要不要丢」：
// 摘要是会话的一部分，**一律不丢**，只是不冒充用户提问。
export const COMPACTION_INJECTION = 'compaction';

const COMPACTION_TAGS = [
  ['<cb_summary>', '</cb_summary>'],
  ['<conversation_history_summary>', '</conversation_history_summary>'],
];

// 压缩之后宿主补的一句「请基于摘要继续」——它**没有标签包裹**，只能整句精确匹配。
// 真机样本：WorkBuddy 压缩后注入的固定一句（providerData.isCompactInternal=true）。
// 命中与否都不丢内容，只是标成系统事件，不冒充用户提问。
const COMPACTION_CONTINUE_PHRASES = [
  'Please continue with the conversation based on the summarized context above. Maintain the same level of detail and helpfulness as before the summarization.',
];

/**
 * 文本是否是宿主注入的压缩摘要/续写提示。
 * @returns {'compaction'|null} 命中返回 'compaction'，否则 null
 */
export function compactionInjectionKind(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  for (const [open, close] of COMPACTION_TAGS) {
    if (t.startsWith(open) && t.endsWith(close)) return COMPACTION_INJECTION;
  }
  for (const phrase of COMPACTION_CONTINUE_PHRASES) {
    if (t === phrase) return COMPACTION_INJECTION;
  }
  return null;
}

// 剥掉摘要的宿主包裹，只留内层正文 X。整段包裹只是特例：摘要与真实用户文本混排、
// 一段文本里嵌多份摘要、甚至嵌套包裹都要剥干净 —— 核心指纹若只在「整段纯摘要」时剥，
// 混排形态两侧就会算出不同骨架，复跑被判成分叉。无标签原样返回（对普通文本是恒等变换）。
// 用 indexOf 循环而非正则：标签无需转义，每轮严格缩短必然终止，缺闭合标签时不吞正文。
export function compactionSummaryText(text) {
  let t = String(text ?? '');
  for (const [open, close] of COMPACTION_TAGS) {
    for (;;) {
      const i = t.indexOf(open);
      if (i === -1) break;
      const j = t.indexOf(close, i + open.length);
      if (j === -1) break;
      t = t.slice(0, i) + t.slice(i + open.length, j) + t.slice(j + close.length);
    }
  }
  return t;
}
