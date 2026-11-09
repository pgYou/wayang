# 分册 02：worker 骨架（src/services/agents/acp/）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`（0.8.4 权限层已合入）。本册日期：2026-11-05。
- **契约归属**：事件映射表与映射函数签名见冻结页 `00-interface-freeze.md` §3；取消/超时/停止策略见其 §6；对上层暴露的最小面见其 §7。本册写骨架的**生命周期设计**：五钩子的 v3 形状、`run()` 骨架、stopReason 映射、能力视图、transcript 同构约束。与冻结页冲突时以冻结页为准。
- 本册范围内的文件：`base-acp-worker.ts`、`event-mapper.ts`；`permission-bridge.ts` 见 04 分册；两个 provider 薄类见 03 分册。

## 1. 定位：三层分工的中间层

```
TaskExecuteEngine.createWorker           ← switch (config.type)（task-execute-engine.ts:1035），不做注册表
  └── IWorkerInstance（不变，src/types/worker.ts:47-89）
        ├── WorkerAgent                   （puppet，现状）
        ├── ClaudeCodeWorker              （SDK 通道，现状不动；不继承 BaseAcpWorker）
        └── BaseAcpWorker                 （新增：ACP 通用骨架，abstract）
              ├── CodebuddyAcpWorker      （新增，主路径）
              └── OpenCodeAcpWorker       （新增，experimental）
                    └── 组合持有 AcpClient（每次 run() 新建一次传输与 session）
```

| 层 | 位置 | 职责 | 明确禁止 |
| --- | --- | --- | --- |
| 协议层 | `src/services/acp/` | 见 01 分册 §1 | 不含任何 wayang 业务策略 |
| **骨架** | `src/services/agents/acp/base-acp-worker.ts` | 实现 `IWorkerInstance`：`run()` 骨架、`WorkerState` / `conversation.jsonl` 写入、`acceptMessage` 队列（回合边界交付）、`abort()`、`getLiveStatus()`、能力视图、审计埋点 | 不出现 `if (provider === …)`；不定义 provider 默认命令；不自己写 JSON-RPC / 起进程 / kill |
| provider 薄类 | `codebuddy-acp-worker.ts` / `opencode-acp-worker.ts` | 只覆写五钩子（§2）+ 本 provider 的事件后处理 | 不复制 `run()` 骨架；不跨 provider 复用私有逻辑 |

- **不引入与 `IWorkerInstance` 平行的 worker 抽象**：引擎只认 `IWorkerInstance`（abortAll / cancel / message delivery 全部按接口调用），两个 ACP 类只是同一接口的两个实现。
- **不重写 `ClaudeCodeWorker`**：claude-code 走 SDK 通道，具备 ACP v1 表达不了的能力（拒绝可带理由、in-process SDK MCP 的 `ask_controller`、prompt iterable 句柄），改写等于净损失。它继续是 `switch` 的一个 case，不继承 `BaseAcpWorker`、不碰协议层。
- **分发保持 `switch`，按配置里必填的 `type` 落到具体类**（`claude-code` / `codebuddy-acp` / `opencode-acp`，见 05 分册）：实现类型的集合是封闭的、编译期已知，注册表只会把「漏注册」从编译期错误挪成运行期错误。构造签名统一 `(config, sessionDir, workspaceDir, ctx, skills)`，与 `ClaudeCodeWorker` 一致。

## 2. 五钩子（v3 形状）

冻结页 §7 规定五钩子沿用 v2 §3.1 的划分（`buildLaunch` / `mapPermission` / `normalizeError` / `isReady` / `stopPolicy`），范围外条目已删除。v3 对齐冻结页类型后的最终形状如下；**v2 §3.1 里与本处冲突的 TS 定义作废**（差异见 §2.6）。

