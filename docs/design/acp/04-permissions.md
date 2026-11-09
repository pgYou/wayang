# 分册 04：权限桥（0.8.4 语义）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：**0.8.4 实际代码**（release/0.9.0 @ `7bfd1e2` 已合入）。本册日期：2026-11-05。
- **契约归属**：权限桥契约（输入合并、kind→策略工具名映射、裁决→outcome 序列、optionId 生成方式、超时默认、fail-closed 三铁律）以冻结页 `00-interface-freeze.md` §5 为准，本册不重复该表。本册写**0.8.4 基线的权限栈事实**（冻结页默认读者已知）与**v2→v3 的语义修正**——v2 §3.5 基于 0.8.3 语义的描述（如「敏感写=硬拒」）全部作废。
- 共享件：`src/services/agents/acp/permission-bridge.ts`，由 `BaseAcpWorker.mapPermission` 的默认实现调用（02 分册 §2）。

## 1. v2 → v3 修正清单（先读这个）

| # | v2（0.8.3 语义，作废） | v3（0.8.4 语义，以冻结页 §5 为准） |
| --- | --- | --- |
| 1 | 「deny（敏感写）→ reject_once」；敏感写=硬拒 | **敏感命中（含写方向）默认 `ask` 走审批**（`SensitiveMode='ask'` 默认，config.ts:60-72）；只有 `sensitiveMode:'deny'` 时出现 `deny` 裁决 → `hard-denied` 审计 + selectRejectOption，无 reject 选项 → outcome `cancelled`，本回合按失败收口 |
| 2 | 权限 scope 字段叫 homeDir 之类 | scope 字段更名 **`userHome`**（`WorkerAccessScope{userHome, workspace, taskAllowedDirs?, permission?}`，permission-rules.ts:102） |
| 3 | 「sensitive-list-write」规则名 | **已并入 `sensitive-list`**：方向不编码在规则名里，由独立 `access` 字段表达（`PermissionAuditEntry.access`，permission-audit.ts:48-52；`ToolAccessDecision.access`） |
| 4 | 审计枚举只有 approved/denied（0.8.3） | 0.8.4 枚举：**`allowed` / `approved` / `denied` / `hard-denied` / `granted-by-memory`**；source：`controller` / `timeout` / `aborted`；新增 `grantId` 字段（permission-audit.ts:68-117） |
| 5 | 无审批记忆概念 | **approval memory（issue #46）已存在**：`ask` 且命中任务内 read 授权 → 不发信号直接放行（冻结页 §5 裁决 2） |
| 6 | `execute` 的 args 提取顺序把 `toolCall.title` 列在链尾（v2 §3.5，标注仅日志用） | title **完全退出提取链**（冻结页 §5 表：只取 `rawInput.command` → `rawInput.cmd`；取不到直接 ask）。title 只是展示字段 |
| 7 | `other`/缺失 kind → write_file 或 ask | **形态推断**：rawInput.command → bash；路径字段 + name 含 read/search/grep → read_file、否则 write_file；推断不出 → **不调 decideToolAccess，直接 ask**（decideToolAccess 对未知工具名恒 allow，绝不能把未知工具喂给它） |

## 2. 0.8.4 权限栈事实（判定所依赖的一切）

**入口**：`decideToolAccess(scope, toolName, args)`（permission-rules.ts:1813）。`scope` 由引擎注入（`WorkerAccessScope`，permission-rules.ts:102）——与 puppet / claude-code 共用同一个入口，ACP 侧不做第二套判定。

**裁决形状**：`ToolAccessDecision`（permission-rules.ts:120）——`{decision: 'allow'|'ask'|'deny', matchedRule, message?, reason?, matchedEntry?, matchedSource?, sensitive?, resolvedPath?, access?, askPaths?}`。要点：

- `askPaths`：本次 ask 需要审批的全部候选路径（一条一个）；reuse 判定必须查全（只查 `resolvedPath` 会让已批准的 `cat /a /b` 静默覆盖 `/b` 第二次）。
- 敏感命中：`sensitive:true` + `matchedRule:'sensitive-list'`；`sensitiveMode` 默认 `'ask'` → 走审批；`'deny'` → 硬拒（唯一产生 `deny` 裁决的路径）。
- 与冻结页冲突时以冻结页 §5 为准（冻结页开头已声明本层冲突裁决规则）。

**权限桥的输入合并**（冻结页 §5 开头）：`request.params.toolCall` 与累积器里同 toolCallId 的事件**合并后判定**——实测（§9）：codebuddy 请求 toolCall 无 kind/title/name，rawInput 为 `{command,description}`（bash）或 `{file_path,content}`（Write）；opencode（注入权限闸后）请求 toolCall 为全量形状，rawInput 为 `{path,content}`。首事件 rawInput 可为空（01 分册 §4 第 1 条）。判定永远基于合并结果，单事件判定是 bug。

