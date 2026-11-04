# ACP worker adapter 设计（0.9.0）

- 关联 issue：#25（Worker 接入扩展：以 ACP 为通用适配层接入 codex cli / codebuddy code / openCode）
- 基线：`release/0.9.0` @ `7827739`；version 0.8.3
- 取证日期：2026-11-04。代码事实给 `文件:行号`；外部事实给 URL，抓不到或未实测的一律标「未核实」。
- 本文只做设计，不含实现代码。

## 0. 结论（先行）

1. **做 ACP adapter，但不重写 claude-code。** 新增一个 `AcpWorkerInstance`（实现现有 `IWorkerInstance`），内部持有可替换的 `IAcpAdapter`（进程 + JSON-RPC + 会话）。`ClaudeCodeWorker` 原样保留并注册进工厂表，充当「非 ACP 的第三方 worker 兼容层」。理由：claude-code 走的 SDK 通道具备 ACP v1 表达不了的能力（拒绝可带理由、SDK MCP 的 `ask_controller`、prompt iterable 的回合内输入句柄），改写等于净损失（`src/services/agents/claude-code-worker.ts:302-330`、`788-865`）。
2. **provider 分发从 switch 收敛到注册表**，`TaskExecuteEngine.createWorker` 的 `switch`（`src/services/task-execute-engine.ts:1005-1010`）换成查表；同时把引擎里两处 `instanceof ClaudeCodeWorker`（`:1250`、`:1290`）改成能力探测，否则每加一种 adapter 都要改引擎。
3. **provider 差异靠配置与内置 profile，不靠代码分支。** `type: 'acp'` 一种实现 + `command/args/env` 三件套即可接入任意 ACP agent；codex / codebuddy / opencode 只是三组默认 profile。
4. **codex 必须先装 adapter 进程，codex CLI 本身不支持 ACP。** openai/codex 主分支 11032 个文件路径中 0 个含 `acp`（2026-11-04 实测）；ACP 由 `@agentclientprotocol/codex-acp`（2.5.0，2026-10-29 发布）提供，它自己会拉 `@openai/codex`。**codebuddy 原生支持**（`codebuddy --acp`，本机 2.167.0 实测 initialize 成功）；**opencode 原生支持**（`opencode acp`，官方文档）。
5. **中途消息在 ACP v1 下必然退化为「回合边界交付」**，这与 claude-code 现有实测语义一致（`claude-code-worker.ts:788-865`；PoC 记录见 `docs/develop/v0.6-design.md` §6 与 `scripts/poc-interrupt-permission.mjs`，结论是 interrupt 会留下孤立 tool_use），因此不是能力倒退；真正的「回合内注入」只在 ACP v2 draft / 厂商 steering 扩展里，0.9.0 不做。
6. **权限是本次最大的语义缺口**：ACP 的 `session/request_permission` 是「选一个选项」，不是「返回带理由的裁决」。硬拒绝（敏感路径写）只能映射成 `reject_once`，若 agent 没提供 reject 选项，只能回 `cancelled` 终止整个回合。这是 fail-closed 的代价，需要拍板（见 §6 问题 2）。
7. 粗估 **12 人日**（§4 第 1-6 步之和；不含三家 CLI 的账号/网络问题排查，见 §6）。

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

### 3.1 分层：IWorkerInstance 不动，adapter 在它下面

```
TaskExecuteEngine
  └── IWorkerInstance（不变，src/types/worker.ts:47-89）
        ├── WorkerAgent                （puppet，现状）
        ├── ClaudeCodeWorker           （兼容层，现状不动）
        └── AcpWorkerInstance          （新增）
              └── IAcpAdapter          （新增：进程 + JSON-RPC + 会话）
                    ├── StdioTransport （ndjson 子进程）
                    └── JsonRpcPeer    （id 分配 / pending / 通知分发 / 超时）
```

要点：

- **不引入与 `IWorkerInstance` 平行的 worker 抽象**。引擎只认 `IWorkerInstance`（`task-execute-engine.ts:1013-1015`、`:1307-1335`），abortAll/cancel/message delivery 全部按接口调用（`:263-276`、`:484-499`、`:691-706`）。多一层兄弟抽象只会多一处分发。
- **adapter 是 ACP worker 的内部件**，不是「所有 worker 的实现」。claude-code 不实现它（见 §3.2）。
- ACP 特有的三件事必须有归属：进程句柄、回合状态机、权限应答。它们全在 adapter 与 worker 之间，不外泄。

接口签名（只定形状，不写实现）：

