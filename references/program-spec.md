# 21 个变体的支持规格（session-sync 程序规格）

本文件登记**本程序**对 21 个变体的支持规格：根定位、标题同步、读写侧规矩、导入与并发、
可写性矩阵、落点策略、账号切换，以及写入宿主时本工具自己的注入约定。
各家宿主自身的数据组织（目录结构、表结构、字段约束、可见性契约）见
[`agent-storage.md`](agent-storage.md)，两边不重复登记；功能性修改前先查对应变体的宿主规格
（规则见 SKILL.md 的「协议先行」）。

证据状态标记、待证项清单与取证脚本清单都在 [`agent-storage.md`](agent-storage.md)：
本文件只写本程序怎么实现，不重复登记宿主事实。

`<home>` = 用户主目录。`%APPDATA%` / `%LOCALAPPDATA%` 仅 Windows。

---

## 0. 根定位的统一出口（`src/roots.mjs`）

每家宿主「根在哪、桶在哪、skills 在哪、登录态在哪」只在 `src/hosts.mjs` 的 `LOCATOR` 声明一次，
读侧/写侧/accounts/installer/落点表全部走同一个 `resolveRoot(variant, ctx)`。
`test/m55` 是棘轮：白名单外任何模块再自己拿 `ctx.home/appData/xdg*` 拼宿主根就红。

候选按档排列，**高优先级不会删掉低优先级的候选**（漏一条候选就是漏读一批会话）：

