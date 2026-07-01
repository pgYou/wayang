# 长时运行：Worker 按需驻留 与 Per-workspace Sessionless

> 状态：已实施（Phase A + Phase B）
> 关联 Roadmap：
> - Persistent Workers Across Tasks
> - Sessionless Long-Running Agent

本文档记录"让 Controller 和 Worker 活得更久"这一方向的设计与实现。两个特性独立落地、互不阻塞。

---

## 0. 定位

本次迭代把 Wayang 的定位明确为**项目编排器**（单 workspace 内的多智能体大脑，"多智能体版 Claude Code"），并据此给用户**常驻感**：

- **Worker 驻留**：对任何定位都是纯增益，先做。
- **Sessionless**：采用 **per-workspace**（按 workspace 索引的最新会话继承），**不是**全局一条连续流。这样 workspace 概念保住、权限边界（`isInsideWorkspace`）不破、跨项目污染消失，同时拿到"一直都在"的体感。

明确**不做**：机器级 AI 管家（需 daemon + 持久记忆 + 新安全模型，是另一个项目，不寄生在本轮）。

## 1. 背景与动机

当前 Wayang 的生命周期是"一次性"的：

- **Worker**：一任务一实例，`done` / `fail` 后立即回收，上下文随之丢失。
  对于天然多阶段、阶段间需要人类或 Controller 检查才能推进的任务（例如"先出方案 → 人类 review → 再写代码"），每进入下一阶段都得冷启动一个新 Worker，重新铺设上下文。
- **Controller / Session**：每次 `wayang` 启动都是全新的 session，只有显式 `--resume` 才继承上次。
  用户感知上是"一次会话一用"，而不是"一个一直都在的助手"。

这两个问题对应 Roadmap 里两条独立但风格呼应的条目，本文档把二者合并讨论，因为它们共享同一条主线：**把生命周期的"终点"从默认值改成可选的、更长的形态**。

## 2. 设计原则

1. **不引入 Worker 池**。默认仍然"用完即回收"，驻留是一种**按需启用的可选项**，而不是把所有 Worker 变成常驻资源。
2. **不引入长期记忆系统**（向量检索、跨运行自动归档等）。notebook 工具已经承担"用户主动让它记住"这部分职责，本轮不扩展。
3. **改造 = 加支路，而非换主干**。两个特性都只在现有状态机/生命周期上"加一条可选分支"，主路径保持不变。
4. **决策权归属 LLM，机制归属代码**。何时驻留、何时视历史任务为作废，由 LLM 在合适位置判断；代码只提供机制与兜底。

## 3. 整体设计

### 3.1 Worker 按需驻留（Multi-stage Worker）

**语义**：Controller 在创建任务时，如果判断该任务天然需要分多个阶段、阶段间需要人类或 Controller 检查，就显式声明"完成后不要销毁 Worker"。Worker 在阶段性工作结束后进入**待命（idle）**状态，下一阶段可以把新任务直接派发给这个 Worker，带着已有上下文继续工作。

**决策权**：由 Controller LLM 在 `add_task` 时显式声明（而不是 Worker 自主请求暂停）。

**Worker 生命周期扩展**：

```
pending ──► running ──┬──► completed ──► disposed   (默认路径)
                      │
                      └──► idle ──► running ──┬──► completed ──► disposed
                            ▲                  │
                            └──── assign ──────┘
                            (下一阶段任务派发到该 idle worker)
```

- `idle` 态：任务本身标记为阶段性 `completed`，但 Worker 实例 + `WorkerState` 保留。
- 从 `idle` 回到 `running`：通过 `TaskExecuteEngine.assignToExistingWorker(workerId, task)` 路径，**复用同一实例**，重装配工具/权限中间件后再次 `run()`。
- 失败永不驻留：`multiStage=true` 但任务 `failed` 时，仍走销毁路径（只有成功才进 idle）。
- 回收兜底：
  - 超时未被复用 → 自动销毁（默认 30 分钟，config `idleTimeoutMs` 可覆盖）。
  - 计入 `maxConcurrency`：idle worker 也占坑（`getOccupiedSlots()` = running + idle），防止用户不知情攒一堆。
  - 显式 `dispose_worker` 工具 / 用户从 TUI 手动销毁（`abortByWorkerId`）。