```ts
// src/services/agents/acp/types.ts
export interface AcpSpawnOptions {
  command: string;                    // 可执行文件或 npx
  args: string[];
  env: Record<string, string>;        // 已与 process.env 合并后的最终值
  cwd: string;                        // 任务 workspace（绝对路径）
  clientInfo: { name: string; version: string };
  clientCapabilities: AcpClientCapabilities;
  handshakeTimeoutMs: number;         // 默认 15000
  stderrSink: (line: string) => void; // 只记日志，不进 transcript
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

export interface IAcpAdapter {
  /** 起进程并完成 initialize 握手；失败必须 kill 子进程再抛错（不留孤儿）。 */
  spawn(opts: AcpSpawnOptions): Promise<AcpHandshake>;

  /** session/new（0.9.0 不用 session/load）；返回 sessionId。 */
  openSession(opts: { cwd: string; additionalDirectories?: string[]; mcpServers?: AcpMcpServer[] }): Promise<string>;

  /**
   * 交付一条用户消息（session/prompt），resolve 于该回合结束的 stopReason。
   * 同一 session 内串行：上一个 send 未 settle 前不得再调用（ACP v1 语义）。
   */
  send(input: { sessionId: string; blocks: AcpContentBlock[]; timeoutMs?: number }): Promise<AcpTurnResult>;

  /** 订阅 session/update 流；回调同步执行，抛错不得影响读循环。 */
  onEvent(handler: (e: AcpSessionEvent) => void): () => void;

  /** 注册权限请求处理器：必须返回一个 outcome，adapter 负责回写 JSON-RPC 响应。 */
  requestPermission(handler: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>): () => void;

  /** session/cancel（通知），不 resolve 等待；等 send 的 cancelled stopReason 由 worker 侧处理。 */
  cancel(reason: 'user' | 'timeout' | 'shutdown'): Promise<void>;

  /** 关闭：cancel → 等退出 cancelGraceMs → SIGTERM → 等 2s → SIGKILL；幂等。 */
  shutdown(reason: 'run-finished' | 'abort' | 'shutdown' | 'crash'): Promise<AcpExitInfo>;

  /** 协商结果 + 本地 profile 合并后的能力视图（供引擎/UI/降级判断）。 */
  capabilities(): AcpCapabilities;
}
```

`AcpCapabilities` 是给上层看的稳定视图，与协议字段解耦：

```ts
export interface AcpCapabilities {
  protocolVersion: number;
  streaming: boolean;          // 恒为 true（session/update 存在）
  toolCalls: boolean;          // 观察到 tool_call 变体
  permissionRequests: boolean; // agent 是否真的会发 request_permission（配置可覆盖）
  loadSession: boolean;
  midTurnInject: false;        // 0.9.0 恒为 false，字段先占位，语义显式
  inquiry: boolean;            // ask_controller 是否可用（0.9.0 默认 false，见 §3.6）
  authRequired: boolean;
}
```

### 3.2 claude-code 的迁移结论

**0.9.0 不迁移 `ClaudeCodeWorker` 到 ACP，只做三件事：**

1. 把它注册进工厂表（`type: 'claude-code'`），行为零变化。
2. 把引擎里的两处 `instanceof ClaudeCodeWorker`（`task-execute-engine.ts:1250`、`:1290`）改为能力探测，让「需要引擎配合的第三方 worker」有统一入口（见 §3.3）。判定条件用可选成员：`typeof worker.setSignalContext === 'function'` / `typeof worker.setInquirySupport === 'function'`，并把这两个方法提到 `IWorkerInstance` 的可选成员上（`src/types/worker.ts` 加 4 行，标注「第三方 worker 能力」）。
3. 在 `WorkerConfig.type` 上保持 `'claude-code'` 不变，`cliPath` 语义不变（不做清单第 1 条）。

不迁移的理由（可复核）：

- `canUseTool` 的拒绝能带 `message`，ACP 只能 `reject_*`（§2.8）。
- `ask_controller` 走 in-process SDK MCP（`claude-code-worker.ts:302-310`、`:872-894`），ACP 侧没有等价物（ACP 的 MCP 是「client 起 server 给 agent 用」，需要另写一个 MCP server 进程，见 §3.6）。
- prompt iterable 让「回合边界交付」的实现非常直接（`:788-865`），改写成 ACP 需要先绕开 SDK，收益为负。
- 迁移成本（如果要）：约 5-7 人日，且需要先补齐 ACP 侧的 deny 语义与 inquiry 通道；不建议在 0.9.0 做。

**明确保留兼容层**：`ClaudeCodeWorker` 类继续存在，直到 ACP 侧功能对等（deny 带理由 + inquiry）后再评估。届时它是一个 `type: 'claude-code-legacy'` 的注册项，删或留由数据说话（用户配置里 `type: 'claude-code'` 的存量）。

### 3.3 provider 分发：switch → 注册表

现状（`task-execute-engine.ts:989-1011`）的职责被拆成三段：解析（puppet vs 配置）、校验（enable/未知）、构造（switch）。目标形状：

