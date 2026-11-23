# 运行环境判别规格（六维 / 五层信号 / 三终态）

> 本文只回答一个问题：**当前这个进程跑在哪个环境里**。各家宿主的存储事实（目录树、库表、可见性契约）一律以 [`agent-storage.md`](agent-storage.md) 的 V1–V9 为准，本文不复制任何一条。
> 本文的「六维」与 agent-storage.md 的 V1–V9 是两套不同概念，不要互相对照编号。

## 0. 目的与边界

| 项目 | 内容 | 证据 |
| --- | --- | --- |
| 覆盖对象 | 21 个变体的宿主判别，以及 CLI / 桌面 / IDE 插件三种形态 | 【源码】 |
| 不管什么 | 会话正文格式、库表结构、落点策略、账号切换动作 | 【源码】 |
| 对外契约 | **变体名（21 个）是唯一对外标识**；六维坐标 `envId` 只作内部解析中间产物 | 【源码】 |
| 违规处理 | 存量不符合本文规则的代码登记进 `test/m76-environment-rules.test.mjs` 的债表，只减不增 | 【源码】 |

对外标识决策的理由：变体名已经固化在 CLI 参数、`SKILL.md`、`references/*.md` 与 180 处以上测试断言里；`envId` 比变体名更细（一个变体可跨多代存储），过早对外等于立刻制造第二套契约。

## 1. 六维取值域

| 维 | 取值 | 谁能判 |
| --- | --- | --- |
| `family` | claude / codex / opencode / codebuddy / qoder / zcode / mimo / minimax / dsh / cline / cursor / antigravity / pi / codebuff / doubao | S1、S2 |
| `product` | 家族内产品名（workbuddy / codebuddy / kilo / roo / freebuff …） | S1、S2 |
| `edition` | `cn` \| `intl` \| `n/a` | S1（必须是带值匹配的路径/域名信号）、S2 |
| `form` | `cli` \| `desktop` \| `ide-plugin`（可多值，用 `+` 连接） | S1 入口证据、S2 安装形态；**不得由数据根反推** |
| `gen` | `default` \| `v1` \| `v2` \| `tasks` \| `sessions` \| `db` \| `main.sqlite` \| `local.db` \| `v2-files` \| `message-rows`（可多值，用 `/` 连接） | **仅 S4** |
| `instance` | 安装根标识 / 账号 uid | S1、S3 |

### 1.1 `gen` 是独立的第六维（含 opencode v1/v2）

- `opencode` 一个变体**同时覆盖 v1 与 v2 两代存储**：v2 看 `session_v2 + session_message` 两表，v1 看 `session + message` 两表，读侧按库内表名分流。同一变体横跨两代，说明 **`envId` 比变体名更细，二者不是同构关系** —— 这正是 `envId` 不作对外契约的技术理由。
- 同类折叠还有：`kilo`（`kilo.db` 代 vs 任务目录代）、`cline`（任务目录一/二代 vs `sessions` 三代）、`minimax`（`v2-files` vs `message-rows`）、`qoder`（`main.sqlite` 现行代 vs 旧 `local.db` 密文代）。
- **`gen` 只能由 S4（存储内容 / schema）判定**：不得由环境变量或目录名判定。写侧按 `gen` 选 writer。
- 本期（P0）只把这些散落判定点登记进来，不收敛；收敛为 `genOf()` 唯一出口属于 P1。

### 1.2 变体坐标表（机器可读，测试逐行核对）

