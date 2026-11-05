# 分册 06：测试计划

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05。
- **契约归属**：fake ACP server 的剧本开关与六个验收用例以冻结页 `00-interface-freeze.md` §8 为准（本册不复制其断言清单）。本册写**测试对象矩阵、降级场景与真机验收纪律**。
- 门槛（每步实施都过，缺一不可）：`npm run lint`、`npx vitest run`、`npm run build`；新增 e2e 全绿；分层禁令用 grep 断言守住（01 分册 §1）。

## 1. 原则

- **provider 差异断言写在该 provider 的测试文件里**（`codebuddy-worker.test.ts` / `opencode-worker.test.ts`）；公共断言函数不允许出现 `if provider` 分叉——与「provider 类 vs 骨架」的 code review 边界同构（02 分册 §8）。
- **协议层单测用真子进程**（fake ACP agent），不是 mock：分帧、退出、kill 阶梯都是进程行为，mock 测不出。
- **测试不走「注册假实现」**：每个 provider 类直接 `new CodebuddyAcpWorker(fakeConfig, …)`；e2e 用 fake ACP agent 子进程，不依赖引擎注入点。
- Mock state 自包含；避免同秒假设（测试 ID 用唯一前缀）；修 bug 后重跑全套。

## 2. 单元测试对象矩阵

