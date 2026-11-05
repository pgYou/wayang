# ACP worker adapter 设计（0.9.0）· v3 索引

- 关联 issue：#25（Worker 接入扩展：以 ACP 为通用适配层接入第三方 CLI agent）。
- 基线：release/0.9.0 @ `7bfd1e2`（**0.8.4 权限层已合入**；代码事实按 0.8.4 实际代码取证，行号见各分册）。
- **契约**：`acp/00-interface-freeze.md`（接口冻结页，2026-11-05）是协议层与权限桥的唯一契约。本文与分册写目标、架构、依据与实施计划；**与冻结页冲突时以冻结页为准**。
- **v3 修订（2026-11-05）**：v2 的 856 行单文档重写为「索引 + 分册」。三处实质变更：① provider 收敛为两家（范围决策见「不做」末行）；② 权限语义按 **0.8.4** 修正（v2 里 0.8.3 的描述——如「敏感写=硬拒」——作废，见 04 分册修正清单）；③ 新增**环境就绪**分册（07）：fail-fast，不以静默降级代替报错。
- 本文只做设计，不含实现代码；分册均为 md，与冻结页平级放在 `docs/design/acp/`。

## 1. 目标与范围

以 ACP（Agent Client Protocol，稳定版本 1）为通用适配层，把第三方 CLI coding agent 接入 wayang 的 worker 体系：

- **接入两个 provider**：codebuddy code（主路径，真机已实测）与 opencode（experimental，本机未安装，仅有官方文档依据）。范围决策见「不做」。
- 传输只做 stdio（ndjson 上的 JSON-RPC）；不引入新 npm 依赖（自研约 300 行，见 01 分册 §5）。
- claude-code 通道（`ClaudeCodeWorker`）**不迁移、不重写**：SDK 通道具备 ACP v1 表达不了的能力，改写等于净损失（02 分册 §1）。
- 范围内：协议层 `src/services/acp/`、worker 骨架与两个 provider 薄类、权限桥接入 0.8.4 审批与审计、配置 schema 与加载期校验、TUI/审计/controller 的影响面、测试矩阵、环境就绪 fail-fast。
- 范围外：见「不做」。

## 2. 结论（先行）

1. **做 ACP，但 ACP 只是共享协议层；每个 provider 仍然有自己的 worker 类。** `src/services/acp/`（ndjson、JSON-RPC、session 生命周期、取消、超时）是纯库，不含任何 wayang 业务策略。上层是 `BaseAcpWorker`（实现 `IWorkerInstance` 的通用骨架，暴露「启动 / 权限 / 错误归一化 / 就绪判定 / 停止策略」五个钩子）+ `CodebuddyAcpWorker` / `OpenCodeAcpWorker` 两个薄类。理由：两家的差异不是配置差异而是**控制流**差异——codebuddy「握手成功 ≠ 可用」（未登录时 `session/new` 无响应，实测）、opencode 的取消语义取保守丢弃。压进一个通用实现，等于把某家的已知 bug 变成共享代码里的条件分支（03 分册）。
2. **不重写 `ClaudeCodeWorker`，它也不继承 `BaseAcpWorker`。** 它继续作为 `switch` 的一个 case 存在（02 分册 §1）。
3. **分发保持 `switch`，按配置里必填的 `type` 落到具体类**（`claude-code` / `codebuddy-acp` / `opencode-acp`），不做注册表。`createWorker`（task-execute-engine.ts:1035）只加 case；两处 `instanceof ClaudeCodeWorker`（:1283 / :1344）改为可选成员探测，之后加 provider 不再动引擎（02 分册 §1、05 分册 §1）。
4. **中途消息在 ACP v1 下必然退化为「回合边界交付」**，与 claude-code 现有实测语义一致，不是能力倒退；回合内注入只在 ACP v2 draft / 厂商 steering 扩展里，0.9.0 不做（01 分册 §2.4）。
5. **权限是本次最大的语义缺口**：ACP 的 `session/request_permission` 是「选一个选项」，不是「返回带理由的裁决」。0.8.4 下敏感命中（含写方向）**默认走审批**（`sensitiveMode:'ask'`），硬拒仅出现在 `sensitiveMode:'deny'`；拒绝理由只进审计与信号，agent 看不到。选项缺失时 fail-closed（04 分册）。
6. **环境就绪 fail-fast**：缺 CLI / 握手超时 / 认证失败各自有明确归因、文案与退出行为；**不以静默降级代替报错**（07 分册）。
7. 粗估 **12.5 人日**（§6 第 1-6 步之和）。不含两家 CLI 的账号/网络问题排查。

