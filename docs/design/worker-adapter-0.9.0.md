# ACP worker adapter 设计（0.9.0）

- 关联 issue：#25（Worker 接入扩展：以 ACP 为通用适配层接入 codex cli / codebuddy code / openCode）
- 基线：`release/0.9.0` @ `7f39791`（初版设计）／代码取证基于 0.8.3 工作区；version 0.8.3
- 取证日期：2026-11-04。代码事实给 `文件:行号`；外部事实给 URL，抓不到或未实测的一律标「未核实」。
- 本文只做设计，不含实现代码。
- **v2 修订（2026-11-04）：按类型分 worker 类。** ACP 降级为共享协议层／基类，不再是唯一 worker 实现；每个 provider 一个 worker 类，引擎仍按 `type` switch 分发。本次只重写架构（§0 结论 1-3、7 与 §3 全节）与实施计划（§4、§5、§6 风险项、§7 新增 1 条）相关章节；§1 取证的代码事实、§2 ACP 协议摘要与 §2.9 实测结论、附录 A 取证记录**未改动**。

## 0. 结论（先行）

1. **做 ACP，但 ACP 只是共享协议层；每个 provider 仍然有自己的 worker 类。** `src/services/acp/`（JSON-RPC over stdio、消息编解码、session 生命周期、取消、超时）是纯库，不含任何 wayang 业务策略。上层是 `BaseAcpWorker`（实现 `IWorkerInstance` 的通用骨架，暴露「启动命令/env、权限映射、错误归一化、就绪判定、停止策略」五个钩子）+ `CodebuddyAcpWorker` / `CodexAcpWorker` / `OpenCodeAcpWorker` 三个薄类，各自覆写本 provider 的私有差异。理由：三家的差异不是配置差异而是行为差异——codebuddy 未登录时 `session/new` 完全无响应（§2.9 实测）、codex 需要一个第三方 adapter 进程且工具命令常藏在 `title` 里、opencode 的取消语义与「后端 session abort」绑定（§3.4 逐条列）。压进一个通用实现，等于把每个 provider 的已知 bug 变成共享代码里的条件分支：修 A 家会回归 B 家，而且没有任何一个地方能完整表述某家的兜底策略。
2. **不重写 `ClaudeCodeWorker`，它也不继承 `BaseAcpWorker`。** claude-code 走的 SDK 通道具备 ACP v1 表达不了的能力（拒绝可带理由、SDK MCP 的 `ask_controller`、prompt iterable 的回合内输入句柄），改写等于净损失（`src/services/agents/claude-code-worker.ts:302-330`、`788-865`）。它继续作为一个独立的第三方 worker 实现存在（§3.2）。
3. **分发保持 `switch`，按配置里必填的 `type` 落到具体类。** 不用注册表：实现类型的集合是封闭的、编译期已知（`claude-code` / `codebuddy-acp` / `codex-acp` / `opencode-acp`），注册表只会把「漏注册」从编译期错误挪成运行期错误，并给每个新 provider 多一个注册点。`TaskExecuteEngine.createWorker`（`src/services/task-execute-engine.ts:1005-1010`）只加 case、形状不变（§3.3）；引擎里两处 `instanceof ClaudeCodeWorker`（`:1250`、`:1290`）改成能力探测，三个 ACP 类由骨架统一提供该能力，因此加 provider 不再需要动引擎。
4. **codex 必须先装 adapter 进程，codex CLI 本身不支持 ACP。** openai/codex 主分支 11032 个文件路径中 0 个含 `acp`（2026-11-04 实测）；ACP 由 `@agentclientprotocol/codex-acp`（2.5.0，2026-10-29 发布）提供，它自己会拉 `@openai/codex`。**codebuddy 原生支持**（`codebuddy --acp`，本机 2.167.0 实测 initialize 成功）；**opencode 原生支持**（`opencode acp`，官方文档）。
5. **中途消息在 ACP v1 下必然退化为「回合边界交付」**，这与 claude-code 现有实测语义一致（`claude-code-worker.ts:788-865`；PoC 记录见 `docs/develop/v0.6-design.md` §6 与 `scripts/poc-interrupt-permission.mjs`，结论是 interrupt 会留下孤立 tool_use），因此不是能力倒退；真正的「回合内注入」只在 ACP v2 draft / 厂商 steering 扩展里，0.9.0 不做。
6. **权限是本次最大的语义缺口**：ACP 的 `session/request_permission` 是「选一个选项」，不是「返回带理由的裁决」。硬拒绝（敏感路径写）只能映射成 `reject_once`，若 agent 没提供 reject 选项，只能回 `cancelled` 终止整个回合。这是 fail-closed 的代价，需要拍板（见 §6 问题 2）。
7. 粗估 **14.5 人日**（§4 第 1-7 步之和）。比原方案（一个通用 adapter，12 人日）多约 2.5 人日，全花在三份 provider 类的钩子覆写与各自 fixture 上；换回来的是「三个 provider 的 bug 互不传染」（代价分析见 §4 末）。不含三家 CLI 的账号/网络问题排查（见 §6）。

---

## 1. 现状与问题

### 1.1 worker 统一接口

`IWorkerInstance`（`src/types/worker.ts:47-89`）是引擎与 controller 看到的唯一抽象：`run(task, tools, onProgress)`（`:62-67`）、`abort()`（`:69`）、`getConversation()`（`:71`）、`getState()`（`:73`，已标 deprecated）、`acceptMessage()`（`:80`）、可选的 `getLiveStatus()`（`:82`）与 `pendingMessages()`（`:88`）。

引擎侧只按类型名分发一次（`src/services/task-execute-engine.ts:989-1011`），其余全部走接口：消息投递 `sendMessageToWorker`（`:484-499`）、审批回路 `resolvePermission`（`:500-508`）、取消 `abortByTaskId`（`:691-706`）、批量关闭 `abortAll`（`:727-752`）。**结论：新增 worker 实现不需要动引擎的调度/生命周期，只需要动分发点和两处 `instanceof`。**

### 1.2 claude-code 现有实现的分层事实

| 关注点 | 位置 | 事实 |
| --- | --- | --- |
| 进程启动 | `claude-code-worker.ts:327-330` | 通过 `@anthropic-ai/claude-agent-sdk` 的 `query({ prompt, options })` 起子进程；外层没有 `spawn`，进程完全由 SDK 托管（`:17` import）。 |
| 启动参数 | `:283-298` | `cwd` / `maxTurns`（默认 1000）/ `permissionMode`（有 signal context 时 `default`，否则 `bypassPermissions`）/ `abortController` / `env`（必须 spread `process.env`，SDK 会整体替换子进程环境，见 `:290-293` 注释）。 |
| 可执行文件 | `:299-301` | `config.cliPath` → `options.pathToClaudeCodeExecutable`。 |
| 工具/MCP 注入 | `:302-310` | 用 `createSdkMcpServer` 注入进程内 `ask_controller`（`:872-894`）。 |
| 消息投递（中途） | `:788-865` | prompt 是 `AsyncIterable`；首个 yield 是任务提示词 + 空闲期堆积的消息（`:797-812`），之后按回合边界交付队列消息（`:826-860`）。`acceptMessage`（`:489-499`）只入队，不打断。 |
| 事件解析 | `:922-931` 分派 → `:952-1030` 助手消息（text→内容、tool_use→`ToolCallRecord`）、`:1043-1074` 用户消息（tool_result→`ToolResultRecord` 合并）、`:1122-1174` 结果消息（success/error → `completed`/`failed`）。 |
| 步骤原子性 | `:991-1002`、`:1081-1098`、`:1105-1120` | 一个 LLM step 的文本+tool_use+tool_result 合并写进同一条 `AssistantEntry`（存储 append-only，见 `src/services/agents/utils/claude-tool-records.ts:1-20`）；流结束时未拿到结果的调用标 `cancelled`（`:1110-1114`）。 |
| 权限 | `:312-316` → `:581-632` | `canUseTool` 回调把 SDK 工具名映射到策略工具名（`SDK_FILE_TOOL_MAP`，`:522-533`；无路径工具白名单 `SDK_NON_PATH_TOOLS`，`:540-558`），再调 `decideToolAccess`（`src/services/tools/permission-rules.ts:737-756`）；`deny` → 直接拒绝并可带 `message`（`:641-661`）；`ask` → 发 `permission_request` 信号并阻塞等 `respond_permission`（`:691-752`，超时 300s，`:127`）。 |
| 取消 | `:435-443` | `abortController.abort()` + 丢弃去抖的 progress + 清空待决权限 + 唤醒被 park 的 prompt 迭代器；结果兜底为 `failed/'Aborted'`（`:373-379`）。 |
| 崩溃/退出 | `:345-371` | 流循环 `finally` 置 `_streamEnded/_inputClosed` 并 flush 未完成 step；异常分支落 `failed`。进程退出本身由 SDK 处理，worker 只看流。 |

### 1.3 分发与配置

- 分发：`src/services/task-execute-engine.ts:989-1011`。`type === 'puppet'` 走 `WorkerAgent`（`:993-995`），否则取 `workerConfigs[type]`（`:997-1000`），再 `switch (config.type)`（`:1005-1010`），**只有一个 case `'claude-code'`**。
- 配置：`WorkerConfig`（`src/types/config.ts:42-57`）= `type`（实现类型，`:44`）+ `enable`（`:46`）+ `emoji`（`:48`）+ `description`（`:50`）+ `capabilities`（`:52`，字符串标签）+ `maxTurns`（`:54`）+ `cliPath`（`:56`）。`WayangConfig.workers` 是以 worker ID 为键的字典（`:112`）。
- 校验：`validateConfig`（`src/types/config.ts:129-161`）**完全不校验 `workers`**——写错 `type` 不会在加载期报错，要到派发时才在 `createWorker` 抛 `Unsupported worker type`（`task-execute-engine.ts:1009`）。这是 ACP 化之后必须先补的缺口：provider 一多，配置错误的暴露点会从 1 个变成 N 个。

### 1.4 能力声明

- 配置里 `capabilities?: string[]`（`src/types/config.ts:52`）只用于给 controller 看的自然语言标签，渲染在 `buildWorkerList`（`src/services/agents/prompts/controller-prompt.ts:349-357`）。
- puppet 的默认能力是硬编码常量（`src/services/agents/worker-defaults.ts:11-20`）；展示元数据由 `getWorkerMeta` 合成（`:26-39`），**只回 `{ label, emoji }`**，没有协议能力概念。
- 运行时可见的 worker 元信息只有 `ActiveWorkerInfo`（`src/types/worker.ts:12-28`）与 `WorkerLiveStatus`（`:39-44`）。**结论：目前没有「这个 worker 支持 stream / 权限 / resume 吗」的结构化声明位，ACP 引入后必须新增，否则降级行为无处表达。**

### 1.5 问题归纳

1. 新增一种第三方 agent = 改引擎（`task-execute-engine.ts:1005-1010`）+ 复制 800 行流式解析/权限/取消逻辑（`claude-code-worker.ts` 全文件 1175 行）。
2. 引擎对实现类有硬依赖：`instanceof ClaudeCodeWorker` 出现在 `:1250`（注入 `ask_controller`）与 `:1290`（注入 signal context + 注册 permission resolver）。这两种「需要引擎配合的能力」没有接口化。
3. 配置期不校验 `workers`，错误延迟到派发；也没有「协议层参数」（command/args/env/超时）。
4. 能力声明只有说明性标签，无结构化协议能力，无法驱动「某 provider 不支持权限请求时怎么办」这类降级。
5. 工具事件模型是为 claude SDK 的形状（assistant/user 两类消息）定制的，ACP 是 `session/update` 变体流，映射规则必须显式写死，否则 TUI/controller 读取路径会分叉。

---

## 2. ACP 协议摘要（只写核实到的部分）

来源与核实日期：全部于 2026-11-04 抓取。

- 官方文档站：`https://agentclientprotocol.com/`，协议版本页 `https://agentclientprotocol.com/protocol/v1/`（overview / initialization / session-setup / prompt-turn / tool-calls / cancellation / transports）。
- schema：`https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json`（仓库已迁至 `agentclientprotocol/agent-client-protocol`，README 指向同一 schema 目录）。
- 稳定协议版本：**`1`**（`https://agentclientprotocol.com/` 仓库 README「The current stable ACP protocol version is `1`」）。`protocolVersion` 是整数，只在破坏性变更时递增；非破坏性能力靠 `initialize` 的能力协商表达。
- v2 目前是 draft（文档站标 "Schema v2 Draft"），不作为 0.9.0 目标。

