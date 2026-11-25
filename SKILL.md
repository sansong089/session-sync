---
name: session-sync
description: 在任意 coding agent 之间同步会话历史（n:n）。支持 21 个变体（含 CLI/Desktop/插件/中文版/国际版/OpenCode v1·v2 等多变种），--from 省略时默认取全部变体。把 OpenCode / Claude Code / Codex / CodeBuddy / CodeBuddy IDE·插件 / Pi / Antigravity / WorkBuddy(中/英) / Qoder(中/英) / ZCode / MiMo Code / MiniMax Code / DSH / Freebuff / Cline / Kilo / Roo Code / Cursor / Doubao 的会话导入到另一个 agent，成为其原生可恢复会话。幂等（同会话只导差异）、跨链路去重（同一会话经不同路径到达只保留一份）、round-trip 收敛（自己的会话导回来不会重复）。支持按时间范围、按项目、多来源多目的地批量同步，也支持把一条已有会话换到另一个登录账号（accounts / switch-account，含目标账号没挂载项目时补项目）。触发词：同步会话、导入会话、迁移对话历史、会话历史搬运、把 X 的会话导到 Y、切账号、换账号、会话换归属、切换登录账号、session sync、import sessions、switch account、copy chat history between agents。
---

# session-sync — 跨 agent 会话同步

把任意 coding agent 的会话历史，同步成任意另一个 agent 的**原生可恢复会话**。
调用本 skill 的 agent 默认就是**目标**；也可以显式指定目标。

CLI（本 skill 的唯一执行入口，零外部依赖）：

```
node "{{CLI}}"
```

下文所有 `session-sync <子命令>` 都指上面这条命令。

---

## 1. 何时使用

用户表达以下意图时使用：

- 「把 codex 的会话同步到 workbuddy」「导入 claude 的历史」「迁移一下对话记录」
- 「把最近 7 天的会话搬过来」「把 opencode 里 xx 项目的会话导到 pi」
- 「两边会话互相通一下」「把 A、B 的历史都合并到 C」
- 「我之前的会话在哪能接着用」

不适用：**导出成 markdown / 分享链接**（本 skill 只做 agent 之间的原生会话同步）。

---

## ⛔ 协议先行（功能性修改的硬规矩）

**各 agent 自身的存储规格统一登记在 [`references/agent-storage.md`](references/agent-storage.md)（V1–V9 九个维度，每条带验证状态标记【真机】/【源码】/【确认】/【待证】，标记不带日期）；本程序自己的实现规格在 [`references/program-spec.md`](references/program-spec.md)。**

任何功能性修改（reader / writer / roots / hosts / title-slots / identity / placement / accounts 等存储相关代码）：

1. **改前必读**：先读 `agent-storage.md` 里对应变体的 V1–V9——宿主规格是唯一事实源，与代码现场冲突时先修规格再改码；本程序机制同时对照 `program-spec.md`；
2. **改后必写**：同步更新涉及的规格项内容与验证状态；新规格项必须带状态标记；本程序机制变更同步 `program-spec.md`；
3. **待证不准入**：没有真机/源码证据的只能标【待证】并登记进 `agent-storage.md` 文末的「待证项清单」；
   修改代码涉及待证项之前，必须先取证，或经主人明确确认；
4. `test/m74` 是棘轮：两份文档缺一、变体缺维度、规格项缺标记、待证未登记、脚本清单挂空头支票、本规则文本被删，都会红。

---

## 2. 先理解三件事（否则会做错）

### 2.1 目标 = 当前 agent，除非用户说了别的

`--into` 省略时，CLI 会用环境变量指纹探测当前宿主（并顺带拿到当前会话 id）。
所以「同步到我这」不需要任何参数。用户说「导到 pi」才需要 `--into pi`。

### 2.1.1 写侧形态：用户没明示时，就是「调用本 skill 的这个 agent」的形态

同一个产品常有多形态（Cline 的 IDE 插件与 CLI、Codex 的 CLI 与桌面、Qoder 的桌面与 CLI）。
导入要写到哪一份，按下面顺序定，**不要自己挑一份写**：

| 顺序 | 依据 |
| --- | --- |
| 1 | 用户明示（「导到 IDE 插件那份」「导到终端那份」） |
| 2 | **当前调用本 skill 的 agent 的形态**（入口证据：可执行文件、安装目录、扩展目录）—— 用户没明示时就是它 |
| 3 | 目标产品在本机只有一个形态，且能判出来 |
| 4 | 多形态并存且当前宿主形态判不出 → 报 `form-ambiguous`，列出候选形态与各自路径，问用户选哪个；**一份都不写** |