```ts
// src/services/agents/registry.ts
export interface WorkerFactoryDeps {
  config: WorkerConfig;
  sessionDir: string;
  workspaceDir: string;
  ctx: SystemContext;
  skills: SkillRegistry;
}

export type WorkerFactory = (deps: WorkerFactoryDeps) => IWorkerInstance;

/** 注册实现类型；重复注册直接抛错（防止后加载覆盖前者）。 */
export function registerWorkerType(type: string, factory: WorkerFactory): void;
export function hasWorkerType(type: string): boolean;
export function listWorkerTypes(): string[];
/** 未知类型必须抛错，错误文案列出已注册类型（配置期提示可读）。 */
export function createWorkerInstance(type: string, deps: WorkerFactoryDeps): IWorkerInstance;
```

- puppet 不进注册表之外的特殊分支：`createWorker` 变成
  `if (isPuppet(type)) … else { config 查找/enable 校验 → createWorkerInstance(config.type, deps) }`，puppet 仍是独立分支（它需要 provider/model/toolChoice，`task-execute-engine.ts:993-995`，不是 `WorkerConfig` 能表达的）。
- 注册发生在模块加载期（`src/services/agents/index.ts` 或 bootstrap），注册项：`'claude-code'` → `ClaudeCodeWorker`；`'acp'` → `AcpWorkerInstance`。测试可直接 `registerWorkerType('test-fake', …)`。
- `validateConfig` 增加：`workers.*.type` 必须已注册（`hasWorkerType`）——这样错误在加载期暴露，而不是派发时（现状 `:1009`）。

### 3.4 权限：ACP 的 permission 请求如何映射到 `decideToolAccess`

**判定输入**：`session/request_permission` 的 `params.toolCall`（`ToolCallUpdate`）+ 同 id 的 `tool_call` 事件里累积的字段（`rawInput`/`locations` 可能只在其中一次出现，必须按 toolCallId 合并后判定）。

**映射表**（`AcpPermissionRequest` → `decideToolAccess(scope, toolName, args)`，与 `handleCanUseTool` 保持同构，`claude-code-worker.ts:581-632`）：

| ACP `kind` | 策略工具名 | args 取值顺序 | 取不到目标时 |
| --- | --- | --- | --- |
| `execute` | `bash` | `rawInput.command` → `rawInput.cmd` → `toolCall.title`（仅当日志用，不参与判定） | 无 command 字符串 → `ask`（reason: command 无法确定） |
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

**fail-closed 的三条硬规则**：

1. 判定所需输入缺失（拿不到 kind、拿不到 command/path）→ `ask`，永不 `allow`。
2. 选项集合里既没有 allow 也没有 reject（畸形 agent）→ 回 `cancelled` 并记审计 `decision: 'denied'`、`source: 'protocol-mismatch'`。
3. 任何 JSON-RPC 错误、超时、子进程退出，一律按拒绝处理（不能「没回就当放行」）。

**审计与信号**：复用 `recordPermissionAudit`（`src/services/permission/permission-audit.ts`，与 puppet / claude-code 同一份记录形状，`claude-code-worker.ts:735-750`），新增两个只读字段 `adapter: 'acp'`、`provider: <workerId>`，便于事后按 provider 统计审批分布。

**必须写进文档的安全边界**：client 声明不支持 `fs/*`、`terminal/*` 后，工具由 agent 自己执行；**只有 agent 主动发 `request_permission` 时才可拦**。agent 若在自身策略下直接执行（等价于 claude-code 的 `bypassPermissions`，`claude-code-worker.ts:268-273` 的注释），wayang 无法阻止。这一点与现状态一致，不是 ACP 引入的退步，但必须在 README/配置示例中明说。

### 3.5 取消、超时、进程退出、崩溃恢复

**取消链路**（对齐现有 `cancel_task → abortByTaskId → worker.abort()`，`task-execute-engine.ts:263-276`、`:691-706`）：

1. `abort()` 置内部 `aborted`，调用 `adapter.cancel('user')`（发 `session/cancel`）。
2. **同时**把所有待决 permission 请求以 `{outcome:'cancelled'}` 回写（协议硬要求，§2.6），并 cleanup pending map。
3. 等待进行中的 `send()` 以 `stopReason === 'cancelled'` 正常返回：**这条路径不是崩溃**——`_terminalResult` 记为 `{status:'failed', error:'Aborted'}`，与 claude-code 的兜底一致（`claude-code-worker.ts:373-379`），引擎侧 `consumeCancelled` 会抑制多余的 failed 信号（`task-execute-engine.ts:1307-1316`）。
4. 超过 `cancelGraceMs`（默认 5000）未 settle → `SIGTERM`；再过 2000ms → `SIGKILL`；两条都记 warn。

**超时矩阵**：

