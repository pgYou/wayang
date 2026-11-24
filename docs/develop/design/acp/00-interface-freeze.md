# ACP 接口冻结页（0.9.0 · v3）

- 关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`（0.8.4 权限层已合入）。冻结日期：2026-11-05。
- 本页是 `src/services/acp/` 协议层与权限桥的**唯一契约**：实现方（后续编码 worker）只依据本页；与 v2 文档（`docs/design/worker-adapter-0.9.0.md`）冲突处以本页为准。v3 范围决策：**codex 全部移除**（不安装、不打包、不设计），仅保留 `codebuddy-acp`（主路径，真机已实测）与 `opencode-acp`（experimental，本机未装）。
- 与 v2 的三处差异（实现方必读）：① v2 §3.1 的六文件布局合并为本页 §1 的五文件；② v2 §3.4.2（codex）整节作废，`WORKER_TYPES` 少一个值；③ v2 §3.5 权限桥按 0.8.4 语义修正——`sensitive-list-write` 已并入 `sensitive-list`、敏感命中（含写方向）默认走审批而非硬拒、scope 字段更名 `userHome`、审计新增 `allowed`/`granted-by-memory` 决策与 `grantId` 字段。
- 硬约束：不引入新 npm 依赖（ndjson/JSON-RPC 自研）；协议层不读 `WayangConfig`、不写 transcript、不发 signal、不碰 TUI、代码里不出现任何 provider 名字。

## 1. 模块划分与文件清单（src/services/acp/）

| 文件 | 职责 | 导出符号 |
| --- | --- | --- |
| `types.ts` | ACP v1 协议类型子集（只覆盖 wayang 用到的）与能力视图 | `AcpContentBlock` `AcpMcpServer` `AcpStopReason` `AcpToolKind` `AcpToolStatus` `AcpToolCall` `AcpToolCallUpdate` `AcpToolCallContent` `AcpSessionUpdate` `AcpPermissionOptionKind` `AcpPermissionOption` `AcpPermissionRequest` `AcpPermissionOutcome` `AcpAuthMethod` `AcpAgentCapabilities` `AcpClientCapabilities` `AcpHandshake` `AcpTurnResult` `AcpExitInfo` `AcpCloseReason` `AcpCapabilities` |
| `transport.ts` | 子进程与 ndjson 传输：spawn、按行分帧、stderr 行缓冲、exit/error 事件、kill 阶梯 | `AcpTransport` `StdioAcpTransport` |
| `client.ts` | JSON-RPC peer（自增 id、pending map、超时、乱序归位、通知分发、对端请求回 -32601）+ ACP 生命周期方法与事件订阅 | `AcpClient` `AcpClientOptions` `buildAcpCapabilities` `selectAllowOption` `selectRejectOption` |
| `errors.ts` | 错误分类、判定依据与面向上层的文案模板 | `AcpErrorCode` `AcpError` `acpUserMessage` |
| `config.ts` | 启动配置与超时矩阵的默认值/校验（纯函数，输入普通对象，不读 WayangConfig） | `AcpLaunchConfig` `AcpTimeouts` `DEFAULT_ACP_TIMEOUTS` `resolveAcpTimeouts` `ACP_JSONRPC_ERROR` |

分层禁令：`src/services/acp/**` 不得 import `@/services/agents/**` 与 `@/types/config`（`WorkerConfig`/`WayangConfig`）；worker 层（`src/services/agents/acp/**`）单向依赖本层。文件拆分大于 500 行时按 #50 的纯搬移原则处理。

## 2. 接口签名（冻结）

### 2.1 config.ts

```ts
export interface AcpLaunchConfig {
  command: string;              // 可执行文件名；不在 PATH 时由 worker 层 preflight 报 cli-missing
  args: readonly string[];      // provider 默认 ['--acp']（codebuddy）/ ['acp']（opencode），可被用户配置覆盖
  env: Record<string, string>;  // 已与 process.env 合并后的最终环境（合并由 worker 层完成）
  cwd: string;                  // 绝对路径 = 任务 workspace，也是 session/new 的 cwd
  timeouts: AcpTimeouts;
}
export interface AcpTimeouts {
  handshakeMs: number;      // initialize 无响应上限；默认 15000
  sessionNewMs: number;     // session/new 无响应上限；默认 30000
  promptMs: number;         // 单回合上限；默认 0 = 不限；>0 到点走 §6 取消路径
  permissionMs: number;     // permission_request 等待上限；默认 300000
  cancelGraceMs: number;    // session/cancel 后等 settle 的宽限；默认 5000（codebuddy 覆写 8000）
  sigtermWaitMs: number;    // SIGTERM 后等退出的宽限；默认 2000
}
export const DEFAULT_ACP_TIMEOUTS: AcpTimeouts; // {15000, 30000, 0, 300000, 5000, 2000}
export function resolveAcpTimeouts(partial?: Partial<AcpTimeouts>): AcpTimeouts; // promptMs>=0、其余>0，违例抛 AcpError('protocol-mismatch')
export const ACP_JSONRPC_ERROR = { requestCancelled: -32800, methodNotFound: -32601, internal: -32603 } as const;
```

### 2.2 transport.ts

```ts
export type AcpCloseReason = 'run-finished' | 'cancel' | 'shutdown' | 'crash';
export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: AcpCloseReason;  // 意外退出上报为 'crash'
  cancelled: boolean;      // 取消路径为 true，用于区分取消与崩溃
}
export interface AcpTransport {
  /** spawn（detached:false，stdio 三 pipe）。ENOENT/EACCES/ENOEXEC → AcpError('cli-missing')。 */
  start(): Promise<void>;
  /** 写一行 ndjson（不含换行，实现负责追加 '\n'）。关闭后调用为 no-op + debug 计数。 */
  write(line: string): void;
  /** 幂等。时序：SIGTERM → sigtermWaitMs → SIGKILL；exit 与 error 双到达只结算一次。 */
  close(opts: { sigtermWaitMs: number; reason: AcpCloseReason }): Promise<AcpExitInfo>;
  onMessage(handler: (line: string) => void): () => void;  // stdout 按行；非 JSON 行原样上抛，由 client 判定
  onClose(handler: (info: AcpExitInfo) => void): () => void;
  onError(handler: (err: Error) => void): () => void;       // spawn 后的流错误
  stderrTail(): string[];                                   // 最近 50 行，供错误归因（截断 2000 字符后进文案）
  readonly pid: number | null;
}
export class StdioAcpTransport implements AcpTransport { constructor(config: AcpLaunchConfig); }
```

### 2.3 types.ts（关键形状；TS 判别联合按官方 v1 schema 核对）

```ts
export type AcpContentBlock = { type: 'text'; text: string } | { type: 'resource_link'; name: string; uri: string };
export type AcpMcpServer = { name: string; command: string; args: string[]; env?: { name: string; value: string }[] }; // 0.9.4 注入 wayang stdio server；降级时传 []
export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export interface AcpToolCall {          // 实测：首事件可 rawInput 空、kind 'other'，同 id 后到全量重发
  toolCallId: string; title: string;
  name?: string | null; kind?: AcpToolKind; status?: AcpToolStatus;
  content?: AcpToolCallContent[]; locations?: { path: string; line?: number | null }[];
  rawInput?: unknown; rawOutput?: unknown;   // rawOutput 实测是单对象 {type:'text',text}，不是块数组
}
export interface AcpToolCallUpdate {   // 除 toolCallId 全可选；null/缺省 = 不变；content/locations/rawInput/rawOutput 为覆盖语义
  toolCallId: string;
  title?: string | null; name?: string | null; kind?: AcpToolKind | null; status?: AcpToolStatus | null;
  content?: AcpToolCallContent[] | null; locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown; rawOutput?: unknown;
}
export type AcpToolCallContent = { type: 'content'; content: AcpContentBlock } | { type: 'diff'; path: string; oldText?: string; newText: string } | { type: 'terminal'; terminalId: string };
export type AcpSessionUpdate =   // 官方 v1 共 14 个变体：前 7 个（user/agent_message_chunk、agent_thought_chunk、tool_call、tool_call_update、plan、usage_update）精确列型，其余 7 个一律忽略（§3 表），以兜底行收口
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: AcpContentBlock; messageId?: string | null }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  | { sessionUpdate: 'plan'; entries: { content: string; priority?: string; status?: string }[] }  // AcpPlanEntry 内联；0.9.0 只透传 runtimeState
  | { sessionUpdate: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: string; [k: string]: unknown };  // available_commands_update / current_mode_update / config_option_update / session_info_update / notice / compaction_update / compaction_summary_chunk
