# 分册 01：协议层（src/services/acp/）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`（0.8.4 权限层已合入）。本册日期：2026-11-05。
- **契约归属**：本层（协议层与权限桥）的唯一契约是同目录冻结页 `00-interface-freeze.md`（下称「冻结页」）——文件清单见其 §1、接口签名见其 §2、错误分类见其 §4、取消与超时见其 §6。本册写**依据与设计说明**：协议摘要、与 wayang 现有语义的差异、实测校正、实现纪律。与冻结页冲突时以冻结页为准。
- v3 范围：provider 只剩 codebuddy（主路径）与 opencode（experimental）；范围决策见冻结页与主文档「不做」。

## 1. 定位与依赖方向

协议层是纯库：ndjson 上的 JSON-RPC、子进程与传输、生命周期方法、事件分发。五文件清单与导出符号见冻结页 §1（`types.ts` / `transport.ts` / `client.ts` / `errors.ts` / `config.ts`），此处不重复。

分层禁令（实现期用 grep 断言守住，见 06 分册）：

- `src/services/acp/**` 不得 import `@/services/agents/**` 与 `@/types/config`（`WorkerConfig` / `WayangConfig`）。
- worker 层（`src/services/agents/acp/**`）单向依赖本层，反向不成立。
- 协议层不读 `WayangConfig`、不写 transcript、不发 signal、不碰 TUI、代码里不出现任何 provider 名字（provider 差异全部留在 worker 层，见 03 分册）。

理由：协议层必须能独立单测（fake ACP agent 起真子进程，不起 wayang 引擎）；将来接其他 ACP consumer 也直接复用这一层。任何「协议层里出现 provider 名字」的改动都是层次错误，code review 直接拦下（主文档「不做」第 12 条）。

## 2. ACP v1 协议摘要（设计依据）

来源与核实日期：官方文档站与 v1 schema 于 2026-11-04 抓取（沿用 v2 §2 的取证，范围外的条目已删除）；实测见 §4 与冻结页 §9。

- 官方文档站：`https://agentclientprotocol.com/`，协议版本页 `https://agentclientprotocol.com/protocol/v1/`。
- schema：`https://raw.githubusercontent.com/zed-industries/agent-client-protocol/main/schema/v1/schema.json`（仓库已迁至 `agentclientprotocol/agent-client-protocol`，README 指向同一 schema 目录）。
- 稳定协议版本：**`1`**。`protocolVersion` 是整数，只在破坏性变更时递增；非破坏性能力靠 `initialize` 的能力协商表达。v2 目前是 draft，不作为 0.9.0 目标（主文档「不做」第 3 条）。

### 2.1 传输与消息模型

- JSON-RPC 2.0，UTF-8；stdio 传输：客户端把 agent 作为子进程启动，**按行分隔（`\n`）的 JSON，消息内不得含裸换行**；agent 的 stderr 只放日志。
- 方法/通知分工：客户端 → agent 的请求（`initialize`、`session/new`、`session/prompt`）；agent → 客户端的请求（`session/request_permission`、`fs/*`、`terminal/*`）；agent → 客户端的通知（`session/update`）。
- 客户端必须能作为 JSON-RPC 服务端回应 agent 发来的请求——这是 adapter 与「单向日志解析」最本质的区别。

### 2.2 初始化与能力协商

- `initialize { protocolVersion: 1, clientCapabilities: { fs?: {readTextFile, writeTextFile}, terminal?, auth?: {terminal}, elicitation?, session?: {...} }, clientInfo: { name, version } }`。
- wayang 全部声明不支持（`fs`/`terminal`/`auth` 均显式 false）：工具一律由 agent 自己执行，client 只在 agent 主动发 `session/request_permission` 时可拦（安全边界见 04 分册 §7）。
- 能力语义：**未声明即不支持**，不能靠 agent 猜。实测 codebuddy 尊重了声明（`fs/*` 请求 0 次，冻结页 §9）。
- 版本规则：客户端发自己支持的最高版本；agent 支持就原样回，否则回自己最高的；回包 `protocolVersion !== 1` → `AcpError('protocol-mismatch')`（冻结页 §2.4）。

### 2.3 会话创建

- `session/new { cwd（绝对路径）, mcpServers: McpServer[] }` → `{ sessionId, modes?, configOptions? }`。`mcpServers` 是 v1 schema 必填；0.9.0 恒传 `[]`，0.9.4 起注入一个 `wayang` stdio server（env 为 `{name,value}[]`），失败时才降级回传 `[]`（见 03 分册 §6）。
- `session/load` 需要 agent 声明 `loadSession`；0.9.0 不做跨 run 续接（主文档「不做」第 6 条）。
- 实测 codebuddy 在响应里携带厂商扩展字段（`modes` / `configOptions` / `models` / `multitaskOn`）：**一律忽略未知字段**，只取 `sessionId`（冻结页 §2.4 注释、§9 ②）。

