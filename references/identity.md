# 身份、去重与分叉

这套机制的目标：**不建登记表**，仅凭会话自身携带的信息，就能在任意多条同步路径上
做到幂等、去重、round-trip 收敛。

---

## 1. IR（中间表示）

```
Session { variant, id, title, cwd, createdAt, updatedAt, model, origin, chain, turns[], meta }
  └─ Turn { index, role:'user'|'assistant'|'system', items[] }
       └─ Item：message / reasoning / tool_call / tool_result / attachment / meta / note
```

各家 reader 把原生格式统一成 IR；writer 把 IR 还原成目标原生格式。

---

## 2. provenance（随会话传播的来源标记）

```json
{
  "origin": { "variant": "codex", "sessionId": "01a1..." },
  "chain":  [ { "variant": "codex", "sessionId": "01a1...", "at": 1790000000000 },
              { "variant": "pi",    "sessionId": "019f...", "at": 1790000001000 } ],
  "tool": "session-sync",
  "v": 1
}
```

- `origin` = **最上游**原始会话，永不改变
- `chain` = 经过的每一跳（不含目标自身）
- `tool` + `v` 是合法性校验位：**"这个会话是不是我们导入的"只看 provenance 是否存在**，不看 ID 形状（Codex / OpenCode 的原生 ID 也是 uuid5，形状无法区分）

写入目标时的落点（各家不同，但都随会话走）：

| 变体 | 落点 |
| --- | --- |
| opencode | `session_v2.metadata["session-sync"]` |
| mimo | `session.permission["session-sync"]` |
| workbuddy-cn/intl | `session-meta` 行 `meta["session-sync"]` |
| freebuff | `chat-meta.json` 的 `"session-sync"` |
| cline / kilo | `task_metadata.json` 的 `"session-sync"` |
| claude | 专用行 `type="session-sync-provenance"` + sidecar |
| codex | 专用行 `type="session-sync-provenance"` + sidecar |
| pi | 专用行 `type="session-sync/provenance"` + sidecar（斜杠不是笔误，宿主原文如此） |
| dsh | 会话目录 `provenance.session-sync.json` |
| codebuddy | `<id>.jsonl.session-sync.json`（sidecar；JSONL 行没有 provenance 槽位） |
| codebuddy-ide | conversation 目录 `index.json.session-sync.json`（sidecar） |
| zcode | `session_entry` 表 `type='session-sync/provenance'`（`data` 即 provenance 本体） |
| minimax | `local_runtime_sessions.extra_data_json["session-sync"]` |
| qoder-cn/intl | `chat_sessions.extra_json["session-sync"]`（同时也是「这行是我们建的」的认领判据） |
| opencode-classic（v1 库） | `session.permission["session-sync"]` |

sidecar 有两种用途：写 `db` / 二进制容器的变体额外写一份同名 sidecar 兜底（`<会话文件>.session-sync.json`，读侧优先 sidecar）；
codebuddy 与 codebuddy-ide 的 provenance **只有** sidecar 一个槽位，没有正文内的落点。

---

## 3. originKey → 目标 ID（确定性派生）

```
originKey = "<origin.variant>:<origin.sessionId>"
```

`origin.variant` 为空的会话（原生）取自身 `variant:id`。

目标 ID 由 `uuid5(originKey, NS)` 派生，按各家 ID 形态分流：

| 变体 | 形态 | 派生方式 |
| --- | --- | --- |
| claude、codebuddy、pi、codex、dsh、cursor、kilo、workbuddy×2 | uuid（36） | `uuid5(originKey, NS)` |
| opencode | `ses_` + hex32 | `ses_` + `uuid5(originKey, NS)` 去掉横线（v2 的 `Session.ID` schema 强制 `ses` 前缀，裸 uuid 会让 `/api/session` 整页 500） |
| zcode | `sess_` + uuid（36） | `sess_` + `uuid5(originKey, NS)`（`contracts/.../shared.ts` 的 SessionId 契约；裸 32 hex 与原生形态不符） |
| mimo | `ses_` + hex22 | `sha256(originKey)[:22]` |
| minimax | `mvs_` + hex32 | `sha256(originKey)[:32]` |
| freebuff | `sync-` + hex16 | `sha256(originKey)[:16]` |
| codebuddy-ide | hex32 | `sha256(originKey)[:32]`（宿主 conversation id 形态） |
| qoder×2 | hex20 | `sha256(originKey)[:20]` |
| cline、roo | 13 位十进制 | `sha256 → BigInt % 9e12 + 1e12`（时间戳形态，宿主按它排序；Roo 的任务 ID 与 Cline 同构） |