### 2.1 传输与消息模型

- JSON-RPC 2.0，UTF-8；stdio 传输：客户端把 agent 作为子进程启动，**按行分隔（`\n`）的 JSON，消息内不得含裸换行**；agent 的 stderr 只放日志（`https://agentclientprotocol.com/protocol/v1/transports`）。
- 方法/通知分工：客户端 → agent 的请求（`initialize`、`session/new`、`session/prompt`…），agent → 客户端的请求（`session/request_permission`、`fs/*`、`terminal/*`），agent → 客户端的通知（`session/update`）。
- 客户端也必须能作为 JSON-RPC 服务端回应 agent 发来的请求——这是 adapter 与「单向日志解析」最本质的区别。

### 2.2 初始化

`https://agentclientprotocol.com/protocol/v1/initialization`

- 请求：`initialize { protocolVersion: 1, clientCapabilities: { fs?: {readTextFile, writeTextFile}, terminal?, auth?: {terminal}, elicitation?, session?: {...} }, clientInfo: { name, version } }`。
- 响应：`{ protocolVersion, agentCapabilities: { loadSession?, promptCapabilities?: {image, audio, embeddedContext}, mcpCapabilities?: {http, sse}, sessionCapabilities?: {...}, auth? }, agentInfo?: {name, title, version}, authMethods: [...] }`。
- 版本规则：客户端发自己支持的最高版本；agent 支持就原样回，否则回自己最高的；客户端不支持就应断开并告知用户。
- 能力语义：**未声明即不支持**。所以「我不实现 `fs/read_text_file`」必须显式给 `false`（或省略），不能靠 agent 猜。

### 2.3 会话创建

`https://agentclientprotocol.com/protocol/v1/session-setup`

- `session/new { cwd（绝对路径）, mcpServers?: McpServer[] }` → `{ sessionId, modes?, configOptions? }`。
- `McpServerStdio` = `{ name, command（绝对路径）, args?, env? }`；另有 `McpServerHttp` / `McpServerSse`。
- `session/load` 需要 agent 声明 `loadSession`；`session/resume`、`session/close`、`session/list`、`session/delete` 各自需要对应的 `sessionCapabilities.*`。

### 2.4 提示回合

`https://agentclientprotocol.com/protocol/v1/prompt-turn`

- `session/prompt { sessionId, prompt: ContentBlock[] }`，基线必须支持 `text` 与 `resource_link`；`image`/`audio`/`resource` 需要 agent 的 `promptCapabilities`。
- 回合内的所有输出走 `session/update` 通知，`update.sessionUpdate` 是判别字段。v1 全量变体（官方 schema + 文档）：
  `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`、`notice`、`compaction_update`、`compaction_summary_chunk`。
- 回合结束：agent 用 `session/prompt` 的**响应**给出 `stopReason`，取值 `end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`。响应可带 `usage`（schema 标 UNSTABLE）。
- `session/cancel` **之后必须**回 `cancelled`（协议原文：MUST，即使底层取消抛异常也要转换成这个语义化响应）。
- 关键约束：**v1 里一个 `session/prompt` 请求拥有整个回合**，回合内没有「再插一条用户消息」的标准方法。v2 draft 才把「回合生命周期」与「请求响应」解耦，允许排队/转向（`https://agentclientprotocol.com/protocol/v2/overview`，抓取自 2026-11-04 的 draft 文档）。

### 2.5 工具调用

`https://agentclientprotocol.com/protocol/v1/tool-calls`

- `tool_call`：`{ toolCallId（必填）, title（必填）, name?, kind?, status?, content?, locations?, rawInput?, rawOutput? }`。
- `kind`：`read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `switch_mode` / `other`。
- `status`：`pending` / `in_progress` / `completed` / `failed`（**没有 `cancelled` 取值**，取消只能在 client 侧自行推断）。
- `tool_call_update`：除 `toolCallId` 外全可选，只带变更字段（`name` 省略/null 表示不变，v1 无法清空 name）。
- `content` 元素：`{type:'content', content: ContentBlock}` | `{type:'diff', path, oldText?, newText}` | `{type:'terminal', terminalId}`。
- `locations[]` = `{ path（绝对路径）, line? }`。

### 2.6 权限请求

同 `tool-calls#requesting-permission` 与 `https://agentclientprotocol.com/protocol/v1/cancellation`

- agent → client：`session/request_permission { sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }`。
- `PermissionOption` = `{ optionId, name, kind }`，`kind` ∈ `allow_once` | `allow_always` | `reject_once` | `reject_always`（只是 UI 提示；记住与否由 agent 负责）。
- client 响应：`{ outcome: { outcome:'selected', optionId } }` 或 `{ outcome: { outcome:'cancelled' } }`。
- 协议硬约束：客户端发出 `session/cancel` 时，**必须**把所有待决的 permission 请求以 `cancelled` 回应。
- 安全条款（协议明确建议）：自动放行不应只看 `title`/选项名；不认识的 outcome 不得当作批准。

### 2.7 取消

- `$/cancel_request`（按 JSON-RPC id 取消任意请求）为可选机制；`session/cancel`（按 sessionId）是功能级取消，未响应请求应以 `-32800 Request Cancelled` 结束，或用该功能定义的成功响应（如 `stopReason: 'cancelled'`）结束。

### 2.8 与 wayang 现有语义的差异（设计必须直面的部分）

| 维度 | claude-code 通道（现状） | ACP v1 | 影响 |
| --- | --- | --- | --- |
| 工具事件 | assistant/user 两类消息 + tool_use/tool_result 配对 | `tool_call` + 增量 `tool_call_update` | 需要「按 toolCallId 累积」的状态机，取消状态需自行推断 |
| 拒绝表达 | `{behavior:'deny', message}` 可带理由 | 只能选 `reject_*`，无法传理由 | deny 的原因只能进审计/信号，agent 看不到 |
| 权限粒度 | 按工具名 + 入参人工判定 | 只拿到 agent 给的 `toolCall`（name/kind/locations/rawInput 可能不全） | 判定输入更弱，必须 fail-closed |
| 回合内注入 | prompt iterable 提供句柄 | 无 | 退化为回合边界交付 |
| 结果文本 | `result.result` 汇总文本 | 无「结果文本」，只有 `stopReason` | summary 需自行从最后的 agent 消息取 |
| 会话续接 | 每次 `run()` 新会话 | `session/load`/`resume` 可选 | 0.9.0 与 claude-code 对齐：不续接 |

### 2.9 三个 CLI 的 ACP 支持现状（实测/文档）

| provider | ACP 形态 | 证据 | 本机状态 |
| --- | --- | --- | --- |
| codebuddy code | **原生**：`codebuddy --acp`（stdio），另有 `--acp-transport streamable-http`；`--permission-mode` 的文档串里直接写了 "TUI, --serve Web, ACP" | 本机 `/usr/local/nodejs/bin/codebuddy` **2.167.0**，`codebuddy --help`（2026-11-04）；包 `@tencent-ai/codebuddy-code` 依赖 `@agentclientprotocol/sdk@1.7.0`；ACP registry 收录 "Codebuddy Code" | **已安装**；实测 `initialize` 立即返回 `protocolVersion: 1`，`agentCapabilities = {loadSession:true, promptCapabilities:{image:true, embeddedContext:true}, mcpCapabilities:{http:true,sse:true}, delegateToolsSupport:true, mainAgentSupport:false, multitaskSupport:true, metaPromptSupport:true}`，`authMethods = [iOA, external, internal, selfhosted]` |
| codebuddy 的 `session/new` | 未登录时**无响应** | 本机实测：同一进程内先 `initialize`（成功），再 `session/new`（cwd 指向 `.agents/tmp/probe`，`mcpServers: []`），25s 与 28s 两次探测均无任何 stdout/stderr 输出，进程被 timeout 杀死 | 原因**未核实**（可能是认证态/网络等待）；需登录后实测，见 §6 问题 5 |
| codex cli | **非原生**：ACP 由 adapter 进程提供 | openai/codex 主分支 tree 11032 条路径，**0 条**含 `acp`（`gh api repos/openai/codex/git/trees/main?recursive=1`，2026-11-04）；ACP registry 条目叫 "Codex — ACP adapter for OpenAI's coding assistant"；`@agentclientprotocol/codex-acp` 2.5.0（npm 发布 2026-10-29）README：「stdio ACP agent server. It starts the Codex App Server」，npm 包内含 `@openai/codex` 依赖，可用 `CODEX_PATH` 覆盖；旧仓 `zed-industries/codex-acp`（npm 0.16.0 / Rust，最后 push 2026-07-22）已注明迁移 | **未安装**（`command -v codex` 失败）；adapter 也未安装（未执行 `npx`，避免引入安装副作用） |
| opencode | **原生**：`opencode acp`（stdio） | 官方文档 `https://opencode.ai/docs/acp/`：「configure your editor to run the `opencode acp` command … communicates with your editor over JSON-RPC via stdio」 | **未安装**（`command -v opencode` 失败） |

补充事实：codebuddy 打包的 `@agentclientprotocol/sdk@1.7.0` 的 schema 比官方 v1 **多出厂商扩展变体**（`plan_update`、`plan_removed`、`subagent_update`、`session_message`、`session_message_chunk`，以及 NES/elicitation 相关内容）。设计上必须「只认官方 v1 变体，其余忽略并记 debug 日志」，否则会被单一厂商的 schema 绑架。

---

## 3. 目标架构

> **v2 修订：按类型分 worker 类。** 本节整体重写：从「一个 `AcpWorkerInstance` + 单一 `IAcpAdapter` + 注册表」改为「协议层 `src/services/acp/` + `BaseAcpWorker` 骨架 + 每个 provider 一个薄类 + 引擎 `switch` 分发」。旧 §3.2（claude-code 不迁移）、旧 §3.4（权限映射表）、旧 §3.5（取消/超时/退出语义）的**判定规则沿用**，只调整归属类与命名；新增 §3.4（provider 差异点清单）；配置 schema 改为 `type` 必填并列举允许值（§3.7）。

### 3.1 三层分工：协议层 / 骨架 / provider 薄类

```
TaskExecuteEngine.createWorker           ← switch (config.type)，四个 case，不做注册表
  └── IWorkerInstance（不变，src/types/worker.ts:47-89）
        ├── WorkerAgent                   （puppet，现状）
        ├── ClaudeCodeWorker              （SDK 通道，现状不动；不继承 BaseAcpWorker）
        ├── BaseAcpWorker                 （新增：ACP 通用骨架，abstract）
        │     ├── CodebuddyAcpWorker      （新增）
        │     ├── CodexAcpWorker          （新增）
        │     └── OpenCodeAcpWorker       （新增）
        │           └── 组合持有 AcpSession（每次 run() 新建一个）
        └── src/services/acp/             （协议层，纯库）
              ├── jsonrpc.ts              （id 分配 / pending / 通知分发 / 超时 / 错误码）
              ├── transport-stdio.ts      （ndjson 分帧、子进程、退出与三级 kill）
              └── session.ts              （initialize / session-new / prompt / cancel / close）
```

| 层 | 位置 | 职责 | 明确禁止 |
| --- | --- | --- | --- |
| **协议层** | `src/services/acp/` | ndjson 分帧与 JSON-RPC 路由、pending map 与超时、`initialize` / `session/new` / `session/prompt` / `session/cancel` 生命周期、子进程退出与 kill 升级、协议错误码（`-32800` / `-32601` / `-32603`） | 不读 `WayangConfig`、不写 transcript、不认识 `decideToolAccess`、不发 signal、不碰 TUI、代码里不出现任何 provider 名字 |
| **骨架** | `src/services/agents/acp/base-acp-worker.ts` | 实现 `IWorkerInstance`：`run()` 骨架（spawn → openSession → 回合循环 → 收尾）、`WorkerState` / `conversation.jsonl` 写入、`acceptMessage` 队列（回合边界交付）、`abort()`、`getLiveStatus()`、能力视图、审计埋点 | 不出现 `if (provider === …)`；不定义 provider 默认命令 |
| **provider 薄类** | `src/services/agents/acp/{codebuddy,codex,opencode}-acp-worker.ts` | 只覆写五个钩子（§3.1 下）+ 本 provider 的事件后处理 | 不自己写 JSON-RPC / 起进程 / kill；不复制 `run()` 骨架；不跨 provider 复用私有逻辑 |

要点：