口径：

- **不写多份**：同一条会话在多个形态各留一份会破坏幂等与去重（同一会话两处副本），除非用户明确要求。
- 形态 ↔ 变体 ↔ 数据根的对应关系见 `references/agent-storage.md` 的「变体形态矩阵」。
- 当前版本还没有把形态纳入判别（`detectHost` 只认变体）。遇到多形态产品时**不要假装知道**，按第 4 步处理。

### 2.2 身份是内容派生的，不靠登记表

每个会话有 `origin`（最上游原始会话）+ `chain`（经过的每一跳），随会话一起写进目标。
目标会话 ID 由 `originKey = <变体>:<原生会话ID>` 确定性派生，因此：

| 场景 | 结果 |
| --- | --- |
| 同一会话再导一次 | 目标 ID 相同 → 命中已有会话 → 只补差异或跳过 |
| codex→pi→opencode 与 codex→opencode 都做了 | 两条路径派生出**同一个** opencode 会话 ID → 只保留一份 |
| 自己的会话经别人绕一圈导回来 | 目标 ID = 自己的原生 ID → 收敛回原生会话，不产生副本 |
| 目标会话被本地改过（分叉） | 生成确定性 fork ID；同一分歧内容经不同路径得到同一个 fork |

### 2.3 四种动作，不要擅自替用户决定写不写

`status` 是只读预览，`import` 默认也是 dry-run，加 `--apply` 才真正写盘。

| 动作 | 含义 |
| --- | --- |
| `create` | 目标里没有同 origin 的活跃候选、派生 ID 也不存在 → 新建 |
| `append` | 身份相同（`originKey` 相等）且候选是源的严格前缀 → 增量追加到**最长**的那个候选（续接 parentId 链；原生会话同样允许，写侧剥离 provenance、不改落点） |
| `skip` | 完全一致 / 源被候选包含 / 同源副本已被更长副本覆盖（计划期折叠）/ 目标归档且无活跃候选 → 不动 |
| `fork` | 身份相同但与所有候选都真分叉 → 相对 LCP 最长的候选另建 fork；身份不同（派生 ID 上占位冲突）也 fork，绝不覆盖 |

**判据顺序是硬规则**：先身份（root 相等；原生目标的 root 就是它自己），再内容（严格前缀）。
身份不同绝不 append/合并；原生会话可被续写但保持原生（不写 provenance、不改落点）。

---

## 3. 标准工作流（默认按这个顺序做）

```bash
# 1) 看清环境：哪些 agent 装了、哪些能读、哪些能写、当前宿主是谁
session-sync detect

# 2) 只读预览：每个(源会话 × 目标)将要做什么
session-sync status --from codex,claude --since 7d

# 3) 确认后落盘（--apply 是关键，漏了就是干跑）
session-sync import --from codex,claude --since 7d --apply

# 4) 需要时单独复核某个会话
session-sync verify --into workbuddy-intl <sessionId>

# 5) 要把某条会话换到另一个登录账号：先列账号，再按 id 点名（同样是默认 dry-run）
session-sync accounts --into codebuddy-ide,workbuddy-cn,codex
session-sync switch-account --into codebuddy-ide --id <会话id> --account <目标uid> --apply
```

**给用户汇报时**：先说 `actions: create N append N skip N`，再列出实际写入的几条（源 → 目标、行数、校验结果）。不要把 skip 的逐条列出来。

---

## 4. 自然语言 → 参数映射