派生只有一处实现 `mintByFamily(variant, key)`（`src/identity.mjs`）：普通导入传 `originKey`，
分叉传 `originKey + "#fork:" + branchKey`。**形态分流不区分用途** —— 同变体的普通会话与 fork
必然长成同一种 ID 形态，否则宿主侧会出现「有的能打开、有的打不开」。

`NS = uuid5('session-sync/identity/v1', NAMESPACE_DNS)` —— 固定命名空间，换机器/换会话不变。

### 三条不变量

1. **同一原始会话 → 同一目标 ID**：无论从哪条路径到达，`originKey` 相同 ⇒ ID 相同 ⇒ 命中同一会话，天然去重。
2. **round-trip 收敛**：`origin.variant === 目标变体` 时，目标 ID **直接取原生会话 ID**。所以自己的会话绕一圈导回来，落点就是它自己 ⇒ 一致即 skip 或原地续写，不产生副本。
3. **fork 确定性（分支坐标）**：`forkId = mintByFamily(目标变体, originKey + "#fork:" + branchKey)`，
   其中 `branchKey = sha256({父基准本地 ID, 分歧点 k, 第 k 轮核心指纹})`（`forkBranchKey`，唯一实现）。
   同一分歧点经不同路径到达 ⇒ 同一个 fork；分支后续增长只换尾巴、不换 `k` 与第 `k` 轮 ⇒ **同一个 fork ID**。
   （旧实现用「相对基准的整个后缀」做哈希，同一分支每续一轮就换一次 ID，会累积出多条近似 fork。
   那份 `diff.divergenceHash` 已经删除，`diff` 与 `import` 都走 `forkBranchKey`。）

### 身份与分支的分工

`originKey` 是**跨链路唯一身份**；`branchKey` 只是**目标本地的分支坐标**：不写进 provenance、
不参与跨变体 ID 派生，也**不落盘** —— 它的 `parent` 一项就是父基准会话在目标侧的本地 ID，
每次导入时现算（读目标候选列表 + LCP），盘上没有任何 `parentId` 字段可读可写。
同一分支在不同 agent 里会有不同的本地 fork ID，但都归一到同一个 `originKey`，靠内容关系继续收敛。

---

## 4. 指纹与四种动作

### 4.1 核心指纹 vs 全量指纹

| | 组成 | 用途 |
| --- | --- | --- |
| **核心指纹**（默认） | 消息文本（角色 + 规范化空白）+ 工具调用（工具名 + 入参） | 幂等/去重/分叉判定 |
| 全量指纹（`--strict`） | 上述 + reasoning + tool_result 输出 + attachment + meta | 诊断 |

为什么默认不用全量：`reasoning` 是模型内部产物，多数宿主不保留；`tool_result` 长输出常被截断或改写。
用全量指纹会把**同一会话**判成分叉，从而反复 fork —— 这是这套机制里最容易踩的坑。

### 4.2 决策（候选集，不是单个 base ID）

判据顺序：**先身份，后内容**。基准不是「派生 ID 那一条」，而是目标里**同 `originKey` 且未归档**的
全部会话（源与目标同变体时，源会话本身排除）。源与每个候选都按核心指纹求 LCP，再按包含关系选动作：

| 候选与源的关系 | 动作 |
| --- | --- |
| 某候选与源完全一致 | `skip`（命中的不是派生 ID 时标 `fork-converged:identical`） |
| 某候选是源的**严格前缀** | `append` 到**最长**的那个候选（fork 也能被续写，不新开分支） |
| 源是某候选的前缀 | `skip(target-ahead)` |
| 都不成立（真分叉） | 相对 LCP 最长的候选 `fork`，fork ID 用该候选本地 ID 作父 |
| 没有任何活跃候选 | 派生 ID 不存在 ⇒ `create`；存在且同身份：目标已归档 ⇒ `skip(target-archived)`，源与目标是同一条会话（round-trip）⇒ `skip(round-trip-self)`；存在但身份不同 ⇒ `fork` + `identity-mismatch` |

身份：`originKey(S) === originKey(T)`。目标原生时 root 就是它自己 `variant:id`；导入会话 root 取
`provenance.origin`。身份不同 ⇒ 绝不 append/skip：两条内容相同但不同 root 的原生会话不得合并。

### 4.3 原生会话的续写

原生会话**不再是 append 的一票否决**：身份相同 + 目标是源的严格前缀即可续写。
写侧对原生目标**剥离 provenance**（不写来源行/sidecar），使用目标既有 cwd/scope，不改落点，
保持其原生状态；导入目标则照常写 provenance。旧规则从未 append 过原生会话，无需清理历史数据。

