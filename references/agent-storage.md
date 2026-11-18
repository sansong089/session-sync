# 21 个变体的存储规格（各家 agent 的数据组织）

本文件只登记**各家宿主自身**的数据组织规格：数据落在哪、目录怎么分层、一会话由什么构成、
库里有哪些表、每张表的列与约束是什么、宿主靠什么把会话列出来。
本程序（session-sync）自身的实现规格见 [`program-spec.md`](program-spec.md)，两边不重复登记。

`<home>` = 用户主目录；`%APPDATA%` / `%LOCALAPPDATA%` 仅 Windows；`<slug>` / `<id>` 等为占位符。
**本文件是规格文档，不记录取证环境、版本快照与实例数据**；证据登记与待证 backlog 见文末。

## 规格说明

### 维度骨架

每家固定九节，缺一节即视为规格不完整（`test/m74` 棘轮会红）：

| 维度 | 回答的问题 |
| --- | --- |
| V1 数据根与定位 | 分平台默认根、官方环境变量、怎么认出这个目录属于本家 |
| V2 账号与多账号 | 登录态落点、存储是否按账号分区、会话是否带账号字段、切账号影响（账号直接决定部分宿主的存储落点，故紧随数据根） |
| V3 目录与库全貌 | 完整目录树（逐项职责）；有库的另列库内全部表与用途分组 |
| V4 会话边界与命名 | 一会话 = 文件 / 目录 / 表行；ID 形态；文件名与 cwd 派生算法 |
| V5 存储格式与编码 | 文件 / SQLite / 混合；JSONL / JSON / protobuf / 密文；压缩多帧与解码要点 |
| V6 数据结构 | 用到的表逐列列出（类型、长度、约束、默认值），或文件的顶层键与事件类型；索引 / 外键不列（与本项目无关） |
| V7 可见性与索引契约 | 列表从哪读、打开正文依赖什么、缺字段后果、标题裁决顺序 |
| V8 项目与工作区归属 | 项目判定、会话归属键、项目注册表、非项目会话、显示名来源 |
| V9 元数据与特殊会话 | 时间戳单位、去重 / 多副本、子代理 / 分支 / 压缩、宿主迁移 |

同一宿主的多个变体（中英版）合并成一节；同一宿主存在两套互不引用的存储形态时（opencode v1 / v2），
**各占一节、各自独立描述**，不写相互对比。

### 规格项标准化

每个维度的表格行名全库统一，逐家登记同一套规格项，列固定为「规格项 | 内容 | 证据」；
某家没有对应事实时写 `—` 并注明，不允许改成别的行名：

| 维度 | 固定规格项 |
| --- | --- |
| V1 | 默认根 / 官方覆盖变量 / 目录归属判据 |
| V2 | 登录态落点 / 账号分区 / 会话账号字段 / 切换账号影响 |
| V3 | 会话正文载体 / 列表索引与注册表 / 非项目落点（另附目录树与库全貌） |
| V4 | 会话边界 / 会话 ID 形态 / 命名与目录派生 / 非项目桶 |
| V5 | 正文格式 / 编码与加密 / 压缩与多帧 / 解码要点 |
| V6 | 存储实体 / 关键列与约束 / 标题落点（库形态另附逐列表结构） |
| V7 | 列表来源 / 打开正文依赖 / 标题裁决 / 缺字段后果 |
| V8 | 项目判定 / 会话归属键 / 项目注册表 / 非项目会话 / 项目显示名 |
| V9 | 时间戳 / 多副本与去重 / 子代理与特殊会话 / 宿主迁移机制 |

### 形态与版次的登记位置

形态（CLI / 桌面 / IDE 插件）与版次（中文版 / 国际版）是**产品的横切属性**，只登记在「变体形态矩阵」；
正文各节只写存储事实，标题与正文都不再重复这些字眼。

判据：形态差异若只影响「根与入口」，留在矩阵；若使会话结构、可见性、边界等多维不同（实现完全不同），
才在正文**独立成章**——例如 opencode v1 与 v2 各占一节。

### 验证状态与准入

| 状态 | 写法 | 含义 | 准入 |
| --- | --- | --- | --- |
| 真机 | `【真机】` | 在真实宿主上验证过：宿主 oracle、GUI 验收、现网数据逐条对照、镜像验收 | ✅ 默认准入 |
| 源码 | `【源码】` | 宿主本体取证：反汇编 / app.asar / dist 源码 / VSIX / 数据库 migration | ✅ 准入（证据等级次于真机） |
| 确认 | `【确认】` | 无宿主证据的判断，经主人明确拍板 | ✅ 准入 |
| 待证 | `【待证 待证-<变体>-<序号>】` | 没有任何上述证据 | ⛔ 不准入裁决：涉及该条前必须先取证或经主人明确确认 |

默认只有【真机】【源码】可进入本规格；【待证】必须带编号并登记进文末清单，状态只能升级。
标记不带日期与版本号——证据批次与取证脚本登记在「真机取证脚本清单」。

### 类型与长度语义（SQLite 库）

SQLite 不强制列类型与长度，文档里出现的类型按以下语义理解：

| 声明 | 实际行为 |
| --- | --- |
| `TEXT` | 文本亲和性；长度不受列定义限制，仅受 SQLite 全局 `SQLITE_MAX_LENGTH`（默认 10⁹ 字节）约束 |
| `varchar(N)` / `char(N)` | 在 SQLite 中等价于 TEXT 亲和性，`N` **不被强制**，超长插入不报错 |
| `CHECK(length(col) <= N)` | 唯一真正强制长度的写法；各家库里如出现会在对应表结构里登记 |
| `CHECK (col IN (...))` | 枚举取值校验，与长度无关 |

本规格登记的各家库的 `CHECK` 均为枚举校验，无任何 `CHECK(length(...))`——**文本列没有数据库级长度限制**，
字段长度约束只存在于宿主代码层。

## 变体形态矩阵

同一个产品可能同时有多种形态（CLI / 桌面应用 / IDE 插件），**各形态的数据根可能相同、也可能不同**。
本表是形态与版次的**唯一事实源**，按产品登记（一个产品的形态不因变体而变）；判别规程见
[`environment.md`](environment.md)，正文各节只登记存储事实、不再重复形态字眼。

三条口径：

- 形态判定**由入口证据定**（可执行文件、安装目录、扩展目录），不由数据根反推——数据根可能被多形态共用。
- 读写能力**由落点上有什么决定**，形态只用于解释与提示。
- 只有当形态导致**实现完全不同**（会话结构 / 可见性 / 边界等多维不同）时，才在正文独立成章，
  例如 opencode v1 与 v2 各自一节；仅根与入口不同的，一律留在此表。

| 产品 | 形态 | 形态改变落点 | 形态→变体 | 本机可见入口 | 各形态数据根 | 本程序已覆盖 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| opencode | cli | 否 | cli→opencode | `opencode` 可执行 | `~/.local/share/opencode/`（全平台统一 XDG） | cli | 【真机】 |
| claude | cli | 否 | cli→claude | `~/.claude/` | `~/.claude/`（桌面客户端是另一个消费端产品，不落此根） | cli | 【真机】 |
| pi | cli | 否 | cli→pi | `~/.pi/` | `~/.pi/` | cli | 【真机】 |
| antigravity | cli+ide-plugin+desktop | 待证 | cli→antigravity；ide-plugin / desktop→未接入 | `antigravity/Antigravity.exe`（桌面）、`Antigravity IDE/`（IDE）、`~/.gemini/antigravity-cli/`（CLI） | CLI 正文根 `~/.gemini/antigravity-cli/`；IDE 侧另有 `%APPDATA%/Antigravity/`；桌面与 IDE 的会话根未取证 | cli | 【真机】入口 ／【待证 待证-antigravity-1】 |
| codex | cli+ide-plugin+desktop | 待证 | cli→codex；ide-plugin / desktop→未接入 | `~/.codex/`（CLI）；IDE 扩展与桌面入口为官方另发的入口形态 | CLI `~/.codex/`；扩展与桌面形态是否复用此根未取证 | cli | 【真机】CLI ／【待证 待证-codex-3】 |
| codebuddy | cli+ide-plugin | 是 | cli→codebuddy；ide-plugin→codebuddy-ide | `~/.codebuddy/`（CLI）、`%LOCALAPPDATA%/CodeBuddyExtension/Data/`（IDE 插件） | 两套互不相同的根（CLI 项目目录 vs 扩展 Data） | 两者 | 【真机】 |
| workbuddy | desktop | 否 | desktop→workbuddy-cn / workbuddy-intl（按版次分变体） | `WorkBuddy.exe`（中文版）、`WorkBuddyAI` 安装体（国际版） | 中文版 `~/.workbuddy/`；国际版 `~/.workbuddy-ai/` | desktop | 【真机】 |
| qoder | desktop+cli | 是 | desktop+cli→qoder-cn / qoder-intl（按版次分变体） | `Qoder CN.exe` / `Qoder.exe`、`~/.qoder-cn/bin/` / `~/.qoder/bin/` | 桌面注册表 `%APPDATA%/com.qoder*.app.stable/`；CLI 正文 `~/.qoder-cn/` / `~/.qoder/` | 两者 | 【真机】 |
| zcode | desktop+cli | 否 | desktop+cli→zcode | `ZCode.exe`、`~/.zcode/cli/` | 同根 `~/.zcode/`（正文库 `cli/db/`，侧栏索引 `v2/`） | 两者 | 【真机】 |
| mimo | desktop+cli | 否 | desktop+cli→mimo | `Xiaomi MiMo.exe`、`~/.mimocode/bin/mimo.exe` | 同根 `~/.mimocode/` | 两者 | 【真机】 |
| minimax | desktop+cli | 否 | desktop+cli→minimax | `MiniMax Code.exe`、`~/.minimax/bin/` | 同根 `~/.minimax/` | 两者 | 【真机】 |
| dsh | desktop+cli | 否 | desktop+cli→dsh | `DeepSeek Harness.exe`、`~/.dsh/` | 同根 `~/.dsh/` | 两者 | 【真机】 |
| freebuff | desktop+cli | 否 | desktop+cli→freebuff | `Freebuff.exe`、`~/.config/manicode/` | 同根 `~/.config/manicode/` | 两者 | 【真机】 |
| cline | ide-plugin+cli | 是 | ide-plugin+cli→cline | IDE 扩展 `globalStorage/saoudrizwan.claude-dev/tasks/`、`~/.cline/`（CLI 三代会话库） | 两套互不相同的根 | 两者 | 【真机】 |
| kilo | ide-plugin+cli | 是 | ide-plugin+cli→kilo | `~/.kilo/bin/kilo.exe`、`~/.kilo/kilo.db`、IDE 扩展 `globalStorage/kilocode.kilo-code/tasks/` | 两套互不相同的根（库代与任务目录代） | 两者 | 【真机】 |
| roo | ide-plugin | 否 | ide-plugin→roo | IDE 扩展 `globalStorage/rooveterinaryinc.roo-cline/tasks/`；`~/.roo/` 下只有规则与技能 | 单根 | ide-plugin | 【真机】入口 ／【待证 待证-roo-3】 |
| cursor | ide-plugin | 否 | ide-plugin→cursor | `%APPDATA%/Cursor/User/globalStorage/` | 单根 `state.vscdb` | ide-plugin | 【真机】 |
| doubao | desktop | 否 | desktop→doubao | `Doubao.exe`（`%LOCALAPPDATA%\Doubao\Application\app\`） | `%LOCALAPPDATA%\Doubao\User Data\`（会话在 `<Profile>\.doubao\agent_mode\workspace\.sessions\`） | desktop | 【真机】 |

「形态改变落点」取值：**是** = 不同形态落在不同根，必须按形态选根；**待证** = 可能不同根但未取证；
**否** = 桌面与 CLI 共用一个根，形态不改变落点（判出来也不改变行为）。

一句话口径：**形态不同不等于存储不同**。zcode / mimo / minimax / dsh / freebuff 是「桌面与 CLI 共用一个根」，
qoder / cline / kilo / codebuddy 是「各形态各自一个根」，antigravity 与 codex 的多形态存储尚未取证。

---

## 1. opencode-v1 — OpenCode（三表 schema）

> **存储模型**：单库 SQLite，会话 / 消息 / 部件分三表存放，项目行单独一张表；库本身没有按会话划分的目录。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | 由 `XDG_DATA_HOME` 决定（Windows 走 Roaming），库文件固定为数据根下的 `opencode.db` | 【源码】 |
| 官方覆盖变量 | 宿主不认任何自定义数据目录变量 | 【源码】 |
| 目录归属判据 | 库内存在 `session` / `message` / `part` 三表 | 【源码】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（库内无账号分区） | 【源码】 |
| 账号分区 | —（无） | 【源码】 |
| 会话账号字段 | —（未登记账号列） | 【源码】 |
| 切换账号影响 | —（未见登记） | 【源码】 |

### V3 目录与库全貌

**【源码】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.local/share/opencode/            # XDG_DATA_HOME 下的数据根
├── opencode.db                          # 单库：会话 / 消息 / 部件 / 项目 / 权限全部在内
├── opencode.db-wal / -shm               # WAL 伴生文件
├── log/ tool-output/ snapshot/ shell/ repos/   # 日志、工具输出与运行时产物
└── opencode.db.bak-*                    # 宿主自身生成的库备份
```

**【源码】 库全貌与用途分组**：

**`opencode.db`（v1 schema）** —— 建表语句取自宿主自身的数据库 migration；一个库内同时存在以下七张表：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `session`, `message`, `part`, `todo`, `session_share` |
| 项目与工作区 | `project` |
| 权限 | `permission` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | 单库 SQLite：会话、消息、部件、项目、权限、待办、分享全部在库内，无每会话目录 | 【源码】 |
| 列表索引与注册表 | 库即全部，无独立注册表；库旁可有 `-wal` / `-shm` 伴生文件 | 【源码】 |
| 非项目落点 | —（无） | 【源码】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = `session` 一行；消息 = `message` 多行；部件拆到 `part` 多行，按 `message_id` + `session_id` 双重关联 | 【源码】 |
| 会话 ID 形态 | `ses` 前缀的文本 | 【源码】 |
| 命名与目录派生 | `slug` / `directory` / `version` 为非空文本列，`directory` 记录会话所在目录 | 【源码】 |
| 非项目桶 | —（无独立桶；列表按 `project_id` 组织） | 【源码】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | SQLite | 【源码】 |
| 编码与加密 | 明文，无加密；`message.data` 与 `part.data` 都是内联 JSON，部件类型与状态编码在各自 `data` 里 | 【源码】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | —（SQLite 直读） | 【源码】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `session`**（18 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | PK | — | 记录 ID |
| `project_id` | `text` | NOT NULL | — | 所属项目 ID |
| `parent_id` | `text` | — | — | 父会话 ID |
| `slug` | `text` | NOT NULL | — | 会话短名 |
| `directory` | `text` | NOT NULL | — | 目录标识 |
| `title` | `text` | NOT NULL | — | 会话标题 |
| `version` | `text` | NOT NULL | — | — |
| `share_url` | `text` | — | — | — |
| `summary_additions` | `integer` | — | — | — |
| `summary_deletions` | `integer` | — | — | — |
| `summary_files` | `integer` | — | — | — |
| `summary_diffs` | `text` | — | — | — |
| `revert` | `text` | — | — | — |
| `permission` | `text` | — | — | — |
| `time_created` | `integer` | NOT NULL | — | 创建时间 |
| `time_updated` | `integer` | NOT NULL | — | 更新时间 |
| `time_compacting` | `integer` | — | — | — |
| `time_archived` | `integer` | — | — | — |

表级约束：

- `CONSTRAINT 'fk_session_project_id_project_id_fk' FOREIGN KEY ('project_id') REFERENCES 'project'('id') ON DELETE CASCADE`

**表 `message`**（5 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | PK | — | 记录 ID |
| `session_id` | `text` | NOT NULL | — | 所属会话 ID |
| `time_created` | `integer` | NOT NULL | — | 创建时间 |
| `time_updated` | `integer` | NOT NULL | — | 更新时间 |
| `data` | `text` | NOT NULL | — | 序列化正文 |

表级约束：

- `CONSTRAINT 'fk_message_session_id_session_id_fk' FOREIGN KEY ('session_id') REFERENCES 'session'('id') ON DELETE CASCADE`

**表 `part`**（6 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | PK | — | 记录 ID |
| `message_id` | `text` | NOT NULL | — | 所属消息 ID |
| `session_id` | `text` | NOT NULL | — | 所属会话 ID |
| `time_created` | `integer` | NOT NULL | — | 创建时间 |
| `time_updated` | `integer` | NOT NULL | — | 更新时间 |
| `data` | `text` | NOT NULL | — | 序列化正文 |

表级约束：

- `CONSTRAINT 'fk_part_message_id_message_id_fk' FOREIGN KEY ('message_id') REFERENCES 'message'('id') ON DELETE CASCADE`

**表 `project`**（10 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `text` | PK | — | 记录 ID |
| `worktree` | `text` | NOT NULL | — | — |
| `vcs` | `text` | — | — | — |
| `name` | `text` | — | — | 显示名 |
| `icon_url` | `text` | — | — | — |
| `icon_color` | `text` | — | — | — |
| `time_created` | `integer` | NOT NULL | — | 创建时间 |
| `time_updated` | `integer` | NOT NULL | — | 更新时间 |
| `time_initialized` | `integer` | — | — | — |
| `sandboxes` | `text` | NOT NULL | — | — |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 会话 / 消息 / 部件 / 项目四表，完整列以宿主自身的建表 migration 为准（见下方表结构） | 【源码】 |
| 关键列与约束 | `message` 与 `part` 都带 `time_created` / `time_updated` 整数时间戳；`part.data` 内部结构（宿主源码 v1 migration 实证）部件 `type`：`text`（`text`，可选 `ignored` / `synthetic`）/ `reasoning`（`text`）/ `file`（`url`）/ `tool`（`tool`）/ `agent` / `subtask` / `step-start`（`snapshot`）/ `snapshot`（`snapshot`）/ `patch`（`hash`, `files`）/ `step-finish`（`snapshot`）/ `compaction`（`text`） | 【源码】 |
| 标题落点 | `session` 表（见下方表结构） | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 宿主按 `project_id` 组织会话列表（`session.project_id` → `project.id`） | 【源码】 |
| 打开正文依赖 | —（库内即正文） | 【源码】 |
| 标题裁决 | —（见 `session` 表结构） | 【源码】 |
| 缺字段后果 | `session_entry` 对未知 `type` 行的容忍性 | 【待证 待证-opencode-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目由 `project` 表承载（`worktree` 为仓库根、`vcs` 为版本控制类型） | 【源码】 |
| 会话归属键 | `session.project_id` | 【源码】 |
| 项目注册表 | `project` 表；`permission` 按 `project_id` 存权限 | 【源码】 |
| 非项目会话 | —（无独立桶；列表按 `project_id` 组织） | 【源码】 |
| 项目显示名 | —（未见显示名实体） | 【源码】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 整数列：`time_created` / `time_updated` / `time_compacting` / `time_archived` / `summary_*` | 【源码】 |
| 多副本与去重 | 无独立 sidecar，元数据都在库行里 | 【源码】 |
| 子代理与特殊会话 | 子会话 `session.parent_id`；压缩 `time_compacting`；归档 `time_archived`；`todo` 复合主键 `(session_id, position)`；`session_share` 主键 `session_id` | 【源码】 |
| 宿主迁移机制 | —（未见登记） | 【源码】 |

---

## 2. opencode-v2 — OpenCode（两表 schema）

> **存储模型**：单库 SQLite，会话一行、消息多行且部件内嵌在消息 JSON 里，项目与工作区各自成表；库本身没有按会话划分的目录。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.local/share/opencode/opencode.db` | 【真机】 |
| 官方覆盖变量 | 宿主本体按 `XDG_DATA_HOME` 取数据根（Windows 走 Roaming）；不认 `OPENCODE_DATA_DIR` | 【源码】 |
| 目录归属判据 | 特征表 `session_v2` | 【源码】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（库内无账号分区） | 【源码】 |
| 账号分区 | —（无） | 【源码】 |
| 会话账号字段 | —（无账号列） | 【源码】 |
| 切换账号影响 | —（未见登记） | 【源码】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.local/share/opencode/            # XDG_DATA_HOME 下的数据根
├── opencode.db                          # 单库：会话 / 消息 / 部件 / 项目 / 权限全部在内
├── opencode.db-wal / -shm               # WAL 伴生文件
├── log/ tool-output/ snapshot/ shell/ repos/   # 日志、工具输出与运行时产物
└── opencode.db.bak-*                    # 宿主自身生成的库备份
```

**【真机】 库全貌与用途分组**：

**`opencode.db`** —— 库内共 **21 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `session_inbox`, `session_message`, `session_v2` |
| 项目与工作区 | `project`, `project_directory`, `workspace`, `worktree` |
| 账号与权限 | `account`, `account_state`, `control_account`, `credential`, `permission` |
| 事件与队列 | `event`, `event_sequence` |
| 迁移与元数据 | `instruction_state`, `kv`, `migration` |
| 其他 | `blob`, `blob_ref`, `instruction_blob`, `instruction_entry` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | 单文件 SQLite 库，无每会话目录；会话、消息、部件、项目行全部在库内 | 【真机】 |
| 列表索引与注册表 | 库即列表源；同机可能并存多个 `opencode.db`（XDG 与 Roaming 各一），彼此是独立库 | 【源码】 |
| 非项目落点 | —（无目录桶；`global` 语义见 V7） | 【源码】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = `session_v2` 一行；消息 = `session_message` 多行 | 【源码】 |
| 会话 ID 形态 | 必须以 `ses` 开头（`Session.ID` schema）；裸 uuid 会让 `/api/session` 编码失败 → 整个列表 500 | 【源码】 |
| 命名与目录派生 | `directory` = `sha1('directory:' + realpath)`（native realpath 的 forward-slash 形态、真实大小写；大小写或斜杠不一致会对不上项目）；`path` 为相对 worktree 的 subpath，会话目录 === 项目目录时是**空串不是 NULL**（store 用 `=` 精确匹配） | 【源码】 |
| 非项目桶 | —（无目录桶） | 【源码】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | SQLite | 【源码】 |
| 编码与加密 | `session_message.data` 内联 JSON，`content[]` 嵌在消息行里；`session_v2.model` 要么是完整 `Model.Ref`（`{id, providerID}`）要么 NULL，半截 JSON 会让列表编码失败 | 【源码】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | —（SQLite 直读） | 【源码】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `session_v2`**（36 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `project_id` | `TEXT` | NOT NULL | — | 所属项目 ID |
| `workspace_id` | `TEXT` | — | — | 所属工作区 ID |
| `parent_id` | `TEXT` | — | — | 父会话 ID |
| `fork_session_id` | `TEXT` | — | — | — |
| `fork_boundary` | `TEXT` | — | — | — |
| `slug` | `TEXT` | NOT NULL | — | 会话短名 |
| `directory` | `TEXT` | NOT NULL | — | 目录标识 |
| `path` | `TEXT` | — | — | 项目内相对路径 |
| `title` | `TEXT` | — | — | 会话标题 |
| `version` | `TEXT` | NOT NULL | — | — |
| `share_url` | `TEXT` | — | — | — |
| `summary_additions` | `INTEGER` | — | — | — |
| `summary_deletions` | `INTEGER` | — | — | — |
| `summary_files` | `INTEGER` | — | — | — |
| `summary_diffs` | `TEXT` | — | — | — |
| `metadata` | `TEXT` | — | — | — |
| `cost` | `REAL` | NOT NULL | `0` | — |
| `tokens_input` | `INTEGER` | NOT NULL | `0` | — |
| `tokens_output` | `INTEGER` | NOT NULL | `0` | — |
| `tokens_reasoning` | `INTEGER` | NOT NULL | `0` | — |
| `tokens_cache_read` | `INTEGER` | NOT NULL | `0` | — |
| `tokens_cache_write` | `INTEGER` | NOT NULL | `0` | — |
| `revert` | `TEXT` | — | — | — |
| `permission` | `TEXT` | — | — | — |
| `agent` | `TEXT` | — | — | — |
| `model` | `TEXT` | — | — | 模型引用 |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `time_idle` | `INTEGER` | — | — | — |
| `time_viewed` | `INTEGER` | — | — | — |
| `idle_outcome` | `TEXT` | — | — | — |
| `time_compacting` | `INTEGER` | — | — | — |
| `time_archived` | `INTEGER` | — | — | — |
| `time_suspended` | `INTEGER` | — | — | — |
| `resume_attempts` | `INTEGER` | NOT NULL | `0` | — |

