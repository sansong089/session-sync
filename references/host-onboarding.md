// references/host-onboarding.md — 新增宿主（agent）接入指南
//
// 定位：这是「怎么给本仓加一个新宿主」的操作手册，只写可复用的方法论与仓库事实约定。
// 任一宿主的具体路径 / 格式 / 取证证据，按 V1–V9 九维度记入 references/agent-storage.md 的对应变体段落（规格项必须带验证状态标记）；本程序自己的接线约定记入 references/program-spec.md。本文不留宿主专属内容。

# 新增宿主（agent）接入指南

> 三条铁律：
> 1. **取证没做完不写适配代码。** 猜出来的字段名会让整个 reader 白写，而重写的成本远高于多跑一条样本。
> 2. **结论必须可复现。** 每条事实后面跟「怎么验证的」（命令 / 文件:行号），并落进 `agent-storage.md` 的对应规格项（带【真机/源码/确认/待证】状态标记；无取证依据的标【待证】并登记进文末待证项清单）。
> 3. **先只读、后可写。** 读写一起上，出问题时分不清是哪一半错了。

## 0. 三段流程与放行门槛

| 段 | 做什么 | 放行判据（不满足不许进下一段） |
| --- | --- | --- |
| A 取证 | 在本机把宿主存储摸到「能重建一条会话」 | 正文定位到具体文件/表；工具调用的真实字段名已知；可写性有明确结论 |
| B 接线 | hosts / reader / writer / placement / accounts + 测试 + 文档 | `npm test` 全绿（含 m43 文档一致性） |
| C 验收 | 真机确认读得到、写得进、看得见 | 导入后宿主 UI 列表可见、正文完整、能继续对话不产生分叉 |

---

## 1. 阶段 A：本机取证

### A1 定位数据根（取证产物填进 LOCATOR 单表）

一个宿主通常有 2~3 处落点，分工不同，不要只扫一处：

| 落点 | 典型内容 |
| --- | --- |
| `%APPDATA%\<App>` / `~/Library/Application Support/<App>` | 配置、账号态、窗口状态 |
| `%LOCALAPPDATA%\<App>` / `~/Library/Caches` 或 `~/.cache` | 数据、缓存、Chromium `User Data` |
| `~/.<app>` / `~/.config/<app>` / `~/.local/share/<app>` | CLI 约定目录、会话正文（最常见） |
| VS Code 系插件 | `~/.vscode/extensions/<publisher>.<ext>/`、`<User>/globalStorage/` |
| 宿主工作区产物 | `~/Documents/<App>/`、`~/.<app>/workspace/` |

识别壳层能少走弯路：Chromium/Electron 系必有 `User Data/<Profile>/`（Preferences、Local Storage、IndexedDB）；原生 CLI 多为单文件库或 JSONL；IDE 插件多为 sqlite（`state.vscdb` / `globalStorage/*.db`）。

**取证结论的唯一落点是 `hosts.mjs` 的 `LOCATOR` 单表**（`root` / `marker` / `probe` / `bucket` / `skills` / `account` / `appDir` / `userData`），
配套的官方环境变量登记在 `ROOT_ENV_KEYS`。不要在 reader/writer 里再写路径分支——所有消费点（读侧、写侧、登录态、skills、桶根、非项目判定）
都从 `resolveRoot(variant, ctx)` 拿答案。填好 `probe` 后，「宿主装在自定义目录」的读侧探测自动生效（按目录名 + marker 判据）；
官方 env 变量登记后 env 档自动进候选阶梯。test/m55 有结构棘轮：LOCATOR 白名单之外自己拼宿主根会红。

### A2 定位会话正文（唯一硬指标）

判定标准只有一条：**能搜到一条已知对话的原文**。文件存在、目录结构像，都不算证据。

| 形态 | 判定成本 | 备注 |
| --- | --- | --- |
| 明文 JSONL / JSON | 低 | 最好情况，注意行格式变体 |
| 明文 SQLite | 低 | 先看 `sqlite_master`，再看单行样本 |
| leveldb（Local Storage / IndexedDB） | 中~高 | 需解码；value 常是 structured-clone/protobuf |
| 压缩归档（`.zst` / `.gz` / 内嵌压缩块） | 中 | 写入需整帧解压后重压 |
| 加密 / 二进制 protobuf | 高 | 无安全读写路径就直接 `read: false` 或 `write: false` |