| variant | family | product | edition | form | gen |
| --- | --- | --- | --- | --- | --- |
| opencode | opencode | opencode | n/a | cli | v1/v2 |
| claude | claude | claude | n/a | cli | default |
| pi | pi | pi | n/a | cli | default |
| antigravity | antigravity | antigravity | n/a | cli+ide-plugin+desktop | default |
| codex | codex | codex | n/a | cli+ide-plugin+desktop | default |
| codebuddy | codebuddy | codebuddy | n/a | cli | default |
| codebuddy-ide | codebuddy | codebuddy | n/a | ide-plugin | default |
| workbuddy-cn | codebuddy | workbuddy | cn | desktop | default |
| workbuddy-intl | codebuddy | workbuddy | intl | desktop | default |
| qoder-cn | qoder | qoder | cn | desktop+cli | main.sqlite/local.db |
| qoder-intl | qoder | qoder | intl | desktop+cli | main.sqlite/local.db |
| zcode | zcode | zcode | n/a | desktop+cli | db |
| mimo | mimo | mimo | n/a | desktop+cli | db |
| minimax | minimax | minimax | n/a | desktop+cli | v2-files/message-rows |
| dsh | dsh | dsh | n/a | desktop+cli | default |
| freebuff | codebuff | freebuff | n/a | desktop+cli | default |
| cline | cline | cline | n/a | ide-plugin+cli | tasks/sessions |
| kilo | cline | kilo | n/a | ide-plugin+cli | db/tasks |
| roo | cline | roo | n/a | ide-plugin | tasks |
| cursor | cursor | cursor | n/a | ide-plugin | default |
| doubao | doubao | doubao | n/a | desktop | default |

### 1.3 形态列的口径

- `form` **可多值**（`+` 连接），因为同一产品常有多种入口：比如 antigravity 同时有桌面、IDE 与 CLI，codex 官方同时有 CLI、IDE 扩展与桌面入口，cline / kilo 是「IDE 插件 + CLI」，zcode / mimo / minimax / dsh / freebuff 是「桌面 + CLI 共用一个根」。
- **形态由入口证据判定**（可执行文件、安装目录、扩展目录），不由数据根反推；数据根可能被多形态共用。
- **能力由落点上有什么决定**，形态只用于解释与提示：某形态的存储尚未接入时，如实报"未覆盖"，不拿另一形态的根去凑。
- 各形态的数据根、入口与覆盖状态以 [`agent-storage.md`](agent-storage.md) 的「变体形态矩阵」为唯一事实源；本表只是它在判别维上的投影，`test/m76` 断言两者一致。
- 形态维度目前只有 codex / roo 两处存在取证缺口（见 §8），其余均为真机入口证据；antigravity 三形态已由宿主源码常量与真机落点双向确认。

## 2. 五层信号

| 层 | 载体 | 典型位置 | 最高可达维度 |
| --- | --- | --- | --- |
| S1 | 进程环境变量（宿主导出为主；本工具自造的钉住变量同属这一载体，但宿主不认） | `hosts.mjs` 的 `HOST_ENV_MARKERS` | 带值匹配时可到 `edition`，否则只到 `product`；自造变量一律不超过 `product` |
| S2 | 安装路径 / 落点 / **父进程链** | `LOCATOR.root`、`probe.names`、可执行与 resources 路径、祖先 pid 链上的 exe 与宿主按 pid 自生成的归属文件 | `edition`（目录名） |
| S3 | 目录形状 marker | `LOCATOR.marker` + `verifyMarker` | 通常只到 `product` |
| S4 | 存储内容与 schema | `schemaOf`、`tableExists` | **只有它能判 `gen`** |
| S5 | 活动度（mtime） | `newestMtime`、`index.json` mtime | 仅用于解释，**不参与决策** |

## 3. 六条硬规则