| 阶段 | 默认值 | 触发后 |
| --- | --- | --- |
| spawn + initialize | 15000ms | kill 子进程，run 失败，错误文案提示「CLI 是否支持 --acp / 是否需要登录」 |
| session/new | 同 handshake | 同上（对 codebuddy 未登录的实测现象直接生效，§2.9） |
| 单次 `session/prompt` | 不设（0 = 无限） | 由外部 `cancel_task` 或 idle 机制处理；配置可开，开了就按 cancel 处理并标失败 |
| permission 等待 | 300000ms（沿用） | 选 reject_once，审计 `source:'timeout'` |
| shutdown | 5000 + 2000ms | 强制 SIGKILL，记 warn |

**进程退出**：

- `exit` 且 `cancelled === false`、且当前有未 settle 的 prompt → `failed`，error = `ACP agent exited (code=N)` + stderr 尾部 20 行（截断到 2000 字符，走 `truncateForStorage` 同款处理（`src/services/agents/utils/claude-tool-records.ts:39-42`））。
- `exit` 且无进行中回合（idle/multi-stage 等待中）→ 标记会话失效，`acceptMessage` 返回 false，`get_worker_status` 能看出「已结束」（对齐 `WorkerLiveStatus`，`src/types/worker.ts:39-44`）。
- stdout 上出现非 JSON 行（违反协议）→ 记 debug 跳过，不杀进程（有些实现会混打印日志）；连续 N 条（默认 50）才判协议失配并失败。

**崩溃恢复**：

- worker 进程与 wayang 进程同生命周期，不跨会话存活。wayang 崩溃时任务由 `recoverCrashedTasks` 统一置 failed（`task-execute-engine.ts:1426-1433`），ACP 侧不需要额外状态。
- **孤儿进程**：`shutdown` 三阶段 kill 是主防线；`spawn` 时把 `pid` 记到 `<sessionDir>/workers/<workerId>/runtime-state.json` 的 `runtimeState.acp = { pid, command }`（复用 `WorkerState`，`src/services/agents/worker-state.ts`），为后续「启动时扫孤儿」留证据。**0.9.0 不做自动清理**（不做清单第 8 条），只记录。

### 3.6 配置 schema 增量

`WorkerConfig`（`src/types/config.ts:42-57`）新增字段（全部可选，不改变 `claude-code` 现有语义）：

| 字段 | 类型 | 默认 | 说明 / 校验 |
| --- | --- | --- | --- |
| `type` | `string` | 必填 | 取值必须已注册（`'claude-code'` \| `'acp'`），加载期校验 |
| `command` | `string` | 由内置 profile 提供 | ACP 可执行文件（`codebuddy` / `opencode` / `codex-acp` / `npx`）；相对路径不解析，要求可从 `PATH` 找到 |
| `args` | `string[]` | 由 profile 提供 | `['--acp']` / `['acp']` / `['-y','@agentclientprotocol/codex-acp@2']` |
| `env` | `Record<string,string>` | `{}` | 与 `process.env` 合并（子进程继承环境） |
| `protocol` | `AcpProtocolConfig` | 见下 | 超时与能力覆盖 |
| `permissionMode` | `'client' \| 'agent'` | `'client'` | `client`：接 `session/request_permission` 并走 `decideToolAccess`；`agent`：不接（显式放弃 client 侧管控，用于已知会自己管权限的 agent） |
| `inquiry` | `boolean` | `false` | 是否提供 `ask_controller`（0.9.0 仅 `claude-code` 支持，ACP 侧默认 false） |

`maxTurns` 对 `type: 'acp'` 不生效（ACP 没有「最大回合数」字段；回合上限由 agent 自己的配置决定），加载期对 `acp` + `maxTurns` 给 warning 而不报错，避免存量配置直接失败。

```ts
export interface AcpProtocolConfig {
  handshakeTimeoutMs?: number;   // 15000；必须 > 0
  promptTimeoutMs?: number;      // 0 = 不限；>= 0
  cancelGraceMs?: number;        // 5000；必须 > 0
  permissionTimeoutMs?: number;  // 300000
  /** 覆盖探测到/未探测到的能力，例如某些 agent 不发 permission 请求。 */
  capabilities?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls' | 'loadSession'>>;
}
```

**内置 profile**（`src/services/agents/acp/profiles.ts`，只是默认值，可被配置覆盖）：

| profile | command | args | 备注 |
| --- | --- | --- | --- |
| `codebuddy` | `codebuddy` | `['--acp']` | 原生；未登录时 `session/new` 无响应（实测，§2.9），握手超时应给可读错误 |
| `opencode` | `opencode` | `['acp']` | 原生（官方文档） |
| `codex` | `codex-acp` | `[]` | **需要先装 `@agentclientprotocol/codex-acp`**；wayang 不自动 `npx` 拉包（见 §6 问题 1） |

配置示例（写进 `docs/` 与 `.env.example` 同级的位置，具体落点见 §4 第 5 步）：