搜不到不等于没有，四种编码会让搜索失效，逐一排除后再下结论：

- `rg` 默认跳过隐藏目录 → 必须 `--hidden`；二进制 → `-a`。
- leveldb 的 `.ldb` 块可能压缩 → 用 `src/leveldb.mjs` 的 `readLevelDb(dir)` 解码后再搜。
- UI 缓存里的字符串常是 UTF-16LE → 按 `utf-16le` 再解一遍。
- 库可能有 WAL 未 checkpoint → 让宿主退出或等待后再读。

### A3 列表源 ≠ 正文源（最容易翻车处）

四类信息往往各有各的源，必须分开登记、分开验证：

| 信息 | 常见源 | 陷阱 |
| --- | --- | --- |
| 会话清单 | 云端接口 / 本地索引库 / 目录枚举 | 清单在云端 → 本地既读不全也写不进 |
| 标题、时间 | 元信息 / 索引库 / 首条用户消息 | 只有缓存里有 → 当增强项并标注降级 |
| 正文 | 独立文件 / 库表 / 压缩块 | 与清单不同源是常态 |
| id → 工作目录 | 配置 KV / 注册表 / 数据库 | 可能按需懒创建 |

两条判据：

- **产物工作区目录存在 ≠ 会话存在。** 很多宿主首次产出文件才建目录，拿它判存在性会漏掉纯对话会话。
- **本地缓存 ≠ 索引。** 分页/过期型缓存同一位置两次采集内容会变，只能当标题增强，不能当会话清单。

### A4 skills 根

全局根（`~/.<app>/skills`）与工作区级根（`.skills` / `.user_skills` / 项目内 `.agent/skills`）都要找。判明宿主实际加载哪个：装一个技能看落点，比读文档可靠。installer 桥接必须指向宿主真正加载的那个根。

### A5 宿主 env 指纹

宿主是否把会话 id / 数据目录导出给子进程？有则在 `hosts.mjs` 的 `HOST_ENV_MARKERS` 精准识别，无则只能退到 newest-store 启发式。
**凡是被 `root(ctx)` / `probe` 用作路径基准的 env 变量，必须同步登记进 `ROOT_ENV_KEYS`**（双向锁定：env/pin 档位判定与「这变量属于哪个变体」都查这张表，漏登记 = 路径被误归 default 档）。

写法：根派生返回 `{ path, envKey }`，用 `rootOf(path, 'X_HOME')` 或 `envRootOf(c, 'X_HOME', fallback)` 构造
（后者在变量缺位时自动给 `envKey: null`）；`readPaths` / `writePaths` / `auxPaths` 的每条候选把根上的 `envKey` 带上。
**候选不自己写档位** —— 档位由 `ROOT_ENV_KEYS` 查表得出（见 `program-spec.md` §0）。
名称门/形态门把 env 值拒掉时，`envKey` 必须一起清空：带着来源却走了默认路径，等于宣称「用户钉过这里」。

手法：对主二进制扫 `<PREFIX>_*` 形态字符串。**注意区分「内部配置常量」与「导出给子进程的 env」**——前者（配置键、路径枚举、日志前缀）不能当指纹，否则会误判「在宿主内运行」。

### A6 样本矩阵（缺一不可）

一次把形态采全，比来回补采便宜得多。每类样本至少一条：

| # | 样本 | 验证什么 |
| --- | --- | --- |
| 1 | 纯文本多轮（≥3 轮） | 轮次归属、用户消息落在哪个文件 |
| 2 | 带工具调用 | 工具调用的真实字段名与嵌套 |
| 3 | 工具报错 | 失败态怎么表示（状态字段 / 文本前缀） |
| 4 | 并行多工具 | id 配对方式（顺序是否可靠） |
| 5 | 只有工具、无文本的助手行 | `content` 缺失是否合法 |
| 6 | 附件轮（图片 / 文件） | 附件目录与消息内引用的对应 |
| 7 | 深度思考开 / 关 | 推理内容是独立 role、独立字段，还是加密体 |
| 8 | 子任务 / 多智能体 | 会话内分组结构（见 A8） |

> 单样本推格式必错：只有纯对话样本时，会得出「用户消息全在任务书文件里」这类错误结论，而真相往往是首轮在任务书、后续轮在轨迹里。