- **不引入与 `IWorkerInstance` 平行的 worker 抽象**。引擎只认 `IWorkerInstance`（`task-execute-engine.ts:1013-1015`、`:1307-1335`），abortAll / cancel / message delivery 全部按接口调用（`:263-276`、`:484-499`、`:691-706`）。三个 ACP 类只是同一接口的三个实现。
- **协议层不含业务策略**，可独立单测、可复用（将来接别的 ACP consumer 也用它）。
- **依赖方向单向**：`src/services/agents/acp/**` → `src/services/acp/**`，反向不成立。协议层不认识 `AcpLaunch.preflight`（本地预检是 worker 层的事），`buildLaunch()` 跑完预检后只把 `{command, args, env}` 作为 `AcpLaunchSpec` 传进去。
- **ACP 特有的三件事必须有单一归属**：进程句柄（协议层）、回合状态机（骨架的 `run()`）、权限应答（钩子 2 + 共享 permission-bridge）。三者都不向引擎外泄——引擎看到的和 puppet / claude-code 完全一样。

**骨架暴露的五个钩子**（只定形状，不写实现）：

```ts
// src/services/agents/acp/base-acp-worker.ts
export interface AcpLaunch {
  command: string;
  args: string[];
  /** 已与 process.env 合并后的最终环境（子进程继承）。 */
  env: Record<string, string>;
  /** spawn 之前的本地预检：返回非 null 即直接失败（缺 CLI / 缺 adapter）。 */
  preflight?: () => Promise<string | null>;
}

export interface AcpStopPolicy {
  /** session/cancel 之后等 stopReason 的宽限；超时进 SIGTERM。 */
  cancelGraceMs: number;
  /** SIGTERM 之后等多久 SIGKILL。 */
  sigtermWaitMs: number;
  /** 取消后是否仍信任 agent 的后续 session/update（opencode / codex 为 false，§3.4）。 */
  trustUpdatesAfterCancel: boolean;
}

export interface AcpReadyContext {
  handshake: AcpHandshake;             // 已协商结果（含 authMethods，用于登录态归因）
  phase: 'handshake' | 'session-new';  // 判定时机：握手后 / session/new 失败后
  error?: unknown;                     // phase === 'session-new' 时的原始错误（超时 / JSON-RPC error）
  stderrTail: string[];                // 最近 N 行 stderr，供关键词归因
}

export interface AcpReadiness {
  ready: boolean;
  /** 未就绪的归因：auth-required / cli-missing / adapter-missing / unknown。 */
  kind?: AcpFailureKind;
  /** 直接给用户看的文案（含该 provider 的登录/安装指引）。 */
  message?: string;
}

export abstract class BaseAcpWorker implements IWorkerInstance {
  /** 1) 启动：command / args / env / cwd 与本地预检。 */
  protected abstract buildLaunch(env: WorkerEnvView): AcpLaunch;
  /** 2) 权限：ACP request → decideToolAccess → outcome（默认走共享 permission-bridge）。 */
  protected abstract mapPermission(
    req: AcpPermissionRequest,
    ctx: PermissionContext,
  ): Promise<AcpPermissionOutcome>;
  /** 3) 错误归一化：session 错误 + 退出码 + stderr 尾行 → 一条可读失败。 */
  protected abstract normalizeError(err: unknown, phase: AcpPhase): AcpFailure;
  /** 4) 就绪判定：握手结果 / session-new 失败是否等价于「可用」（未登录探测在这里）。 */
  protected abstract isReady(ctx: AcpReadyContext): AcpReadiness;
  /** 5) 停止策略：取消宽限、kill 升级、取消后是否信任后续输出。 */
  protected abstract stopPolicy(): AcpStopPolicy;
}
```

**为什么是组合而不是让 `AcpSession` 当基类**：`AcpSession` 必须能在「worker 已经决定失败」之后被单独关闭（codex 的 preflight 通过但 adapter 起不来要干净地 kill），也要能在 agent 崩溃后重开一次。`AcpSession` 是资源句柄，`BaseAcpWorker` 是生命周期所有者；串成继承链会让「谁负责 kill」变含糊。

**协议层契约**：

```ts
// src/services/acp/session.ts
export interface AcpLaunchSpec {
  command: string;                    // 协议层只认这三个字段，不认识 provider / preflight
  args: string[];
  env: Record<string, string>;
}

export interface AcpSessionOptions {
  launch: AcpLaunchSpec;              // provider 类的 buildLaunch() 的产物（AcpLaunch 去掉 preflight 后传入）
  cwd: string;                        // 任务 workspace（绝对路径）
  clientInfo: { name: string; version: string };
  clientCapabilities?: AcpClientCapabilities;
  handshakeTimeoutMs?: number;        // 默认 15000（codex 覆写为 30000，§3.4.2）
  sessionNewTimeoutMs?: number;       // 默认 30000（codebuddy 未登录就靠它抓，§3.4.1）
  stderrSink?: (line: string) => void; // 只记日志，不进 transcript
}

export interface AcpHandshake {
  protocolVersion: number;            // agent 回的版本（1 才继续）
  agentCapabilities: AcpAgentCapabilities;
  agentInfo?: { name: string; title?: string; version: string };
  authMethods: AcpAuthMethod[];
  pid: number;
}

export interface AcpTurnResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  usage?: AcpUsage;
}

export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 取消路径下为 true，用于区分「取消」与「崩溃」。 */
  cancelled: boolean;
  stderrTail: string[];               // 最近 N 行，脱敏/截断后用于报错
}

export interface AcpSession {
  /** 起进程并完成 initialize；失败必须 kill 子进程再抛错（不留孤儿）。 */
  start(): Promise<AcpHandshake>;

  /** session/new（0.9.0 不用 session/load）；返回 sessionId。 */
  openSession(opts: { cwd: string; additionalDirectories?: string[]; mcpServers?: AcpMcpServer[] }): Promise<string>;

  /**
   * session/prompt，resolve 于该回合结束的 stopReason。
   * 同一 session 串行：上一回合未 settle 前不得再调用（ACP v1 语义，§2.4）。
   */
  prompt(input: { blocks: AcpContentBlock[]; timeoutMs?: number }): Promise<AcpTurnResult>;

  /** 订阅 session/update 流；回调同步执行，抛错不得影响读循环。 */
  onUpdate(handler: (e: AcpSessionEvent) => void): () => void;

  /** 注册权限处理器：必须返回一个 outcome，session 负责回写 JSON-RPC 响应。 */
  onPermissionRequest(handler: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>): () => void;

  /** session/cancel（通知），不等结果；回合以 cancelled stopReason 收尾（§2.7）。 */
  cancel(reason: 'user' | 'timeout' | 'shutdown'): Promise<void>;

  /** cancel → 等 cancelGraceMs → SIGTERM → 等 sigtermWaitMs → SIGKILL；幂等。 */
  close(reason: 'run-finished' | 'abort' | 'shutdown' | 'crash'): Promise<AcpExitInfo>;

  /** 协商结果 + provider 覆盖合并后的能力视图。 */
  capabilities(): AcpCapabilities;
}
```

`AcpCapabilities` 是给上层看的稳定视图，与协议字段解耦：

```ts
// src/services/acp/capabilities.ts
export interface AcpCapabilities {
  provider: string;            // worker 类自报：'codebuddy-acp' / 'codex-acp' / 'opencode-acp'
  protocolVersion: number;
  streaming: boolean;          // 恒为 true（session/update 存在）
  toolCalls: boolean;          // 观察到 tool_call 变体
  permissionRequests: boolean; // agent 是否真的会发 request_permission（provider 默认 + 配置可覆盖）
  loadSession: boolean;
  midTurnInject: false;        // 0.9.0 恒为 false，字段先占位，语义显式
  inquiry: boolean;            // ask_controller 是否可用（0.9.0 全 provider 默认 false，见 §3.8）
  authRequired: boolean;       // isReady() 判定出的登录态
}
```

**为什么不再多拆一层**：

- 不合并成「一个 AcpWorker + 三组 profile」：§3.4 的五类差异里只有「启动方式」能用 profile 表达，另外四类（认证归因、权限选项、取消、退出码）都是**控制流**差异，profile 只能退化成 `if (provider === 'codex')`。
- 不拆成 Transport / Codec / Lifecycle / Policy 四五个包：0.9.0 只有一个 client 实现，拆细只增加 import 噪音，协议层内部三个文件已经够。

### 3.2 claude-code 的迁移结论

> **v2 修订：按类型分 worker 类。** 本节结论不变（不迁移），只把「注册进工厂表」改为「`switch` 的一个 case」，并明确它**不继承 `BaseAcpWorker`、不碰协议层**。

**0.9.0 不迁移 `ClaudeCodeWorker` 到 ACP，只做三件事：**

1. 让它继续做 `switch` 里的一个 case（`case 'claude-code'`，`task-execute-engine.ts:1005-1010`），行为零变化。
2. 把引擎里的两处 `instanceof ClaudeCodeWorker`（`task-execute-engine.ts:1250`、`:1290`）改为能力探测，让「需要引擎配合的第三方 worker」有统一入口（见 §3.3）。判定条件用可选成员：`typeof worker.setSignalContext === 'function'` / `typeof worker.setInquirySupport === 'function'`，并把这两个方法提到 `IWorkerInstance` 的可选成员上（`src/types/worker.ts` 加 4 行，标注「第三方 worker 能力」）。**三个 ACP worker 由 `BaseAcpWorker` 统一实现这两个可选成员，所以引擎只改这一次，之后加 provider 不用再动。**
3. 在 `WorkerConfig.type` 上保持 `'claude-code'` 不变，`cliPath` 语义不变（不做清单第 1 条）。

不迁移的理由（可复核）：

- `canUseTool` 的拒绝能带 `message`，ACP 只能 `reject_*`（§2.8）。
- `ask_controller` 走 in-process SDK MCP（`claude-code-worker.ts:302-310`、`:872-894`），ACP 侧没有等价物（ACP 的 MCP 是「client 起 server 给 agent 用」，需要另写一个 MCP server 进程，见 §3.8）。
- prompt iterable 让「回合边界交付」的实现非常直接（`:788-865`），改写成 ACP 需要先绕开 SDK，收益为负。
- 迁移成本（如果要）：约 5-7 人日，且需要先补齐 ACP 侧的 deny 语义与 inquiry 通道；不建议在 0.9.0 做。

**明确保留兼容层**：`ClaudeCodeWorker` 类继续存在，直到 ACP 侧功能对等（deny 带理由 + inquiry）后再评估。届时它只是 `switch` 的一个 `case 'claude-code-legacy'`，删或留由数据说话（用户配置里 `type: 'claude-code'` 的存量）。

### 3.3 provider 分发：switch 保持，按 `type` 落到具体类

> **v2 修订：按类型分 worker 类。** 原方案（注册表 + `registerWorkerType`）作废。理由：实现类型的集合是封闭的、编译期已知，注册表把「漏注册」从编译期错误变成运行期错误，还给每个新 provider 加一个注册点与一段加载顺序问题。**只有 provider 变成用户可插件化时才值得抽象**，0.9.0 不是。

现状（`task-execute-engine.ts:989-1011`）的职责本来就是三段：解析（puppet vs 配置）、校验（enable / 未知）、构造（`switch`）。三段全保留，只把 `switch` 的 case 从 1 个扩到 4 个：

```ts
// src/services/task-execute-engine.ts（createWorker 内，形状不变）
switch (config.type) {
  case 'claude-code':
    return new ClaudeCodeWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
  case 'codebuddy-acp':
    return new CodebuddyAcpWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
  case 'codex-acp':
    return new CodexAcpWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
  case 'opencode-acp':
    return new OpenCodeAcpWorker(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills);
  default:
    // 未知类型的文案必须列出允许值；形状校验在 validateConfig 已先兜一次（§3.7）
    throw new Error(
      `Unsupported worker type "${config.type}" for worker "${type}". Supported types: ${WORKER_TYPES.join(', ')}`,
    );
}
```

