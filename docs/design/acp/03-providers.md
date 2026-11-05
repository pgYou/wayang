# 分册 03：provider 薄类（codebuddy / opencode）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05。
- **契约归属**：五钩子形状见 02 分册 §2；权限映射见 04 分册；启动配置 schema 见 05 分册。本册写**每个 provider 的差异点、实测事实与兜底**。与冻结页 `00-interface-freeze.md` 冲突时以冻结页为准。
- v3 范围：只有两个 provider；范围决策见主文档「不做」。

## 1. 状态总表（如实标注，禁止猜测）

| provider | type | 状态 | 依据 | 本机状态 |
| --- | --- | --- | --- | --- |
| codebuddy code | `codebuddy-acp` | **主路径，真机已实测（2026-11-05）** | 探针五步全部成功（冻结页 §9）；用户确认 cbc 可正常对话 | 已安装 2.167.0（`/usr/local/nodejs/bin/codebuddy`），登录态 |
| opencode | `opencode-acp` | **experimental，未实测** | 仅官方文档 `https://opencode.ai/docs/acp/` | 未安装（`command -v opencode` 失败） |

实测的含义：codebuddy 的行为断言来自 2026-11-05 探针输出（探针脚本 `.agents/tmp/acp-probe/probe.cjs`，不入库；全文见冻结页 §9）。**opencode 的所有相关行为一律标注「未实测」**——0.9.0 不对它做任何行为假设；缺 CLI、握手失败、认证失败一律 fail-fast（§3、07 分册），绝不静默降级。

## 2. codebuddy（`type: 'codebuddy-acp'`，主路径）

### 2.1 实测事实（2026-11-05，codebuddy 2.167.0，登录态，node v22.17.0）

环境：探针未改 codebuddy 任何配置，`clientCapabilities` 全 false，cwd 与 `session/new.cwd` 均为探针目录。五步全部成功，总耗时 27.5s：

| 步骤 | 实测结果 | 设计结论 |
| --- | --- | --- |
| `initialize` | 2921ms 返回 `protocolVersion:1`；`agentCapabilities` 含 `loadSession:true`、`promptCapabilities:{image,embeddedContext}`、`mcpCapabilities:{http,sse}` 与厂商位（`delegateToolsSupport` 等）；`authMethods` = iOA / external(Google/Github) / internal(WeChat) / selfhosted | 握手健康；厂商位进 `raw: unknown` 保留，不解释（01 分册 §4 第 5 条） |
| `session/new` | 231ms 返回 `sessionId`；响应携带 `modes` / `configOptions` / `models` / `multitaskOn` 厂商扩展字段 | 一律忽略未知字段，只取 `sessionId` |
| prompt「Reply with exactly: OK」 | 8680ms，`end_turn`；回合内 26 条 update：`available_commands_update`×4、`session_info_update`×11、`usage_update`×3、`agent_thought_chunk`×7、`agent_message_chunk`×1；无 `user_message_chunk`；全程 stderr 0 行、非 JSON 行 0、`fs/*` 请求 0 次 | `agent_thought_chunk` / `session_info_update` 必须忽略（02 分册 §5）；`agentCapabilities` 被尊重 |
| prompt「Run `echo probe-ok`」 | 7512ms，`end_turn`；工具调用三段式（空 rawInput 首事件 → 流式补齐 → 同 id 全量重发 kind 修正为 `execute`）；`request_permission` 的 `toolCall` 无 kind/title，`rawInput` 只有 `{command, description}`；选项 `allow_always`/`allow_once(optionId:'allow')`/`reject_once(optionId:'reject')`，`allow_always` 排第一；`rawOutput` 是单对象 `{type:'text',text}` 而非块数组 | 流式累积合并（01 分册 §4 第 1 条）；判定基于合并结果（04 分册 §2）；选项按 kind 选、optionId 是任意串（01 分册 §4 第 2、3 条） |
| 取消（5s 后 `session/cancel`） | 45ms 返回 `stopReason:'cancelled'`；cancel 后迟到 update 仅 1 条（`usage_update`）；SIGTERM 后约 60ms 退出 `code:0` | `cancelGraceMs` 有足够裕度；迟到 update 可信（收尾性质） |

### 2.2 未登录形态（auth-required 判据的来源）

2026-11-04 实测（未登录态）：同一进程内 `initialize` 成功后，`session/new` 25s 与 28s 两次探测**均无任何 stdout/stderr 输出**，进程被 timeout 杀死——握手成功 ≠ 可用。原因未单独核实（登录态修复后消失），但现象稳定可复现，据此 v3 的判定是（冻结页 §4）：`session/new` 在 `sessionNewMs` 内无响应且握手 `authMethods` 非空 → `auth-required`；或 stderr 命中 login/auth/unauthor/token/401 时**短路归因**（命中即判，不等超时）。文案：`"<provider>" 未登录：先在终端运行一次 "<command>" 完成登录（<authMethods 名单>）再重试`。