### A7 可写性判定

写一条最小会话进宿主存储 → **重启宿主** → UI 列表能列出、能打开、能继续对话，才算可写。

典型失败形态：列表源自云端或索引缓存，本地文件写得再对也不可见 → 直接定 `write: false`（并在 `agent-storage.md` 对应变体 V6 / V7 写明原因，避免以后有人反复试）。

「文件出现了」不是可写证据；「宿主 UI 看得见」才是。

### A8 多产品 / 多 Profile / 多账号 / 多智能体

- **多产品**：同厂兄弟产品常各有一个数据目录、布局同构。存储格式同构 → 一个变体 + 多候选路径；格式有实质差异 → 拆变体。
- **多 Profile**：`Default` + `Profile N` 是常态 → `readPaths` 从 `Local State` / 配置枚举，绝不硬编码默认 Profile。
- **多账号**：看会话存储是否带账号维度（uid 字段 / 账号子目录）。单账号宿主按「无分区」处理，不要硬塞 partition。
- **多智能体**：一个会话下可能同时存在多个 agent 兄弟目录（主 / 协调 / 子），角色与派单关系写在各自元信息（role、assigned by）与顶层公告板里。**会话粒度必须落在会话目录，不能落在 agent 目录**，否则一条会话会被拆成 N 条。

### A9 取证陷阱清单

1. 单样本推格式（见 A6）。
2. 首轮用户消息可能不在轨迹里：系统侧把首个需求写成任务书单文件，第 2 轮起才进轨迹 → 只读一边必然丢首问或重复次问；合并时**按内容去重，不要按序号**。
3. 追加写 vs 覆盖写要看行数变化；不要假设存在消息 id / 时间戳 / 序号。
4. 工具结果不一定落目录（可能只进轨迹）→「目录没动」不能推断「没调用工具」。
5. 缓存是视图级的（见 A3）。
6. 目录可能懒创建（见 A3）。
7. 编码四连：UTF-16LE、snappy、zstd、protobuf，任一个都能让 grep 空手而归。
8. 二进制里的路径常量不是运行时真相，以实存文件为准。
9. 宿主可能压缩存档 → 写入时整帧解压后重压并原子替换，绝不另起一份明文文件。
10. 系统注入会污染轮次：任务书、环境上下文、`AGENTS.md` 注入都可能是 `role: user` → 必须过滤（复用 `stripSystemInjections`）。

### A10 命令模板

```bash
# 1) 三落点扫描（Windows 示例，macOS/Linux 换对应根）
ls -la "$LOCALAPPDATA/<App>" "$APPDATA/<App>" "$HOME/<App>" 2>/dev/null

# 2) 已知原文定位（隐藏目录 + 二进制；搜不到先排除编码因素）
rg -a --hidden -l '<一句已知原文>' "<userData>"

# 3) leveldb 解码（复用仓库解析器，不要自己写）
node -e "import('./src/leveldb.mjs').then(({readLevelDb})=>{
  const m=readLevelDb('<leveldb dir>');
  const a=[...m].map(([k,e])=>[Buffer.from(k,'latin1'),Buffer.from(e.value??Buffer.alloc(0))]);
  for (const [k,v] of a.sort((x,y)=>y[1].length-x[1].length).slice(0,3))
    console.log(k.toString('hex').slice(0,32), v.length, v.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff]/g,'.').slice(0,160));
});"

# 4) 二进制 strings（env 指纹 / 路径常量）
rg -a -o '(<PREFIX>|<PRODUCT>)[A-Z0-9_]{2,32}' "<main binary>" | sort -u | head -40

# 5) 增量取证：刚操作后到底哪些文件动了
find "<sessionRoot>" -newermt '<YYYY-MM-DD HH:MM>' -printf '%TH:%TM:%TS %10s %p\n' | sort
```

---

## 2. 阶段 B：仓库接线

### B1 改动面总表