- **puppet 不进 `switch`**：它需要 provider / model / toolChoice（`task-execute-engine.ts:993-995`），不是 `WorkerConfig` 能表达的，保持前置独立分支。
- **`WORKER_TYPES` 是唯一真源**（`src/types/config.ts`）：`export const WORKER_TYPES = ['claude-code', 'codebuddy-acp', 'codex-acp', 'opencode-acp'] as const;` —— `switch` 的 case、`validateConfig` 的允许值、错误文案、文档示例全部引用它。加 provider 时 `switch` 末尾的穷尽检查（`const _exhaustive: never = config.type;`）会让 `npm run lint` 直接报错，不会漏 case。
- **构造函数签名统一**：四家都是 `(config, sessionDir, workspaceDir, ctx, skills)`，与 `ClaudeCodeWorker`（`task-execute-engine.ts:1007`）一致，`switch` 里没有分叉的参数拼装。
- **测试不走「注册假实现」**：每个 provider 类的单测直接 `new CodebuddyAcpWorker(fakeConfig, …)`；e2e 用 fake ACP agent 子进程（§5.2），不依赖引擎注入点。
- **不新增 `src/services/agents/index.ts` 聚合出口**：仓库当前也没有这个文件，不为了「有个地方注册」而造一个。

### 3.4 每个 provider 的差异点清单（为什么需要三个类）

> **v2 修订：按类型分 worker 类。** 本节新增，是「不用一个通用 ACP worker 吞掉所有类型」的论证主体——每条都写清「差异是什么、为什么必须单独一类、兜底怎么做」。

**尺子**：只有能用配置表达的差异留在配置里（`command` / `args` / `env` / 超时 / `permissionMode`）；凡是影响**控制流**的差异，一律进对应 provider 类（即 `buildLaunch` / `mapPermission` / `normalizeError` / `isReady` / `stopPolicy` 五个钩子）。

#### 3.4.0 共性（留在 `BaseAcpWorker` 与协议层，provider 类不许重写）

- `run()` 骨架：spawn → `openSession` → 回合循环（`prompt` → 队列里的中途消息作为下一个回合）→ 收尾写 `System/TaskResult|Error` 条目 → 返回 `WorkerResult`（与 `claude-code-worker.ts:345-403` 同序）。
- transcript / 状态：`WorkerState` + `applyTurnEnvelope`，条目形状与 puppet / claude-code 完全一致（§3.8 的硬约束）。
- `session/update` → `ToolCallRecord` 的累积状态机（`event-mapper.ts`），官方 v1 之外的变体一律 debug 丢弃。
- `acceptMessage` 的回合边界交付语义与 `_inputClosed` 判定（对齐 `claude-code-worker.ts:489-499`）。
- `stopReason` → 结果映射：`end_turn` → completed；`max_tokens` / `max_turn_requests` / `refusal` → failed（带原因）；`cancelled` → failed('Aborted')，由引擎的 `consumeCancelled` 抑制多余信号（`task-execute-engine.ts:1307-1316`）。
- 权限的 fail-closed 三条硬规则与 `decideToolAccess` 映射表（§3.5）。
- 超时矩阵的默认值与三级 kill（§3.6）。

#### 3.4.1 codebuddy（`type: 'codebuddy-acp'`）

| 维度 | 差异（事实 + 来源） | 兜底（在本类里怎么做） |
| --- | --- | --- |
| 启动方式 | `codebuddy --acp`（原生 stdio）；本机 **2.167.0** 实测 `initialize` 立即返回 `protocolVersion: 1`（§2.9）。另有 `--acp-transport streamable-http`，0.9.0 不接（§7 第 2 条） | `buildLaunch()`：`command: 'codebuddy'`、`args: ['--acp']`、`env` 与 `process.env` 合并；`command` / `args` 可被配置覆盖（换包管理器路径）。`preflight()` 只查可执行文件是否存在，不做 `--version` 探测（省一次进程启动） |
| 未登录 / 认证失败 | 未登录时 `initialize` **成功**、`session/new` 25s 与 28s 两次探测**无任何 stdout/stderr**（§2.9 实测）；`authMethods = [iOA, external, internal, selfhosted]` | 只靠握手判不出来，所以把 `session/new` 超时当第一判据：`sessionNewTimeoutMs = 30000`；超时且 `authMethods.length > 0` → `isReady()` 返回 `{ready:false, kind:'auth-required'}`，文案「codebuddy 未登录：先在终端运行一次 `codebuddy` 完成登录（iOA / external / internal / selfhosted 任一）再重试」。stderr 命中 login / auth / unauthor / token / 401 时不看超时、直接按 `auth-required` 归因（避免白等 30s） |
| 权限请求选项 | 打包的 `@agentclientprotocol/sdk@1.7.0` schema 含官方之外的变体（`plan_update` / `plan_removed` / `subagent_update` / `session_message` 等，§2.9）；`request_permission` 是否总带 reject 选项、`toolCall.kind` 是否总带，**未核实**（需登录后实测） | `mapPermission()` 用共享 permission-bridge，本类只覆写两个兜底点：(a) 选项集只有 `allow_always` → 仍选它（协议规定「记住与否」由 agent 负责，§2.6）；(b) 选项集里既无 allow 也无 reject（畸形）→ 回 `cancelled` + 审计 `protocol-mismatch`。未知 `sessionUpdate` 变体只 debug 记录，连续 50 条才判协议失配 |
| 取消与超时 | `session/cancel` 后是否真回 `cancelled` **未核实**；node 进程，SIGTERM 一般能退，但可能留下自己的子进程 | `stopPolicy()`：`cancelGraceMs: 8000`（比另两家宽——它可能在等网络）、`sigtermWaitMs: 2000`、`trustUpdatesAfterCancel: true`（原生实现，取消后的 update 多为收尾，不该丢） |
| 进程退出码语义 | 未核实。已知一种形态：无响应被 `timeout` / SIGKILL 杀掉时 `code === null, signal === 'SIGKILL'` | `normalizeError()`：`signal === 'SIGKILL'` 且握手已完成 → 归 `auth-required`／无响应（而不是「崩溃」），文案带「会话未建立」；`code !== 0` → `exited(code)` + stderr 尾 20 行；`code === 0` 但回合未 settle → `protocol-mismatch` |

**为什么必须单独一类**：codebuddy 是三家唯一「握手成功 ≠ 可用」的 provider，`auth-required` 的判定依赖「`session/new` 超时 + `authMethods` 非空 + stderr 关键词」三者组合。这套逻辑放进通用层就会对 codex / opencode 一并生效，把它们的普通超时误报成「未登录」。

#### 3.4.2 codex（`type: 'codex-acp'`）

| 维度 | 差异（事实 + 来源） | 兜底（在本类里怎么做） |
| --- | --- | --- |
| 启动方式 | **codex CLI 本身不支持 ACP**：openai/codex 主分支 11032 条路径中 0 条含 `acp`（§2.9 实测）；ACP 由 `@agentclientprotocol/codex-acp`（2.5.0）提供，它自己拉 `@openai/codex`，可用 `CODEX_PATH` 覆盖，README 说它「starts the Codex App Server」 | 两级 `preflight()`：(a) `command`（默认 `codex-acp`）不存在 → 文案「未安装 codex 的 ACP adapter：`npm i -g @agentclientprotocol/codex-acp`」；(b) adapter 起来后 stderr 命中 codex not found / ENOENT → 文案「adapter 找不到 codex，请设置 `CODEX_PATH` 指向 codex 可执行文件」。`handshakeTimeoutMs` 默认放宽到 **30000**（adapter 要先起 App Server，比原生慢），配置可覆盖 |
| 未登录 / 认证失败 | codex 需要 OpenAI 账号（`codex login` 或 `OPENAI_API_KEY`）；adapter 用 JSON-RPC error 还是 stderr 表达认证失败，**未核实**（只读了 README） | `isReady()` 只看握手（`authMethods` 有值不代表未登录）；实际归因放在 `normalizeError()`：`session/new` 或首个 prompt 失败且 stderr 命中 401 / unauthor / login / api key / OPENAI_API_KEY → `auth-required`，文案「先 `codex login`，或设置 `OPENAI_API_KEY`」；未命中 → `unknown`，只保留 stderr 尾行，不给误导性结论 |
| 权限请求选项 | codex 的工具是 shell 命令包装，命令可能落在 `rawInput.command`（字符串或数组）、`parsed_cmd[]`，或只出现在 `title`（如 `Run: …`）里；**未核实**具体形状 | 覆写 `mapPermission()` 的命令提取顺序：`rawInput.command`（string / string[] join）→ `rawInput.cmd` → `rawInput.parsed_cmd[0].cmd` → `title` 去掉 `Run:` / `$` 前缀。**仍取不到 → `ask`（fail-closed），绝不 `allow`**：codex 的 `execute` 占比最高，命令提取错等于审批闸门失效，这是本类存在的首要理由 |
| 取消与超时 | adapter 只是转发层，`session/cancel` 是否被转发给 Codex App Server **未核实**，可能永远等不到 `stopReason:'cancelled'` | `stopPolicy()`：`cancelGraceMs: 3000`（比通用短——等不到就别等）、`sigtermWaitMs: 2000`、`trustUpdatesAfterCancel: false`。`abort()` 之后立刻置 `_inputClosed = true`，`acceptMessage` 返回 false（不再假装能排队） |
| 进程退出码语义 | adapter 进程的退出码**可能不反映 Codex 的真实结果**（可能 0 退出但回合没收尾），未核实 | 判决以「有无 stopReason」为主判据，退出码只用于文案：`code !== 0` → `exited(code)` + stderr 尾行；`code === 0` 但回合未 settle → `protocol-mismatch`，文案「codex-acp 已退出但未返回回合结果」；`cancelled === true` → failed('Aborted')，不报崩溃 |

**为什么必须单独一类**：codex 有两处别家没有的东西——「必须有第三方 adapter 进程」这个前置条件（缺失时的探测方式与文案完全不同），以及「命令藏在 `title` 里」这个权限输入缺口（它决定 fail-closed 的具体实现）。塞进通用层的话，通用层要为一家的 adapter 概念引入 `preflight` 抽象（另两家用不上），并为一家的 `rawInput` 形状加特判。

#### 3.4.3 opencode（`type: 'opencode-acp'`）

| 维度 | 差异（事实 + 来源） | 兜底（在本类里怎么做） |
| --- | --- | --- |
| 启动方式 | **原生**：`opencode acp`（stdio），官方文档原文「run the `opencode acp` command … over JSON-RPC via stdio」（§2.9）；本机未安装 | `buildLaunch()`：`command: 'opencode'`、`args: ['acp']`；`preflight()` 失败文案「未安装 opencode：见 https://opencode.ai/docs/acp/」 |
| 未登录 / 认证失败 | opencode 有自己的 auth 登录流程，**未核实**具体命令与 ACP 下的表现 | 与 codex 同构的 stderr 关键词归因，文案换成 opencode 的登录指引；不做 `authenticate` 交互（§6 问题 5 的结论对三家一致） |
| 权限请求选项 | opencode 的 ACP 实现是否发 `session/request_permission` **未核实**；它可能自管权限、完全不发 | 本类把能力视图中 `permissionRequests` 的**默认值设为 `false`**（如实表达「未观察到」），配置可覆盖为 `true`。声明 `false` 却仍收到请求 → 回 `cancelled` + 审计 `protocol-mismatch`（不静默放行，也不静默接受）。**这条必须写在本类**：它是单家事实，写进通用层会让另两家被误降级 |
| 取消与超时 | 取消与「后端 session 的 abort」绑定，`session/cancel` 之后仍可能继续推 `session/update`（**未核实**） | `stopPolicy()`：`trustUpdatesAfterCancel: false` —— 取消后收到的 update 一律**丢弃并计数**，debug 日志记 `discarded_after_cancel`，避免 transcript 出现「取消之后又跑了几步」的污染；`cancelGraceMs: 5000`（默认），超时 SIGTERM → SIGKILL |
| 进程退出码语义 | 原生 CLI，`0` 正常 / `1` 错误、SIGTERM 是否优雅退出，**未核实** | 默认映射：`cancelled` 标记为真 → failed('Aborted')；`code === 130 or 143` → 视为被信号中断，failed 且文案标 `interrupted`；其余非 0 → `exited(code)` + stderr 尾 20 行 |

**为什么必须单独一类**：「取消后不信任 agent 的后续输出」是一条与 provider 观察强绑定的策略。放在通用层，要么对 codebuddy 也无脑丢弃（丢掉合法收尾），要么根本不实现（opencode 的迟到事件污染 transcript）。只有单独一类才能既保守又不误伤。

#### 3.4.4 差异落点汇总

