# CLI 参考

所有命令都通过 `node "<安装目录>/bin/session-sync.mjs" <子命令> [参数]` 调用。
安装后路径通常是 `~/.agents/skills/session-sync/bin/session-sync.mjs`。

全局开关：`--json`（输出机器可读 JSON，放任意位置均可）。

---

## selftest

```
session-sync selftest [--json]
```

环境与核心逻辑自检：Node 版本、`node:sqlite`、`node:zlib` 的 zstd、变体注册表、
uuid5/uuid7、身份派生确定性、round-trip 收敛、provenance round-trip、diff 决策、
指纹稳定性、路径解析。

14 项全 `PASS` 才说明环境可用。退出码 0 表示全通过。

---

## detect

```
session-sync detect [--json] [--data-root <变体>=<目录>,...]
```

输出四项汇总：

- `host`：当前宿主变体 + 当前会话 id + 判定依据（环境变量名）
- `installed`：本机探测到数据的变体
- `readable`：有 reader 实现的变体
- `writable`：有 writer 实现的变体

`installed` 之后逐家输出一行根定位证据（`rootSummary`）：用了哪个根、属于哪一档
（flag/env/pin/probe/default）、拒绝了几条候选、探测命中几处。装了不等于读得到，
排「not installed」先看这批行。

- `--data-root <变体>=<目录>`：显式钉住某个变体的数据根（最高优先档，多个用 `,` 分隔）。
  探测认不出的目录（改过名、非常规宿主形态）只能靠它点名。
- 写侧被探测档拒收时，`import`/`status` 的返回里带可直接粘贴的
  `--data-root <变体>=<目录>`（`roots[].paste`）；`detect` 逐家行同样给出。

`--into` 省略时，`status` / `import` 用的就是这里的 `host.variant`。

---

## accounts

```
session-sync accounts [--into <变体,...|auto>] [--json]
```

**只读**。逐变体输出账号模型与本机实测到的账号，是 `switch-account` 的前置（36 位 uid 没人记得住）。

- `accountModel`：
  - `partition` —— 会话/项目的可见性按账号分区，**可以切**：`codebuddy-ide`、`codex`、`workbuddy-cn`、`workbuddy-intl`
  - `single-account` —— 有登录态，但本地会话行不带账号归属，切了也不改变宿主可见性
  - `none` —— 未发现任何账号身份落点
- `evidence`：这一家「登录态在哪、会话表有没有账号列」的实测依据（路径 + 行数）。缺项视为未取证，
  `test/m52` 断言每个变体都必须有一条带可核对路径的结论 —— 曾经因为扫描深度参数写错，
  三层深的库整批没打开过，「没扫到」被误写成「没有账号概念」
- `current`：当前登录账号（能确定时）。CodeBuddy IDE 的登录态本机没有可信落点 → **固定报 `null`**，
  不拿「哪个目录最新」冒充登录账号
- `accounts[]`：`{id, name, ide, sessions|threads|conversations, workspaceKeys, isCurrent}`

---

## list

```
session-sync list [--from <变体,...|auto>] [--since 7d] [--until 2026-10-01]
                  [--project <cwd子串>] [--id <会话ID,...>] [--limit N] [--include-subagents] [--include-empty] [--json]
```

列出源会话（**默认不列 0 轮会话**，`--include-empty` 才显示）。`--from` 省略 = **全部变体**（未安装的自然为 0 条）；`--from auto` = 只取本机探测到数据的变体。`--limit` 是全局条数上限（按 `updatedAt` 倒序截断）。

输出列：`时间 / 变体 / 标题 / 所属项目 / 会话ID / 轮次 [scope][acct][match][来源][archived]`。
**所属项目只显示项目名**（宿主自己的项目名协议：qoder `workspaces.name`、codex 注册表 `local-projects[*].name`、
zcode `projects.name`、dsh workspace `title`、workbuddy `workspace-display-names.json` 的 `displayName`、
minimax localStorage 的项目别名、opencode/mimo `project.name` → `worktree` 末段；其余按目录名，
详见 `references/agent-storage.md` 各变体 V8），非项目会话固定显示 `非项目会话`；完整路径仍在 `--json` 的 `cwd`。
项目名只用于展示，不参与 `--project` 过滤与落点判定。

- `[scope]` = `project`（挂在真实项目目录）或 `none`（挂在宿主自己生成的非项目工作区）。
  它决定导入后**宿主能不能把它列成非项目会话**，不参与「是不是同一条会话」的判定。