| 文件 | 动什么 | 漏了的现象 |
| --- | --- | --- |
| `src/hosts.mjs` `VARIANTS` | 注册变体（读写能力，字段见 B2） | detect / list 全看不到 |
| `src/hosts.mjs` `LOCATOR` | 根定位声明单表：`root` / `marker` / `probe` / `bucket` / `skills` / `account`（各字段语义见 B2） | 读不到、写不进、登录态缺、非项目只能 `requires-cwd` |
| `src/hosts.mjs` `ROOT_ENV_KEYS` | 官方 env 变量登记（与 LOCATOR 的 root/probe 对齐，双向锁定） | env 覆盖路径被误归 default 档 |
| `src/hosts.mjs` `HOST_ENV_MARKERS` | 宿主 env 指纹 | detect 退化为 newest-store 启发式 |
| `src/readers/<name>.mjs` + `readers/index.mjs` | reader 实现与注册 | `reader-not-implemented` |
| `src/writers/<name>.mjs` + `writers/index.mjs` | writer 实现与注册（仅 write ≠ false） | 不能作导入目标 |
| `src/placement.mjs` | 落点决策 | 非项目会话路径错位 |
| `src/accounts.mjs` | 账号模型 | `switch-account` 不认 |
| `src/cli.mjs` | 检查硬编码变体清单/计数 | 帮助、矩阵打印缺项 |
| `test/mNN-<topic>.test.mjs` | 单测 | 无回归保护 |
| 文档 4 处 | 计数与矩阵 | m43 立刻变红（见 B7） |

新宿主的路径知识**只进 LOCATOR，不新增路径分支**：读侧候选阶梯（flag/env/pin/probe/default）、
写侧采纳门、自定义目录探测、「文档」重定向判定都是通用闭环，登记后自动生效。

### B2 `hosts.mjs` 注册字段语义

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `label` | 是 | 展示名 |
| `read` | 是 | 当前全仓均为 `true`（能读）；不可读的宿主不进 `VARIANTS` |
| `write` | 是 | `'A'` 文件/JSONL 直写；`'B'` 库或压缩容器；`false` 只读 |
| `readPaths(ctx)` | 是 | 返回 `{kind:'file'|'dir', path, note?, role?}` 数组；**必须**从 `candidateRoots(variant, ctx)` 派生（读侧候选阶梯的唯一入口），`kind` 决定按文件还是目录遍历，写错 reader 读到空 |
| `detect(ctx)` | 是 | 存在性判断，要便宜且不误判；不要在里面读大文件 |
| `sharedDirect` | 否 | 会话直接落在共享根（无 per-session 子目录） |
| `writePaths` / `auxPaths` | 否 | 写入落点 / 附属文件（索引、注册表） |

**`LOCATOR` 的字段语义**（root 定位声明单表，见 B1）：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `root(ctx)` | 是 | 配置根唯一派生处（含 env 覆盖链）；env 变量同步登记 `ROOT_ENV_KEYS` |
| `marker` | 是 | 「这目录确实是本家」的判据：`sqlite-tables`（特征表）/ `children`（约定子目录）/ `descendant-named`。**禁止「目录存在即算」**，否则探测会认错别人家的目录 |
| `probe` | 否 | 自定义目录探测：在哪些基准下找哪些名字、多深；命中且过 marker 才进读侧候选 |
| `skills` | 有 skills 的宿主 | `{base, rel}`，installer 桥接指向宿主真正加载的根 |
| `bucket` | 是 | 非项目桶：`shape: generated/shared/none` + `root(ctx)`（+ `knownFolder` 声明「文档」重定向参与判定） |
| `account` / `appDir` / `userData` | 否 | 登录态落点 / 桌面产品目录 / Chromium User Data |

**候选路径要多于一个**：env 覆盖优先，其次各平台默认，最后旧版遗留（都在 LOCATOR/`candidateRoots` 的候选阶梯里，按 flag > env > pin > probe > default 排序）。多库/多目录并存时全部读、按会话 id 合并，单个损坏只跳过它自己。

### B3 reader 契约

```js
{ variant, label, available(ctx), list(ctx, opts) -> 候选会话[], read(ctx, id) -> Session }
```