| 钩子 | 骨架默认 | codebuddy | codex | opencode |
| --- | --- | --- | --- | --- |
| `buildLaunch` | 抛错（必须覆写） | `codebuddy --acp` | `codex-acp`，握手 30s，两级 preflight | `opencode acp` |
| `mapPermission` | 共享 bridge（§3.5 表） | 仅 `allow_always` / 畸形选项兜底 | 命令提取顺序 + 取不到即 ask | `permissionRequests` 默认 false + 失配回 cancelled |
| `normalizeError` | 通用 exit / stderr | SIGKILL + 握手完成 → auth-required | stderr auth 关键词 + 「退出但无 stopReason」 | 130 / 143 → interrupted |
| `isReady` | 只看 `protocolVersion === 1` | `session/new` 超时 + `authMethods` → auth-required | 握手恒 ready（归因在 normalizeError） | 握手恒 ready（归因在 normalizeError） |
| `stopPolicy` | 5000 / 2000 / true | 8000 / 2000 / true | 3000 / 2000 / **false** | 5000 / 2000 / **false** |

**两个反向指标**：provider 类里出现「另两家也要的逻辑」→ 下沉到骨架或协议层；骨架里出现 `if (provider === …)` → 上移成钩子。两个方向的漂移在 code review 里直接拦下（§7 第 12 条）。

### 3.5 权限：ACP 的 permission 请求如何映射到 `decideToolAccess`

> **v2 修订：按类型分 worker 类。** 判定表与 fail-closed 规则**不变**；变化只有归属：这套映射是共享件 `src/services/agents/acp/permission-bridge.ts`，由每个 provider 类在 `mapPermission()` 钩子里调用（默认实现就是直接调用它，只有 codex / opencode 需要覆写提取顺序或默认能力，见 §3.4.2、§3.4.3）。

**判定输入**：`session/request_permission` 的 `params.toolCall`（`ToolCallUpdate`）+ 同 id 的 `tool_call` 事件里累积的字段（`rawInput`/`locations` 可能只在其中一次出现，必须按 toolCallId 合并后判定）。

**映射表**（`AcpPermissionRequest` → `decideToolAccess(scope, toolName, args)`，与 `handleCanUseTool` 保持同构，`claude-code-worker.ts:581-632`）：

| ACP `kind` | 策略工具名 | args 取值顺序 | 取不到目标时 |
| --- | --- | --- | --- |
| `execute` | `bash` | `rawInput.command` → `rawInput.cmd` → `toolCall.title`（仅当日志用，不参与判定；codex 类额外接受 `parsed_cmd[]` 与 title 前缀解析，§3.4.2） | 无 command 字符串 → `ask`（reason: command 无法确定） |
| `read` | `read_file` | `locations[0].path` → `rawInput.file_path` → `rawInput.path` → `rawInput.filePath` | `ask` |
| `edit` | `edit_file` | 同上 | `ask` |
| `delete` / `move` | `write_file` | 同上 | `ask` |
| `search` | `search_content` | `locations[0].path` → `rawInput.path` | 无路径 → `allow`（等价于 workspace 内默认，对齐 `SDK_FILE_TOOL_MAP` 的 `pathRequired:false`，`:531-532`） |
| `fetch` / `think` / `switch_mode` | — | — | `allow`（无文件系统目标，对齐 `SDK_NON_PATH_TOOLS`，`:540-558`） |
| `other` / 缺失 | `write_file`（若有可辨识路径）否则 `ask` | 同上 | `ask`（不认识就不放行） |

**裁决 → ACP outcome**：

| `decideToolAccess` 结果 | ACP 响应 | 说明 |
| --- | --- | --- |
| `allow` | 选 `kind === 'allow_once'` 的选项 | 若 agent 只提供 `allow_always`，仍选它（协议要求 agent 自己管理记忆，client 只做 UI 提示，§2.6） |
| `ask` | 发 `permission_request` 信号（复用 `PermissionRequestSignalPayload`），阻塞等 `respond_permission`（超时 300s，沿用 `claude-code-worker.ts:127`）→ 批准选 `allow_once`，拒绝选 `reject_once` | 载荷字段用现有形状（toolName/toolArgs/description/operation/matchedRule/matchedEntry/resolvedPath/sensitive/access），`toolName` 填 ACP 的 `name ?? kind`，`toolArgs` 填合并后的 `rawInput`（缺失则 `{locations}`） |
| `deny`（敏感写） | 选 `kind === 'reject_once'` 的选项；**没有 reject 选项时回 `{outcome:'cancelled'}`** 并把该 run 判为失败（fail-closed） | ACP 无「带理由的拒绝」，理由只进审计与信号 |

**fail-closed 的三条硬规则**（共享 bridge 里实现一次，任何 provider 都不许放宽）：

1. 判定所需输入缺失（拿不到 kind、拿不到 command/path）→ `ask`，永不 `allow`。
2. 选项集合里既没有 allow 也没有 reject（畸形 agent）→ 回 `cancelled` 并记审计 `decision: 'denied'`、`source: 'protocol-mismatch'`。
3. 任何 JSON-RPC 错误、超时、子进程退出，一律按拒绝处理（不能「没回就当放行」）。

**审计与信号**：复用 `recordPermissionAudit`（`src/services/permission/permission-audit.ts`，与 puppet / claude-code 同一份记录形状，`claude-code-worker.ts:735-750`），新增两个只读字段 `transport: 'acp'`、`provider: <config.type>`（如 `codex-acp`），便于事后按 provider 统计审批分布——这也是三分类相对单类的一个直接收益：审计能按 provider 归因。

**permissionMode**：`'client'`（默认）时注册 handler 并走上表；`'agent'` 时不注册（显式放弃 client 侧管控，用于已知自带沙箱/审批的 agent）。`'agent'` 下若 agent 仍发请求 → 回 `cancelled` + 审计 `protocol-mismatch`（不静默放行）。

**必须写进文档的安全边界**：client 声明不支持 `fs/*`、`terminal/*` 后，工具由 agent 自己执行；**只有 agent 主动发 `request_permission` 时才可拦**。agent 若在自身策略下直接执行（等价于 claude-code 的 `bypassPermissions`，`claude-code-worker.ts:268-273` 的注释），wayang 无法阻止。这一点与现状态一致，不是 ACP 引入的退步，但必须在 README/配置示例中明说。

### 3.6 取消、超时、进程退出、崩溃恢复

> **v2 修订：按类型分 worker 类。** 本节语义不变，只是把「宽限时长 / 是否信任取消后的输出 / kill 升级」参数化到 `stopPolicy()` 钩子（默认值在此，各 provider 覆写见 §3.4.4 汇总表）。

**取消链路**（对齐现有 `cancel_task → abortByTaskId → worker.abort()`，`task-execute-engine.ts:263-276`、`:691-706`）：

1. `abort()` 置内部 `aborted`，调用 `session.cancel('user')`（发 `session/cancel`）。
2. **同时**把所有待决 permission 请求以 `{outcome:'cancelled'}` 回写（协议硬要求，§2.6），并 cleanup pending map。
3. 等待进行中的 `prompt()` 以 `stopReason === 'cancelled'` 正常返回：**这条路径不是崩溃**——`_terminalResult` 记为 `{status:'failed', error:'Aborted'}`，与 claude-code 的兜底一致（`claude-code-worker.ts:373-379`），引擎侧 `consumeCancelled` 会抑制多余的 failed 信号（`task-execute-engine.ts:1307-1316`）。
4. 超过 `stopPolicy().cancelGraceMs`（默认 5000，codebuddy 8000 / codex 3000）未 settle → `SIGTERM`；再过 `sigtermWaitMs`（默认 2000）→ `SIGKILL`；两条都记 warn。
5. `trustUpdatesAfterCancel === false` 的 provider：取消之后到达的 `session/update` 直接丢弃并计数（日志 `discarded_after_cancel`），不写 transcript、不推进度。

**超时矩阵**：

| 阶段 | 默认值 | 触发后 |
| --- | --- | --- |
| spawn + initialize | 15000ms（codex 30000） | kill 子进程，run 失败，错误文案提示「CLI 是否支持 --acp / 是否需要登录」 |
| session/new | 30000ms（`sessionNewTimeoutMs`） | 同上；对 codebuddy 未登录的实测现象直接生效（§2.9、§3.4.1），按 `auth-required` 归因 |
| 单次 `session/prompt` | 不设（0 = 无限） | 由外部 `cancel_task` 或 idle 机制处理；配置可开，开了就按 cancel 处理并标失败 |
| permission 等待 | 300000ms（沿用） | 选 reject_once，审计 `source:'timeout'` |
| shutdown | `cancelGraceMs` + `sigtermWaitMs` | 强制 SIGKILL，记 warn |

**进程退出**：

- `exit` 且 `cancelled === false`、且当前有未 settle 的回合 → `failed`，error 由 `normalizeError()` 生成（一般含 `ACP agent exited (code=N)` 与 stderr 尾部 20 行；截断到 2000 字符，走 `truncateForStorage` 同款处理（`src/services/agents/utils/claude-tool-records.ts:39-42`））。
- `exit` 且无进行中回合（idle/multi-stage 等待中）→ 标记会话失效，`acceptMessage` 返回 false，`get_worker_status` 能看出「已结束」（对齐 `WorkerLiveStatus`，`src/types/worker.ts:39-44`）。
- stdout 上出现非 JSON 行（违反协议）→ 记 debug 跳过，不杀进程（有些实现会混打印日志）；连续 N 条（默认 50）才判协议失配并失败。

**崩溃恢复**：

- worker 进程与 wayang 进程同生命周期，不跨会话存活。wayang 崩溃时任务由 `recoverCrashedTasks` 统一置 failed（`task-execute-engine.ts:1426-1433`），ACP 侧不需要额外状态。
- **孤儿进程**：`close()` 的三阶段 kill 是主防线；`start()` 时把 `pid` 记到 `<sessionDir>/workers/<workerId>/runtime-state.json` 的 `runtimeState.acp = { pid, command, provider }`（复用 `WorkerState`，`src/services/agents/worker-state.ts`），为后续「启动时扫孤儿」留证据。**0.9.0 不做自动清理**（不做清单第 8 条），只记录。

### 3.7 配置 schema：`type` 必填 + 各 provider 的覆盖位

> **v2 修订：按类型分 worker 类。** 原方案的 `type: 'acp'` 单值作废：`type` 现在是**必填的枚举**，一个值对应一个 worker 类。`command/args/env` 仍可覆盖，但语义变成「覆盖该类的默认启动方式」，而不是「选一个通用实现」。

`WorkerConfig`（`src/types/config.ts:42-57`）改造：

| 字段 | 类型 | 默认 | 说明 / 校验 |
| --- | --- | --- | --- |
| `type` | `WorkerType` | **必填** | 允许值：`'claude-code'` \| `'codebuddy-acp'` \| `'codex-acp'` \| `'opencode-acp'`。缺失或不在枚举内 → 加载期报错（不再拖到派发） |
| `command` | `string` | 由 provider 类的 `buildLaunch()` 提供 | 覆盖该 provider 的 ACP 可执行文件；相对路径不解析，要求可从 `PATH` 找到 |
| `args` | `string[]` | 同上 | 覆盖默认参数（`['--acp']` / `['acp']` / ad-hoc npx 形式） |
| `env` | `Record<string,string>` | `{}` | 与 `process.env` 合并（子进程继承环境）；codex 的 `CODEX_PATH` 走这里 |
| `protocol` | `AcpProtocolConfig` | 见下 | 超时与能力覆盖；不填即用 provider 类的默认值 |
| `permissionMode` | `'client' \| 'agent'` | `'client'` | 见 §3.5 |
| `inquiry` | `boolean` | `false` | 是否提供 `ask_controller`（0.9.0 仅 `claude-code` 支持，三个 ACP 类恒 false） |

```ts
export type WorkerType = 'claude-code' | 'codebuddy-acp' | 'codex-acp' | 'opencode-acp';
export const WORKER_TYPES: readonly WorkerType[] = ['claude-code', 'codebuddy-acp', 'codex-acp', 'opencode-acp'];

export interface AcpProtocolConfig {
  handshakeTimeoutMs?: number;    // 默认按 provider 类（15000 / codex 30000）；必须 > 0
  sessionNewTimeoutMs?: number;   // 默认 30000；必须 > 0
  promptTimeoutMs?: number;       // 0 = 不限；>= 0
  cancelGraceMs?: number;         // 默认按 stopPolicy()；必须 > 0
  sigtermWaitMs?: number;         // 默认 2000；必须 > 0
  permissionTimeoutMs?: number;   // 300000
  /** 覆盖探测到/未探测到的能力（opencode 的 permissionRequests 默认 false，可在此打开）。 */
  capabilities?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls' | 'loadSession'>>;
}
```

