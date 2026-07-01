# 调研参考：Multica 的 Workspace-Project-Issue 模型

> 状态：**调研参考文档（非计划）**
> 用途：记录 Multica 产品模型对 Wayang 的启示，供未来大迭代时参考。
> 关系：与 `long-running-design.md`（设计草案）独立。本文不改变现有架构，
> 仅作为"如果将来要做大改"时的输入材料。当前迭代**不执行**本文任何建议。
> 调研时间：2026-06

---

## 0. 这是什么、不是什么

- **是**：一份把 Multica 的产品模型拆解后，对照 Wayang 现状得到的启示清单。
- **不是**：要立即执行的设计方案。所有启示都标注了"对现有架构的改动量"，
  绝大多数属于**大迭代级别**才值得动的东西。

阅读建议：把它当作"当我们某天决定重构数据归属 / 引入长周期工作管理时，
可以先回来翻一遍"的备忘。

---

## 1. Multica 模型速览

Multica 的数据层级是清晰的三级：

```
Workspace（顶层实体，隔离边界）
  └── Project（相关 Issue 的容器）
       └── Issue（最小工作单元）
```

几个关键设计点（详见 Multica 官方文档）：

- **Workspace 是第一公民**：每个 workspace 自包含——独立的成员、Agent 配置、
  Issue 列表、技能库（Skills）、设置。切换 workspace 替换整个视图。
- **Workspace 有不可变标识**：创建时定 `slug`（URL 标识，不可改）和
  `issue prefix`（如 `MUL-`，强烈不建议改，改了历史引用全断）。
- **Project 有状态、有 lead**：project 有 status / priority / progress
  （progress 从关联 issue 自动算出）。**lead 字段可以填一个 Agent**。
- **Issue 有 workspace 内编号**：`MUL-123` 形式，递增、不可手填、删除不复用。

一句话：Multica 把"AI Agent 当队友"这个叙事**下沉到了数据模型**，而不是停留在 UI。

---

## 2. 五条启示（按改动量从小到大）

### 启示一 · Workspace 升为第一实体（改动：大，大迭代级）

**现状**：Wayang 的数据根是 `session`，`workspace` 只是 session meta 里的一个字符串属性。

```
~/.wayang/sessions/<sessionId>/        ← 数据根
  meta.json { workspace: "/abs/path" } ← workspace 是 session 的属性
```

**Multica 的做法**：workspace 是顶层实体，session/conversation/task 都挂在它下面。

```
workspaces/<slug>/
  meta.json { slug, name, counter, ... }
  sessions/<sessionId>/   ← session 降级为 workspace 下的一条切片
```

**对 Wayang 的价值**：
- 机制层面其实已就绪（`--all`、`getLatestSessionForWorkspace` 都已是按 workspace 查），
  缺的只是把数据归属从 `sessions/` 翻转为 `workspaces/<slug>/sessions/`。
- 翻转后，`long-running-design.md` 里纠结的"跨 workspace 继承 / 全局一条流"
  这个决策点**直接消失**——数据天然按 workspace 隔离，污染问题从根上不存在。
- 为 workspace 级状态（编号 counter、未来的 settings/skills）开了头。

**为什么是大迭代**：动的是整个持久化层的目录结构，涉及所有 state 模块的路径计算、
迁移旧数据、向后兼容。不是顺手能做的事，必须单独立项。

**保留点（重要）**：实体化 workspace **不等于消除 session**。session 作为
"用户可主动分割的单元"这个能力要保留（对应 `--fresh` 逃生舱）。只是它从
"数据根"降级为"workspace 下的切片"。Multica 的"全局一条流"形态不适合 Wayang
（单用户 CLI 需要能开新会话）。

---

### 启示二 · 引入 Project / taskGroup 中间层（改动：中）

**现状**：Wayang 的任务模型是扁平两级——Controller 直接拆出一批 Task 并行执行，
`TaskDetail` 没有归属分组，没有跨任务的进度聚合。

**Multica 的启示**：中间的 Project 层对应"比单个任务大、比整个 workspace 小"
的工作单元（一次重构、一个功能上线），提供四样 Wayang 现在没有的东西：

| 能力 | 价值 |
|---|---|
| 状态机（进行中/暂停/完成） | 长周期工作的整体状态 |
| 进度（从关联 task 自动算） | 不用人工统计 |
| 多 task 归属到一个 project | 跨任务的关联与回溯 |
| owner | 显式化"谁负责推进" |

**与现有设计的关系**：`long-running-design.md` 的 multiStage 任务
（"方案→review→实现"）本质是 Project 的雏形，只是被实现成了
"一个 Worker 跨任务保留上下文"。引入 Project 不冲突，反而是给 multiStage
提供"上层容器"——一个 Project 容纳多个 Task，Task 可以各自 multiStage。