```json
{
  "workers": {
    "codebuddy": {
      "type": "acp",
      "description": "Tencent CodeBuddy Code agent (ACP)",
      "capabilities": ["code", "refactor", "shell"],
      "command": "codebuddy",
      "args": ["--acp"]
    },
    "codex": {
      "type": "acp",
      "description": "OpenAI Codex via codex-acp adapter",
      "command": "codex-acp",
      "args": [],
      "env": { "CODEX_PATH": "/usr/local/bin/codex" },
      "protocol": { "handshakeTimeoutMs": 30000 }
    }
  }
}
```

**校验规则**（全部加进 `validateConfig`，`src/types/config.ts:129-161`）：

1. `workers.<id>.type` 必须已注册；`description` 非空字符串。
2. `type === 'claude-code'` 时：`command/args/env/protocol` 一律禁止（提示「claude-code 用 cliPath」），避免两套语义混用。
3. `type === 'acp'` 时：`command` 非空（或可由 profile 解析）；`args` 必须是字符串数组；`protocol.*` 必须是正数（`promptTimeoutMs` 允许 0）。
4. `capabilities` 必须是字符串数组（现状未校验）。
5. `enable === false` 的 worker 仍要校验形状（配置错误不因禁用而隐藏）。

### 3.7 能力声明对 TUI / 审计 / controller 的影响

- **controller prompt**：`buildWorkerList`（`src/services/agents/prompts/controller-prompt.ts:349-357`）继续用 `capabilities` 字符串标签，并在 `type === 'acp'` 时追加 `[acp]` 后缀，让 controller 知道这是外部 agent（它的 `update_progress`/`done` 语义不同：ACP worker 没有这些工具，靠回合结束收尾）。这是**唯一需要改 controller prompt 的地方**，不改调度模型。
- **TUI**：`ActiveWorkerInfo.workerType`/`emoji`（`src/types/worker.ts:12-28`）已够用，ACP worker 的 `workerType` 就是配置里的 worker ID，无需改结构。工具行展示沿用 `ToolCallRecord`（`src/types/conversation.ts:67-84`）：`toolCallId` / `toolName`（ACP 的 `name ?? kind`）/ `arguments`（`rawInput` 序列化）/ `status`（`pending→running`、`in_progress→running`、`completed→completed`、`failed→failed`、取消时 `cancelled`）/ `startedAt` / `endedAt`。**不改 TUI 组件**。
- **transcript**：写 `<sessionDir>/workers/<workerId>/conversation.jsonl`（`src/services/agents/worker-state.ts:62`），读取路径不变（`src/services/worker-transcript.ts:8-16`、`:46-48`），因此 `read_worker_conversation` / `get_worker_status` / `get_task_detail` 无需为 provider 分叉。这是「不改读取侧」的硬约束，事件映射必须迁就 `ToolCallRecord`/`ToolResultRecord` 的形状而不是反过来。
- **审计**：`permission-audit` 增加 `adapter`/`provider` 两个字段（§3.4），不新增文件、不新增格式。
- **能力差异表**：`docs/develop/acp-capability-matrix.md`（新增），按 provider 记「流式 / 工具可见性 / 权限请求 / 取消 / resume / 中途注入」六列，值来自实测，写「未实测」而不是猜。

---

## 4. 文件级实施计划

每步都能独立通过四道门槛（`npm run lint`、`npx vitest run`、`npm run build`、相关 e2e），且能单独 revert。

### 第 1 步：ACP 协议层（无 UI、无引擎改动）— 2 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/types.ts` | 新增。协议类型（`AcpContentBlock`、`AcpSessionEvent`、`AcpPermissionRequest/Outcome`、`AcpCapabilities`、`AcpExitInfo` 等），只覆盖官方 v1 用到的子集 |
| `src/services/agents/acp/jsonrpc.ts` | 新增。`JsonRpcPeer`：按行分帧读写、自增 id、pending map、请求超时、通知分发、错误码常量（`-32800` / `-32601` / `-32603`）、收到未知方法回 `-32601`、`$/cancel_request` 折叠处理 |
| `src/services/agents/acp/transport-stdio.ts` | 新增。`spawn`（`detached:false`、`stdio: pipe`）、stdout 行解析、stderr 按行回调、`exit`/`error` 事件、三阶段 kill |
| `src/services/agents/acp/__tests__/jsonrpc.test.ts` | 新增。分帧/乱序响应/并发请求/超时/协议错误 |
| `src/services/agents/acp/__tests__/transport.test.ts` | 新增。用 `node -e` 起假进程，测 exit/kill/非法行容错 |

验收：纯库层，单测覆盖 ≥ 85%，无外部进程依赖（除 node 自身）。