| 档 | 来源 | 读侧 | 写侧 |
| --- | --- | --- | --- |
| `flag` | `--data-root <变体>=<目录>` | 用 | 用 |
| `env` | 宿主官方变量**且能整体挪动本家的根**（`CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `ZCODE_HOME` / `MINIMAX_HOME` / `DSH_HOME` / `PI_HOME` / `WORKBUDDY_CONFIG_DIR` / `WORKBUDDY_DATA_FOLDER_NAME` / `MIMO_HOME` / `FREEBUFF_CONFIG_DIR` / `CLINE_DIR` / `CLINE_DATA_DIR` / `CODEBUDDY_CONFIG_DIR`） | 用 | 用 |
| `pin` | 其余覆盖点：本工具自造的（`QODER_CN/INTL_REGISTRY_DB`、`CODEBUDDY_EXTENSION_DATA/HISTORY`、`OPENCODE_DATA_DIR`、`WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME`）+ 官方但只挪子目录或单文件的（`CLINE_TASKS_DIRS`、`CLINE_SESSION_DATA_DIR`、`CLINE_DB_DATA_DIR`、`KILO_DB` / `KILO_DATA_DIR` / `KILO_TASKS_DIRS` / `KILO_TASKS_DIR`、`ROO_TASKS_DIRS`） | 用 | 用 |
| `probe` | 主动探测：在候选父集里按目录名找 + **marker 判据** | 用（存在才用） | **不自动用**，只回一条可粘贴的 `--data-root` |
| `default` | 各家约定位置 | 存在才用 | 宿主在本机出现过（配置根在）就可用 |

**档位分界看「它挪不挪得动根」，不只看「谁认它」**：
`env` 档的语义是「这个家的根被指到别处了」—— 所以 `skills`、非项目桶、登录态必须一起跟过去（`test/m58` 逐变体断言这一点）。
一个官方变量若只覆盖**某个子目录或单个库文件**（任务目录、`sessions.db`、`kilo.db`），它挪不动根，
按 `env` 对待会让 skills / 桶留在旧位置，形成「会话读到 D 盘、skills 还装 C 盘」的半搬状态 —— 这类一律 `pin`。
按此口径定档时，官方与自造只影响**证据来源**（能证明「用户在指方向」），不影响档位。
`OPENCODE_DATA_DIR` 宿主不认（见 V1，opencode 只认 `XDG_DATA_HOME`），属 `pin`。

**档位由声明产出，不从路径反推。** 每家的根派生（`rootOf` / `envRootOf`）返回 `{ path, envKey }`：
`envKey` = 决定这个路径的那个变量，`readPaths` 的每条候选把根上的 `envKey` 继承下来。
`ROOT_ENV_KEYS` 只回答「这个变量属于 env 还是 pin」，候选落哪一档 = 查表，声明处不写档位。

因此 env 值的两种形态天然都对：绝对路径（`CODEX_HOME` 指向具体目录），
或 home 下的目录名（`WORKBUDDY_DATA_FOLDER_NAME=.workbuddy`，宿主只给名字不给路径）。
反推式定档（候选路径落在哪个 env 值下面）会把后者算成 `default`，写门随后按「宿主没出现过」拒收 —— 用户明明声明了落点。
漏标 `envKey` 只会**降**成 `default`（不会静默升档），由 `test/m55` 的执行断言兜住：
凡是声明了来源的候选，其 `envKey` 必须已在 `ROOT_ENV_KEYS` 登记，且档位与登记表一致。

**接入状态**：`KILO_TASKS_DIRS`（复数、平台分隔符连接的多任务目录）已接入 `VARIANTS.kilo.readPaths`，
与旧名 `KILO_TASKS_DIR` 并存；两个都认是因为宿主两代都在用，漏一个就漏读一批会话。

- **marker 是「这个目录真的属于本家」的唯一判据**：SQLite 特征表（`session_v2`、`local_runtime_sessions`、
  `chat_sessions`、`session`+`project`…）、约定子目录（`projects/`、`sessions/`、`agent/sessions/`）、
  `User/globalStorage/<扩展 id>`。「目录存在」本身不算，所以别的宿主不会被当成本家，
  qoder 中/国际版也不会互读（候选按目录名硬隔离）。
- 探测产物是**搬过位置的声明**：命中 `<新位置>/.codex` 后套回本家形状（`sessions/`、`.codex-global-state.json`…），
  所以各家 reader 的 `kind`/`role` 过滤不用改语义。
- 探测预算只花一次：一次有界遍历（深 ≤5、每目录 200 条、整轮 1200ms）建「目录名 → 路径」索引，全体变体共用；
  超时只回静态档，绝不拿半截扫描结果写。`resolveRoot` 本身不缓存 —— 它是「写完立刻读回」的流程。
- 自定义位置**改名**后探测认不出（探测按目录名找），必须用 `--data-root` 点名。
- 非项目桶落在「文档」这类已知文件夹里的（codex / qoder×2 / dsh），位置由注册表
  `HKCU\...\User Shell Folders\Personal`（Linux 读 `user-dirs.dirs`）决定，并用宿主自生成目录互校：
  **确实被指到别处、那儿又没有本家目录 → 判未证实 → 写侧改判 `requires-cwd`，不凭空建目录**；
  注册表读不到只是「不知道」，沿用 `<home>\Documents`，不当成搬走过。
- 各变体的官方环境变量见 [`agent-storage.md`](agent-storage.md) 的 V1；本工具自造的 `pin` 变量见「宿主注入约定」。表里没有的变量 = 本家没有官方变量
  （`antigravity`、`cursor` 就没有），那种家只能靠探测或 `--data-root`。

图例：**写** = 能否作为导入目标。

---

## 0.5 标题同步的统一机制（`src/writers/title-slots.mjs`）

「源宿主里改了会话名，导入后还是旧名字」是**通性问题**，不是某家的个别毛病。
机制上它之所以发生：核心指纹只取**消息文本 + 工具调用**，不含标题 → 改名判 `identical`
→ import 的 skip 分支一行都不写 → 目标侧标题永远停在导入那一刻。

统一做法：

- **槽声明**：各家 writer 只声明「我的标题落在哪」（表名列名 / 正文行类型 / JSON 文件字段），
  三种槽形状：`db-column`、`body-row`（支持 `data.title` 这类嵌套路径）、`json-file`；
  复合主键（zcode 的 `tasks`）也支持（`idCol` 可为数组，`idVals` 可以是函数 —— 复合键的某些列
  值不是 `targetId` 本身，得由 writer 现算；取不到就不写，宁可不动也不误伤）。
  **更新逻辑只在 `title-slots.mjs` 一份** —— 加一家宿主 = 加一条声明，不写第二套 `syncTitle`。
  `test/m61` 是棘轮：任何 writer 手写 `syncTitle` 就红（`makeTitleSyncer` 造的函数带
  `__fromTitleSlots` 标记）。
- **单一通道**：标题有且只有一个负责人 —— import 的 `syncTitleIfChanged`。
  两条路径都走它，判据留在调用点（判据属场景，不属机制）：
  - **skip 分支**（`identical` / `fork-converged:identical`）：正文一字不动，只可能名字变了
  - **append 分支**：正文新增轮次后补一次 —— 否则「源侧改名 + 同时有新轮次」永远同步不过去
  - **create / fork**：标题随正文一起落，不补（读回来必然相等，函数内部早退）
  索引自愈（`ensureIndex`）与各 writer 的 append 写入**都不碰标题**：skip 分支还有
  `target-ahead`（目标比源更新），那时源侧标题是**旧名**，顺手写就把目标侧标题抹掉了。
- **同步时机**：源目标标题不同才写（`src !== dst`）。标题变化**不算内容变化**
  → 不触发 fork、不产生副本、正文一字不动。
- **append 不写标题**：写入路径若「顺手把标题落进去」，标题就有了第二个写入口（还会绕过 guard）。
  所以 claude / codebuddy / minimax / zcode / cline / kilo 的 append 都只写正文，
  标题一律交给上面那条通道。
- **guard（用户已定名 → 不覆盖）**：标了 `guard` 的槽是「用户自己起的名」的落点，
  它非空就说明用户在目标宿主里手动改过名 → **整个同步跳过**（用户的决定优先于源侧改名）。
  WorkBuddy 声明两处 guard：`sessions.custom_title` 列 + 正文 `custom-title` 行。
- **不写 `custom_title` / `custom-title`**：那是宿主给「用户在宿主里手动改名」用的标记
  （WorkBuddy：`isUserDefinedTitle = customTitle 非空`），代写等于冒充用户操作 ——
  所以它们只作 guard（只读），不作写入目标。
- 标题是**首问派生**、确实没有独立落点的只有 **pi / freebuff**（`test/m61` 的
  `NO_SLOT_REASONS` 钉着这条，且名单自校验：一旦某家接了槽却还留在名单里就红）。
  claude（正文 `ai-title`）、codex（线程库 `threads.title`）、codebuddy-ide
  （工作区 `index.json` 的 `conversations[].name`）**都有落点**，曾经被误归类成
  「首问派生、无处可落」而一直不同步 —— 归类结论必须逐家取证，不能照着上一版的名单抄。

各家的槽（宿主侧的标题落点见 [`agent-storage.md`](agent-storage.md) 对应变体 V7）：

| 变体 | 标题落点 |
| --- | --- |
| qoder-cn / qoder-intl | `chat_sessions.title`（CLI 明文 jsonl 里没有标题字段） |
| opencode | `session_v2.title` |
| mimo / kilo（db 代） | `session.title` |
| zcode | **四处**：CLI 库 `session.title`；桌面索引 `tasks.title`、`tasks.cli_title`（复合主键 `(workspace_key, task_id)`，workspace_key 从 CLI db 的 `session.directory` 反查）；`tasks.title_overridden` 作 guard（数字位，`=1` 才算用户已定名） |
| minimax | `local_runtime_sessions.title` |
| workbuddy-cn / workbuddy-intl | 正文 `ai-title` 行 + `sessions.title` 列 |
| codebuddy | 正文 `custom-title` 行 |
| dsh | 正文 `session/title` 行的 `data.title`（`pick:'all'`，正文是 zstd 多帧，由 writer 的 io 钩子解帧/重编码） |
| cline（4.x） | 会话库 manifest 的 `metadata.title` |
| kilo | `state.vscdb` 的 `ItemTable['kilocode.kilo-code'].taskHistory[].task` |
| claude | 正文 `ai-title` 行（`pick:'last'`：每会话 6–23 条，读侧最后一条胜出）；create 时补一行 |
| codex | 线程库 `threads.title`；`threads.name` 作 guard（用户手动改名才有的列） |
| codebuddy-ide | 工作区 `index.json` 的 `conversations[id].name`（数组元素按 id 定位，绝不新建条目） |
| zcode（guard） | `tasks.title_overridden`（数字位：=1 才算已定名；=0 不能永久挡住同步） |

### 标题长度的口径（读不截、写按容量截、比对用截断值）

| 位置 | 规则 | 为什么 |
| --- | --- | --- |
| **读侧** | 原样返回，**任何情况下都不按长度截断** | 读的职责是如实反映宿主里的内容；读时截一刀，列表显示的就已不是真相，截断值再写回去还会把宿主的标题真的改短。`normalizeTitle` 因此不接受 `maxLen` 参数（`test/m72` 有棘轮：`readers/` 不许引用 `TITLE_MAX`） |
| **写侧** | 归一化后按**目标宿主的原生容量**（`TITLE_MAX`）截断，不报错 | 为一个超长标题让整条导入失败是本末倒置；不截则宿主自己截（它按 UTF-16 code unit 切，emoji 会被劈成半个代理对）。唯一出口 `fitTitleFor(variant, raw)` |
| **drift 比对** | 源标题**先按目标容量截断**，再与目标当前标题比 | 拿未截断的源值去比，「源 600 字 / 目标存 500 字」永远不相等 → 每轮都判定改名、反复重写 |
| **首问预览** | 归一化后按 `PREVIEW_LEN` 截断（`previewTitle`） | 这是我们构造的显示值，截断就是它的语义 |

变体名带区域后缀是常态（`workbuddy-cn`、`qoder-intl`），`titleMaxOf` 先精确命中再按 `-` 退到家族名；
`codebuddy-ide` 精确命中 200，不会被退成 `codebuddy` 的 500。

---

## 0.6 写侧的两条硬规矩

### 一题多解 = 必须收敛为唯一出口

**同一件事出现两处及以上实现，一律视为一题多解，必须收敛，不许「先报告再说」。**
判断口径：两个函数回答**同一个问题** → 就是一题多解。

已收敛（`test/m64` 是棘轮，防止再长出第二套）：

| 事项 | 唯一出口 | 收敛前 |
| --- | --- | --- |
| 取表的列名 | `readers/base.mjs` 的 `tableColumns` | 5 处各写一遍 `PRAGMA table_info` |
| 表里有没有某列 | `readers/base.mjs` 的 `tableHasColumn` | 4 处各判一遍 |
| 时间范围过滤 | `readers/base.mjs` 的 `inTimeRange` | 12 处（8 个转发壳 + 4 个 import opencode 的） |
| opencode 会话 slug | `writers/base.mjs` 的 `slugOf` | opencode 与 opencode-classic 各一份（**同宿主两代，规则必须一致**） |
| 工具输出→文本 | `src/text.mjs` 的 `outputText` | **7 份**：`util.toolOutputText`、`readers/base`、`writers/base`（`outputToText`）、`readers/workbuddy` 私有版、claude 的 `toolResultText`、dsh 内联、pi 的 `textOf`。`{text}` / `{content[]}` / 字符串 / 数组四种形态的归一只有这一处 |
| fork 分支坐标 | `identity.mjs` 的 `forkBranchKey` | `diff.divergenceHash`（整段后缀）与 `import.branchKey`（第 k 轮）两套并存，同一分支每续一轮就换一个 fork ID |
| 复合键 WHERE | `writers/base.mjs` 的 `resolveKeyWhere` / `keyWhereOf` | `title-slots` 读、写两段同构 + zcode 私有反查，共 3 份 |
| 标题归一化 / 预览截断 / 写侧容量 | `titles.mjs` 的 `normalizeTitle` / `previewTitle` / `fitTitleFor` | 各仓 20+ 处 `slice(0, N)` |
| 写前备份落点 | `writers/base.mjs` 的 `backupDirOf` / `backupPathFor` / `backupCopy` | 三套：`<file>.bak-<ts>`（11 家各自调用）、`backups/<rootDir 的 basename>`、`backups/<变体>` |

**刻意不合并的**（各家宿主事实，合并会写错）：`hostVersion` 兜底值不同；`copyTree` 一个带 filter
一个不带；codex 的 `readText` 解 zstd 而 util 的不解；`ensureProjectRow` / `turnToMessages`
表与格式都不同。null 语义（写侧 `''` / 读侧 `null`）已由 `outputText` 的调用方在取用时决定，
不再是两份实现。

### db 写入一律按「库里实际存在的列」裁剪

宿主的表是「baseline 建表 + 后续 `ALTER TABLE ADD COLUMN`」长出来的，
**我们用的列有一半是后加的**（真机取证 app.asar 内嵌的迁移 SQL）：
WorkBuddy 的 `transport`/`unread`/`thought_level` 就不在 baseline 里 ——
硬编码列名 → 老版本库上 INSERT 整条失败（`index-write-failed`）→ 索引行写不进去
→ 宿主会话列表里看不到这条会话。

规矩：**写侧 INSERT 一律「声明想要的列 → 按 `tableColumns` 过滤 → 拼 SQL」**。
`test/m65` 是棘轮（源码字面量 + 运行时过滤双重断言）。
唯一豁免是 **cline**（自建表，列集由我们自己的 `CLINE_SESSIONS_DDL` 定义）。

---

## 宿主注入约定（本工具自己的写入约定）

以下都是**本程序**写入宿主时的约定，不是宿主的数据规格：宿主的目录 / 表 / 字段见
[`agent-storage.md`](agent-storage.md) 对应变体，代码须与那边对齐。

### 来源标记（provenance）槽位

| 变体 | 本工具写入的来源标记落点 |
| --- | --- |
| claude | 专用行 `type="session-sync-provenance"` + 同名 sidecar |
| pi | 专用行 `type="session-sync/provenance"` + sidecar |
| codex | 顶层专用行 `type="session-sync-provenance"` + sidecar |
| workbuddy-cn / workbuddy-intl | `session-meta` 行的 `meta["session-sync"]` + sidecar |
| qoder-cn / qoder-intl | CLI 明文 jsonl 的专用行；桌面库行的 `extra["session-sync"]` 用于给没带标记的明文副本补齐 |
| zcode | `session_entry` 表 `type='session-sync/provenance'`（`data` 就是本体） |
| mimo | `session.permission` 的 `"session-sync"` 键 |
| minimax | `extra_data_json["session-sync"]` + 规范历史目录里的 sidecar（`messages.jsonl.session-sync.json`）—— 宿主首次物化会话时会用自己的默认值重写 `extra_data_json`、把来源标记槽整个抹掉，sidecar 是活过那次重写的那一份 |
| dsh | 会话目录下 `provenance.session-sync.json` |
| freebuff | `chat-meta.json` 的 `"session-sync"` 键 |
| cline | manifest 的 `metadata["session-sync"]`（读侧两处都认） |
| kilo | 库形态 `session.permission` 的 `"session-sync"` 键；任务目录形态 `task_metadata.json` 的 `"session-sync"` 键 |
| roo | `task_metadata.json` 的 `"session-sync"` 键 |
| codebuddy | sidecar `<id>.jsonl.session-sync.json`（正文里不放宿主不认识的行），落点搬迁时 sidecar 跟随正文一起移动 |

### 覆盖变量：pin 档收哪些

两类变量落 `pin`（判据见 §0 的「它挪不挪得动根」）：

- **本工具自造**（宿主本体不认）：`OPENCODE_DATA_DIR`（只认 `XDG_DATA_HOME`）、`QODER_CN/INTL_REGISTRY_DB`、
  `CODEBUDDY_EXTENSION_DATA/HISTORY/IDE/USER`、`CLINE_TASKS_DIRS`、
  `WORKBUDDY_HOME` / `WORKBUDDY_AI_HOME`（别名，只在官方根变量缺位时兜底）。
- **官方但只覆盖子目录 / 单文件**：`CLINE_SESSION_DATA_DIR`、`CLINE_DB_DATA_DIR`、
  `KILO_DB` / `KILO_DATA_DIR` / `KILO_TASKS_DIRS` / `KILO_TASKS_DIR`、`ROO_TASKS_DIRS`。

宿主官方根变量见 [`agent-storage.md`](agent-storage.md) 各变体 V1；`QODER_CONFIG_DIR` 刻意不跟随
（跟随会让国际版读到 CN 数据），自定义位置改用 `--data-root` 点名。

### 读侧合并策略

- 多库并存全部读：opencode（env 指定的库 + XDG / Roaming 默认库）、mimo（XDG / Roaming / LocalAppData 三处），
  按登记顺序全部打开、按会话 id 合并为一条（正文先到者优先；缺来源标记时从同 id 的其它库补齐）；单个库损坏只跳过它自己。
- 同 id 多副本优先级：qoder **CLI 明文 jsonl > 桌面库**、cline **会话库 > legacy 任务目录**、
  kilo **库 > 任务目录**；多副本 origin 不同时保留优先级高的并在 `list`/`import` 打印冲突。
- codebuddy-ide 多副本（IDE 与插件、多个账号的 Data 下）统一按「消息更多 → 更新时间更晚」选同一份
  （`codebuddyPickBest`），避免 `show`/append 落到另一副本。
- minimax 的正文有**两种载体、两套形状**（文件型 `messages.jsonl` vs 列式 `local_runtime_message_rows`，
  见 [`agent-storage.md`](agent-storage.md) minimax V5）：文件型的工具调用是 assistant 行的 `toolCall` 块、
  回执是**独立 `toolResult` 行**；列式则把回执并进 `tool_calls[]`。两侧的形状映射统一由
  `src/pi-agent-blocks.mjs` 承担（原生行/块 ↔ π 块）；`pi` 与本变体同属 pi-agent runtime、块词汇相同，
  也走这个出口（原先是各自内联解析，属一题多解）。读侧只认这一个出口 ——
  曾经读侧按 π 词表（`tool_use` / `tool_result`）解原生行：`toolCall` 全丢、`toolResult` 行被当成
  助手正文，导入后工具回执显示成一串助手消息。

### 读侧的设计决定

- doubao 只读（写侧取证定案，见 [`agent-storage.md`](agent-storage.md) §22 V7）：侧栏 = 云端 + IndexedDB 缓存，
  本地 `.sessions` 只是 agent 运行时工作区、不是会话注册表；外部写入三处 oracle（GUI / 缓存库 / 启动日志）
  全阴性 → 与 antigravity / cursor 同档，不注册 writer。
- 会话粒度落在 `.sessions/<chatId>`：多 agent 角色目录（`m_` main / `o_` organizer / `s_` subagent）归一为一条会话，
  main 的 trajectory 作主线，其余 agent 只进 `meta.agents` 名册；无 trajectory 的空 agent 目录跳过。
- 首轮用户消息只在 `assignment.md`（不进 trajectory），第 2 轮起两边都有：先解析 assignment 的需求块
  （剥宿主注入块，剥空的块跳过），再按文本与 trajectory 的 user 行去重 —— 未被 trajectory 覆盖的块
  （正常只有首轮）先按块头时间补成用户轮，其余行的时间取匹配块的时间。
- trajectory 三个解码点：`tool_calls[].function.arguments` 已是 JSON 对象（不二次序列化）、
  `role:"tool"` 行按 `tool_call_id` 回填工具名、报错按 `Error:` / `exited with code N` 前缀推断
  `status=error`。行内无时间戳，助手 / 工具项挂前一条用户轮时间（推断值）。
- 读侧显式给 `scope:'none'`（`scopeReason` = `reader`）：agent 模式会话是云端聊天，不是项目会话；
  cwd 取 Preferences 的 `general-agent:new-chat-workspace:<chatId>` 映射，无映射留空。

### 写侧的设计决定

- **轮首附件归位，写在唯一入口**：`src/writers/index.mjs` 的 `getWriter()` 就地包装 `write`，
  对每轮跑 `src/ir.mjs` 的 `normalizeTurnItems` —— 把排在本轮第一条 user 消息之前的 attachment
  挪到它之后。12 家把附件降级成 assistant 侧占位文本的 writer 都依赖「附件不早于用户消息」这个
  输入假设（否则先发一条 assistant 消息 → 读侧多开一轮 → 核心指纹整体平移，真机 2026-11-13
  qoder-cn → workbuddy-cn 的 `verify-failed` 即此）；另 6 家把附件并进 user 侧，本就不受影响。
  收敛在注册表出口，不在 12 个 writer 里各打补丁；`coreItem` 不收附件，挪顺序不改变身份。
  **就地改 `write`、不返回副本**：注册表对象仍是可就地替换方法的那一个（`test/m67` 的
  `repair` mock 依赖它，返回副本会让 mock 失效）。验证：`test/m37-turn-boundary.test.mjs`
  的轮首附件全矩阵（18 个可写目标逐一写入读回）。
- freebuff 目录名用 `targetId` 而不是宿主自己的 ISO 形态（2026-10-27 决定）：宿主列表是
  「目录枚举 + mtime 倒序 + `messageCount>0`」，ISO 只是它自己生成目录的习惯；目录名 = targetId
  才能保住「同一 originKey 幂等落到同一目录、按同一 id 读回」。时间戳改记在 `chat-meta.json` 的
  `createdAt/updatedAt`。若未来实测证明宿主只认 ISO 目录名，替代方案是目录用 ISO + id 存进
  `chat-meta.json`，reader/findExisting 改为按元数据里的 id 匹配（成本高一个量级，需先有实测证据再动）。
- freebuff 项目会话写入时顺带 upsert `<config>/recent-projects.json`（宿主事实见
  [`agent-storage.md`](agent-storage.md) §15 V8）：项目选择器只读这个注册表，只建
  `projects/<project>/` 目录不会进列表。形状按宿主自己的 save：目录在盘上存在才登记、
  `{path, lastOpened}` 按 `path` 去重置顶、上限 10 条、2 空格 JSON；新增条目报
  `project-registered`，目录不存在时不造假条目、告警 `project-unmatched`。
  skip 自愈通道（`ensureIndex`）同样补登记 —— 历史导入复跑即可补齐。
- minimax **导入会话的 `session_type` 必须写 `'branch'`**（`src/writers/minimax.mjs` 的 `LISTABLE`）：
  宿主自己创建的普通对话全是 branch；`'root'` 是 Agent 的**内部主会话**（Main），
  宿主侧栏的 `listInternalDefaultRootIds` 会把「root + conversation + 默认桶（或 Agent 内部默认工作目录）」
  的行从侧栏整体排除 ⇒ 写 `root` 的导入会话**在桌面侧栏整条看不见**（库里有、运行时 `list` 得到、
  侧栏没有；六个列表硬门全过也没用）。
  真机验收 2026-11-23：改成 branch 后侧栏立刻出现。
  skip 自愈通道（`ensureIndex`）会把老版本写出的 `root` 改回 `branch` —— 只修带
  `session-sync` provenance 的行，宿主原生行不动。
- minimax **导入会话必须自己落「规范历史文件」**（`src/writers/minimax.mjs` 的 `writeCanonicalHistory`）：
  目录 = `v2/sessions/<YYYY/MM/DD/HH-mm-ss-mmm-session_<base64url(sessionId)>`（UTC，4 段斜杠，
  与宿主 `utcSessionHistoryRelativeDir` 同形），内容 = `messages.jsonl`（宿主规范信封
  `{message_id, turn_id, message}`）+ `manifest.json`（宿主校验它与行的 sessionId / createdAtMs 一致），
  行的 `history_relative_dir` 直接指过去。
  **不落的后果**：宿主物化器在会话没有 legacy 账本时只发布**空文件**，空文件就是模型上下文的
  唯一来源 ⇒ 导入正文在模型上下文里消失（界面消息列表仍看得到，因为它读 DB 行）。
  落盘失败才退回「只写 DB 行 + 该列留 NULL」（老行为），并在报告里告警。
- minimax **标题搜索文档不预写**：FTS 文档（`local_runtime_sessions_fts`）由宿主在会话首次被
  打开/物化时自己写，写侧预写会占掉宿主下一次分配的 FTS rowid（与
  `local_runtime_session_fts_keys` 的 AUTOINCREMENT 分配必须同步），宿主再建会话就会撞唯一约束。
- minimax **一行 = 一条消息**（宿主的 display message 契约，见 [`agent-storage.md`](agent-storage.md) minimax V6）：
  一轮 IR 按**模型发言**切成若干帧（一帧 = 一段思考 + 若干 (工具调用 + 工具回执) + 可选正文），
  收到工具回执或出现正文即断帧；同一轮里连续的 user 文本块算一条消息（Anthropic 存多块）。
  每帧写一行，行的 `role` 就是**这条消息自己**的角色，同一轮的所有行共享一个 `turn_id`。
  完整部件数组放在 `data_json['session-sync-content']`（块级带 `role`）：宿主不读它，
  但自己必须能靠它**无损**读回 tool_call / tool_result / 附件 ——
  少了它，读回只剩正文，工具调用会在核心指纹里消失 → 往返被判成 fork。
  宿主可见字段（`msg_content` / `thinking_content` / `tool_calls` / `msg_type`）必须等于真相：
  整轮压成一行会让助手正文在宿主里整段消失（实测：63 行全 `role=user`，12.9 万字符回复不可见）。
- minimax **追加进已有 `messages.jsonl` 时按文件型原生形状写**（`src/pi-agent-blocks.mjs` 的
  `toNativeBlock` / `toolResultRowOfBlock`）：assistant 行的块是 `text` / `thinking` / `toolCall`，
  工具回执写成**独立的 `role='toolResult'` 行**（`toolCallId` / `toolName` / `content[]` / `isError`）。
  不许把 π 块（`tool_use` / `tool_result`）写进这个文件 —— 宿主不认这两个块类型，它自己界面里
  那次调用会只剩「发起」没有「结果」。DB 行路径不受此约束：那条路走的是 `tool_calls[]` 原生列。
- minimax **列表的轮次必须与 read 同口径**（`src/readers/minimax.mjs`）：不采样、不标近似 ——
  `list` 与 `read` 读同一份 `messages.jsonl`、用同一套 `assembleTurns` 口径算轮次。
  早先 `list` 走采样（大文件只读头尾），同一个会话 `list` 报 1 轮、`read` 报 67 轮 ——
  用户按 `list` 挑会话、按 0 轮过滤，看到的都是错的数。
- minimax **无原生代际证据的旧格式文件与 DB 行分叉时，读侧以 DB 行为准**（`src/readers/minimax.mjs` 的 `pickBody`）：
  文件优先（照宿主取数链），但**我们写的那几轮在文件里没有**时改用 DB 行 ——
  宿主物化出来的空文件会把导入正文整个遮住（界面消息列表仍看得到，因为它读 DB 行）。
  判据按**内容**（核心指纹）而不是 turn_id：宿主可能用自己的 turn_id 把我们的行重新物化进文件，
  那种情况文件是完整的，按 id 判会把同一轮当成缺失。
- minimax **规范历史文件自愈**（`src/writers/minimax.mjs` 的 `repair`，走 writer 的目标级自愈钩子，
  锁内、决策之前跑）：按已有轮的有序匹配位置补入可验证的缺失轮。有序匹配无法覆盖已经出现的导入轮时，报告歧义，保留现有文件。
  宿主自己写的内容**逐字节保留**（按原始行文本归并，不重新序列化）。
  写前校验文件 size 与 mtime：宿主刚追加过就**放弃这次修复**（不覆盖），下次重跑再试。
  为什么要赶在决策之前：文件被遮住时，读侧看到的会话只有宿主自己的那几轮，
  内容对不上源 → 判成分叉 → 长出重复副本。
- **身份旁证丢失时的决策底线**（`src/import.mjs` 的 `decideWithoutIdentity`）：
  来源标记被宿主抹掉 / 老版本导入没写标记时，只允许「已经在那儿」的结论
  （内容完全一致 → identical；目标是源的超集 → target-ahead），两者都是**不动作**；
  凡是**要往目标里写**的（目标是源的严格前缀 → append、双方分叉 → fork）一律判
  `fork + identity-mismatch` —— 宁可长副本，也不写进身份不明的会话（m4 的底线）。
  归档行只作存在性判定（D1）：哪怕内容一模一样也得另导一条新的（m28）。
  完整表述见 [`identity.md`](identity.md) §4.2。
- MiniMax 当前只做压缩摘要的跨宿主传递。文件侧写成带 `<cb_summary>` 标签的 user 文本块，
  DB 侧靠 `msg_type=3` 与 `session-sync-content` 承载。回读标签或块标记时恢复裸摘要与 `compact:true`，
  再导入支持原生边界的目标可生成该目标的边界。MiniMax 续写侧的原生 `compactionSummary`
  是分段历史的首条记录，当前导入未写入这种历史，reader 也跳过该原生记录。
  读写、校验及存量升级设计见下文「MiniMax 原生压缩实施方案」。
- minimax 的落点目录必须**对齐到宿主已有的项目行**（`src/writers/minimax.mjs` 的
  `resolveWorkspaceDir` / `mergeDuplicateProjects`）：宿主的项目键是字节级目录串
  （`local_runtime_projects.workspace_dir` 上的部分唯一索引 + 触发器回填 `project_id` 时的等值比较），
  源 agent 记的 cwd 大小写与宿主自己记的不一致时照抄就会多出一个项目行 → 侧栏两个同名分组。
  取值顺序：① 宿主**已有的那一串**（精确命中直接用；忽略大小写/分隔符命中则用宿主那串，
  只有宿主自己的串能和它的唯一索引、触发器等值比较对上）→ ② 宿主自己的目录形态
  （见下条「项目键的目录形态」）→ ③ 盘符大写兜底；顺带把同一个目录的历史重复项目行合并掉
  （会话改挂到保留行，不丢会话）。
- **项目键的目录形态**（`src/util.mjs` 的 `canonicalDirPath`）：各家宿主都按「自己记的 cwd」
  现算项目键（slug / md5 / 原串），源 agent 记的写法与宿主不一致时，算出来是**另一个键**
  → 写进另一个目录 → 侧栏两个同名项目。盘符大小写是**每家自己的约定**，不能全局一刀切
  （本机真机实测）：大写 = claude（13/13）、pi（4/4）、minimax、dsh；
  小写 = workbuddy（46/47）、codebuddy-ide（URI 形态 `d:/...`，368 条）；
  其余字母大小写一律不动（宿主记什么就是什么），也不解析 junction/symlink
  （宿主记的是逻辑路径）。由此：claude / pi / workbuddy 的 slug 派生、`codebuddy-ide` 的
  md5 键，都要先过这一层。`codebuddy-ide` 的 md5 不可逆，只能借宿主登记过的
  「md5 → 目录」对照表认领（`resolveCodebuddyWorkspaceKey`）。
- 读侧用宿主原生边界或结构标记识别压缩摘要，兼容已知标签与固定续写提示。按各宿主既有规则
  清理环境注入，再剥压缩外壳。MiniMax 的 `msg_type=3`（SystemEvent）是其存储形态，
  前端仍可能按 `role` 和标签显示用户气泡。
  核心指纹先剥掉包裹标签再哈希（`src/text.mjs` 的 `compactionSummaryText`，在 `src/ir.mjs` 的
  `coreItem` 里**无条件**施加）：同一份摘要的三种宿主表示剥到内层正文才是同一个骨架，
  混排（摘要 + 真实用户文本）两侧也才算出同一核心。
- opencode 的压缩摘要落成宿主**原生压缩边界**：纯压缩轮写 `session_message` 的
  `type='compaction'` / `status='completed'` 行，摘要正文进 `data.summary`
  （`src/writers/opencode.mjs` 的 `turnToEvents`）。宿主把最新一条 completed 摘要当历史边界、
  只读它之后的消息，上下文估算随之变小 —— 写成普通 user 消息的话，超大导入会话续写时
  会被整体压平成一条超模型上下文的请求（网关判输入超长而拒绝）。读侧一条 compaction 行
  还原成**一轮**（`data.summary` 裸正文 + 压缩语义位，`src/readers/opencode.mjs`），`list` 计数同判据。
  混排真实用户文本 / 带附件 / 剥壳后为空 → 兜底普通 user 行。OpenCode v2 在该行的文本字段
  内用摘要标签承载压缩片段，包含无标签的固定续写提示。回读为同轮的多个文本块。这种写法保留语义，但不形成宿主历史截断。
  存量导入的摘要行不改写，要享受边界须删旧目标重导（见 `references/identity.md` 已知边界）。
 - 压缩摘要跨宿主采用**统一归一化**：每跳从当前来源宿主的正文读入，经过 IR 后由目标 writer 落盘。
   读侧把各家原生形态（opencode 原生边界行 / qoder 的
   `isCompactSummary` 结构标记 / workbuddy 的 `<cb_summary>` 标签壳与 `cmp_` 行）剥成
   「裸摘要正文 + 压缩语义位」——正文与语义正交，语义位不进 `coreItem`/`normalizeItem`（指纹只看正文，
   故全链路稳定）；写侧按目标原生形态还原（原生边界行 / 原生标记行 / 带壳行 / SystemEvent），
   正文一字不丢。这样 qoder→workbuddy→qoder 等往返正文逐字不变、压缩语义保留、核心指纹逐轮收敛。
   混排真实文本 / 带附件 / 剥壳后为空的轮走普通 user 行，支持逐块表达的变体保留片段标记。
   未接入目标原生边界写入时，支持标签回读的变体可以用标签保留传播语义。核心指纹一致及读回
   `compact:true` 只能验收本工具的传播结果。原生边界还需验收目标宿主实际恢复的上下文。
- Codex 的公开对话保留 `response_item`，压缩内容块加摘要标签以便读回。纯压缩轮在该用户条目后写原生 `compacted`，`message` 保存裸摘要，`replacement_history` 保存模型续写所用的摘要消息。读侧仅合并紧邻且同时间的标签镜像与其原生边界，相同正文的独立原生边界逐次保留。混排逐块保留语义，不裁掉上下文。原生加密压缩仅记录边界类型和时间，不重放替代历史，也不生成明文摘要。存量裸文本的语义必须由仍持有压缩标记的同源副本恢复。
- WorkBuddy 对完整压缩摘要写原生 `cmp_` 行和 `providerData` 标记，摘要的前驱只走 `logicalParentId`，后续消息从该摘要继续普通父链。混排时仅给压缩内容块加标签，读回逐块识别。原生行同样先按既有规则清理系统注入和冗余空行，再剥壳，保持已导出副本的核心指纹。写后验证双向比较本次写入的用户文本及其有序压缩标记，允许宿主合并相邻同类文本块。
- 多来源导入按原有身份及核心前缀去重。被覆盖副本的压缩标记可补给保留副本，仅限同源、核心前缀仍一致、同轮用户块可按文本顺序一一对齐。执行重新读取并比对来源。存量目标正文相同仍按 `skip` 处理。
- mimo 孤儿 `tool_result`：源侧有回执但同轮找不到调用时，只落一个 `state.input=null` 的 tool 部件，
  读侧不得据此再补一个 `tool_call`（会让核心指纹多一项）。
- workbuddy 项目会话必须写宿主空间归属：`sessions.space_id` 按 cwd 认领已登记且 active 的
  `spaces.id`（路径按统一分隔符/大小写比较，优先 `primary_folder_path`，再
  `create_folder_path`），新建行写入、存量导入行仅在为空时补；认不到保持 NULL（宿主按 legacy 处理），
  宿主原生行与非空归属一律不覆盖。侧栏项目页按 `space_id` 过滤，留 NULL 会出现「正文与索引都在、
  但项目下不显示」。旧版宿主没有 `spaces` 表或 `sessions.space_id` 列时，整段判据按存在性自动跳过，
  写入/自愈行为与修复前完全一致（真机旧形态与端到端回归见 m90）。
- qoder 三层写入：CLI 正文 jsonl + `main.sqlite` 的 `chat_sessions` 行 + `chat_session_messages` 投影；
  旧代 `local.db` 是上一代密文存储，只降级读、不参与写入。
- opencode 自愈：`import --apply` 在写入前对历史导入行做一次性迁移 —— 裸 uuid / `ses_<32hex>`
  改名为原生 Identifier 形态（见下条）、
  project/directory/path 重算、半截 model 清空、assistant 消息补 `agent`/`model`、tool 部件补
  `time`/规范 `state`、`event_sequence` 计数器补登记到该会话已占用的最大 seq、
  assistant 消息补 `finish`（宿主缺 `finish` 即判该回复「被截断」，续写时末尾内容块不重放、
  尾部 reasoning 被丢弃）、tool 部件补 `executed: false` 与 `time.ran`、
  占位 `model.providerID`（`session-sync`）换成宿主真实 ref（含 `variant`）、reasoning 部件补
  `native` 包裹与 `time`、assistant 补 `rawFinish`/`cost`/`tokens`/`time.streamed` 同形字段、
  带 provenance 的行 `version` 对齐宿主版本（无 metadata 的行保留 `session-sync/1` 识别标记）。
  原生会话（无来源标记）永不触碰。
- opencode 的 user 附件必须是宿主 `Prompt.FileAttachment`（`data` Base64、`mime`、
   `source:{type:'inline'}|{type:'uri',uri}`）：近似形状会让整条消息解码失败，打开会话 500。
   写侧（`turnToEvents`）按引用取字节：本地图片读成 Base64 走 inline，本地其它文件走
   `source.uri` + `data`；远端 URL / 不可读或超大文件用 `data:''` + `mime:'application/octet-stream'`
   + `source.uri` 兜底（空 Base64 合法，且不会被当成空图片重放）。历史坏行（ `{url,type:'file'}` ）
   在自愈侧 `repairMessageData` 里按同一口径改写；读侧优先从 `source.uri` 还原引用，兼容历史 `url`。
   验证见 m89。
- opencode 会话 ID 必须是宿主原生 Identifier 形态（`ses_`+12hex 降序时间戳+14base62，共 26 位）：
  本地 schema 只校验 `ses` 前缀，`ses_<32hex>` 能过本地校验、列表也显示，但 **Zen 网关续写时
  回 `FreeUsageLimitError(429)`**——与真实配额、历史体量、provenance、model 均无关（真机交叉
  实验：同一时刻原生格式 id 成功、32hex 失败；截断到 1 条小消息仍失败；len26 但前缀全 0 也失败）。
  派生 id = `ses_`+降序12hex(源 `createdAt`)+14base62(originKey 哈希)：前缀可解回 sane 时间戳、
  后缀确定性 → 去重不变量保留。自愈把存量非原生 id 的导入行迁移到该派生 id（消息 `session_id`、
  `event_sequence.aggregate_id` 随迁，不留孤儿计数器）；读侧 list/read 对迁移前的旧行也按同一
  派生 id 暴露/回退，保证修复前后 plan 命中同一条。回归见 m87。
- opencode 写消息必须同时登记 `event_sequence` 计数器：宿主按这一行分配后续消息的 seq
  （读不到行就当 `-1`，下一个 seq 从 0 开始）。导入的消息已占用 0..N 而计数器缺位时，
  宿主会分配出与已有行重复的 seq → 撞 `(session_id, seq)` 唯一索引 → 该会话再也续写不了。
  登记值取该会话已占用的最大 seq；计数器只进不退（宿主已推进的值不拉低）。
- opencode 写出的消息必须带宿主判定「回复是否完整」的那几个字段：assistant 消息带 `finish`
  （以工具调用收尾 → `tool-calls`，以文本收尾 → `stop`），工具部件带 `executed: false`
  与 `time.ran`。宿主缺 `finish` 一律把该回复当成被截断的流（末尾内容块不重放、尾部
  reasoning 丢弃）；缺 `executed`/`ran` 则工具在回放时缺少「已执行」的证据。
- opencode 导入的 reasoning 必须带 provider 原生包裹，否则续写时被网关丢弃（上游
  `to-llm-message.ts` 实证）：`sameModel = message.model.providerID === model.providerID &&
  message.model.id === model.id`，true 时 reasoning 发 `providerMetadata={opencode: item.native}`
  → 适配器输出 `reasoning`+`reasoning_details`；false 时只发 `{type,text}` → 降级成
  `reasoning_content` → Zen 网关整段丢弃。两条缺一不可：① assistant `model.providerID` 写宿主
  真实 provider（`opencode`，占位 `session-sync` 会判 false）；② reasoning 部件带
  `native={reasoningField:'reasoning', reasoningDetails:[{type:'reasoning.text', text, format:'unknown', index:0}]}`
  （缺它即便 provider 对，`providerMetadata(key, undefined)=undefined` 仍降级）。写入侧
  `turnToEvents` 与自愈侧 `repairMessageData` 都补。读侧 IR 不读 `native`/统计字段，补齐不改核心指纹
  （收敛安全）。验证：`test/m86-opencode-reasoning-native.test.mjs`（含 red-green 取证）。
- codex 注册表 `.codex-global-state.json` 读-改-写 + 备份 + 保留未知键；正文可能是 `.jsonl` 或
  宿主压缩过的 `.jsonl.zst`，追加时按 id 找回原文件，`.zst` 走「整帧解压 → 追加 → 重新压成一帧 → 原子替换」。
- codex 导入会话写入宿主可读的 `session_meta`，用 `event_msg/task_started`、`task_complete` 和
  `user_message`、`agent_message` 生成 legacy 回放。原有 `response_item` 继续保存消息、推理和工具历史，
  也是 session-sync 读回和指纹的正文来源。新建时登记 `threads` 索引行和 `title`，保留宿主手动改名使用的 `name`。
  重导旧版已写入的会话时，在目标锁内修复缺失的会话头、回放和索引。修复只作用于带 session-sync 来源标记的目标，
  按轮核对回放事件是否齐全，保留已有原生事件。正文写入前留备份，并在原子替换前再次校验文件状态。线程索引标题统一使用目标标题容量。复跑以同一 ID 收敛，归档和宿主原生会话不进入此自愈路径。
- codex 注册表的**路径提示两键按账户分区**：宿主把 `thread-workspace-root-hints` 与
  `thread-projectless-output-directories` 放在 `electron-owner-value:<key>:<ownerId>` 下，顶层裸键**读不到**
  （宿主的 storageKey→a6 只解析 owner 空间键，写顶层等于写死数据）。写侧据此定位 owner 空间：
  ownerId 取注册表里的 `electron-renderer-content-owner`；取不到就用注册表里**唯一**的 owner 空间；
  多个 owner 空间又没标记当前账户 → 不猜，退回顶层旧键并告警 `registry-owner-unresolved`
  （新版本体可能不显示 —— 宁可如实报，也不写进身份不明的空间）。
  `projectless-thread-ids` / `thread-project-assignments` / `local-projects` 宿主仍留在顶层，不动。
- codebuddy-ide：append 进已有会话不再注入 `<user_info>`，首条消息的 Workspace Folder 只在搬迁时改写；
  relocate 先把会话目录备份到 `<home>/.session-sync/backups/codebuddy-ide/`。
- codebuddy-ide 写哪一份 history（`resolveHistoryRoot`）按档位定：钉住 `CODEBUDDY_EXTENSION_HISTORY` > `--account` 命中的账号坐标 > 本机唯一账号坐标（指定账号没有目录时告警 `account-root-unmatched`，不擅自改道、写进唯一那份）> 多账号并存且没点名 → `account-ambiguous`，**一个字节都不写**，让用户先用 `accounts` 看 uid 再点名 > 一个坐标都没有（本机从没开过这个 IDE）→ 按 user/ide 坐标派生。已撤掉「按 mtime 谁最近被改过挑账号」的旧口径：活动度只解释在用情况，不决定该写哪儿，冷账号会被挤掉，用户以为导进了 B、实际写进了 A。
- claude 的 `parentUuid` 线性续接，断链会导致会话打不开（宿主 oracle 待取证）。
- 同族双份守卫（`edition-duplicate`）：中英版共用派生命名空间（`identity.UUID_FAMILY`），同一
  originKey 在两版得到**同一个会话 id**，所以「写错版本」不会报错，只会在另一版再存一份，
  两份各自看起来都正常、事后无从判定哪份是真的（本机现场：同一来源在 `.workbuddy` 里 12653 行、
  在 `.workbuddy-ai` 里 139 行）。因此写入动作是 create/fork 时先按同族另一版的派生 id 查一次，
  命中即中止该条并给出那份的路径与轮数，绕过只许显式 `--allow-family-duplicate`；
  目标自己已有这条时照旧走 skip/append，不进这道门。
- qoder 旧代 `local.db` 只能读元数据（正文密文），`import` 计 `degradedSkipped` 并跳过（`--include-degraded` 才导，内容为占位说明）；现行三层写入不含这一代。
- freebuff 宿主无 skill 机制：`install` 会在项目 `.agents/` 生成 TS 薄封装模板，不写宿主自己的技能目录。
- kilo 写侧判代际：`kilo.db` 存在 → 只写库（不再产出任务目录）；否则写任务目录 + `taskHistory` 索引。旧版机器走旧契约、升级后自动切到库。两代存储都不在**且配置根也不在**时是第三态 `kilo-store-absent` —— 那是「这家没装」而不是「要新建」，只有这一态让 `canWrite` 返回 false，前两态照常写。
- opencode v1 库不可写（会报 `session_v2-missing`）：可写性矩阵里的 opencode 指 v2 schema 的库；v1 形态只作读侧兼容。
- 写前备份、复合键 WHERE、db 写入按实际列裁剪、标题单一通道等统一机制见 §0.5 / §0.6。
- 多形态产品（cline / kilo / codebuddy / qoder 等）写哪一份：按 [`environment.md`](environment.md) §4.1 的顺序定 ——
  **用户明示 > 调用本 skill 的 agent 的形态 > 目标产品唯一形态 > 报 `form-ambiguous`**；
  不写多份（幂等与去重会失效），也不按 mtime 挑一份（见 R6）。当前只判变体、未判形态，判不出时不要猜。

### 形态 → 落点 → 读写覆盖（B 映射层）

`role` 是**落点职责**（变体内的读写契约槽位），不是形态、也不是根别名：写侧按 role 取根，读侧按 role 过滤。
形态只决定「存在哪些 role」，不决定 role 叫什么——反例：minimax 的 `db` 与 `history` 同属 CLI 形态，`codebuddy-ide` 的 `data` 同时覆盖 IDE 与插件。
下表只列**形态改变落点**的产品（其余产品桌面与 CLI 共用一个根，见
[`agent-storage.md`](agent-storage.md) 的「变体形态矩阵」）。

证据口径同 agent-storage.md 的四态，但本文不写方括号标记（职责纯净：状态标记只属于宿主规格）。

| 产品 | 形态 | role | 根 | 读 | 写 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| antigravity | cli | sessions | `~/.gemini/antigravity-cli/` | ✅ | ❌ | CLI 正文库可读；侧栏由 Hub 摘要库决定，写 CLI 不会出现在 Hub |
| antigravity | ide-plugin | ide | `~/.gemini/antigravity-ide/` | ✅ | ❌ | 仅旧加密 `.pb`（读侧跳过）；独立 IDE 安装目录为空 |
| antigravity | desktop | hub | `~/.gemini/antigravity/` | ✅ | ✅ | Hub 活库：`conversations/<id>.db` + `conversation_summaries.db` 双写 |
| codex | cli | sessions | `~/.codex/` | ✅ | ✅ | 归档目录用 `archive` role、只读不写（不进导入候选）；判定不再靠目录名 |
| codex | ide-plugin | 未声明 | 未取证 | ❌ | ❌ | 是否复用 `~/.codex/` 待证（待证-codex-3） |
| codex | desktop | 未声明 | 未取证 | ❌ | ❌ | 已证实桌面端与 CLI 同根（`~/.codex/`），但该形态尚未接入本程序 |
| codebuddy | cli | projects | `~/.codebuddy/projects/` | ✅ | ✅ | 写侧已改走 `writeRootOf`，搬根后不再写回默认位置 |
| codebuddy | ide-plugin | data | `%LOCALAPPDATA%/CodeBuddyExtension/Data/` | ✅ | ✅ | 扩展缓存结构，含账号分区 |
| qoder | desktop | registry | `%APPDATA%/com.qoder*.app.stable/main.sqlite` | ✅ | ✅ | 写入含 `chat_sessions` 与消息投影 |
| qoder | cli | cliProjects | `~/.qoder*/projects/` | ✅ | ✅ | 明文 jsonl 正文 |
| cline | ide-plugin | tasks | `<IDE>/User/globalStorage/saoudrizwan.claude-dev/tasks/` | ✅ | ❌ | 写侧固定写 `data/sessions`，IDE 形态看不到导入结果（已知缺口） |
| cline | cli | sessions + sessionsIndex | `~/.cline/data/sessions/` + `data/db/sessions.db` | ✅ | ✅ | 4.x CLI 会话库 |
| kilo | ide-plugin | tasks | `<IDE>/User/globalStorage/kilocode.kilo-code/tasks/` | ✅ | 条件 | 写侧按 `kilo.db` 是否存在分派 |
| kilo | cli | db | `~/.kilo/kilo.db` | ✅ | 条件 | 同上：有库写库，无库写任务目录 |

**role 覆盖**：21 个变体已全部声明 role（原先只有 6 个）。仍标「未声明」的行是**该形态尚未接入**（codex 的扩展/桌面），不是漏标；antigravity 三形态已分别声明 sessions / ide / hub。

**已知的写覆盖缺口**：cline 的 IDE 插件形态读得到、写不到（写侧落点固定为 CLI 三代会话库）。
用户若在 IDE 形态下工作，导入后侧栏看不到结果——这不是 bug，是尚未接入；按 §4.1 的策略如实告知，不要假装成功。


### role 接线后的预期行为变化

本轮把 writer 的取根从「按 kind 取第一个」改成「按 role 取」，有两处**有意**的行为变化（不是回归）：

- **zcode 正文库**：旧实现用 `firstExisting(all files)`，`v2/tasks-index.sqlite`（aux）可能被当成正文库；
  现在只认 `db` role。库里没有 `cli/db/db.sqlite` 时，行为从「写错库」变为 `db-not-found`（失败暴露，不兜底）。
- **codebuddy 写侧**：旧实现直连 `codebuddyProjectsRoot`，`--data-root` / 探测把根搬走后仍写回默认位置；
  现在走 `writeRootOf('codebuddy','projects')`，会写到搬走后的根。默认与 env 档下路径不变。

**已知分叉（未修，已登记）**：`writeGate` 只看全局最优根（偏好已存在的目录），而 writer 按 role 取根。
kilo 同时存在 `kilo.db` 与 `~/.kilo/tasks` 时，门会指向 `tasks`、实际写入 `kilo.db`。
这是既有问题（门从不看 role），本轮不改；`test/m77` 用债表把它钉住，新增分叉会红。

### role 词表（落点职责）

一个 role 必须具备三件事：**kind 闭集**、**消费者**（谁按它取根）、**文档登记**。
没有消费者的 role 一律不许存在——`derivedCache` 就是反例（已删除，降级为 note）。

| role | kind | 基数 | 职责 | 消费者 |
| --- | --- | --- | --- | --- |
| projects | dir | many | 项目分目录正文 | claude / codebuddy / workbuddy-cn / workbuddy-intl / freebuff 读写 |
| sessions | dir | many | 会话 ID 分目录正文 | cline / pi / dsh / antigravity / cursor / codex / doubao 读 |
| hub | dir | one | 桌面 Hub 活库（每会话一 SQLite + 侧栏摘要库） | antigravity 读写 |
| ide | dir | one | 独立安装的 IDE 数据根（旧加密 .pb，正文跳过） | antigravity 读 |
| backup | dir | one | 升级备份（与 IDE 同 ID 的旧 .pb，正文跳过） | antigravity 读 |
| tasks | dir | many | Cline 血统任务三件套 | cline / kilo / roo 读写 |
| sessionsIndex | file | one | 会话列表索引库 | cline / workbuddy-cn / workbuddy-intl 写 |
| db | file | many | 单文件式正文库 | opencode / mimo / kilo / zcode / cursor / minimax 读写 |
| registry | file | one | 桌面注册表（元数据 + 投影） | qoder-cn / qoder-intl 读写 |
| cliProjects | dir | one | CLI 正文目录（桌面注册表之外的明文正文） | qoder-cn / qoder-intl 读写 |
| history | dir | one | 文件型历史目录 | minimax 读写 |
| data | dir | one | 插件数据根 | codebuddy-ide 读写 |
| archive | dir | one | 归档正文（不进导入候选） | codex 读 |
| cwdMap | dir | one | 会话 → cwd 映射 | cursor 读 |
| aux | file/dir | many | 写侧平行库 | zcode 读写 |

### 写侧宿主 oracle 的验收 backlog

9 条写侧宿主 oracle 与 1 条 slug 待证项，连同建议取证方式与可复跑脚本，
登记在 [`agent-storage.md`](agent-storage.md) 的「待证项清单」「真机取证脚本清单」，本文件不重复列。

## MiniMax 原生压缩实施方案

每一跳从当前来源的原生载体读取。MiniMax 同时提供两个视图。跨宿主同步使用按顺序重建的可移植历史，MiniMax 续写使用活动段中的原生摘要和保留消息。两个视图须从同一次写入独立验证。

读侧以活动首条和父快照引用确定可达范围，检测到代际结构后禁止退回 SQLite 显示投影推断缺轮。损坏的代际历史返回可诊断状态，禁止参与自动导入判断。代际语义 revision 按 MiniMax 的递归键排序 JSON 计算，与现有核心指纹各自独立。相邻代保留记录按宿主消息 ID 及载荷对齐，首次出现的位置决定同步顺序。跨代未验证的结构应保留已读取的内容并明确报告缺损。

原生写入通过两种探针启用。隔离探针通过显式环境变量 `SESSION_SYNC_MINIMAX_NATIVE=1` 选择，并要求把目标根指向隔离目录。真机探针仅在默认数据根中新建单条独立的合成会话。它按随机探针编号派生会话 ID，使用同一原生发布事务，在 SQLite 索引可见前完成正文发布和回读。已存在的会话只能由隔离探针修改原生代际文件。普通导入使用标签兼容写入。

MiniMax 写入器在非项目会话未传入工作区时，按最终目标 ID 复用非项目落点规则并创建目录。写入 `workspace_dir`、`project_workspace_dir` 与 `record_json.workspaceDir`，项目归属仍是默认组。追加未指定工作区时保留目标已有目录。索引自愈只对有来源标记的默认组会话补齐缺失的运行工作目录，沿用目标 ID、正文和压缩代。真机验收须实际发起续写，侧栏能打开或正文扫描通过不能代替 AgentHost 续写检查。

原生摘要可以接同轮的助手回复和工具记录。一个源轮需要包含单个、位于首条用户记录中的独立摘要块，才能用一个原生段首保留原有核心内容与组轮。多个摘要块或摘要与普通用户正文混排时保留原块边界并标明降级。

原生压缩快照须满足 MiniMax 的工具调用与回执顺序。写入时用同轮的真实回执配对。源端未记录回执时，生成明确的失败占位回执，读回 IR 时滤掉该占位，以保留原调用和原始核心指纹。无法可靠配对的孤儿或重复回执拒绝原生发布。

原生写入在活动文件切换前写入含旧、新 revision 的恢复记录。在 SQLite 会话索引提交前回读正文并核对核心指纹及压缩语义。SQLite 与会话索引同事务提交新 revision。重跑根据该提交标记保留已提交的活动文件或恢复上一版，发现第三个 revision 时报告冲突。未被引用的快照由读侧跳过。发布待恢复时，普通读取会标明历史未完成，相关会话不参加去重和差异写入。

对新建会话预发布的普通或原生规范历史，写入器回读验证后在同一索引事务内补宿主物化登记，使用 `source='empty'`、活动文件记录数及语义 revision。原生发布事务也在发布时补齐缺失登记。保留已有宿主登记，缺表的旧版本沿用原路径。宿主登记用于启动续写，本程序的 `session_sync_history_commits` 用于恢复中断的发布。

已有原生导入可通过定点压缩修复补物化登记。它要求完整可达的活动链、可用工作区、导入来源及与活动文件一致的本程序发布 revision。预览只检查条件。应用仅插入缺失的宿主登记，保留正文文件、快照、来源与核心指纹。

外部助手消息在 MiniMax 规范文件中显式写入 `provider: 'session-sync'`，供宿主按跨模型历史回放。该字段属于宿主载荷，来源沿用原有 provenance，核心指纹继续取消息内容。对旧原生导入，定点修复可在已验证的发布前缀内补缺失的助手 `provider`。宿主追加后的前缀验证优先使用发布记录，旧发布记录可使用同 revision 的首次物化记录。修复复用原生发布恢复事务，回读校验来源及核心指纹。既有快照与新写入的宿主尾部保持原样。

默认数据根的探针通过桌面「继续」、新输入和再次手动压缩。代 2 的回读保留首次导入的 3 轮核心指纹。以代 1 快照为压缩前基线，前 5 轮核心指纹一致，新增第 6 轮为宿主原生摘要。从真实 MiniMax 源回读并导入测试目标 Codex，再回到测试目标 WorkBuddy，6 轮核心指纹及第 2、6 轮的压缩语义均保留，WorkBuddy 命中原始会话并追加 1 轮。重复导入跳过。探针按有序记录前缀核对续写，包含并入原末轮的助手消息。正式启用前须验收新运行实例对已有压缩代的续写。

### 1. 读取与重建

父快照尚存而活动文件缺失、为空或丢失边界时，报告历史缺损。确认回滚的发布清理自身未引用的快照。损坏的同源分支不妨碍健康目标的精确只读匹配。计划将源历史读取错误同时纳入 pair 和顶层错误，文本与 JSON 状态一致。

- 先区分没有代际标志的旧格式、合法活动代和缺损代际历史。活动文件缺失但仍有快照时，标记历史不完整并阻止写入。由活动首条的父指针逐代验证文件名、宿主语义 revision、记录形状和有序身份。catalog 和 locator 可辅助检查，其是否为必需投影按宿主取证结果确定。读取期间复查活动代及 revision，遇到并发更改时重读。
- 从最早的可达快照开始，逐代接回活动历史。上一代保留到下一代的记录按 `message_id`、规范载荷及相对顺序对齐，每条保留记录只进入同步视图一次。同文而 ID 不同的记录保留出现次数与顺序。原生压缩摘要按各代的交接位置进入同步视图一次。工具回执与调用按同一存储记录对齐后再组轮。覆盖区内保留的记录、当前用户尾部及宿主预览记录的精确位置，以多代真机样本固定为回归测试。回退或分叉时从新活动首条重算可达链。
- MiniMax 结构化摘要按宿主解析规则区分摘要正文和尾部运行状态。裸正文以 `compact:true` 进入 IR。只拆除能通过相应版本校验的附录。MiniMax 专属的记录 ID、代号、revision 和运行状态留作本宿主元数据。兼容旧标签和已取证的旧式结构化边界，按明确的记录/部件对应关系合并同一摘要的多种表示。
- `list`、`read`、`verify` 与 repair 共享历史状态和组轮口径。找不到父代或校验失败时，报告可读范围和缺损原因，预览仍可展示已验证部分，计划拒绝将其当作完整历史作自动写入。可恢复的旧格式 DB 行按有序轮次和出现次数对齐后补齐。存在原生代际历史时，repair 对照完整可达链判断缺失，修复范围由已验证的提交记录确定。历史快照里的轮次属于完整历史，活动段允许缺席这些轮次。

### 2. 写入与存量升级

替换或恢复既有原生文件均受隔离探针门槛约束。经验证的 SQLite 登记可独立补齐。物化登记核对宿主必需列，不兼容时报告明确原因。发布记录同时保存活动记录数和 revision，验证后才定位已导入前缀。旧发布记录可用同 revision 的首次物化登记证明前缀。

- 对独立、非空的纯摘要，按源 IR 顺序建立代际链。例：源为 `前史 → 摘要 A → 中段 → 摘要 B → 续写`，生成代 0 快照 `前史`、代 1 快照 `原生摘要 A + 中段`、活动代 2 `原生摘要 B + 续写`。每代首条至多一个原生边界，前代快照的 revision 写入新代父指针。保留尾部只使用来源提供的可验证位置，单纯的时间戳或摘要文字不足以证明覆盖范围。混排、附件、空摘要及无可移植正文的压缩按既有降级契约保留可恢复内容，报告未形成原生边界的轮次及原因。
- 优先验证是否存在可从工具调用的宿主提交入口。现有内部 `compact` 仅证明宿主实现了该操作。若无法调用，针对已验证的宿主版本实现离线发布：按宿主契约生成并验证父快照、活动段和所需投影，再切换活动文件。宿主语义 revision 与本工具核心指纹分别计算。事务跨 SQLite 和文件时，保存以目标会话与预期 revision 标识的提交记录，使中断可恢复。覆盖前重验宿主状态。不具备共享锁或受支持的提交接口时，仅在确认宿主离线后发布。
- `create` / `fork` 建独立历史和投影。`append` 沿用原会话，新增普通轮只更新活动代与所需投影，遇新纯摘要则发布下一代并保留前代。现有目标的完整历史及原始来源均参与前缀比较。保留 DB 与 sidecar 的 provenance 槽位，在宿主压缩、重启及重写 DB 后核对来源和链路。原生 MiniMax 会话以自身 ID 为 origin，追加不改归属。
- 旧标签继续可读。存量升级采用显式、按会话执行的 repair。默认同步仍按原来的 `skip` / `append` / `fork` 判据行事。升级前核对来源、摘要位置、完整前缀及目标 revision，保全宿主后来追加的记录。升级后沿用目标 ID，回读完整历史与摘要语义再提交成功。位置无法证明的缺损历史、分叉和无来源标记的会话进入诊断结果。

### 3. 身份与 n:n 验收

- 保持现有核心指纹版本及 origin 派生。逐轮检查有序核心指纹、摘要所在轮和块位置、裸摘要、顺序、重复次数、附件与工具配对。压缩语义和原生形状独立报告。含 `compact:true` 的标签回读属于语义验收。原生验收还需校验活动首条、可达链与宿主下一次模型请求。
- 自动矩阵覆盖 MiniMax 作为源及目标，与所有相关可读/可写变体各自的压缩能力匹配。支持原生边界的目标验证原生形状，支持标签传递的目标验证语义保留，不能表达时记录明确的降级。重点测直接与经 MiniMax 到达目标的会话 ID 一致、回到原宿主只补新增轮、连续复跑命中 `skip`、分歧命中稳定 `fork`。另测纯摘要、混排和附件、同文多次、多代、缺快照、旧标签、并发追加和每个发布点中断。
- 用隔离会话覆盖宿主自己产生的两次以上压缩、带保留记录、回退和分叉，再跑 `WorkBuddy → MiniMax → Codex/OpenCode → WorkBuddy` 和 `MiniMax 原生压缩 → 其他宿主 → MiniMax`。真机续写探针使用当前登录的桌面实例和真实数据根。用每轮独立的合成标记核对活动摘要、保留尾部和覆盖前史。实际请求存在可观测证据时核对发送内容，模型复述只作为行为证据。重启后复核可继续、可再压缩、可导出。用原问题会话的隔离备份逐轮比对被记录的摘要及曾丢失的轮次。
- 实施顺序为宿主取证与脱敏样本、只读解析及关闭错误补写路径、原生 create/fork、增量和失效恢复、存量升级、自动矩阵及真机续写。每阶段先补相应规格和回归样本。形成原生边界的能力按宿主兼容性及真机续写结果启用。

---

## 可写性汇总

| 可写（19） | 只读（2） |
| --- | --- |
| claude、pi、codex、codebuddy、codebuddy-ide、workbuddy-cn、workbuddy-intl、opencode、mimo、dsh、freebuff、cline、kilo、roo、zcode、minimax、qoder-cn、qoder-intl、antigravity | cursor、doubao |

zcode / minimax 本轮由只读转为可写，取证结论见 [`agent-storage.md`](agent-storage.md) 对应变体。
`roo` 按**代码实际**登记为可写（与 cline/kilo 共用 `createClineFamilyWriter`，也在 18 目标矩阵里），
但本机没有任何宿主内成功样本（任务索引为空、宿主版本已停更）—— 计划 D5 原本要求它保持只读，
代码并未按 D5 收敛，此处如实记录这处偏离，不以文档掩盖。

---

## 项目 vs 非项目：各家落点与判据

**落点只决定「写到哪、宿主能不能把它列成非项目会话」，绝不参与「是不是同一条会话」。**
身份由 `originKey` + 轮次指纹唯一决定，所以改落点只会移动同一个 targetId。

桶的三种形态（`NON_PROJECT_BUCKET`）：

| 形态 | 含义 | 变体 |
| --- | --- | --- |
| `generated` | 每会话一个互不重叠的子目录 | codex `<桶根>/<源日期>/<slug(targetId)>`、workbuddy `<home>/WorkBuddy[ AI]/<hyphen6>`、minimax `~/.minimax/sessions/<id>/workspace`（键是 ID 不含日期）、mimo `~/XiaomiMiMoProjects/.mimo-sessions/<Y>/<M>/<D>/<slug>`、qoder `~/Documents/Qoder[CN]/<源日期>/<targetId 前 12>`（与现网 12 hex 叶子同形） |
| `shared` | 所有非项目会话共用一个固定目录（搬迁只改归属字段，绝不 move 目录） | zcode `~/.zcode/workspace/default`、dsh `~/Documents/deepseek-harness/default-workspace`、opencode `bucketRoot = home` |
| `none` | 宿主结构上没有非项目落点 → 不兜底、不造目录，标 `requires-cwd` 让调用方补 `--cwd` | claude、codebuddy、codebuddy-ide、pi、antigravity、cursor、cline、kilo、roo、freebuff、doubao |

各家判据（宿主侧实测依据见 [`agent-storage.md`](agent-storage.md) 对应变体 V8；`--limit`/`--json` 里对应 `scope` / `scopeReason`）：

| 变体 | 判为非项目的依据 | 账户来源 / 能否切账号 |
| --- | --- | --- |
| codex | `session_meta` 无 `git` 键（105/105 一致），或 cwd 命中 `~/Documents/Codex` | `creator_user_id` / `creator_account_id`（线程库 `threads` 两列 + rollout 首行同名字段）。**可切**：两处一起翻；`local-projects` 注册表按安装共享，与账号无关。导入时这两列取 `<CODEX_HOME>/auth.json` 的当前登录（读不到就留 NULL，与宿主自己那 314/356 行同形），**不会**写来源会话的账号。宿主列表是否按它过滤仍**未取证** |
| codebuddy | 会话行没有 `cwd`（通用 empty-cwd 兜底）→ 非项目；CLI 只有 `projects/<slug>`，没有非项目桶 | 有登录态（`~/.codebuddy/inspiration/<uid>/` 与 workbuddy 同源 uid），但会话行不带归属 → **不可切** |
| codebuddy-ide | cwd 来自首条 user 文本的 `<user_info> Workspace Folder`（缺失时 md5→工作区索引反查）；cwd 为空（通用 empty-cwd 兜底）→ 非项目；宿主没有非项目桶（`none`），导入要 `--cwd` | **账号 = 目录层** `Data/<user>/<ide>/<uid>/`。**可切**，且这是唯一「项目也按账号分区」的宿主：`history/<md5(项目路径)>/` 与 `check-point`/`file-tree`/`plan-task` 同坐标平行目录都在账号目录内，实测两账号的 md5 集合几乎不相交 → 切换必须顺带补项目。当前登录 uid 本机无可信落点，`accounts` 固定报 `current: null` |
| workbuddy | ① 先看 cwd 形态是否命中 `<home>/WorkBuddy[ AI]*/<四种代际叶子>`；② `is_playground=1` 只作新版辅助（旧代不可靠：compact14 代 17 置位 / 67 未置位） | `sessions.user_id`；**当前登录 uid 的唯一权威来源是 `<root>/storage/skeleton/account-snapshot.json → primary.uid`**。**可切**（改列）。`workspaces`/`workspace_trust_decisions`/`projects/<slug>` 按安装共享，不需补项目；intl 实测两账号行并存（124 + 10） |
| minimax | `is_default_workspace=1` / `project_kind='default'` | 有登录态（`~/.minimax/local-runtime.auth.json → realUserID`、leveldb `UNIQUE_USER_ID`），`local_runtime_sessions` 无账号列 → **不可切**；唯一按账号键控的是项目显示别名 `mavis.remote-control.project-aliases.v1:<account>` |
| dsh | cwd 在 `defaultWorkspaceId` 指向的目录下（`~/.dsh/storages/workspace.json`） | `~/.dsh/.credentials.yaml` 的 refs 有 6 个具名账号引用，但那是**多供应商凭据池**（谁付费），会话体解出来无账号字段 → **不可切** |
| mimo | 优先库内信号 `session.project_id='global'`（与 `directory LIKE '%XiaomiMiMoProjects%'` 实测 16/16 重合，目录前缀只作兜底） | 库内 `account`/`account_state` 表存在（实测 0 行），桌面登录在 `%APPDATA%/Xiaomi MiMo/xiaomi-last-confirmed.json → userId`；`session`/`project` 无账号列 → **不可切** |
| zcode | `directory` 命中 `~/.zcode/workspace` 或 `~/ZCodeProject`（CLI 库没有 project 表、无 git 信号，目录是唯一判据） | 登录在 `~/.zcode/v2/credentials.json`（含按账号 uid 键控的 `project-key-location:v1:[…,<uid>,…,team]`）；`tasks` 按 `workspace_key` 分组、无账号列（`hosts.membership_id` 槽位本机为 NULL）→ **不可切** |
| qoder | jsonl 首行 `workspace-directories` + 逐行 `cwd`；`project_uri` 为空也算 | 登录态确凿（`account_profiles`、`qoder-data.v1.ext.json` 的 `.accounts` 两份档案、`~/.qoder-cn/.models/<account-uuid>/` 按账号目录），但**现行注册表 `chat_sessions` 没有账号列**（实测百余行，`owner_session_id` 全空、`registration_json` 全 NULL），`workspaces` 也没有 → **不可切**。带 `user_id` 的是上一代 `%APPDATA%/QoderCN/SharedClientCache/cache/db/local.db`（数十行同一 uid，mtime 停在 2026-10-15 已不再被写），读侧只在它存在时用它补账号 |
| cline/roo | 任务目录里没有 cwd（读回恒为空）→ 一律非项目 | 无 |
| kilo | 「非项目」= 记录 `workspace:""`（空 workspace 跨工作区可见），不是目录概念 | 无（`workspace` 字段是目录，不是账号） |
| claude / pi / antigravity / cursor / freebuff | cwd 非空且不是各家内部路径 → 项目；空 → 非项目。**五家均实测无桶**：claude `default` 0 命中、pi `--default--` 0 命中、cursor 列表源是 `state.vscdb` KV、antigravity `<uuid>.db` 平铺且 3/5 条 `cwd=''` | freebuff 有 `~/.config/manicode/credentials.json`（profile→id/email）但会话无归属列 → 不可切；其余四家未发现账号身份落点 |
| doubao | reader 显式信号 `scope='none'`（agent 模式会话是云端聊天；cwd 来自 Preferences 的 workspace 映射，无映射留空）→ 一律非项目 | 云端账号；本地 `.sessions` 树无账号维度 → **不可切**（当前账号 uid 的读取来源待证，见 agent-storage §22 V2） |

读侧一律**不按账户过滤**（全量导入），写侧统一归目标宿主当前登录账号。
「有登录态」与「会话按账号分区」是两件事，决定 `switch-account` 能不能做的只有后者：
逐家的取证路径写在 `src/accounts.mjs` 的 `ACCOUNT_MODEL`，现查用 `session-sync accounts`，
可切名单由 `test/m52` 与该表双向锁定（曾经因为扫描深度参数写错，把三层深的库整批漏扫成「没有账号概念」）。
注册表类名单（如 codex 的 `projectless-thread-ids`）里挂着的会话**不能拿来改判**——
那是「未挂到侧栏项目」而不是「非项目会话」，实测有 112 条「有 git + 项目 cwd」的会话同样在里面。

### 项目名来源（展示口径）

展示只给**项目名**，不给路径（完整路径仍在 `--json` 的 `cwd`；`--project` 过滤与落点判定都不看项目名）。
有项目名实体的宿主一律按宿主协议取，没有的才回退到会话目录末段；逐家的项目名来源见 
[`agent-storage.md`](agent-storage.md) 对应变体 V8。复核记录（逐家取证、未发现的检索范围）同样在那边。

---

## 并发写入安全（目标 agent 运行中导入）

宿主随时可能在写同一批文件/库，因此各家的写入方式按容器类型分别处理：

| 容器类型 | 变体 | 写入方式 |
| --- | --- | --- |
| JSONL 追加 | claude、codebuddy、pi、codex、workbuddy×2 | 单次 `O_APPEND` 写整块 + 写前文件大小校验；发现被改过就重建行重试（最多 3 次） |
| JSONL 整文件 | pi（首建）、freebuff、cline、kilo | `temp + fsync + rename` 原子替换，读方永远看到完整版本 |
| JSON 多文件 | codebuddy-ide | 消息与索引各自 `temp + rename`；先写消息再登记工作区索引，宿主看不到半截会话 |
| 多帧 zstd | dsh | 同上（整体原子替换） |
| SQLite | opencode、mimo | `PRAGMA busy_timeout = 8000` + 单条 `BEGIN IMMEDIATE` 事务，失败整体 `ROLLBACK` |
| SQLite 索引 | workbuddy×2 | `busy_timeout = 8000` + 单条 INSERT/UPDATE（不包长事务，尽量缩短持锁） |

在此之上还有两层编排级保护（见 `src/import.mjs`、`src/lock.mjs`）：

1. **目标级跨进程锁**（`target:<变体>`）：挡住我们自己多个进程同时写同一 agent。
   锁文件在 `os.tmpdir()/session-sync-locks/`，`O_EXCL` 创建；持有者 pid 已死或超过 5 分钟未释放 → 可抢占。
2. **锁内写前重校验**：重新读目标、重新判定 `create/append/skip/fork`。陈旧计划不会盲写。

宿主侧仍有一个无法消除的窗口：宿主在我们「读 → 判定 → 写」的微秒级间隙里写入。
此时最坏结果是产生一个 fork（而不是覆盖或重复），由幂等规则在下次同步时收敛。

---