### 4.4 轮次边界保真（写入侧不变量）

核心指纹按**轮**比对，所以「同一会话在同一宿主里写下去再读回来，必须还是同一串轮次」是硬要求，
否则源与目标的 LCP 提前截断，续写被误判成 `fork`。各家对「一轮」的表示并不一致，写侧因此统一四条：

| 规则 | 为什么 | 落点 |
| --- | --- | --- |
| 一轮的用户文本只发**一条** user 消息（多段合并） | 读侧「一条含文本的 user 消息 = 一轮」，逐段发会多出轮次 | claude / codex / pi / cline 系 / workbuddy / dsh / opencode / mimo / codebuddy / codebuddy-ide |
| 装不下多段的宿主用 `\n\n` 拼接，核心指纹把同角色相邻消息**合并后再哈希** | 「分块」与「拼接」是表示差异，不是内容差异 | `src/ir.mjs` `turnCore` |
| 附件降级占位行 `[attachment] <路径>` 不进核心指纹 | 源侧是附件、目标侧是这行文本，进核心就永远对不上 | `src/ir.mjs` `coreItem` |
| 部件时间戳写入时钳成不低于前一条 | 读侧按 `(time_created, id)` 排序，源里同轮部件时间戳并不单调，直写会重排工具顺序 | `src/writers/opencode-classic.mjs` |
| 轮首附件先归位到本轮第一条 user 消息之后 | 把附件降级成 assistant 侧占位文本的宿主（12 家）会先发一条 assistant 消息，读侧 `assembleTurns` 因此凭空多开一轮、核心指纹整体平移一格 | `src/ir.mjs` `normalizeTurnItems` + `src/writers/index.mjs` `getWriter`（写侧唯一入口） |

轮首附件是**写侧共用的输入假设**：12 家把附件降级成 assistant 侧内容、6 家把附件并进 user 侧，
只有前者会在附件排在本轮用户消息之前时失真。因此归位放在 `getWriter()` 这一处，
不在 12 个 writer 里各修一遍；`coreItem` 不收附件，挪顺序不改变会话身份。
`normalizeTurnItems` 只动「第一条 user 消息之前」的附件：附件已在用户文本之后、
或整轮没有用户消息时原样返回（后者没有可归位的目标）。

读侧配套两条：工具/推理件只挂到**当前最后一条**助手条目（向后查找更早的会把后一轮的工具错挂进前一轮）；
「开一轮」必须有可展示内容 —— WorkBuddy 原生用 `content: []` 的 user 事件标记「只有助手发言的一轮」
（本机两家共 86 个），别的宿主读不出这种轮次，因此空标记一律并进上一轮，各家口径一致。

验证：`test/m37-turn-boundary.test.mjs`（三类形状逐一回读 + 轮首附件的 18 目标全矩阵 + 归位边界）
+ `test/m7-matrix.test.mjs`（源里带多段用户文本，17 个目标逐个比对核心指纹）。

---

## 5. 源侧去重与批内去重

**源侧去重（计划期，`sourceDuplicates`）**：`--from` 里同一 `originKey` 的多份副本，
先按摘要（轮次）排序，然后**读 IR 算核心指纹**判定关系：

| 关系 | 处理 |
| --- | --- |
| 某副本是另一份的严格前缀 | 丢弃短的那份，`provenance`/`account` 并入保留者 |
| 完全相同 | 只留一条（优先保留带 provenance 的） |
| 分叉（互相都不包含） | 全部保留，交给执行期按候选集各自落位 |

轮次少**不等于**前缀，所以摘要只能排序，判定必须落到内容。单副本组不读正文，零额外开销。

**批内去重**：键是 `(目标, 目标ID, 源身份)`，只折叠真正重复的同一源；
不同源即使映射到同一目标槽位也不折叠（折叠会静默丢掉一条分支），由执行期锁内重校验分家。

---

## 6. 已知边界

- **reasoning 丢失**：claude/codex/dsh/opencode/mimo/workbuddy/freebuff 之间可传；pi 与 cline 无对应通道，会丢。核心指纹不受影响。
- **工具输出截断**：长输出可能被目标宿主截断，不影响身份判定。
- **空会话**：`turns === 0` 且轮次为精确值时会跳过；采样得到的 0 不可信，不据此丢弃。
- **标题**：`create` 保留原标题；`fork` 会加 `[origin变体]` 前缀便于区分。