| 规则 | 陈述 | 反例 | 检查方式 | 证据 |
| --- | --- | --- | --- | --- |
| R1 | 家族共有信号不得产出比它自身 reach 更细的维度结论 | 用「两个产品都导出的版本号变量」直接判定 `workbuddy-intl` | 分支级：分支返回的变体，其结论维不得高于该分支条件里 key 的 reach（带值匹配可提升到 `edition`） | 【源码】 |
| R2 | 高层结论不得被低层推翻 | 环境指纹已给出 family，又用 mtime 覆盖 | `detectHost` 唯一定义 + 指纹表独占 + 结果不被外部改写 + 高低层信号叠加结果不变 | 【源码】 |
| R3 | 禁止默认分支 / 排除法兜底 | `cond ? 'qoder-cn' : 'qoder-intl'`（不是 cn 就 intl） | 同一 marker 返回多个变体时，每个分支条件必须含值匹配 | 【源码】 |
| R4 | 负面证据必须显式化为 `unknown` | 判不出来时落到某个默认变体 | 每个产出变体的 marker 至少要有 1 条 `充分=是` 的判据；空信号必须 `variant=null` | 【源码】 |
| R5 | 判据必须带区分力与取证标记 | 代码读了某个变量，登记表里查不到 | 双向绑定：代码用到的 key 必须登记，登记的必须被用到；每行必须有 reach / 充分 / 四态证据 | 【源码】 |
| R6 | 活动度只解释不决策 | `newest-store` 直接当当前宿主；CLI 拿 `host.variant` 当默认目标不看终态 | 决策函数体内不得同时出现 mtime 与结论产出；CLI 默认目标只认 `state=identified`（`confidence` 只说明证据来源，不代替终态） | 【源码】 |
| R7 | 当前宿主身份只认正面证据，入口层不得成为第二个兜底 | 入口查询失败就退回「最近被改动的那个」 | 入口证据只在 S1 无结论时查询（源码位置在 env/partial 判定之后）；命中唯一变体才 `identified`，命中多个只能 `ambiguous`；链查询失败或超时只能 `unknown`。入口表独占于 `hosts.mjs`，匹配一律整段目录名/文件名相等 | 【源码】 |

对「带值匹配」的定义：分支条件里出现正则字面量、`test(`、`startsWith(`、`endsWith(`、`includes(`、
或调用唯一根名判据 `wbNameMatches(` 之一，且被匹配的是路径或名称类取值。只有存在性判断（`env.X != null`）不算。
把比对抽成函数不改判据性质 —— 抽反而应该被鼓励，因为同一问题写两份正则会出现两种答案。

## 4. 三终态

| 终态 | 含义 | 现有代码能否产出 |
| --- | --- | --- |
| `identified` | 有充分信号唯一锁定一个变体 | 能（`state: identified` / `confidence: env`） |
| `ambiguous` | 信号存在但不足以锁定（家族/产品已定，某维未定） | 能（`state: ambiguous`，带 `candidates`；`confidence` 仍记证据来源 `env`） |
| `unknown` | 无任何正面证据 | 能（`state: unknown` / `confidence: none`） |

`detectHost` 的三个终态都已落地：`--into` 缺省只在 `identified` 时采纳当前宿主，
`ambiguous` / `unknown` 一律报用法错并提示显式指定（见 `cli.mjs` 的 `hostTargets` / `hostHint`）。

活动度（mtime）不再参与结论：判不出变体时它只在 `hint` 里说明「最近被改动的是谁」，供人看，不供程序用（R6）。
这条纪律要守住的原因：兜底分支修掉之后若没有 `ambiguous` 出口，压力会转移到更弱的信号上，
问题就从「稳定判错」变成「随机判错」——后者更难复现、更难追责。

## 4.1 写侧形态策略（D）

同一个产品多形态并存时（Cline 的 IDE 插件 / CLI、Codex 的 CLI / 桌面、Qoder 的桌面 / CLI），
写入落到哪一份按下列顺序定，**顺序即优先级**：

| 顺序 | 依据 | 说明 |
| --- | --- | --- |
| 1 | 用户明示 | 「导到 IDE 插件那份」这类表述优先于一切推断 |
| 2 | **调用本 skill 的 agent 的形态** | 用户没明示时就是它：用户正在哪个环境里干活，会话就落到哪个形态 |
| 3 | 目标产品在本机唯一存在的形态 | 只有一份时不存在歧义 |
| 4 | 都定不出 | 报 `form-ambiguous`，列出候选形态与各自路径，**一份都不写** |

两条硬约束：

- **不写多份**。同一条会话在多个形态各留一份，会让幂等与跨链路去重失效（同一会话出现两处副本）。
- **不猜测**。形态判不出时不得挑「最近改动的那份」或「默认那份」写，这属于 R6 禁止的活动度决策。