```ts
// src/services/agents/acp/base-acp-worker.ts
export interface AcpStopPolicy {
  /** session/cancel 之后等 settle 的宽限；超时进 SIGTERM。 */
  cancelGraceMs: number;
  /** SIGTERM 之后等多久 SIGKILL。 */
  sigtermWaitMs: number;
  /** 取消后是否仍信任 agent 的后续 session/update（false → 丢弃并计数，冻结页 §6.4）。 */
  trustUpdatesAfterCancel: boolean;
}

export interface AcpReadyContext {
  handshake: AcpHandshake;             // 冻结页 §2.3（含 authMethods，登录态归因用）
  phase: 'handshake' | 'session-new';  // 判定时机：握手后 / session/new 失败后
  error?: unknown;                     // phase='session-new' 时的原始错误（超时 / JSON-RPC error）
  stderrTail: string[];                // transport.stderrTail()（冻结页 §2.2），供关键词归因
}

export interface AcpReadiness {
  ready: boolean;
  /** 归因枚举收窄：0.9.0 唯一需要握手后归因的失败就是登录态。 */
  kind?: 'auth-required';
  /** acpUserMessage 产出（冻结页 §2.5），直接给用户展示。 */
  message?: string;
}

export abstract class BaseAcpWorker implements IWorkerInstance {
  /** 1) 启动：command / args / env 合并、cwd；缺 CLI 由 worker 层 preflight 报 cli-missing（§3 步骤 1）。 */
  protected abstract buildLaunch(env: WorkerEnvView): AcpLaunchConfig;
  /** 2) 权限：默认实现走共享 permission-bridge（04 分册）；provider 仅在必要时覆写。 */
  protected mapPermission(req: AcpPermissionRequest, ctx: PermissionContext): Promise<AcpPermissionOutcome>;
  /** 3) 错误归一化：把 phase 内的失败折成 AcpError（code/userMessage 已由冻结页 §4 分类表给出）。 */
  protected abstract normalizeError(err: unknown, phase: 'handshake' | 'session-new' | 'prompt'): AcpError;
  /** 4) 就绪判定：握手成功 ≠ 可用（codebuddy 未登录实测：session/new 无响应）；归因在 §3 步骤 5。 */
  protected abstract isReady(ctx: AcpReadyContext): AcpReadiness;
  /** 5) 停止策略：数值默认见 03 分册（codebuddy 8000/2000/true；opencode 5000/2000/false）。 */
  protected abstract stopPolicy(): AcpStopPolicy;
}
```

### 2.6 与 v2 §3.1 的差异（实现方必读）

- `AcpSession`（含 `AcpLaunchSpec` / `capabilities()` / `cancel(reason)`）**拆并**为冻结页的 `AcpClient` + `AcpTransport` + `AcpLaunchConfig`：骨架组合持有 `AcpClient`，不再有 `AcpSession` 这个类型。
- `AcpLaunch.preflight` 字段取消：预检是 worker 层行为，放在 `buildLaunch` 之前的骨架步骤里（§3 步骤 1）；协议层 spawn 的 ENOENT/EACCES/ENOEXEC 同样折成 `cli-missing`（冻结页 §2.2），双保险。
- `AcpFailure` / `AcpFailureKind` **作废**，统一为 `AcpError` / `AcpErrorCode`（七值，冻结页 §2.5）；`normalizeError` 的产出就是 `AcpError`，`isReady` 的归因只剩 `auth-required` 一种，v2 枚举里范围外的值（`adapter-missing` / `exited` / `turn-timeout`）不再存在（进程退出走 `transport-closed`，回合超时走取消路径收口为 `cancelled`，冻结页 §4 注）。
- `AcpCapabilities` 的 `authRequired` / `inquiry` 字段收窄：`inquiry: false` 恒占位（0.9.0 不提供 `ask_controller`，主文档风险表）；登录态不再是能力位，而是 `auth-required` 归因（`AcpCapabilities` 形状以冻结页 §2.3 为准）。

## 3. `run()` 骨架（生命周期，固定顺序）

```
run(task, tools, onProgress)
  1. preflight（worker 层）：解析 command（PATH / 绝对路径）；未找到 → AcpError('cli-missing')（文案带 provider 安装指引，04/07 分册）。
  2. buildLaunch() → AcpLaunchConfig（env 已与 process.env 合并——合并由 worker 层完成，冻结页 §2.1）。
  3. new StdioAcpTransport(config).start()：spawn；ENOENT/EACCES/ENOEXEC → 同样 cli-missing。
  4. client.initialize()：handshakeMs 超时 → handshake-timeout；回包版本 ≠ 1 → protocol-mismatch。失败先 transport.close 再抛。
  5. isReady({handshake, phase:'handshake'})：ready=false → 直接失败，文案走 message。
  6. client.sessionNew({ cwd: workspace（绝对路径）, mcpServers: [] })：
     sessionNewMs 超时且 authMethods 非空 → auth-required；stderr 命中 login/auth/unauthor/token/401 → 短路归因（不等超时，冻结页 §4）。
  7. 回合循环：任务提示词 + 空闲期堆积消息（首个 prompt）；之后每回合 = 一次 sessionPrompt。
     acceptMessage 只入队（回合边界交付）；回合内没有注入手段（01 分册 §2.4）。
  8. stopReason 到达 → flushUnsettled（未完成 tool_call 标 cancelled）→ 最后一段 agent-text 作为回合 summary。
  9. 收尾：WorkerResult 映射（§4）→ close('run-finished')（幂等）→ 写 System/TaskResult|Error 条目。
```