**各 provider 的默认启动方式**（写在各自的 `buildLaunch()` 里，不放一张 profile 表——表里的值必须和类里的兜底逻辑挨着看，分开放迟早对不上）：

| type | command | args | 备注 |
| --- | --- | --- | --- |
| `codebuddy-acp` | `codebuddy` | `['--acp']` | 原生；未登录时 `session/new` 无响应（实测，§2.9、§3.4.1） |
| `codex-acp` | `codex-acp` | `[]` | **需要先装 `@agentclientprotocol/codex-acp`**；wayang 不自动 `npx` 拉包（§6 问题 1、§3.4.2） |
| `opencode-acp` | `opencode` | `['acp']` | 原生（官方文档，§3.4.3） |

`maxTurns` 对三个 `*-acp` 类型不生效（ACP 没有「最大回合数」字段；回合上限由 agent 自己的配置决定），加载期对 `*-acp` + `maxTurns` 给 warning 而不报错，避免存量配置直接失败。

配置示例：

```json
{
  "workers": {
    "codebuddy": {
      "type": "codebuddy-acp",
      "description": "Tencent CodeBuddy Code agent (ACP)",
      "capabilities": ["code", "refactor", "shell"]
    },
    "codex": {
      "type": "codex-acp",
      "description": "OpenAI Codex via codex-acp adapter",
      "env": { "CODEX_PATH": "/usr/local/bin/codex" },
      "protocol": { "handshakeTimeoutMs": 30000 }
    },
    "opencode": {
      "type": "opencode-acp",
      "description": "OpenCode (native ACP)",
      "protocol": { "capabilities": { "permissionRequests": true } }
    }
  }
}
```

**`validateConfig` 对 `workers` 段的校验规则**（新增，`src/types/config.ts:129-161`；现状完全不校验 `workers`，见 §1.3）：

1. `type` 必填且必须是 `WORKER_TYPES` 之一。缺失 → `workers.<id>.type is required (allowed: claude-code, codebuddy-acp, codex-acp, opencode-acp)`；未知 → `workers.<id>.type "foo" is not supported (allowed: …)`。文案里必须带字段路径 + 允许值。
2. `type: 'puppet'` 写进 `workers` → 报错：`puppet is a built-in worker type, do not declare it under workers`（避免和引擎前置分支冲突）。
3. `description` 必须是非空字符串；`capabilities` 必须是字符串数组；`emoji` 必须是字符串。
4. `type === 'claude-code'`：`command` / `args` / `env` / `protocol` 一律禁止（提示「claude-code 用 cliPath」），避免两套启动语义混用。
5. `type` 为任一 `*-acp`：`command` 若出现必须是非空字符串；`args` 必须是字符串数组；`env` 必须是 `Record<string,string>`；`protocol.*` 必须是正数（`promptTimeoutMs` 允许 0）；`protocol.capabilities` 的键必须是已知键。
6. `permissionMode` 必须是 `'client'` 或 `'agent'`；`inquiry` 必须是布尔。
7. `enable === false` 的 worker 仍要校验形状（配置错误不因禁用而隐藏）。

### 3.8 能力声明对 TUI / 审计 / controller 的影响

> **v2 修订：按类型分 worker 类。** 影响面不变，只把「`type === 'acp'` 时打 `[acp]` 标记」改为「按 provider 打标记」，这样 controller 能区分三个外部 agent。

- **controller prompt**：`buildWorkerList`（`src/services/agents/prompts/controller-prompt.ts:349-357`）继续用 `capabilities` 字符串标签，并对 `*-acp` 类型追加 `[acp:<provider>]` 后缀（如 `[acp:codebuddy]`），让 controller 知道这是外部 agent（它没有 `update_progress`/`done` 工具，靠回合结束收尾，中途消息只能回合边界交付）。这是**唯一需要改 controller prompt 的地方**，不改调度模型。
- **TUI**：`ActiveWorkerInfo.workerType`/`emoji`（`src/types/worker.ts:12-28`）已够用，ACP worker 的 `workerType` 就是配置里的 worker ID（或 `config.type`），无需改结构。工具行展示沿用 `ToolCallRecord`（`src/types/conversation.ts:67-84`）：`toolCallId` / `toolName`（ACP 的 `name ?? kind`）/ `arguments`（`rawInput` 序列化）/ `status`（`pending→running`、`in_progress→running`、`completed→completed`、`failed→failed`、取消时 `cancelled`）/ `startedAt` / `endedAt`。**不改 TUI 组件**。
- **transcript**：写 `<sessionDir>/workers/<workerId>/conversation.jsonl`（`src/services/agents/worker-state.ts:62`），读取路径不变（`src/services/worker-transcript.ts:8-16`、`:46-48`），因此 `read_worker_conversation` / `get_worker_status` / `get_task_detail` 无需为 provider 分叉。这是「不改读取侧」的硬约束，事件映射必须迁就 `ToolCallRecord` / `ToolResultRecord` 的形状而不是反过来。
- **审计**：`permission-audit` 增加 `transport` / `provider` 两个字段（§3.5），不新增文件、不新增格式。三分类让「哪个 provider 审批最多」这类问题可以直接查出来。
- **能力差异表**：`docs/develop/acp-capability-matrix.md`（新增），按 provider 记「流式 / 工具可见性 / 权限请求 / 取消 / resume / 中途注入 / 认证失败形态」七列，值来自实测，写「未实测」而不是猜。

---

## 4. 文件级实施计划

> **v2 修订：按类型分 worker 类。** 步骤重排为「协议层 + 骨架 + 一个 provider（codebuddy，本机可实测）→ codex → opencode → 配置/文档 → e2e 矩阵 → 收口」七步。与原方案的区别：不再有「注册表」步骤；每个 provider 是独立步骤、独立验收、可独立 revert；fake ACP server 在第 1 步就要存在（协议层单测依赖它），后续步骤只扩展剧本。

每一步都能独立过四道门槛（`npm run lint`、`npx vitest run`、`npm run build`、本步新增 e2e），且可单独 revert。

### 第 1 步：协议层 `src/services/acp/`（纯库，无引擎改动）— 2.5 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/acp/types.ts` | 新增。协议类型（`AcpContentBlock`、`AcpSessionEvent`、`AcpPermissionRequest/Outcome`、`AcpAgentCapabilities` 等），只覆盖官方 v1 用到的子集 |
| `src/services/acp/jsonrpc.ts` | 新增。`JsonRpcPeer`：按行分帧读写、自增 id、pending map、请求超时、通知分发、错误码常量（`-32800` / `-32601` / `-32603`）、未知方法回 `-32601`、`$/cancel_request` 折叠处理 |
| `src/services/acp/transport-stdio.ts` | 新增。`spawn`（`detached:false`、`stdio: pipe`）、stdout 行解析、stderr 按行回调、`exit`/`error` 事件、三阶段 kill、非 JSON 行计数 |
| `src/services/acp/session.ts` | 新增。`AcpSession` 实现：`start`（spawn + initialize，失败必 kill）、`openSession`、`prompt`（串行）、`onUpdate`、`onPermissionRequest`、`cancel`、`close`、`capabilities` |
| `src/services/acp/capabilities.ts` | 新增。协商结果 → `AcpCapabilities`，含 provider 覆盖合并 |
| `src/services/acp/errors.ts` | 新增。`AcpFailure` / `AcpFailureKind`（`spawn-failed` / `cli-missing` / `adapter-missing` / `handshake-timeout` / `auth-required` / `protocol-mismatch` / `turn-timeout` / `exited` / `cancelled`）与 stderr 尾行截断工具 |
| `e2e/fixtures/fake-acp-agent.ts` | 新增。node 脚本版 ACP agent：按剧本回 `initialize` / `session/new` / `session/prompt`，能发 `session/update` 与 `session/request_permission`，支持 `--no-response <method>`、`--crash-after N`、`--exit-code N`、`--no-reject-option`、`--late-updates-after-cancel` |
| `src/services/acp/__tests__/jsonrpc.test.ts` | 新增。分帧（超长行 / 空行 / 非 UTF-8）、乱序响应按 id 归位、通知不产生 pending、超时、对端请求走 handler 并回写、handler 抛错 → `-32603` |
| `src/services/acp/__tests__/transport.test.ts` | 新增。exit 与 error 同时到达只结算一次、SIGTERM 后仍在 → SIGKILL、stderr 不混入 stdout 解析、非 JSON 行容错 |
| `src/services/acp/__tests__/session.test.ts` | 新增。用 fake-acp-agent 起真子进程：握手成功、`protocolVersion: 2` 拒绝、`session/new` 超时（`--no-response`）、单回合、`cancel` → `cancelled`、agent 崩溃 |

**验收标准**：协议层单测覆盖率 ≥ 85%；`session.test.ts` 里至少 6 个用例走真子进程（不是 mock）；`npm run build` 通过且协议层零 `import` 自 `src/services/agents/**`（用一条 grep 断言守住分层的单向依赖）。

### 第 2 步：骨架 + codebuddy（第一个可实测 provider）— 4 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/base-acp-worker.ts` | 新增。`abstract class BaseAcpWorker implements IWorkerInstance`：`run()` 骨架、`WorkerState`/transcript 写入（`applyTurnEnvelope`）、`acceptMessage` 队列与 `_inputClosed`、`abort()`、`getLiveStatus()`、`getState()`、`subscribe()`、能力视图、pid 记录；声明五个抽象钩子（§3.1） |
| `src/services/agents/acp/event-mapper.ts` | 新增。`session/update` → transcript 条目与 progress：文本块去抖 500ms（沿用 `PROGRESS_DEBOUNCE_MS`，`claude-code-worker.ts:192`）、`tool_call`/`tool_call_update` 按 id 累积成 `ToolCallRecord`、`agent_thought_chunk` 丢弃、`plan`/`usage_update` 只进 runtimeState、未知变体 debug |
| `src/services/agents/acp/permission-bridge.ts` | 新增。`AcpPermissionRequest` → `decideToolAccess` → outcome（§3.5 全表），fail-closed 三分支 + 审计（`transport`/`provider`） |
| `src/services/agents/acp/codebuddy-acp-worker.ts` | 新增。`CodebuddyAcpWorker extends BaseAcpWorker`：五个钩子（§3.4.1） |
| `src/services/task-execute-engine.ts` | `switch` 加 `case 'codebuddy-acp'`（§3.3）；两处 `instanceof ClaudeCodeWorker`（`:1250`、`:1290`）改为可选成员探测 |
| `src/types/worker.ts` | `IWorkerInstance` 增加两个可选成员声明（`setSignalContext?` / `setInquirySupport?`，标注「第三方 worker 能力」） |
| `src/services/permission/permission-audit.ts` | 追加 `transport` / `provider` 字段（向后兼容：老记录缺字段即为旧格式） |
| `src/services/agents/acp/__tests__/event-mapper.test.ts` | 新增。变体→条目、乱序 update、缺失 tool_result、取消时 `cancelled` 收尾 |
| `src/services/agents/acp/__tests__/permission-bridge.test.ts` | 新增。kind×rawInput 全表、缺路径→ask、deny→reject_once、无 reject 选项→cancelled、超时→reject_once、审计字段齐全 |
| `src/services/agents/acp/__tests__/codebuddy-worker.test.ts` | 新增（用 fake agent）：正常 `end_turn`、`max_tokens`/`refusal` → failed、`--no-response session/new` → `auth-required` 文案、`SIGKILL` 且已握手 → `auth-required`、cancel → `Aborted` |

**验收标准**：
1. fake ACP agent e2e：单任务成功、回合边界交付中途消息（`chat_worker` → 下一个 `session/prompt`）、取消不产生 `worker_failed`、权限 allow / ask→批准 / ask→拒绝 / 敏感路径硬拒 四条路径全绿。
2. transcript 与 claude-code 场景同构（复用同一组断言函数）。
3. **真机**：`codebuddy` 登录后跑通一个真实任务（读文件 + 改文件 + 一次权限审批）；未登录态能稳定复现 `auth-required` 文案（不卡 30s×N，stderr 命中即短路）。
4. 既有测试全绿（尤其 `task-execute-engine-permission.test.ts`、`claude-code-*.test.ts`）。