- `[acct …]` = 源宿主的登录账号 id（codex `creator_user_id` / workbuddy `sessions.user_id` / qoder `chat_session.user_id`）。
  无账户信号的变体为 `null` —— **绝不按目录猜**。读侧从不按账户过滤（全部账号的会话都列）。
- `--project <子串>` 同时匹配「当前 cwd」与 provenance 里记录的落点/源目录，`--json` 的 `matchedBy`
  字段标明命中了哪一个（会话被搬过家之后，按原名仍要搜得到）；文本视图会打成 `[match:origin-dir]` 这类标签。
- `--id a,b` 只列指定会话（原生 id，精确匹配）。`--json` 的 `missingIds` 列出「指定了但没找到」的 id ——
  先 `list --id` 核对、再 `import --id` 是同一条口径。
- **按名字/标题找会话没有开关**：`list` 的标题列（`--json` 的 `title`）就是会话名，先按名字找到 id，
  再用 `--id` 导入；不要臆造 `--title` / `--name`（会被判未知参数）。

**时间与工作区（`--project`）的口径**（list / status / import 一致）：

- `--since` 看会话的 `updatedAt`；`--until` 纯日期表示**到这一天为止（含当天）**，等价于当天 23:59:59.999（UTC）。
- 给了时间范围时，**没有时间戳**（`updatedAt=0`）的会话无法证明落在范围内 → 不导；`import/status` 的
  `timeUnknownSkipped` 会给出条数。不带范围时它们照常参与，`list` 也始终能看到。
- `--project` 与 `--since/--until` 是**与**关系：只导「该工作区里、且在该时间段内」的会话。

轮次后带 `~` 表示该数字来自采样（大文件不全量解析）；标题带 `(degraded)` 表示该会话只能读到元数据。
带 `[archived]` 的行**只出现在 list**：归档会话一律不进导入候选（无开关）。

---

## show

```
session-sync show --from <变体> <会话ID> [--json]
```

以 IR 形式展示单个会话（轮次 + 条目类型）。条目类型：
`message` / `reasoning` / `tool_call` / `tool_result` / `attachment` / `meta` / `note`。

`--json` 会带上 `origin`、`chain`、`meta`，排查身份问题用它；`scope` / `scopeReason` / `account`
与 `list` 同口径（`scopeReason` 说明这个分类是靠什么得出的：`internal-root:<变体>` / `placed` /
`reader` / `empty-cwd` / `project-dir`）。

---

## status

```
session-sync status --from <变体,...> [--into <变体,...>]
                    [--since/--until/--project/--limit/--id]
                    [--include-subagents] [--include-empty] [--json]
```

**只读**。输出每个 `(源会话 × 目标)` 的计划动作：`create` / `append` / `fork` / `skip` / `error`。

- `--into` 省略 → 用探测到的当前宿主
- `--limit N` → **每个来源**各取最近 N 条
- `--id a,b` → 只处理指定会话 id（精确匹配原生 id）。指定的若是「被源侧去重折叠掉的副本」，
  会自动映射到内容更全的保留副本；导不出任何结果的 id 会列在 `missingIds` 里（归档 / 空会话 / 根本不存在）
- 默认跳过空会话（0 轮且轮次为精确值）；`--include-empty` 保留
- **正文加密/只能读元数据的会话默认不导**（qoder 旧代 `local.db` 这类）：计划里计 `degradedSkipped`，
  显式 `--include-degraded` 才放行（导过去只有「内容加密」占位说明，等于空壳）

文本输出只列非 skip 的行（最多 30 条），全量用 `--json`。

---

## import

```
session-sync import --from <变体,...> [--into <变体,...>]
                    [--since/--until/--project/--limit/--id]
                    [--cwd <目录>] [--account <id>] [--placement auto|project|bucket|cwd]
                    [--include-subagents] [--include-empty]
                    [--apply | --dry-run] [--force]
                    [--lock-timeout <ms>] [--no-lock] [--json]
```

参数语义同 `status`。差别是**可以真正写盘**：

- 默认 dry-run（`executed: false`）
- `--apply` 落盘；`--dry-run` 显式覆盖（同默认）
- `--force` 允许覆盖已存在的目标会话（覆盖前备份到 `<home>/.session-sync/backups/<变体>/<相对 home 的原路径>.bak-<时间戳>`，宿主扫描根内不留 `.bak`）