当前实现状态：`detectHost` 只产出变体、尚未产出 `form`，因此第 2 / 3 步暂时依赖人工确认；
`form-ambiguous` 这个终态与 `--form` 显式开关都属于 P1 的落地项（见 §5 契约）。

## 5. Environment 契约

| 字段 | 含义 | 状态 |
| --- | --- | --- |
| `envId` | 六维坐标 | 只在测试的规格模型里计算 |
| `variant` | 变体名投影，对外契约 | 已有；**只在 `state=identified` 时有值** |
| `state` | `identified` / `ambiguous` / `unknown` | 已有（`detectHost` 三终态） |
| `candidates` | `ambiguous` 时的候选变体 | 已有 |
| `confidence` | 证据来源强度：`env` / `heuristic` / `none` | 已有（判不出变体时与 `state` 正交，不再兼任终态） |
| `hint` | `unknown` 时「最近被改动的是谁」，仅作解释 | 已有 |
| `roots` | 各落点根，只由解析得出 | 已有（`resolveRoot`） |
| `remedies` | 补齐缺维度所需动作（`--into` / `--data-root`） | 无（用法错误里已给出该补哪个开关） |

## 6. 判据登记表（机器可读，测试按此表核验代码）

| 判据 | 层 | key / 模式 | 值匹配 | reach | 充分 | 归属变体 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E-CODEBUDDY-CFG | S1 | CODEBUDDY_CONFIG_DIR | — | family | 否 | codebuddy,workbuddy-cn,workbuddy-intl | 【真机】 |
| E-CB-CFG-VALUE | S1 | CODEBUDDY_CONFIG_DIR | /\.codebuddy$/ | product | 是 | codebuddy | 【源码】 |
| E-WB-CFG-CN | S1 | CODEBUDDY_CONFIG_DIR | /[\\/]\.workbuddy$/ | edition | 是 | workbuddy-cn | 【待证 待证-workbuddy-2】 |
| E-WB-CFG-INTL | S1 | CODEBUDDY_CONFIG_DIR | /[\\/]\.workbuddy-ai$/ | edition | 是 | workbuddy-intl | 【源码】 |
| E-WB-CFG-DIR-CN | S1 | WORKBUDDY_CONFIG_DIR | /[\\/]\.workbuddy$/ | edition | 是 | workbuddy-cn | 【真机】 |
| E-WB-CFG-DIR-INTL | S1 | WORKBUDDY_CONFIG_DIR | /[\\/]\.workbuddy-ai$/ | edition | 是 | workbuddy-intl | 【待证 待证-workbuddy-3】 |
| E-WB-FOLDER-CN | S1 | WORKBUDDY_DATA_FOLDER_NAME | /^\.workbuddy$/ | edition | 是 | workbuddy-cn | 【真机】 |
| E-WB-FOLDER-INTL | S1 | WORKBUDDY_DATA_FOLDER_NAME | /^\.workbuddy-ai$/ | edition | 是 | workbuddy-intl | 【待证 待证-workbuddy-3】 |
| E-WB-HOME | S1 | WORKBUDDY_HOME | — | product | 否 | workbuddy-cn | 【待证 待证-workbuddy-1】 |
| E-WB-AIHOME | S1 | WORKBUDDY_AI_HOME | — | product | 否 | workbuddy-intl | 【待证 待证-workbuddy-1】 |
| E-WB-APPVER | S1 | WORKBUDDY_APP_VERSION | — | product | 否 | workbuddy-cn,workbuddy-intl | 【真机】 |
| E-WB-RES | S1 | WORKBUDDY_RESOURCES_PATH | — | product | 否 | workbuddy-cn,workbuddy-intl | 【真机】 |
| E-WB-PID | S1 | WORKBUDDY_STARTUP_PID | — | product | 否 | workbuddy-cn,workbuddy-intl | 【真机】 |
| E-WB-SESSION | S1 | CODEBUDDY_SESSION_ID | — | instance | 否 | workbuddy-cn,workbuddy-intl | 【源码】 |
| E-CLAUDECODE | S1 | CLAUDECODE | — | product | 是 | claude | 【源码】 |
| E-CLAUDE-ENTRY | S1 | CLAUDE_CODE_ENTRYPOINT | — | product | 是 | claude | 【源码】 |
| E-CLAUDE-CFG | S1 | CLAUDE_CONFIG_DIR | — | product | 是 | claude | 【源码】 |
| E-CLAUDE-SESSION | S1 | CLAUDE_SESSION_ID | — | instance | 否 | claude | 【源码】 |
| E-CODEX-HOME | S1 | CODEX_HOME | — | product | 是 | codex | 【源码】 |
| E-CODEX-SANDBOX | S1 | CODEX_SANDBOX | — | product | 否 | codex | 【源码】 |
| E-CODEX-NPM | S1 | CODEX_MANAGED_BY_NPM | — | product | 否 | codex | 【源码】 |
| E-CODEX-THREAD | S1 | CODEX_THREAD_ID | — | instance | 否 | codex | 【源码】 |
| E-OPENCODE-DATA | S1 | OPENCODE_DATA_DIR | — | product | 是 | opencode | 【源码】 |
| E-OPENCODE-CFG | S1 | OPENCODE_CONFIG | — | product | 是 | opencode | 【源码】 |
| E-OPENCODE-BIN | S1 | OPENCODE_BIN | — | product | 是 | opencode | 【源码】 |
| E-PI-HOME | S1 | PI_HOME | — | product | 是 | pi | 【源码】 |
| E-PI-SESSION | S1 | PI_SESSION_ID | — | instance | 否 | pi | 【源码】 |
| E-QODER-CFG-CN | S1 | QODER_CONFIG_DIR | /\.qoder-cn$/ | edition | 是 | qoder-cn | 【真机】 |
| E-QODER-CFG-INTL | S1 | QODER_CONFIG_DIR | /\.qoder$/ | edition | 是 | qoder-intl | 【待证 待证-qoder-1】 |
| E-QODER-HOME-CN | S1 | QODER_HOME | /\.qoder-cn$/ | edition | 是 | qoder-cn | 【待证 待证-qoder-2】 |
| E-QODER-SESSION | S1 | QODER_SESSION_ID | — | instance | 否 | qoder-cn,qoder-intl | 【源码】 |
| E-ZCODE-HOME | S1 | ZCODE_HOME | — | product | 是 | zcode | 【源码】 |
| E-ZCODE-SESSION | S1 | ZCODE_SESSION_ID | — | instance | 否 | zcode | 【源码】 |
| E-MIMO-PREFIX | S1 | MIMOCODE_ | — | product | 是 | mimo | 【真机】 |
| E-MIMO-HOME | S1 | MIMO_HOME | — | product | 是 | mimo | 【源码】 |
| E-MIMO-SESSION | S1 | MIMOCODE_SESSION_ID | — | instance | 否 | mimo | 【源码】 |
| E-MINIMAX-HOME | S1 | MINIMAX_HOME | — | product | 是 | minimax | 【源码】 |
| E-MINIMAX-SESSION | S1 | MINIMAX_SESSION_ID | — | instance | 否 | minimax | 【源码】 |
| E-DSH-HOME | S1 | DSH_HOME | — | product | 是 | dsh | 【源码】 |
| E-DSH-SESSION | S1 | DSH_SESSION_ID | — | instance | 否 | dsh | 【源码】 |
| E-FREEBUFF-CFG | S1 | FREEBUFF_CONFIG_DIR | — | product | 是 | freebuff | 【源码】 |
| E-CODEBUFF-CFG | S1 | CODEBUFF_CONFIG_DIR | — | product | 是 | freebuff | 【源码】 |
| E-CLINE-TASKS | S1 | CLINE_TASKS_DIRS | — | product | 是 | cline | 【源码】 |
| E-KILO-DB | S1 | KILO_DB | — | product | 是 | kilo | 【源码】 |
| E-KILO-DATA | S1 | KILO_DATA_DIR | — | product | 是 | kilo | 【源码】 |
| E-KILO-TASKS | S1 | KILO_TASKS_DIR | — | product | 是 | kilo | 【源码】 |
| E-CURSOR-TRACE | S1 | CURSOR_TRACE_ID | — | product | 是 | cursor | 【源码】 |
| E-CURSOR-AGENT | S1 | CURSOR_AGENT | — | product | 是 | cursor | 【源码】 |
| E-FORM-ANTIGRAVITY-CLI | S2 | `~/.gemini/antigravity-cli/` | — | form | 是 | antigravity | 【真机】 |
| E-FORM-ANTIGRAVITY-IDE | S2 | `~/.gemini/antigravity-ide/`（宿主 paths.js 的 `IDE_NEW_DATA_DIR`） | — | form | 是 | antigravity | 【真机】 |
| E-FORM-ANTIGRAVITY-DESKTOP | S2 | `<Programs>/antigravity/Antigravity.exe` | — | form | 是 | antigravity | 【真机】 |
| E-FORM-ANTIGRAVITY-HUB | S2 | `~/.gemini/antigravity/`（宿主 paths.js 的 `IDE_OLD_DATA_DIR`，现为 Hub 活库） | — | form | 是 | antigravity | 【真机】 |
| E-FORM-CODEX-CLI | S2 | `~/.codex/` | — | form | 是 | codex | 【真机】 |
| E-FORM-CODEX-IDE | S2 | VS Code 系扩展的 Codex 目录 | — | form | 否 | codex | 【待证 待证-codex-3】 |
| E-FORM-CODEX-DESKTOP | S2 | ChatGPT 桌面端的 Codex 视图 | — | form | 否 | codex | 【待证 待证-codex-3】 |
| E-FORM-CB-CLI | S2 | `~/.codebuddy/` | — | form | 是 | codebuddy | 【真机】 |
| E-FORM-CB-IDE | S2 | `%LOCALAPPDATA%/CodeBuddyExtension/Data/` | — | form | 是 | codebuddy-ide | 【真机】 |
| E-FORM-QODER-DESKTOP | S2 | `%APPDATA%/com.qoder*.app.stable/` | — | form | 是 | qoder-cn,qoder-intl | 【真机】 |
| E-FORM-QODER-CLI | S2 | `~/.qoder*/projects/` | — | form | 否 | qoder-cn,qoder-intl | 【真机】 |
| E-FORM-CLINE-IDE | S2 | `<IDE>/User/globalStorage/saoudrizwan.claude-dev/` | — | form | 是 | cline | 【真机】 |
| E-FORM-CLINE-CLI | S2 | `~/.cline/data/sessions/` | — | form | 是 | cline | 【真机】 |
| E-FORM-KILO-IDE | S2 | `<IDE>/User/globalStorage/kilocode.kilo-code/` | — | form | 是 | kilo | 【真机】 |
| E-FORM-KILO-CLI | S2 | `~/.kilo/` | — | form | 否 | kilo | 【真机】 |
| E-WB-ACC-PATH | S1 | ACC_PRODUCT_CONFIG_PATH | 所指配置里 `dataFolderName` 整段等于 .workbuddy / .workbuddy-ai | edition | 是 | workbuddy-cn,workbuddy-intl | 【待证 待证-workbuddy-4】 |
| E-ENTRY-DOUBAO-EXE | S2 | 祖先进程 exe = `%LOCALAPPDATA%/Doubao/Application/app/Doubao.exe` | 整段 | product | 是 | doubao | 【待证 待证-doubao-7】 |
| E-ENTRY-DOUBAO-SHELL | S2 | 祖先进程 exe 在 `%LOCALAPPDATA%/Doubao/User Data/sandbox_runtime/bases/*/pwsh/` | 整段目录名 | product | 是 | doubao | 【待证 待证-doubao-7】 |
| E-ENTRY-WB-PID-CN | S2 | `<home>/.workbuddy/cache/acc-product-config-v3-<祖先pid>-*.json`，其 `dataFolderName` 为 `.workbuddy` | 整段 | edition | 是 | workbuddy-cn | 【待证 待证-workbuddy-5】 |
| E-ENTRY-WB-PID-INTL | S2 | `<home>/.workbuddy-ai/cache/acc-product-config-v3-<祖先pid>-*.json`，其 `dataFolderName` 为 `.workbuddy-ai` | 整段 | edition | 是 | workbuddy-intl | 【待证 待证-workbuddy-5】 |