- `list` 只负责「按来源顺序给出候选」，**不要自己去重**——去重与分类在 `readers/index.mjs` 的 `listSessions` 统一做。
- `read` 产出 IR：`makeSession` → 逐轮 `makeTurn` → `finalizeSession`；item 用 `ir.mjs` 的工厂（`messageItem` / `reasoningItem` / `toolCallItem` / `toolResultItem` / `attachmentItem` / `metaItem` / `noteItem`）。
- 直接复用 `readers/base.mjs`，不要重新发明：`assembleTurns`（user 开轮、空内容不开轮）、`pushAssistantItem`、`deriveTitle`、`parseJsonl`、`listEvents`、`stripSystemInjections`、`walkFiles`、`readHead`/`readTail`、`openDb`、`parseArgs`、`tableExists`、`TOOL_RESULT_ONLY`/`TOOL_NULL_INPUT`。
- 空会话（无任何轮次）跳过，不产出空壳条目。

### B4 writer 契约

```js
{ variant, label, canWrite(ctx), targetPath(ctx, session, targetId), write(ctx, args) }
```

- **Tier A**（文件 / JSONL）：单文件原子写，注意追加 vs 重写的语义。
- **Tier B**（库 / 压缩容器）：事务 + 备份 + 原子替换；压缩容器按「整帧解压 → 追加 → 重压 → 替换」。
- **可见性注册表**：部分宿主除正文外还要在索引/注册表登记，否则宿主侧栏不列。写这类文件必须读-改-写、保留未知键、先备份。
- 目标 id 与目录名的映射：宿主自己生成的 slug 通常复刻不了也不需要复刻，自铸 slug + 自己的映射注册表即可。

### B5 落点与账号

- 非项目会话三种桶形态：`generated`（每会话独立子目录）/ `shared`（所有非项目会话共用一个固定目录，搬迁只改归属字段、绝不 move 目录）/ `none`（结构上没有落点 → 不兜底、不造目录，标 `requires-cwd`）。选择依据写进 `program-spec.md` 落点表，m43 会校验三者互斥。
- 账号：`partition` 型才进 `PARTITIONED_VARIANTS`、才允许 `switch-account`；其余按单账号处理。

### B6 测试

- 命名 `test/mNN-<topic>.test.mjs`，NN 取**当前实际最大值 +1**：`ls test | sed -n 's/^m\([0-9]*\)-.*/\1/p' | sort -n | tail -1`。不要信本文档或注释里的数字（会过期）。
- 必跑：`m7-matrix`（可写目标全矩阵）、`m9-variants`（变体契约）、`m37-turn-boundary`（轮次边界保真）、`m43-docs-consistency`（文档 = 代码）。
- 夹具用**真实样本脱敏**后入库，覆盖 A6 的 8 类形态；手捏的假格式测不出真实坑。

### B7 文档同步（m43 会逐条挑错）

| 位置 | 要同步的内容 |
| --- | --- |
| `references/agent-storage.md` | 标题 `# N 个变体`；新增变体段落（V1–V9 九维度，目录树 / 库全貌 / 逐列表结构齐备，逐项带验证状态标记） |
| `references/program-spec.md` | 可写性汇总表头 `可写（N） \| 只读（M）` 与两份名单 |
| `references/program-spec.md` | 落点表 `generated` / `shared` / `none` 三行 |
| `references/program-spec.md` | 账号行 `**可切**` / `不可切` |
| `README.md` | `## 支持矩阵` 的 Agent 行 + 读/写列；`N 个可写目标全矩阵`；`## 换账号` 段 |
| `SKILL.md` | `支持 N 个变体`、`N 个变体（含各变种）`、`只有 N 个变体可做` |
| `references/cli.md` | `## switch-account` 的按宿主动作表（partition 变体） |
| `test/m7-matrix.test.mjs` | 标题里的 `可写目标全矩阵：N 个目标` |

新增一份参考文档时，`README.md` 的「文档」表与 `SKILL.md` §参考文档 各加一行。

### B8 代码规约

- 只写「为什么」的注释：约束、反直觉决策、踩过的坑。不要复述方法名。
- 变体专属知识放 reader/writer 和 `agent-storage.md`（规格项带验证状态），本程序接线放 `program-spec.md`；不要在 `hosts.mjs` 里堆分支。
- 多处派生同一个值时留「唯一派生处」注释（env 覆盖路径尤其容易分叉）。

---

## 3. 阶段 C：验收

1. `npm test` 全绿（含 m43）。
2. 真机：`import --apply` → 宿主 UI 列表可见 → 打开 → 正文、工具调用、附件齐全。
3. **续写不产生分叉**：导入后在宿主里追加一轮，再导入一次，应判为追加而非 `fork`（轮次边界不变量，见 `references/identity.md`）。
4. 只读宿主：抽样比对「会话数 / 轮次数」与宿主 UI，确认没漏读；降级项（标题、时间）显式标注。
5. 副作用自查：env 覆盖路径下，reader / writer / 登录态 / 落点用的是同一个根。