| 用户这么说 | 用什么 |
| --- | --- |
| 「把 codex 的会话同步过来」 | `--from codex`（目标自动 = 当前 agent） |
| 「导到 pi 里」 | `--into pi` |
| 「最近 7 天 / 一周 / 今天以来」 | `--since 7d` / `--since 1w` / `--since 12h` |
| 「到 10 月 1 日为止」 | `--until 2026-10-01` |
| 「xx 项目的会话」 | `--project xx`（按 cwd 子串匹配） |
| 「xx 工作区最近 7 天」 | `--project xx --since 7d`（与关系；无时间戳的会话不导，`timeUnknownSkipped` 报数） |
| 「每个 agent 各来 5 条」 | `--limit 5`（**每来源**各 N 条，不是总数） |
| 「就这个会话」 | `--id <sessionId>`（可逗号分隔多个；先 `list --id` 核对，`missingIds` 报缺失） |
| 「那个叫 xxx 的会话」 | **没有 `--title` 开关**：先 `list` 按标题找到 id，再 `import --id <id>`（见 4.1） |
| 「A 和 B 的历史都并到 C」 | `--from a,b --into c` |
| 「A 导到 B 和 C」 | `--from a --into b,c` |
| 「A、B 分别导到 C、D」 | `--from a,b --into c,d`（笛卡尔积，去重后执行） |
| 「先看看会怎么动」 | `status` 或 `import` 不带 `--apply` |
| 「确认了，执行」 | 加 `--apply` |
| 「重新覆盖一遍」 | 加 `--force`（先备份到 `~/.session-sync/backups/<变体>/`，宿主目录里不留 `.bak`） |
| 「连空会话也要」 | 加 `--include-empty`（`list` 默认也不列 0 轮会话） |
| 「明明有这条却导不进来」 | 先看 `degradedSkipped`：qoder 旧代 `local.db` 的正文是密文，只能读元数据；
要么换有明文副本的会话（同题常另有 CLI jsonl，标题可能不同），要么 `--include-degraded` 硬导（只有占位说明） |
| 「DSH 的子代理会话也要」 | 加 `--include-subagents` |
| 「别当成项目会话，集中到一个地方看」 | `--placement bucket`（全部进目标宿主的非项目桶） |
| 「就按原来的项目目录放」 | `--placement project` |
| 「放到某个指定目录」 | `--placement cwd --cwd <目录>`（两者都要给：`--cwd` 单独用时只兜底没有桶的目标） |
| 「宿主没给桶，被跳过了」 | 补 `--cwd <目录>` 后重跑同一条 |
| 「挂到某个账号下」 | `--account <uid>`（省略时取**目标宿主**当前登录账号；源会话自带的账号不会被带过来；只影响**这次写入的新行**） |
| 「这条会话换到另一个账号」 | `switch-account --into <变体> --id <会话id> --account <目标uid>`（**必须点名 id**，默认 dry-run；可切的 uid 先看 `accounts`） |
| 「有哪些账号可以切 / 这个宿主按不按账号分区」 | `accounts [--into a,b|auto]`（逐变体报 `partition` / `single-account` / `none` + 取证依据） |
| 「宿主装在自定义目录 / 数据被搬走了 / 明明装了却查不到」 | `detect` 看逐家的根定位证据行（哪一档、拒了几条候选）；探测认不出（改过名的目录）就用 `--data-root <变体>=<目录>` 点名 |

时间参数写法：`30m` / `12h` / `7d` / `2w` / `2026-10-01` / `2026-10-01T12:00` / ISO 串。

### 4.1 按会话名字导（没有 `--title` 开关，组合现有命令）

用户说「把那个叫 xxx 的会话导过来」时，**不要猜 id、也不要加不存在的开关**，按三步走：

```bash
# ① 找到它：list 的标题列就是会话名（先用 --project / --since 收窄，避免翻全库）
session-sync list --from codex --project demo-app --since 30d   # 每行带「所属项目」列（宿主项目名；非项目显示「非项目会话」）
#   要给模型解析用 --json：sessions[].{variant,id,title}，标题在 title 字段

# ② 核对「要动的就是这条」：正式导入前先干跑，看 create/append/skip 与落点
session-sync import --from codex --into <目标> --id <上一步的 id> --dry-run

# ③ 确认后落盘（漏了 --apply 就是干跑）
session-sync import --from codex --into <目标> --id <id> --apply
```

口径与坑：

- **标题不是标识**：多数变体的标题取自首条用户文本，导入别家后可能被改写；fork 的标题还带 `[fork:…]` 前缀。
  「认名字」只用在这一步，落盘一律用 id。
- **同名多条**（不同变体各有一条同名会话）→ 把命中列表按 `变体:id` 给用户挑，别自己选。
- `list` 显示的是**变体内已合并**的结果：同一变体的多份副本只出一行（短副本被更长副本覆盖）；
  用户点的若是被折叠那份的 id，`import --id` 会自动导保留的那份（内容更全），`--json` 的 `sourceDuplicates` 里能看到映射。
- 一个名字都没命中时**不要扩大成全量导入**：先放宽 `--since` / 去掉 `--project` 再找一遍，仍没有就如实告诉用户。

---

## 5. 能力边界（务必先跟用户说清）

