# 分册 03：provider 薄类（codebuddy / opencode）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05（codebuddy 2.180.0 + opencode 2.2.5 真机复测后更新）。
- **契约归属**：五钩子形状见 02 分册 §2；权限映射与拒绝→cancelled 语义见 04 分册；启动配置 schema（含 `gatePermissions`）见 05 分册。本册写**每个 provider 的差异点、实测事实与兜底**。与冻结页 `00-interface-freeze.md` 冲突时以冻结页为准，冻结页文末 §10「实测勘误」列出了复测差异。
- v3 范围：只有两个 provider；范围决策见主文档「不做」。

## 1. 状态总表（如实标注，禁止猜测）

| provider | type | 状态 | 依据 | 本机状态 |
| --- | --- | --- | --- | --- |
| codebuddy code | `codebuddy-acp` | **主路径，真机已实测**（2026-11-05：2.167.0 探针 + 2.180.0 复测） | 探针五步全部成功（冻结页 §9）；2.180.0 真机验收三场景全绿（06 分册 §5） | 已安装 2.180.0（`/usr/local/nodejs/bin/codebuddy`，别名 `cbc`），登录态 |
| opencode | `opencode-acp` | **已实测**（2026-11-05，2.2.5 真机验收；实测发现默认权限全 allow，必须注入权限闸，§3.2） | 真机验收三场景全绿（06 分册 §5） | 已安装 2.2.5（npm 全局 `@opencode/cli`，Bun standalone 二进制） |

实测的含义：codebuddy 的行为断言来自 2.167.0 探针（冻结页 §9）与 2.180.0 复测（§2.1）；opencode 的行为断言来自 2.2.5 真机验收（§3）。两家 `initialize` 均返回 `protocolVersion:1`。仍未核实的行为照实标注（§2.4、§3.5）；缺 CLI、握手失败、认证失败一律 fail-fast（§3、07 分册），绝不静默降级。

## 2. codebuddy（`type: 'codebuddy-acp'`，主路径）

### 2.1 实测事实（2026-11-05；2.167.0 探针 + 2.180.0 复测）

2.167.0 五步探针（总耗时 27.5s：`initialize` 2921ms、`session/new` 231ms、prompt 8680ms / 7512ms、`session/cancel` 后 45ms 返回、SIGTERM 后 ~60ms 退出 code 0）作为冻结页 §9 的证据保留。本表记录 2.180.0 复测确认与新增的事实。

| 观测点 | 实测结果（2.180.0） | 设计结论 |
| --- | --- | --- |
| `initialize` | `protocolVersion:1`；`authMethods` 4 项：iOA / Login with Google-Github / Login with WeChat / Login with Enterprise Domain | 握手健康；`auth-required` 文案的名单来源（07 分册 §4） |
| `session/new` | 响应键 `[sessionId, models, modes, configOptions, multitaskOn]` | 只取 `sessionId`，厂商键一律忽略（01 分册 §4 第 5 条） |
| 回合内变体 | 含工具调用的完整回合：`config_option_update`×1（**此前未观察到，属冻结页 §2.3 已列忽略集合**）、`available_commands_update`×4、`session_info_update`×50、`usage_update`×13、`agent_thought_chunk`×53、`agent_message_chunk`×41、`tool_call`×10、`tool_call_update`×17；全程 stderr 0 行、非 JSON 行 0、`fs/*` 请求 0 次 | 忽略集合在高频压力下工作正常（`session_info_update` 50 条/回合不污染 transcript）；`agentCapabilities` 被尊重 |
| `tool_call` 三段式 | 首事件**同时**带 `input:{}` 与 `rawInput:{}`（`input` 是厂商键，应忽略，以 `rawInput` 为准）；同 id 全量重发并修正 `kind`；全量重发的 `rawInput` 新增 `timeout` 字段 | 累加器合并语义不变（冻结页 §3）；**参数键集不承诺固定**——提取链不要枚举完整键集（04 分册 §2） |
| 工具名 | 标准 `name` 仍缺；厂商工具名（`Bash` / `Write`）只在 `_meta.codebuddy.ai/toolName` | transcript 工具名显示 ACP kind（`execute` / `edit`）；`_meta` 原样透传不解释 |
| `request_permission` 触发面 | **只对有副作用的工具发**：bash / Write 发，read / search 不发 | 权限桥只在副作用工具上被触发（04 分册 §9）；能力视图如实计数 |
| 拒绝后 | `stopReason:'cancelled'` + `_meta.codebuddy.ai/outcome:'PERMISSION_DENIED'`，`errorMessage` `"Permission denied for tool(s): unknown"`，距拒绝响应约 285ms | **cancelled ≠ 用户取消**：拒绝也以 cancelled 收尾，worker 层按本回合拒绝次数区分（04 分册 §9） |
| 取消 | `session/cancel` → 242ms 返回 `cancelled`；迟到 update 3 条（收尾性质）；agent 自行杀掉工具子进程 | `trustUpdatesAfterCancel:true` 保留写入是对的（3 条均为收尾）；`cancelGraceMs:8000` 裕度充足 |

