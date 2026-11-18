# Qoder（中文版 / 国际版）写入契约

取证时间 2026-10-28，本机 Qoder CN 桌面版；国际版同日装上后二次取证，两代 schema 完全一致
（三组 CHECK、`chat_session_messages` 列集、`ws_…` 形态都对得上），以下契约对两家同时成立。全部结论都来自真机读写实验与宿主包内代码，不是推测。
实现：`src/writers/qoder.mjs`；读侧：`src/readers/qoder.mjs` 的 `registry*` 一路；回归：`test/m38-qoder-writer.test.mjs`。

## 1. 三层落点，缺一层就不算「被识别」

| 层 | 位置 | 作用 | 缺它的实测后果 |
| --- | --- | --- | --- |
| 1 正文 | `<cliRoot>/projects/<slug>/<id>.jsonl` | CLI 恢复、本工具读正文 | 桌面回「这个会话未在 Qoder 中登记」 |
| 2 注册表行 | `<appData>/com.qodercn.app.stable/main.sqlite` → `chat_sessions` | 桌面列表 / 标题 / 落点 | 列不出来 |
| 2b 项目归属 | `chat_sessions.workspace_id`（可选列，存在才写） | 决定会话出现在哪个项目分组下 | 项目会话只进「未分配」，任何项目下都看不到 |
| 3 正文投影 | 同库 `chat_session_messages` | 桌面打开后的消息渲染 | 列得出但点开是空的 |

`<cliRoot>` = cn `~/.qoder-cn`、intl `~/.qoder`（硬隔离，不跟随 `QODER_CONFIG_DIR`）。
`<slug>` 与 Claude Code 同规则（非字母数字换 `-`，大小写保留）：`D:\02-mywork\session-sync` → `D--02-mywork-session-sync`。

旧的 `%APPDATA%\QoderCN\SharedClientCache\cache\db\local.db`（正文密文那套）mtime 停在上一代，
是被 `main.sqlite` 取代的**上一代存储**，只保留作降级读与账户信号来源，不参与写入。
2026-10-30 复核：本机该文件仍在（数十行 `chat_session.user_id` 全是同一个 uid，mtime 2026-10-15）；
而现行 `chat_sessions` **没有任何账号列**（实测百余行，`owner_session_id` 全空、`registration_json` 全 NULL），
`workspaces` 也没有 —— 所以 Qoder 的本地会话不按账号分区，`switch-account` 对它返回 `switch-unsupported`；
它的账号身份在 `account_profiles` / `qoder-data.v1.ext.json` 的 `.accounts`（实测两份档案）/
`~/.qoder-cn/.models/<account-uuid>/` 这些地方，换装或换区要靠跨安装导入。

> 之前文档写的「正文密文、无法构造合法密文 → 只读」是过期结论：现行两层的正文都是明文。

## 2. 第 1 层：正文 jsonl

与 Claude Code 同构（`user`/`assistant` + `parentUuid` 链），差异只有形状要求：

```jsonc
{"type":"workspace-directories","sessionId":"<id>","directories":["<cwd>", …]}   // 首行，恰好 1 条
{"type":"runtime-config","sessionId":"<id>","model":"…","reasoningEffort":null,"contextWindow":null,"timestamp":<ms>}
{"type":"user","uuid":"…","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"…"}]},
 "cwd":"…","userType":"external","entrypoint":"cli","version":"1.1.16","gitBranch":"…","isSidechain":false}
{"type":"active-leaf","leafUuid":"<最后一条 user/assistant 的 uuid>","explicit":false,"sessionId":"<id>"}
```

`active-leaf` 是恢复游标（会话树的叶子），宿主一次会话里会写多条（实测某会话 3 条），所以追加时补一条即可。

## 3. 第 2 层：`chat_sessions`

必填列（其余可空）：`title`、`cwd`、`additional_direcotries`（宿主就这么拼写）、`extra_json`、
`created_at`、`updated_at`、`execution_target_json`、`archived`、`unread`，以及三个带 CHECK 的枚举：
`session_kind IN ('standard','sideChat','automationExecution')`、
`conversation_mode IN ('normal','voice')`、`product_mode IN ('coding','general')`。

我们写：`standard` / `normal` / `coding`，`execution_target_json = {"mode":"local","host":{"id":"local","kind":"local","label":"Local"},"workspace":{"id":"ws_…","path":"<cwd>"}}`。