export interface AcpPermissionRequest { sessionId: string; toolCall: AcpToolCallUpdate; options: AcpPermissionOption[] }
export interface AcpPermissionOption { optionId: string; name: string; kind: AcpPermissionOptionKind }
export type AcpPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
export interface AcpAuthMethod { id: string; name: string; description?: string | null }
export interface AcpHandshake {
  protocolVersion: number;               // !== 1 → AcpError('protocol-mismatch')
  agentCapabilities: AcpAgentCapabilities; // 官方字段 + raw: unknown 保留厂商位（实测 codebuddy 有 delegateToolsSupport 等）
  authMethods: AcpAuthMethod[];
  agentInfo?: { name: string; title?: string; version: string } | null;
}
export interface AcpTurnResult { stopReason: AcpStopReason; raw: unknown } // raw = 完整 result 对象，厂商字段（如 userMessageId）原样透传不解释
export interface AcpCapabilities {       // 上层稳定能力视图；由 buildAcpCapabilities 构造
  provider: string; protocolVersion: number; streaming: true;   // streaming 恒真（session/update 存在即真）
  toolCalls: boolean; permissionRequests: boolean; loadSession: boolean;
  midTurnInject: false; inquiry: false;   // 0.9.0 恒 false，字段占位、语义显式
  authMethods: AcpAuthMethod[];
}
```

### 2.4 client.ts

```ts
export interface AcpClientOptions {
  clientInfo: { name: string; version: string };  // 'wayang' / 当前版本
  clientCapabilities?: AcpClientCapabilities;      // 默认全 false：fs{readTextFile,writeTextFile:false}、terminal:false、auth{terminal:false}
  timeouts: AcpTimeouts;
  stderrSink?: (line: string) => void;             // 只记日志，不进 transcript
  nonJsonLimit?: number;                           // 连续非 JSON stdout 行阈值，默认 50，达到 → AcpError('protocol-mismatch')
  unknownVariantLimit?: number;                    // 连续未知 sessionUpdate 变体阈值，默认 50，同上
}
export class AcpClient {
  constructor(transport: AcpTransport, options: AcpClientOptions);
  /** 发 initialize{protocolVersion:1}。超时 → handshake-timeout；回包版本 !== 1 → protocol-mismatch。失败先 transport.close 再抛（不留孤儿）。 */
  initialize(): Promise<AcpHandshake>;
  /** 协议原语，0.9.0 worker 层不调用（登录态归因走 §4 auth-required，不做交互引导）。 */
  authenticate(methodId: string): Promise<void>;
  /** mcpServers 必填（v1 schema required），0.9.4 注入 wayang stdio server（03 分册 §6），降级时传 []。响应未知字段忽略（实测 codebuddy 回 models/modes/configOptions）。 */
  sessionNew(input: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<{ sessionId: string }>;
  /** 同 session 串行：上一回合未 settle 再调 → AcpError('protocol-mismatch')。响应 error → agent-error；error.code === -32800 → cancelled。 */
  sessionPrompt(sessionId: string, blocks: AcpContentBlock[]): Promise<AcpTurnResult>;
  /** 通知 fire-and-forget；同时立即对所有待决 request_permission 回 outcome:'cancelled'（协议 MUST）。 */
  sessionCancel(sessionId: string): void;
  /** 同步回调；回调抛错只 debug 计数，不得打断读循环。 */
  onUpdate(handler: (update: AcpSessionUpdate) => void): () => void;
  /** handler 必须返回一个 outcome，client 负责回写 JSON-RPC 响应。 */
  onPermissionRequest(handler: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>): () => void;
  /** 委托 transport.close；先结算 pending：permission → 拒绝（audit source 'aborted'）、request → AcpError('transport-closed'，取消路径 'cancelled'）。 */
  close(reason: AcpCloseReason): Promise<AcpExitInfo>;
}
export function buildAcpCapabilities(provider: string, handshake: AcpHandshake, overrides?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls'>>): AcpCapabilities;
export function selectAllowOption(options: AcpPermissionOption[]): AcpPermissionOption | undefined;  // kind 'allow_once' 优先，无则 'allow_always'
export function selectRejectOption(options: AcpPermissionOption[]): AcpPermissionOption | undefined; // kind 'reject_once' 优先，无则 'reject_always'
```

peer 规则（client 内部）：请求 id 为自增整数；乱序响应按 id 归位；通知不产生 pending；对端未知方法的请求一律回 `-32601`（我们未声明 fs/terminal/elicitation 能力，agent 不应发；实测 codebuddy 尊重了声明，0 次 fs/*）；agent 侧 handler 抛错 → 回 `-32603`；`$/cancel_request` 通知只接收不处理（wayang 取消只走 `session/cancel`）。

### 2.5 errors.ts

```ts
export type AcpErrorCode = 'cli-missing' | 'handshake-timeout' | 'auth-required' | 'protocol-mismatch' | 'agent-error' | 'cancelled' | 'transport-closed';
export class AcpError extends Error {
  constructor(code: AcpErrorCode, message: string, detail?: { exit?: AcpExitInfo; rpc?: { code: number; message: string }; stderrTail?: string[] });
  readonly code: AcpErrorCode;
  readonly userMessage: string;  // acpUserMessage 产出，直接给上层展示
}
export function acpUserMessage(code: AcpErrorCode, ctx: { command?: string; provider?: string; authMethods?: string[]; stopReason?: string; rpc?: { code: number; message: string }; exit?: AcpExitInfo }): string;
```

## 3. 事件映射表（session/update → wayang）

映射函数放 worker 层（`src/services/agents/acp/event-mapper.ts`），签名冻结：

```ts
export interface AcpToolAccumulator {   // byToolCallId 累积；tool_call 后到全量覆盖，update 增量合并（实测同 id 发两次 tool_call）
  upsert(u: AcpToolCall | AcpToolCallUpdate): AcpToolSnapshot;
  flushUnsettled(): AcpToolSnapshot[];  // 回合结束仍未 completed/failed 的调用 → status 'cancelled'
}
export type AcpMappedEvent =
  | { kind: 'agent-text'; text: string; messageId: string | null }
  | { kind: 'tool-call'; record: ToolCallRecord }      // status: pending|in_progress→'running'、completed→'succeeded'、failed→'failed'
  | { kind: 'tool-result'; record: ToolResultRecord }   // output = content 块文本拼接，缺则 rawOutput.text
  | { kind: 'runtime-state'; key: 'plan' | 'usage'; value: unknown }
  | { kind: 'ignored'; variant: string; reason: string };
export function mapSessionUpdate(update: AcpSessionUpdate, acc: AcpToolAccumulator): AcpMappedEvent[];
```

| 变体 | 映射 | 依据 |
| --- | --- | --- |
| `agent_message_chunk` | agent-text（进 AssistantEntry，携带 `messageId` 供进度按消息聚合） | 实测同一消息的 chunk 共享 messageId |
| `agent_thought_chunk` | ignored（debug 计数） | 不进 transcript；实测一次简单回合最多 36 条，写入即污染 |
| `tool_call` | acc.upsert；首个快照不产出 record | 实测首事件 rawInput 可为空、kind='other'，须等后续合并 |
| `tool_call_update` | acc.upsert；status completed/failed 时产出 tool-call + tool-result | 实测 rawOutput 为单对象 {type:'text',text} |
| `plan` | runtime-state('plan')，0.9.0 不渲染 | 官方 v1；未实测到 |
| `usage_update` | runtime-state('usage', {used,size})，供 get_worker_status | 官方 v1；实测每回合多次 |
| `user_message_chunk` | ignored（reason 'echo'） | wayang 自写 UserEntry，不接受 agent 回显；实测未出现 |
| `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` | ignored（debug 计数） | 0.9.0 不渲染；实测 codebuddy 大量发 session_info_update |
| `notice` | ignored（'no-render'） | 协议规定仅在 client 声明 session.notices 时发；wayang 不声明 |
| `compaction_update` / `compaction_summary_chunk` | ignored（'no-render'） | 仅在声明 session.compaction 时发；wayang 不声明 |
| 未知/厂商变体 | ignored（'unknown-variant'，debug 计数） | 连续 ≥ unknownVariantLimit(50) → AcpError('protocol-mismatch')；实测 codebuddy 未发 v1 之外的变体（其扩展在 `_meta` 与 session/new 附加字段） |

回合结束（sessionPrompt settle）时：flushUnsettled → 未完成 tool_call 标 'cancelled'；最后一段 agent-text 作为该回合 summary（ACP 无结果文本，stopReason 只是枚举）。

## 4. 错误分类（Taxonomy）

协议层与 worker 层都不自动重试；下表「重派」指用户重新派发同一任务能否恢复。

| code | 判定依据 | 重派 | 文案模板（acpUserMessage） |
| --- | --- | --- | --- |
| `cli-missing` | spawn ENOENT/EACCES/ENOEXEC；或 worker 层 preflight 未找到 command | 否（需安装） | `ACP agent "<command>" 无法启动：<errno 摘要>。codebuddy：npm i -g @tencent-ai/codebuddy-code；opencode：见 https://opencode.ai/docs/acp/` |
| `handshake-timeout` | initialize 在 handshakeMs 内无响应 | 可（偶发） | `与 "<command>" 握手超时（<N>s 无 initialize 响应），进程已终止。请重试；持续失败请检查 CLI 是否需要登录` |
| `auth-required` | session/new 在 sessionNewMs 内无响应且握手 authMethods 非空；或 stderr 命中 login/auth/unauthor/token/401（命中即短路，不等超时） | 否（需登录） | `"<provider>" 未登录：先在终端运行一次 "<command>" 完成登录（<authMethods 名单>）再重试` |
| `protocol-mismatch` | 回包 protocolVersion !== 1；或权限选项集无 allow 且无 reject；或非 JSON 行/未知变体达阈值；或退出 code 0 但回合未 settle | 否 | `与 "<command>" 的 ACP 协议不匹配（<版本 N / 畸形选项 / N 行非 JSON / 回合未收尾>）。请升级该 CLI 或提交 issue` |
| `agent-error` | session/new、session/prompt 返回 JSON-RPC error；或 stopReason ∈ {refusal, max_tokens, max_turn_requests}；或 worker 层构建的失败（如 opencode 权限闸注入失败/拒绝，#62） | 可 | `"<provider>" 回合失败（<rpc message、stopReason 或 reason>）` |
| `cancelled` | 主动取消路径（session/cancel 后 stopReason 'cancelled'，或 kill 阶梯完成且 cancelled=true） | 可 | `任务已取消`（WorkerResult=failed('Aborted')，引擎 consumeCancelled 抑制多余信号） |
| `transport-closed` | 进程 exit/error 时仍有未 settle 的回合或请求 | 可（偶发崩溃） | `"<command>" 进程提前退出（code=<N> signal=<S>）。stderr 尾部：<尾 20 行，截 2000 字>` |

注：promptMs>0 的到点超时不设独立枚举——按 §6 先走 session/cancel，以 `cancelled` 收口。

## 5. 权限桥契约（request_permission → decideToolAccess → approval memory → respond_permission）

**输入合并**：request.params.toolCall 与累积器里同 toolCallId 的事件合并后判定（实测请求里 toolCall 无 kind、无 title，rawInput 只有 {command, description}；首事件 rawInput 可为空——判定必须基于合并结果）。

**kind → 策略工具名**（与 puppet/claude-code 同一个 `decideToolAccess(scope, toolName, args)`，scope 为引擎注入的 `WorkerAccessScope{userHome, workspace, taskAllowedDirs?, permission?}`）：

| ACP kind | 策略工具名 | args 提取顺序 | 取不到时 |
| --- | --- | --- | --- |
| `execute` | `bash` | rawInput.command → rawInput.cmd（string[] 则 join ' '） | 直接 ask（command 无法确定） |
| `read` | `read_file` | locations[0].path → rawInput.file_path → rawInput.path → rawInput.filePath | ask |
| `edit` | `edit_file` | 同上 | ask |
| `delete` / `move` | `write_file` | 同上 | ask |
| `search` | `search_content` | locations[0].path → rawInput.path | 无路径 → allow（cwd 内搜索，对齐 pathRequired:false） |
| `fetch` / `think` / `switch_mode` | —（非路径） | — | 直接选中 allow 选项 |
| `other` / 缺失 | 形态推断：rawInput.command → bash；路径字段 + name 含 read/search/grep → read_file、否则 write_file；推断不出 → **不调 decideToolAccess，直接 ask**（decideToolAccess 对未知工具名恒 allow，绝不能把未知工具喂给它） |

**裁决 → outcome**（按序判定）：

1. `allow` → selectAllowOption 选中；audit `decision:'allowed'`。
2. `ask` 且命中审批记忆（access==='read'、非敏感、askPaths 非空、`approvalKey('read', path)` 每条都 `engine.approvalGrants.has(taskId, key)`）→ 选中 allow 选项；audit `granted-by-memory` + `grantId`；不发信号。
3. `ask`（其余）→ 发 `permission_request` 信号（`PermissionRequestSignalPayload` 全字段；toolName=toolCall.name ?? kind；toolArgs=合并后的 rawInput（缺则 {locations}）；description 按现有格式：bash→`Execute shell command: <command>`、文件→`<name>: <path>`；matchedRule/matchedEntry/matchedSource/resolvedPath/sensitive/access/operation 从 verdict 投影）→ `BlockingRequestMap.wait(requestId, permissionMs=300000)`：
   - 批准 → `grants.remember(taskId, approvalKey('read', path), {requestId})`（每条 askPath）+ audit `approved` → 选中 allow 选项；
   - 拒绝 → audit `denied` source `'controller'` → selectRejectOption；
   - 超时 → audit `denied` source `'timeout'` → selectRejectOption。
4. `deny`（仅 `sensitiveMode:'deny'` 时出现）→ audit `hard-denied` → selectRejectOption；无 reject 选项 → outcome `cancelled`，本回合按失败收口。
5. worker 侧 handler 暴露 `readonly permissionHandler: PermissionMiddlewareResult`（resolvePermission/cleanup，与 ClaudeCodeWorker.permissionHandler 同形状），引擎照旧 `permissionResolvers.set(workerId, …)`，`respond_permission` 工具零改动。

**optionId 生成方式**：wayang 不生成 optionId——v1 每个选项必带 optionId（任意字符串，实测 codebuddy 为 `allow`/`reject`/`allow_always`）；选择只按 kind：allow_once > allow_always、reject_once > reject_always（实测选项顺序不可依赖，allow_always 排在第一位）。两类都缺 → `{outcome:'cancelled'}`。

**超时默认**：permissionMs = 300000（对齐 claude-code 的 PERMISSION_TIMEOUT_MS 与 middleware 的 DEFAULT_TIMEOUT_MS）。

**fail-closed 三铁律**（任何 provider 不许放宽）：① 判定输入缺失（无 kind 且形态推断不出、command/path 取不到）→ ask，永不静默 allow；② 选项集既无 allow 也无 reject → outcome cancelled + audit `hard-denied` + 记 protocol-mismatch 日志；③ 传输错误/进程退出/超时/abort → 一律按拒绝结算（cleanup），不得「没回就当放行」。

**审计扩展**：复用 `recordPermissionAudit`，`PermissionAuditEntry` 增加两个只读可选字段 `transport: 'acp'`、`provider: config.type`（缺省即旧记录，向后兼容）。**permissionMode**：`'client'`（默认）注册 handler；`'agent'` 不注册，若 agent 仍发请求 → outcome cancelled + audit（不静默放行）。

## 6. 取消与超时

1. `worker.abort()` → `sessionCancel(sessionId)`（同时 client 自动对全部待决 permission 回 cancelled——协议 MUST）。
2. 等 in-flight `sessionPrompt` settle。实测 codebuddy 在 cancel 后 **45ms** 返回 `stopReason:'cancelled'`。settle 后 WorkerResult = `failed('Aborted')`，引擎 `consumeCancelled`（task-execute-engine.ts:1455）抑制多余 failed 信号——既有机制，零改动。
3. `cancelGraceMs`（默认 5000，codebuddy 覆写 8000）未 settle → SIGTERM；再 `sigtermWaitMs`（默认 2000）→ SIGKILL；两跳都记 warn。实测 codebuddy 收 SIGTERM 后约 60ms 退出 code=0。
4. 迟到 update：client 一律继续分发给 onUpdate（不丢弃）；丢弃策略在 worker 层：`trustUpdatesAfterCancel=false`（opencode 默认）→ 丢弃 + debug 计数 `discarded_after_cancel`、不写 transcript；`true`（codebuddy 默认）→ 照常写。实测 cancel 后仅 1 条迟到 usage_update。
5. provider 停止策略默认：codebuddy `cancelGraceMs:8000 / sigtermWaitMs:2000 / trustUpdatesAfterCancel:true`；opencode `5000 / 2000 / false`。
6. close 幂等；exit 与 error 双到达只结算一次；退出时未决 permission → cleanup 拒绝（audit source 'aborted'），未决 request → AcpError（'transport-closed'；取消路径 'cancelled'）。

## 7. 对上层暴露的最小面（只列签名）

- **BaseAcpWorker**（`src/services/agents/acp/base-acp-worker.ts`）从本层 import 的全部符号即 §1/§2 全表；另需 worker 层文件：`event-mapper.ts`（§3 签名）、`permission-bridge.ts`（§5 规则）、`codebuddy-acp-worker.ts`、`opencode-acp-worker.ts`（五钩子形状沿用 v2 §3.1：buildLaunch / mapPermission / normalizeError / isReady / stopPolicy，删除 codex 相关条目）。
- **引擎**（`src/services/task-execute-engine.ts`）改动面：① createWorker 的 switch（:1035）加 `case 'codebuddy-acp'`、`case 'opencode-acp'`，构造签名与 ClaudeCodeWorker 一致：`(config, this.ctx.sessionDir, workspaceDir, this.ctx, this.skills)`；② 两处 `instanceof ClaudeCodeWorker`（:1283 setInquirySupport、:1344 setSignalContext）改为可选成员探测——BaseAcpWorker 统一实现 `setSignalContext(...)`（在现有形状上追加 `grants: ApprovalMemory`、`approvalMemory: ApprovalMemoryMode` 两参）与 `permissionHandler`，`respond_permission`/`resolvePermission` 零改动；③ `src/types/config.ts`：`WORKER_TYPES = ['claude-code', 'codebuddy-acp', 'opencode-acp']`，WorkerConfig 增 `protocol`/`permissionMode` 字段（v2 §3.7 表，codex 行删除）。
- **TUI**：零改动。transcript 条目同构（AssistantEntry.toolCalls/toolResults）；`getLiveStatus()`：resultReceived = stopReason 已到，streamEnded = 回合已 settle。
- **信号**：零新增类型（permission_request/progress/completed/failed 复用现有 SignalQueue 通路）。

## 8. 验收：fake ACP server 跑通完整回合

`e2e/fixtures/fake-acp-agent.cjs`：node 原生 ndjson 实现（禁用 ACP SDK），剧本开关 `--protocol-version N`、`--no-response <method>`、`--permission-options <allow+reject|allow-only|none>`、`--ignore-cancel`、`--late-updates N`、`--crash-after N`、`--exit-code N`。以下用例**仅依赖本页接口**：

1. 完整回合（含权限与取消）：initialize → session/new → session/prompt 期间 fake 依次发 agent_message_chunk('He')、agent_message_chunk('llo')、tool_call(kind:'execute', rawInput 完整)、request_permission([allow_once, reject_once])、tool_call_update(completed, rawOutput) → 响应 selected allow_once → end_turn。断言：AcpHandshake 字段、AcpTurnResult.stopReason、update 顺序、ToolCallRecord（arguments=rawInput JSON、status 'succeeded'）与 ToolResultRecord、审计含 transport:'acp'。
2. ask→拒绝：edit 类权限、workspace 外路径 → permission_request 信号 → respond_permission(false) → 选中 reject_once；audit denied source 'controller'。
3. 取消：回合中途 session/cancel → fake 回 cancelled → prompt resolve stopReason:'cancelled'、待决 permission 全部 outcome:'cancelled'、WorkerResult failed('Aborted')；`--ignore-cancel` 时 cancelGraceMs 内 SIGTERM、sigtermWaitMs 后 SIGKILL、AcpExitInfo.cancelled=true、late-updates N 在 trustUpdatesAfterCancel=false 时被丢弃计数。
4. 审批记忆：同任务第二次同路径读 → 不发信号、audit granted-by-memory + grantId；任务终态后 grants 被 clearTask 清空（引擎既有调用）。
5. 失配/降级：`--protocol-version 2` → protocol-mismatch；`--permission-options none` → outcome cancelled + audit；`--no-response initialize` → handshake-timeout；`--no-response session/new` 且 authMethods 非空 → auth-required；`--crash-after 2` → transport-closed（文案含 exit code 与 stderr 尾）。
6. 协议层单测：ndjson 分帧（超长行/空行/非 JSON 计数）、乱序响应按 id 归位、通知不产生 pending、超时、对端请求 -32601、handler 抛错 -32603、exit+error 单次结算、kill 阶梯时序。

门槛：`npm run lint`、`npx vitest run`、`npm run build` 全绿；§1 的分层禁令用 grep 断言守住。

## 9. 实测证据（codebuddy --acp，2026-11-05）

环境：codebuddy 2.167.0（`/usr/local/nodejs/bin/codebuddy`，登录态）、node v22.17.0。探针 `.agents/tmp/acp-probe/probe.cjs`（不入库；cwd 与 session/new.cwd 均为该目录；clientCapabilities 全 false；未改 codebuddy 任何配置）。五步全部成功，总耗时 27.5s。摘录（`_meta` 与模型列表删节，全文见探针输出）：

```jsonc
// ① initialize（2921ms）
--> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"auth":{"terminal":false}},"clientInfo":{"name":"wayang-probe","version":"0.9.0-probe"}}}
<-- {"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"loadSession":true,"delegateToolsSupport":true,"mainAgentSupport":false,"multitaskSupport":true,"toolModeSupport":false,"codeModeSupport":false,"metaPromptSupport":true},"authMethods":[{"id":"iOA","name":"Login with iOA"},{"id":"external","name":"Login with Google/Github"},{"id":"internal","name":"Login with WeChat"},{"id":"selfhosted","name":"Login with Enterprise Domain"}]}
// ② session/new（231ms）——注意厂商扩展字段，必须忽略未知字段
<-- {"sessionId":"01a1a9c7-fb3b-74e3-a528-1265bc187695","modes":{"currentModeId":"default",…},"configOptions":[…],"models":{…},"multitaskOn":false}
// ③ prompt "Reply with exactly: OK"（8680ms，end_turn）
<-- NOTIFY session/update {"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"},"messageId":"01a1a9c8-06ba-…"}}
<-- {"stopReason":"end_turn","userMessageId":"…"}
//    回合内 26 条 update：available_commands_update×4、session_info_update×11、usage_update×3、agent_thought_chunk×7、agent_message_chunk×1；无 user_message_chunk
// ④ prompt "Run `echo probe-ok`"（7512ms，end_turn）——工具调用与权限的完整实测形态
<-- tool_call         {"sessionUpdate":"tool_call","toolCallId":"chatcmpl-tool-8224b0e808229d09","title":"Bash","kind":"other","status":"in_progress","rawInput":{}}
<-- tool_call_update  {"sessionUpdate":"tool_call_update","toolCallId":"…","rawInput":{"command":"echo probe-ok"}}                         // 参数流式补齐
<-- tool_call         {"sessionUpdate":"tool_call","toolCallId":"…","title":"`echo probe-ok`","kind":"execute","status":"pending","rawInput":{"command":"echo probe-ok","description":"…"},"content":[{"type":"content","content":{"type":"text","text":"…"}}]}   // 同 id 全量重发，kind 修正为 execute
<-- AGENT-REQ session/request_permission {"sessionId":"…","toolCall":{"toolCallId":"…","rawInput":{"command":"echo probe-ok","description":"…"}},"options":[{"kind":"allow_always","optionId":"allow_always"},{"kind":"allow_once","optionId":"allow"},{"kind":"reject_once","optionId":"reject"}]}   // toolCall 无 kind/title；optionId 为任意串；allow_always 排第一
--> {"jsonrpc":"2.0","id":9,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}
<-- tool_call_update  {"sessionUpdate":"tool_call_update","toolCallId":"…","status":"completed","rawOutput":{"type":"text","text":"Stdout: probe-ok\r\n\nStderr: (empty)\nExit Code: 0\nSignal: (none)"}}   // rawOutput 是单对象而非块数组
<-- {"stopReason":"end_turn"}
// ⑤ 取消：prompt "Count slowly…" 进行 5s 后发 session/cancel（通知，无响应）
<-- {"stopReason":"cancelled","userMessageId":"…","_meta":{"codebuddy.ai/outcome":"CANCELLED"}}   // 距 cancel 仅 45ms
//    cancel 后迟到 update 仅 1 条（usage_update）；SIGTERM 后 ~60ms 退出 {code:0}；全程 stderr 0 行、非 JSON 行 0 条、fs/* 请求 0 次
```

结论：initialize / session-new / prompt / request_permission / cancel 五项全部实测成功；本页标注「实测」的行为均来自本次输出。如实标注的未实测项：opencode 全链路（未安装）、codebuddy 的 authenticate 与 session/load、plan/notice/compaction 变体、mcpServers 注入（0.9.4 已实现，真机接受形态未实测，见 03 分册 §6）、多回合中途消息（回合边界交付由 §8 fake 测试覆盖）。

## 10. 实测勘误（2026-11-05 复测：codebuddy 2.180.0 + opencode 2.2.5）

冻结正文（§1-§9）不作改动；以下为同日复测与冻结正文的差异清单，细节归位在分册。复测环境：codebuddy 2.180.0（`/usr/local/nodejs/bin/codebuddy`，别名 `cbc`）；opencode 2.2.5（npm 全局 `@opencode/cli`，Bun standalone 二进制；`opencode acp` 子命令存在，仅 `--login` 一个 flag）。两家 `initialize` 均返回 `protocolVersion:1`。

| # | 冻结正文 | 复测结论 | 归位 |
| --- | --- | --- | --- |
| 1 | §2.3/§3：tool_call 首事件可 rawInput 空、kind 'other' | 2.180.0 首事件**同时**带 `input:{}` 与 `rawInput:{}`（`input` 是厂商键，应忽略）；同 id 全量重发修正 kind 不变，全量重发的 rawInput 新增 `timeout`。**opencode 首条 tool_call 即全量**（name/title/kind/status/locations/rawInput 齐备）——累积器 upsert/合并语义同时覆盖两种形态，接口签名不变 | 03 分册 §2.1/§3.1 |
| 2 | §2.3 兜底行 / §3 表：忽略集合 | 2.180.0 回合实测 `config_option_update`×1（此前未观察到，属 §2.3 已列忽略集合，计数即可）；`session_info_update` 高达 50 条/回合，忽略集合在压力下工作正常 | 03 分册 §2.1 |
| 3 | §4 `cancelled` 行：主动取消路径 | **用户拒绝权限也以 `stopReason:'cancelled'` 收尾**（codebuddy 附 `_meta.codebuddy.ai/outcome:'PERMISSION_DENIED'` 与 errorMessage `"Permission denied for tool(s): unknown"`，约 285ms；opencode 同）——cancelled ≠ 用户取消。worker 层按本回合拒绝次数区分：有拒绝 → `failed('Permission denied by user: <tool>')`；无拒绝 → `failed('Aborted')`。02 分册 §4 的 cancelled 行按此收窄 | 04 分册 §9.1 |
| 4 | §5 输入合并：请求 toolCall 无 kind/title，rawInput {command,description} | 2.180.0 请求 toolCall 仍无 kind/title/name；rawInput 为 {command,description}（bash）或 {file_path,content}（Write）；**只对有副作用的工具发**（read/search 不发）。opencode（注入权限闸后）请求为全量形状（name/kind/locations 齐备），rawInput {path,content}——键名是 `path`；§5 提取链本就覆盖 | 04 分册 §9.2/§9.3 |
| 5 | §5 optionId：allow / reject / allow_always | 2.180.0 为 allow_always('allow_always') / allow_once('allow') / reject_once('reject')；opencode 为 once / always / reject——再次印证 optionId 是任意串、只能按 kind 选 | 04 分册 §9.3 |
| 6 | §6：cancel 后 45ms 返回、迟到 update 1 条 | 2.180.0：242ms 返回、迟到 3 条（收尾性质，trustUpdatesAfterCancel=true 保留写入）；opencode：20ms、迟到 2 条（false 丢弃计数）。两家 agent 均自行杀工具子进程；cancelGraceMs 默认（8000/5000）裕度仍足 | 03 分册 §2.1/§3.1 |
| 7 | （冻结页未对 opencode 权限行为作假设） | **opencode 2.2.5 默认权限全 allow**（仅 .env 读取 ask）：不注入配置时对 bash 与文件写（含 workspace 外）从不发 request_permission，越界写静默落盘——权限桥被整体旁路。修复：注入 ask-all 权限闸（子进程 env `OPENCODE_CONFIG` 或 workspace 根 `opencode.json`，内容 `{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}`），由新增配置 `protocol.gatePermissions`（默认 true）控制 | 03 分册 §3.2、05 分册 §3.1 |
| 8 | §9 环境行（2.167.0） | 复测版本：codebuddy 2.180.0（§9 证据为 2.167.0，保留不动）。opencode 新增实测：authMethods 单项 `["Login with opencode"]`、agentInfo `{name:"OpenCode", version:"2.2.5"}`、session/new 键 `[sessionId, configOptions]` | 03 分册 §3.1 |

验收口径补充：原 §8 用例 1-5 的 fake e2e 夹具（`e2e/fixtures/fake-acp-agent.cjs`）未交付，改以 opt-in 真机用例覆盖（`ACP_REAL_CODEBUDDY=1` / `ACP_REAL_OPENCODE=1`，默认跳过；另有默认常跑的受控 PATH cli-missing 用例）；是否补登 fake 夹具为待办，见 06 分册 §3/§5。