### 第 2 步：注册表 + 引擎分发收敛 — 1.5 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/registry.ts` | 新增。`registerWorkerType` / `hasWorkerType` / `createWorkerInstance` |
| `src/services/agents/index.ts`（或现有聚合出口） | 注册 `'claude-code'` |
| `src/services/task-execute-engine.ts:989-1011` | `switch` 换成 `createWorkerInstance`；未知类型错误文案列出已注册类型 |
| `src/services/task-execute-engine.ts:1250`、`:1290` | `instanceof ClaudeCodeWorker` → 可选成员探测（`setInquirySupport` / `setSignalContext`） |
| `src/types/worker.ts:47-89` | `IWorkerInstance` 增加两个可选成员声明（不实现、不改 puppet/ClaudeCodeWorker 逻辑） |
| `src/types/config.ts:129-161` | `validateConfig` 增 `workers` 段校验（形状为主，类型是否注册在第 2 步的 `hasWorkerType` 里） |
| `src/services/__tests__/worker-registry.test.ts` | 新增。重复注册抛错、未知类型抛错、puppet 不走注册表、`enable:false` |

验收：现有 worker 行为零变化，全部既有测试通过（尤其 `task-execute-engine-permission.test.ts`、`claude-code-*.test.ts`）。

### 第 3 步：AcpWorkerInstance（会话与事件映射）— 3 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/acp-adapter.ts` | 新增。`IAcpAdapter` 实现：spawn→initialize→session/new、`send`、事件分发、cancel、shutdown |
| `src/services/agents/acp/acp-worker.ts` | 新增。`AcpWorkerInstance implements IWorkerInstance`：复用 `WorkerState`、`applyTurnEnvelope`、`buildThirdPartyPrompt`；`run()` 内 spawn→openSession→send→回合循环；`acceptMessage` 入队（回合边界交付）；`abort()` 走 cancel；`getLiveStatus` 映射「有 stopReason / 进程已退」 |
| `src/services/agents/acp/event-mapper.ts` | 新增。`session/update` → transcript 条目与 progress：文本块去抖 500ms（沿用 `PROGRESS_DEBOUNCE_MS`，`claude-code-worker.ts:192`）、`tool_call`/`tool_call_update` 按 id 累积成 `ToolCallRecord`、`agent_thought_chunk` 丢弃、`plan`/`usage_update` 只进 runtimeState（usage），未知变体 debug 日志 |
| `src/services/agents/acp/profiles.ts` | 新增。codex / codebuddy / opencode 默认 command+args |
| `src/services/agents/acp/index.ts` | 新增。`registerWorkerType('acp', …)` |
| `src/services/agents/acp/__tests__/event-mapper.test.ts` | 新增。变体→条目、乱序 update、缺失 tool_result、取消时的 `cancelled` 收尾 |
| `src/services/agents/acp/__tests__/acp-worker.test.ts` | 新增。fake adapter：正常结束、max_tokens→failed、refusal→failed、cancel→`Aborted`、exit 非 0→failed |

验收：单测内用 fake adapter 跑通「单任务完整回合」，transcript 与 claude-code 形状一致（用同一组断言函数）。

### 第 4 步：权限桥 — 2 人日

| 文件 | 改动 |
| --- | --- |
| `src/services/agents/acp/permission-bridge.ts` | 新增。`AcpPermissionRequest` → `decideToolAccess` → outcome（§3.4 的表），含 fail-closed 三分支与审计 |
| `src/services/agents/acp/acp-worker.ts` | `setSignalContext`（与 `claude-code-worker.ts:410-433` 同签名）→ 注册 permission handler + `permissionHandler`（供引擎 `permissionResolvers`，`task-execute-engine.ts:1301`） |
| `src/services/permission/permission-audit.ts` | 追加 `adapter`/`provider` 字段（向后兼容，老记录缺字段即为旧格式） |
| `src/services/agents/acp/__tests__/permission-bridge.test.ts` | 新增。kind×rawInput 全表、缺路径→ask、deny→reject_once、无 reject 选项→cancelled、超时→reject_once |

验收：`task-execute-engine-permission.test.ts` 增加 ACP 分支，断言 puppet / claude-code / acp 三者对同一输入给出相同 verdict。

### 第 5 步：配置、文档、能力差异表 — 1.5 人日

| 文件 | 改动 |
| --- | --- |
| `src/types/config.ts:42-57`、`:129-161` | 新字段 + 校验规则（§3.6） |
| `src/types/__tests__/config.test.ts` | 新增用例：acp 缺 command、claude-code 带 command、非法超时 |
| `src/onboard.ts:146` | 初始化流程补一句「也可选填 acp worker」的提示（不改默认生成内容） |
| `src/services/agents/prompts/controller-prompt.ts:349-357` | worker 列表追加 `[acp]` 标记 |
| `docs/develop/acp-capability-matrix.md` | 新增。三 provider × 六能力列，逐项写实测结果或「未实测」 |
| `docs/README.zh-CN.md` | 「开放接入 — ACP 客户端」从路线图改为「已支持（0.9.0）」，附配置示例 |

验收：`validateConfig` 的错误文案可读（含字段路径），文档含可直接粘贴的配置段。

