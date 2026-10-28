# Wayang 0.5 → 1.0 路线图

> 状态:已定稿(2026-10)
> 定位:从"多智能体 CLI"进化为**多 agent 协作 + 工作台**,不再是玩具。
> 本文档是版本级规划;每个版本开工前另落具体设计文档(沿用 `long-running-design.md` 的惯例)。

---

## 一、愿景与缺口拆解

"多 agent 协作 + 工作台"的完整形态,拆成七个缺口,全部排入版本:

| # | 缺口 | 承载版本 |
|---|---|---|
| 1 | 架构解耦:逻辑层独立进程 + RPC(一切 UI 与 e2e 测试的前提) | 0.5 |
| 2 | 工作台 UI(Web,学 Codex app + Multica) | 0.6 |
| 3 | 任务规划架构:拆分 / 追踪 / 依赖 / 任务组 | 0.6(编号)+ 0.7 |
| 4 | 并行安全:同仓多 agent 改代码(worktree 隔离 / 协作通道) | 0.7 |
| 5 | agent 接入广度:ACP 客户端,接入更多第三方 agent | 0.8 |
| 6 | worker 执行能力:MCP 挂载 / 工具拓展 / 技能 | 0.9 |
| 7 | 愿景收尾:常驻与远程、长期记忆、质量闭环、生态分发 | 0.10 / 0.11 / 1.0 |

**排序依据:**
- 逻辑进程拆分放 0.5:无头逻辑进程是 e2e 自测(自研自测的前提)与 WebUI 的共同依赖,先拆分让后续所有功能建在最终架构上,避免二次重构。
- WebUI 放 0.6(提前):早一步拿到工作台的真实反馈;代价是看板初期数据模型还薄,0.7 落地任务组/依赖后看板升级一次。
- ACP 定为**仅客户端**(Wayang 驱动别人,不对外提供 ACP 服务端)。
- TUI 只维持"主 agent 基础对话 + 摘要",不再往页面交互发力——多 agent 视图交给 Web。

---

## 二、版本总览

| 版本 | 主题 | 一句话 |
|---|---|---|
| 0.5 | 架构地基 | 逻辑进程化 + RPC + 测试体系 |
| 0.6 | 工作台 MVP | WebUI 上线 + WAY-N 任务编号 |
| 0.7 | 协作核心 | 规划架构 + 并行安全 |
| 0.8 | 开放接入 | ACP 客户端 + agent 生态 |
| 0.9 | 执行增强 | Worker 能力 + MCP + 硬化 |
| 0.10 | 常驻与远程 | "永动机"形态:daemon + 通知 + 远程 |
| 0.11 | 记忆与质量闭环 | 知识沉淀 + 自动审查验证 |
| 1.0 | 生态与稳定 | 插件协议 + 分发 + 审计 |

---

## 三、版本详述

### 0.5 — 架构地基:逻辑进程化 + RPC + 测试体系

**背景:** 当前逻辑与 ink TUI 同进程,零 RPC 痕迹;测试只有单测(手写 vi.mock),无 e2e。逻辑层抽成无头进程后,e2e 才有稳定的驱动目标,WebUI 与 TUI 瘦身才有共同的挂载点。

**功能点:**
1. `wayang server` 无头逻辑进程:Supervisor / ControllerAgent / TaskExecuteEngine / SignalQueue / SkillRegistry 全部移入,进程内零 ink / react 依赖。
2. RPC v1(先出协议设计文档):
   - 传输:stdio(TUI ↔ server)+ WebSocket(为 Web 预留)。
   - 命令面:`submit_input` / `cancel_task` / `update_task` / `respond_permission` / `chat_worker` / `dispose_worker` / inquiry 应答 / `compact` / `get_snapshot`(任意 Subscribable path)/ `shutdown`。
   - 事件面:订阅/退订;信号流、任务与 worker 状态增量推送。
3. TUI 瘦身:基础对话 + `/tasks` 摘要 + 权限 / inquiry 应答;删除 worker-list-overlay、worker-detail-page。
4. fake OpenAI 兼容 provider:本地 HTTP 服务,按脚本回放 SSE + tool-call 序列。
5. e2e harness:spawn server → RPC 驱动 → 断言任务/信号生命周期。首批 3 场景:单任务全链路 / 权限审批 / multiStage 复用。
6. GitHub Actions CI:lint + 单测 + e2e,PR 必绿。
7. 单测补齐:engine 状态机全覆盖(含 idle / TTL / recover)、signal-queue、permission-middleware、base-agent。

**验收:** 行为不变的纯重构;e2e 3 场景在 CI 稳定绿;TUI 与 server 经 stdio RPC 正常交互。

**风险:** 拆分过程中的行为回归 → 以"e2e 先行"兜底(先给现状写 e2e 再动刀)。

---