| 对象 | 文件 | 用例要点 |
| --- | --- | --- |
| 协议层 | `src/services/acp/__tests__/`（transport / client / config） | 冻结页 §8 用例 6：ndjson 分帧（超长行/空行/非 JSON 计数）、乱序响应按 id 归位、通知不产生 pending、超时、对端请求 -32601、handler 抛错 -32603、exit+error 单次结算、kill 阶梯时序、`resolveAcpTimeouts` 违例 |
| 事件映射 | `src/services/agents/acp/__tests__/event-mapper.test.ts` | **流式累积合并**（同 id 两次 tool_call 全量重发 + update 增量，01 分册 §4 第 1 条）；首个快照不产出 record；`flushUnsettled` → cancelled；thought/user_message_chunk 忽略；plan/usage 进 runtimeState；未知变体 debug 计数 |
| 权限桥 | `src/services/agents/acp/__tests__/permission-bridge.test.ts` | 冻结页 §5 全表；kind 缺失 → 形态推断 → 推断不出直接 ask；输入合并（请求 toolCall 与累积事件合并后判定）；审批记忆命中 → 不发信号 + `granted-by-memory` + `grantId`；`sensitiveMode:'deny'` → `hard-denied` + 无 reject 选项 → cancelled；超时 → `denied/timeout`；**选项按 kind 选**（`allow_always` 排第一时仍选 `allow_once`）；审计字段与 puppet 记录逐字段比对（transport/provider） |
| 骨架 | `src/services/agents/acp/__tests__/base-acp-worker.test.ts` | 回合循环（多回合 + 队列消息顺序）；`_inputClosed` 判定；stopReason → WorkerResult 映射（02 分册 §4）；`abort()` 幂等；`getLiveStatus` 两标志；`trustUpdatesAfterCancel=false` 时丢弃计数（transcript 条数不增） |
| codebuddy 类 | `src/services/agents/acp/__tests__/codebuddy-worker.test.ts` | 握手成功但 `session/new` 超时 → `auth-required`（文案含 authMethods 名单）；stderr 命中 login → 立即短路（不等 30s）；`stopPolicy` 为 8000/2000/true；`buildLaunch` 默认 `codebuddy --acp` |
| opencode 类 | `src/services/agents/acp/__tests__/opencode-worker.test.ts` | `buildLaunch` 默认 `opencode acp`；`stopPolicy` 5000/2000/**false**；取消后 update 丢弃；`cli-missing` 文案含官方 URL；全部行为标注来源为 fake agent（真机未实测，§5） |
| 配置校验 | `src/types/__tests__/config.test.ts` | 05 分册 §5 七条规则；`promptMs:0` 合法；`enable:false` 仍校验；错误文案含字段路径与允许值 |
| 引擎分发 | `task-execute-engine` 相关测试 | 三个 `type` 各构造出预期类；未知 `type` 抛错并列出允许值；`type` 缺失在 `validateConfig` 就失败（不是派发期）；两处 `instanceof` 改为能力探测后 `respond_permission` 通路回归 |

## 3. 集成：fake ACP server 端到端（冻结页 §8）

`e2e/fixtures/fake-acp-agent.cjs`：node 原生 ndjson（禁用 ACP SDK），剧本开关 `--protocol-version N`、`--no-response <method>`、`--permission-options <allow+reject|allow-only|none>`、`--ignore-cancel`、`--late-updates N`、`--crash-after N`、`--exit-code N`。六个验收用例（完整回合含权限与取消 / ask→拒绝 / 取消 / 审批记忆 / 失配降级 / 协议层单测）以冻结页 §8 为准。补充场景（07 分册联动）：

- **中途消息**：`chat_worker` 回合进行中投递 → `acceptMessage` true → 当前回合结束后以新 `session/prompt` 交付 → transcript 出现 `[Controller message]` 前缀条目；回合结束后投递且队列为空 → false。
- **多阶段**：idle worker 复用时新起进程、新 session（与 claude-code「每次 run 新会话」一致）。
- 断言与 claude-code 场景同构：复用同一组断言函数（transcript 条目形状一致，02 分册 §7）。

## 4. 降级场景（fail-fast，与 07 分册共用文案基准）

| 场景 | 期望 |
| --- | --- |
| `command` 不在 PATH | run 立刻 failed（< 1s），`cli-missing`；文案含该 provider 的安装指引（codebuddy：`npm i -g @tencent-ai/codebuddy-code`；opencode：官方 URL）；任务不卡 running；**绝不静默跳过该 provider** |
| initialize 15s 无响应 | failed，`handshake-timeout`；文案提示重试与「检查 CLI 是否需要登录」；进程已终止（无孤儿） |
| `session/new` 30s 无响应且 `authMethods` 非空 | failed，`auth-required`；文案给该 provider 的登录指引；重派无效（需登录） |
| stderr 命中 login/auth/unauthor/token/401 | 立即 `auth-required`（短路，不等超时） |
| `protocolVersion !== 1` | failed，`protocol-mismatch`；错误含对端版本号；不尝试降级解析 |
| 权限选项集无 allow 且无 reject | outcome `cancelled` + 审计 `hard-denied` + protocol-mismatch 日志（不静默放行） |
| agent 退出（crash） | `transport-closed`；文案含 exit code 与 stderr 尾 20 行（截 2000 字） |
| 取消后迟到 update | `trustUpdatesAfterCancel=false`（opencode 默认）丢弃 + 计数；`true`（codebuddy 默认）照常写——两类 provider 各自断言 |
| 未知 `type` / 缺失 `type` | 加载期失败，文案列出三个允许值（不是派发期才炸） |

## 5. 真机验收纪律（如实，禁止把 fake 行为写成真机行为）

- **codebuddy（主路径）**：可用真机验收。最低要求：登录态跑通一个真实任务（读文件 + 改文件 + 一次权限审批）；未登录态能稳定复现 `auth-required` 文案（stderr 命中即短路，不卡 30s×N）。实测基准见 03 分册 §2.1（2026-11-05 探针，五步 27.5s）。
- **opencode（experimental）**：真机链路未实测**不阻塞** 0.9.0 发布；验收只要求 fake 全绿 + fail-fast 文案断言（§4）。能力矩阵（05 分册 §7）里如实写「未实测」，写清卡在哪（本机未安装）。
- **能力矩阵回填**：实现完成后把实测结果回填 `docs/develop/acp-capability-matrix.md`；没有「猜」出来的值；CHANGELOG 与实际交付一致。
- 复核：重跑 07 分册 §2 的探测命令，确认 CLI 状态没变；新发现的未核实项补进 03 分册与主文档风险表。

## 6. 门槛与覆盖率

- 协议层单测覆盖率 ≥ 85%；`session`/client 级测试至少 6 个用例走真子进程。
- 修改核心模块（state / controller / worker / agent loop）后重跑全量 `npx vitest run`。
- 分层禁令的 grep 断言（`src/services/acp/**` 无 `@/services/agents` / `@/types/config` import、无 provider 名字）进 CI 或 lint 脚本。