### 第 6 步：集成与 e2e — 2 人日

| 文件 | 改动 |
| --- | --- |
| `e2e/fixtures/fake-acp-agent.ts` | 新增。node 脚本：按剧本回 `initialize`/`session/new`/`session/prompt`，按剧本发 `session/update` 与 `session/request_permission`，支持 `--crash-after N`、`--no-response`、`--no-reject-option` |
| `e2e/scenarios/acp-worker.test.ts` | 新增。单任务成功、回合边界交付中途消息、取消不误判死亡、权限 allow/deny/超时、agent 崩溃、CLI 缺失 |
| `e2e/scenarios/acp-degrade.test.ts` | 新增。command 不存在（ENOENT）、initialize 无响应（超时）、`protocolVersion: 2` |

验收：六个场景全绿；`acp-degrade` 的错误文案能让用户直接定位（「codebuddy 未登录 / codex-acp 未安装」）。

合计：**约 12 人日**（含自测；不含真实 CLI 的账号/网络排查，见 §6）。

---

## 5. 测试计划

### 5.1 单元

| 对象 | 用例要点 |
| --- | --- |
| `jsonrpc.ts` | ndjson 分帧（超长行、空行、非 UTF-8 字节）；乱序响应按 id 归位；通知不产生 pending；请求超时；未知方法回 `-32601`；对端发来的请求（`session/request_permission`）走 handler 并回写；handler 抛错 → `-32603` |
| `transport-stdio.ts` | `exit` 与 `error` 同时到达只结算一次；SIGTERM 后仍在 → SIGKILL；stderr 按行回调且不混入 stdout 解析 |
| `registry.ts` | 未知类型抛错并列出已注册；重复注册抛错；puppet 不进表 |
| `event-mapper.ts` | `tool_call` → `in_progress` → `completed` 三步合成一条 `ToolCallRecord` + `ToolResultRecord`；`tool_call_update` 只带 status 时保留 name/arguments；同一 step 多 tool 的顺序；流结束未完成 → `cancelled`；未知变体忽略 |
| `permission-bridge.ts` | §3.4 全表；`kind` 缺失；`rawInput` 为空但有 `locations`；`allow_always`-only 的选项集；无 reject 选项 → `cancelled`；超时 → `reject_once`；审计字段齐全（与 puppet 记录逐字段比对） |
| `config.ts` | §3.6 五条校验规则；`protocol.promptTimeoutMs: 0` 合法；`enable:false` 仍校验 |

### 5.2 集成（fake ACP server 端到端）

用 `e2e/harness.ts` 的既有套路（真实 `dist/cli.js` + fake LLM provider，`e2e/harness.ts:1-30`）加一个 fake ACP agent 子进程：

1. **单任务成功**：controller 派发 → ACP worker 跑完 `end_turn` → 任务 completed → transcript 里有 assistant 文本 + tool 记录（断言与 claude-code 场景同构）。
2. **中途消息**：`chat_worker` 在回合进行中投递 → `acceptMessage` 返回 true → 当前回合结束后以新的 `session/prompt` 交付 → transcript 里出现 `[Controller message]` 前缀条目；若在回合结束后投递且队列为空，则 `acceptMessage` 返回 false（对齐 `claude-code-worker.ts:489-499` 的语义）。
3. **取消**：`cancel_task` → fake agent 收 `session/cancel` → 回 `stopReason:'cancelled'` → 任务 `cancelled`，**不产生 worker_failed**（验证 `task-execute-engine.ts:1307-1316` 的抑制逻辑）。
4. **权限**：fake agent 在 `kind:'edit'` 上发 `request_permission` → workspace 内路径直接 allow（无审批）；workspace 外路径 → 产生 `permission_request` 信号 → 批准后选 `allow_once`、拒绝后选 `reject_once`；敏感路径写 → 直接 `reject_once` + 审计 `hard-denied`。
5. **崩溃**：`--crash-after 2` → 进程退出非 0 → 任务 failed，错误含 exit code 与 stderr 尾行。
6. **多阶段**：idle worker 复用时新起进程、新 session（与 claude-code 的「每次 run 新会话」一致，`claude-code-worker.ts:9-14`）。

### 5.3 降级（缺 CLI / 协议不匹配）

| 场景 | 期望 |
| --- | --- |
| `command` 不在 PATH | run 立刻 failed（< 1s），错误文案：「ACP agent `codex-acp` 未找到：请先 `npm i -g @agentclientprotocol/codex-acp`」；任务不入 running 卡死 |
| initialize 15s 无响应 | failed，错误文案提示「agent 无响应，可能需要登录（codebuddy 实测现象）」 |
| `protocolVersion !== 1` | failed，错误含对端版本号；不尝试降级解析 |
| agent 出现但从不发 `session/update`（只有 stopReason） | 正常结束但 transcript 只有任务提示与结果条目；`get_worker_status` 能看出「无工具记录」 |
| `permissionRequests: false`（配置覆盖） | 不注册 handler；若 agent 仍发请求 → 回 `cancelled` + 审计（协议失配，不静默） |