落点（placement）四档，dry-run 与 `--apply` 都会逐条打印 `scope → directory [source]`：

| `--placement` | 语义 |
| --- | --- |
| `auto`（默认） | 项目会话按源 cwd；非项目会话进目标宿主自己的桶（`generated` 每会话一目录 / `shared` 共用固定目录） |
| `project` | 一律按源 cwd（哪怕源本来是非项目会话） |
| `bucket` | 一律集中进目标桶（想看「全部非项目」时用） |
| `cwd` | 一律用 `--cwd`（没给就退回源 cwd） |

`--cwd <目录>` 是给「目标宿主结构上没有非项目落点」的变体兜底的：这类条目记
`skipped(requires-cwd)`，**一个文件都不写、不建目录、不失败整批**，报告末尾单列
「待用户指定目录」；补上 `--cwd` 再跑同一条就落地。不做交互式追问（`--json` 与管道场景必须无副作用）。

`--account <id>` 决定写侧归属（workbuddy 落 `sessions.user_id`、codex 落 `creator_user_id` + `creator_account_id`）；
**源会话自带的那一行账号绝不会被带过来** —— 它是「来源宿主那一侧」的归属，跨 agent 时甚至属于另一个
命名空间（codex 的 `user-xxxx`、workbuddy 的 uuid、qoder 上一代库的 `user_id`），而各家列表谓词都是
「归属 = 自己这个账号」，挂上去等于写进没人能看见的桶里且不报错。所以省略 `--account` 时取
**目标宿主的当前登录账号**（`src/accounts.mjs` 的 `currentAccount` 是这件事的唯一出口：workbuddy =
`<安装根>/storage/skeleton/account-snapshot.json → primary.uid`，codex = `<CODEX_HOME>/auth.json` 的
`tokens.account_id` + id_token claims，codebuddy-ide 本机无可信落点 → 返回 null 由 `--account` 点名）。
再取不到就落目标宿主默认账号 `local` 并在 `warnings` 里标 `account-snapshot-missing`（`account:target-default`）。
**绝不**用「库里有没有这个 uid 的行」反推当前账号。源侧永远全量导入（不按账号筛）。
`--account` 同时决定 workbuddy 历史行的改标归属（不只是新行）。

搬迁是必需的而非可选：改落点只会**移动同一个 targetId**（身份不含目录），
所以 append 前会先按 id 找回既有正文、整份搬到新目录，备份放在
`<home>/.session-sync/backups/<变体>/`（宿主扫描根之外，避免被宿主读成第二条会话），
结果里带 `relocated: …` 警告。

宿主身份与同族双份：

- 省略 `--into` 时目标只认「唯一锁定」的当前宿主。S1 环境指纹判不出时会查一次**入口证据**
  （祖先进程链上的可执行文件路径，以及宿主按 pid 自生成的归属文件）；仍判不出就报用法错误、
  一个字节都不写。绝不挑「最近被改动的那个」—— 判错一次的代价是写进另一个安装，事后无从发现。
- `detect --trace-entry` 打印这条链与命中的判据；宿主判不出时这是唯一能现场取证的地方。
- 默认情况下，若同族另一版（`workbuddy-cn` ↔ `workbuddy-intl`）已经有同一来源的会话，
  该条中止为 `skip(edition-duplicate)`，报告里给出那份的变体、id、路径与轮数；
  确认要在两版各留一份才加 `--allow-family-duplicate`，想接着另一版用就把 `--into` 指过去。

并发相关：

- 每个 `(源,目标)` 的写入在 `target:<变体>` 跨进程锁内完成；拿不到锁 → `error: lock-timeout`
- `--lock-timeout <ms>` 抢锁超时，默认 30000
- `--no-lock` 关闭锁（仅排障用，会失去跨进程保护）
- 拿到锁后会**重新读目标并重新判定**，所以陈旧计划（plan 之后宿主/其它进程又写了内容）不会盲写

`--apply` 在写入前还会对**每个目标**做一次历史导入行自愈（老版本写出的、会让宿主列表
报错的脏行：OpenCode 的裸 uuid / project 不符 / NULL path / 消息缺字段，WorkBuddy 的缺失索引）。
自愈只碰 `session-sync` 导入的行（带了 provenance 标记），原生会话不动。