## 3. approval memory（issue #46，0.8.4 既有机制，ACP 直接接入）

- 记忆范围：**只记 read**（`ApprovalDirection = 'read'`，approval-memory.ts）；键 = `approvalKey('read', canonicalPath)`；**敏感命中永不记忆**（两个 mode 都不记）；**拒绝不记忆**。
- 生命周期：grant 活在任务里——引擎在终态（completed/failed/cancelled）`clearTask(taskId)` 直调（task-execute-engine.ts:880，非 hook）；不持久化，`--resume` 从空开始。
- ACP 侧的接线（冻结页 §5 裁决 2，引擎注入）：`ask` 且 `access==='read'`、非敏感、`askPaths` 非空、每条 `approvalKey('read', path)` 都 `engine.approvalGrants.has(taskId, key)` → 选中 allow 选项；审计 `granted-by-memory` + `grantId`；不发信号。
- 批准时写回：`grants.remember(taskId, approvalKey('read', path), {requestId})`（每条 askPath），审计 `approved`。
- 引擎注入方式：`BaseAcpWorker.setSignalContext(...)` 在现有形状上追加 `grants: ApprovalMemory`、`approvalMemory: ApprovalMemoryMode` 两参（`resolveApprovalMemory`，task-execute-engine.ts:1334-1335 现状）；worker 侧暴露 `readonly permissionHandler: PermissionMiddlewareResult`（resolvePermission/cleanup，与 ClaudeCodeWorker 同形状，claude-code-worker.ts:129），引擎照旧 `permissionResolvers.set(...)`，`respond_permission` 工具零改动。

## 4. 审计（0.8.4 枚举 + ACP 扩展）

- 决策枚举：`allowed`（allow 快路径）/ `approved` / `denied`（source：`controller` / `timeout` / `aborted`）/ `hard-denied`（`sensitiveMode:'deny'` 的敏感命中）/ `granted-by-memory`（+`grantId`）。
- 复用 `recordPermissionAudit`（permission-audit.ts:144），**字段 allowlist 固定**：只进元数据（matchedRule/matchedEntry/matchedSource/resolvedPath/operation/access/taskId/workerId/toolName），永不进命令原文与文件内容。
- ACP 扩展（向后兼容）：`PermissionAuditEntry` 增两个只读可选字段 **`transport:'acp'`**、**`provider: config.type`**（如 `codebuddy-acp`）——老记录缺字段即旧格式；事后可按 provider 统计审批分布。
- 超时/abort 的结算：permission 等待超时（`permissionMs` 默认 300000，对齐 `PERMISSION_TIMEOUT_MS` 与 middleware `DEFAULT_TIMEOUT_MS`）→ `denied` + source `'timeout'` → selectRejectOption；取消/退出 → cleanup 按拒绝结算（source `'aborted'`），不得「没回就当放行」。

## 5. fail-closed 三铁律（任何 provider 不许放宽，冻结页 §5）

1. 判定输入缺失（无 kind 且形态推断不出、command/path 取不到）→ **ask**，永不静默 allow。
2. 选项集既无 allow 也无 reject → outcome `cancelled` + 审计 `hard-denied` + 记 `protocol-mismatch` 日志。
3. 传输错误 / 进程退出 / 超时 / abort → 一律按拒绝结算（cleanup），不得「没回就当放行」。

**optionId 生成方式**（冻结页 §5 末）：wayang **不生成** optionId——v1 每个选项必带 optionId（任意字符串，实测 codebuddy 为 `allow` / `reject` / `allow_always`）；选择只按 kind：`allow_once` > `allow_always`、`reject_once` > `reject_always`（`selectAllowOption` / `selectRejectOption`，冻结页 §2.4）。选项顺序不可依赖（实测 `allow_always` 排第一）。两类都缺 → `{outcome:'cancelled'}`。

**超时默认**：`permissionMs = 300000`（对齐 claude-code 的 `PERMISSION_TIMEOUT_MS`，claude-code-worker.ts:126，与 middleware `DEFAULT_TIMEOUT_MS` 一致）。等待走 `BlockingRequestMap.wait(requestId, permissionMs)`（src/infra/blocking-requests.ts:24）。

## 6. permissionMode（'client' / 'agent'）

- `'client'`（默认）：注册 `onPermissionRequest` handler，走上表全链路（裁决 → 记忆 → 信号 → 审计）。
- `'agent'`：不注册（显式放弃 client 侧管控，用于已知自带沙箱/审批的 agent）。**agent 仍发请求 → outcome `cancelled` + 审计（不静默放行）**；能力视图 `permissionRequests` 如实表达，不因 mode 而撒谎。
- **opencode 专属（#62 起文档化）**：`permissionMode:'agent'` 同时**跳过权限闸注入**，且优先级高于 `protocol.gatePermissions`——该模式下 agent 自管权限，wayang 既不注入 ask-all `OPENCODE_CONFIG`，也不桥接 `request_permission`（收到请求一律 `cancelled` + 审计）。`gatePermissions:false` 则只关注入：权限桥仍注册，agent 自带配置触发的请求照常走裁决链路。两条跳过路径都在启动日志 warn 一次，不静默（05 分册 §3.1）。
- 0.9.0 没有「不支持权限请求就静默降级」的路径：不支持就显式声明并在收到请求时报失配（02 分册 §6）。