### 2.3 差异落点（本类覆写）

| 钩子 | codebuddy 取值 | 依据 |
| --- | --- | --- |
| `buildLaunch` | `command:'codebuddy'`、`args:['--acp']`、env 与 `process.env` 合并；command/args 可被用户配置覆盖 | 原生 stdio；实测 2.167.0。另有 `--acp-transport streamable-http`，0.9.0 不接（主文档「不做」第 2 条） |
| `mapPermission` | 默认实现（共享 permission-bridge，04 分册），不覆写 | 实测请求形态已被 bridge 的合并规则覆盖（toolCall 无 kind → 形态推断兜底） |
| `normalizeError` | 按冻结页 §4 分类表折 `AcpError`；无 provider 特例 | 实测无畸形退出形态 |
| `isReady` | `session/new` 超时 + `authMethods` 非空 → `auth-required`（§2.2）；stderr 关键词短路 | 只看握手判不出登录态 |
| `stopPolicy` | `cancelGraceMs:8000`（比默认宽——可能在等网络）、`sigtermWaitMs:2000`、`trustUpdatesAfterCancel:true`（原生实现，迟到 update 多为收尾，不该丢） | 实测 cancel 后仅 1 条迟到 usage_update、SIGTERM ~60ms 退出 |

### 2.4 codebuddy 的未实测项

`authenticate` 与 `session/load`（0.9.0 不做交互引导，02 分册 §2.6）；`plan` / `notice` / `compaction*` 变体；`mcpServers` 注入；多回合中途消息（由 06 分册 fake 用例覆盖）；`--acp-transport streamable-http`。

## 3. opencode（`type: 'opencode-acp'`，experimental）

**定位**：experimental。本机未安装（2026-11-05 核对 `command -v opencode` 失败），唯一依据是官方文档 `https://opencode.ai/docs/acp/`（「configure your editor to run the `opencode acp` command … communicates with your editor over JSON-RPC via stdio」）。**所有相关行为未实测**，0.9.0 不做任何行为假设；本类只做三件事：启动、fail-fast、保守丢弃。

| 钩子 | opencode 取值 | 状态 |
| --- | --- | --- |
| `buildLaunch` | `command:'opencode'`、`args:['acp']` | 未实测（原生 stdio 仅文档依据） |
| `mapPermission` | 默认实现（共享 permission-bridge），不覆写；`permissionMode:'client'` 注册 handler | 未实测（是否发 `request_permission` 未知；声明了 handler 而观察不到请求，能力视图如实为 false，不做降级假设） |
| `normalizeError` | 按冻结页 §4 分类表折 `AcpError`；无 provider 特例 | 未实测 |
| `isReady` | 与 codebuddy 同构的 stderr 关键词 + `session/new` 超时归因（`authMethods` 非空时） | 未实测（opencode 有自己的 auth 流程，具体命令未核实，文案只给通用指引） |
| `stopPolicy` | `cancelGraceMs:5000`、`sigtermWaitMs:2000`、`trustUpdatesAfterCancel:false`（取消后 update 一律丢弃并计数，不写 transcript） | 未实测（保守值：宁可丢，不让「取消之后又跑了几步」污染 transcript） |

fail-fast 文案（缺 CLI，冻结页 §4）：`ACP agent "opencode" 无法启动：<errno 摘要>。opencode：见 https://opencode.ai/docs/acp/`。**不以静默降级代替报错**：未安装就报 `cli-missing`，登录问题就报 `auth-required`，安装/登录是用户的事，wayang 不自动装、不自动引导（07 分册 §4）。

**experimental 的验收含义**（06 分册 §5）：opencode 只需 fake ACP server 全绿 + fail-fast 文案断言；真机链路未实测不阻塞 0.9.0 发布，能力矩阵里如实写「未实测」，禁止把 fake 行为写成真机行为。

## 4. 差异落点汇总（两列对照）

| 钩子 | 骨架默认 | codebuddy | opencode |
| --- | --- | --- | --- |
| `buildLaunch` | 抛错（必须覆写） | `codebuddy --acp` | `opencode acp` |
| `mapPermission` | 共享 bridge（04 分册） | 默认，不覆写 | 默认，不覆写 |
| `normalizeError` | 冻结页 §4 分类表 | 无特例 | 无特例 |
| `isReady` | 只看 `protocolVersion===1` | `session/new` 超时 + `authMethods` → auth-required | 同构归因 |
| `stopPolicy` | 5000 / 2000 / true | **8000** / 2000 / **true** | 5000 / 2000 / **false** |

两个反向指标（code review 直接拦）：provider 类里出现「另一家也要的逻辑」→ 下沉到骨架或共享件；骨架里出现 `if (provider === …)` → 上移成钩子（02 分册 §8）。