写入后自动做一次读回校验（核心指纹比对），结果在 `verify` 字段。

退出码：任一写入失败**或校验失败（verify-failed）** → `2`；`--apply` 却一条都没写成 → `3`；
dry-run 一律 `0`（它本来就不写，报 `3` 会让探测脚本误判）。

`--json` 的 `results[]` 每项含：
`sourceVariant / sourceId / target / targetId / action / executed / ok / path / lines / backup / warnings / placement / verify / index / concurrentRetries / hint`

- `placement`：`{scope, directory, source, account, warnings[], hint?}` —— 这条会话落到哪、为什么这么落
  （`project-dir-missing` 表示源项目目录已不存在：仍原样保留，但宿主可能不列）
- `status: "skipped"` + `reason: "requires-cwd"`：该条被跳过（不是失败），等 `--cwd`
- `action: "skip"` + `reason: "target-archived"`：目标侧已归档的同 id 会话 —— D1 只把它当「已存在」，
  不改写、不搬迁、不重新登记回宿主列表
- `action: "skip"` + `reason: "round-trip-self"`：源与目标是同一条会话（自同步 / 全量互导），
  内容必然一致；伴随 `relocate-foreign` 时表示该正文是宿主原生行，落点自愈故意没动它
- `summary` 里对应计入 `skipped:requires-cwd`
- `index`：WorkBuddy 索引表写入结果（`{ok, created}` / `{ok, skipped}`）
- `concurrentRetries`：追加时因并发改动重建重试的次数
- `hint`：失败时的补救建议（例如索引写失败后重跑可自愈）

---

## switch-account

```
session-sync switch-account --into <变体,...> --id <会话id,...> --account <目标uid>
                            [--ide <CodeBuddyIDE|VSCode>] [--cwd <目录>]
                            [--keep-source] [--only-imported]
                            [--apply | --dry-run] [--force]
                            [--lock-timeout <ms>] [--no-lock] [--json]
```

把**一条已存在的会话**换到另一个登录账号。与 `import --account` 是两件事：后者只决定「这次写入的新行归谁」，
本命令改的是宿主里已有数据的归属。

- `--id` 必填。不给 id 就等于一次改整库的归属，这个口子不放开（批量请逐条确认）
- 默认 dry-run；`--apply` 才写。整个变体在 `target:<变体>` 跨进程锁内执行，与 `import` 共用同一把锁
- 身份不变：账号与目录一样，**绝不参与「是不是同一条会话」**，切换保持同一 targetId
- 宿主原生会话（没有 session-sync 标记）也允许切，但逐条打 `foreign-switch-authorized` 审计行；
  只想动本工具导入过的会话加 `--only-imported`
- `--keep-source`：在目标账号另建一份、源账号那一份保留（默认是搬走，源侧不再可见）
- 目标账号已有同 id 时先比核心指纹：内容相同 → 收敛成一份（`converged`，重跑即 `already`）；
  不同 → `content-diverged` 拒绝，两份都留着，`--force` 才替换（替换前备份目标）
- 备份：**全部**落在 `<home>/.session-sync/backups/<变体>/`（写前快照按相对 home 的原路径镜像，一眼能对回是哪个文件）；只改列的没有文件可备份 →
  写前把原值快照到 `<home>/.session-sync/backups/<变体>/switch-*.json`

按宿主动什么：

| 变体 | 分区形态 | 写入动作 | 补 project |
| --- | --- | --- | --- |
| `codebuddy-ide` | 目录 `Data/<user>/<ide>/<uid>/` | 搬 `history/<md5>/` 正文 + `check-point`/`file-tree`/`plan-task` 同坐标平行目录，双向改工作区 `index.json` | **要**：目标账号没这个项目时按导入同一条路径补 `history/<md5>/index.json`（dry-run 预告 `[会补 project]`） |
| `workbuddy-cn` / `workbuddy-intl` | 列 `sessions.user_id` | 单行 `UPDATE user_id`（`deleted_at` 行拒绝：`row-deleted`） | 不需要：`workspaces`/`projects` 按安装共享 |
| `codex` | 列 + 头行 | rollout 首行 `session_meta.creator_*` + 线程库 `threads` 两列一起翻（`.jsonl.zst` 原地整帧重压） | 不需要：`local-projects` 按安装共享 |
| 其余（qoder/minimax/mimo/zcode/dsh/freebuff/codebuddy/opencode） | `single-account` | 不写，回 `switch-unsupported` + 依据 + 替代路径 | — |