**表 `session_message`**（7 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `type` | `TEXT` | NOT NULL | — | 类型 |
| `seq` | `INTEGER` | NOT NULL | — | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |

**表 `project`**（14 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `worktree` | `TEXT` | NOT NULL | — | — |
| `vcs` | `TEXT` | — | — | — |
| `name` | `TEXT` | — | — | 显示名 |
| `icon_url` | `TEXT` | — | — | — |
| `icon_url_override` | `TEXT` | — | — | — |
| `icon_color` | `TEXT` | — | — | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `time_initialized` | `INTEGER` | — | — | — |
| `time_active` | `INTEGER` | NOT NULL | `0` | — |
| `time_archived` | `INTEGER` | — | — | — |
| `sandboxes` | `TEXT` | NOT NULL | — | — |
| `commands` | `TEXT` | — | — | — |

**表 `event_sequence`**（3 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `aggregate_id` | `TEXT` | PK | — | 聚合体 ID（会话 ID） |
| `seq` | `INTEGER` | NOT NULL | — | 该聚合体**已分配到的最后一个** seq |
| `owner_id` | `TEXT` | — | — | 属主 ID（可空） |

`event_sequence` 是宿主给消息分配 seq 的计数器，`aggregate_id` 就是会话 ID。
宿主写新消息前先读这一行，读不到就当 `-1`、下一个 seq 从 0 开始
（事件总线按 `latest = row?.seq ?? -1` → `seq = latest + 1` 分配，
序号登记也是 `max(现值, 新值)` —— 计数器只进不退）。
因此外部写入 `session_message` 行的同时必须登记这一行：只写消息不登记，
宿主分配的 seq 会与已存在的消息行重复（`session_message` 上有 `(session_id, seq)` 唯一索引）。

**消息 JSON 的字段契约**（宿主靠这几个字段判断「这条回复完不完整」）：

| 位置 | 字段 | 取值 | 缺失 / 写错的后果 |
| --- | --- | --- | --- |
| assistant 消息 | `finish` | `stop` / `length` / `tool-calls` / `content-filter` / `error` / `unknown` | **缺 `finish` 一律被判为「被 Esc / 崩溃 / 失败截断的流」**：末尾内容块不重放、尾部 reasoning 丢弃 |
| assistant 消息 | `error` | 有值 = 该轮出错 | 同样判为截断流 |
| assistant 消息 | `model.providerID` / `model.id` | 宿主真实 provider（`opencode`）+ 宿主模型 id（含 `variant`） | 上游 `sameModel = message.model.providerID === model.providerID && message.model.id === model.id`；占位 provider（如 `session-sync`）→ false → reasoning 降级（见下） |
| reasoning 部件 | `native` | `{reasoningField:'reasoning', reasoningDetails:[{type:'reasoning.text', text, format:'unknown', index:0}]}` | `sameModel=true` 时作为 `providerMetadata={opencode: item.native}` 发成 `reasoning`+`reasoning_details`；**缺它即便 provider 改对，`providerMetadata(key, undefined)` 仍返回 undefined → 照样降级** |
| tool 部件 | `executed` | `true` = provider 侧托管执行的内建工具；`false` = 本地执行 | 置 `true` 会让宿主把本地结果当 provider 内建工具回放 |
| tool 部件 | `time.ran` | 毫秒时间戳 | 宿主靠「`ran` 有值 **或** `state.status === 'completed'`」判定工具真跑过 |

取值口径与真机原生行一致：回复**以工具调用收尾** → `finish: tool-calls`，
**以文本收尾** → `finish: stop`；源侧本地执行过的工具 → `executed: false`。

**reasoning 降级机制**（上游 `packages/core` 的 `session/runner/to-llm-message.ts` 实证）：
`sameModel=false` 时 reasoning 只发 `{type:'reasoning', text}`（不带 providerMetadata），
适配器据此降级成 `reasoning_content`，而 **Zen 网关整段丢弃 `reasoning_content`**
（真机抓包：原生请求带 `reasoning`/`reasoning_details`，导入请求只有 `reasoning_content`）。
因此导入的 reasoning 部件必须**同时**满足两条：① assistant `model.providerID` 是宿主真实
provider（`opencode`）且 `model.id` 与当前模型一致；② 部件带 `native` 包裹（文本是源侧真实
reasoning，这里只补回宿主 canonical 格式，`format` 未知取 `'unknown'`，与真机原生行同值）。
写入侧（`turnToEvents`）与自愈侧（`repairMessageData`）都按此补齐。

**与原生行同形的其余字段**（宿主 schema 不强制，但原生 assistant 行都有，缺则补、已有不动 → 幂等）：
`rawFinish`（与 `finish` 同值）、`cost`（`0`）、`tokens`（`{input,output,reasoning,cache:{read,write}}`，
源侧无计数取零）、`time.streamed`；reasoning 部件另补 `time:{created,completed}`。
这些字段不参与 `toLLMMessages` 转换，纯形状对齐；读侧 IR 只取 `text`/工具名+入参，**不读 `native`/统计字段**，
故补齐不改核心指纹（收敛安全，m86 取证）。

**`session_v2.version` 同形**：原生行写应用版本（如 `2.1.4`），导入行原写 `session-sync/1`。
自愈把**带 provenance metadata** 的导入行 version 对齐到宿主版本（识别改靠 metadata 标记，仍认得出）；
**无 metadata 的行**（`appendToNative`，provenance 为 null）version 是唯一识别标记，**必须保留 `session-sync/1`**。
读侧判定 `importedRow = !!prov || version==='session-sync/1'`，两条标记互为兜底。


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | `session_v2`（会话）/ `session_message`（消息）/ `project`（项目）/ `event_sequence`（消息 seq 计数器），逐列结构见下方表结构 | 【源码】 |
| 关键列与约束 | assistant 消息必填 `agent`（字符串）与完整 `model`；`finish` ∈ `stop`/`length`/`tool-calls`/`content-filter`/`error`/`unknown`（**缺它即被当成被截断的流**，见上方字段契约）；`content[].tool` 必填 `time.created`，`state` ∈ `completed`/`error`/…，`completed` 要求 `input` 为对象、`content` 为非空数组；工具另有 `executed`（本地执行为 `false`）与 `time.ran`。**会话 ID 另有网关续写契约**：本地 schema 只校验 `ses` 前缀，但 Zen 网关要求宿主原生 Identifier 形态 `ses_`+12hex（降序时间戳，`r=now*0x1000+counter` 取 `~r` 低 48 位六字节）+14base62 共 26 位、且前缀解出 sane 时间戳；`ses_<32hex>` 列表可见却续写 429（与体量/provenance/model 无关，截断小消息仍 429、len26 前缀全 0 也 429） | 【源码】【真机】 |
| 标题落点 | `session_v2`（见下方表结构） | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | TUI `/sessions` 与 `opencode session list` 走同一套服务端过滤 | 【源码】 |
| 打开正文依赖 | 按 `project_id` 过滤；`project_id` 不指向真实 `project` 行就看不到 | 【源码】 |
| 标题裁决 | —（见 `session_v2` 表结构） | 【源码】 |
| 缺字段后果 | 任何一行不合规都会整页 500（表现为「列表空」）；`event_sequence` 缺该会话的行不炸列表，但宿主续写时分配的 seq 从 0 重来，与已有消息行撞 `(session_id, seq)` 唯一索引 → 该会话再也写不下去 | 【源码】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | `project_id` 派生（复刻 `Project.resolve`）：git 内 `sha1('git-remote:' + 归一化 remote url)` → `<commonDir>/opencode` 文件内容 → 排序后首个根提交哈希 → `'global'`（无 remote、无提交的仓库）；hg 内 `.hg/opencode` 文件内容 → 首个根 changeset；否则 `sha1('directory:' + native realpath)`；目录里有个空 `.git` 不算仓库（`git rev-parse` 失败即按普通目录处理） | 【源码】 |
| 会话归属键 | `session_v2.project_id` 列（值为上述派生 id） | 【源码】 |
| 项目注册表 | `project` 表，行形状 `(worktree=<repo>, vcs=git)`；本家 `global` 指「无 remote 的 git 仓库」，不是非项目桶（MiMo 的 `global` 才是非项目桶） | 【源码】 |
| 非项目会话 | —（无目录桶） | 【源码】 |
| 项目显示名 | `project.name`，为空时取 `project.worktree` 末段（与宿主 UI 同口径，不是会话 `directory` 末段） | 【源码】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 `session_v2` / `session_message` 表结构 | 【源码】 |
| 多副本与去重 | 会话元数据（标题、时间）与消息同库同行，没有独立 sidecar | 【源码】 |
| 子代理与特殊会话 | 未见子代理 / 分支会话的独立存放层 | 【源码】 |
| 宿主迁移机制 | —（未见登记） | 【源码】 |

---

## 3. claude — Claude Code