**Controller ↔ Worker 工具改动**（采用方案 A：复用 `add_task`，减少工具数量）：

- Controller 工具 `add_task` 新增字段：
  - `multiStage: boolean`（默认 false）。
  - `assignToWorker?: string` —— 把本任务派发给某个 idle worker（workerId 来自上一阶段完成信号）。省略 = 新建 worker。
- Controller 新增工具 `dispose_worker(workerId)`：手动回收一个不再需要的 idle worker，立即释放占坑。
- Worker 的 `done` 语义分化：
  - `multiStage=false`：同现状，任务完成 → Worker 销毁。
  - `multiStage=true`：任务完成 → Worker 进入 `idle`，不销毁。
  - 不新增 `pause` 工具，Worker 自己不主动决定驻留。

**Task 字段**：`TaskDetail` 新增 `multiStage?: boolean`、`assignToWorker?: string`、`assignedFromWorkerId?: string`（派发到 idle worker 时记录来源）。

**Worker 实现改动**：

- `WorkerAgent`（puppet）：`collectLoop` "跑完就返回"，`run()` 设计为**可重入**——每次重置 `_terminalResult` 并追加新任务描述为 user message，已有 conversation 自然延续。puppet 是 multiStage 的主要受益者。
- `ClaudeCodeWorker`：**修复了 `_terminalResult` 不重置的重入 bug**（`run()` 开头置 null）。但 Claude Agent SDK 的 `query()` 每次开启新 session，所以 claude-code 的 multiStage 只复用实例与持久化的对话日志，**底层 Claude 进程重新开始**——multiStage 对它收益有限，已在代码注释中说明。

**TUI 改动**：

- active worker 列表（`worker-list-overlay`）区分 `running` / `idle`（idle 灰色 + ⏸ 标记 + 计时切换为 idle 时长）。
- worker-detail-page 显示 idle 状态、`⏸ idle` 徽章、上一阶段 `lastStageSummary`，并提示"等待后续任务 / 超时自动回收"。

### 3.2 Per-workspace Sessionless Controller

**语义**：Controller 默认就继承**本 workspace** 上一次运行的上下文。真正的"全新开始"需要显式 `--fresh`。Workspace 概念保住，权限边界不破，跨项目不污染。

**关键决策**：

| 决策点 | 选择 | 说明 |
|---|---|---|
| 跨 workspace 继承 | **per-workspace**（按 workspace 索引最新会话） | 不做"全局一条流"。workspace 是承重概念（工具 cwd、权限判定边界），全局流会破坏它并引入跨项目污染 |
| 上一次未完成任务 | **作为 `previous_session_tasks` signal 注入，由 Controller LLM 判断** | 不自动恢复 Worker；LLM 自行决定重新 dispatch / 视作历史 / 询问用户 |
| 长期记忆 | **不做** | notebook 工具承担"主动记忆"职责 |
| 全局流 / 机器级管家 | **不做** | 那是另一个项目（需 daemon + 持久记忆 + 新安全模型） |

**启动流程反转**：

- `wayang`（默认）：继承本 workspace 最近一次 session（`getLatestSessionForWorkspace`）；若该 workspace 无历史 session，则新建。
- `wayang --fresh`（别名 `-n` / `--new-session`）：显式全新会话。
- `wayang --resume` / `wayang --resume <id>` / `wayang --resume --all`：保留为**显式选择历史 session**（交互式列表 / 指定 ID / 跨 workspace 列表），不废弃。

**冷启动压缩**：

长时运行必然面临 token 爆炸。继承的对话尾部可能已经超阈值。处理：

- 在 `Supervisor.start()` 中、Controller loop 启动前，检查 `controllerAgent.needsCompaction()`，若超阈值则调一次 `performCompaction()`。
- 复用 `ControllerAgent` 已有的 LLM-based context compaction，**不新增压缩设施**。
- 压缩策略的 fallback 链：LLM 摘要失败 → half-truncation（现有）→ 空上下文。