## 7. 安全边界（必须写进 README / 配置示例）

client 在 `initialize` 里声明不支持 `fs/*`、`terminal/*`、`elicitation`、MCP-over-ACP（全 false）之后，**工具由 agent 自己执行；只有 agent 主动发 `request_permission` 时才可拦**。agent 若在自身策略下直接执行（等价于 claude-code 的 `bypassPermissions`），wayang 无法阻止——这与现状态一致，不是 ACP 引入的退步，但必须在用户文档中明说（05 分册配置示例旁注）。

## 8. 信号载荷（复用现有通路，零新增类型）

`ask` → 发 `permission_request` 信号（`PermissionRequestSignalPayload` 全字段）：`toolName = toolCall.name ?? kind`；`toolArgs = 合并后的 rawInput`（缺则 `{locations}`）；description 按现有格式（bash → `Execute shell command: <command>`、文件 → `<name>: <path>`）；`matchedRule` / `matchedEntry` / `matchedSource` / `resolvedPath` / `sensitive` / `access` / `operation` 从 verdict 投影。批准 → 选中 allow 选项；拒绝 → selectRejectOption + 审计 `denied` source `'controller'`；超时 → selectRejectOption + source `'timeout'`。`respond_permission` 工具零改动（§3）。

## 9. 拒绝 → cancelled：回合收尾语义与请求形态（2026-11-05 复测，两家一致）

### 9.1 拒绝也以 cancelled 收尾（stopReason 不再自证取消）

**实测事实**：用户拒绝权限后，两家 agent 都让回合以 `stopReason:'cancelled'` 收尾——codebuddy 附 `_meta.codebuddy.ai/outcome:'PERMISSION_DENIED'` 与 `errorMessage` `"Permission denied for tool(s): unknown"`，距拒绝响应约 285ms；opencode 同为 `cancelled`。**因此 cancelled ≠ 用户取消**：单看 stopReason 无法区分「用户点了拒绝」与「用户取消了任务」。

**映射规则（worker 层，收窄 02 分册 §4 的 cancelled 行与冻结页 §4）**——按**本回合拒绝次数**区分：

| 本回合拒绝次数 | stopReason 'cancelled' 的归因 | WorkerResult |
| --- | --- | --- |
| ≥1（permission 审计已落 `denied`） | 权限被用户拒绝 | `failed('Permission denied by user: <tool>')` |
| 0 | 用户/上层主动取消 | `failed('Aborted')`（引擎 `consumeCancelled` 既有路径） |

拒绝发生在回合 settle 之前（审计先落 `denied` source `'controller'`），计数在收口时天然可得；`_meta` 厂商字段只作旁证，不作判据（01 分册 §4 第 5 条）。

### 9.2 哪些工具会请求权限（实测触发面）

- **codebuddy 2.180.0**：只对**有副作用的工具**发 `request_permission`——bash / Write 发，read / search 不发。后者由 agent 自治执行，wayang 侧裁决不可达（安全边界见 §7）。
- **opencode 2.2.5**：默认权限全 allow（仅 `.env` 读取 ask）→ **不发任何请求**，权限桥被整体旁路（03 分册 §3.2）；**注入权限闸（ask-all）后**请求才出现，且每个工具执行都会 ask。`protocol.gatePermissions`（05 分册 §3，默认 true）控制注入。

### 9.3 请求形态与选项（实测，进 permission-bridge 断言）

| 维度 | codebuddy 2.180.0 | opencode 2.2.5（注入权限闸后） |
| --- | --- | --- |
| 请求 toolCall | 无 kind / title / name，判定靠合并累积器 + 形态推断 | 全量形状（`name:'write'`、`kind:'edit'`、`locations` 齐备） |
| rawInput 键 | bash `{command,description}`；Write `{file_path,content}` | write `{path,content}`——**键名是 `path` 不是 `file_path`**，冻结页 §5 提取链已覆盖 |
| 选项（optionId） | `allow_always('allow_always')` / `allow_once('allow')` / `reject_once('reject')`，`allow_always` 排第一 | `allow_once('once')` / `allow_always('always')` / `reject_once('reject')` |

两家 optionId 字面值不同，再次印证 §5 铁律：**选择只按 kind**（allow_once > allow_always、reject_once > reject_always），代码里禁止对 optionId 字面值做比较或匹配。