### 2.2 未登录形态（auth-required 判据的来源）

2026-11-04 实测（未登录态）：同一进程内 `initialize` 成功后，`session/new` 25s 与 28s 两次探测**均无任何 stdout/stderr 输出**，进程被 timeout 杀死——握手成功 ≠ 可用。原因未单独核实（登录态修复后消失），但现象稳定可复现，据此 v3 的判定是（冻结页 §4）：`session/new` 在 `sessionNewMs` 内无响应且握手 `authMethods` 非空 → `auth-required`；或 stderr 命中 login/auth/unauthor/token/401 时**短路归因**（命中即判，不等超时）。文案：`"<provider>" 未登录：先在终端运行一次 "<command>" 完成登录（<authMethods 名单>）再重试`。

### 2.3 差异落点（本类覆写）

| 钩子 | codebuddy 取值 | 依据 |
| --- | --- | --- |
| `buildLaunch` | `command:'codebuddy'`、`args:['--acp']`、env 与 `process.env` 合并；command/args 可被用户配置覆盖 | 原生 stdio；实测 2.180.0。另有 `--acp-transport streamable-http`，0.9.0 不接（主文档「不做」第 2 条） |
| `mapPermission` | 默认实现（共享 permission-bridge，04 分册），不覆写 | 实测请求形态被 bridge 的合并规则覆盖（toolCall 无 kind → 形态推断兜底） |
| `normalizeError` | 按冻结页 §4 分类表折 `AcpError`；无 provider 特例 | 实测无畸形退出形态 |
| `isReady` | `session/new` 超时 + `authMethods` 非空 → `auth-required`（§2.2）；stderr 关键词短路 | 只看握手判不出登录态；authMethods 4 项进文案 |
| `stopPolicy` | `cancelGraceMs:8000`（可能在等网络，比默认宽）、`sigtermWaitMs:2000`、`trustUpdatesAfterCancel:true`（迟到 update 多为收尾，不该丢） | 实测 2.180.0：242ms 返回、迟到 3 条保留写入；2.167.0：SIGTERM ~60ms 退出 |

### 2.4 codebuddy 的未实测项

`authenticate` 与 `session/load`（0.9.0 不做交互引导，02 分册 §2.6）；`plan` / `notice` / `compaction*` 变体；`mcpServers` 注入；多回合中途消息（由 worker 层 fake 断言覆盖，06 分册 §3）；`--acp-transport streamable-http`；2.180.0 的未登录形态未单独复测（§2.2 判据沿用 2.167.0 时期实测）。

## 3. opencode（`type: 'opencode-acp'`）