---

## 4. 数据形态 → IR 映射决策表

| 维度 | 必须先问的问题 | 常见形态 | 坑 |
| --- | --- | --- | --- |
| 会话 id | 稳定吗？会被重映射吗？ | 雪花 id / uuid / 文件名 | 宿主可能先用临时 id，落定后重映射 |
| 标题 | 权威来源是哪个？ | 元信息 / 索引库 / 首条用户消息 | 索引是缓存；退化为首条消息时才截（`previewTitle`）。**读到的标题不截断**，容量只在写侧生效（`TITLE_MAX` + `fitTitleFor`） |
| 时间 | 有逐条时间吗？ | ISO8601 / epoch ms / 无 | 只有会话级 → 逐条标 inferred，**不要伪造** |
| 角色 | 有哪些 role？ | user / assistant / system / tool / reasoning | 空 content 的 user 常表示「助手继续输出」，不该开新轮 |
| 工具调用 | 字段名？`arguments` 是对象还是字符串？ | OpenAI 风格 / Anthropic 风格 / 自定义 | 照搬「JSON.parse(arguments)」会抛错 |
| 工具结果 | 带工具名吗？ | 独立行 / 同条消息内 | 只有 callId → 先建 id→name 索引回填 |
| 失败态 | 有状态字段吗？ | 状态字段 / 纯文本前缀 | 无状态字段 → 按 `Error:` / 非 0 退出码前缀推断，原文保留 |
| 并行调用 | 怎么配对？ | 数组顺序 / callId | 结果顺序无保证，按 callId 配对 |
| 推理内容 | 独立 role 还是字段？加密吗？ | reasoning 行 / 字段 / 加密体 | 解不开就丢弃并标注，不要塞进正文 |
| 附件 | 存哪？消息里怎么引用？ | 独立目录 + 路径/占位 | 两处都要查，占位行不进核心哈希 |
| 多智能体 | 一个会话几个 agent 目录？ | 兄弟目录 + 公告板 + 派单链 | 会话粒度落在会话目录 |
| 系统注入 | 哪些是宿主注入的？ | `role: user` 的上下文块 | 必须过滤，否则轮次与哈希漂移 |

---

## 5. 实施顺序

1. `hosts.mjs` 注册 + `readPaths`/`detect` —— 目标：`detect` 命中、`list` 能报出正确会话数。
2. `reader.list` —— 对齐会话数、标题、更新时间。
3. `reader.read` —— 用 A6 的真样本逐条比对，先纯文本、再工具、再附件。
4. 单测（真实样本夹具）+ 文档同步 + 跑 m43。
5. `writer`（write ≠ false 时）：最小会话 → 工具轮 → 附件 → 可见性注册表。
6. 真机验收（阶段 C）。

---

## 6. 新增宿主登记卡（复制填空）

| 项 | 值 |
| --- | --- |
| 变体名 / 展示名 | |
| 数据根（含多产品、多 Profile 规则） | |
| `LOCATOR`（root / marker / probe / bucket / skills / account） | |
| 正文格式与位置 | |
| 会话清单来源（本地/云端/缓存） | |
| 标题 / 时间来源 | |
| 工具调用 schema（arguments 类型、结果行是否带名） | |
| 推理 / 附件表示 | |
| 多智能体布局 | |
| 桶形态（generated/shared/none） | |
| 账号模型（partition / 单账号） | |
| 可写性结论 + 依据（哪次真机验证） | |
| 证据清单（命令 + 日期 + 文件:行号） | |

---

## 7. 反模式

- 只看二进制字符串就定路径。
- 拿缓存当索引、拿产物目录当会话存在性判据。
- 单样本推格式；只读任务书或只读轨迹。
- 「目录没动」推断「没调用工具」。
- 假设所有宿主都是 OpenAI 原生 schema。
- 读写一起上，出问题分不清哪一半。
- 手改文档里的计数与名单——直接跑 m43，让它告诉你漏了哪。
- 把新宿主的专属事实写进本文（本文只放方法论）。