- `--cwd`：CodeBuddy 的会话目录名是 md5，正文里又没有 `Workspace Folder` 注入时恢复不出项目 →
  报 `cwd-required` 并要求补 `--cwd`，绝不造宿主不打开的目录
- `--ide`：同一账号在 CodeBuddyIDE 与 VSCode 两层各有一套缓存时用它收窄
- 写完的读回校验：`verify.readBack` 是重新 `list` 出来的归属；CodeBuddy 另有 `host-restart-needed`
  （外部改缓存不会推给宿主 UI，扩展日志 `Loaded N conversations from HistoryStorage` 才算生效）
- Codex 会固定带 `state5-host-predicate-unmeasured`：宿主列表是否真按 `threads.creator_*` 过滤未取证

---

## verify

```
session-sync verify --into <变体> <会话ID>
                    [--expect <变体>:<会话ID>] [--mode create|append|fork] [--strict]
```

读回目标会话并与源比对。

- `--expect` 给源会话；省略则只报告目标自身的轮次与 provenance
- `--mode fork` 用分叉比对规则
- `--strict` 用**全量**指纹（含 reasoning / tool_result 输出）。默认用核心指纹（消息文本 + 工具调用），因为 reasoning 与工具输出跨宿主不可靠

---

## repair

```bash
session-sync repair --into minimax --id <session-id> [--apply]
```

按会话预览或修复 MiniMax 历史。对于原生导入，若活动链、工作区、来源及原发布 revision 都通过校验，`--apply` 可补缺失的宿主物化登记。旧标签转原生仍遵循原生写入的探针限制。

此命令也可补齐已验证的原生导入记录中缺失的助手 `provider`。预览返回 `assistantProviderMissing`。改写活动文件和恢复待发布事务均要求启用隔离探针，实际补齐条数由 `assistantProviderRepaired` 返回。首次物化登记只涉及 SQLite，可独立补齐。

## install

```
session-sync install [--host <变体,...>] [--root <路径>] [--cwd <项目目录>]
                     [--dry-run] [--force] [--no-shared]
```

- **共享根 `~/.agents/skills/session-sync/` 必装**（`--no-shared` 可跳过，但不推荐）
- `--host` 省略 → 自动探测：为本机已安装且有 skill 目录的 agent 全部建桥
- 桥接方式：在各家 `skills/<name>/SKILL.md` 写一份渲染后的 SKILL.md（CLI 路径指向共享根，单一事实源）
- CodeBuddy：桥接写到 `~/.codebuddy/skills/session-sync/SKILL.md`。CodeBuddy Code CLI 与 IDE/插件共用该目录（主进程 `getUserSkillsDir()` 固定 `.codebuddy/skills`），`--host codebuddy` 装一次即可
- `--root` 覆盖共享根位置
- `--cwd` 指定项目目录（Freebuff 的薄封装写在这里）
- `--dry-run` 只报告不写
- `--force` 覆盖已存在的桥接文件

---

## uninstall

```
session-sync uninstall [--host <变体,...>] [--purge]
```

移除桥接；`--purge` 同时删除共享根。

---

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（含 dry-run：它本来就不写） |
| 1 | 用法错误 / 环境不满足 / 目标不可写 |
| 2 | 写入失败**或读回校验失败**（`verify.ok === false` 同样算失败：脚本不能把「写坏了」当成功） |
| 3 | `--apply` 但一条都没写成（全是 skip / error / 被写根采纳门挡住） |

分命令的细节：

| 命令 | 差异 |
| --- | --- |
| `import` | 上面的口径即 `import` 的口径；`status`（计划期）只要有会话读取错误就回 `1`，不会等执行 |
| `switch-account` | 计划期就失败（不可切 / 目标账号不合法）→ `1`；`--apply` 后写入失败 → `2`；`--apply` 但没一条真的执行 → `3`（「什么都没变」不该伪装成成功） |
| `install` / `uninstall` | 用 `ok` 判定：`ok === false`（含内部异常被转成结构化 JSON 的情形）→ `2`，否则 `0`。异常也走同一套 JSON，不会吐裸栈让调用方去解析 |
| `detect` / `list` / `show` / `accounts` | 只读命令，恒 `0`（除非参数非法 → `1`） |
| `selftest` | 全 `PASS` → `0`，否则 `1` |
