# 长时运行：Worker 按需驻留 与 Sessionless Controller

> 状态：设计草案
> 关联 Roadmap：
> - Persistent Workers Across Tasks
> - Sessionless Long-Running Agent

本文档记录"让 Controller 和 Worker 活得更久"这一方向的讨论结论、整体设计与分阶段实施计划。

---

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
- 从 `idle` 回到 `running`：通过 `TaskExecuteEngine` 新增的 "assign-to-existing-worker" 路径，而不是 `createWorker`。
- 回收兜底：
  - 超时未被复用 → 自动销毁（可配置，默认例如 30 分钟）。
  - 计入 `maxConcurrency`：idle worker 也占坑，防止用户不知情攒一堆。
  - 显式 `cancel_task` / 用户从 TUI 手动销毁。

**Controller ↔ Worker 工具改动**：

- Controller 工具 `add_task` 新增字段：`multiStage: boolean`（默认 false）。
- Controller 新增或复用工具用于"把下一阶段任务派发给某个 idle worker"：
  - 方案 A：`add_task` 增加 `assignToWorker?: string` 字段。
  - 方案 B：新增独立工具 `continue_worker(workerId, task)`。
  - 倾向方案 A：减少工具数量，语义"创建任务 + 可选指定 worker"足够清晰。
- Worker 的 `done` 语义分化：
  - `multiStage=false`：同现状，任务完成 → Worker 销毁。
  - `multiStage=true`：任务完成 → Worker 进入 `idle`，不销毁。
  - 不新增 `pause` 工具，Worker 自己不主动决定驻留。

**Worker 实现改动**：

- `WorkerAgent`（puppet）：`collectLoop` 目前是"跑完就返回"。需要支持"返回时保留 state"，下次接任务时从保留的 conversation 恢复继续。`WorkerState` 三段式结构已具备，无需新增持久化设施。
- `ClaudeCodeWorker`：Claude Agent SDK 本身支持多轮 session，复用相对容易；需要确认 SDK 侧的 session 句柄也能跨任务保留。

**TUI 改动**：

- active worker 列表区分 `running` / `idle`。
- worker-detail-page 显示 idle 状态与上一阶段任务摘要，方便用户判断要不要手动销毁。

### 3.2 Sessionless Controller

**语义**：Controller 默认就继承上一次运行的上下文，Wayang 从"一次会话一用"变成"一直都在"。真正的"全新开始"需要显式 flag。

**关键决策（已与用户确认）**：

| 决策点 | 选择 | 说明 |
|---|---|---|
| 跨 workspace 继承 | **全局一条连续流**，忽略 workspace 切换 | 简单直接；Controller 自己判断相关性。若后续发现污染严重再退化为"按 workspace 索引" |
| 上一次未完成任务 | **由 Controller LLM 启动时判断** | 不自动恢复 Worker；把上次 task snapshot 作为一条系统 signal 注入，LLM 自行决定重新 dispatch 还是视作历史 |
| 长期记忆 | **不做** | notebook 工具承担"主动记忆"职责 |

**启动流程反转**：

- `wayang`（默认）：继承上一次 session 上下文。
- `wayang --fresh`（或 `--new-session`）：显式全新会话。
- `--resume` 退化为默认行为（或保留为别名）。

**冷启动压缩**：

长时运行必然面临 token 爆炸。启动时不能原样 append 全量历史，需要做一次**启动压缩**：

- 复用 `ControllerAgent` 已有的 LLM-based context compaction。
- 启动时对"上一次 conversation 尾部"做一次压缩，摘要化注入 system / 初始消息。
- 压缩策略的 fallback 链：LLM 摘要失败 → half-truncation（现有）→ 空上下文。

**未完成任务的处理**：

启动时：

1. 读取上一次 session 的 task snapshot（pending / running 状态的任务）。
2. 做成一条结构化 system signal 注入 `SignalQueue`（例如 `previous_session_tasks`）。
3. Controller LLM 在第一次循环中看到这条 signal，自行决定：
   - 视作历史，直接忽略；
   - 重新 `add_task` 某几条；
   - 询问用户。

**不做**：

- 不做自动恢复 running worker。启动时任何 idle worker / running worker 都不复活，避免意外副作用。
- 不做跨 session 的 worker 驻留（驻留只在单次 Controller 运行内有效）。