## 3. 架构总览（三层）

```
TaskExecuteEngine.createWorker           ← switch (config.type)，三个 case，不做注册表
  └── IWorkerInstance（不变，src/types/worker.ts:47-89）
        ├── WorkerAgent                   （puppet，现状）
        ├── ClaudeCodeWorker              （SDK 通道，现状不动；不继承 BaseAcpWorker）
        └── BaseAcpWorker                 （新增：ACP 通用骨架，abstract）
              ├── CodebuddyAcpWorker      （新增，主路径）
              └── OpenCodeAcpWorker       （新增，experimental）
                    └── 组合持有 AcpClient（每次 run() 新建传输与 session）
                          └── src/services/acp/（协议层，纯库）
                                types / transport / client / errors / config
```

| 层 | 位置 | 职责 | 明确禁止 |
| --- | --- | --- | --- |
| 协议层 | `src/services/acp/` | ndjson 分帧与 JSON-RPC、生命周期方法、错误分类 | 不读 `WayangConfig`、不写 transcript、不发 signal、不碰 TUI、不出现 provider 名字 |
| 骨架 | `src/services/agents/acp/base-acp-worker.ts`（+ `event-mapper.ts`） | `run()` 骨架、transcript、回合边界交付、能力视图、审计埋点 | 不出现 `if (provider === …)`；不定义 provider 默认命令 |
| provider 薄类 | `codebuddy-acp-worker.ts` / `opencode-acp-worker.ts` | 只覆写五钩子（`buildLaunch` / `mapPermission` / `normalizeError` / `isReady` / `stopPolicy`） | 不写 JSON-RPC / 起进程 / kill；不复制 `run()` 骨架 |

依赖方向单向：provider 薄类 → 骨架 → 协议层；反向不成立（分层禁令用 grep 断言守住，01 分册 §1）。共享件 `permission-bridge.ts` 由骨架默认调用（04 分册）。

## 4. provider 状态（如实标注，禁止猜测）

| provider | type | 状态 | 依据 |
| --- | --- | --- | --- |
| codebuddy code | `codebuddy-acp` | **主路径，真机已实测（2026-11-05）** | 探针五步全部成功（27.5s：initialize / session-new / prompt / request_permission / cancel，冻结页 §9）；用户确认 cbc 可正常对话 |
| opencode | `opencode-acp` | **experimental，未实测** | 仅官方文档 `https://opencode.ai/docs/acp/`；本机未安装；所有行为标注「未实测」，fail-fast（07 分册） |

实测校正后的协议事实（v3 必读，逐条来自 2026-11-05 codebuddy 探针，01 分册 §4）：`tool_call` 流式累积合并；`request_permission` 的选项**按 kind 选**（`allow_once` > `allow_always`、`reject_once` > `reject_always`）；`optionId` 是任意串，禁止按字面值匹配；`stopReason` 恒五值；codebuddy 厂商扩展字段一律忽略未知字段。

## 5. 分册目录（`docs/design/acp/`，与冻结页平级）

| 编号 | 文件 | 内容 | 读者 |
| --- | --- | --- | --- |
| 00 | [`00-interface-freeze.md`](acp/00-interface-freeze.md) | **接口冻结页**：文件清单、签名、事件映射、错误分类、权限桥契约、取消/超时、验收用例、实测证据 | 实现方（唯一契约） |
| 01 | [`01-protocol.md`](acp/01-protocol.md) | 协议层依据：ACP v1 摘要、与 wayang 语义差异、实测校正五条、实现纪律 | 协议层实现 |
| 02 | [`02-worker-base.md`](acp/02-worker-base.md) | 骨架：五钩子 v3 形状、`run()` 生命周期、stopReason 映射、事件映射动机、transcript 同构 | 骨架实现 |
| 03 | [`03-providers.md`](acp/03-providers.md) | codebuddy 实测事实与兜底；opencode experimental 约束；差异落点汇总 | provider 类实现 |
| 04 | [`04-permissions.md`](acp/04-permissions.md) | 权限桥：0.8.4 语义修正清单、策略栈事实、approval memory、审计扩展、fail-closed 铁律 | 权限桥实现 |
| 05 | [`05-config.md`](acp/05-config.md) | 配置 schema、校验规则、示例、能力声明对 controller/TUI/审计的影响 | 配置与 prompt 改造 |
| 06 | [`06-testing.md`](acp/06-testing.md) | 测试矩阵、fake ACP server 场景、降级场景、真机验收纪律 | 测试与验收 |
| 07 | [`07-readiness.md`](acp/07-readiness.md) | 环境就绪：CLI 探测、握手探测判定、三类失败的文案与退出行为、验收前清单（人类可执行） | 实现方与验收人 |