- **可写目标 19 家**：claude、pi、codex、codebuddy、codebuddy-ide、workbuddy-cn、workbuddy-intl、opencode、mimo、dsh、freebuff、cline、kilo、roo、zcode、minimax、qoder-cn、qoder-intl、antigravity
  （`roo` 与 cline/kilo 共用同一 writer，代码可写，但本机没有任何宿主内成功样本 —— 给用户承诺前要说清这一点；
  `codebuddy` 指 CodeBuddy Code CLI，会话在 `~/.codebuddy/projects/`；`codebuddy-ide` 指 CodeBuddy IDE / VS Code 插件，
  写入按其真实扩展缓存结构落盘，已在腾讯 CodeBuddy CN 1.106.1.0 做过 GUI 列表现场验收；
  `antigravity` 只写桌面 Hub（`~/.gemini/antigravity/` 正文库 + 侧栏摘要库双写），CLI/IDE 根不会成为目标）
- **只读 2 家**（能作源，不能作目标，原因见 `references/agent-storage.md` 对应变体 V6 / V7）：
  - `cursor`：composer 内部不变量 + 新代内容寻址 blob 链未文档化
  - `doubao`：侧栏 = 云端 + IndexedDB 缓存，本地 `.sessions` 不是会话注册表（外部写入不进列表，Q3 探针三处 oracle 全阴性）
  - 附：`antigravity` 的独立 IDE / 备份根里是旧加密 `.pb`，读侧跳过；老 `.db` 内嵌 JSON 与新 `.db` protobuf 均可读。

用户要求写入只读目标时：明确说明原因，并给出替代（写到某家可写目标，或只做反向同步）。

- **换账号（`switch-account`）只有 4 个变体可做**：`codebuddy-ide`、`codex`、`workbuddy-cn`、`workbuddy-intl`。
  判据不是「有没有登录态」（所有国产宿主都有），而是**会话/项目的可见性是否按账号分区**：
  - `codebuddy-ide` 按**目录**分区（`Data/<user>/<ide>/<uid>/history/<md5(项目路径)>/`，另有 `check-point`/`file-tree`/`plan-task` 三个同坐标平行目录）→ 切换 = 搬正文 + 三个平行目录 + **目标账号没挂载这个项目时按导入同一条路径把 `history/<md5>/index.json` 补出来**（报告里是 `project-created`，dry-run 就预告 `[会补 project]`）
  - `workbuddy-cn/intl` 按**列**分区（`sessions.user_id`）→ 切换 = 改那一列；项目表按安装共享，不需补
  - `codex` 按 `threads.creator_user_id/creator_account_id` + rollout 首行 `session_meta` 分区 → 切换两处一起翻；注册表按安装共享
  - 其余有登录态的（`qoder-cn/intl`、`minimax`、`mimo`、`zcode`、`dsh`、`freebuff`、`codebuddy`、`opencode`、`doubao`）是 `single-account`：本地会话行**不带账号归属**，改它不产生宿主可见的变化 → 命令如实报 `switch-unsupported` + 取证依据 + 替代路径，绝不静默；`claude`/`pi`/`cursor`/`cline`/`kilo`/`roo`/`antigravity` 是 `none`
  - 逐家的依据用 `accounts` 命令现查（表在 `src/accounts.mjs`，`test/m52` 断言每个变体都必须有带路径的结论）

- **落点（scope）问题不是失败，是分类**：目标宿主结构上没有「非项目会话」这一层时
  （claude / codebuddy / codebuddy-ide / pi / antigravity / cursor / cline / kilo / roo / freebuff / doubao），该条会被记为
  `skipped(requires-cwd)` —— **一个文件都不写**，报告末尾单列「待用户指定目录」。
  正确做法：问用户要一个目录，然后 `--cwd <目录>` 重跑同一条。**不要**自作主张造目录，
  宿主永远不会打开它（claude 的 `projects/--default--`、workbuddy 的 `default` 桶都已被实测证伪为 0 命中）。
- **导入后「看不到」先分清是 scope 还是数据**：
  - `scope=project` → 要在**该项目目录**里启动宿主才看得到（或把会话改判到桶里：`--placement bucket`）
  - `scope=none` → 已落在宿主自己的非项目工作区；OpenCode 的列表默认只看当前目录，`ctrl+a` 切「全部项目」
  - `qoder-cn/intl` 的项目会话 → 目标宿主没登记过该项目时，写侧会按宿主的 `save()` 形状补一行 `workspaces`
    （报告里 `workspace-created`），但外部写库拿不到宿主的 UI 推送 —— **要刷新或重开侧栏列表**才出现。
    只有目录在盘上不存在时才留空并告警 `workspace-unmatched`
  - `freebuff` 的项目会话 → 项目选择器只读 `<config>/recent-projects.json`（不是目录扫描），
    写侧会按宿主 save 形状补登记（新增报 `project-registered`）；目录不存在时不造假条目、
    告警 `project-unmatched`。历史导入缺登记的，复跑 `import --apply` 走 skip 自愈补齐
  - 都不是 → 才去查数据侧（索引行、注册表、provenance 槽位）