**自造变量（宿主不认）**：`OPENCODE_DATA_DIR`、`CLINE_TASKS_DIRS`、`CODEBUDDY_EXTENSION_DATA/HISTORY`、
`QODER_CN/INTL_REGISTRY_DB`、`WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME`。它们仍以 S1 层登记（载体确实是环境变量），
但语义是「本工具钉住的覆盖点」而不是「宿主导出的信号」，reach 一律不超过 `product`，档位见
[`program-spec.md`](program-spec.md) §0 的 `pin` 档。判据的**层**回答「信号从哪来」，**档位**回答「它挪不挪得动根」，两者不得互相替代
（宿主认的官方变量若只覆盖子目录/单文件，也仍是 `pin`）。

**WorkBuddy 中英判别的正解**（`E-WB-CFG-DIR-*` / `E-WB-FOLDER-*`）：值匹配到根名即可定 edition，不依赖两版共用的版本号。
`WORKBUDDY_CONFIG_DIR` 同时是宿主自己的根声明，因此它既喂根定位（`program-spec.md` §0 的 `env` 档）也喂 edition 判别 ——
**同一个变量喂两个出口，不等于两个问题合并**：判别只读它的值里的目录名，定位只读它的路径，任何一方都不得用另一方的结论反推。

「值匹配」在这里的精确含义是**整段根名相等**（`wbNameMatches`）：去掉尾分隔符取最后一段，再与 `.workbuddy` / `.workbuddy-ai`
全等比较。这四条判据与 `workbuddyRoot()` 共用同一个谓词（`wbNameMatches`），因为「这个值是不是某版本的根」是同一个问题：
两边各写一份正则时，尾分隔符的值（`…/.workbuddy/`）定位认而判别判不出，近似根名（`my-workbuddy-ai`）判别认而定位不认，
后者会以 `identified` 的身份把数据写进默认目录。表里的模式列因此都要求**分隔符或行首紧邻**（`[\\/]\.workbuddy$`），
裸后缀式（`/workbuddy-ai$/`）会把 `my-workbuddy-ai` 认成本家的根，不算合规判据。