读法：实现协议层与权限桥只看 00；实现骨架 / provider 类 / 配置先看对应分册、冲突回 00；本索引只保留结论与总表。

## 6. 实施步骤与验收口径

每步独立过四道门槛（`npm run lint`、`npx vitest run`、`npm run build`、本步新增测试），可单独 revert。人日为粗估。

| 步 | 内容 | 主要交付 | 人日 |
| --- | --- | --- | --- |
| 1 | 协议层 `src/services/acp/`（纯库，无引擎改动）+ `e2e/fixtures/fake-acp-agent.cjs` | 五文件（冻结页 §1）+ 协议层单测（真子进程，冻结页 §8 用例 6） | 2.5 |
| 2 | 骨架 + event-mapper + permission-bridge + **codebuddy**；引擎 `switch` 加 case、两处 `instanceof` 改能力探测；审计加 `transport`/`provider` | `BaseAcpWorker` 五钩子（02 分册 §2）+ codebuddy 类（03 分册 §2.3）+ fake 回合全绿（冻结页 §8 用例 1-5）+ **真机 codebuddy 跑通真实任务**（06 分册 §5） | 4 |
| 3 | **opencode**（experimental）：薄类 + fake 断言 + fail-fast 文案 | opencode 类（03 分册 §3）+ `WORKER_TYPES` 三值齐 | 1.5 |
| 4 | 配置 schema、校验、controller prompt `[acp:<provider>]` 标记、onboard 提示、能力矩阵文档 | `validateConfig` workers 七条规则（05 分册 §5）+ 文档（05 分册 §6） | 2 |
| 5 | e2e 场景矩阵（两 provider × 降级） | 06 分册 §3/§4 全场景：含环境就绪三类失败（07 分册 §4）断言 | 1.5 |
| 6 | 收口：能力矩阵实测回填、CHANGELOG 校准、复核 | 无「猜」出来的值；CHANGELOG 与实际交付一致（06 分册 §5） | 1 |

验收口径（总）：fake ACP server 六用例以冻结页 §8 为准；降级场景每条都让任务进 failed 且文案可读（07 分册 §6）；transcript 与 claude-code 场景同构（02 分册 §7）；分层禁令 grep 断言进 CI（06 分册 §6）。环境就绪的实现不单列步骤——错误分类在步骤 1（冻结页 §4）、worker preflight 在步骤 2（02 分册 §3）、就绪清单在步骤 5 验收（07 分册 §5）。

## 7. 风险与未决问题（需要拍板）

| # | 问题 | 决策建议 |
| --- | --- | --- |
| 1 | ACP 无法表达「带理由的拒绝」；agent 未提供 reject 选项时只能回 `cancelled`（终止整轮） | 接受 fail-closed；理由进审计与信号；「协议失配」日志可查（04 分册 §5） |
| 2 | 中途消息只能回合边界交付（ACP v1 无回合内注入） | 接受，与 claude-code 同语义；不实现厂商 steering 扩展（「不做」第 3 条） |
| 3 | `ask_controller` 在 ACP 下怎么给？ | 0.9.0 不提供（`inquiry:false` 恒占位）；0.9.1 候选：stdio MCP server 经 `session/new.mcpServers` 注入（未实测，约 2-3 人日） |
| 4 | codebuddy 未登录时 `session/new` 无响应（实测），要不要做 `authenticate` 引导？ | 不引导，只给 `auth-required` 文案 + 文档说明「先在终端登录一次」（07 分册 §4）；登录方式（iOA/external/internal/selfhosted）是单独的交互设计题 |
| 5 | `type` 改为必填枚举，配置键仍是 `workers.<id>.type`，要不要解耦 `id` + `type`？ | 保持 `workers.<id>.type`；解耦留给 1.0。存量 `type:'acp'` 旧写法在加载期报错并列出允许值（05 分册 §5） |
| 6 | `permissionMode:'agent'`（不接权限）要不要提供？ | 提供但默认 `'client'`；`'agent'` 下收到请求 → `cancelled` + 审计，不静默放行（04 分册 §6） |
| 7 | 孤儿 ACP 进程（wayang 被 SIGKILL）要不要启动期清理？ | 0.9.0 只记录 pid（`runtimeState.acp`）；清理单独 issue（pid 复用误杀风险） |
| 8 | 两份 provider 薄类会不会复制粘贴出多份骨架？ | 只允许覆写五钩子；骨架/共享件里不出现 `if (provider === …)`；code review 以「provider 类 vs 骨架」边界为主要检查点（02 分册 §8） |