`extra_json` 承载身份：`{"source":"workspace","importedFrom":"session-sync","historyRecoveryBackgroundAgents":[],"session-sync":{…provenance…}}`。
最后一项是本工具认领这一行的判据，也是读侧补 origin 的来源。
`ws_<64hex>` 的哈希规则没取证到（`sha256(cwd)`、小写、正斜杠几种都不中），
实现只做「同一目录恒得同一 id」的稳定占位，写进 `execution_target_json.workspace.id`。

**`workspace_id` 才是项目分组条件（2026-10-30 真机取证，CN 桌面 0.4.11）**：侧栏按
`SELECT … FROM chat_sessions WHERE workspace_id = ? AND registration_json IS NULL AND deleted_at IS NULL`
取每个项目下的会话（包内 `listWorkspaceSessions`）；`workspace_id` 为 NULL 的项目会话不会出现在任何项目下。
它必须等于 `workspaces.workspace_id`（宿主 UUID），**不能**填 `ws_…` 占位。写侧规则：

1. **认领**：按 `workspaces.root_paths_json` 找该 cwd 所属工作区（最长前缀，忽略大小写与 `/`·`\` 差异，
   跳过 `archived=1` / `deleted_at` 非空的行）。命中就用它的 `workspace_id`。
2. **补登记**：认领不到且 `scope=project` 时，按宿主 `save()` 的形状往 `workspaces` 插一行 ——
   `workspace_id` 用随机 v4 uuid（源码取证：宿主 `saveNewWorkspace` 走 `store.save({workspaceId: De(), ...})`，
   是随机 uuid，**不是** 路径哈希，所以没有「复刻不了就不能登记」的限制），
   `name` = 目录末段，`workspace_source = 'local'`，`product_mode = 'coding'`，`extra_json = '{}'`，
   `archived = 0`，`deleted_at = NULL`，并告警 `workspace-created`。
   宿主侧栏的项目列表就是 `SELECT … FROM workspaces WHERE deleted_at IS NULL AND archived = 0`，
   纯读库，所以补出来的行能显示；但外部写库拿不到宿主的 UI 推送，需要**刷新或重开列表**。
3. **`root_paths_json` 的字面必须与宿主一致**：宿主按 `root_paths_json[0] === path` 严格比较来复用项目行，
   实测存的是 `fs.realpathSync.native` + 盘符大写 + 反斜杠（`d:/work/demo` → `D:\work\demo`）。
   差一个大小写或分隔符，用户之后打开同一目录就会多出一行幽灵项目。
   用 `realpathSync`（非 native）或只做字符串替换都拿不到磁盘真实大小写。
4. **边界**：目录在盘上不存在时不登记（宿主 `resolveWorkspaceRoots` 同样会抛），保持留 `NULL` +
   `workspace-unmatched` 告警；同一目录只登记一行，后续导入复用；已被宿主归档的行不复活、也不另插一条。
5. **自愈**：续写我们自己建的会话时，会顺带把之前留空的归属补上。
   早期版本漏了第 1 步，真机表现是「三层都在、侧栏任何项目下都看不到」。

## 4. 第 3 层：`chat_session_messages`（关键判据都在这里）

一行 = 一轮里的一个角色：user 行 + assistant 行。必须满足：

- `source = 'cli-import'`、`payload_schema_version = 2`。
  实测同样两行用 `sdk-projection` + 版本 1 写入，宿主 `read_chat_session` 读回 `messages: []`；
  只改这两列后立刻原样读出（含工具与输出）。
- `message_id`：user 行 = 该轮 uuid；assistant 行 = `assistant:<userUuid>`。
  包内 `needsCliProjectionRefresh` 的判据就是
  `source='cli-import' AND message_id NOT LIKE 'assistant:%'` 视为过期投影，形态不对会被宿主反复重建。
- `payload_json`：`{"id","role","turnId","text","timestamp","parts":[…]}`（顶层 `text` 是同角色文本的 `\n\n` 拼接；
  宿主两种代际都出现过 —— 一种只有 `{parts}`，一种带全套，所以按超集写，两条 SQL 路径都命中）。
- 部件词表（从宿主自己的 `cli-import` 行采样）：`text` / `thinking` / `tool` / `hook` / `contextCompression`。
  `tool` 部件是**调用与回执一体**：`{"id":"tool:<id>","type":"tool","tool":{"id","name","input","status":"completed|failed|running","parentToolUseId","response"}}`，
  不要拆成两行；非 `toolu_` 前缀的调用 id 宿主规范成 `toolu_migrated_<hex>`（包里 `Hce()`），我们跟同一口径。
- `payload_hash = sha256(payload_json)`、`payload_bytes = len`、`status='completed'`、`has_visible_content=1`、`sequence` 递增。
- 顺带更新 `chat_session_history_revisions(session_id, revision)`。

不需要写：`chat_session_search_*`（FTS）、`chat_session_recaps`、`chat_session_highlights`、
`chat_session_sidebar_placements/groups` —— 实测可见会话在这些表里也是 0 行，缺它们不影响列出与渲染。

## 5. 写入纪律与安全

- 只动我们自己建的行：认领判据是 `extra_json['session-sync']`。**标题只在创建那一次拥有**：续写时读回的
  `session.title` 是本地从首条用户文本推出来的，拿它覆盖会把宿主里更好的标题降级成整段文本（真机 append 实测到过）。
  追加到宿主原生的会话时，
  注册表只推进 `updated_at` 并插入新增轮次的投影行，**绝不删改宿主写的历史行**。
- 备份：`main.sqlite` 实测 186 MB，所以同进程内对同一库只备份一次（含 `-wal`/`-shm`，
  只拷主文件会停在缺最新事务的状态）。
- 并发：`PRAGMA busy_timeout = 15000`，并由 `import.mjs` 的目标级锁串行化。
- 注册表不存在时不假装成功：仍写正文（CLI 侧可见），返回 `registry-db-absent` 警告。
- 侧栏不会自己出现：宿主只给自己的写入路径发 `artifactSource.notifyCommitted`，
  外部写库要靠刷新或重开列表 → 每次写入都固定输出 `registry-refresh-needed` 警告。

## 6. 官方导入为什么借不到

包内 `sessionMigrationSources` 写死两个来源：`questCn`（读 `QoderCN/SharedClientCache/cache/db/local.db`）
和 `qoderWorkCn`（读 `QoderWork CN/data/agents.db` + `.qoderworkcn` 正文根）。没有「任意 agent / 任意目录」
的入口，也没有对外的导入命令行。另外现网 96 条里 74 条 `importedFrom:"workbuddy"`，而 `workbuddy`
这个词在 141 MB 的 `app.asar` 里命中 0 次 —— 那批行是外部写入方按宿主形状直接落盘的结果，
并且现在正常显示。结论：没有官方接口可调，但「外部按形状写三层」是宿主实际接受的形态。

## 7. 验收

- fixture：`test/m38-qoder-writer.test.mjs`（7 项，DDL 与 CHECK 照抄真机）——三层形状、
  jsonl 与投影两条读路的核心指纹等价、append、物化、注册表缺失降级、编排幂等。
- 全矩阵：`test/m7-matrix.test.mjs` 现在覆盖 17 个目标（含 qoder×2）。
- 真机：写一条 claude 会话（3 轮、31 次工具调用、18 段思考）到真实 CN 库，
  用宿主自己的 `read_chat_session` 读回 —— 标题、三轮文本、每轮的 tool 列表与输出全部原样呈现。
  `list --from qoder-cn` 与再导入判为 `skip`。
- 国际版实测（2026-10-28 装好后）：注册表 `%APPDATA%\com.qoder.app.stable\main.sqlite`（推断被证实）、
  正文根 `~/.qoder/projects`、非项目桶 `~/Documents/Qoder/<日期>/<uuid8>`（宿主自己建过 `2026-10-28/11e08d4a`）。
  同一条 claude 会话导入国际版：三层齐全、`revision=6`、6 行投影全是 `cli-import`/schema 2、
  宿主原有那条会话的 4 行投影一行未动。**两家 UI 都人工确认过**：CN 用宿主自己的
  `read_chat_session` 读回标题/正文/20 次工具与输出，国际版在侧栏刷新后列出同一条并可打开看到工具；
  验收后写回滚脚本删掉了自己建的行与正文（注册表回到宿主原有行数，原生投影行数不变）。
- 国际版顺带证实的两点：宿主自己写的 user 投影行顶层还带 `issueId/attachments/selectedSkillNames/…`
  （我们写超集不必包含）；`hook` 部件是**独立的 `role='system'` 行**，不是 assistant 行里的部件 →
  读侧按「只认 user/assistant」跳过它是对的。