### 0.6 — WebUI 工作台 MVP + 任务编号

**背景:** 多 agent 视图(并行任务、worker 会话、审批流)终端装不下。Codex app 的范式是"任务为中心 + 并行 agent + diff 入口";Multica 提供了 Workspace → Project → Issue 的层级参照。WAY-N 编号(`research-multica.md` 启示三,成本最小的独立项)提前到本版:看板需要稳定的行标识,对话需要稳定指代。

**功能点:**
1. WAY-N 任务编号:workspace 级 counter(`~/.wayang/workspaces/<slug>/meta.json`),工具返回 / 信号 / TUI / Web 全链路统一指代。
2. server 内嵌 HTTP + WS:静态托管前端构建产物,token 鉴权。
3. Web 前端(Vite + React,初定,0.5 末再定稿):
   - 会话页:与 Controller 流式对话,tool call / 结果折叠内联;
   - 任务看板:pending / running / history + worker 状态卡,WAY-N / 优先级 / multiStage 标识;
   - 审批中心:permission 队列一键批/拒 + inquiry 结构化问答;
   - worker 会话回放:基于既有 conversation 持久化。
4. 多客户端同连:终端 + 浏览器同时在线,状态一致。
5. UI 走查基准:对照 Codex app 与 Multica 列检查单,逐项过。
6. e2e:Playwright 驱动 Web 关键路径(下指令 → 看板更新 → 审批 → 收结果)。

**验收:** 浏览器完成完整任务闭环;对话中 WAY-N 指代可用;双端同连无状态漂移。

**风险:** 前端工程量被低估 → 看板/审批优先,worker 回放可降级为只读列表。

---

### 0.7 — 协作核心:规划架构 + 并行安全

**背景:** "真正做到任务拆分、进度跟踪"是用户对主 agent 的核心诉求。`research-multica.md` 启示二(Project/taskGroup 中间层)在本版落地;同时,"多个 agent 并行改同一个仓库"是业界公认未解难题(Codex app 用隔离 worktree 缓解),Wayang 以 Controller 统一编排 + worktree 隔离给出自己的答案。

**功能点:**
1. Task Group(项目)容器:创建 / 归属、组状态聚合(x/y 完成、失败升级)、看板组视图。
2. `blockedBy` 任务依赖:调度器拓扑派发 + 环检测。
3. 结构化规划:`plan` 工具(里程碑 / 子任务草稿)→ 用户确认或直接派发;`replan` 修订。
4. 失败处理:失败复盘信号 → Controller 重组再派;组级失败升级通知。
5. Git worktree 隔离:并行任务可选独立 worktree 执行;完成合并 / 冲突呈报 / 丢弃;worktree 生命周期管理。
6. Worker ↔ Worker 协作:工作台共享 scratch 区 + 经 Controller 中转的 worker 间消息(chat_worker 扩展)。
7. 跨会话 backlog:`previous_session_tasks` 升级为 workspace 级待办池(带 WAY-N),冷启动可一键重派。
8. e2e:多任务 + 依赖 + 并行 + 失败重试 + worktree 合并。

**验收:** 一句话目标 → 带依赖的组任务 → 并行执行(含 worktree 隔离)→ 看板全链路追踪。

**风险:** worktree 合并冲突的产品化复杂 → 首版只做"冲突呈报 + 人工选择",不做自动合并。

---

### 0.8 — 开放接入:ACP 客户端 + agent 生态

**背景:** ACP(Agent Client Protocol,Zed 主导)2026 年已稳定:JSON-RPC over stdio,"AI agent 界的 LSP"。Gemini CLI 原生支持(`--acp`),claude-agent-acp / codex-acp / OpenCode 等适配器齐备,JetBrains 已跟进。ACP 是"接入更多 agent"的标准路径,取代逐个写 SDK 适配。

**功能点:**
1. ACP 客户端核心:`initialize` 协商 / `session/new` / `session/prompt` / `stop` + `session/update` 流(content / tool_call / plan / usage)映射到 WorkerResult、进度、会话流。
2. `acp` worker 类型:`config.workers` 声明命令行;首批 Gemini CLI(--acp 原生)、claude-agent-acp、codex-acp、OpenCode。
3. permission 桥接:ACP `session/request_permission` → 现有审批中心(Web + TUI 双端)。
4. capabilities 能力矩阵注入 Controller prompt,参与派发决策。
5. Worker 混排:puppet / claude-code(SDK)/ acp 同组并行;WebUI 统一展示三方会话流。
6. fake ACP agent(e2e 用,覆盖握手 / 工具展示 / 权限 / 中断)+ 真实 Gemini CLI 冒烟(CI 可选,本地必跑)。
7. 接入文档:《配置一个 ACP worker》。

**验收:** 混排任务组 e2e 绿;真实 Gemini CLI 完成一个代码任务。