### 2.4 提示回合

- `session/prompt { sessionId, prompt: ContentBlock[] }`；回合内所有输出走 `session/update` 通知，判别字段是 `update.sessionUpdate`。官方 v1 共 14 个变体，wayang 的处理表见冻结页 §3（前 7 个精确列型，其余 7 个忽略，未知变体以兜底行收口）。
- 回合结束：agent 用 `session/prompt` 的**响应**给出 `stopReason`，五值：`end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`（实测均为这五值语义，见 §4）。
- `session/cancel` 之后协议规定 **MUST** 回 `cancelled`，即使底层取消抛异常也要转换成这个语义化响应。
- 关键约束：**v1 里一个 `session/prompt` 请求拥有整个回合**，回合内没有「再插一条用户消息」的标准方法；真正的回合内注入只在 ACP v2 draft / 厂商 steering 扩展里，0.9.0 不做（主文档「不做」第 3 条）。中途消息退化为回合边界交付，与 claude-code 现有实测语义一致，不是能力倒退（主文档结论 4）。

### 2.5 工具调用

- `tool_call`：`{ toolCallId（必填）, title（必填）, name?, kind?, status?, content?, locations?, rawInput?, rawOutput? }`。`kind` 十值、`status` 四值（`pending` / `in_progress` / `completed` / `failed`，**没有 `cancelled`**——取消只能在 client 侧自行推断，`flushUnsettled` 把回合结束仍未完成的调用标 `cancelled`，见冻结页 §3）。
- `tool_call_update`：除 `toolCallId` 外全可选，null/缺省 = 不变；`content` / `locations` / `rawInput` / `rawOutput` 为**覆盖语义**。
- 实测形态（codebuddy，冻结页 §9 ④）：同一 toolCallId 先后到达「空 rawInput 的 in_progress → 参数流式补齐的 update → 全量重发且 kind 修正的 tool_call」——这就是流式累积合并的依据（§4 第 1 条）。

### 2.6 权限请求

- agent → client：`session/request_permission { sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }`。
- `PermissionOption = { optionId, name, kind }`，`kind` ∈ `allow_once` | `allow_always` | `reject_once` | `reject_always`。`optionId` 是**任意字符串**（实测 codebuddy 为 `allow` / `reject` / `allow_always`），选择只按 kind，绝不按 optionId 字面值（§4 第 2、3 条）。
- client 响应：`{ outcome: { outcome:'selected', optionId } }` 或 `{ outcome: { outcome:'cancelled' } }`。
- 协议硬约束：客户端发出 `session/cancel` 时，**必须**把所有待决的 permission 请求以 `cancelled` 回应（`AcpClient.sessionCancel` 内建，冻结页 §2.4）。
- 安全条款（协议明确建议）：自动放行不应只看 `title` / 选项名；不认识的 outcome 不得当作批准。

### 2.7 取消

- `$/cancel_request`（按 JSON-RPC id 取消任意请求）为可选机制；wayang 只接收不处理——取消统一走 `session/cancel`（按 sessionId），未响应请求以 `-32800 Request Cancelled` 结束或以 `stopReason:'cancelled'` 收尾。
- 实测 codebuddy 收到 `session/cancel` 后 **45ms** 返回 `stopReason:'cancelled'`；SIGTERM 后约 60ms 退出 code=0（冻结页 §9 ⑤）。

## 3. 与 wayang 现有语义的差异（设计必须直面的部分）

| 维度 | claude-code 通道（现状） | ACP v1 | 影响 |
| --- | --- | --- | --- |
| 工具事件 | assistant/user 两类消息 + tool_use/tool_result 配对 | `tool_call` + 增量 `tool_call_update`，同 id 可全量重发 | 需要「按 toolCallId 累积」的状态机（02 分册 §5）；取消状态需自行推断 |
| 拒绝表达 | `{behavior:'deny', message}` 可带理由 | 只能选 `reject_*`，无法传理由 | deny 的原因只能进审计/信号，agent 看不到（04 分册 §4） |
| 权限粒度 | 按工具名 + 入参人工判定 | 只拿到 agent 给的 `toolCall`（name/kind/locations/rawInput 可能不全，实测请求里无 kind/title） | 判定输入更弱，必须 fail-closed（04 分册 §5） |
| 回合内注入 | prompt iterable 提供句柄 | 无 | 退化为回合边界交付（02 分册 §3） |
| 结果文本 | `result.result` 汇总文本 | 无「结果文本」，只有 `stopReason` 五值 | summary 取最后一段 agent 消息（冻结页 §3 回合结束规则） |
| 会话续接 | 每次 `run()` 新会话 | `session/load`/`resume` 可选 | 0.9.0 与 claude-code 对齐：不续接 |
| 能力协商 | SDK 通道内建 | 显式能力声明，未声明即不支持 | client 侧 `fs`/`terminal` 全 false；agent 尊重声明（实测 0 次 `fs/*`） |