- **同 session 串行**：上一回合未 settle 再调 `sessionPrompt` → `AcpError('protocol-mismatch')`（冻结页 §2.4）。
- **回合边界交付**：`acceptMessage` 在 `_inputClosed` 后返回 false（对齐 claude-code-worker 的语义：调用方必须报失败而不是假装已排队）；`pendingMessages()` 供引擎发 `message_undelivered` 信号。
- **`getLiveStatus()`**：`resultReceived` = stopReason 已到；`streamEnded` = 回合已 settle（冻结页 §7 TUI 行）。
- **pid 记录**：spawn 后把 `pid` / `command` / `provider` 写进 `WorkerState.runtimeState.acp`，为「启动时扫孤儿」留证据；0.9.0 只记录不清理（主文档「不做」第 8 条）。

## 4. stopReason → WorkerResult 映射（0.8.4 引擎口径）

| stopReason | WorkerResult | 引擎侧行为 |
| --- | --- | --- |
| `end_turn` | completed（summary = 最后一段 agent-text） | 正常收尾 |
| `max_tokens` / `max_turn_requests` / `refusal` | failed（`agent-error`，冻结页 §4 文案） | 可重派 |
| `cancelled` | failed(`'Aborted'`) | 引擎 `consumeCancelled`（task-execute-engine.ts:1455）抑制多余的 failed 信号——既有机制，零改动 |

取消不是崩溃：`abort()` → `sessionCancel`（client 同时自动对全部待决 permission 回 `cancelled`，协议 MUST）→ 等 settle。实测 codebuddy cancel 后 45ms 返回 `cancelled`；`cancelGraceMs` 未 settle → SIGTERM → `sigtermWaitMs` → SIGKILL，两跳都记 warn。完整时序与迟到 update 的丢弃策略见冻结页 §6（`trustUpdatesAfterCancel=false` → 丢弃 + debug 计数 `discarded_after_cancel`，不写 transcript）。

## 5. 事件映射与累积器（worker 层 event-mapper.ts）

映射表（session/update → wayang）以冻结页 §3 为准，此处不重复。设计动机：

- **累积器 `AcpToolAccumulator`**：`byToolCallId` 累积，`tool_call` 后到全量覆盖、`update` 增量合并（实测同 id 发两次 `tool_call`，01 分册 §4 第 1 条）。**首个快照不产出 record**——首事件 rawInput 可为空、kind 可为 `other`，等合并后再判定。
- **回合结束 `flushUnsettled`**：仍未 completed/failed 的调用标 `cancelled`（status 枚举没有 cancelled 取值，01 分册 §2.5）。
- `agent_thought_chunk` 不进 transcript（实测一次简单回合最多 36 条，写入即污染）；`plan` / `usage_update` 只透传 runtimeState；`user_message_chunk` 忽略（wayang 自写 UserEntry，不接受 agent 回显）。
- 文本进度不在这里逐 chunk 播报：`agent-text` 只进 `AcpTurnWriter` 聚合，进度由该聚合出的完整消息驱动（见 03 分册 §6）。

## 6. 能力视图

`AcpCapabilities`（冻结页 §2.3）是给上层的稳定视图，与协议字段解耦：`streaming: true` 恒真；`toolCalls` / `permissionRequests` 来自实测观察（本回合内是否出现对应事件），可被配置覆盖（05 分册）；`midTurnInject: false` / `inquiry: false` 恒占位——**语义显式**：不支持就写 false，不缺省、不猜。0.9.0 没有「某 provider 不支持权限请求就静默降级」这回事：`permissionMode:'agent'` 不注册 handler 时，agent 仍发请求 → 回 `cancelled` + 审计，不静默放行（04 分册 §6）。

## 7. transcript 同构（硬约束，读取侧零改动）

- 写入：`<sessionDir>/workers/<workerId>/conversation.jsonl`（`worker-state.ts`，条目形状与 puppet / claude-code 完全一致）；`AssistantEntry.toolCalls/toolResults` 挂 `ToolCallRecord` / `ToolResultRecord`（`arguments` = rawInput JSON、`output` = content 块文本拼接缺则 `rawOutput.text`）。
- 读取：`src/services/worker-transcript.ts` 路径不变，`read_worker_conversation` / `get_worker_status` / `get_task_detail` 无需为 provider 分叉。**事件映射迁就 `ToolCallRecord` 的形状，而不是反过来**（这是「不改读取侧」的硬约束）。
- TUI 零改动：`ActiveWorkerInfo.workerType`/`emoji` 已够用；工具行展示沿用既有 `ToolCallRecord` 渲染。

## 8. 骨架禁令与漂移拦截

- 骨架里出现 `if (provider === …)` → 上移成钩子；provider 类里出现「另一家也要的逻辑」→ 下沉到骨架或共享件（`permission-bridge.ts` / `event-mapper.ts`）。
- 反例判据：任何一处改动需要在两个 provider 类里同时做一遍，就是抽象层次选错了（主文档「不做」第 12 条）。
- 测试侧对应纪律：provider 差异断言写在该 provider 的测试文件里，公共断言函数不允许 `if provider` 分叉（06 分册 §1）。