**定位**：原 experimental——2.2.5 真机实测后转为「已实测」。环境：npm 全局 `@opencode/cli` 2.2.5（Bun standalone 二进制）；ACP 入口 `opencode acp`（子命令存在，仅 `--login` 一个 flag）。实测发现的 P0（默认权限全 allow，§3.2）决定了：**这家 provider 的可用前提是权限闸注入**。

### 3.1 实测事实（2026-11-05，opencode 2.2.5）

| 观测点 | 实测结果 | 设计结论 |
| --- | --- | --- |
| `initialize` | `protocolVersion:1`；`authMethods` 单项 `["Login with opencode"]`；`agentInfo` `{name:"OpenCode", version:"2.2.5"}` | 握手健康；`auth-required` 文案只给通用登录指引（登录流程未核实） |
| `session/new` | 响应键 `[sessionId, configOptions]`（比 codebuddy 少 modes / models / multitaskOn） | 只取 `sessionId` |
| `tool_call` 形态 | **首条 `tool_call` 即全量**：name / title / kind / status / locations / rawInput 齐备——与 codebuddy 的空首事件不同 | **累加器必须兼容两种形态**：全量首事件 upsert 后即完整快照，空首事件等后续合并——冻结页 §3 的累积语义天然覆盖两者，不需要 provider 分叉 |
| 拒绝后 | 同 codebuddy：`stopReason:'cancelled'` 收尾 | 拒绝→cancelled 语义两家一致，统一映射（04 分册 §9） |
| 取消 | `session/cancel` → 20ms 返回 `cancelled`；迟到 update 2 条，`trustUpdatesAfterCancel:false` 丢弃并计数；agent 自行杀工具子进程 | 保守丢弃策略实测正确；`cancelGraceMs:5000` 裕度充足 |

### 3.2 默认权限全 allow（实测 P0：权限闸必须注入）

- **现象**：opencode 2.2.5 的默认 agent 权限为**全 allow**（仅 `.env` 读取 ask）。不注入任何配置时，对 bash 与文件写（**含 workspace 外**）从不发 `session/request_permission`——实测越界写与越界 `touch` 均静默执行并落盘。
- **后果**：权限桥（04 分册）在 opencode 上被**整体旁路**，`decideToolAccess` 根本不会被调用。这不是 wayang 的降级，是 agent 侧默认策略——但装作没看见，等于把「越界写静默落盘」当正常行为。
- **修复（两种均实测有效）**：
  1. 子进程 env `OPENCODE_CONFIG=<json>`——wayang 默认走这条（`protocol.gatePermissions`，默认 true，05 分册 §3）；实测确认**不影响用户全局 provider/model 配置**（不改写 `~/.config/opencode`）。
  2. workspace 根 `opencode.json`（内容相同）——用户自管配置时用。
- **注入内容**：`{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}`——ask-all，把每次工具执行的裁决权交回 wayang 权限桥（04 分册）。

### 3.3 注入后的权限请求形态

- 请求出现；`toolCall` 为全量形状：`name:'write'`、`kind:'edit'`、`locations`、`rawInput={path,content}`——**键名是 `path` 不是 `file_path`**（冻结页 §5 提取链 locations → file_path → path → filePath 本就覆盖两家）。
- 选项 `allow_once('once')` / `allow_always('always')` / `reject_once('reject')`——再次印证 optionId 是任意串、只能按 kind 选（04 分册 §5）。

### 3.4 差异落点（本类覆写）