### 第 3 步：codex（adapter 进程 + 命令提取）— 2 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/codex-acp-worker.ts` | 新增。`CodexAcpWorker extends BaseAcpWorker`：两级 preflight（adapter 缺失 / `CODEX_PATH` 缺失）、`handshakeTimeoutMs` 30000、命令提取顺序（`rawInput.command` → `cmd` → `parsed_cmd[0].cmd` → `title` 前缀）、`cancelGraceMs` 3000、`trustUpdatesAfterCancel: false`、退出但无 stopReason → `protocol-mismatch`（§3.4.2） |
| `src/services/task-execute-engine.ts` | `switch` 加 `case 'codex-acp'` |
| `e2e/fixtures/fake-acp-agent.ts` | 扩展剧本：`--kind execute --command-in title`（命令只在 title）、`--exit-without-stop-reason`、`--stderr "codex: command not found"`、`--ignore-cancel` |
| `src/services/agents/acp/__tests__/codex-worker.test.ts` | 新增：命令提取四个来源各一例 + 全缺失→ask；adapter 缺失文案；`CODEX_PATH` 缺失识别；忽略 cancel 时 3s 后 SIGTERM；0 退出无 stopReason → `protocol-mismatch` |

**验收标准**：fake adapter 剧本覆盖上面五条差异并全绿；「命令只出现在 title」时得到的 approval 载荷里 `command` 字段与预期一致（或按 fail-closed 转 ask，不允许静默 allow）；真机（可选，需 OpenAI 账号）`codex-acp` 跑通一回合，跑不通时错误文案能区分「adapter 未装 / codex 未装 / 未登录」三种。

### 第 4 步：opencode（取消语义差异）— 1.5 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/opencode-acp-worker.ts` | 新增。`OpenCodeAcpWorker extends BaseAcpWorker`：`opencode acp` 启动、`permissionRequests` 默认 false、`trustUpdatesAfterCancel: false` + 丢弃计数、退出码 130/143 → `interrupted`（§3.4.3） |
| `src/services/task-execute-engine.ts` | `switch` 加 `case 'opencode-acp'`，并在末尾加 `const _exhaustive: never = config.type` 穷尽检查 |
| `e2e/fixtures/fake-acp-agent.ts` | 扩展剧本：`--permission-never`（从不发 permission）、`--late-updates-after-cancel`（取消后继续推 3 条 update）、`--exit-code 143` |
| `src/services/agents/acp/__tests__/opencode-worker.test.ts` | 新增：默认能力视图 `permissionRequests: false`；配置覆盖为 true 后收到请求走 bridge；声明 false 却收到请求 → `cancelled` + 审计；取消后 update 被丢弃（断言 transcript 条数不增）；143 → `interrupted` |

**验收标准**：三条 provider 特有行为各有用例；三个 `switch` case 齐全后 `npm run lint` 的穷尽检查通过（故意删一个 case 时 lint 必报错，作为回归演示写进 PR 说明）。

### 第 5 步：配置 schema、校验、controller prompt、文档 — 2 人日

| 文件 | 改动 |
| --- | --- |
| `src/types/config.ts` | 新增 `WorkerType` / `WORKER_TYPES`、`WorkerConfig` 新字段（§3.7）；`validateConfig` 增 `workers` 段七条规则 |
| `src/types/__tests__/config.test.ts` | 新增用例：缺 `type`、未知 `type`、`type: 'puppet'`、`claude-code` 带 `command`、`*-acp` 的 `args` 非数组、`protocol` 负值/零、`enable:false` 仍校验、错误文案含字段路径 |
| `src/services/agents/prompts/controller-prompt.ts:349-357` | worker 列表追加 `[acp:<provider>]` 标记（§3.8） |
| `src/onboard.ts:146` | 初始化流程补一句「也可选填 ACP worker（codebuddy-acp / codex-acp / opencode-acp）」的提示，不改默认生成内容 |
| `docs/develop/acp-capability-matrix.md` | 新增。三 provider × 七列，逐项写实测结果或「未实测」 |
| `docs/README.zh-CN.md` | 「开放接入 — ACP 客户端」从路线图改为「已支持（0.9.0）」，贴 §3.7 的配置示例 |

**验收标准**：`validateConfig` 的错误文案可读（含 `workers.<id>.<field>` 路径与允许值）；文档里的配置段可直接粘贴运行；配置示例必须用 `type: 'codebuddy-acp'` 这类**具体类型**，不允许再出现 `type: 'acp'`。

### 第 6 步：e2e 场景矩阵（三 provider × 降级）— 1.5 人日

| 文件 | 改动 |
| --- | --- |
| `e2e/scenarios/acp-worker.test.ts` | 新增。用既有 `e2e/harness.ts` 套路（真实 `dist/cli.js` + fake LLM provider，`harness.ts:1-30`）+ fake ACP agent 子进程，按 provider 参数化跑：单任务成功、中途消息、取消、权限四路径、崩溃 |
| `e2e/scenarios/acp-degrade.test.ts` | 新增。`command` 不存在（ENOENT）、initialize 无响应、`session/new` 无响应（codebuddy 未登录形态）、`protocolVersion: 2`、adapter 在但 codex 缺失、无 reject 选项、取消后迟到 update |
| `e2e/scenarios/acp-dispatch.test.ts` | 新增。未知 `type` 的报错文案、四个 `type` 各自选出正确类（用 worker 元信息断言）、`type` 缺失在加载期失败（而不是派发时） |

**验收标准**：三个文件的场景全绿；`acp-degrade` 的错误文案能让用户直接定位（「codebuddy 未登录 / codex-acp 未安装 / opencode 未安装」三类文案各有一条断言）；同一 fake agent 剧本下三个 provider 的差异断言**各自独立**（不允许用 `if provider` 分叉的公共断言函数）。

### 第 7 步：收口（能力矩阵实测回填、CHANGELOG、复核）— 1 人日

| 项 | 内容 |
| --- | --- |
| `docs/develop/acp-capability-matrix.md` | 把第 2-4 步真机实测结果回填，未实测的保持「未实测」并写清卡在哪（账号/网络） |
| `CHANGELOG.md` | 0.9.0 段落按真实落地校准（三个 provider 各自的状态：已实测 / 仅 fake agent 通过） |
| 复核 | 重跑 §2 的四条 `curl` 与 `command -v`，确认协议与 CLI 状态没变；把新发现的未核实项补进本节与附录 A |

**验收标准**：能力矩阵里没有「猜」出来的值；CHANGELOG 与本文档描述一致；`npm run lint && npx vitest run && npm run build` 全绿。

### 合计与人日对比

- 本方案：2.5 + 4 + 2 + 1.5 + 2 + 1.5 + 1 = **14.5 人日**。
- 原方案（单一通用 adapter + 注册表）：**12 人日**。
- 差额 **+2.5 人日**，构成：三个类的钩子覆写与兜底（codebuddy 认证归因 +0.5、codex 命令提取与 preflight +1、opencode 取消语义 +0.5）、三套 provider 专属 fixture 剧本（+0.5）。
- 长期账：原方案每接一个新 provider 约 0.5 人日（写 profile），但每个「provider 特有 bug」都会变成共享类里的条件分支，回归面是全量 provider；本方案每接一个新 provider 约 1.5-2 人日（一个薄类 + 五个钩子），回归面只有该类。**按 0.9.0 只有三家算，本方案略贵；从第四家起本方案更便宜，且 bug 修复不会互相传染。**
- 不含：三家 CLI 的账号/网络问题排查（见 §6），以及真机上跑不通时的第三方提 issue / 等待时间。

---

## 5. 测试计划

> **v2 修订：按类型分 worker 类。** 测试对象从「registry + 单一 adapter」改为「协议层 + 骨架 + 三个 provider 类」，并新增一条硬要求：每个 provider 的差异断言必须写在该 provider 的测试文件里，公共断言函数不允许出现 `if provider` 分叉。

### 5.1 单元

| 对象 | 用例要点 |
| --- | --- |
| `jsonrpc.ts` | ndjson 分帧（超长行、空行、非 UTF-8 字节）；乱序响应按 id 归位；通知不产生 pending；请求超时；未知方法回 `-32601`；对端发来的请求（`session/request_permission`）走 handler 并回写；handler 抛错 → `-32603` |
| `transport-stdio.ts` | `exit` 与 `error` 同时到达只结算一次；SIGTERM 后仍在 → SIGKILL；stderr 按行回调且不混入 stdout 解析；非 JSON 行连续计数到阈值才判失配 |
| `session.ts` | 真子进程（fake-acp-agent）：握手成功 / `protocolVersion: 2` 拒绝 / `session/new` 无响应超时 / 单回合 stopReason 透传 / cancel 后回 cancelled / 进程崩溃时 `AcpExitInfo` 字段齐全 |
| `event-mapper.ts` | `tool_call` → `in_progress` → `completed` 三步合成一条 `ToolCallRecord` + `ToolResultRecord`；`tool_call_update` 只带 status 时保留 name/arguments；同一 step 多 tool 的顺序；流结束未完成 → `cancelled`；未知变体忽略 |
| `permission-bridge.ts` | §3.5 全表；`kind` 缺失；`rawInput` 为空但有 `locations`；`allow_always`-only 的选项集；无 reject 选项 → `cancelled`；超时 → `reject_once`；审计字段齐全（与 puppet 记录逐字段比对） |
| `base-acp-worker.ts` | 回合循环（多回合 + 队列消息顺序）；`_inputClosed` 判定；`stopReason` → `WorkerResult` 映射；`abort()` 幂等；`getLiveStatus` 的两个标志；`trustUpdatesAfterCancel === false` 时丢弃计数 |
| `codebuddy-acp-worker.ts` | 握手成功但 `session/new` 超时 → `auth-required`；stderr 命中 login → 立刻 `auth-required`（不等超时）；握手后 SIGKILL → `auth-required`；`cancelGraceMs` 为 8000 |
| `codex-acp-worker.ts` | 命令提取四来源各一例；全缺失 → `ask`；adapter 缺失 / `CODEX_PATH` 缺失两级文案；`cancelGraceMs` 3000 且忽略 cancel 时按时 SIGTERM；0 退出无 stopReason → `protocol-mismatch` |
| `opencode-acp-worker.ts` | 默认 `permissionRequests: false`；配置覆盖 true 后走 bridge；声明 false 却收到请求 → `cancelled` + 审计；取消后 update 全部丢弃；143 → `interrupted` |
| `config.ts` | §3.7 七条校验规则；`protocol.promptTimeoutMs: 0` 合法；`enable:false` 仍校验；错误文案含字段路径与允许值 |
| `task-execute-engine.ts`（dispatch） | 四个 `type` 各构造出预期类；未知 `type` 抛错并列出允许值；`type` 缺失在 `validateConfig` 就失败 |

### 5.2 集成（fake ACP server 端到端）

用 `e2e/harness.ts` 的既有套路（真实 `dist/cli.js` + fake LLM provider，`e2e/harness.ts:1-30`）加一个 fake ACP agent 子进程，同一套场景按 `type` 参数化各跑一遍：

1. **单任务成功**：controller 派发 → ACP worker 跑完 `end_turn` → 任务 completed → transcript 里有 assistant 文本 + tool 记录（断言与 claude-code 场景同构）。
2. **中途消息**：`chat_worker` 在回合进行中投递 → `acceptMessage` 返回 true → 当前回合结束后以新的 `session/prompt` 交付 → transcript 里出现 `[Controller message]` 前缀条目；回合结束后投递且队列为空时返回 false（对齐 `claude-code-worker.ts:489-499`）。
3. **取消**：`cancel_task` → fake agent 收 `session/cancel` → 回 `stopReason:'cancelled'` → 任务 `cancelled`，**不产生 worker_failed**（验证 `task-execute-engine.ts:1307-1316` 的抑制逻辑）；`trustUpdatesAfterCancel: false` 的 provider 额外断言「取消后无新条目」。
4. **权限**：fake agent 在 `kind:'edit'` 上发 `request_permission` → workspace 内路径直接 allow（无审批）；workspace 外 → 产生 `permission_request` 信号 → 批准选 `allow_once`、拒绝选 `reject_once`；敏感路径写 → 直接 `reject_once` + 审计 `hard-denied`；审计记录里 `provider` 字段等于 `config.type`。
5. **崩溃**：`--crash-after 2` → 进程退出非 0 → 任务 failed，错误含 exit code 与 stderr 尾行。
6. **多阶段**：idle worker 复用时新起进程、新 session（与 claude-code 的「每次 run 新会话」一致，`claude-code-worker.ts:9-14`）。

### 5.3 降级（缺 CLI / 缺 adapter / 协议不匹配）