> **存储模型**：纯文件型：一个会话就是一个 JSONL 事件流，按 cwd 派生的 slug 目录分桶，宿主靠目录枚举列出会话。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.claude/`；会话在 `projects/<slug>/` 下 | 【真机】 |
| 官方覆盖变量 | `CLAUDE_CONFIG_DIR` | 【源码】 |
| 目录归属判据 | `projects/` 子目录 + 其下 `.jsonl` 会话文件 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（未登记登录态落点） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账号字段） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.claude/
├── projects/<slug>/                     # 会话根：按 cwd 派生的项目桶
│   └── <sessionId>.jsonl                # 一会话 = 一个事件流文件（正文 + 标题 + 元数据）
├── sessions/ session-env/ shell-snapshots/  # 运行时会话状态与 shell 快照
├── history.jsonl                        # 全局命令历史
├── .claude.json（<home> 下）             # 项目路径键与信任配置（无显示名）
├── settings.json / settings.local.json / CLAUDE.md  # 配置与全局指令
├── agents/ skills/ plugins/ hooks/ plans/ tasks/ todos/  # 扩展、技能与任务
├── backups/ file-history/ transcripts/ paste-cache/ cache/  # 备份与缓存
├── ide/ telemetry/ statsig/ .last-cleanup  # IDE 集成、遥测与清理标记
└── （无独立列表索引库；projects/ 目录枚举即列表来源）
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `projects/<slug>/<sessionId>.jsonl` — 会话事件流（正文，也是唯一会话载体） | 【真机】 |
| 列表索引与注册表 | 无独立列表索引库；`projects/` 目录枚举即列表来源 | 【真机】 |
| 非项目落点 | —（无独立桶） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `.jsonl` 文件 | 【真机】 |
| 会话 ID 形态 | uuid（文件名） | 【真机】 |
| 命名与目录派生 | slug 规则（宿主原文 `e.replace(/[^a-zA-Z0-9]/g,"-")`）：**每个**非字母数字各成一个 `-`（不折叠、保留大小写）；长度 >200 时截成 `slice(0,200)+"-"+Math.abs(javaHash(原cwd)).toString(36)`。例：`D:\00-work\code\x` → `D--00-work-code-x` | 【真机】 |
| 非项目桶 | —（无独立桶；会话按 cwd 派生的 slug 归到对应项目目录） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 单行一条事件的 JSONL | 【真机】 |
| 编码与加密 | UTF-8 明文 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | `parentUuid` 线性续接契约：断链后宿主能否加载尚未取证 | 【待证 待证-claude-1】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 事件流行（一会话一文件） | 【真机】 |
| 关键列与约束 | 事件类型 `user` / `assistant` / `attachment` / `ai-title` / `queue-operation` / `file-history-snapshot` / `last-prompt`；未知 `type` 的行宿主会忽略（专用标记行能被容忍的前提）；负载字段结构（真机样本逐字段核验）：`user` / `assistant` 行公共字段 `parentUuid`（首行 NULL）/ `isSidechain` / `uuid` / `timestamp`（ISO 字符串）/ `cwd` / `sessionId` / `version` / `gitBranch` / `userType` / `entrypoint`；`message.content`：user 为字符串或块数组——`text{text}`、`tool_result{tool_use_id, content, is_error}`；assistant 为块数组——`text{text}`、`thinking{thinking, signature}`、`tool_use{id, name, input}`；辅助行：`ai-title{aiTitle, sessionId}`、`last-prompt{lastPrompt, leafUuid}`、`permission-mode{permissionMode, sessionId}`、`file-history-snapshot{messageId, snapshot{messageId, trackedFileBackups, timestamp}, isSnapshotUpdate}`。工具配对：`assistant` 的 `tool_use.id` ↔ `user` 的 `tool_result.tool_use_id` | 【真机】 |
| 标题落点 | 正文 `ai-title` 行（每会话 6–23 条） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | `projects/` 目录枚举，没有 db 索引或注册表；目录存在即可见 | 【真机】 |
| 打开正文依赖 | —（正文文件即全部） | 【真机】 |
| 标题裁决 | `ai-title` 行最后一条胜出，没有独立标题列 | 【真机】 |
| 缺字段后果 | 宿主加载外部构造 JSONL 的 oracle（`parentUuid` 断链后果） | 【待证 待证-claude-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目 = cwd 经 slug 规则映射的目录；会话归属完全由所在目录决定。**项目键的目录形态 = 大写盘符 + 原生分隔符**（宿主按 `process.cwd()` 记 cwd，本机 13/13 条实测）：盘符大小写或分隔符与宿主记的不一致 → 另一个目录名 → 侧栏两个同名项目 | 【真机】 |
| 会话归属键 | —（文件内不另存项目键） | 【真机】 |
| 项目注册表 | —（无项目表；`~/.claude.json` 的 `projects` 只登记路径键与信任配置） | 【真机】 |
| 非项目会话 | —（无独立桶） | 【真机】 |
| 项目显示名 | —（宿主没有项目显示名实体，也没有项目改名能力） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 事件内字段（见正文流） | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理独立目录；`file-history-snapshot` 等机械事件与正文混在同一事件流里 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 4. pi — Pi

> **存储模型**：纯文件型：一会话一个 JSONL，按 cwd 派生的 slug 目录分桶，时间与 ID 都在文件名里。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.pi/agent/sessions/<slug>/` | 【真机】 |
| 官方覆盖变量 | `PI_HOME` | 【源码】 |
| 目录归属判据 | `agent/sessions/` 子目录 + `--…--` 形态的 slug 目录 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `auth.json`（数据根下） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账户字段） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.pi/agent/
├── sessions/<slug>/                     # 会话根：按 cwd 派生的项目桶
│   └── <ISO>_<id>.jsonl                 # 一会话 = 一个 JSONL 文件
├── auth.json                            # 登录态
├── models.json / models-store.json      # 模型定义与缓存
├── settings.json / tasks.json           # 配置与任务
├── bin/ extensions/ skills/             # 可执行文件、扩展与技能
└── （无独立索引库；sessions/ 目录枚举即列表来源）
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `sessions/<slug>/<ISO>_<sessionId>.jsonl` — 会话事件流（正文 + 头信息同文件） | 【真机】 |
| 列表索引与注册表 | 无独立索引库；列表靠 `sessions/` 下目录与文件枚举 | 【真机】 |
| 非项目落点 | —（无独立桶） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `.jsonl` 文件 | 【真机】 |
| 会话 ID 形态 | uuid，内嵌在文件名 `<ISO>_<id>.jsonl` | 【真机】 |
| 命名与目录派生 | slug 规则（宿主原文）：`--${resolvedCwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--` —— **只动 `/` `\` `:` 三个字符**，点、下划线、空格、中文原样保留 | 【真机】 |
| 非项目桶 | —（无独立桶；会话按 cwd slug 归目录） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 单行一条事件的 JSONL | 【真机】 |
| 编码与加密 | UTF-8 明文 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 首行 `{type:'session',version:3,…}`，其后为事件流 | 【真机】 |
| 关键列与约束 | 事件 `model_change` / `thinking_level_change` / `message`；content 类型 `text` / `toolCall` / `image`，**无 reasoning 类型**（推理内容会丢失，属格式限制） | 【真机】 |
| 标题落点 | 无独立落点，由首条用户文本派生 | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 目录 / 文件枚举，无 db 索引与注册表 | 【真机】 |
| 打开正文依赖 | —（正文文件即全部） | 【真机】 |
| 标题裁决 | 只有「首问派生」一个来源，无标题列、无 `ai-title` 行 | 【真机】 |
| 缺字段后果 | —（未见登记） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目 = cwd 经 slug 规则映射的目录。**项目键的目录形态 = 大写盘符 + 原生分隔符**（宿主按 `process.cwd()` 记 cwd，本机 4/4 条实测）：盘符大小写或分隔符与宿主记的不一致 → 另一个目录名 → 侧栏两个同名项目 | 【真机】 |
| 会话归属键 | —（文件内不另存项目键） | 【真机】 |
| 项目注册表 | —（`dist/bundle/chunks` 全量检索 rename / workspace 显示名零命中，`agent/settings.json` 无项目名） | 【真机】 |
| 非项目会话 | —（无独立桶） | 【真机】 |
| 项目显示名 | —（宿主没有项目显示名实体） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 文件名 `<ISO>_<id>.jsonl` 与首行 `session` 事件 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层；`model_change` / `thinking_level_change` 作为事件混在正文流里 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 5. antigravity — Antigravity

> **存储模型**：每会话一个独立 SQLite 库，步骤与元数据分表；工作区归属记在会话级 history.jsonl 而不是会话库内。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.gemini/antigravity-cli/`，会话库在 `conversations/` 下 | 【真机】 |
| 官方覆盖变量 | —（宿主无官方环境变量） | 【源码】 |
| 目录归属判据 | 内含 `conversations/` 子目录（其下为 `<uuid>.db`） | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（无账号分区目录） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账户字段） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.gemini/antigravity-cli/
├── conversations/                       # 会话根：每会话一个独立 SQLite 库
│   ├── <conversationId>.db              # 一会话 = 一个库（正文步骤 + 元数据）
│   ├── <conversationId>.db-wal / -shm   # WAL 伴生文件
│   └── history.jsonl                    # 会话级索引 / 工作区记录（cwd 取自其 workspace 字段）
├── brain/<uuid>/                        # 会话关联的脑图 / 记忆目录
├── cache/                               # last_conversations.json / projects.json / onboarding.json
├── implicit/                            # *.pb 二进制隐式状态
├── knowledge/ log/ updater/ bin/ builtin/ skills/  # 知识库、日志、升级器与技能
├── cli.log / history.jsonl / installation_id / last_check.timestamp / settings.json
└── （无项目表、无账号分区目录）
```

**【真机】 库全貌与用途分组**：

**`conversations/<conversationId>.db`** —— 库内共 **7 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `steps`, `trajectory_meta`, `trajectory_metadata_blob` |
| 迁移与元数据 | `executor_metadata`, `gen_metadata` |
| 其他 | `battle_mode_infos`, `parent_references` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `conversations/<conversationId>.db` — 每会话一个 db（正文 + 步骤） | 【真机】 |
| 列表索引与注册表 | `conversations/history.jsonl` — 会话级索引 / 工作区记录（cwd 取自其 `workspace` 字段） | 【真机】 |
| 非项目落点 | —（无项目表、无桶） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `<uuid>.db` 文件 | 【真机】 |
| 会话 ID 形态 | db 文件名（uuid） | 【真机】 |
| 命名与目录派生 | 会话库平铺，不按日期或项目分层 | 【真机】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | SQLite；`steps.step_payload` / `metadata` / `task_details` 是 **protobuf 二进制**，内部嵌了可读 JSON | 【真机】 |
| 编码与加密 | 可读 JSON 形态：`{"step_index":N,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>…"}` 与 `{"step_index":N,"source":"MODEL","type":"PLANNER_RESPONSE","content":…}` | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | `gen_metadata` 同样是 protobuf 二进制，未展开 | 【真机】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `steps`**（11 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `idx` | `INTEGER` | PK | — | — |
| `step_type` | `INTEGER` | NOT NULL | `0` | — |
| `status` | `INTEGER` | NOT NULL | `0` | 状态 |
| `has_subtrajectory` | `numeric` | NOT NULL | `false` | — |
| `metadata` | `BLOB` | — | — | — |
| `error_details` | `BLOB` | — | — | — |
| `permissions` | `BLOB` | — | — | — |
| `task_details` | `BLOB` | — | — | — |
| `render_info` | `BLOB` | — | — | — |
| `step_payload` | `BLOB` | — | — | — |
| `step_format` | `INTEGER` | NOT NULL | `0` | — |

表级约束：

- `PRIMARY KEY ('idx')`

**表 `trajectory_meta`**（4 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `trajectory_id` | `TEXT` | PK | — | — |
| `cascade_id` | `TEXT` | — | — | — |
| `trajectory_type` | `INTEGER` | — | — | — |
| `source` | `INTEGER` | — | — | — |

表级约束：

- `PRIMARY KEY ('trajectory_id')`


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 关键表 / 列：`steps.step_payload`（步骤二进制）、`metadata`、`task_details`、`trajectory_meta`（元数据），逐列结构见下方表结构 | 【真机】 |
| 关键列与约束 | steps 二进制容器无安全构造路径：内部不变量未文档化，宿主侧不提供明文写入入口 | 【源码】 |
| 标题落点 | —（`trajectory_meta` 无名称列） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | `conversations/` 目录枚举 + `history.jsonl`，无独立索引库 | 【真机】 |
| 打开正文依赖 | cwd 来自 `history.jsonl` 的 `workspace` 字段，不在会话 db 内 | 【真机】 |
| 标题裁决 | —（无标题实体） | 【真机】 |
| 缺字段后果 | —（未见登记） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 只有 `history.jsonl` 的 `workspace`；无项目表 / 注册表 | 【真机】 |
| 会话归属键 | —（会话 db 内不存归属字段；cwd 取自 `history.jsonl` 的 `workspace` 字段） | 【真机】 |
| 项目注册表 | —（无项目表 / 关联键） | 【真机】 |
| 非项目会话 | —（无） | 【真机】 |
| 项目显示名 | —（`app.asar` 主进程检索 rename / workspace 显示名零命中） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 元数据在 `trajectory_meta` 与 `history.jsonl` | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层；每会话一个 db 天然隔离 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 6. codex — Codex

> **存储模型**：文件 + 注册表 + 线程库三层：rollout JSONL 是正文，全局状态文件是列表前置，线程库存标题与账户。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.codex/`；会话在 `sessions/YYYY/MM/DD/`，注册表在根下 | 【真机】 |
| 官方覆盖变量 | `CODEX_HOME` | 【源码】 |
| 目录归属判据 | `sessions/` 子目录 + `.codex-global-state.json` | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `<CODEX_HOME>/auth.json` — 当前登录态（`creator_user_id` / `creator_account_id` 取值来源） | 【真机】 |
| 账号分区 | —（`local-projects` 注册表按安装共享，与账号无关） | 【真机】 |
| 会话账号字段 | `creator_user_id` / `creator_account_id`（线程库 `threads` 两列 + rollout 首行同名字段） | 【真机】 |
| 切换账号影响 | 宿主列表是否按 `creator_user_id` 过滤（决定切账号后旧会话是否可见）未取证——oracle 登记在 V6（待证-codex-1） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<CODEX_HOME> = <home>/.codex/
├── sessions/YYYY/MM/DD/                 # 会话正文：按日期分层
│   └── rollout-<ISO>-<id>.jsonl         # 一会话 = 一个 rollout 文件（可压缩为 .jsonl.zst）
├── .codex-global-state.json             # 会话注册表：列表可见性的硬前置
├── state_5.sqlite                       # 线程库：threads / projects / project_roots 等
├── sqlite/                              # 另一组状态库（goals / logs / memories / automations / queue）
├── archived_sessions/ rollout-migrations/  # 归档会话与 rollout 迁移产物
├── auth.json                            # 登录态
├── sessions 之外的运行时目录：attachments/ automations/ cache/ memories/ plans/ prompts/
│   rules/ skills/ plugins/ browser/ computer-use/ node_repl/ pets/ process_manager/ ...
└── .sandbox/ .sandbox-bin/ .sandbox-secrets/ .tmp/  # 沙箱与临时产物
```

**【真机】 库全貌与用途分组**：

**`state_5.sqlite`** —— 库内共 **16 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `thread_attachments`, `thread_dynamic_tools`, `thread_read_receipts`, `thread_sections`, `thread_spawn_edges`, `threads` |
| 项目与工作区 | `project_idempotency_keys`, `project_roots`, `projects` |
| 迁移与元数据 | `_sqlx_migrations`, `backfill_state`, `external_agent_config_imports`, `rollout_migration_skipped_rollouts`, `rollout_migration_state` |
| 其他 | `guardian_review_feedback`, `remote_control_enrollments` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl` — 会话事件流；压缩后为同名 `.jsonl.zst` | 【真机】 |
| 列表索引与注册表 | `.codex-global-state.json` — 全局注册表（线程、项目、非项目线程、工作区提示），是可见性的硬前置 | 【真机】 |
| 非项目落点 | `~/Documents/Codex/<YYYY-MM-DD>/<slug>/`，内含 `outputs/` 子目录 | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 rollout 文件 | 【真机】 |
| 会话 ID 形态 | 文件名 `rollout-<ISO>-<uuid>.jsonl` 中的 uuid | 【真机】 |
| 命名与目录派生 | 按 `YYYY/MM/DD` 日期分层；桶内叶子名由宿主用首条用户消息转写 + 同日计数器生成；非项目会话 `session_meta`：`cwd` = 桶内叶子 `~/Documents/Codex/<YYYY-MM-DD>/<slug>`、`runtime_workspace_roots` = `[桶根]`、**完全没有 `git` 键** | 【真机】 |
| 非项目桶 | `~/Documents/Codex/<YYYY-MM-DD>/<slug>/` | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 单行一条事件的 JSONL；压缩形态为 zstd 单帧 `.jsonl.zst` | 【真机】 |
| 编码与加密 | `reasoning.encrypted_content` 形如 `ocxr1:<base64(JSON{txt})>`，可无损还原推理文本 | 【真机】 |
| 压缩与多帧 | 追加进压缩文件需「整帧解压 → 追加 → 重新压成一帧 → 原子替换」，不能另起一份明文文件 | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `threads`**（43 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `rollout_path` | `TEXT` | NOT NULL | — | — |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |
| `source` | `TEXT` | NOT NULL | — | — |
| `model_provider` | `TEXT` | NOT NULL | — | — |
| `cwd` | `TEXT` | NOT NULL | — | 工作目录 |
| `title` | `TEXT` | NOT NULL | — | 会话标题 |
| `sandbox_policy` | `TEXT` | NOT NULL | — | — |
| `approval_mode` | `TEXT` | NOT NULL | — | — |
| `tokens_used` | `INTEGER` | NOT NULL | `0` | — |
| `has_user_event` | `INTEGER` | NOT NULL | `0` | — |
| `archived` | `INTEGER` | NOT NULL | `0` | 归档位 |
| `archived_at` | `INTEGER` | — | — | — |
| `git_sha` | `TEXT` | — | — | — |
| `git_branch` | `TEXT` | — | — | — |
| `git_origin_url` | `TEXT` | — | — | — |
| `cli_version` | `TEXT` | NOT NULL | `''` | — |
| `first_user_message` | `TEXT` | NOT NULL | `''` | — |
| `agent_nickname` | `TEXT` | — | — | — |
| `agent_role` | `TEXT` | — | — | — |
| `memory_mode` | `TEXT` | NOT NULL | `'enabled'` | — |
| `model` | `TEXT` | — | — | 模型引用 |
| `reasoning_effort` | `TEXT` | — | — | — |
| `agent_path` | `TEXT` | — | — | — |
| `created_at_ms` | `INTEGER` | — | — | — |
| `updated_at_ms` | `INTEGER` | — | — | — |
| `thread_source` | `TEXT` | — | — | — |
| `preview` | `TEXT` | NOT NULL | `''` | — |
| `recency_at` | `INTEGER` | NOT NULL | `0` | — |
| `recency_at_ms` | `INTEGER` | NOT NULL | `0` | — |
| `history_mode` | `TEXT` | NOT NULL | `'legacy'` | — |
| `name` | `TEXT` | — | — | 显示名 |
| `is_pinned` | `INTEGER` | NOT NULL | `0` | — |
| `thread_section_id` | `TEXT` | — | — | — |
| `section_position` | `INTEGER` | — | — | — |
| `section_entered_at_ms` | `INTEGER` | — | — | — |
| `project_id` | `TEXT` | — | — | 所属项目 ID |
| `originator` | `TEXT` | — | — | — |
| `daybreak_enabled` | `BOOLEAN` | — | — | — |
| `creator_user_id` | `TEXT` | — | — | — |
| `creator_account_id` | `TEXT` | — | — | — |
| `attached_thread_parent_id` | `TEXT` | — | — | — |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 事件类型 `session_meta` / `response_item` / `event_msg` / `turn_context` / `world_state` / `token_usage_record` / `compacted`；**只取 `response_item`**（`event_msg/item_completed` 是同一内容的重复投影，读它会得到双份） | 【真机】 |
| 关键列与约束 | `response_item.payload.type`：`message`(role developer\|user\|assistant) / `reasoning` / `custom_tool_call` / `custom_tool_call_output` / `function_call` / `function_call_output`；上下文注入过滤：`# AGENTS.md instructions`、`<turn_aborted>`、`<external_codex_apps_open_page>`、`<environment_context>` 等 role=user 注入块视作非用户输入 | 【真机】 |
| 标题落点 | 线程库 `threads.title`；`threads.name` 是用户手动改名才有的列 | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 注册表 `.codex-global-state.json` 是可见性的**硬前置**：只写 rollout 文件的会话宿主侧栏不列；需读-改-写并保留未知键 | 【真机】 |
| 打开正文依赖 | 非项目：`projectless-thread-ids` 含该 id、`thread-workspace-root-hints[id]` = 桶根字符串、`thread-projectless-output-directories[id]` = `<会话目录>/outputs`，**不**挂 `thread-project-assignments`；项目：`thread-project-assignments[id]` = `{projectKind:"local", projectId}`、`local-projects[projectId]` = `{id, name, rootPaths:[repo根], createdAt, updatedAt}`、projectId 进 `project-order` | 【真机】 |
| 标题裁决 | 线程库 `threads.title` | 【真机】 |
| 缺字段后果 | 宿主列表是否按 `creator_user_id` 过滤（决定切账号后旧会话是否可见） | 【待证 待证-codex-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | `session_meta` 有 `git` 键 + `thread-project-assignments` 归属为项目；非项目判据为「无 `git` 键」或 cwd 命中 `~/Documents/Codex` | 【真机】 |
| 会话归属键 | `thread-project-assignments[id]` = `{projectKind:"local", projectId}`（注册表键控；正文 `session_meta` 只有 `git` 信号） | 【真机】 |
| 项目注册表 | `local-projects[projectId]` = `{id, name, rootPaths:[repo根], createdAt, updatedAt}`；projectId 进 `project-order`；`local-projects` 按安装共享，与账号无关 | 【真机】 |
| 非项目会话 | 非项目线程挂 `projectless-thread-ids` + `thread-workspace-root-hints[id]`（= 桶根字符串）+ `thread-projectless-output-directories[id]`（= `<会话目录>/outputs`），**不**挂 assignments；桶 `~/Documents/Codex/<YYYY-MM-DD>/<slug>/` | 【真机】 |
| 项目显示名 | `local-projects[*].name` | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 `threads` 表结构（`created_at` / `created_at_ms` 双列，宿主自同步） | 【真机】 |
| 多副本与去重 | 注册表里挂着的「未挂到侧栏项目」线程不能拿来改判非项目：`projectless-thread-ids` 里同样会有带 git 与项目 cwd 的会话；压缩形态 `.jsonl.zst` 与明文 `.jsonl` 是同一会话的不同编码，不是两个会话 | 【真机】 |
| 子代理与特殊会话 | —（未见子代理独立存放层） | 【真机】 |
| 宿主迁移机制 | `rollout-migrations/` 为宿主自身迁移产物 | 【真机】 |

---

## 7–8. workbuddy-cn / workbuddy-intl — WorkBuddy

> **存储模型**：JSONL 正文 + SQLite 索引双写：目录里的 jsonl 是正文，workbuddy.db 的 sessions 表才是 UI 列表源。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.workbuddy/`（国际版 `.workbuddy-ai/`） | 【真机】 |
| 官方覆盖变量 | `WORKBUDDY_CONFIG_DIR`（宿主自己的根；回退 `CODEBUDDY_CONFIG_DIR` → `<home>/WORKBUDDY_DATA_FOLDER_NAME`，默认 `.workbuddy`）。中文版与国际版的区分依据是**根名里有没有 `workbuddy-ai`**。`WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME` 是同步工具自用的别名，宿主本体不识别。桌面进程确实导出 `WORKBUDDY_CONFIG_DIR`（值形如 `<home>/.workbuddy`）与 `WORKBUDDY_DATA_FOLDER_NAME`（值是根名而非完整路径） | 【源码】【真机】 |
| 目录归属判据 | `projects/` 子目录 + 根下 `workbuddy.db`（含 `sessions` 表） | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `storage/skeleton/account-snapshot.json → primary.uid`（当前登录 uid 的唯一权威来源） | 【真机】 |
| 账号分区 | —（`workspaces` / `workspace_trust_decisions` / `projects/<slug>` 按安装共享；唯一账号维度是 `sessions.user_id` 列） | 【真机】 |
| 会话账号字段 | `sessions.user_id`（不能凭空造：宿主自己的行来自当前登录） | 【真机】 |
| 切换账号影响 | 切换账号只改 `sessions.user_id` 一列；其余共享实体不受影响 | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.workbuddy/                       # 国际版：.workbuddy-ai/
├── projects/<slug>/                      # 会话正文：按 cwd 派生的项目桶
│   └── <sessionId>.jsonl                 # 一会话 = 一个 JSONL 事件流
├── workbuddy.db                          # 会话索引库：sessions / workspaces / ...
├── workspace-display-names.json          # 工作区显示名
├── edge-sync-mapping-v4.db               # 边缘同步映射
├── .workbuddy-sqlite-migrations/ .migration-history/  # 宿主自身的库迁移记录
├── <uuid>/                               # 账号 / 实例分区目录
├── app/ blobs/ brain/ cache/ memory/ connectors/ binaries/  # 运行时数据与扩展
├── automations/ automation-backups/ audit-log/ backup/     # 自动化、审计与备份
├── artifact-index/ changes-index/ media-index/ file-history/  # 索引与文件历史
├── logs/ local_storage/ clipboard-images/ ...               # 日志与本地存储
└── （Electron 常规目录：Cache/ GPUCache/ Crashpad/ 等，与会话存储无关）
```

**【真机】 库全貌与用途分组**：

**`workbuddy.db`** —— 库内共 **11 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `session_usage`, `sessions` |
| 项目与工作区 | `workspace_trust_decisions`, `workspaces` |
| 事件与队列 | `automation_delivery_outbox`, `automation_runs`, `automation_runtime_state`, `automations` |
| 迁移与元数据 | `__workbuddy_drizzle_migrations`, `migration_meta` |
| 其他 | `buddy_snapshots` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `projects/<slug>/<sessionId>.jsonl` — 会话事件流（正文） | 【真机】 |
| 列表索引与注册表 | `workbuddy.db` 的 `sessions` 表 — 会话索引（UI 列表 / 标题 / 时间）；`workspace-display-names.json` — 工作区显示名（`{version, workspaces:{<规范化路径>:{id,path,displayName,updatedAt}}}`）；`edge-sync-mapping-v4.db` — 边缘同步映射 | 【真机】 |
| 非项目落点 | `<home>/WorkBuddy[ AI]/<hyphen6>` 形态的独立子目录（每会话一个） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `.jsonl` 文件 + `sessions` 表一行，两者缺一不可 | 【真机】 |
| 会话 ID 形态 | uuid（文件名） | 【真机】 |
| 命名与目录派生 | slug 规则：仅 `:` `\` `/` → `-` 并折叠重复；点、下划线、空格**原样保留**。例：`c:\Users\you\WorkBuddy AI\x` → `c-Users-you-WorkBuddy AI-x` | 【真机】 |
| 非项目桶 | `<home>/WorkBuddy[ AI]/<hyphen6>` | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 单行一条事件的 JSONL，明文 | 【真机】 |
| 编码与加密 | 时间戳为**毫秒数字**；索引为 SQLite，`journal_mode = wal`、`busy_timeout` 默认 0（宿主自身并发写入需调用方设超时） | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `sessions`**（40 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `cwd` | `TEXT` | NOT NULL | — | 工作目录 |
| `user_id` | `TEXT` | NOT NULL | — | 账号 ID |
| `title` | `TEXT` | — | — | 会话标题 |
| `custom_title` | `TEXT` | — | — | — |
| `status` | `TEXT` | NOT NULL | `'Pending'` | 状态 |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |
| `deleted_at` | `INTEGER` | — | — | — |
| `is_playground` | `INTEGER` | NOT NULL | `0` | — |
| `model` | `TEXT` | — | — | 模型引用 |
| `mode` | `TEXT` | — | — | — |
| `last_activity_at` | `INTEGER` | — | — | — |
| `source_mode` | `TEXT` | — | — | — |
| `is_background_automation` | `INTEGER` | — | — | — |
| `expert_id` | `TEXT` | — | — | — |
| `expert_locale` | `TEXT` | — | — | — |
| `expert_runtime_identity` | `TEXT` | — | — | — |
| `expert_marketplace` | `TEXT` | — | — | — |
| `permission_mode` | `TEXT` | — | — | — |
| `use_sandbox_cli` | `INTEGER` | — | — | — |
| `project_id` | `TEXT` | — | — | 所属项目 ID |
| `plugin_context_json` | `TEXT` | — | — | — |
| `last_user_prompt_expert_selection` | `TEXT` | — | — | — |
| `context_window` | `INTEGER` | — | — | — |
| `buddy_snapshot_id` | `TEXT` | — | — | — |
| `buddy_binding_json` | `TEXT` | — | — | — |
| `thought_level` | `TEXT` | — | — | — |
| `addon_selection` | `TEXT` | — | — | — |
| `session_settings` | `TEXT` | — | — | — |
| `transport` | `TEXT` | NOT NULL | `'local'` | — |
| `conversation_origin` | `TEXT` | — | — | — |
| `visibility` | `TEXT` | — | — | 可见性 |
| `group_id` | `TEXT` | — | — | — |
| `group_title` | `TEXT` | — | — | — |
| `agent_dirty` | `INTEGER` | — | — | — |
| `agent_dirty_at` | `INTEGER` | — | — | — |
| `agent_last_synced` | `INTEGER` | — | — | — |
| `verified_at` | `INTEGER` | — | — | — |
| `unread` | `INTEGER` | NOT NULL | `0` | — |

**表 `workspaces`**（2 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | `TEXT` | PK | — | 项目内相对路径 |
| `last_opened_at` | `INTEGER` | NOT NULL | — | — |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 正文事件 `message`(role user\|assistant, content `input_text`/`output_text`) / `reasoning`(rawContent `reasoning_text`) / `function_call` / `function_call_result` / `ai-title` / `session-meta` / …；索引表逐列结构见下方表结构 | 【真机】 |
| 关键列与约束 | `sessions` 关键列：`id`(PK) / `cwd` / `user_id` / `title` / `status` / `created_at` / `updated_at` / `last_activity_at` / `transport`(='local') / `unread` / `is_playground` / `model`；`transport` / `unread` / `thought_level` 等列是后续 `ALTER TABLE ADD COLUMN` 追加的，不在初始建表里；`sessions.project_id` 不作为项目名来源 | 【真机】 |
| 标题落点 | `sessions.title` / `sessions.custom_title` 列与正文行（裁决顺序见 V6） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | UI 的会话列表读的是 db 索引，不是目录扫描；只写 jsonl 会「写了但看不到」 | 【真机】 |
| 打开正文依赖 | —（正文 jsonl 本身） | 【真机】 |
| 标题裁决 | `sessions.custom_title` 列（`isUserDefinedTitle = customTitle 非空`，用户在宿主里手动改名的标记）> 正文 `custom-title` 行 > `sessions.title` 列 > 正文 `ai-title` 行 > 首条 user 文本；读侧不按长度截断标题，超长由宿主按 UTF-16 code unit 切 | 【真机】 |
| 缺字段后果 | 索引行缺失或落后时宿主侧栏不列该会话 | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | cwd 形态命中 `<home>/WorkBuddy[ AI]*/<四种代际叶子>` 为非项目；`is_playground=1` 只作新版辅助 | 【真机】 |
| 会话归属键 | `sessions.project_id` 存在但不作为项目名来源 | 【真机】 |
| 项目注册表 | —（目录即项目；`workspaces` 表以 `path` 为主键、与 session 无外键，按安装共享）。**项目键的目录形态 = 小写盘符**（宿主记自己的 cwd，本机 46/47 条实测，与 claude/pi 的大写相反）：与宿主记法不一致 → 另一个 `projects/<slug>` 目录 → 侧栏两个同名项目 | 【真机】 |
| 非项目会话 | `<home>/WorkBuddy[ AI]/<hyphen6>` 形态的独立子目录（每会话一个） | 【真机】 |
| 项目显示名 | UI 的「Rename Workspace」只改显示名、不改目录（宿主原文 `Only the display name changes. The actual folder path will stay the same.`），结果写 `<root>/workspace-display-names.json`，键为规范化路径 | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 毫秒数字 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立目录；`session-meta` / `file-history-snapshot` 等机械事件混在正文流里 | 【真机】 |
| 宿主迁移机制 | `.workbuddy-sqlite-migrations/` / `.migration-history/` 为宿主自身库迁移记录；`wal` 下并发写入需 `busy_timeout` | 【真机】 |

---

## 9–10. qoder-cn / qoder-intl — Qoder

> **存储模型**：CLI 明文 JSONL 正文 + 桌面 SQLite 注册表投影，另有一代已停写的密文桌面库作为历史副本。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | 桌面：`%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`（旧代）、`%APPDATA%\com.qodercn.app.stable\main.sqlite`（现行注册表）；CLI 正文根 `<home>/.qoder-cn/`（国际版 `.qoder/`），两变体按目录名硬隔离互不读取 | 【真机】 |
| 官方覆盖变量 | 宿主 CLI 侧有 `QODER_CONFIG_DIR`，但正文根不跟随它（跟随会让国际版读到 CN 数据） | 【源码】 |
| 目录归属判据 | `.qoder-cn` / `.qoder` 下的 `projects/` 子目录，或 `main.sqlite` 内含 `chat_sessions` 表 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `account_profiles`、`qoder-data.v1.ext.json` 的 `.accounts`、`~/.qoder-cn/.models/<account-uuid>/` | 【真机】 |
| 账号分区 | 现行注册表不带账号归属：`chat_sessions` 无账号列 → 宿主列表不按账号过滤 | 【真机】 |
| 会话账号字段 | 列表行上的账户 `account` 只来自桌面库 `chat_session.user_id`；CLI jsonl 里没有用户字段；旧代 `local.db` 的 `user_id` 是历史账号线索，只在它存在时用于补账户元数据 | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.qoder-cn/                        # 国际版：.qoder/
├── projects/<slug>/                      # CLI 明文正文：按 cwd 派生的项目桶
│   └── <sessionId>.jsonl                 # 一会话 = 一个明文 JSONL
├── .auth/ .migrations/ .models/ .cache/ # 登录态、迁移、模型与缓存
├── agents/ app/ bin/ entry/ extensions/ plugins/ sites/  # 运行时与扩展
├── canvas/ file-history/ memories/ memory/ plans/ qoder-knowledge/  # 内容与记忆
├── session-env/ shell-snapshots/ host-actions/ ipc/ logs/ security-resources/
└── （项目清单、信任与全局配置在 CLI 根下）
%APPDATA%/com.qodercn.app.stable/
├── main.sqlite                           # 现行注册表：chat_sessions / chat_session_messages / workspaces
└── ...（Electron 常规目录）
%APPDATA%/QoderCN/SharedClientCache/cache/db/
└── local.db                              # 上一代桌面库：chat_session / chat_message（密文正文）
```

**【真机】 库全貌与用途分组**：

**`main.sqlite`** —— 库内共 **124 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `chat_attachment_assets`, `chat_generated_image_assets`, `chat_message_attachment_assets`, `chat_model_preferences`, `chat_session_context_usage`, `chat_session_generated_images`, `chat_session_highlights`, `chat_session_history_revisions`, `chat_session_input_provenance`, `chat_session_input_receipts`, `chat_session_messages`, `chat_session_peer_projection_turns`, `chat_session_recaps`, `chat_session_runtime_context_candidates`, `chat_session_sidebar_group_memberships`, `chat_session_sidebar_groups`, `chat_session_sidebar_placements`, `chat_session_turn_states`, `chat_sessions`, `cloud_message_feedback`, `cloud_session_cache`, `collaboration_deleted_context_sessions`, `managed_worktree_sessions`, `partner_plan_snapshots`, `qoder_daemon_remote_session_launches`, `qoder_daemon_session_store_entries`, `qoder_daemon_session_store_keys`, `remote_session_reimport_tasks`, `scheduled_task_run_logs`, `scheduled_task_settings`, `scheduled_tasks`, `turn_file_change_files`, `turn_file_change_operations`, `turn_file_change_patches`, `turn_file_change_sets`, `turn_file_change_unsupported` |
| 项目与工作区 | `discussion_agent_workspaces`, `discussion_local_workspaces`, `managed_worktrees`, `project_local_workspaces`, `workspace_authority_command_receipts`, `workspace_data_corrections`, `workspace_merge_aliases`, `workspaces` |
| 账号与权限 | `account_profiles`, `agent_data_import_accounts`, `application_sdk_authorizations`, `byok_model_credentials`, `collaboration_runtime_credentials`, `mcp_oauth_credentials`, `remote_byok_sync_hosts`, `remote_ssh_hosts` |
| 事件与队列 | `agent_inbox_items`, `agent_inbox_progress`, `agent_registration_outbox`, `cloud_automation_list_cache`, `local_inbox_items`, `peer_ingress_queue`, `rc_assistant_event_aliases`, `rc_ingress_environment_inbox`, `rc_ingress_inbox` |
| 迁移与元数据 | `app_settings`, `byok_model_capability_metadata`, `plugin_inventory_meta`, `rc_identity_migrations`, `remote_qoder_ide_migration_ledger`, `schema_migration_ledger` |
| 全文检索 | `chat_session_search_fts`, `chat_session_search_fts_config`, `chat_session_search_fts_data`, `chat_session_search_fts_docsize`, `chat_session_search_fts_idx`, `chat_session_search_segments` |
| 其他 | `agent_data_import_failures`, `agent_data_import_runs`, `agent_profile_details`, `agent_profiles`, `agent_runtimes`, `agent_team_members`, `agent_teams`, `attention_completions`, `byok_model_profiles`, `collaboration_deleted_issue_deliveries`, `collaboration_governance`, `collaboration_resource_deletions`, `discussion_agent_context_deliveries`, `discussion_agent_contexts`, `discussion_launches`, `extension_installations`, `issue_agent_deliveries`, `issue_agent_publications`, `local_device_identity`, `marketplace_bindings`, `marketplace_definition_aliases`, `marketplace_installation_names`, `marketplace_installation_presentations`, `marketplace_operations`, `marketplace_preinstall_receipts`, `marketplace_resource_bindings`, `mcp_connection_profiles`, `mcp_marketplace_receipt_entries`, `mcp_marketplace_receipts`, `peer_access_policies`, `peer_devices`, `peer_grants`, `peer_ingress_timeline`, `plugin_inventory_diagnostics`, `plugin_inventory_installations`, `plugin_inventory_resources`, `rc_channel_admissions`, `rc_history_body_proofs`, `rc_history_sync`, `rc_ingress_bindings`, `rc_ingress_deliveries`, `rc_ingress_environments`, `rc_ingress_lifecycle_cursors`, `rc_ingress_management`, `rc_ingress_timeline`, `rc_interaction_deliveries`, `rc_scope_continuity`, `remote_byok_sync_sources`, `skill_evolution_attempts`, `skill_evolution_suggestions`, `skill_market_links` |

**`local.db`** —— 库内共 **59 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `broker_session_mapping`, `chat_goal`, `chat_message`, `chat_record`, `chat_session`, `chat_snapshot`, `chat_working_space_file`, `chat_working_space_file_reference`, `session_notification`, `task_tree` |
| 事件与队列 | `agent_wiki_event` |
| 迁移与元数据 | `agent_memory_embedding_metadatachunks00`, `agent_memory_embedding_metadatachunks01`, `agent_memory_embedding_metadatachunks02`, `agent_memory_embedding_metadatachunks03`, `agent_memory_embedding_metadatatext00`, `agent_memory_embedding_metadatatext01`, `agent_wiki_config`, `broker_environment_state`, `enterprise_migration_notice`, `memory_common_embedding_metadatachunks00`, `memory_common_embedding_metadatachunks01`, `memory_common_embedding_metadatachunks02`, `memory_common_embedding_metadatachunks03`, `memory_common_embedding_metadatachunks04`, `memory_common_embedding_metadatatext00`, `memory_common_embedding_metadatatext01`, `memory_common_embedding_metadatatext02`, `sync_metadata` |
| 其他 | `agent_code_snippet`, `agent_commit`, `agent_knowledge_relation`, `agent_memory`, `agent_memory_agent_trace`, `agent_memory_conversation_trace`, `agent_memory_embedding`, `agent_memory_embedding_chunks`, `agent_memory_embedding_info`, `agent_memory_embedding_rowids`, `agent_memory_embedding_vector_chunks00`, `agent_memory_operation_log`, `agent_memory_system`, `agent_memory_system_strategy`, `agent_source_file`, `agent_wiki_catalog`, `agent_wiki_item`, `agent_wiki_overview`, `agent_wiki_readme`, `agent_wiki_repo`, `canvas_publish`, `goal`, `local_execution`, `memory_common_embedding`, `memory_common_embedding_chunks`, `memory_common_embedding_info`, `memory_common_embedding_rowids`, `memory_common_embedding_vector_chunks00`, `resource_snapshot`, `supabase_token` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `~/.qoder-cn/projects/**/<id>.jsonl`（国际版 `~/.qoder`）— CLI 明文会话正文，与 Claude Code 同构 | 【真机】 |
| 列表索引与注册表 | `%APPDATA%\com.qodercn.app.stable\main.sqlite` — 现行注册表（`chat_sessions` / `chat_session_messages` / `workspaces`）；`%APPDATA%\QoderCN\...\local.db` — 上一代桌面库（`chat_record` / `chat_message`，密文） | 【真机】 |
| 非项目落点 | `~/Documents/Qoder[CN]/<源日期>/<会话 id 前 12 位>` | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一条 CLI jsonl（明文正文） + `main.sqlite` 的 `chat_sessions` 行 + `chat_session_messages` 投影；旧代 `local.db` 的 `chat_record` / `chat_message` 是另一套副本 | 【真机】 |
| 会话 ID 形态 | CLI 正文路径 `projects/**/<id>.jsonl` 的 `<id>` | 【真机】 |
| 命名与目录派生 | 项目目录名由 cwd 派生；非项目会话目录 `~/Documents/Qoder[CN]/<源日期>/<会话 id 前 12 位>` | 【真机】 |
| 非项目桶 | `~/Documents/Qoder[CN]/<源日期>/<会话 id 前 12 位>` | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | CLI 侧单行一条事件的 JSONL，明文、与 Claude Code 同构 | 【真机】 |
| 编码与加密 | 桌面库正文为**密文**：base64 解码后高熵不可读，只能读到元数据（标题、时间、项目、角色、token、model） | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | 旧代密文库只能读元数据，正文不可读 | 【真机】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `chat_sessions`**（35 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | PK | — | 所属会话 ID |
| `sidebar_custom_order` | `INTEGER` | — | — | — |
| `origin_session_id` | `TEXT` | — | — | — |
| `session_kind` | `TEXT` | NOT NULL | `'standard'` | — |
| `owner_session_id` | `TEXT` | — | — | — |
| `side_chat_label_ordinal` | `INTEGER` | — | — | — |
| `side_chat_lifecycle_state` | `TEXT` | — | — | — |
| `side_chat_cleanup_state` | `TEXT` | — | — | — |
| `side_chat_last_activity_at` | `TIMESTAMP` | — | — | — |
| `side_chat_expires_at` | `TIMESTAMP` | — | — | — |
| `side_chat_expired_at` | `TIMESTAMP` | — | — | — |
| `side_chat_closed_at` | `TIMESTAMP` | — | — | — |
| `side_chat_close_reason` | `TEXT` | — | — | — |
| `side_chat_cleanup_failure_code` | `TEXT` | — | — | — |
| `conversation_mode` | `TEXT` | NOT NULL | `'normal'` | — |
| `product_mode` | `TEXT` | NOT NULL | `'coding'` | — |
| `title` | `TEXT` | NOT NULL | — | 会话标题 |
| `cwd` | `TEXT` | NOT NULL | — | 工作目录 |
| `execution_kind` | `TEXT` | — | — | — |
| `workspace_id` | `TEXT` | — | — | 所属工作区 ID |
| `git_branch` | `TEXT` | — | — | — |
| `model` | `TEXT` | — | — | 模型引用 |
| `permission_mode` | `TEXT` | — | — | — |
| `additional_direcotries` | `TEXT` | NOT NULL | `'{}'` | — |
| `extra_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `created_at` | `TIMESTAMP` | NOT NULL | — | 创建时间 |
| `updated_at` | `TIMESTAMP` | NOT NULL | — | 更新时间 |
| `execution_target_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `registration_json` | `TEXT` | — | — | — |
| `archived` | `INTEGER` | NOT NULL | `0` | 归档位 |
| `unread` | `INTEGER` | NOT NULL | `0` | — |
| `archived_at` | `TIMESTAMP` | — | — | — |
| `deleted_at` | `TIMESTAMP` | — | — | — |
| `message_envelope_version` | `INTEGER` | — | — | — |
| `initiator_peer_device_id` | `TEXT` | — | — | — |

表级约束：

- `CHECK (session_kind IN (
          'standard', 'sideChat', 'automationExecution'
        )`
- `CHECK (conversation_mode IN ('normal', 'voice')`
- `CHECK (product_mode IN ('coding', 'general')`

**表 `chat_session_messages`**（23 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | PK, NOT NULL | — | 所属会话 ID |
| `message_id` | `TEXT` | PK(2), NOT NULL | — | 所属消息 ID |
| `turn_id` | `TEXT` | — | — | — |
| `sequence` | `INTEGER` | NOT NULL | — | — |
| `payload_json` | `TEXT` | NOT NULL | — | — |
| `status` | `TEXT` | NOT NULL | `'completed'` | 状态 |
| `feedback` | `TEXT` | — | — | — |
| `source` | `TEXT` | NOT NULL | — | — |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |
| `role` | `TEXT` | — | — | — |
| `message_stream` | `TEXT` | — | — | — |
| `voice_session_id` | `TEXT` | — | — | — |
| `subtype` | `TEXT` | — | — | — |
| `runtime_input_state` | `TEXT` | — | — | — |
| `fork_availability` | `TEXT` | — | — | — |
| `turn_started_at` | `INTEGER` | — | — | — |
| `is_compaction_boundary` | `INTEGER` | — | — | — |
| `has_visible_content` | `INTEGER` | — | — | — |
| `payload_bytes` | `INTEGER` | — | — | — |
| `payload_hash` | `TEXT` | — | — | — |
| `payload_schema_version` | `INTEGER` | — | — | — |
| `feedback_revision` | `INTEGER` | NOT NULL | `0` | — |

表级约束：

- `PRIMARY KEY (session_id, message_id)`

**表 `workspaces`**（10 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `workspace_id` | `TEXT` | PK | — | 所属工作区 ID |
| `name` | `TEXT` | NOT NULL | — | 显示名 |
| `workspace_source` | `TEXT` | NOT NULL | — | — |
| `root_paths_json` | `TEXT` | NOT NULL | — | — |
| `product_mode` | `TEXT` | NOT NULL | `'coding'` | — |
| `extra_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |
| `archived` | `INTEGER` | NOT NULL | `0` | 归档位 |
| `deleted_at` | `INTEGER` | — | — | — |

表级约束：

- `CHECK (product_mode IN ('coding', 'general')`

**表 `chat_session`**（20 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `session_id` | `varchar(64)` | PK | — | 所属会话 ID |
| `user_id` | `VARCHAR(64)` | NOT NULL | — | 账号 ID |
| `user_name` | `varchar(64)` | — | — | — |
| `session_title` | `varchar(256)` | NOT NULL | — | — |
| `project_id` | `varchar(64)` | NOT NULL | — | 所属项目 ID |
| `project_uri` | `varchar(512)` | — | — | — |
| `project_name` | `varchar(64)` | — | — | — |
| `gmt_create` | `INTEGER` | — | — | — |
| `gmt_modified` | `INTEGER` | — | — | — |
| `org_id` | `VARCHAR(64)` | — | `''` | — |
| `session_type` | `VARCHAR(64)` | — | `''` | — |
| `mode` | `VARCHAR(64)` | — | `''` | — |
| `version` | `VARCHAR(64)` | — | `''` | — |
| `preferred_model_info` | `TEXT` | — | `''` | — |
| `status` | `VARCHAR(32)` | — | `''` | 状态 |
| `last_user_query_at` | `INTEGER` | — | `0` | — |
| `stop_reason` | `VARCHAR(20)` | — | `''` | — |
| `extra` | `TEXT` | — | `''` | — |
| `parent_session_id` | `VARCHAR(64)` | — | `''` | 父会话 ID |
| `parent_tool_call_id` | `VARCHAR(128)` | — | `''` | — |

**表 `chat_message`**（13 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `varchar(64)` | PK | — | 记录 ID |
| `session_id` | `VARCHAR(64)` | — | — | 所属会话 ID |
| `request_id` | `VARCHAR(64)` | — | — | — |
| `role` | `VARCHAR(64)` | — | — | — |
| `content` | `TEXT` | — | — | — |
| `summary` | `TEXT` | — | — | — |
| `summary_modified` | `INTEGER` | — | — | — |
| `summary_trigger` | `INTEGER` | — | `0` | — |
| `tool_result` | `TEXT` | — | — | — |
| `token_info` | `TEXT` | — | — | — |
| `model_info` | `TEXT` | — | — | — |
| `extra` | `TEXT` | — | `''` | — |
| `gmt_create` | `INTEGER` | — | — | — |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 旧代 `chat_record` / `chat_message`（密文行需 `content-sha256` 才能区分不同会话）；现行注册表 `chat_sessions`（`workspace_id` / `owner_session_id` / `registration_json`）/ `chat_session_messages` / `workspaces`，逐列结构见下方表结构 | 【真机】 |
| 关键列与约束 | 逐列结构与 CHECK 见下方表结构；CLI jsonl 事件负载与 Claude Code 同构（同一套字段：`parentUuid` / `uuid` / `message.content` 块数组），负载字段见 §3 V6 | 【真机】 |
| 标题落点 | `chat_sessions.title`；CLI 明文 jsonl 里没有标题字段 | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | CLI 明文 jsonl 与桌面库两路并存：同 id 只出一条，正文取明文；桌面库行只提供元数据 / 账户 | 【真机】 |
| 打开正文依赖 | 项目会话的 `chat_sessions.workspace_id` 必须命中同库 `workspaces` 行（侧栏按它分组）；认领不到时宿主 `save()` 会补登记一行（随机 v4 uuid + `root_paths_json` 用宿主的 realpath 形态） | 【真机】 |
| 标题裁决 | `chat_sessions.title` | 【真机】 |
| 缺字段后果 | 旧代密文库正文不可读（降级只读元数据） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | jsonl 首行 `workspace-directories` + 逐行 `cwd`；`project_uri` 为空也算非项目 | 【真机】 |
| 会话归属键 | `chat_sessions.workspace_id` → 同库 `workspaces` 行 | 【真机】 |
| 项目注册表 | `main.sqlite` 的 `workspaces` 表（`workspaces.name` 经 `workspace_id` 关联） | 【真机】 |
| 非项目会话 | `~/Documents/Qoder[CN]/<源日期>/<会话 id 前 12 位>` | 【真机】 |
| 项目显示名 | `workspaces.name` | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 `chat_sessions` / `chat_session_messages` 表结构 | 【真机】 |
| 多副本与去重 | 两代副本同 id 并存时是同一会话的不同形态 | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 11. zcode — ZCode

> **存储模型**：双库分工：CLI 正文库存会话与消息，桌面列表库的 tasks 表决定侧栏是否可见，缺一不可。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.zcode/`；正文库在 `cli/db/`，列表库在 `v2/` | 【真机】 |
| 官方覆盖变量 | `ZCODE_HOME` | 【源码】 |
| 目录归属判据 | `cli/db/db.sqlite` 含 `session` / `message` / `part` / `session_entry`；`v2/tasks-index.sqlite` 含 `tasks` 表 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `v2/credentials.json`（含按账号 uid 键控的 `project-key-location:v1:[…,<uid>,…,team]`） | 【真机】 |
| 账号分区 | `tasks` 按 `workspace_key` 分组、无账号列；`hosts.membership_id` 槽位为空 → 宿主列表不按账号过滤 | 【真机】 |
| 会话账号字段 | —（`session` / `tasks` 无账号列） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.zcode/
├── cli/
│   ├── db/db.sqlite                      # 正文库：session / message / part / session_entry
│   ├── rollout/ artifacts/ exec/ log/ plugins/  # 执行产物与日志
│   └── config.json
├── v2/
│   ├── tasks-index.sqlite                # 桌面侧栏列表库：tasks / projects / project_roots
│   ├── checkpoints/ runtime/ crash/ logs/ certs/  # 运行时状态
│   └── config.json / credentials.json / provider_config.json / bot-*.json
├── workspace/default/                    # 默认工作区
├── plugin-workspace/ skills/ backup/     # 插件工作区、技能与宿主自身备份
└── AGENTS.md
```

**【真机】 库全貌与用途分组**：

**`cli/db/db.sqlite`** —— 库内共 **24 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `message`, `part`, `session`, `session_entry`, `session_input`, `session_target`, `session_task_link`, `turn_usage` |
| 账号与权限 | `permission` |
| 事件与队列 | `dwf_event`, `workflow_event` |
| 迁移与元数据 | `local_setting`, `schema_migration` |
| 其他 | `dwf_actor`, `dwf_node`, `dwf_run`, `input_history`, `model_usage`, `todo`, `tool_usage`, `workflow_activity`, `workflow_definition`, `workflow_run`, `zcode_database_identity` |

**`v2/tasks-index.sqlite`** —— 库内共 **15 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `off_peak_tasks`, `task_group_admissions`, `task_group_members`, `task_group_view_node_orders`, `task_group_workspace_bootstraps`, `task_groups`, `tasks`, `tasks_schema_migration` |
| 项目与工作区 | `project_roots`, `projects`, `remote_project_entries` |
| 账号与权限 | `hosts` |
| 事件与队列 | `automation_runs`, `automations` |
| 迁移与元数据 | `schema_migration` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `cli/db/db.sqlite` — 正文库（`session` / `message` / `part` / `session_entry`） | 【真机】 |
| 列表索引与注册表 | `v2/tasks-index.sqlite` 的 `tasks` — 桌面侧栏列表索引（`SELECT * FROM tasks WHERE workspace_key=?`，主键 `(workspace_key, task_id)`） | 【真机】 |
| 非项目落点 | `workspace/default` — 非项目会话的共享桶；落 shared 桶前必须 `mkdir -p` 该目录（宿主自己也是 `mkdir(recursive:true)`，目录不存在它不列） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 正文库 `session` 行 + `message` / `part` 行 + 列表库 `tasks` 行；两库缺一不可 | 【真机】 |
| 会话 ID 形态 | `sess_<uuid>`（宿主校验 `/^(?:current\|sess_[A-Za-z0-9._-]+)$/`）；`slug === id`（不是标题 slug） | 【真机】 |
| 命名与目录派生 | `project_id` 是 `directory` 的纯函数：`proj_` + slugify(directory).slice(0,80)（转小写 → `[^a-z0-9._-]+` 连续段压成单个 `-` → 去首尾 `-`）。例：`D:\work\demo` → `proj_d-work-demo`；没有项目表可关联，落点只要对同一会话 id 稳定即可 | 【真机】 |
| 非项目桶 | `~/.zcode/workspace/default`（shared 形态） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | SQLite（两个独立 `.sqlite` 文件） | 【真机】 |
| 编码与加密 | 明文，无加密、无 revision 哈希 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（SQLite 直读） | 【真机】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `session`**（27 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `project_id` | `TEXT` | NOT NULL | — | 所属项目 ID |
| `workspace_id` | `TEXT` | — | — | 所属工作区 ID |
| `parent_id` | `TEXT` | — | — | 父会话 ID |
| `slug` | `TEXT` | NOT NULL | — | 会话短名 |
| `directory` | `TEXT` | NOT NULL | — | 目录标识 |
| `path` | `TEXT` | — | — | 项目内相对路径 |
| `title` | `TEXT` | NOT NULL | — | 会话标题 |
| `version` | `TEXT` | NOT NULL | — | — |
| `share_url` | `TEXT` | — | — | — |
| `summary_additions` | `INTEGER` | — | — | — |
| `summary_deletions` | `INTEGER` | — | — | — |
| `summary_files` | `INTEGER` | — | — | — |
| `summary_diffs` | `TEXT` | — | — | — |
| `revert` | `TEXT` | — | — | — |
| `permission` | `TEXT` | — | — | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `time_compacting` | `INTEGER` | — | — | — |
| `time_archived` | `INTEGER` | — | — | — |
| `task_type` | `TEXT` | NOT NULL | `'interactive'` | — |
| `title_source` | `TEXT` | NOT NULL | `'first_input'` | — |
| `title_message_id` | `TEXT` | — | — | — |
| `time_title_updated` | `INTEGER` | — | — | — |
| `trace_id` | `TEXT` | — | — | — |
| `time_deleted` | `INTEGER` | — | — | — |
| `last_outcome` | `TEXT` | — | — | — |

表级约束：

- `check(title_source in ('default', 'first_input', 'generated', 'custom')`

**表 `message`**（6 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |
| `sequence` | `INTEGER` | — | — | — |

**表 `part`**（7 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `message_id` | `TEXT` | NOT NULL | — | 所属消息 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |
| `sequence` | `INTEGER` | — | — | — |

**表 `session_entry`**（6 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `type` | `TEXT` | NOT NULL | — | 类型 |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |

**表 `tasks`**（35 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `workspace_key` | `TEXT` | PK, NOT NULL | — | — |
| `workspace_path` | `TEXT` | NOT NULL | — | — |
| `workspace_identity` | `TEXT` | — | — | — |
| `task_id` | `TEXT` | PK(2), NOT NULL | — | — |
| `title` | `TEXT` | NOT NULL | `''` | 会话标题 |
| `task_status` | `TEXT` | — | — | — |
| `provider` | `TEXT` | — | — | — |
| `mode` | `TEXT` | NOT NULL | `'build'` | — |
| `model` | `TEXT` | — | — | 模型引用 |
| `migration_source` | `TEXT` | — | — | — |
| `forked_from_task_id` | `TEXT` | — | — | — |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |
| `unread_at` | `INTEGER` | — | — | — |
| `pinned` | `INTEGER` | NOT NULL | `0` | — |
| `archived` | `INTEGER` | NOT NULL | `0` | 归档位 |
| `deleted` | `INTEGER` | NOT NULL | `0` | — |
| `title_overridden` | `INTEGER` | NOT NULL | `0` | — |
| `meta_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `searchable_text` | `TEXT` | NOT NULL | `''` | — |
| `last_unread_at` | `INTEGER` | NOT NULL | `0` | — |
| `cron_automation_id` | `TEXT` | — | — | — |
| `off_peak_task_id` | `TEXT` | — | — | — |
| `host_id` | `TEXT` | — | — | — |
| `root_path` | `TEXT` | — | — | — |
| `project_id` | `TEXT` | — | — | 所属项目 ID |
| `execution_directories` | `TEXT` | — | — | — |
| `sort_order` | `INTEGER` | — | — | — |
| `cli_title` | `TEXT` | — | — | — |
| `handoff_pending` | `INTEGER` | NOT NULL | `0` | — |
| `cli_title_source` | `TEXT` | — | — | — |
| `cli_created_at` | `INTEGER` | — | — | — |
| `cli_updated_at` | `INTEGER` | — | — | — |
| `cli_last_outcome` | `TEXT` | — | — | — |
| `cli_deleted` | `INTEGER` | — | — | — |

表级约束：

- `PRIMARY KEY (workspace_key, task_id)`

**表 `projects`**（11 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | PK | — | 所属项目 ID |
| `host_id` | `TEXT` | NOT NULL | — | — |
| `name` | `TEXT` | NOT NULL | — | 显示名 |
| `name_overridden` | `INTEGER` | NOT NULL | `0` | — |
| `position` | `INTEGER` | NOT NULL | — | — |
| `pinned` | `INTEGER` | NOT NULL | `0` | — |
| `pinned_at` | `INTEGER` | — | — | — |
| `deleted` | `INTEGER` | NOT NULL | `0` | — |
| `deleted_at` | `INTEGER` | — | — | — |
| `created_at` | `INTEGER` | NOT NULL | — | 创建时间 |
| `updated_at` | `INTEGER` | NOT NULL | — | 更新时间 |

**表 `project_roots`**（4 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `project_id` | `TEXT` | PK, NOT NULL | — | 所属项目 ID |
| `root_path` | `TEXT` | PK(2), NOT NULL | — | — |
| `position` | `INTEGER` | NOT NULL | — | — |
| `is_primary` | `INTEGER` | NOT NULL | `0` | — |

表级约束：

- `PRIMARY KEY(project_id,root_path)`


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 正文库 `session` / `message` / `part` / `session_entry`；列表库 `tasks` / `projects` / `project_roots`，逐列结构见下方表结构 | 【真机】 |
| 关键列与约束 | `message.sequence` / `part.sequence` 原生按 0..n 递增（part 是**每条消息内**从 0 起），不写就退化成插入序；`title_source` 有 CHECK 枚举 → 宿主用 `custom`；`migration_source` 宿主按严格 zod 枚举校验 → 只能为 NULL，来源信息放 `meta_json` 与 `session_entry`；`tasks` 主键 `(workspace_key, task_id)`，`workspace_key` 从 CLI 库的 `session.directory` 反查 | 【真机】 |
| 标题落点 | 四处落点：CLI 库 `session.title`；列表库 `tasks.title`、`tasks.cli_title`；`tasks.title_overridden` 是「用户已定名」的数字位（`=1` 才算） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 桌面侧栏读 `tasks-index.sqlite` 的 `tasks`（本地会话 `workspace_identity` 恒 NULL 且 `workspace_key === workspace_path`）；**只写正文库不会出现在侧栏** | 【真机】 |
| 打开正文依赖 | —（正文库直读） | 【真机】 |
| 标题裁决 | `tasks.title_overridden = 1` 才算用户已定名 | 【真机】 |
| 缺字段后果 | 宿主加载外部构造会话的 oracle（CLI / 桌面能列出并打开）未取证；读侧已覆盖 | 【待证 待证-zcode-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | `directory` 命中 `~/.zcode/workspace` 或 `~/ZCodeProject`；CLI 库没有 project 表、无 git 信号，目录是唯一判据 | 【真机】 |
| 会话归属键 | `session.directory` 派生 `project_id`（`proj_` + slugify，见 V3）；列表库 `tasks.workspace_key` 从 `session.directory` 反查 | 【真机】 |
| 项目注册表 | `v2/tasks-index.sqlite` → `projects.name`（`tasks.task_id` = 会话 id；无任务行时按 `project_roots.root_path` 最长前缀匹配） | 【真机】 |
| 非项目会话 | `~/.zcode/workspace/default`（shared 形态） | 【真机】 |
| 项目显示名 | `projects.name` | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 `session` / `tasks` 表结构 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层；`session_entry` 作扩展行，同 id 的两库行是同一会话的两个投影 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 12. mimo — MiMo Code

> **存储模型**：单库 SQLite（OpenCode 血统四表结构），会话 / 消息 / 部件 / 项目分表；列表按当前目录解析出的 project 过滤。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.local/share/mimocode/mimocode.db`（Windows 也可能在 `%APPDATA%` / `%LOCALAPPDATA%`） | 【真机】 |
| 官方覆盖变量 | `MIMO_HOME` | 【源码】 |
| 目录归属判据 | 库内含 `session` / `message` / `part` / `project` 四表 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `%APPDATA%/Xiaomi MiMo/xiaomi-last-confirmed.json → userId`（桌面登录态） | 【真机】 |
| 账号分区 | `account` / `account_state` 表存在；`session` / `project` 无账号列 | 【真机】 |
| 会话账号字段 | —（会话行不带账号归属） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.local/share/mimocode/             # Windows 也可能在 %APPDATA% / %LOCALAPPDATA%
├── mimocode.db                           # 单库：session / message / part / project / account / ...
├── mimocode.db-wal / -shm                # WAL 伴生文件
├── log/ tool-output/ snapshot/           # 日志、工具输出与快照
├── memory/sessions/ storage/session_diff/  # 会话记忆与差异存储
├── compose/ builtin_skills/              # 组合配置与内置技能
└── installation_id
```

**【真机】 库全貌与用途分组**：

**`mimocode.db`** —— 库内共 **36 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `message`, `part`, `session`, `session_prefix_snapshot`, `session_share`, `task`, `task_event` |
| 项目与工作区 | `project`, `workspace` |
| 账号与权限 | `account`, `account_state`, `control_account`, `permission`, `permission_grant` |
| 事件与队列 | `event`, `event_sequence`, `inbox` |
| 迁移与元数据 | `__drizzle_migrations`, `history_index_migration` |
| 全文检索 | `history_fts`, `history_fts_idx`, `history_fts_idx_config`, `history_fts_idx_data`, `history_fts_idx_docsize`, `history_fts_idx_idx`, `memory_fts`, `memory_fts_idx`, `memory_fts_idx_config`, `memory_fts_idx_data`, `memory_fts_idx_docsize`, `memory_fts_idx_idx` |
| 其他 | `actor_registry`, `claude_import`, `external_import`, `todo`, `workflow_run` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `mimocode.db` — 单库（`session` / `message` / `part` / `project` / `account` / `account_state` / `external_import` / `claude_import`）；按平台不同 XDG / Roaming / LocalAppData 三处可能各有一个库 | 【源码】 |
| 列表索引与注册表 | 库即列表源（按 project 过滤，见 V6） | 【真机】 |
| 非项目落点 | `~/XiaomiMiMoProjects/.mimo-sessions/<Y>/<M>/<D>/<slug>` — 非项目会话桶（每会话一个互不重叠的子目录） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = `session` 行 + `message` / `part` 行；project 归属由 `session.project_id` 表达 | 【真机】 |
| 会话 ID 形态 | —（见 `session` 表结构） | 【真机】 |
| 命名与目录派生 | `project_id` 来源是宿主的 **id 文件契约**：非 git 目录 → `global`（`project(global, worktree='/', vcs=null)`，宿主预先建好）；git 仓库 → `<git-common-dir>/mimocode-project-id`（36 字节 uuid、不带换行；文件不存在时宿主生成写入；linked worktree 也写在 common dir）；库内 `project.id` 与 id 文件内容逐字一致（真机核验） | 【真机】 |
| 非项目桶 | —（`global` 是库内信号；磁盘桶见 V2） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | SQLite；`session` / `message` / `part` / `project` 四表 | 【源码】 |
| 编码与加密 | 明文 | 【源码】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | —（SQLite 直读） | 【源码】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `session`**（26 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `project_id` | `TEXT` | NOT NULL | — | 所属项目 ID |
| `parent_id` | `TEXT` | — | — | 父会话 ID |
| `slug` | `TEXT` | NOT NULL | — | 会话短名 |
| `directory` | `TEXT` | NOT NULL | — | 目录标识 |
| `title` | `TEXT` | NOT NULL | — | 会话标题 |
| `version` | `TEXT` | NOT NULL | — | — |
| `share_url` | `TEXT` | — | — | — |
| `summary_additions` | `INTEGER` | — | — | — |
| `summary_deletions` | `INTEGER` | — | — | — |
| `summary_files` | `INTEGER` | — | — | — |
| `summary_diffs` | `TEXT` | — | — | — |
| `revert` | `TEXT` | — | — | — |
| `permission` | `TEXT` | — | — | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `time_compacting` | `INTEGER` | — | — | — |
| `time_archived` | `INTEGER` | — | — | — |
| `workspace_id` | `TEXT` | — | — | 所属工作区 ID |
| `context_from` | `TEXT` | — | — | — |
| `context_watermark` | `TEXT` | — | — | — |
| `last_checkpoint_message_id` | `TEXT` | — | — | — |
| `prompt` | `TEXT` | — | — | — |
| `auto_worktree_hint_sent` | `INTEGER` | — | — | — |
| `title_source` | `TEXT` | NOT NULL | `'user'` | — |
| `title_revision` | `INTEGER` | NOT NULL | `0` | — |

表级约束：

- `CHECK (title_source IN ('fallback', 'generated', 'user')`
- `CHECK (typeof(title_revision)`

**表 `message`**（6 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK, NOT NULL | — | 记录 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `agent_id` | `TEXT` | NOT NULL | `'main'` | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |

**表 `part`**（6 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `message_id` | `TEXT` | NOT NULL | — | 所属消息 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `data` | `TEXT` | NOT NULL | — | 序列化正文 |

**表 `project`**（11 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `TEXT` | PK | — | 记录 ID |
| `worktree` | `TEXT` | NOT NULL | — | — |
| `vcs` | `TEXT` | — | — | — |
| `name` | `TEXT` | — | — | 显示名 |
| `icon_url` | `TEXT` | — | — | — |
| `icon_color` | `TEXT` | — | — | — |
| `time_created` | `INTEGER` | NOT NULL | — | 创建时间 |
| `time_updated` | `INTEGER` | NOT NULL | — | 更新时间 |
| `time_initialized` | `INTEGER` | — | — | — |
| `sandboxes` | `TEXT` | NOT NULL | — | — |
| `commands` | `TEXT` | — | — | — |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | `session` / `message` / `part` / `project` + `account` / `account_state` / `external_import` / `claude_import`，逐列结构见下方表结构 | 【真机】 |
| 关键列与约束 | `session.project_id='global'` 是库内的非项目信号；`session` / `project` 无账号列 | 【真机】 |
| 标题落点 | `session.title`（`title_source` CHECK 见表结构） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 按「当前目录解析出的 project」过滤：换目录列表就变 → 「写进库」≠「宿主列表能看到」；侧栏分组按 `project_id`，不靠目录 | 【真机】 |
| 打开正文依赖 | —（库内即正文） | 【真机】 |
| 标题裁决 | `session.title` | 【真机】 |
| 缺字段后果 | 自动导入会话（`external_import` / `claude_import` 表）会被宿主排除 | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 当前目录解析出的 project（id 文件契约，见 V3） | 【真机】 |
| 会话归属键 | `session.project_id`；`'global'` 是库内非项目信号 | 【真机】 |
| 项目注册表 | `project` 表；`global` 是宿主预先建好的非项目 project 行（`worktree='/'`, `vcs=null`） | 【真机】 |
| 非项目会话 | `~/XiaomiMiMoProjects/.mimo-sessions/<Y>/<M>/<D>/<slug>`（每会话一个互不重叠子目录） | 【真机】 |
| 项目显示名 | `project.name`，为空时取 `project.worktree` 末段（与宿主 UI 同口径，**不是**会话 `directory` 末段） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 `session` / `message` 表结构 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | `external_import` / `claude_import` 是宿主自己的导入副本表，与用户会话分开存放 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 13. minimax — MiniMax Code

> **存储模型**：SQLite 运行时索引库 + 每会话正文目录；列表有一组硬门条件，少一项整条会话不可见。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.minimax/`，索引库在 `v2/sqlite/`，正文在 `v2/sessions/` | 【真机】 |
| 官方覆盖变量 | `MINIMAX_HOME` | 【源码】 |
| 目录归属判据 | `v2/sqlite/runtime-state.sqlite` 内含 `local_runtime_sessions` 表 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `~/.minimax/local-runtime.auth.json`（`realUserID`）与 renderer LevelDB 的 `UNIQUE_USER_ID` | 【真机】 |
| 账号分区 | `local_runtime_sessions` 无账号列；唯一按账号键控的是项目显示别名（远端键含 `<account>`） | 【真机】 |
| 会话账号字段 | —（无账号列） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.minimax/
├── v2/
│   ├── sqlite/runtime-state.sqlite       # 运行时索引库：local_runtime_sessions 等
│   ├── sessions/<sessionId>/             # 正文目录：messages.jsonl 等
│   └── migration/                        # 宿主自身的版本迁移产物
├── sessions/<sessionId>/                 # 会话级运行时目录
├── auth/ .builtin-skills/ agents/ skills/ plugins/ integrations/  # 登录态与扩展
├── cache/ computer-use/ cu/ memory/ run/  # 缓存、计算机使用与运行时状态
├── bin/                                  # 可执行文件
└── config.yaml / access-control.yaml / channel-*.yaml / local-runtime.auth.json
```

**【真机】 库全貌与用途分组**：

**`runtime-state.sqlite`** —— 库内共 **82 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `local_runtime_background_task_events`, `local_runtime_background_tasks`, `local_runtime_communication_messages`, `local_runtime_cron_session_history`, `local_runtime_message_row_migrations`, `local_runtime_message_rows`, `local_runtime_messages`, `local_runtime_session_agent_definitions`, `local_runtime_session_agent_state`, `local_runtime_session_asset_index_state`, `local_runtime_session_assets`, `local_runtime_session_clio_outbox`, `local_runtime_session_clio_state`, `local_runtime_session_locks`, `local_runtime_session_projection_watermarks`, `local_runtime_session_schema_migrations`, `local_runtime_session_sidechats`, `local_runtime_sessions`, `local_runtime_task_session_bindings`, `local_runtime_thread_goals`, `local_runtime_turn_diff_journal`, `local_runtime_turn_diff_retention_queue`, `local_runtime_turn_diff_rewind_operations`, `local_runtime_turn_diffs`, `local_runtime_turn_ingress`, `local_runtime_turn_ingress_client_requests`, `local_runtime_turn_ingress_sequences`, `local_runtime_v2_memory_execution_tasks`, `local_runtime_v2_memory_session_states`, `local_runtime_workspace_indexing_sessions`, `session_resources`, `session_turn_resources` |
| 项目与工作区 | `local_runtime_project_migrations`, `local_runtime_projects`, `local_runtime_workspace_indexing_revisions` |
| 账号与权限 | `local_runtime_plugin_miniapp_permission` |
| 事件与队列 | `local_runtime_cron_data_migrations`, `local_runtime_cron_legacy_imports`, `local_runtime_crons`, `local_runtime_queue_items`, `local_runtime_queue_migration_quarantine`, `local_runtime_queue_pauses`, `local_runtime_queue_row_migrations`, `local_runtime_queues`, `local_runtime_v2_cron_definitions`, `local_runtime_v2_cron_runs`, `local_runtime_v2_scheduler_jobs` |
| 迁移与元数据 | `local_runtime_legacy_migrations`, `local_runtime_liveboard_state`, `local_runtime_pi_history_file_migrations`, `local_runtime_pi_history_row_migrations`, `local_runtime_plugin_official_state`, `local_runtime_query_view_states`, `local_runtime_schema_migrations`, `local_runtime_v2_schema_migrations` |
| 全文检索 | `local_runtime_session_fts_keys`, `local_runtime_sessions_fts`, `local_runtime_sessions_fts_config`, `local_runtime_sessions_fts_content`, `local_runtime_sessions_fts_data`, `local_runtime_sessions_fts_docsize`, `local_runtime_sessions_fts_idx` |
| 其他 | `agents`, `local_runtime_agents`, `local_runtime_canvas_asset_references`, `local_runtime_canvas_documents`, `local_runtime_canvas_operations`, `local_runtime_file_api_uploads`, `local_runtime_ledger_watermarks`, `local_runtime_pi_history_rows`, `local_runtime_plugin_local_disabled`, `local_runtime_preferences`, `local_runtime_token_usage`, `local_runtime_v2_agent_legacy_history_notice_repair`, `local_runtime_v2_goal_requests`, `local_runtime_v2_goal_token_charges`, `local_runtime_v2_goals`, `local_runtime_v2_memory_baseline_files`, `local_runtime_v2_memory_capture_attempts`, `local_runtime_v2_memory_execution_calls`, `local_runtime_v2_memory_scopes`, `questionnaire_requests` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `v2/sessions/<history_relative_dir>/messages.jsonl` + `manifest.json` — 正文首选源 | 【真机】 |
| 列表索引与注册表 | `v2/sqlite/runtime-state.sqlite` 的 `local_runtime_sessions` — 会话索引 / 列表源 | 【真机】 |
| 非项目落点 | `~/.minimax/sessions/<id>/workspace` — 非项目会话桶（键是 ID，不含日期）；renderer localStorage（Chromium LevelDB）— 项目显示别名 | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = `local_runtime_sessions` 一行 + `messages.jsonl` 文件；`history_relative_dir` 留 NULL 时宿主按 `(session_id, created_at_ms)` 自己派生并绑定 | 【真机】 |
| 会话 ID 形态 | `history_relative_dir` 形态为 `<日期>/<时间>-session_<base64url(sessionId)>`；磁盘真实层级是 `<YYYY>/<MM>/<DD>/<同上>`，**与库内值差一个日期前缀层**，不能拿库内值当路径直接拼 | 【真机】 |
| 命名与目录派生 | 正文源选择链：`messages.jsonl → authoritativeLedgerSnapshot → local_runtime_message_rows → sqliteBlob`；DB 行缺失文件时才回退，`canonical-history-materializer` 会自己把 DB 行物化成 `messages.jsonl` | 【源码】 |
| 非项目桶 | `~/.minimax/sessions/<id>/workspace`（`generated` 形态） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 正文 `messages.jsonl` 为单行事件 JSONL，明文；索引为 SQLite | 【真机】 |
| 编码与加密 | 宿主解码链只看 `role` / `msg_content` / `thinking_content` / `tool_calls`；`data_json` 里的扩展键不影响解码 | 【源码】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | 明文直读；**消息行粒度是一行 = 一条消息** —— 行的 `role` 就是这条消息自己的角色，同一轮的多个消息共享同一个 `turn_id`。把一轮压成一行、role 取轮的角色，助手正文会被解码链整段丢掉（模型回复在宿主里消失） | 【源码】【真机】 |

**正文行契约**（`v2/sessions/**/messages.jsonl`，真机原生口径）：

| 行 `role` | 载荷 | 说明 | 证据 |
| --- | --- | --- | --- |
| `user` | `content:[{type:'text',text}]`（另带 `canonicalTextRange`） | 用户提问，一轮的起点 | 【真机】 |
| `assistant` | `content:[thinking / text / **toolCall** 三种块]`；行上另带 `api` / `provider` / `model` / `usage` / `stopReason` / `timestamp` / `responseId` | 一次模型发言 = 一行；一行可含多个 `toolCall` | 【真机】 |
| `toolResult` | `{toolCallId, toolName, content:[{type:'text',text}], details, isError, timestamp}` | **工具回执独立成行**，不写在 `assistant` 行的块里 | 【真机】 |
| `custom` | `{customType, content, display}`：`session_identity_reminder` / `todo_cadence_reminder` / `background_task_read_settlement` | 宿主内部注入；`display:false` = 宿主自己也不显示 | 【真机】 |
| `compactionSummary` | `{summary}`（无 `content` 块），`turn_id` 带 `:compaction` 后缀 | 上下文压缩摘要 | 【真机】 |

块类型全量只有三种：`text` / `thinking` / `toolCall`。
`tool_use` / `tool_result` 是**本工具自己的 π 块词汇**（只存在于 `data_json['session-sync-content']` 与 IR），
宿主原生文件里一个都没有 —— 按 π 词表去解原生行，会得到「工具调用全丢 + 回执全变助手正文」的结果。

**同一个库的两种载体，形状不同、不能共用一套块词汇**：

| 维度 | 文件型 `v2/sessions/**/messages.jsonl` | 列式 `local_runtime_message_rows.data_json` |
| --- | --- | --- |
| 工具调用 | `assistant` 行的 `toolCall` 块 | `tool_calls[]`（一条自带结果：调用 + 回执合体） |
| 工具回执 | **独立一行** `role='toolResult'` | 并进上面那条的 `tool_call_result_data` |
| 思考 / 正文 | `thinking` / `text` 块 | `thinking_content` / `msg_content` 字段 |
| 读侧后果 | 把 `toolResult` 行当 assistant 正文、只认 `tool_use` 块 → 回执显示成一串助手消息、调用全丢 | 按 `role` 二态解 → 无此问题（列只有 user / assistant） |
| 写侧后果 | 把 π 块原样写进文件 → 宿主认不出 `tool_use`，它界面里该次调用消失 | 按 `tool_calls[]` 写 → 宿主正常渲染 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `local_runtime_sessions`**（25 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | PK | — | 所属会话 ID |
| `record_json` | `TEXT` | NOT NULL | — | — |
| `updated_at_ms` | `INTEGER` | NOT NULL | — | — |
| `columnar_version` | `INTEGER` | NOT NULL | `0` | 列式格式版本 |
| `agent_name` | `TEXT` | — | — | — |
| `runtime` | `TEXT` | — | — | — |
| `session_type` | `TEXT` | — | — | — |
| `status` | `TEXT` | — | — | 状态 |
| `archived` | `INTEGER` | NOT NULL | `0` | 归档位 |
| `visibility` | `TEXT` | NOT NULL | `'visible'` | 可见性 |
| `session_kind` | `TEXT` | NOT NULL | `'unknown'` | — |
| `purpose` | `TEXT` | — | — | — |
| `purpose_kind` | `TEXT` | NOT NULL | `''` | — |
| `origin_cron_id` | `TEXT` | — | — | — |
| `parent_session_id` | `TEXT` | — | — | 父会话 ID |
| `workspace_dir` | `TEXT` | — | — | — |
| `project_workspace_dir` | `TEXT` | — | — | — |
| `is_default_workspace` | `INTEGER` | NOT NULL | `0` | — |
| `title` | `TEXT` | — | — | 会话标题 |
| `created_at_ms` | `INTEGER` | — | — | — |
| `error_message` | `TEXT` | — | — | — |
| `error_code` | `INTEGER` | — | — | — |
| `extra_data_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `project_id` | `INTEGER` | — | — | 所属项目 ID |
| `history_relative_dir` | `TEXT` | — | — | — |

表级约束：

- `CHECK (session_kind IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown')`
- `CHECK (is_default_workspace IN (0, 1)`

**表 `local_runtime_message_rows`**（9 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `INTEGER` | PK | — | 记录 ID |
| `session_id` | `TEXT` | NOT NULL | — | 所属会话 ID |
| `msg_id` | `TEXT` | NOT NULL | — | — |
| `role` | `TEXT` | — | — | — |
| `turn_id` | `TEXT` | — | — | — |
| `created_at_ms` | `INTEGER` | NOT NULL | — | — |
| `data_json` | `TEXT` | NOT NULL | — | — |
| `source` | `TEXT` | — | — | — |
| `source_context_json` | `TEXT` | — | — | — |

表级约束：

- `UNIQUE(session_id, msg_id)`

**消息行的载荷契约**（`data_json`，真机原生行口径）：

| 字段 | 内容 | 约束 | 证据 |
| --- | --- | --- | --- |
| `msg_id` | 与列 `msg_id` **必须相等** | 不等时 `decodeDisplayMessage` 直接抛 `MessageDataCorruptionError` | 【源码】 |
| `turn_id` / `turnId` | 与列 `turn_id` 相等；同一轮的所有消息共享同一个值 | 轮次边界靠它 | 【源码】【真机】 |
| `role` | `user` / `assistant`（与列 `role` 相等） | 决定这条消息显示成用户气泡还是助手消息 | 【源码】【真机】 |
| `msg_type` | `1`=AgentContent / `2`=AgentToolCall / `3`=SystemEvent | 前端按它区分「正文 / 工具调用 / 系统事件」；用户消息分支**不看**它 | 【源码】 |
| `msg_content` | 这条消息的正文 | 助手正文必须落在**助手行**上，否则宿主渲染不出来 | 【源码】【真机】 |
| `thinking_content` | 这条消息的思考 | 与正文同属一行 | 【源码】 |
| `tool_calls[]` | `{tool_name, tool_call_id, tool_call_status(1 Start/2 Finished/3 Failed), tool_call_args(JSON串), tool_call_result_data(JSON串)}` | 入参与结果都是 **JSON 串**；一条 tool_call 自带结果 | 【源码】【真机】 |
| `attachments[]` | `{type, filePath, fileName}` | 渲染层 `toAttachmentView` 的容错口径 | 【源码】 |
| `data_json` 里的其它键 | 宿主不读 | 只对本工具有意义（如全量部件数组） | 【源码】 |

**表 `local_runtime_projects`**（12 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `project_id` | `INTEGER` | PK | — | 所属项目 ID |
| `project_kind` | `TEXT` | NOT NULL | — | — |
| `workspace_dir` | `TEXT` | — | — | — |
| `pinned` | `INTEGER` | NOT NULL | `0` | — |
| `hidden` | `INTEGER` | NOT NULL | `0` | — |
| `order_index` | `INTEGER` | NOT NULL | `2147483647` | — |
| `recent_at_ms` | `INTEGER` | — | — | — |
| `latest_activity_at_ms` | `INTEGER` | NOT NULL | `0` | — |
| `session_count` | `INTEGER` | NOT NULL | `0` | — |
| `extra_data_json` | `TEXT` | NOT NULL | `'{}'` | — |
| `created_at_ms` | `INTEGER` | NOT NULL | — | — |
| `updated_at_ms` | `INTEGER` | NOT NULL | — | — |

表级约束：

- `CHECK(project_kind IN ('default', 'workspace')`
- `CHECK (
        (project_kind = 'default' AND workspace_dir IS NULL)`


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | `local_runtime_sessions` + `local_runtime_message_rows` + `local_runtime_projects`，逐列结构见下方表结构 | 【源码】 |
| 关键列与约束 | **列表硬门（少一项整条不可见）**：`columnar_version=3`（不是 3 时 `decodeSessionRow` 直接 throw）、`agent_name IN ('mavis','main')`、`archived=0`、`visibility<>'hidden'`、`session_kind NOT IN ('peek','cron')` 等；枚举严格（违规即 SQLITE_CONSTRAINT）：`runtime ∈ {pi-agent, opencode}`、`session_type ∈ {root, branch}`、`status ∈ {idle, started, error, aborted, interrupted}`；`local_runtime_projects` 行由宿主在 `columnar_version=3` 会话插入时自动建行并回填 `project_id` | 【源码】 |
| 标题落点 | `local_runtime_sessions.title` | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 来自 `local_runtime_sessions`，六个硬门全部满足才可见 | 【源码】 |
| 打开正文依赖 | 见 V3 正文源选择链（文件 → 账本快照 → DB 行 → blob 四级回退） | 【源码】 |
| 标题裁决 | `local_runtime_sessions.title` | 【源码】 |
| 缺字段后果 | 宿主加载外部构造会话的 oracle（桌面能列出并打开）未取证；列表硬门目前是源码级结论 | 【待证 待证-minimax-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 侧栏分组靠 `project_id` 列，不靠目录 | 【真机】 |
| 会话归属键 | `local_runtime_sessions.project_id`（宿主在 `columnar_version=3` 会话插入时自动回填）。回填用的是**等值比较** `p.workspace_dir = NEW.project_workspace_dir` —— 字节级相等才算命中同一个项目 | 【源码】【真机】 |
| 项目注册表 | `local_runtime_projects` 表（宿主自动建行）。**项目键是字节级目录串**：`workspace_dir` 上有部分唯一索引（`project_kind='workspace'` 时生效），所以同一个目录的两种写法（Windows 上 `d:\work` 与 `D:\work` 是同一个目录）会被当成两个项目行 → 侧栏两个同名分组 | 【源码】【真机】 |
| 非项目会话 | 判据：`is_default_workspace=1` / `project_kind='default'`；桶 `~/.minimax/sessions/<id>/workspace`（`generated` 形态，键是 ID 不含日期） | 【真机】 |
| 项目显示名 | 本地项目组 localStorage 键 `mavis:sidebar:projectGroupPrefs:v1` 的 `aliases`（键 = 规范化 workspaceDir）；远端项目 `mavis.remote-control.project-aliases.v1:<account>` | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | `created_at_ms` / `updated_at_ms`（毫秒整数） | 【源码】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | `parent_session_id` 非空、`session_kind` 为 peek / cron 的行被列表硬门排除——宿主表达分支 / 临时会话的方式 | 【源码】 |
| 宿主迁移机制 | `v2/migration/` 为宿主自身的版本迁移产物 | 【真机】 |

---

## 14. dsh — DSH (DeepSeek Harness)

> **存储模型**：目录型：一会话一个目录，正文是多帧 zstd 压缩的 JSONL，按 cwd slug 分桶。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.dsh/`，会话在 `sessions/<slug>/<会话目录>/` | 【真机】 |
| 官方覆盖变量 | `DSH_HOME` | 【源码】 |
| 目录归属判据 | `sessions/` 子目录 + 其下 `session.v4.jsonl.zstd` | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `.credentials.yaml` — 多供应商凭据池（6 个具名账号引用） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（会话体解出来无账号字段） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.dsh/
├── sessions/<slug>/<会话目录>/            # 会话根：按 cwd 派生的项目桶
│   ├── session.v4.jsonl.zstd             # 正文：多帧 zstd 压缩 JSONL
│   ├── meta.json                         # 会话元数据
│   └── ...                               # 会话级附属文件
├── storages/                             # session_projcache/ workspace.json
├── our-free-model/                       # session-map.json / catalog.json / settings.json
├── profiles/ channel-pack/ dsh-runtimes/ openai-gateway/ skills/
└── .credentials.yaml / .anonymous-user-id
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `sessions/<slug>/<会话目录>/session.v4.jsonl.zstd` — 会话正文（全部事件在一个文件里） | 【真机】 |
| 列表索引与注册表 | 无独立索引库；`storages/workspace.json` — 工作区表（`tables.workspaces[*].title`、`defaultWorkspaceId`） | 【真机】 |
| 非项目落点 | `~/Documents/deepseek-harness/default-workspace` — 非项目会话共享桶 | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个会话目录；正文 + 元数据同目录，无独立索引库 | 【真机】 |
| 会话 ID 形态 | 会话目录名 | 【真机】 |
| 命名与目录派生 | slug 规则：**与 Pi 只差冒号** —— 冒号被**丢弃**、`/` 与 `\` 变 `-`，外裹 `--…--`。例：cwd `D:\work\demo` → `--D-work-demo--` | 【真机】 |
| 非项目桶 | `~/Documents/deepseek-harness/default-workspace`（shared 形态） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | **多帧 zstd 拼接**的 JSONL（每事件一帧，魔数 `28 B5 2F FD`） | 【真机】 |
| 编码与加密 | 明文（压缩层之外） | 【真机】 |
| 压缩与多帧 | `zstdDecompressSync` 只解第一帧，必须按魔数切帧逐帧解 | 【真机】 |
| 解码要点 | 同上：切帧逐解 | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 事件：`session`(头) / `turn/start` / `step/start` / `system/message` / `user/message` / `assistant/message` / `tool/call` / `tool/result` / `session/title` / `step/end` / `turn/end` | 【真机】 |
| 关键列与约束 | 去重：`assistant/message.content` 已含 `tool-call`，独立的 `tool/call` 事件是重复投影；`agent/inbox/spliced` 与 `user/message` 重复；注入过滤：`Current runtime context…` 这类运行时快照（以 user 身份注入）不是用户输入；事件信封统一为 `type` + `seq` + `time` + `data`（`session` 头行另有 `version` / `id` / `createdAt` / `cwd` / `isSeeded` / `delegationDepth` / `agentPreset`；真机大样本逐字段核验）。关键 `data` 内层：`user/message{content, source, role, id}`、`assistant/message{turn, step, message, usage, stream}`、`tool/call{turn, step, callId, name, arguments}`、`tool/result{turn, step, message}`、`session/title{title, messageSeqs, source}`；tool 调用 / 回执同 `turn` + `step` 相邻，`callId` 标识调用 | 【真机】 |
| 标题落点 | 正文 `session/title` 行的 `data.title` | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 以 `sessions/<slug>/` 下的会话目录为单元；无独立 SQLite 列表索引 | 【真机】 |
| 打开正文依赖 | —（会话目录即全部） | 【真机】 |
| 标题裁决 | 只有正文 `session/title` 行一个来源，没有标题列或索引表 | 【真机】 |
| 缺字段后果 | —（未见登记） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | cwd 与 `~/.dsh/storages/workspace.json` 的 `defaultWorkspaceId` 比对：命中其指向目录下即为非项目 | 【真机】 |
| 会话归属键 | —（会话体内无项目键） | 【真机】 |
| 项目注册表 | `storages/workspace.json` → `tables.workspaces[*]`（`title` / `defaultWorkspaceId`） | 【真机】 |
| 非项目会话 | `~/Documents/deepseek-harness/default-workspace`（shared 形态） | 【真机】 |
| 项目显示名 | `tables.workspaces[*].title` | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 事件内字段（见正文流） | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 子代理会话：`delegationDepth > 0` 或 `origin='subagent'`，宿主主列表默认排除 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 15. freebuff — Freebuff (Codebuff)

> **存储模型**：目录型：一会话一个目录，正文、元数据、上下文、会话树各一个 JSON 文件。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<config>/projects/<project>/chats/<ISO目录>/` | 【真机】 |
| 官方覆盖变量 | `FREEBUFF_CONFIG_DIR`（默认 `~/.config/manicode`） | 【源码】 |
| 目录归属判据 | `projects/*/chats/` 下含 `chat-messages.json` 与 `chat-meta.json` | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `~/.config/manicode/credentials.json`（profile → id / email） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（会话无归属列 → 宿主列表不按账号过滤） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<config> = ~/.config/manicode/（FREEBUFF_CONFIG_DIR 可覆盖）
└── projects/<project>/
    └── chats/<ISO目录>/                  # 一会话 = 一个目录
        ├── chat-messages.json            # 正文消息数组
        ├── chat-meta.json                # 标题、时间戳、消息数等元数据
        ├── chat-context.json             # 上下文
        └── chat-tree.json                # 会话树结构
<config>/
├── settings.json / credentials.json / freebuff-metadata.json / freebuff-instance-owner.json
├── message-history.json / analytics-id.json
├── recent-projects.json                    # 最近项目注册表（懒创建，【源码】见 V8）
└── freebuff.exe / rg.exe / tree-sitter.wasm   # 宿主自带可执行文件
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `chats/<ISO目录>/chat-messages.json` — 对话正文（数组）；`chat-meta.json` — `{messageCount, firstPrompt, messagesMtimeMs}`；`chat-context.json` / `chat-tree.json` — 上下文与会话树 | 【真机】 |
| 列表索引与注册表 | 无独立索引库：目录枚举 + mtime 倒序 + `messageCount>0`（见 V6） | 【确认】 |
| 非项目落点 | —（五家「无桶」宿主之一，结构上无非项目落点） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 chats 子目录 | 【真机】 |
| 会话 ID 形态 | 目录名（全局唯一） | 【真机】 |
| 命名与目录派生 | 宿主列表是「目录枚举 + mtime 倒序 + `messageCount>0`」，删除时校验 `basename(id) === id`；ISO 形态只是宿主**自己生成**目录的习惯，不是它读取时的谓词 | 【确认】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | `chat-messages.json` 是整体 JSON 数组（不是事件流），没有逐行追加结构 | 【真机】 |
| 编码与加密 | UTF-8 明文 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 消息对象：`{id, variant:'user'\|'ai', content, blocks[], timestamp}` | 【真机】 |
| 关键列与约束 | blocks：`mode-divider` / `text`（`textType='reasoning'` 为思考）/ `tool`（`toolCallId,toolName,input,output`，一块 = 一次调用 + 一次回执）/ `agent` | 【真机】 |
| 标题落点 | `chat-meta.json` 的 `firstPrompt` | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 目录枚举 + mtime 倒序 + `messageCount>0`；`chat-meta.json` 缺失或 `messageCount=0` 的目录不列 | 【确认】 |
| 打开正文依赖 | 时间戳记在 `chat-meta.json` 的 `createdAt/updatedAt`；目录名里的 ISO 只是兜底来源 | 【真机】 |
| 标题裁决 | `chat-meta.json` 的 `firstPrompt` | 【真机】 |
| 缺字段后果 | 宿主枚举并打开「以会话 id 直接命名」目录的 oracle | 【待证 待证-freebuff-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目层由 `projects/<project>/` 目录表达；`run-state.json` 的 `sessionState.fileContext.projectRoot` 是会话内的项目根 | 【真机】 |
| 会话归属键 | —（目录即归属） | 【真机】 |
| 项目注册表 | 会话层无注册表（目录即归属）；UI 项目选择器另读 `<config>/recent-projects.json`：`{path, lastOpened}` 数组、上限 10 条、读时过滤盘上不存在的路径并按 `lastOpened` 倒序；宿主每次打开项目 upsert 一条（路径必须存在、按 `path` 去重、置顶、截断 10、2 空格 JSON），只建 `projects/<project>/` 目录不会进选择器列表 | 【源码】 |
| 非项目会话 | —（五家「无桶」宿主之一，结构上无非项目落点） | 【真机】 |
| 项目显示名 | —（客户端二进制检索 rename / workspace 显示名零命中，config 只有 settings / credentials / analytics） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | `chat-meta.json` 的 `createdAt/updatedAt` | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层；`log.jsonl` 是运行日志、与对话正文分开 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 16. cline — Cline

> **存储模型**：现行形态为 SQLite 会话库，legacy 形态为任务目录三件套；两种形态按数据根下的标记判定。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | 现行 `<data>` = `CLINE_DATA_DIR \|\| (CLINE_DIR\|~/.cline)/data`（源码 `resolveClineDataDir()`）；legacy 根 `<IDE 的 userDataDir>/User/globalStorage/saoudrizwan.claude-dev/`——按 VSCode 平台规则：Windows `%APPDATA%\<IDE>`、macOS `~/Library/Application Support/<IDE>`、Linux `~/.config/<IDE>`（IDE = Code / Cursor / Windsurf / VSCodium） | 【源码】 |
| 官方覆盖变量 | `CLINE_DATA_DIR`、`CLINE_SESSION_DATA_DIR`（覆盖 `sessions/`）、`CLINE_DB_DATA_DIR`（覆盖 `db/`） | 【源码】 |
| 目录归属判据 | `<data>/sessions/` + `<data>/db/sessions.db`，或 legacy 的 `tasks/` + `state/taskHistory.json` | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（未见登录态落点） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账号归属列） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<data> = CLINE_DATA_DIR || (CLINE_DIR|~/.cline)/data
├── db/sessions.db                        # 现行会话库：sessions 表
├── db/                                   # connectors.db / cron.db / tasks.db / teams.db / hub-*.db
├── sessions/ tasks/ checkpoints/ cache/ locks/ logs/ state/ settings/ workspace/ workspaces/
├── globalState.json / secrets.json / locks.db
└── <home>/.cline/ 下另有 cron/ skills/ tasks/ 与两个服务日志
%APPDATA%/<IDE>/User/globalStorage/saoudrizwan.claude-dev/   # legacy 任务目录形态
├── tasks/<taskId>/                       # 一会话 = 一个任务目录
│   ├── api_conversation_history.json / ui_messages.json / task_metadata.json
│   └── ...
├── state/taskHistory.json                # legacy 全局任务索引
├── checkpoints/ settings/ cache/
└── （IDE = Code / Cursor / Windsurf / VSCodium）
```

**【真机】 库全貌与用途分组**：

**`data/db/sessions.db`** —— 库内共 **4 张表**：

| 用途分组 | 表 |
| --- | --- |
| 会话与消息 | `sessions` |
| 事件与队列 | `schedule_executions`, `schedules`, `subagent_spawn_queue` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `<data>/sessions/<id>/<id>.messages.json` — 消息正文；`<id>.json` — manifest v1（会话元数据） | 【源码】 |
| 列表索引与注册表 | `<data>/db/sessions.db` 的 `sessions` 表 — 列表索引；legacy `state/taskHistory.json` | 【源码】 |
| 非项目落点 | —（结构上无非项目落点） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = manifest + messages + `sessions.db` 行三件套；**manifest 必须带绝对 `messages_path`**（`manifestToSessionRecord` 直接把它映射成 `messagesPath`） | 【源码】 |
| 会话 ID 形态 | `<13位ms>_<5位随机>`；manifest 兜底按目录名里的 13+ 位数字排序，所以纯 13 位时间戳 id 也能工作 | 【真机】 |
| 命名与目录派生 | —（无 slug 层） | 【源码】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | manifest 与 messages 为 JSON 明文（zod 校验）；列表索引为 SQLite `sessions.db` | 【源码】 |
| 编码与加密 | 明文 | 【源码】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | —（明文直读） | 【源码】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `sessions`**（28 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `session_id` | `TEXT` | PK | — | 所属会话 ID |
| `source` | `TEXT` | NOT NULL | — | — |
| `pid` | `INTEGER` | NOT NULL | — | — |
| `started_at` | `TEXT` | NOT NULL | — | — |
| `ended_at` | `TEXT` | — | — | — |
| `exit_code` | `INTEGER` | — | — | — |
| `status` | `TEXT` | NOT NULL | — | 状态 |
| `status_lock` | `INTEGER` | NOT NULL | `0` | — |
| `interactive` | `INTEGER` | NOT NULL | — | — |
| `provider` | `TEXT` | NOT NULL | — | — |
| `model` | `TEXT` | NOT NULL | — | 模型引用 |
| `cwd` | `TEXT` | NOT NULL | — | 工作目录 |
| `workspace_root` | `TEXT` | NOT NULL | — | — |
| `team_name` | `TEXT` | — | — | — |
| `enable_tools` | `INTEGER` | NOT NULL | — | — |
| `enable_spawn` | `INTEGER` | NOT NULL | — | — |
| `enable_teams` | `INTEGER` | NOT NULL | — | — |
| `parent_session_id` | `TEXT` | — | — | 父会话 ID |
| `parent_agent_id` | `TEXT` | — | — | — |
| `agent_id` | `TEXT` | — | — | — |
| `conversation_id` | `TEXT` | — | — | — |
| `is_subagent` | `INTEGER` | NOT NULL | `0` | — |
| `prompt` | `TEXT` | — | — | — |
| `metadata_json` | `TEXT` | — | — | — |
| `transcript_path` | `TEXT` | NOT NULL | `''` | — |
| `hook_path` | `TEXT` | NOT NULL | — | — |
| `messages_path` | `TEXT` | — | — | — |
| `updated_at` | `TEXT` | NOT NULL | — | 更新时间 |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | manifest v1：`{version:1, session_id, source, pid, started_at, ended_at?, exit_code?, status: idle\|running\|pending\|completed\|failed\|cancelled, interactive, provider, model, cwd, workspace_root, …}`；messages：`{version:1, updated_at, agent, sessionId, messages:[{id, role, content:[{type:'text'\|'tool_use'\|'tool_result'}], ts}]}` | 【源码】 |
| 关键列与约束 | `sessions` 表以 `session_id` 为主键；NOT NULL：source / pid / started_at / status / interactive / provider / model / cwd / workspace_root / enable_tools / enable_spawn / enable_teams / hook_pa…（逐列见上方表结构） | 【源码】 |
| 标题落点 | `metadata.title`（缺省回落到第一条 user 文本） | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | `is_subagent=0` 且无 `parent_session_id`；按 `started_at` 倒序；`currentWorkspaceOnly` 用 `cwd/workspace_root` 过滤 | 【源码】 |
| 打开正文依赖 | manifest 兜底扫描（`includeManifestFallback`）：只写 manifest + messages、没有 db 行也能被发现 | 【源码】 |
| 标题裁决 | `metadata.title`；legacy 列表索引是 `state/taskHistory.json`（4.x 只在迁移时读它） | 【源码】 |
| 缺字段后果 | 4.x 扩展能列出并打开外部构造的 manifest + messages + db 三件套的 oracle | 【待证 待证-cline-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | `cwd` / `workspace_root` | 【源码】 |
| 会话归属键 | manifest 的 `cwd` / `workspace_root`；legacy 任务目录里没有 cwd（读回恒为空） | 【源码】 |
| 项目注册表 | —（无项目注册表） | 【源码】 |
| 非项目会话 | legacy 任务目录一律非项目；结构上无非项目落点 | 【真机】 |
| 项目显示名 | —（`dist/extension.js` 无 `renameWorkspace\|renameProject\|projectName`；`workspaceName` 只用于 hooks 上下文；`sessions.db` 只有 `cwd` / `workspace_root`） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | `started_at` / `ts`（毫秒） | 【源码】 |
| 多副本与去重 | legacy 任务目录与会话库可能同时存在同一 id 的两份副本 | 【真机】 |
| 子代理与特殊会话 | `is_subagent` / `parent_session_id` 用于排除子代理；`status` 是严格枚举 | 【源码】 |
| 宿主迁移机制 | 宿主迁移时可能没把 `task_metadata.json` 的扩展键带进 manifest | 【真机】 |

---

## 17. kilo — Kilo Code

> **存储模型**：库形态与任务目录形态并存，按数据根下的 kilo.db 是否存在判定；两者不互相引用。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | 现行 `<data>` = `Global.Path.data`；非 latest 频道库名为 `kilo-<channel>.db`；legacy 根 `<IDE 的 userDataDir>/User/globalStorage/kilocode.kilo-code/`——平台规则同 VSCode（Windows `%APPDATA%` / macOS `~/Library/Application Support` / Linux `~/.config`） | 【源码】 |
| 官方覆盖变量 | `KILO_DB` / `KILO_DATA_DIR` / `KILO_TASKS_DIR` / `KILO_TASKS_DIRS` | 【源码】 |
| 目录归属判据 | 判代际的依据就是 `<data>/kilo.db` 是否存在，读侧与写侧同判据 | 【源码】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（两代均无账号分区） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（`workspace` 字段是目录不是账号） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<data> = Global.Path.data（KILO_DATA_DIR 可覆盖）
├── kilo.db                               # 现行会话库（非 latest 频道为 kilo-<channel>.db）
├── sessions/                             # 会话级目录
└── （判据：kilo.db 存在即库形态，否则走 legacy 任务目录）
%APPDATA%/<IDE>/User/globalStorage/kilocode.kilo-code/       # legacy 形态
├── tasks/<taskId>/                       # 一会话 = 一个任务目录（Cline 同构三件套 + _index.json）
├── sessions/<hash>/                      # 会话级缓存
├── settings/ cache/ puppeteer/
└── <home>/.kilo/ 下另有 bin/ skills/
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | 现行 `<data>/kilo.db` — 本地库（`project` / `session` / `message` / `part`）；legacy `tasks/<id>/` 三件套（`api_conversation_history.json` + `ui_messages.json` + `task_metadata.json`） | 【源码】 |
| 列表索引与注册表 | legacy 列表索引 `context.globalState.get("taskHistory")` → 共享 `state.vscdb` 单行；后续迁移追加 `session.workspace_id`、`session.path`、`workspace` 表 | 【源码】 |
| 非项目落点 | —（`workspace:""` 是记录语义不是目录概念，见 V7） | 【源码】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 库内 `session` 行（现行）或一个任务目录（legacy） | 【源码】 |
| 会话 ID 形态 | uuid | 【真机】 |
| 命名与目录派生 | —（无 slug 层） | 【源码】 |
| 非项目桶 | —（记录 `workspace:""`；webview 谓词 `!workspace \|\| workspace===cwd` 会让它跨工作区可见） | 【源码】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 现行：SQLite 明文；legacy：三个 JSON 文件 + `state.vscdb` 的 KV 单行 | 【源码】 |
| 编码与加密 | 明文 | 【源码】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | —（明文直读） | 【源码】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 现行表是 OpenCode 血统：`project` / `session` / `message` / `part`；后续迁移追加列与 `workspace` 表；legacy `taskHistory` 条目 zod 必填 `id/number/ts/task/tokensIn/tokensOut/totalCost`，可选 `size/workspace/mode/toolProtocol/apiConfigName…`；三件套中 `api_conversation_history.json` 是 API 轮次、`ui_messages.json` 是 UI 投影、`task_metadata.json` 是元数据 | 【源码】 |
| 关键列与约束 | 本程序对库形态读写的表为 `session` / `message` / `part` / `project`，与三表 schema 同源，逐列结构见 §1 V6 的同名表 | 【源码】 |
| 标题落点 | 库形态 `session.title`；legacy `taskHistory[].task` | 【源码】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 现行侧栏读本地库（`/sync/history` 只是它的客户端封装）；legacy 列表读 `state.vscdb` 的 `taskHistory` 单行 | 【源码】 |
| 打开正文依赖 | —（库内即正文） | 【源码】 |
| 标题裁决 | `session.title` / `taskHistory[].task` | 【源码】 |
| 缺字段后果 | 宿主 UI 能看到外部构造会话的 oracle（库 / 任务目录两条路径）未取证 | 【待证 待证-kilo-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | `workspace` 字段（目录语义） | 【源码】 |
| 会话归属键 | `session.workspace`（后续迁移追加 `session.workspace_id` / `session.path` 与 `workspace` 表） | 【源码】 |
| 项目注册表 | `project` 表 | 【源码】 |
| 非项目会话 | 记录 `workspace:""`（无目录桶；webview 谓词 `!workspace \|\| workspace===cwd` 会让它跨工作区可见） | 【源码】 |
| 项目显示名 | `project.name`，为空取 `project.worktree` 末段（与宿主 UI 同口径） | 【源码】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 §1 V6 同名表结构 | 【源码】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 库形态下本地库成为唯一正史；`state.vscdb` 单行索引与任务目录三件套是旧代同一份历史的两个投影 | 【源码】 |
| 宿主迁移机制 | 后续迁移追加列（见 V5） | 【源码】 |

---

## 18. roo — Roo Code

> **存储模型**：纯目录型：一会话一个任务目录，三件套文件 + _index.json 索引。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `%APPDATA%\<IDE>\User\globalStorage\rooveterinaryinc.roo-cline\tasks/<taskId>/`（IDE = Code / Cursor / Windsurf / VSCodium）；CLI 版 `<home>/.roo/tasks` | 【真机】 |
| 官方覆盖变量 | `ROO_TASKS_DIRS`（多个用路径分隔符分隔） | 【源码】 |
| 目录归属判据 | `tasks/` 下含 `task_metadata.json` 的任务目录 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（未见登录态落点） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账号归属列） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
%APPDATA%/<IDE>/User/globalStorage/rooveterinaryinc.roo-cline/
├── tasks/<taskId>/                       # 一会话 = 一个任务目录
│   ├── api_conversation_history.json / ui_messages.json
│   ├── task_metadata.json                # 标题、时间戳与元数据
│   └── _index.json                       # 任务索引
├── cache/ settings/                      # 模型缓存与配置
└── <home>/.roo/ 下另有 skills/ rules-merge-resolver/（CLI 版任务目录在 ~/.roo/tasks）
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `api_conversation_history.json` / `ui_messages.json` / `task_metadata.json` — 三件套 | 【真机】 |
| 列表索引与注册表 | `_index.json` — 任务目录内索引；`state.vscdb → taskHistory` — 宿主侧列表索引（与 Cline legacy 同坐标） | 【真机】 |
| 非项目落点 | —（无落点） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个任务目录 | 【真机】 |
| 会话 ID 形态 | taskId（**时间戳数字**，13 位） | 【真机】 |
| 命名与目录派生 | 无按日期 / 项目分层的上级目录，`tasks/` 平铺 | 【真机】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 三个 JSON 明文文件 + `_index.json` | 【真机】 |
| 编码与加密 | UTF-8 明文 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 与 Cline legacy 完全同构（同 §16 的 legacy 三件套字段），另多一个 `_index.json` 索引文件 | 【真机】 |
| 关键列与约束 | `_index.json` 与 `task_metadata.json` 是同一任务目录内的两份元数据，不是两个会话 | 【真机】 |
| 标题落点 | `task_metadata.json`（字段同 §16） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 宿主列表靠 `state.vscdb → taskHistory` 索引；只写任务目录可能不列 | 【真机】 |
| 打开正文依赖 | —（任务目录三件套） | 【真机】 |
| 标题裁决 | `task_metadata.json` | 【真机】 |
| 缺字段后果 | `state.vscdb → taskHistory` 索引未被外部构造覆盖 —— 宿主能否列出外部构造的任务目录 | 【待证 待证-roo-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 任务目录里没有 cwd（读回恒为空）→ 一律非项目 | 【真机】 |
| 会话归属键 | —（无归属字段） | 【真机】 |
| 项目注册表 | —（无项目注册表） | 【真机】 |
| 非项目会话 | 一律非项目；结构上无非项目落点 | 【真机】 |
| 项目显示名 | —（`dist/extension.js` 无 `renameWorkspace\|renameProject\|projectName`） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | taskId 本身是 13 位时间戳；条目内 `ts` | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 19. cursor — Cursor

> **存储模型**：旧代把会话键值塞进 VS Code 的 state.vscdb，新代改为每会话一个 store.db。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | 新代根 `<home>/.cursor/chats/`；旧代根 `%APPDATA%\Cursor\User\globalStorage\` | 【真机】 |
| 官方覆盖变量 | —（宿主无官方环境变量） | 【源码】 |
| 目录归属判据 | `chats/` 下含 `store.db`，或 `state.vscdb` 中存在 `composerData:<uuid>` 键 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | —（未见登录态落点） | 【真机】 |
| 账号分区 | —（无） | 【真机】 |
| 会话账号字段 | —（无账号归属列） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
%APPDATA%/Cursor/User/globalStorage/
├── state.vscdb                           # 旧代：ItemTable / cursorDiskKV（键值表）
├── state.vscdb.backup / storage.json / storage.json.bak
└── <扩展 id>/                            # 其它扩展的 globalStorage
<home>/.cursor/
├── chats/<...>/store.db                  # 新代：每会话一个库
├── projects/ skills/ extensions/         # 项目缓存、技能与扩展
└── argv.json / hooks.json / mcp.json / shouldUpdate
```

**【真机】 库全貌与用途分组**：

**`state.vscdb`** —— 库内共 **2 张表**：

| 用途分组 | 表 |
| --- | --- |
| 迁移与元数据 | `cursorDiskKV` |
| 其他 | `ItemTable` |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | 新代 `chats/<hash>/<id>/store.db` — 会话（内容寻址 blob 链）；旧代 `state.vscdb` 的 `cursorDiskKV`（key = `composerData:<uuid>`） | 【真机】 |
| 列表索引与注册表 | `User/workspaceStorage/<hash>/workspace.json` — 工作区映射（folder URI），另有 `composer.composerData` | 【真机】 |
| 非项目落点 | —（无独立桶；旧代会话可有空 `cwd`） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 新代一会话 = 一个 `<id>/` 目录 + `store.db`；旧代一会话 = `cursorDiskKV` 里一个 `composerData:<uuid>` 键 | 【真机】 |
| 会话 ID 形态 | 新代目录 `<id>`；旧代 `<uuid>` | 【真机】 |
| 命名与目录派生 | —（无 slug 层） | 【真机】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 新代是内容寻址 blob 链（内部不变量未文档化）；旧代是 SQLite KV，值为 JSON | 【源码】 |
| 编码与加密 | 旧代 bubble `type=1` 为用户、`type=2` 为 AI | 【真机】 |
| 压缩与多帧 | —（无） | 【源码】 |
| 解码要点 | 新代 blob 链的块结构、索引与引用关系均未文档化，宿主不提供明文写入入口 | 【源码】 |

### V6 数据结构

**本程序用到以下表，逐列结构如下**（列名、类型、约束、默认值均照宿主库登记；各家 CHECK 均为枚举取值校验，无 CHECK(length(...)) 类长度约束——文本列长度不受数据库强制，索引 / 外键与本项目无关不列；语义见「规格说明 · 类型与长度语义」）：

**表 `ItemTable`**（2 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `key` | `TEXT` | — | — | 键 |
| `value` | `BLOB` | — | — | 值 |

**表 `cursorDiskKV`**（2 列）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `key` | `TEXT` | — | — | 键 |
| `value` | `BLOB` | — | — | 值 |


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 旧代 `composerData` 含 bubbles、索引与工作区映射；`composerData` 无 `name` / `workspaceIdentifier` 字段 | 【真机】 |
| 关键列与约束 | 旧代 `state.vscdb` 两张表的列与约束见上方表结构 | 【真机】 |
| 标题落点 | —（`composerData` 无 name 字段） | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 旧代列表源是 `state.vscdb` 的 KV，不是目录枚举；工作区映射靠 `workspaceStorage/<hash>/workspace.json` 的 folder URI + `composer.composerData` | 【真机】 |
| 打开正文依赖 | composer 内部不变量（bubbles / 索引 / 工作区映射）+ 新代 blob 链均未文档化 → 无安全构造路径 | 【源码】 |
| 标题裁决 | —（无标题实体） | 【真机】 |
| 缺字段后果 | 新代 `chats/<...>/store.db` 的表结构 | 【待证 待证-cursor-1】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目 = `workspaceStorage/<hash>/workspace.json` 的 folder URI | 【真机】 |
| 会话归属键 | 旧代 `composer.composerData` 的工作区映射；`composerData` 无 `workspaceIdentifier` 字段 | 【真机】 |
| 项目注册表 | `User/workspaceStorage/*/workspace.json` 只有 `folder` URI | 【真机】 |
| 非项目会话 | —（无独立桶；旧代会话可有空 `cwd`） | 【真机】 |
| 项目显示名 | —（未见项目改名能力；`composerData` 无 `name` / `workspaceIdentifier`） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 见 KV 值内字段 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 未见子代理 / 分支的独立存放层 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 20. codebuddy — CodeBuddy Code

> **存储模型**：纯文件型：一会话一个 JSONL，按 cwd 派生的 slug 目录分桶，子代理另放 subagents/。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<home>/.codebuddy/`（`CODEBUDDY_CONFIG_DIR` 可指向别的 `.codebuddy`） | 【真机】 |
| 官方覆盖变量 | `CODEBUDDY_CONFIG_DIR` | 【源码】 |
| 目录归属判据 | `projects/` 子目录 + 其下 `.jsonl` 会话文件 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | `inspiration/<uid>/` — 登录态（与 WorkBuddy 同源 uid） | 【真机】 |
| 账号分区 | —（无账号分区） | 【真机】 |
| 会话账号字段 | —（会话行不带账号归属） | 【真机】 |
| 切换账号影响 | —（未见登记） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<home>/.codebuddy/（CODEBUDDY_CONFIG_DIR 可指向别的 .codebuddy）
├── projects/<slug>/                      # 会话根：按 cwd 派生的项目桶
│   ├── <sessionId>.jsonl                 # 一会话 = 一个 JSONL 事件流
│   └── subagents/                        # 子代理会话
├── settings.json / mcp.json / argv.json / .mcp-migrated
├── skills/ skills-marketplace/ plugins/ extensions/  # 技能与扩展
├── logs/ diagnostics/ code-ratio/ inspiration/ memery/
└── expert-history.json / .skills-marketplace-*.json
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `projects/<slug>/<sessionId>.jsonl` — 会话正史（CLI `codebuddy -r` 从这里加载） | 【真机】 |
| 列表索引与注册表 | 无独立列表索引；`sessions/`（运行时活动会话）与 `history.jsonl`（输入历史）都不是会话正史 | 【源码】 |
| 非项目落点 | —（CLI 只有 `projects/<slug>`，没有非项目桶） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `.jsonl` 文件 | 【真机】 |
| 会话 ID 形态 | 文件名（UUID 形态） | 【真机】 |
| 命名与目录派生 | slug（宿主 `PathUtils.compressPath` 原文）：`[/\\:]` → `-`，去首尾 `-`，折叠 `-+`；规范化名超过 255 字节 → 截到 180 字节（按码点）+ `-` + `djb2aBase36(完整名)` | 【源码】 |
| 非项目桶 | —（无） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 单行一条历史项的 JSONL，明文 | 【真机】 |
| 编码与加密 | `timestamp` 为**毫秒数字** | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | —（明文直读） | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 历史项：`{id, parentId?, timestamp(ms), type:'message', role, content:[block], sessionId, cwd}` | 【真机】 |
| 关键列与约束 | block：user `input_text`；assistant `output_text` / `thinking` / `tool_use`；工具回执是单独的 user 项 `tool_result`；其余机械事件：`file-history-snapshot` / `session-meta` / `result` 等 | 【真机】 |
| 标题落点 | 标题事实行：`custom-title`（`customTitle`）> `ai-title`（`aiTitle`）> `topic` | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | `projects/` 是会话正史；`sessions/` 与 `history.jsonl` 不参与列表 | 【源码】 |
| 打开正文依赖 | 宿主 CLI 以 `codebuddy -r <id>` 加载 `projects/` 里的会话，不存在的 id 报 session-not-found | 【真机】 |
| 标题裁决 | 正文三行 `custom-title` > `ai-title` > `topic`，无独立标题索引列 | 【真机】 |
| 缺字段后果 | —（未见登记） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目 = `projects/<compressPath(cwd)>/`；会话行内带 `cwd`；没有 `cwd` 时按空 cwd 兜底为非项目 | 【真机】 |
| 会话归属键 | 历史项内 `cwd` 字段 | 【真机】 |
| 项目注册表 | —（无项目表） | 【真机】 |
| 非项目会话 | —（CLI 只有 `projects/<slug>`，没有非项目桶） | 【真机】 |
| 项目显示名 | —（未见项目名 / 改名字段，列表按 cwd 末段显示） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | 毫秒数字 | 【真机】 |
| 多副本与去重 | —（未见多副本形态） | 【真机】 |
| 子代理与特殊会话 | 子代理 `subagents/<agentId>.jsonl` 宿主主列表不列；`parentId` 表达同一会话内的线性链 | 【真机】 |
| 宿主迁移机制 | `sessions/` 是运行时状态，与 `projects/` 的正史分开存放 | 【真机】 |

---

## 21. codebuddy-ide — CodeBuddy IDE

> **存储模型**：目录型：账号 / IDE 类型 / 工作区 md5 三级分桶，一会话一个目录，工作区 index.json 管列表。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `<Data>/<user>/<ideType>/<uid>/history/<md5(workspace)>/`；`<Data>` 按 Electron userDataDir 平台规则：Windows `%LOCALAPPDATA%/CodeBuddyExtension/Data`、macOS `~/Library/Application Support/CodeBuddyExtension/Data`、Linux `~/.config/CodeBuddyExtension/Data`（源码级通用规则；仅 Windows 形做过真机核验）；`<ideType>`：`CodeBuddyIDE` / `VSCode` / `Cursor` 等；`<uid>` 为账号目录 | 【真机】 |
| 官方覆盖变量 | —（未见官方环境变量） | 【真机】 |
| 目录归属判据 | `history/` 下含工作区 `index.json` 与 `<conversationId>/` 子目录 | 【真机】 |

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | 账号目录层 `<Data>/<user>/<ideType>/<uid>/` | 【真机】 |
| 账号分区 | **唯一「项目也按账号分区」的宿主**：`history/<md5(项目路径)>/` 与 `check-point` / `file-tree` / `plan-task` 同坐标平行目录都在账号目录内 | 【真机】 |
| 会话账号字段 | —（会话条目无账号字段） | 【真机】 |
| 切换账号影响 | 多账号副本合并规则见 V8（「消息更多 → 更新时间更晚」取同一份） | 【真机】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
<Data> = %LOCALAPPDATA%/CodeBuddyExtension/Data（macOS / Linux 按平台同理）
└── <user>/<ideType>/<uid>/
    └── history/<md5(workspace)>/
        ├── index.json                    # 工作区会话索引
        ├── <conversationId>/            # 一会话 = 一个目录
        │   ├── messages.json / index.json / ...
        │   └── <conversationId>.jsonl   # 正文事件流
        └── ...
<Data>/Public/                            # auth/ .memories/ 公共数据
└── <ideType> = CodeBuddyIDE / VSCode / Cursor 等；<uid> 为账号目录
```


| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `<conversationId>/messages/<messageId>.json` — 单条消息：`{role, message:"<JSON>", id, extra:"<JSON>"}` | 【真机】 |
| 列表索引与注册表 | `history/<md5(workspace)>/index.json` — 工作区会话列表：`{conversations:[{id,type,name,createdAt,lastMessageAt}], current}`；`<conversationId>/index.json` — 会话内索引：`{messages:[{id,type,role,isComplete}], requests}` | 【真机】 |
| 非项目落点 | —（宿主结构上没有非项目桶） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = 一个 `<conversationId>/` 目录（内含 `index.json` + `messages/*.json`）；会话 id 登记在工作区 `index.json` 的 `conversations[]` | 【真机】 |
| 会话 ID 形态 | conversationId（目录名） | 【真机】 |
| 命名与目录派生 | 工作区层目录名是 `md5(workspace)`；会话目录名是 conversationId，不按日期分层 | 【真机】 |
| 非项目桶 | —（无；亦无 `subagents/`） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | 分层 JSON 明文 | 【真机】 |
| 编码与加密 | `message` 与 `extra` 字段的值是 **JSON 字符串**（需二次解析），不是嵌套对象 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | cwd 来自首条 user 文本里的 `<user_info> Workspace Folder: …`；缺失时用 md5 → 工作区路径索引反查 | 【真机】 |

### V6 数据结构

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | `message.content[]`：`text` / `reasoning` / `tool-call{toolCallId,toolName,args}` / `tool-result{toolCallId,result,isError}` | 【真机】 |
| 关键列与约束 | `user_info`、`git_status`、`project_layout` 等是宿主自己注入的上下文块，不是用户输入 | 【真机】 |
| 标题落点 | 工作区 `index.json` 的 `conversations[].name` | 【真机】 |

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 工作区 `index.json` 的 `conversations[]` 是列表源，`current` 指向当前会话 | 【真机】 |
| 打开正文依赖 | 会话内 `index.json` 的 `messages[]` 与 `messages/*.json` 一一对应；缺消息文件时该条打不开 | 【真机】 |
| 标题裁决 | `conversations[].name` | 【真机】 |
| 缺字段后果 | 宿主扩展启动加载条数与 `conversations` 条数一致（真机回滚验证） | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | 项目 = `history/<md5(workspace)>/`。**md5 取的是宿主自己记的路径形态**：`normalize(小写盘符 + 正斜杠)`（宿主登记的 folder URI 一律小写盘符；逐目录核对与该式逐字相等）——盘符大小写对不上就是另一个 md5 → 另一个 history 目录 → 侧栏两个同名项目 | 【真机】 |
| 会话归属键 | cwd 来自首条 user 文本的 `<user_info> Workspace Folder`（缺失时 md5 → 工作区路径索引反查） | 【真机】 |
| 项目注册表 | v1 `genie-history/<base64>` 目录 + 各 IDE 的 `workspaceStorage/*/workspace.json` — md5 → 工作区路径反查索引；`check-point` / `file-tree` / `plan-task` 与 `history` 同坐标平行目录，都在账号目录内 | 【真机】 |
| 非项目会话 | —（宿主结构上没有非项目桶） | 【真机】 |
| 项目显示名 | —（未见显示名实体） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | `createdAt` / `lastMessageAt` 在工作区 `index.json` 的会话条目里 | 【真机】 |
| 多副本与去重 | 同一 conversation 可能同时出现在 IDE 与插件、多个账号的 Data 下 → 多副本按「消息更多 → 更新时间更晚」取同一份 | 【真机】 |
| 子代理与特殊会话 | 无 `subagents/` 目录 | 【真机】 |
| 宿主迁移机制 | v1 `genie-history/<base64>` 是旧代形态 | 【真机】 |

---

## 22. doubao — 豆包（Doubao）

> **存储模型**：agent 模式会话在本地是一棵「会话目录 → 多 agent 角色目录」的明文树（`assignment.md` + `trajectory.jsonl`）；
> 侧栏列表在云端 + IndexedDB 缓存里，本地树不是会话注册表。形态见「变体形态矩阵」。

### V1 数据根与定位

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 默认根 | `%LOCALAPPDATA%\Doubao\User Data\`（Chromium 系 userData）；agent 会话正文在 `<Profile>\.doubao\agent_mode\workspace\.sessions\` | 【真机】 |
| 官方覆盖变量 | —（二进制里有 `SAMAN_*` / `AGENT_WORKSPACE*` 配置键，未发现导出给子进程的会话根变量） | 【源码】 |
| 目录归属判据 | userData 根含 `Local State`（Profile 清单）；会话根含 `.sessions/<chatId>/agents/<agentId>/system/trajectory.jsonl` | 【真机】 |

豆包Work（`%LOCALAPPDATA%\DoubaoWork\`）与 Cici（`%LOCALAPPDATA%\Cici\`）是否与豆包同构、macOS 路径形态，均未取证 【待证 待证-doubao-3】；
多 Profile 并存时的枚举边界未取证 【待证 待证-doubao-4】；
用户技能根（`~/Doubao/skills` 与 `.user_skills` 谁是权威）未取证 【待证 待证-doubao-2】。

### V2 账号与多账号

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 登录态落点 | 云端账号；本地 IndexedDB `chrome_doubao-chat_0.indexeddb.leveldb` 的会话列表缓存有 `creator` 字段（protobuf，未解码） | 【真机】 |
| 账号分区 | —（`.sessions/<chatId>` 平铺，目录层无账号维度） | 【真机】 |
| 会话账号字段 | —（trajectory / assignment 行内无账号字段） | 【真机】 |
| 切换账号影响 | 本地正文不随账号分区；当前账号 uid 的稳定读取来源未取证 | 【待证 待证-doubao-1】 |

### V3 目录与库全貌

**【真机】 目录全貌**（模板树；`*` 为同类文件通配）：

```
%LOCALAPPDATA%\Doubao\User Data\
├── Local State                          # Profile 清单（profile.info_cache 的键）
├── <Profile>\
│   ├── Preferences                      # 含 general-agent:new-chat-workspace:<chatId> 映射
│   └── .doubao\agent_mode\workspace\
│       ├── .sessions\<chatId>\          # 一会话一个目录（chatId = 雪花 id）
│       │   ├── board.md                 # 任务公告板（多 agent 协作视图，尾部带 _最后更新_）
│       │   ├── memory/MEMORY.md
│       │   ├── attachments/
│       │   └── agents\<agentId>\        # m_ = main / o_ = organizer / s_ = subagent
│       │       ├── system\
│       │       │   ├── assignment.md    # append-only：头 4 行 + ## [ISO] 需求 块
│       │       │   ├── trajectory.jsonl # 逐行追加的消息轨迹
│       │       │   ├── tool-results/    # 工具结果只进 trajectory，此目录为空
│       │       │   └── poll-monitors/
│       │       ├── scratch/
│       │       └── socket\{briefing.md,findings.jsonl}
│       ├── .skills\                     # 宿主下发技能包
│       └── .user_skills\
└── （无会话注册表、无项目表）
```

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话正文载体 | `.sessions/<chatId>/agents/<agentId>/system/{assignment.md, trajectory.jsonl}` — 本地唯一明文正文 | 【真机】 |
| 列表索引与注册表 | 侧栏 = 云端 + IndexedDB `conversation-list-data-overall-v2` 缓存（视图级，只作标题增强）；`.sessions` 不是注册表，外部写入不进侧栏 | 【真机】 |
| 非项目落点 | `~/Doubao/chats/<YYYY-MM-DD>/<标题>/`（原生 `createAndGetPath` 产物根，懒创建，部分会话无映射） | 【真机】 |

### V4 会话边界与命名

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 会话边界 | 一会话 = `.sessions/<chatId>/` 目录；多 agent 目录是同一条会话的多个角色，不是多条会话 | 【真机】 |
| 会话 ID 形态 | chatId = 雪花 id（数字串）；前端临时 id `local_<n>` 在服务端落定后重映射 | 【源码】 |
| 命名与目录派生 | `<userData>/<Profile>/.doubao/agent_mode/workspace/.sessions/<chatId>/agents/<agentId>/`；agentId 前缀 `m_` / `o_` / `s_` 分别对应 main / organizer / subagent | 【真机】 |
| 非项目桶 | —（产物根按日期 + 标题分目录，懒创建） | 【真机】 |

### V5 存储格式与编码

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 正文格式 | `trajectory.jsonl` 逐行 `{role, content, tool_calls?, tool_call_id?}`；`assignment.md` 为 append-only Markdown（头 4 行 + `## [ISO8601] 需求` 块） | 【真机】 |
| 编码与加密 | 明文 UTF-8，无加密 | 【真机】 |
| 压缩与多帧 | —（无） | 【真机】 |
| 解码要点 | `tool_calls[].function.arguments` 是 **JSON 对象**（不是字符串）；`role:"tool"` 行只带 `tool_call_id`，工具名要按 id 回填；时间戳唯二来源 = assignment 块头 + `board.md` 的 `_最后更新_`（纳秒精度，`Date.parse` 截断到毫秒） | 【真机】 |

### V6 数据结构

`trajectory.jsonl` 单行（用到的键）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `role` | string | `user` / `assistant` / `tool` |
| `content` | string | assistant 行可为空（纯工具轮）；tool 行是工具输出文本 |
| `tool_calls` | array | `[{id, type:"function", function:{name, arguments:<object>}}]`；一行可带多个并行调用 |
| `tool_call_id` | string | 仅 `role:"tool"` 行有，指向发起调用的 `id` |

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 存储实体 | 上述 trajectory 行 + `assignment.md` 块；行内无 id / 时间戳 / usage / 序号 | 【真机】 |
| 关键列与约束 | 首轮用户消息只在 assignment（不进 trajectory）；第 2 轮起两边都有 → 按内容去重；一行可带多个并行 tool_calls，tool 行按 id 配对不按顺序；报错也是 `role:"tool"`，无状态字段，按 `Error:` 与 `exited with code N` 前缀推断 | 【真机】 |
| 标题落点 | —（无标题实体；标题取 assignment 首个需求块首行） | 【真机】 |

深度思考的推理内容是否落 trajectory 未取证 【待证 待证-doubao-5】；
图片 / 附件轮的表示（`attachments/` 何时有内容、行内如何引用）未取证 【待证 待证-doubao-6】。

### V7 可见性与索引契约

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 列表来源 | 云端 + IndexedDB 缓存（视图级，复采会丢旧会话），`.sessions` 目录不参与列表 | 【真机】 |
| 打开正文依赖 | 云端正文；本地 trajectory / assignment 是 agent 运行时落盘副本 | 【真机】 |
| 标题裁决 | IndexedDB 缓存的 `name`（UTF-16LE）仅作可选增强；本地取 assignment 首块 | 【真机】 |
| 缺字段后果 | 外部构造 `.sessions` 目录后：侧栏不列、缓存库无记录、宿主启动日志不扫该目录 | 【真机】 |

### V8 项目与工作区归属

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 项目判定 | agent 模式会话是云端聊天，非项目会话；工作区映射取 Preferences 的 `saman.local_storage_for_web.home`（字符串化的键值 JSON）→ `general-agent:new-chat-workspace:<chatId>` → 产物目录 | 【真机】 |
| 会话归属键 | —（本地行内无归属字段） | 【真机】 |
| 项目注册表 | —（无项目表；产物根懒创建） | 【真机】 |
| 非项目会话 | 全部 agent 模式会话（产物根 `~/Doubao/chats/<日期>/<标题>`） | 【真机】 |
| 项目显示名 | —（无项目实体） | 【真机】 |

### V9 元数据与特殊会话

| 规格项 | 内容 | 证据 |
| --- | --- | --- |
| 时间戳 | assignment 块头 `## [ISO8601]`（纳秒）与 `board.md` 的 `_最后更新：…Z_`；trajectory 行无时间戳，助手 / 工具轮挂前一条用户轮时间（推断值） | 【真机】 |
| 多副本与去重 | 首轮用户消息在 assignment 与 trajectory 双份 → 按内容去重；多 agent 目录归一为一条会话 | 【真机】 |
| 子代理与特殊会话 | `m_` / `o_` / `s_` 三类 agent 目录同构；main 的轮次作主线，organizer / subagent 归元数据；无 trajectory 的空 agent 目录跳过；`socket/briefing.md`、`socket/findings.jsonl` 为空文件 | 【真机】 |
| 宿主迁移机制 | —（未见登记） | 【真机】 |

---

## 写入检查单（按家）

外部构造一个能被宿主接受的会话所需的最小事实，按家汇总；本程序自身的可写性 / 落点策略见 [`program-spec.md`](program-spec.md)。容忍性一列是写入标记行 / 外部会话的前提，未取证的登记为【待证】（编号见文末清单）。

| 变体 | 会话 ID 生成 | 新会话最小落点 | 追加语义 | 未知 type 容忍性 |
| --- | --- | --- | --- | --- |
| 1. opencode-v1 | 不可写（本程序不写） | — | — | —（不写则无容忍性问题） |
| 2. opencode-v2 | `ses` 开头（裸 uuid 会编码失败） | `session_v2` 行 + `session_message` 行 + `event_sequence` 行（消息 seq 计数器，缺它宿主续写会撞 seq 唯一索引），`project_id` 须命中真实 `project` 行 | 服务端过滤任何不合规行即整页 500（严格 schema 校验） | 【源码】 严格校验：不合规行报 500，不存在「静默忽略」 |
| 3. claude | uuid | `projects/<slug>/<sessionId>.jsonl` 追加事件行（`uuid` / `parentUuid` 链、`sessionId`、`cwd`） | 追加须接在末行 `uuid` 之后（`parentUuid` 线性续接） | 【真机】 未知 `type` 行宿主忽略（见 §3 V6） |
| 4. pi | uuid（内嵌文件名 `<ISO>_<id>.jsonl`） | `sessions/<slug>/<ISO>_<id>.jsonl`（首行 `session` 头） | —（单一文件即全部） | 【待证 待证-pi-1】 未知事件行的容忍性未取证 |
| 5. antigravity | 不可写（steps 二进制无安全构造路径） | — | — | — |
| 6. codex | uuid（`rollout-<ISO>-<uuid>.jsonl`） | rollout 文件 + `.codex-global-state.json` 读-改-写（注册表是可见性硬前置） | 追加进 `.jsonl.zst` 需整帧解压→追加→重压一帧→原子替换 | 【待证 待证-codex-2】 rollout 对未知事件行的容忍性未取证 |
| 7–8. workbuddy-cn / workbuddy-intl | uuid | jsonl 正文 + `sessions` 表行（缺一不可，见 §7 V7） | 索引行缺失或落后则侧栏不列 | 【待证 待证-workbuddy-1】 未知事件行的容忍性未取证 |
| 9–10. qoder-cn / qoder-intl | 会话 id（CLI jsonl 文件名） | CLI jsonl + `chat_sessions` 行 + `chat_session_messages` 投影（`workspace_id` 须命中 `workspaces`） | 旧代 `local.db` 密文不可写 | 【待证 待证-qoder-1】 未知事件行的容忍性未取证 |
| 11. zcode | `sess_<uuid>`（宿主校验正则） | 正文库 `session` / `message` / `part` 行 + 列表库 `tasks` 行（两库缺一不可） | 只写正文库不会出现在侧栏 | 【待证 待证-zcode-2】 未知 `session_entry` 行 / 列表库行的容忍性未取证 |
| 12. mimo | uuid | `session` 行 + `message` / `part` 行（`project_id` 由 id 文件契约解析） | 自动导入表会话被宿主排除 | 【待证 待证-mimo-1】 未知部件行的容忍性未取证 |
| 13. minimax | session id | `local_runtime_sessions` 行（六硬门全过）+ `messages.jsonl` + `manifest.json` | `columnar_version<>3` 时 `decodeSessionRow` 直接 throw | 【待证 待证-minimax-2】 未知行 / 未知 `session_kind` 的容忍性未取证 |
| 14. dsh | uuid（会话目录名） | `sessions/<slug>/<会话目录>/session.v4.jsonl.zstd`（多帧 zstd 追加一帧一事件） | —（无索引库，目录即列表） | 【待证 待证-dsh-2】 未知事件行的容忍性未取证 |
| 15. freebuff | 目录名（全局唯一） | `chats/<id>/` 四文件：`chat-messages.json`（数组整体写）+ `chat-meta.json`（`messageCount>0` 才可见）；项目会话另需 upsert `recent-projects.json`（否则项目选择器不列，见 §15 V8） | 整体 JSON 无追加行语义 | N/A（整体 JSON，无事件行容忍性问题） |
| 16. cline | `<13位ms>_<5位随机>` | manifest + messages + `sessions.db` 行三件套（manifest 必须带绝对 `messages_path`） | manifest 兜底扫描：只写 manifest + messages 无 db 行也能被发现 | 【源码】 manifest 兜底扫描 + zod 校验（不合规 manifest 被拒） |
| 17. kilo | uuid | 库形态 `kilo.db` 行 或 legacy 任务目录三件套 + `state.vscdb` 的 `taskHistory` 单行 | legacy 列表索引是 `state.vscdb` 单行 KV | 【待证 待证-kilo-3】 宿主对库/任务目录外部构造行的容忍性未取证 |
| 18. roo | 13 位时间戳数字（taskId） | 任务目录三件套 + `_index.json`（列表靠 `state.vscdb → taskHistory`） | 只写任务目录可能不列 | 【待证 待证-roo-2】 `taskHistory` 索引对外部构造条目的容忍性未取证 |
| 19. cursor | 不可写（新代 blob 链无安全构造路径） | — | — | — |
| 20. codebuddy | UUID | `projects/<slug>/<sessionId>.jsonl` 追加历史项（正文不放宿主不认识的行，标记用 sidecar） | 标记走 sidecar 即刻意不依赖容忍性 | 【待证 待证-codebuddy-1】 未知历史项行的容忍性未取证（sidecar 策略规避中） |
| 21. codebuddy-ide | conversationId | `<conversationId>/` 目录（`index.json` + `messages/*.json`）+ 工作区 `index.json` 的 `conversations[]` 登记 | 缺消息文件该条打不开 | 【待证 待证-codebuddy-ide-1】 未知字段的容忍性未取证 |
| 22. doubao | 不可写（侧栏 = 云端 + IndexedDB 缓存，`.sessions` 不是会话注册表，外部写入三处 oracle 全阴性） | — | — | —（不写则无容忍性问题） |


## 待证项清单

**这里的每一项都是【待证】规格项的登记处**：涉及某条待证项之前，必须先按「建议取证方式」取证
（升级为【真机】/【源码】），或经主人明确确认（升级为【确认】）。取完证请同步更新对应小节的状态标记与本清单。

| 编号 | 变体 | 待证内容 | 建议取证方式 |
| --- | --- | --- | --- |
| 待证-claude-1 | claude | 宿主加载外部构造 JSONL 的 oracle（`parentUuid` 断链后果） | 探针会话写入后用 Claude Code 打开并核对侧栏与正文 |
| 待证-antigravity-1 | antigravity | IDE 与桌面形态的会话根（菜单里的会话是否与 `~/.gemini/antigravity-cli/` 同源；`%APPDATA%/Antigravity/` 里是否有正文） | 打开 Antigravity IDE 产生一条会话，比对两处目录的写入 |
| 待证-codex-3 | codex | IDE 扩展与桌面入口是否复用 `~/.codex/`（官方已把桌面入口并入 ChatGPT 桌面端） | 装 IDE 扩展与桌面端各产生一条会话，比对 `~/.codex/sessions` 与桌面端数据目录 |
| 待证-roo-3 | roo | 是否存在 CLI 形态（本机 `~/.roo` 下只有规则与技能，无会话与可执行） | 查官方发行物或安装 CLI 后确认会话落点 |
| 待证-opencode-1 | opencode | 三表 schema 的 `session_entry` 表对未知 `type` 行的容忍性 | 找三表 schema 的库样本，或源码取证该表的读写路径 |
| 待证-zcode-1 | zcode | 宿主加载外部构造会话的 oracle（CLI / 桌面能列出并打开；读侧已覆盖） | zcode CLI 加载探针会话（镜像验收 + CLI oracle） |
| 待证-minimax-1 | minimax | 宿主加载外部构造会话的 oracle（列表硬门是源码级结论） | 沙箱写入探针 + 宿主桌面加载，或 app.asar 里 decode 链路实证 |
| 待证-freebuff-1 | freebuff | 宿主枚举并打开「以会话 id 直接命名」的目录的 oracle | 新增 freebuff 脚本：镜像写入 + 宿主 CLI/GUI oracle |
| 待证-cline-1 | cline | 4.x 扩展能列出并打开外部构造的 manifest + messages + db 三件套 | VS Code + Cline 扩展加载探针会话（GUI 日志 oracle） |
| 待证-kilo-1 | kilo | 宿主 UI 能看到外部构造会话（库 / 任务目录两条路径） | VS Code + Kilo 扩展加载探针会话 |
| 待证-roo-1 | roo | `state.vscdb → taskHistory` 索引未被外部构造覆盖 | Roo 扩展加载探针任务目录；若确认不列，先补 taskHistory 索引再验 |
| 待证-codex-1 | codex | 宿主列表是否按 `creator_user_id` 过滤（决定切账号后旧会话是否可见） | codex 源码 / 二进制检索 thread 列表过滤谓词 |
| 待证-kilo-2 | kilo | 库形态的完整列、宿主附加列与约束 | 取一份库形态样本，只读 dump schema 后逐列登记 |
| 待证-cursor-1 | cursor | 新代 `chats/<...>/store.db` 的表结构 | 取一份新代会话库样本，只读 dump schema 后逐列登记 |
| 待证-pi-1 | pi | 未知事件行的容忍性 | 向真实会话追加一行未知 type，宿主重新加载验证 |
| 待证-codex-2 | codex | rollout 对未知事件行的容忍性 | 向真实 rollout 追加一行未知 type，宿主侧栏/打开验证 |
| 待证-workbuddy-1 | workbuddy | 未知事件行的容忍性 | 向真实 jsonl 追加一行未知 type，宿主重新加载验证 |
| 待证-qoder-1 | qoder | 未知事件行的容忍性 | 向真实 CLI jsonl 追加一行未知 type，宿主重新加载验证 |
| 待证-zcode-2 | zcode | 未知行的容忍性 | 向正文库 / 列表库各插入未知行，宿主重新加载验证 |
| 待证-mimo-1 | mimo | 未知部件行的容忍性 | 向 part 表插入未知 type 行，宿主重新加载验证 |
| 待证-minimax-2 | minimax | 未知行 / 未知 session_kind 的容忍性 | 插入偏离硬门的行，宿主重新加载验证 |
| 待证-dsh-2 | dsh | 未知事件行的容忍性 | 向会话文件追加一帧未知 type，宿主重新加载验证 |
| 待证-kilo-3 | kilo | 宿主对外部构造行的容忍性 | 库 / 任务目录两路分别外部构造，宿主加载验证 |
| 待证-roo-2 | roo | taskHistory 索引的容忍性 | 向 state.vscdb 单行插入外部条目，宿主侧栏验证 |
| 待证-codebuddy-1 | codebuddy | 未知历史项行的容忍性 | 向真实 jsonl 追加一行未知 type，`codebuddy -r` 加载验证 |
| 待证-codebuddy-ide-1 | codebuddy-ide | 未知字段的容忍性 | 向消息文件加未知字段，扩展重新加载验证 |
| 待证-dsh-1 | dsh | slug 其余字符（`.` `_` 空格 中文）的行为 | 造含这些字符的 cwd，用宿主真实会话反推目录名 |
| 待证-doubao-1 | doubao | 当前账号 uid 的稳定读取来源（IndexedDB 缓存的 `creator` 为 protobuf，未解码） | 解码 IndexedDB 列表缓存或用宿主调试接口读出 uid，换账号后观察是否变化 |
| 待证-doubao-2 | doubao | 用户技能根：`~/Doubao/skills`（空）与 `.user_skills`（空）谁是权威 | 装一个用户技能后看落点 |
| 待证-doubao-3 | doubao | 豆包Work / Cici 是否与豆包同构、macOS 路径形态 | 装机后同法取证目录树与 env 指纹 |
| 待证-doubao-4 | doubao | 多 Profile 并存时的枚举边界（`Local State` 的 `profile.info_cache` 是否覆盖全部会话根） | 建第二个 Profile 产生一条会话后核对枚举结果 |
| 待证-doubao-5 | doubao | 深度思考的推理内容是否落 trajectory | 开「深度思考」跑一轮，看行内是否出现推理类字段 |
| 待证-doubao-6 | doubao | 图片 / 附件轮的表示（`attachments/` 何时有内容、行内如何引用） | 发一张图后看目录与 trajectory 行结构 |

## 真机取证脚本清单（可复跑）

镜像验收 = 真实库只读快照 → 沙箱跑真导入 → verify → 真实数据树零改动；
oracle 级 = 宿主自己的 CLI / GUI 能加载外部构造的内容。**新取证请落成脚本放进本清单**，
棘轮会校验清单里列出的文件都真实存在。

| 脚本 | 覆盖变体 | 级别 |
| --- | --- | --- |
| `test/real-host/import-mirror.mjs` | pi、dsh、codex、workbuddy-intl、opencode（`--with-opencode`） | 镜像验收 + verify + 真实树零改动 |
| `test/real-host/opencode.mjs` | opencode | 镜像验收 + 宿主 CLI oracle |
| `test/real-host/mimo.mjs` | mimo | 镜像验收 + 宿主 CLI oracle |
| `test/real-host/codebuddy.mjs` | codebuddy | 镜像验收 + 宿主 CLI oracle（覆盖 append 与 relocate） |
| `test/real-host/codebuddy-ide.mjs` | codebuddy-ide | 跨账号切换镜像验收（GUI 协同验收记录见 §21 V6） |
| `test/real-host/doubao-q3.mjs` | doubao | 写侧可见性探针：种一枚原生形状会话 → 三处 oracle（IDB 列表缓存 + 宿主启动日志 + GUI 侧栏，GUI 需人工）→ 逐文件核对后回滚。全阴性 = `write: false` 的依据（见 §22 V7） |