### 3.3 两个特性的边界

- **Worker 驻留** 活在单次 Controller 运行内：Controller 退出时所有 idle worker 一并销毁。
- **Sessionless Controller** 管的是 Controller 自身的跨启动上下文。
- 二者独立可落地，互不阻塞。

## 4. 架构映射

| 改动点 | 主要涉及模块 |
|---|---|
| `add_task` 增加 `multiStage` / `assignToWorker` | `src/services/tools/`（controller tools） |
| Worker 状态机增加 `idle` | `src/services/TaskExecuteEngine` |
| `assignToExistingWorker` 派发路径 | `src/services/TaskExecuteEngine` |
| Worker 完成后进入 idle 的语义 | `WorkerAgent` / `ClaudeCodeWorker` |
| idle worker 超时回收 | `TaskExecuteEngine`（配合 config） |
| TUI 区分 running / idle | `src/tui/`（worker 列表 + detail page） |
| 启动默认继承上次 | `src/bootstrap.ts` + `src/services/session/` |
| `--fresh` flag | `src/cli.ts`（meow 定义） |
| 冷启动压缩 | `ControllerAgent` 启动路径 + 现有 compaction 复用 |
| 未完成任务注入为 signal | `src/services/session/` + `SignalQueue` |

## 5. 分阶段实施计划

两个特性独立推进，各自内部再拆阶段。建议先做 **Worker 驻留**（范围更收敛，风险更低），再做 **Sessionless**。

### Phase A：Worker 按需驻留

**A1. 机制骨架（不接 LLM）**
- `TaskExecuteEngine` 增加 `idle` 态与状态迁移。
- 新增 `assignToExistingWorker(workerId, task)` 路径。
- `add_task` 工具增加 `multiStage` / `assignToWorker` 字段（先不写 prompt 引导）。
- 单测覆盖状态机与派发路径。

**A2. Worker 侧适配**
- `WorkerAgent` 的 `collectLoop` 改造为"支持返回后保留 state，再次唤醒继续"。
- `ClaudeCodeWorker` 验证 SDK session 句柄复用。
- 集成测试：连续两次派发同一个 worker，验证上下文确实延续。

**A3. Prompt & TUI**
- Controller system prompt 增加"何时用 multiStage"的引导。
- TUI active worker 区分 running/idle，worker-detail 显示 idle 状态 + 上一阶段摘要。
- idle worker 超时回收 + 计入 `maxConcurrency`。

**A4. 回归与打磨**
- 全量 `npm test` 回归。
- 手动跑一轮典型多阶段场景（方案 → review → 实现）。

### Phase B：Sessionless Controller

**B1. 启动流程反转**
- `cli.ts` 增加 `--fresh` flag；无 flag 时默认继承上一次。
- `--resume` 保留为别名或显式版本（按向后兼容考虑）。
- Session 存储结构：保持现有 `~/.wayang/`，但查询策略变成"全局最新"。

**B2. 冷启动压缩**
- `ControllerAgent` 启动时若存在上次 conversation：调用现有 compaction 做一次摘要注入。
- fallback 链：LLM 失败 → half-truncation → 空上下文。
- 单测：mock 超长历史，验证启动后 token 在合理范围。

**B3. 未完成任务注入**
- 定义 `previous_session_tasks` signal schema。
- 启动时读取上次 task snapshot 并注入 `SignalQueue`。
- Controller prompt 增加"如何处理这条 signal"的引导。
- 明确约束：不自动恢复 Worker。

**B4. 回归与打磨**
- 全量测试。
- 手动验证：连续三次启动，上下文是否合理延续、是否污染、是否可用 `--fresh` 断开。

## 6. 不在本轮范围内

- 长期记忆 / 向量检索 / 跨运行摘要归档。
- Worker 池化 / 全局常驻 Worker。
- 按 workspace 索引的历史（保留为未来若出现污染问题时的退化方案）。
- 跨 Controller 运行的 Worker 驻留。

## 7. 待进一步确认的小点

- `assignToWorker` 放进 `add_task` vs 独立工具 `continue_worker`：倾向前者，正式实现前再确认一次。
- idle worker 默认超时阈值（建议 30 分钟，可在 config 中覆盖）。
- `--resume` 这个 flag 在 sessionless 之后的命运：保留为别名 / 废弃 / 改语义为"列出并选择历史 session"。