- **跨格式会丢的东西**（正常现象，不要当成失败）：`reasoning`（模型内部思考）多数宿主不保留；`tool_result` 长输出可能被截断。因此幂等/去重判定用的是**核心指纹**（消息文本 + 工具调用），不是全量内容。
- **「同一会话」的硬不变量是轮次边界保真**：写进某宿主再读回来必须还是同一串轮次，否则 LCP 提前截断 → 续写被误判成 `fork`。一轮的用户文本只发一条消息、同角色相邻消息合并后再哈希、附件占位行 `[attachment] …` 不进核心、部件时间戳写入时钳成单调。改动 writer 或 reader 后必须跑 `node --test test/m37-turn-boundary.test.mjs test/m7-matrix.test.mjs`，细则见 `references/identity.md` §4.4。

---

## 6. 目标 agent 正在运行时可以导入

这是默认支持的场景，不需要用户先关掉目标 agent。三层保障：

| 层 | 做法 | 效果 |
| --- | --- | --- |
| 跨进程锁 | 每个 `(源,目标)` 的写入在 `target:<变体>` 锁内完成（锁文件在系统临时目录，持有者进程死亡或超时自动可抢占） | 多个 session-sync 同时跑，不会互相覆盖 |
| 写前重校验 | 拿到锁后**重新读目标并重新判定** | 宿主或另一个进程刚写了新内容 → 自动改成 append / skip / fork，不会按旧计划盲写 |
| 原子写 | JSONL 整文件用 temp+rename；追加用单次 `O_APPEND` 写 + 大小校验重试；SQLite 用 `busy_timeout` + 单事务 | 宿主任何时刻读到的都是完整版本，不会读到半个事件行 |

实测：3 个进程同时向同一目标导入同一会话 → 1 个 `create` + 2 个 `skip`，目标只有 1 个会话文件、19 行、0 坏行。

- 抢锁超时默认 30 秒，`--lock-timeout <ms>` 可调
- `--no-lock` 关闭锁（仅排障用；会失去跨进程保护）
- 目标库被宿主长时间独占时会返回 `lock-timeout`，如实告知用户重试，不要静默重试

### WorkBuddy 的两个落点

WorkBuddy 的会话列表读的是 `workbuddy.db` 的 `sessions` 索引表，**不是**目录扫描。
所以写入时会同时写「jsonl 正文 + db 索引行」，缺一不可：

- 索引写入失败 → 该条 `ok:false` + `error:index-write-failed`（正文已在，重跑会走 skip 并自愈索引）
- 索引库不存在 → 降级为警告，正文仍写入（宿主首次启动后可能需重建索引）