**风险:** 各适配器成熟度参差 → 首批逐个冒烟验收,不达标的不进默认文档。

---

### 0.9 — 执行增强:Worker 能力 + MCP + 硬化

**背景:** 内置 worker 的工具面(bash / 读写编辑 / 搜索 / web_search)不足以完成真实工程任务;MCP 生态是工具能力的放大器。同时长时真实使用暴露的性能 / 稳定性问题在本版收口。

**功能点:**
1. MCP 客户端:config 声明 stdio / HTTP servers、工具发现、注入 worker(+ 可选 controller);权限门控覆盖 MCP 工具。
2. 内置工具拓展:git(status / diff / commit)、任务内 todo 清单、代码导航、web_fetch。
3. per-worker 配置:工具 allowlist、技能包挂载、独立 provider / 模型。
4. 技能 v2:按任务自动推荐、使用统计。
5. 安全硬化:危险命令规则库扩充、secrets 脱敏(日志 + 会话)。
6. 稳定性:长会话性能(100+ 轮压测)、压缩优化、崩溃恢复演练、日志轮转。
7. 文档站(vitepress)+ 架构指南。

**验收:** e2e"worker 经 MCP 操作外部系统"且权限链路生效;长会话压测达标。

**风险:** MCP server 质量不可控 → 默认不捆绑任何 MCP server,只提供挂载机制与配置样例。

---

### 0.10 — 常驻与远程("永动机"形态)

**背景:** `long-running-design.md` 曾把"机器级 AI 管家(daemon)"划为"另一个项目";本版是有边界的重启——**默认人在环**,持续自主推进的是 backlog,不是无人值守乱跑。这是"永动机"愿景的真正形态:目标驱动持续推进 + 人审节点。

**功能点:**
1. daemon 守护:开机常驻 server、多 workspace 管理、健康检查与自动重启。
2. 远程安全接入:token / TLS,从任意设备连回自己的 Wayang。
3. 任务完成通知:系统通知 + webhook。
4. 定时触发:cron 跑 backlog(定时扫描待办池,生成派发建议)。
5. 目标驱动推进:长期目标 → 持续生成 backlog → 人审后派发。

**验收:** 合盖一天后打开浏览器,看到 backlog 的推进记录与待审事项;远程接入安全可控。

---

### 0.11 — 记忆与质量闭环

**背景:** `long-running-design.md` 明确排除的长期记忆,在常驻形态成立后有了落点——记忆服务于 workspace 内的任务质量,不是通用向量库。质量闭环让"做完"升级为"做对"。

**功能点:**
1. workspace 知识库:AGENTS.md 演进(项目约定自动沉淀)+ 任务结论归档。
2. 可检索任务归档:历史任务结果全文检索,WAY-N 直达。
3. review worker:代码审查 + 测试验证作为任务的 Definition of Done。
4. 自动"改完自测"循环:任务完成 → 跑测试 → 失败自动修复重试(有次数上限)。

**验收:** 开启 DoD 的任务组,完成即代表测试通过;知识库能在新会话冷启动时注入项目约定。

---

### 1.0 — 生态与稳定

**功能点:**
1. worker 插件协议 + 脚手架(`wayang worker new`):capabilities / 工具声明 / 生命周期钩子标准化。
2. 技能目录:社区技能收录与一键安装。
3. 可选 docker 沙箱:高危任务容器内执行。
4. 安装分发:npm / homebrew / 一键脚本。
5. 性能与安全审计;正式文档站收口。

**验收:** 第三方开发者按文档能独立写出一个可分发 worker;全新机器 5 分钟内完成安装并跑通首个任务。

---

## 四、贯穿工程原则

- 每版交付物 = 代码 + 单测 + fake-provider e2e + CHANGELOG / README 同步。
- 每版开工前在 `docs/` 落一份设计文档,定稿后再动代码。
- 分支惯例:`release/x.y` → PR → `main`。
- TUI 冻结在"基础对话",新交互能力一律加在 WebUI。
- 决策权归 LLM、机制归代码的既有原则不变;Controller 仍是唯一编排源。

## 五、外部调研引用

- ACP 官方(spec + agent registry):https://agentclientprotocol.com — 协议 2026 年稳定,JetBrains 已跟进;Gemini CLI 原生 `--acp`,Claude Code 经 claude-agent-acp 适配,Codex CLI / OpenCode 在列。
- Codex Mac app(并行 agent 任务界面参照):https://winbuzzer.com/2026/02/03/openai-launches-codex-for-mac-with-parallel-ai-coding-agents-xcxwbn — 任务为中心、每任务独立 agent 与 git worktree、单一 UI 管理并行与 diff 审查。
- 内部调研:`research-multica.md`(Workspace-Project-Issue 模型,启示二/三分别在 0.7 / 0.6 落地)。