## 4. 实测校正后的协议事实（v3 必读，逐条来自 2026-11-05 codebuddy 探针）

以下五条是对 v2 设计的**强制校正**，v2 文档里与之冲突的描述一律作废；证据全文见冻结页 §9（探针 `.agents/tmp/acp-probe/probe.log`，不入库）。

1. **`tool_call` 是流式累积合并，不是一次性事件**：同一 toolCallId 先后收到空 `rawInput` 的 `in_progress` 首事件 → `tool_call_update` 流式补齐参数 → 同 id 全量重发（`kind` 由 `other` 修正为 `execute`）。任何「单事件自足」的解析都是错的：判定与展示必须基于累积器合并结果（02 分册 §5、04 分册 §2）。
2. **`request_permission` 的选项按 kind 选**：`allow_once` > `allow_always`、`reject_once` > `reject_always`。实测选项顺序不可依赖（`allow_always` 排第一），先到的不是想要的。
3. **`optionId` 是任意串**：实测为 `allow` / `reject` / `allow_always`，但协议只要求唯一，不承诺语义。代码里禁止出现对 optionId 字面值的比较或匹配。
4. **`stopReason` 恒为五值**：`end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`。映射规则见 02 分册 §4；`max_tokens` / `max_turn_requests` / `refusal` 归 `agent-error`（冻结页 §4）。
5. **codebuddy 的厂商扩展字段一律忽略未知字段**：`initialize` 响应的 `agentCapabilities` 之外的厂商位（`delegateToolsSupport` 等进 `raw: unknown` 保留）、`session/new` 的 `modes` / `configOptions` / `models`、回合响应的 `_meta` / `userMessageId`、`session_info_update` 等 v1 之外变体——全部原样透传或 debug 计数，不解释、不渲染、不因未知字段判失败（未知变体连续 ≥ 50 才 `protocol-mismatch`，冻结页 §2.3 兜底行）。

## 5. 实现纪律（本册规范；数值与签名以冻结页为准）

- **自研，不引入新 npm 依赖**：JSON-RPC 与 ndjson 约 300 行自研（`AcpClient` + `StdioAcpTransport`），不引 `@agentclientprotocol/sdk`——引入即绑定其 schema 版本（其中含 `plan_update` / `subagent_update` 等厂商变体），与「只认官方 v1 子集」冲突。
- **peer 规则**：请求 id 自增整数；乱序响应按 id 归位；通知不产生 pending；对端未知方法的请求一律回 `-32601`；agent 侧 handler 抛错回 `-32603`；`$/cancel_request` 只接收不处理（冻结页 §2.4 末段）。
- **非 JSON 行容忍**：stdout 非法 JSON 行不杀进程（有的实现会混打印日志），原样上抛由 client 判定；连续 `nonJsonLimit`（默认 50）→ `protocol-mismatch`。实测 codebuddy 全程 0 条非 JSON 行、stderr 0 行。
- **超时矩阵**：`AcpTimeouts` 六值（`handshakeMs` 15000 / `sessionNewMs` 30000 / `promptMs` 0（不限）/ `permissionMs` 300000 / `cancelGraceMs` 5000 / `sigtermWaitMs` 2000）见冻结页 §2.1；`resolveAcpTimeouts` 违例抛 `protocol-mismatch`。provider 覆写：codebuddy `cancelGraceMs:8000`、opencode `5000/2000` 与 `trustUpdatesAfterCancel:false`（03 分册）。
- **kill 阶梯**：`close()` 幂等；SIGTERM → `sigtermWaitMs` → SIGKILL；exit 与 error 双到达只结算一次（冻结页 §2.2）。孤儿防线：失败先 `transport.close` 再抛，不留孤儿进程。
- **不自动重试**：协议层与 worker 层都不重试。错误分类、判定依据、「可否重派」与文案模板见冻结页 §4——上层（引擎/controller）拿到的是 `AcpError.userMessage`，直接展示，不降级、不静默跳过（07 分册 fail-fast 原则）。

## 6. 未实测项（如实标注，禁止猜测）

- opencode 全链路（本机未安装；仅有官方文档依据，03 分册 §3）。
- codebuddy 的 `authenticate` 与 `session/load`（0.9.0 不做交互引导，登录态归因走 `auth-required`，冻结页 §2.4 注释）。
- `plan` / `notice` / `compaction*` 变体（官方 v1 有、实测未出现；wayang 不声明对应能力，agent 不应发，发了也按忽略处理，冻结页 §3 表）。
- `mcpServers` 注入（0.9.4 已实现，见 03 分册 §6；真机形态未实测，保留 fail-soft 降级）。
- 多回合中途消息的回合边界交付（由 06 分册 fake ACP server 用例覆盖，不依赖真机）。