监控项（非决策）：

- **协议漂移**：ACP 往 v2 走（回合生命周期与请求响应分离）；v2 稳定后 `sessionPrompt` / `acceptMessage` 语义可能重做。缓解：协议层只暴露语义化方法，provider 类只见语义方法，迁移影响面压在协议层一处（01 分册）。
- **厂商扩展**：codebuddy 打包的 `@agentclientprotocol/sdk` schema 含 v1 之外变体。缓解：只认官方 v1 清单，其余 debug 丢弃，连续 50 条未知变体才判失配（01 分册 §4 第 5 条）。
- **安全边界被误解**：client 声明不支持 `fs/*`/`terminal/*` 后工具由 agent 执行，未经 `request_permission` 的操作 wayang 看不到。必须写进 README / 配置示例（04 分册 §7）。
- **配置复杂度**：每多一个 provider 多一组启动/超时参数。缓解：provider 类自带可用默认 + 加载期校验 + 错误文案列出允许值（05 分册）。
- **抽象过度**：把两个 provider 合并回万能类、或骨架里加 `if (provider)`，本设计收益立刻归零。缓解：写进「不做」第 12 条，code review 直接拦（02 分册 §8）。

## 8. 不做（明确范围）

1. **不重写 `ClaudeCodeWorker`**，不改 `claude-code` 的配置语义（`cliPath` / `maxTurns` 原样，且它不继承 `BaseAcpWorker`）。
2. **不做远程 ACP**：`streamable-http` 传输（codebuddy 的 `--acp-transport`）不接，只做 stdio。
3. **不支持 ACP v2 draft**，也不实现厂商扩展（`session/steering`、`session_message`、`subagent_update`、`plan_update`）。
4. **不实现 client 侧的 `fs/*`、`terminal/*`、`elicitation/*`、MCP-over-ACP**：initialize 里全部声明不支持，工具一律由 agent 自己执行（04 分册 §7 的安全边界）。
5. **不实现 `allow_always` / `reject_always` 的记忆**：与 0.8.1「grant 不持久化」的决定一致；「记住与否」由 agent 自己负责（协议规定）。
6. **不做 `session/load` / `resume` 的跨 run 上下文续接**，也不做跨 provider 上下文迁移（issue #25 已明确不做）；ACP worker 每次 `run()` 新进程新会话。
7. **不改 controller 调度模型**（并发、队列、多阶段 idle 复用逻辑全部不动）。
8. **不做孤儿进程自动清理**、不做 pid 复用防护（只记录 pid，风险表第 7 条）。
9. **不自动安装/升级 provider CLI**（不 `npx` 拉包，不改用户全局环境；安装指引只出现在错误文案里，07 分册 §2）。
10. **不做 `session/list`、`session/delete`、`session/close`、slash commands、`plan` 渲染、`notice` 展示**：要么需要 UI 设计，要么对「一个任务一个 worker」的模型没有收益。
11. **不引入新依赖**：JSON-RPC 与状态机自研（约 300 行）；不引 `@agentclientprotocol/sdk`。
12. **不为抽象而抽象：宁可两份薄类，也不做一个万能类。** 具体表现：(a) 不引入注册表/插件系统，`switch` 的 case 就是全部实现集合；(b) 不把 provider 差异压进配置 profile，控制流差异必须落在对应类；(c) 骨架里不出现 `if (provider === …)`，provider 类里不重复骨架逻辑；(d) 只有「两家完全相同且与 provider 无关」的逻辑才允许下沉到骨架或协议层。反例判据：任何一处改动需要在两个 provider 类里同时做一遍，就是抽象层次选错了。
13. **codex 不在本版范围（本机未安装、无打包计划）。**