| 钩子 | opencode 取值 | 依据 |
| --- | --- | --- |
| `buildLaunch` | `command:'opencode'`、`args:['acp']`；`gatePermissions !== false` 时向子进程 env 注入 `OPENCODE_CONFIG` 权限闸（05 分册 §3） | 实测：不注入则权限桥旁路（§3.2） |
| `mapPermission` | 默认实现（共享 permission-bridge），不覆写；`permissionMode:'client'` 注册 handler | 实测注入后请求形态被 bridge 覆盖（§3.3） |
| `normalizeError` | 按冻结页 §4 分类表折 `AcpError`；无 provider 特例 | 实测拒绝/取消形态与 codebuddy 同构 |
| `isReady` | 与 codebuddy 同构的 stderr 关键词 + `session/new` 超时归因（`authMethods` 非空时） | authMethods 单项 "Login with opencode"，文案只给通用指引；登录流程未核实 |
| `stopPolicy` | `cancelGraceMs:5000`、`sigtermWaitMs:2000`、`trustUpdatesAfterCancel:false`（取消后 update 一律丢弃并计数，不写 transcript） | 实测 20ms 返回、迟到 2 条丢弃（宁可丢，不让「取消之后又跑了几步」污染 transcript） |

### 3.5 opencode 的未实测项

`--login` 交互流程（0.9.0 不做登录引导，与 codebuddy 同策）；`session/load`；`plan` / `notice` / `compaction*` 变体；`mcpServers` 注入；多回合中途消息（worker 层 fake 断言覆盖，06 分册 §3）；常驻 `serve --service` 后台进程与 ACP 会话的相互作用（真机断言已按 pid 限定，06 分册 §5）。

fail-fast 文案（缺 CLI，冻结页 §4）：`ACP agent "opencode" 无法启动：<errno 摘要>。opencode：见 https://opencode.ai/docs/acp/`。**不以静默降级代替报错**：未安装就报 `cli-missing`，登录问题就报 `auth-required`，安装/登录是用户的事，wayang 不自动装、不自动引导（07 分册 §4）。

**验收含义**（06 分册 §5）：真机 opt-in 验收已交付且全绿；能力矩阵回填实测值，禁止把 fake 行为写成真机行为。

## 4. 差异落点汇总（两列对照）

| 钩子 | 骨架默认 | codebuddy | opencode |
| --- | --- | --- | --- |
| `buildLaunch` | 抛错（必须覆写） | `codebuddy --acp` | `opencode acp` + 权限闸注入（`gatePermissions` 默认 true） |
| `mapPermission` | 共享 bridge（04 分册） | 默认，不覆写 | 默认，不覆写（注入后才见请求） |
| `normalizeError` | 冻结页 §4 分类表 | 无特例 | 无特例 |
| `isReady` | 只看 `protocolVersion===1` | `session/new` 超时 + `authMethods` → auth-required | 同构归因 |
| `stopPolicy` | 5000 / 2000 / true | **8000** / 2000 / **true** | 5000 / 2000 / **false** |

## 5. 两家差异要点（实测归纳，写测试断言时对照）

| 维度 | codebuddy 2.180.0 | opencode 2.2.5 |
| --- | --- | --- |
| tool_call 首事件 | 空（`input:{}` + `rawInput:{}`，`input` 忽略），同 id 全量重发修正 kind | 全量（name / kind / status / locations / rawInput 齐备） |
| 标准工具名 | 缺（厂商名在 `_meta.codebuddy.ai/toolName`，transcript 显示 kind） | 有（如 `name:'write'`） |
| 权限请求触发面 | 原生只对副作用工具发（bash / Write） | 默认不发（全 allow）；**注入权限闸后**才有请求 |
| rawInput 键名 | bash `{command,description}`、Write `{file_path,content}`、全量重发多 `timeout` | write `{path,content}`（`path` 不是 `file_path`） |
| optionId 字面值 | `allow_always` / `allow` / `reject`（`allow_always` 排第一） | `once` / `always` / `reject` |
| 拒绝后收尾 | `cancelled` + `_meta` PERMISSION_DENIED + errorMessage（~285ms） | `cancelled`（同构） |
| 取消时延 / 迟到 update | 242ms / 3 条（保留写入） | 20ms / 2 条（丢弃计数） |

两个反向指标（code review 直接拦）：provider 类里出现「另一家也要的逻辑」→ 下沉到骨架或共享件；骨架里出现 `if (provider === …)` → 上移成钩子（02 分册 §8）。