`WORKBUDDY_APP_VERSION` / `WORKBUDDY_RESOURCES_PATH` / `WORKBUDDY_STARTUP_PID` 只能确定「这是 WorkBuddy」，`充分=否`；
`WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME` 是本工具自造的别名（见下），连产品级都不是。

「充分=否」不等于「无用」：它表示这条判据单独不足以锁定变体，只能把范围收窄到家族或产品。

S2 有两种用法，登记纪律不同：**形态**判据只在形态改变落点时才登记（下表 `E-FORM-*`）；**当前宿主身份**的入口判据（`E-ENTRY-*`）问的是「谁在调用我」，即使各形态共用同一个根也必须登记，因为不登记就没有任何正面证据能说清写入目标 —— workbuddy 中英版共用产品、doubao 一个 env 信号都不导出，正属这一类。
入口判据的取值来源只有两种，都是宿主自己生成的：祖先进程链上的**可执行文件路径**（整段目录名/文件名相等才算命中），以及宿主**按 pid 自生成的归属文件**（WorkBuddy 每次加载产品配置都写 `<数据根>/cache/acc-product-config-v3-<pid>-<guid>.json`，文件里 `dataFolderName` 就是它自己声明的数据根名 —— 中英版各写各的根，所以「哪个根里有这个 pid」是正面证据而不是猜）。链查询只在 S1 判不出时做一次，失败或超时一律 `unknown`（R7）。
（原句保留）S2 类判据（`载体` 列以 S2 开头）只在**形态改变落点**时才登记：形态若共用同一个根（zcode / mimo / minimax / dsh /
freebuff / workbuddy 等），判出形态也不改变写入位置，登记它只是噪音。"形态改变落点" 的判定见
[`agent-storage.md`](agent-storage.md) 的「变体形态矩阵」同名一列。