---

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| `not installed` | 该 agent 的数据目录没被找到。先看 `detect` 逐家的证据行（用了哪个根、哪一档、拒了几条候选、探测命中几处）；工具已经会主动探测被搬走的目录（按目录名 + marker 判据），改名过的目录探测认不出，用 `--data-root <变体>=<目录>` 点名 |
| `lock-timeout` | 目标 agent 的库/文件正被另一个进程独占。等几秒重试，或加大 `--lock-timeout`。**不要**用 `--no-lock` 绕过（会失去并发保护） |
| 判出来的宿主不对（例如中文版被判成 `workbuddy-intl`） | 中英判别与根定位是两件事：判别只看进程信号的**值匹配**，定位看宿主根变量与默认位置。WorkBuddy 的正解是根名的**最后一段**是不是 `.workbuddy-ai`（后缀式匹配会把 `my-workbuddy-ai` 也算成国际版，见 `references/environment.md` §6）。`detect` 会显示终态：`(ambiguous)` 时列出候选且**不再有默认目标**，必须用 `--into <正确变体>` 显式指定；`(unknown)` 表示没有任何身份信号 |
| `index-write-failed` | WorkBuddy 索引表写入失败（正文已写入）。检查 `workbuddy.db` 是否被独占/只读；修复后重跑 `import`（会走 skip 并自愈索引） |
| 写了但宿主看不到（WorkBuddy） | 索引行缺失。重跑一次 `import`（skip 分支会补索引）；仍不可见则确认 `workbuddy.db` 路径与 `--into` 变体是否匹配 |
| 写了但宿主看不到（OpenCode） | 老版本导入的行缺 `ses_` 前缀 / project_id 与目录不符 / `path` 为 NULL / 消息缺 `agent`·`model` —— 重跑一次 `import --apply`，会对历史导入行（含消息）一次性自愈；约束清单见 `references/agent-storage.md` 的 §2 V6 / V7 |
| 写了但宿主看不到（其它） | 先分清 scope：`scope=project` 要在该项目目录启动宿主才看得到；`scope=none` 才轮到查数据侧。分类看 `list --json` 的 `scope`/`scopeReason` |
| `skipped: requires-cwd` | 目标宿主结构上没有非项目落点（claude/codebuddy/codebuddy-ide/pi/cursor/cline/kilo/roo/freebuff/antigravity）。**不是失败**，也没写任何文件——问用户要一个目录，`--cwd <目录>` 重跑同一条 |
| `write-root-unpinned`（warnings/hint） | 探测档找到了这个变体的根（读没问题），但探测档不被写侧采纳（写会建目录/动库，风险更高）。返回里带了可直接粘贴的 `--data-root <变体>=<目录>`，粘上重跑同一条即可 |
| `documents-unvalidated`（warnings/hint） | 这个桶根所在的「文档」目录被重定向过、且新位置没找到宿主自生成的目录——即「说搬走了但没在哪儿找到它」。没写任何文件；给 `--cwd` 指定落点，或确认新位置后用 `--data-root` 点名 |
| 导入后宿主把它当成项目会话挂到别的项目下 | 落点判据在源侧就错了：核对 `list --json` 的 `scopeReason`。宿主自管根前缀命中优先于一切；确实需要集中看，用 `--placement bucket` |
| WorkBuddy 导入后列表里没有，但库里确有行 | 宿主列表谓词是 `user_id = 当前登录 uid`。写侧归属**只可能**是显式 `--account` 或目标宿主当前登录（`<root>/storage/skeleton/account-snapshot.json → primary.uid`，唯一出口 `accounts.mjs:currentAccount`），源会话那一行的账号不会被带过来 —— 所以行挂在别的 uid 下只剩两种解释：① 导入之后宿主又换了登录；② 那是宿主自己写的原生行。用 `list --json` 的 `account` 与 `accounts --into workbuddy-cn` 的 `current` 对照即可判定。`import --apply` 的自愈只会把**我们自己写过的行**（正文带 session-sync 标记）改标到当前登录 uid；要改**宿主原生行**或把某条挪去别的账号，用 `switch-account --id` 逐条点名（见下一行），别扩批量自愈 |
| 一条会话要换到另一个登录账号 | `switch-account --into <变体> --id <会话id> --account <目标uid> --apply`。只有 `codebuddy-ide`/`codex`/`workbuddy-cn`/`workbuddy-intl` 支持；其余变体会回 `switch-unsupported` 并说明为什么改了也没用（`accounts` 命令逐家给依据）。宿主原生行也允许切，但必须点名 id、写前留备份（改列的会落 `<home>/.session-sync/backups/<变体>/switch-*.json` 原值快照）、逐条打 `foreign-switch-authorized`；只想动导入行加 `--only-imported` |
| `skip(edition-duplicate)` | 同族另一版（`workbuddy-cn` ↔ `workbuddy-intl`）已经有同一来源的会话。两版共享派生 id，所以「写错版本」不报错、只在另一版静默再存一份，事后无从判定哪份是真的 —— 因此默认**中止该条**（报告里有那份的变体/id/路径/轮数）。想接着那一版用就把 `--into` 指过去；确认要在两版各留一份才加 `--allow-family-duplicate`。不是失败，别去「修」它 |
| 「同步到我这」被拒（`当前宿主没有可用的身份信号`） | 判不出当前宿主时本工具**不猜**：绝不按「最近被改动的是谁」定目标（判错过一次：在豆包里发起的导入被写成 workbuddy-cn 的 320 行，之后每次都选中同一家）。让用户点名 `--into`，或先跑 `detect --trace-entry` 看祖先进程链为什么没命中任何已登记宿主 |
| `skip(target-archived)` | 目标侧已有同 id 的**归档**会话（如 codex `archived_sessions/`）。D1 只把它当「已存在」：不改写、不搬迁、不重新登记回宿主列表。这不是错误，也不需要处理 |
| `skip(round-trip-self)` | 源与目标**就是同一条会话**（`--from codex --into codex` 这类自同步，或全量互导）。内容必然一致，所以既没写也没搬；旧版本把这种情况误标成 `target-archived`，现在分开标 |
| 写了但宿主看不到（Cline） | 4.x 列表只读**会话库**：`~/.cline/data/sessions/<id>/{<id>.json,<id>.messages.json}` + `db/sessions.db` 的 `sessions` 行（`state/taskHistory.json` 只是 legacy 迁移源）。逐项核对：manifest 是否带**绝对** `messages_path`（缺了只会列出、打不开正文）、db 行是否存在、`is_subagent=0` 且 `parent_session_id` 为空、`CLINE_DATA_DIR`/`CLINE_SESSION_DATA_DIR`/`CLINE_DB_DATA_DIR` 没被改到别处 |
| 写了但宿主看不到（Kilo） | 先看代际：有 `kilo.db`（7.8.18+，OpenCode 血统）就只认这个库 —— 本仓已按它写；没有 `kilo.db` 的是 ≤5.16.2，列表读 `state.vscdb` 的 `kilocode.kilo-code.taskHistory` + 任务目录 —— 本仓也已写。列不出来时先确认写的是不是当前代际的落点，不要同时写两代（会产生双份） |
| 写了但宿主看不到（Freebuff） | 会话在 `projects/<project>/chats/` 里没问题，但**项目选择器**只读 `<config>/recent-projects.json`。老版本导入只建目录不登记 → 项目不在选择器里。重跑一次 `import --apply`（skip 分支会补登记）；仍不可见则核对注册表里 `path` 是否指向真实存在的项目目录、是否被 10 条上限挤掉 |
| 导入 codex 时目标是 `.jsonl.zst` | 宿主会把历史 rollout 压成 zstd；写侧会原地整帧解压→追加→重新压成一帧（同名同文件），**不会**另起一份 `.jsonl` 残档 |
| `warnings` 里有 `account-mismatch` | 现库多数行属另一登录态（报告里写清了「我们改标 M 行 / 宿主原生 K 行未动」）。要换归属就显式 `--account <uid>` |
| `warnings` 里有 `relocated:` | 落点变了，既有正文已整份搬到新目录（备份在 `<home>/.session-sync/backups/`，不在宿主扫描根内）。同一会话仍只有一份，属预期行为 |
| `warnings` 里有 `project-created` / `target-root-derived` | 切账号时目标账号本机没有这个项目（或没开过那个 IDE 的 history 层）。写侧按导入同一条路径补 `history/<md5(项目)>/index.json`，并按源副本形态派生账号目录 —— 这是正常路径，但补出来的目录要宿主真去打开过该项目才有完整侧栏体验，报告里已给出绝对路径供核对 |
| `warnings` 里有 `host-restart-needed`（codebuddy-ide） | 外部改扩展缓存不会推给宿主 UI：扩展日志出现 `Loaded N conversations from HistoryStorage` 或重启 IDE 才算真正确认可见。别把「库里改完了」当成「宿主列出来了」 |
| `content-diverged` | 目标账号已有同 id 但内容不同。写侧保留两份、一个字节都不动；确认要用源覆盖目标才加 `--force`（先备份目标再替换）。内容完全相同则收敛成一份并打 `converged` |
| `warnings` 里有 `state5-host-predicate-unmeasured` | Codex：`threads.creator_*` 是否真的是宿主列表的过滤谓词**尚未取证**（本机 314/356 行为 NULL 就是反证信号）。两处都翻了，但别对用户承诺「一定在宿主里可见」 |
| `warnings` 里有 `account-root-unmatched` | `import --account <uid>` 指定的账号在本机没有 history 目录（codebuddy-ide）。导入不替用户凭空造账号目录；**本机只有一份账号坐标**时仍写进它并告警（不擅自改道），有多份时见下一行。要换账号用 `switch-account` |
| 报 `account-ambiguous`（codebuddy-ide） | 本机有**多个账号目录**而这次没给 `--account`。写侧不再按「谁最近被改过」挑账号（活动度只解释在用情况，不决定该写哪儿）——冷账号会被 mtime 挤掉，用户以为导进了 B、实际进了 A。先用 `accounts --into codebuddy-ide` 看 uid，再 `--account <uid>` 点名 |
| `switch-unsupported` | 该宿主的本地会话行**不带账号归属**（如 qoder 现行 `chat_sessions` 无账号列），改它不产生宿主可见的变化。返回里带取证依据与替代路径（qoder = 跨安装导入），不是 bug，不要去「修」它 |
| 写了但宿主看不到（ZCode） | ZCode 的侧栏读的是**第二个库** `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表，正文写进 `cli/db/db.sqlite` 不足以让它出现。`warnings` 里若有 `tasks-index-absent` / `tasks-table-absent` 就是这个原因；另外落点目录必须真实存在（宿主按目录打开），写侧已 `mkdir -p` |
| 写了但宿主看不到（MiniMax） | 主列表有 6 个硬门：`columnar_version=3`、`agent_name IN ('mavis','main')`、`archived=0`、`visibility<>'hidden'`、`session_kind NOT IN ('peek','cron')`、`parent_session_id IS NULL`，少一项完全不可见（侧栏分组靠 `project_id` 列，不靠目录） |
| MiniMax 压缩历史 | reader 回读可达快照链。普通导入保留标签摘要。原生写入可在隔离根验证，当前登录实例的真机探针仅创建单条合成会话。`repair --into minimax --id <id>` 预览已有标签能否原地升级。隔离写入中断时用同一隔离根重跑；若报告活动 revision 冲突，保留现场并查看 `references/program-spec.md`。 |
| 写了但 Codex 侧栏看不到，或打开后没有正文 | 查 `state_<N>.sqlite` 的 `threads` 索引、全局注册表及 rollout 的 `session_meta` 和 legacy 回放事件。对带 session-sync 来源标记的旧导入复跑同一条 `import --apply` 可自愈。`verify` 校验的是 session-sync 读回，桌面可读性用宿主 `thread/read` 复核。 |
| 写了但 CodeBuddy 看不到 | 会话必须在 `<root>/projects/<compressPath(真实 cwd)>/<会话ID>.jsonl`，行内 `sessionId` 与文件名一致；用 `codebuddy -r <id>` 复核（未登录时停在 auth 提示 = 已加载；提示 `No conversation found` = 没进对目录/文件名） |
| `target-exists` | 目标已有该会话且非 append 场景；确认后加 `--force`（会备份） |
| `unreadable-target` | 目标的既有正文**解不开**（坏行 / 压缩帧对不上）。写侧一律中止且一字不改 —— 把「读不懂」当成「没有历史」再整份重写，会真删掉用户历史。按消息里的路径修好或移走那个文件再重跑（`--force` 是显式授权的整份替换，会先备份） |
| `warnings` 里有 `relocate-foreign` | 该 skip 命中的目标是**宿主原生会话**（正文里没有 session-sync 标记）。落点自愈只搬我们自己写过的行，所以这里没搬、没改索引 —— 不是错误，别去「修」它 |
| `verify-failed` | 写后读回不一致。看 `--json` 的 `mismatches`；多为该宿主的格式约束导致，属于已知边界 |
| 想撤销 | 每条写入结果里有 `backup`（绝对路径，在 `~/.session-sync/backups/<变体>/` 下），复制回去即可；或删除目标会话文件 |
| 导入后出现重复会话 | 说明两边的 origin 不同（即它们本来就不是同一会话）；用 `show --json` 看 `origin` 对比 |
| 豆包（Doubao）会话没列出来 | 只收 main agent 的 `trajectory.jsonl` 非空的 `.sessions/<chatId>` 目录（空 agent 壳与只建了任务书的会话跳过）；会话根按 `Local State` 的 `profile.info_cache` 逐 Profile 扫，多开过 Profile 而这里读不到就是漏。豆包**只读**：写侧不进侧栏是宿主契约，不是 bug（`agent-storage.md` §22 V7） |

退出码：`0` 成功（含 dry-run）/ `1` 用法或环境错 / `2` 写入错**或读回校验失败** /
`3` `--apply` 但一条都没写成。`switch-account` 同理（计划期失败回 `1`、写失败回 `2`、一条没执行回 `3`）；
`install`/`uninstall` 以结果里的 `ok` 判定（`false` → `2`），内部异常同样转成结构化 JSON，不吐裸栈。

---

## 8. 参考文档

- `references/cli.md` — 全部子命令与参数
- `references/agent-storage.md` — 各家 agent 的存储规格：21 个变体（含各变种）按 V1–V9 九维度登记目录树、库全貌、逐列表结构、字段约束与可见性契约，逐项带验证状态标记
- `references/program-spec.md` — 本程序规格：根定位、标题同步、读写侧规矩、可写性矩阵、落点策略、并发写入与宿主注入约定
- `references/environment.md` — 运行环境判别规格：六维坐标（含版代 `gen`）、五层信号、R1–R6 硬规则、三终态、判据登记表；`test/m76` 是它的棘轮
- `references/identity.md` — 身份派生、provenance 结构、去重与分叉判定
- `references/host-onboarding.md` — 新增宿主的接入流程：本机取证 → 仓库接线 → 真机验收