---

## 6. 风险与未决问题（需要拍板）

| # | 问题 | 备选 | 建议 |
| --- | --- | --- | --- |
| 1 | codex 的 ACP 入口是第三方 adapter 包（`@agentclientprotocol/codex-acp`），要不要让 wayang 自动 `npx` 拉起？ | (a) 要求用户预装；(b) 配置里允许 `command: npx`, `args: ['-y', '@agentclientprotocol/codex-acp@2']` 由用户自己写；(c) wayang 内置默认 npx | 选 (b) + profile 里给 (a) 的提示文案。(c) 会让「任务失败」与「网络/包管理器」耦合，且静默升级第三方代码，不可接受 |
| 2 | ACP 无法表达「带理由的拒绝」；agent 未提供 reject 选项时只能回 `cancelled`（终止整轮） | (a) 接受；(b) 只回 reject，没有就 `allow`（危险）；(c) 没有 reject 就整体失败并丢给用户 | 选 (a)：fail-closed 优先，审计与信号保留理由；同时要求 §5.3 的「协议失配」日志可查 |
| 3 | 中途消息只能回合边界交付（ACP v1 无回合内注入） | (a) 接受，与 claude-code 同语义；(b) 支持 codex-acp 的 `session/steering` 扩展；(c) 等 ACP v2 | 选 (a)。(b) 是单一 provider 的厂商扩展，会重新引入「一个 provider 一套实现」的问题 |
| 4 | `ask_controller` 在 ACP 下怎么给？ | (a) 0.9.0 不提供，`capabilities.inquiry = false`；(b) 写一个 stdio MCP server 通过 `session/new.mcpServers` 注入（需要新进程 + MCP 协议实现，约 2-3 人日） | 建议 (a) 先上，(b) 作为 0.9.1 的候选。注意 (b) 只对支持 client MCP 的 agent 有效（codebuddy：`mcpCapabilities` 有 http/sse，stdio 由 `mcpServers` 传，未实测；codex-acp README 明确支持 client MCP） |
| 5 | codebuddy 未登录时 `session/new` 无任何响应（实测 25s/28s），0.9.0 要不要做 `authenticate` 引导？ | (a) 不引导，只给超时错误 + 文档说明「先 `codebuddy` 登录一次」；(b) 实现 ACP `authenticate` 流程 | 建议 (a)。(b) 需要处理 `authMethods` 四种登录方式（iOA / Google-GitHub / WeChat / 企业域名），是单独的交互设计题 |
| 6 | `WorkerConfig.type` 现在既是实现类型又是配置键（`type` 默认等于 worker ID 的语义松散，`task-execute-engine.ts:997-1003`），要不要解耦成 `id` + `type`？ | (a) 保持现状（`workers.<id>.type`）；(b) 引入 `id` 字段 | 建议 (a)：不改既有配置语义，解耦留给 1.0 |
| 7 | `permissionMode: 'agent'`（不接权限）要不要提供？ | (a) 提供；(b) 不提供，强制 client 模式 | 建议 (a)：有的 agent 自带沙箱/审批，强行接管会出现双重审批；但默认必须是 `client` |
| 8 | 孤儿 ACP 进程（wayang 被 SIGKILL）是否需要启动期清理？ | (a) 0.9.0 只记录 pid 不清理；(b) 启动时扫 `runtime-state.json` 的 pid 并 kill | 建议 (a) 先做记录，(b) 单独 issue（涉及 pid 复用误杀风险） |

其他风险（非决策项，需监控）：

- **协议漂移**：ACP 正在往 v2 走（回合生命周期与请求响应解耦、允许排队/转向），v2 稳定后 adapter 的 `send`/`acceptMessage` 语义可能要重做。缓解：`IAcpAdapter` 只暴露语义化方法，不让上层见到 JSON-RPC 方法名。
- **厂商扩展**：codebuddy 打包的 `@agentclientprotocol/sdk@1.7.0` schema 含 `plan_update`/`subagent_update`/`session_message` 等非官方变体（§2.9）。缓解：只认官方变体清单，其余 debug 丢弃。
- **安全边界被误解**：ACP 下工具由 agent 执行，未经 `request_permission` 的操作 wayang 看不到。必须写进文档，避免用户以为 wayang 仍是唯一闸门（§3.4 末段）。
- **配置复杂度**：每多一个 provider，用户要维护 command/args/env/超时。缓解：内置 profile + 加载期校验 + `listWorkerTypes` 式错误文案。

---

## 7. 不做（明确范围）

1. **不重写 `ClaudeCodeWorker`**，不改 `claude-code` 的配置语义（`cliPath` / `maxTurns` / `emoji` / `capabilities` 原样）。
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