## 7. 违规登记与棘轮

- 违规清单由 `node test/env-audit.mjs` 输出，按 R1–R7 分组，每条给「文件:行 + 原因」。
- 存量违规登记在 `test/m76-environment-rules.test.mjs` 的 `DEBT` 常量里，**只减不增**：新增违规立刻红；修好后不下调上限同样红。
- 本规则只覆盖直接命中：封装后的间接调用（例如 `const t = pickNewest()`）不计，属于已知漏报，登记在案而不是假装全绿。

## 8. 待证项清单

| 编号 | 待证内容 | 影响 |
| --- | --- | --- |
| 待证-workbuddy-1 | 桌面端是否导出 `WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME`（二者是本工具自造的别名，宿主不把它们当根；这里只问「是否碰巧也出现在进程环境里」） | 中文版进程环境里没有：这两条不能作为 edition 证据，主链路的判别依据是 `WORKBUDDY_CONFIG_DIR` 的根名 |
| 待证-workbuddy-2 | 桌面端是否会导出 `CODEBUDDY_CONFIG_DIR`：中文版进程环境里没有这个变量 | 该判据只作兼容保留；中文版的判别不再依赖它 |
| 待证-workbuddy-3 | 国际版是否导出 `WORKBUDDY_CONFIG_DIR` 且值为 `.workbuddy-ai`（中文版已确认值为 `.workbuddy`） | 国际版的 edition 判别当前只有源码结论，缺真机样本 |
| 待证-qoder-1 | 国际版是否导出 `QODER_CONFIG_DIR` 且值为 `.qoder` | 国际版目前靠排除法兜底 |
| 待证-qoder-2 | 中文版是否导出 `QODER_HOME` | 该判据只作辅助，不影响主链路 |
| 待证-antigravity-1 | ~~IDE 与桌面形态的会话根是否与 `~/.gemini/antigravity-cli/` 同源~~（已结案） | 三形态不同源：CLI 在 `antigravity-cli/`，独立 IDE 在 `antigravity-ide/`（旧加密 `.pb`），桌面 Hub 在 `antigravity/`（新 `.db` + 摘要库，已接读写）。`%APPDATA%/Antigravity/` 仅 Electron userData，无会话正文 |
| 待证-codex-3 | IDE 扩展与桌面入口是否复用 `~/.codex/` | 多形态并存时，形态维度无法收敛，`form` 只能报候选 |
| 待证-workbuddy-4 | 中英版的 agent 工具子进程是否继承 `ACC_PRODUCT_CONFIG_PATH`（配置内容与 `dataFolderName` 已读到真机样本，缺「这个变量会不会出现在我们进程的环境里」） | 继承则 edition 有 S1 正面证据；不继承就只剩 `E-ENTRY-WB-PID-*` 一条路 |
| 待证-workbuddy-5 | 归属文件名里的 pid 是否落在我们的祖先进程链上（宿主在哪个进程里加载配置未取证） | 不相交则 `E-ENTRY-WB-PID-*` 作废，双装 + 无 env 那一格只能 `ambiguous` |
| 待证-doubao-7 | 豆包 agent 模式跑工具时，祖先进程链能否走到 `Doubao.exe` 或其 `sandbox_runtime` shell；它给子进程注入了哪些变量 | 走到则豆包可 `identified`（判出后仍不可写，只是能说清「你正在豆包里，豆包不可写」）；走不到则豆包永远 `unknown` |
| 待证-roo-3 | 是否存在 CLI 形态（本机 `~/.roo` 只有规则与技能） | 若存在则 `form` 需补 `cli`，并可能新增一个数据根 |