**落地形态（远期）**：第一版可以只是 `taskGroupId / projectName` 轻量标签，
不必上来就做完整状态机。但要在数据模型里留位置。

---

### 启示三 · Task 加人类可读编号（改动：小，可单独先行）

**现状**：`TaskDetail.id` 是 `agent-<timestamp>-<rand>` 形式的机器串。
机器友好，人完全不友好——Controller 跟用户对话、Worker 回报进度时，
只能用 title 或那串机器 id 指代任务。

**Multica 的启示**：`WAY-123` 这种 workspace 内递增编号，解决三个真实问题：

1. 人和 Agent 沟通有稳定指代（"WAY-42 那个任务"）。
2. 编号本身编码了归属（前缀 `WAY-` 即 workspace）。
3. 删除不复用 = 历史引用不会指向错误对象。

**为什么小改动却值得**：成本极低（workspace 内一个 counter），但对多任务
并行的 TUI 和对话清晰度是实打实的提升。

**依赖**：counter 放哪？如果启示一先做了，自然放在 `workspaces/<slug>/meta.json`。
如果启示一没做，可以先用 session 级 counter 顶上，未来再上移。

**可单独先行**：这条与启示一不强耦合，可以在任意迭代单独落地。

---

### 启示四 · Controller 是所有 Project 的唯一 Leader（改动：无，仅显式化）

**澄清一个 Multica 概念的误用风险**：Multica 的 Project 有个 `lead` 字段，
**可以填一个 Agent**（让某个 Agent 当某项目的负责人，自主认领任务）。
这套设计是为 SaaS 的"无中心编排"准备的——Multica 没有一个全局 Controller。

**Wayang 不需要、也不应该抄这个**：

- Wayang 已经有一个**全局唯一、常驻**的 Controller，它天然就是所有
  project/task 的编排者（leader）。这是既成事实，不是要新增的能力。
- 把"可指派的 project lead"引入 Wayang，等于制造**第二编排源**，
  与现有架构原则冲突（`long-running-design.md` §2：决策权归属 LLM、
  Controller 是那个唯一 LLM；Worker 是无状态执行单元）。
- Multica 的 lead 隐含前提是"Agent 常驻"，而 Wayang 明确排除 Worker 池化。

**唯一可做的动作**：在架构文档里显式写一句契约，防止未来语义漂移：

> Controller 是 Wayang 中唯一的常驻编排者，负责所有 project/task 的
> 理解、拆解、派发与综合。Worker 是无状态执行单元（即使 multiStage 驻留，
> 编排权仍在 Controller）。不引入第二编排源。

**这条没有架构改动**，只是把现状写成显式契约。可与任何迭代顺带完成。

---

### 启示五 · 隔离边界升到 Workspace 级（与启示一同一件事）

**说明**：本条在讨论中已确认与启示一是同一洞察的两面——
"把隔离边界升到 workspace 级"就是"把 workspace 当第一实体"的必然结果。
不单独成项，参见启示一。保留此条仅为记录讨论结论，避免日后重复提出。

---

## 3. 与现有架构的冲突清单（决策时必看）

如果未来真要做大改，以下是必须先解决的问题：

| 冲突点 | 说明 |
|---|---|
| 持久化目录结构翻转 | 所有 state 模块（`SessionState`/`TaskPoolState`/`ControllerAgentState`）的路径计算都要改 |
| 旧数据迁移 | 现有 `~/.wayang/sessions/` 下的数据需要迁到 `workspaces/<slug>/sessions/`，且要能识别 slug 来源 |
| `getLatestSessionForWorkspace` 语义 | 查找根变化，逻辑需重写（但语义不变） |
| session 与 workspace 的关系 | 必须明确"session 保留为切片"而非"消除 session"，否则丢失 `--fresh` 能力 |
| 向后兼容期 | 翻转期间可能需要同时支持新旧两种路径，增加复杂度 |

正因为有这些成本，本文档**不建议当前迭代执行**，仅留作大迭代参考。

---

## 4. 优先级与依赖关系（仅作未来规划参考）

```
启示三（编号）────────────────────────► 可独立先行
                                          │
启示一（workspace 实体化）◄──────────────┘ counter 上移到此
      │
      ├──► 启示五（隔离边界）── 同一事物，不单列
      │
      └──► 启示二（Project 层）── 建议在 workspace 实体化之后引入

启示四（Controller 契约）──────────────► 零依赖，任意迭代顺带
```

---

## 5. 参考资料

- Multica 官方文档 — Workspaces: https://www.multica.ai/docs/workspaces
- Multica 官方文档 — Projects: https://www.multica.ai/docs/projects
- Multica 官方文档 — Skills: https://www.multica.ai/docs/skills
- Multica 官方文档 — Project Resources: https://www.multica.ai/docs/project-resources
- Multica GitHub: https://github.com/multica-ai/multica
- 本仓库相关文档：`docs/long-running-design.md`