| 场景 | 期望 |
| --- | --- |
| `command` 不在 PATH | run 立刻 failed（< 1s），错误文案：「ACP agent `codebuddy` 未找到：请确认已安装并从 PATH 可执行」；任务不卡在 running |
| codex adapter 未安装 | failed，文案：「未安装 codex 的 ACP adapter：`npm i -g @agentclientprotocol/codex-acp`」 |
| adapter 在但 codex 不在 | failed，文案：「adapter 找不到 codex，请设置 `CODEX_PATH`」 |
| initialize 15s（codex 30s）无响应 | failed，文案提示「agent 无响应，可能需要登录（codebuddy 实测现象）」 |
| `session/new` 30s 无响应且 `authMethods` 非空 | failed，`auth-required`，文案给该 provider 的登录命令 |
| `protocolVersion !== 1` | failed，错误含对端版本号；不尝试降级解析 |
| agent 出现但从不发 `session/update`（只有 stopReason） | 正常结束但 transcript 只有任务提示与结果条目；`get_worker_status` 能看出「无工具记录」 |
| `permissionRequests: false`（默认或被配置覆盖） | 不注册 handler；若 agent 仍发请求 → 回 `cancelled` + 审计（协议失配，不静默） |
| 未知 `type` / 缺失 `type` | 加载期失败，文案列出四个允许值（不是派发期才炸） |

---

## 6. 风险与未决问题（需要拍板）

> **v2 修订：按类型分 worker 类。** 决策项 1-5、7、8 不变；第 6 项因 `type` 改为必填枚举而更新；新增第 9 项（三份薄类的重复代码漂移）。风险条目里「协议漂移」与「配置复杂度」按新分层重写了缓解手段，并新增「抽象过度」一条。

| # | 问题 | 备选 | 建议 |
| --- | --- | --- | --- |
| 1 | codex 的 ACP 入口是第三方 adapter 包（`@agentclientprotocol/codex-acp`），要不要让 wayang 自动 `npx` 拉起？ | (a) 要求用户预装；(b) 配置里允许 `command: npx`, `args: ['-y', '@agentclientprotocol/codex-acp@2']` 由用户自己写；(c) wayang 内置默认 npx | 选 (b) + `CodexAcpWorker.preflight()` 给 (a) 的提示文案。(c) 会让「任务失败」与「网络/包管理器」耦合，且静默升级第三方代码，不可接受 |
| 2 | ACP 无法表达「带理由的拒绝」；agent 未提供 reject 选项时只能回 `cancelled`（终止整轮） | (a) 接受；(b) 只回 reject，没有就 `allow`（危险）；(c) 没有 reject 就整体失败并丢给用户 | 选 (a)：fail-closed 优先，审计与信号保留理由；同时要求 §5.3 的「协议失配」日志可查 |
| 3 | 中途消息只能回合边界交付（ACP v1 无回合内注入） | (a) 接受，与 claude-code 同语义；(b) 支持 codex-acp 的 `session/steering` 扩展；(c) 等 ACP v2 | 选 (a)。(b) 只在 `CodexAcpWorker` 内开洞，会立刻破坏「三个 provider 行为一致」的预期（同一个 controller 动作，在某一家上语义不同）——这比收敛到 v2 更贵 |
| 4 | `ask_controller` 在 ACP 下怎么给？ | (a) 0.9.0 不提供，`capabilities.inquiry = false`；(b) 写一个 stdio MCP server 通过 `session/new.mcpServers` 注入（需要新进程 + MCP 协议实现，约 2-3 人日） | 建议 (a) 先上，(b) 作为 0.9.1 的候选。注意 (b) 只对支持 client MCP 的 agent 有效（codebuddy：`mcpCapabilities` 有 http/sse，stdio 由 `mcpServers` 传，未实测；codex-acp README 明确支持 client MCP）；一旦做 (b)，注入点放 `BaseAcpWorker` 并把「是否支持」交给各 provider 的 `isReady()` 判定 |
| 5 | codebuddy 未登录时 `session/new` 无任何响应（实测 25s/28s），0.9.0 要不要做 `authenticate` 引导？ | (a) 不引导，只给超时错误 + 文档说明「先 `codebuddy` 登录一次」；(b) 实现 ACP `authenticate` 流程 | 建议 (a)。(b) 需要处理 `authMethods` 四种登录方式（iOA / external / internal / selfhosted），是单独的交互设计题；三家的登录方式各不相同，做了也得三个类各写一份 |
| 6 | `WorkerConfig.type` 现改为必填枚举（`claude-code` / `codebuddy-acp` / `codex-acp` / `opencode-acp`），配置键仍是 `workers.<id>`，要不要再解耦成 `id` + `type`？ | (a) 保持 `workers.<id>.type`（`type` 只表示实现类型，不再默认等于 id）；(b) 引入 `id` 字段 | 建议 (a)：不改既有配置语义，解耦留给 1.0。注意存量配置里 `type: 'acp'` 的写法会失效——错误文案要直接提示「改为 `codebuddy-acp` / `codex-acp` / `opencode-acp`」 |
| 7 | `permissionMode: 'agent'`（不接权限）要不要提供？ | (a) 提供；(b) 不提供，强制 client 模式 | 建议 (a)：有的 agent 自带沙箱/审批，强行接管会出现双重审批；但默认必须是 `client` |
| 8 | 孤儿 ACP 进程（wayang 被 SIGKILL）是否需要启动期清理？ | (a) 0.9.0 只记录 pid 不清理；(b) 启动时扫 `runtime-state.json` 的 pid 并 kill | 建议 (a) 先做记录，(b) 单独 issue（涉及 pid 复用误杀风险） |
| 9 | 三份 provider 薄类会不会复制粘贴出四份骨架？ | (a) 只允许覆写五个钩子，`run()` / transcript / 事件映射一律在骨架；(b) 允许各自写 `run()`（更自由，但三份会漂移） | 建议 (a)，并配两个硬约束：provider 类里不得出现骨架已实现的逻辑；骨架里不得出现 `if (provider === …)`。code review 直接拦漂移（§3.4.4 末、§7 第 12 条） |

其他风险（非决策项，需监控）：

- **协议漂移**：ACP 正在往 v2 走（回合生命周期与请求响应分离、允许排队/转向），v2 稳定后 `AcpSession.prompt` / `acceptMessage` 的语义可能要重做。缓解：协议层只暴露语义化方法（`prompt` / `cancel` / `close`），不让上层见到 JSON-RPC 方法名；三个 provider 类只依赖这些语义方法，因此 v2 迁移的影响面被压在协议层一处。
- **厂商扩展**：codebuddy 打包的 `@agentclientprotocol/sdk@1.7.0` schema 含 `plan_update`/`subagent_update`/`session_message` 等非官方变体（§2.9）。缓解：`event-mapper` 只认官方 v1 清单，其余 debug 丢弃；「连续 50 条未知变体才判失配」的阈值放在骨架，三家一致。
- **安全边界被误解**：ACP 下工具由 agent 执行，未经 `request_permission` 的操作 wayang 看不到。必须写进文档，避免用户以为 wayang 仍是唯一闸门（§3.5 末段）。
- **配置复杂度**：每多一个 provider，用户要维护 command/args/env/超时。缓解：每个 provider 类自带可用的默认启动方式（配置项全部可选）+ 加载期校验 + 错误文案列出四个 `type` 与字段路径。
- **抽象过度**：一旦有人为了「统一」把三个 provider 合并回一个万能类，或者为了「通用」在骨架里加 `if (provider === …)`，本设计的收益立刻归零，且历史 bug 会重新汇聚。缓解：把它写成明确的不做项（§7 第 12 条），并让 code review 以「provider 类 vs 骨架」的边界为主要检查点。

---

## 7. 不做（明确范围）

> **v2 修订：按类型分 worker 类。** 第 1-11 条不变（第 1 条措辞随分层微调）；新增第 12 条。

1. **不重写 `ClaudeCodeWorker`**，不改 `claude-code` 的配置语义（`cliPath` / `maxTurns` / `emoji` / `capabilities` 原样，且它不继承 `BaseAcpWorker`）。
2. **不做远程 ACP**：`streamable-http` 传输（codebuddy 的 `--acp-transport`）不接，只做 stdio。
3. **不支持 ACP v2 draft**，也不实现厂商扩展（`session/steering`、`session_message`、`subagent_update`、`plan_update`）。
4. **不实现 client 侧的 `fs/*`、`terminal/*`、`elicitation/*`、MCP-over-ACP**：initialize 里全部声明不支持，工具一律由 agent 自己执行。
5. **不实现 `allow_always` / `reject_always` 的记忆**：与 0.8.1「grant 不持久化」的决定保持一致（见 `docs/design/permission-policy-0.8.1.md` 非目标）。
6. **不做 `session/load` / `resume` 的跨 run 上下文续接**，也不做跨 provider 上下文迁移（issue #25 已明确不做）；ACP worker 每次 `run()` 新进程新会话，与 claude-code 现状对齐（`claude-code-worker.ts:9-14`）。
7. **不改 controller 调度模型**（并发、队列、多阶段 idle 复用逻辑全部不动）。
8. **不做孤儿进程自动清理**、不做 pid 复用防护（只记录 pid，见 §6 问题 8）。
9. **不自动安装/升级 provider CLI**（不 `npx` 拉包，不改用户全局环境）。
10. **不做 `session/list`、`session/delete`、`session/close`、slash commands、`plan` 渲染、`notice` 展示**：这些要么需要 UI 设计，要么对「一个任务一个 worker」的模型没有收益。
11. **不引入新依赖**：JSON-RPC 与状态机自研（约 300 行）；不引 `@agentclientprotocol/sdk`（引入即绑定其 schema 版本，且与「只认官方 v1 子集」的目标冲突）。
12. **不为抽象而抽象：宁可三份薄类，也不做一个万能类。** 具体表现：(a) 不引入注册表/插件系统，`switch` 的四个 case 就是全部实现集合；(b) 不把 provider 差异压进配置 profile，凡是控制流差异必须落在对应类；(c) 骨架里不出现 `if (provider === …)`，provider 类里不重复骨架逻辑；(d) 只有「三家完全相同且与 provider 无关」的逻辑才允许下沉到 `BaseAcpWorker` 或 `src/services/acp/`。反例判据：任何一处改动需要在三个 provider 类里同时做一遍，就是抽象层次选错了。

---

## 附录 A：取证记录（可复核）

代码：直接读 `release/0.9.0 @ 7827739` 工作区，行号见正文。

外部与实测：

```
# 1) ACP 官方文档与 schema（2026-11-04）
curl -L https://agentclientprotocol.com/protocol/v1/transports          # ndjson / stdio 定义
curl -L https://agentclientprotocol.com/protocol/v1/initialization      # protocolVersion=1, 能力协商
curl -L https://agentclientprotocol.com/protocol/v1/session-setup       # session/new: cwd + mcpServers
curl -L https://agentclientprotocol.com/protocol/v1/prompt-turn         # session/update 14 个变体 + stopReason
curl -L https://agentclientprotocol.com/protocol/v1/tool-calls          # tool_call / request_permission / options
curl -L https://agentclientprotocol.com/protocol/v1/cancellation        # session/cancel 必须回 cancelled
curl -L https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json

# 2) 本机 CLI
command -v codex        # 未找到
command -v codebuddy    # /usr/local/nodejs/bin/codebuddy  (2.167.0)
command -v opencode     # 未找到
codebuddy --help        # 含 --acp / --acp-transport / --permission-mode ... "ACP"

# 3) codebuddy ACP 实测（仅 initialize，未登录、未执行任务）
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,...}}' \
  | timeout 20 codebuddy --acp
# → {"result":{"protocolVersion":1,"agentCapabilities":{...},"authMethods":[iOA,external,internal,selfhosted]}}
# session/new（同一进程内）25s / 28s 均无响应，进程被 timeout 杀死

# 4) codex 是否原生支持 ACP
gh api "repos/openai/codex/git/trees/main?recursive=1" | wc -l    # 11032 条路径
gh api "repos/openai/codex/git/trees/main?recursive=1" | grep -i acp   # 0 条
# npm: @agentclientprotocol/codex-acp 2.5.0 (2026-10-29)；旧 @zed-industries/codex-acp 0.16.0 已迁移
```

未核实项（文档中已逐处标注，汇总）：

- codebuddy 登录后的 `session/new`、`session/prompt`、`request_permission`、`session/cancel` 实际行为。
- codex-acp 的实际握手字段与 `session/steering` 扩展细节（只读了 README）。
- opencode `acp` 子命令的能力面（只读了官方文档）。
- codebuddy 的 stdio MCP server 注入（`session/new.mcpServers`）是否可用。