**未完成任务的处理**：

启动时（`Supervisor.restore()`）：

1. 在 `engine.restore()` 运行 `recoverCrashedTasks`（把 running 标 failed）**之前**，用 `readSessionUnfinishedTasks` 快照上次 session 的 pending + running 任务。
2. 把快照做成一条 `previous_session_tasks` signal 注入 `SignalQueue`。
3. Controller LLM 在第一次循环中看到这条 signal，自行决定：
   - 视作历史，直接忽略；
   - 重新 `add_task` 某几条；
   - 询问用户。

**不做**：

- 不做自动恢复 running worker。启动时任何 idle/running worker 都不复活（与现有 `recoverCrashedTasks` 标 failed 一致），避免意外副作用。
- 不做跨 session 的 worker 驻留（驻留只在单次 Controller 运行内有效）。
- 不做全局流 sessionless（明确 per-workspace）。

### 3.3 两个特性的边界

- **Worker 驻留** 活在单次 Controller 运行内：Controller 退出时所有 idle worker 一并销毁。
- **Sessionless Controller** 管的是 Controller 自身的跨启动上下文。
- 二者独立可落地，互不阻塞。

## 4. 架构映射

| 改动点 | 主要涉及模块 |
|---|---|
| `add_task` 增加 `multiStage` / `assignToWorker` | `src/services/tools/add-task.ts` |
| 新增 `dispose_worker` 工具 | `src/services/tools/dispose-worker.ts` |
| Worker 状态机增加 `idle` + `assignToExistingWorker` 派发路径 | `src/services/task-execute-engine.ts` |
| 抽取 `wireWorker`（工具+权限+signal 装配，新建与复用共用） | `src/services/task-execute-engine.ts` |
| idle worker 超时回收 / 占坑 / 手动销毁 | `src/services/task-execute-engine.ts`（配合 `idleTimeoutMs`） |
| `worker:idle` 生命周期 hook | `src/services/lifecycle-hooks.ts` |
| Worker 完成后进入 idle 的语义（multiStage 分支） | `task-execute-engine.ts`（`handleDone`） |
| ClaudeCodeWorker 重入修复 | `src/services/agents/claude-code-worker.ts` |
| TUI 区分 running / idle | `src/tui/components/worker-list-overlay.tsx`、`src/tui/pages/worker-detail-page.tsx` |
| 启动默认继承本 workspace | `src/bootstrap.ts` + `src/infra/session-helpers.ts` |
| `--fresh` flag | `src/cli.ts` |
| 冷启动压缩 | `src/services/supervisor.ts`（`start()` 内） |
| 未完成任务注入为 signal | `src/infra/session-helpers.ts`（`readSessionUnfinishedTasks`）+ `src/services/supervisor.ts` + `SignalQueue` |
| `previous_session_tasks` signal 类型/转换器 | `src/types/signal.ts`、`src/services/agents/controller-agent.ts` |

## 5. 实施记录（已完成）

两个特性独立推进，先 A 后 B。

### Phase A：Worker 按需驻留

**A1. 类型层**
- `ActiveWorkerInfo` 加 `status: 'running'|'idle'`、`lastStageSummary`、`idleSinceMs`。
- `TaskDetail` 加 `multiStage`、`assignToWorker`、`assignedFromWorkerId`。

**A2. 引擎状态机 + 派发路径（核心）**
- 抽取 `spawnWorker` 中的"装配工具 + 权限中间件 + signal context"为 `wireWorker`，新建与复用共用。
- `assignToExistingWorker(workerId, task)`：校验 idle → 清除 TTL → 转 running → `wireWorker` 重装配 → 复用实例 `run()`。
- `handleDone`：失败一律销毁；成功 + `multiStage` → 进 idle（保留实例、记 summary、启动 TTL）；成功 + 非 multiStage → 销毁。
- `getOccupiedSlots()` = running + idle；`scheduleNext` 据此占坑。
- idle TTL 回收：`idleTimers` Map + `disposeIdleWorker`（abort + 移除 + 发 `cancelled` signal）。
- `abortByWorkerId` / `abortAll` / `cancel` 处理 idle 销毁。
- 新建 `task-execute-engine.test.ts`（此前无）：覆盖状态机、assign 复用、idle 占坑、TTL 回收、multiStage 分支、手动销毁、shutdown（10 例）。

