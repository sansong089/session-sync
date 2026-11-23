# session-sync

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.22-5FA04E)](https://nodejs.org)
[![Agents](https://img.shields.io/badge/agents-20-6f42c1)](#支持矩阵)
[![License](https://img.shields.io/badge/license-MIT-blue)](#许可)

**把任意 coding agent 的会话历史，带进你想用的 agent 里继续。**

WorkBuddy / Qoder / 任意 agent 里，会话进行到一半免费额度用尽，急死人。怎么办？一句话：「把 WorkBuddy 中的会话 xxx 导进来」，然后在新工具里打开原会话接着聊。

session-sync 把一段会话完整搬到另一个 agent，写成它自己的原生会话。打开就能看到完整上下文，接着问、接着改，跟在这个 agent 里一路聊下来一样。

- **21 个 agent 变体**：覆盖 CLI、桌面端与 IDE 插件
- **18 个可写目标**：导过去就是原生会话，在目标界面里直接打开
- **n:n 同步**：任意来源到任意目标，支持双向与多跳
- **幂等去重**：同一会话反复导入，目标里始终只有一份
- **跨链路收敛**：A→B→C 与 A→C 落到同一条 C 会话
- **运行中导入**：目标 agent 开着也能写
- **一条命令装成 skill**：装完直接对 agent 说「把 Codex 最近一周的会话同步过来」

## 适用场景

| 场景 | 做法 |
| --- | --- |
| **换一款 agent / 额度用尽** | **把旧工具的会话导进新工具，上下文完整接上；一个 agent 的免费额度用完，切到另一个 agent 接着聊** |
| 换登录账号 | 把某条会话从旧账号挪到另一个账号（`switch-account`）；目标账号没挂载这个项目时，按导入同一条路径把项目一并补出来 |

## 快速开始

运行环境：Node.js 22.22 及以上，零外部依赖。

```bash
# 在仓库根目录执行

# 1) 安装为 skill：共享根 + 自动桥接到本机各 agent
node bin/session-sync.mjs install

# 2) 看看本机装了哪些 agent、哪些可写
node bin/session-sync.mjs detect

# 3) 浏览与预览
node bin/session-sync.mjs list --from codex --since 7d
node bin/session-sync.mjs import --from codex --since 7d            # 默认只预览

# 4) 确认后落盘
node bin/session-sync.mjs import --from codex --since 7d --apply
```

`--into` 省略时，目标就是当前所在的 agent；`--from` 省略时，来源覆盖本机全部变体。

装成 skill 之后，也可以直接用一句话完成。下面这些原样对 agent 说就行。

**导入单条会话**

```
「导入 WorkBuddy 中的会话 xxxxxx」
```

```
「导入 Qoder 中的会话 xxx」
```

**给单条会话换登录账号**

```
「把账号 xxx 中的会话 xxxx 切到当前账号」
```

**批量导入**

```
「把 Codex 最近 7 天的会话导入进来」
```

```
「Claude 和 Pi 的历史都合并到我这」
```

```
「把 OpenCode 里 00-demo-app 项目的会话导到 Qoder」
```

## 支持矩阵

一个 agent 一行。「读」表示可以作来源，「写」表示可以作目标；这一列由代码里的 writer 注册表自动核对，与实现始终一致。

| Agent | 形态 | 读 | 写 |
| --- | --- | :-: | :-: |
| opencode | CLI / TUI | ✅ | ✅ |
| claude | CLI | ✅ | ✅ |
| pi | CLI | ✅ | ✅ |
| codex | CLI / IDE 扩展 / 桌面 | ✅ | ✅ |
| codebuddy | CLI | ✅ | ✅ |
| codebuddy-ide | IDE / VS Code 插件 | ✅ | ✅ |
| workbuddy-cn | 桌面（中文版） | ✅ | ✅ |
| workbuddy-intl | 桌面（国际版） | ✅ | ✅ |
| qoder-cn | CLI + 桌面（中文版） | ✅ | ✅ |
| qoder-intl | CLI + 桌面（国际版） | ✅ | ✅ |
| zcode | CLI + 桌面 | ✅ | ✅ |
| mimo | 桌面 + CLI | ✅ | ✅ |
| minimax | 桌面 | ✅ | ✅ |
| dsh | 桌面 + 内置 CLI | ✅ | ✅ |
| freebuff | 桌面 | ✅ | ✅ |
| cline | VS Code 扩展 + CLI | ✅ | ✅ |
| kilo | VS Code 扩展 | ✅ | ✅ |
| roo | VS Code 插件 | ✅ | ✅ |
| antigravity | CLI / IDE / 桌面 | ✅ | ✅ |
| cursor | IDE | ✅ | ❌ |
| doubao | 桌面（agent 模式） | ✅ | ❌ |

各家 agent 自身的存储规格（按 V1–V9 九维度登记：目录树 / 库全貌 / 会话边界 / 格式编码 / 逐列表结构 / 可见性 / 项目归属 / 元数据；每条带验证状态标记：真机/源码/确认/待证，不带日期）见 [`references/agent-storage.md`](references/agent-storage.md)；本程序的实现规格见 [`references/program-spec.md`](references/program-spec.md)。

---

## 导入之后是什么样

- **目标里多出一条原生会话**：标题、轮次、消息、工具调用按目标宿主的格式写入，在它的侧栏里就像自己生成的一样。
- **按项目归位**：源会话属于哪个项目，导入后仍挂在同名项目下；侧栏里的所属项目取自目标宿主自己的项目名协议。
- **标题跟着会话走**：导入后的会话标题与源宿主侧栏显示的名字一致。
- **原始会话保持原样**：写入只发生在目标侧；源侧全程只读。
- **冲突自动分叉**：目标里的同名会话被本地改过时，新内容会另建一条分支会话，两边都保留。

## 换账号

有些宿主把会话按登录账号分区：换账号登录后，旧账号名下的会话在当前侧栏里就看不到了。
`switch-account` 把一条已存在的会话挪到另一个账号，**必须点名会话 id，默认只预览**。

```bash
session-sync accounts --into auto                 # 逐家看：按不按账号分区、本机有哪些账号、登录态在哪
session-sync switch-account --into codebuddy-ide --id <会话id> --account <目标uid> --apply
```

- **CodeBuddy IDE / 插件**：账号分区是目录层的（`Data/<user>/<ide>/<uid>/history/<md5(项目路径)>/`）。
  两个账号挂载的项目常常不一样，所以切换除了搬正文，还会把 `history`、`check-point`、`file-tree`、`plan-task`
  四个同坐标目录一起搬，并在目标账号没有这个项目时补出它的工作区索引 —— 与首次导入走的是同一条落点路径。
- **WorkBuddy 中/英**：账号是 `sessions.user_id` 一列，切换只改那一列；项目表按安装共享，不涉及补项目。
- **Codex**：账号在 `threads.creator_user_id/creator_account_id` 与 rollout 首行的同名字段，两处一起翻。
- **其余宿主**（Qoder、MiniMax、MiMo、ZCode、DSH、Freebuff、CodeBuddy CLI、OpenCode）都有登录态，
  但本地会话行不带账号归属，改它不会让宿主多看见或少看见任何东西 —— 命令会如实回
  `switch-unsupported` 并附上逐家的取证依据与替代路径，不做静默改写。

改的是宿主里已有的数据，所以：写前一律留备份（改列的还另存原值快照），宿主原生会话也允许切但必须逐条点名并在报告里打审计行；
只想动本工具导入过的会话，加 `--only-imported`。

## 设计原则

**身份由内容派生。** 每个会话用自己的来源和原会话 ID 生成一个稳定的目标 ID，同一段会话走任意路径、导任意次数，落在目标里都是同一条。

**每一步都可以先看再做。** `status` 与 `import` 默认只读预览，逐条列出动作与落点，确认之后再 `--apply`。

**写入与宿主的读写节奏协同。** 多进程并发、宿主正在读写，都能安全完成导入。

**跨格式保留对话骨架。** 轮次边界、消息文本、工具调用在往返过程中保持等价；导入过的会话可以继续追加，像原生会话一样往下聊。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`SKILL.md`](SKILL.md) | 作为 skill 使用时的完整指令与常见问题 |
| [`references/cli.md`](references/cli.md) | 全部子命令与参数 |
| [`references/agent-storage.md`](references/agent-storage.md) | 21 个变体的宿主存储规格（V1–V9 九维度、目录树 + 库全表清单 + 逐列 DDL、逐项验证状态 + 待证项清单 + 取证脚本清单） |
| [`references/program-spec.md`](references/program-spec.md) | 本程序规格：根定位、标题同步、可写性矩阵、落点策略、并发写入与宿主注入约定 |
| [`references/environment.md`](references/environment.md) | 运行环境判别规格：六维坐标（含版代）/ 五层信号 / R1–R6 硬规则 / 三终态 / 判据登记表 |
| [`references/identity.md`](references/identity.md) | 会话身份、去重与分支的判定规则 |
| [`references/host-onboarding.md`](references/host-onboarding.md) | 新增一个宿主（agent）的取证、接线与验收流程 |

## 开发与质量

```bash
npm test
```

测试覆盖 420 条用例，包含 18 个可写目标全矩阵回归（第 19 个可写目标 claude 的自导入单独覆盖），并对真实宿主存储做只读核对；真机脚本另有两支可复跑：`test/real-host/codebuddy.mjs`（用官方 CLI 的未登录加载提示做 oracle）与 `test/real-host/codebuddy-ide.mjs`（镜像真实扩展缓存跑真 `switch-account`，验证跨账号搬迁与补项目）。

**功能性修改的硬规矩（改前必读规格）**：涉及存储的改动（reader / writer / roots / hosts / title-slots / identity / placement / accounts）动手前先读 [`references/agent-storage.md`](references/agent-storage.md) 对应变体的 V1–V9，落地后同步更新规格项与验证状态；本程序机制变更同步 [`references/program-spec.md`](references/program-spec.md)。无真机/源码证据的规格项只能标【待证】并登记清单，修改涉及待证项前先取证或经项目主人确认。`test/m74` 棘轮守护这些规则。

欢迎提交 Issue 与 Pull Request，尤其欢迎补充新的 agent 形态与真机样本。

## 许可

MIT