**A3. Controller 工具**
- `add_task` 加 `multiStage` / `assignToWorker`（含 `validateIdleWorker` 前置校验）。
- 新增 `dispose_worker` 工具。
- `ControllerToolDeps` + `controller-agent` factory 接线。

**A4. Worker 侧适配 + bug 修复**
- `WorkerAgent.run()` 补 multiStage 可重入注释。
- `ClaudeCodeWorker.run()` 开头 `this._terminalResult = null`（修复重入 bug）+ 类注释说明 SDK session 局限。

**A5. TUI**
- `worker-list-overlay`：区分 running/idle，idle 灰色 + ⏸，计时切 idle 时长。
- `worker-detail-page`：`⏸ idle` 徽章 + 上一阶段摘要 + "等待后续任务/超时回收"提示。

**A6. Prompt + 回归**
- controller-prompt 加 "Multi-stage work" 段落（何时用 / 如何 assign / dispose 清理）。
- 全量回归：tsc 零错误，293 测试通过。

### Phase B：Per-workspace Sessionless

**B1. 启动流程反转**
- `cli.ts`：`--fresh`（别名 `-n`）；无 flag 时默认继承。
- `bootstrap.ts`：无 `--fresh` 且无 `--resume` → `getLatestSessionForWorkspace`，找到则 resume，找不到则新建。
- `session-helpers.ts`：`getLatestSessionForWorkspace`（复用现有 `listSessions` 排序 + workspace 过滤取首条）。

**B2. 冷启动压缩**
- `supervisor.start()`：loop 启动前若 `needsCompaction()` 则 `performCompaction()`（复用现有压缩 + fallback 链，不新增设施）。

**B3. 未完成任务注入**
- `types/signal.ts`：`previous_session_tasks` SignalType + `PreviousSessionTasksSignalPayload` + `PreviousSessionTask`。
- `types/conversation.ts`：`ESignalSubtype.PreviousSessionTasks`。
- `controller-agent.ts`：`signalConverters` 加对应 converter。
- `session-helpers.ts`：`readSessionUnfinishedTasks`（读 session 的 `tasks.json` 的 pending + running）。
- `supervisor.ts`：restore 时快照（在 recoverCrashedTasks 之前）+ 注入 signal；`injectPreviousTasks` 选项可关。
- controller-prompt 加 "[PREVIOUS SESSION]" 处理引导。
- 边界：不自动恢复 Worker。

**B4. 回归**
- tsc 零错误，293 测试通过（含 5 个新 session-helpers 解析测试）。

## 6. 不在本轮范围内

- 长期记忆 / 向量检索 / 跨运行摘要归档。
- Worker 池化 / 全局常驻 Worker。
- 全局流 sessionless / 机器级 AI 管家（daemon + 持久记忆 + 新安全模型）。
- 跨 Controller 运行的 Worker 驻留。

## 7. 已确认的决策点

| 决策点 | 结论 |
|---|---|
| `assignToWorker` 放进 `add_task` vs 独立 `continue_worker` | 采用 `add_task` 内字段（方案 A，减少工具数量） |
| idle worker 默认超时阈值 | 30 分钟，config `idleTimeoutMs` 可覆盖 |
| Sessionless 继承范围 | **per-workspace**（不做全局流） |
| `--resume` 的命运 | 保留为"显式选择历史 session"（交互列表 / 指定 ID / 跨 workspace 列表），不废弃 |
| claude-code 的 multiStage | 落地但收益有限（SDK 每次新 session），已文档化；puppet 为主要受益者 |
