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

| 对象 | 文件（已交付） | 用例要点 |
| --- | --- | --- |
| 协议层 | `src/services/acp/__tests__/`（client-jsonrpc / client-lifecycle / client-turn / transport / line-decoder / errors / config） | 冻结页 §8 用例 6：ndjson 分帧（超长行/空行/非 JSON 计数）、乱序响应按 id 归位、通知不产生 pending、超时、对端请求 -32601、handler 抛错 -32603、exit+error 单次结算、kill 阶梯时序、`resolveAcpTimeouts` 违例；transport 用真子进程夹具（fixtures/*.mjs） |
| 事件映射 | `src/services/agents/acp/__tests__/event-mapper.test.ts` | **流式累积合并**（同 id 两次 tool_call 全量重发 + update 增量，01 分册 §4 第 1 条）；**两种首事件形态都要测**（codebuddy 空首事件 vs opencode 全量首事件，03 分册 §5）；首个快照不产出 record；`flushUnsettled` → cancelled；thought/user_message_chunk 忽略；plan/usage 进 runtimeState；未知变体 debug 计数 |
| 权限桥 | `src/services/agents/acp/__tests__/permission-bridge.test.ts` | 冻结页 §5 全表；kind 缺失 → 形态推断 → 推断不出直接 ask；输入合并（请求 toolCall 与累积事件合并后判定）；两家的 rawInput 键都要喂（`file_path` 与 `path`，04 分册 §9.3）；审批记忆命中 → 不发信号 + `granted-by-memory` + `grantId`；`sensitiveMode:'deny'` → `hard-denied` + 无 reject 选项 → cancelled；超时 → `denied/timeout`；**选项按 kind 选**（optionId 字面值两家不同：allow/reject vs once/always/reject）；审计字段与 puppet 记录逐字段比对（transport/provider） |
| 骨架 | `src/services/agents/acp/__tests__/acp-worker.test.ts`（内存 fake transport） | 回合循环（多回合 + 队列消息顺序）；`_inputClosed` 判定；stopReason → WorkerResult 映射（02 分册 §4，**cancelled 的拒绝计数收窄见 04 分册 §9.1**）；`abort()` 幂等；`getLiveStatus` 两标志；`trustUpdatesAfterCancel` 两分支（true 保留 / false 丢弃计数） |
| provider 薄类 | `src/services/agents/acp/__tests__/provider-workers.test.ts`（两家合一个文件，断言按 provider 分块） | 握手成功但 `session/new` 超时 → `auth-required`（文案含 authMethods 名单）；stderr 命中 login → 立即短路；`stopPolicy`（codebuddy 8000/2000/true、opencode 5000/2000/false）；`buildLaunch` 默认（`codebuddy --acp` / `opencode acp` + 权限闸注入）；受控 PATH 下 `cli-missing` 文案（codebuddy 安装指引 / opencode 官方 URL） |
| 配置校验 | `src/types/__tests__/config.test.ts` | 05 分册 §5 七条规则（含 `gatePermissions` boolean）；`promptMs:0` 合法；`enable:false` 仍校验；错误文案含字段路径与允许值；AcpProtocolConfig 形状锁 |
| 引擎分发 | `src/services/__tests__/task-execute-engine-acp-wiring.test.ts` | 三个 `type` 各构造出预期类；未知 `type` 抛错并列出允许值；`type` 缺失在 `validateConfig` 就失败（不是派发期）；能力探测后 `respond_permission` 通路回归 |

## 3. 集成：交付状态对账（fake e2e 未交付，双层替代）

原计划（冻结页 §8 用例 1-5）：`e2e/fixtures/fake-acp-agent.cjs`（node 原生 ndjson、剧本开关 `--protocol-version N`、`--no-response <method>`、`--permission-options <allow+reject|allow-only|none>`、`--ignore-cancel`、`--late-updates N`、`--crash-after N`、`--exit-code N`）驱动的 e2e 场景**未交付**。是否补登为待办：**待定**——补齐才能让「不依赖真机的 ACP 回归」进 CI（真机用例默认跳过，见 §5）；若 0.9.x 要 CI 化 ACP 回归，应补登 issue。已交付的替代覆盖分两层：

- **worker 层（内存 fake transport，常跑）**：`acp-worker.test.ts` 用 fake-agent-transport（协议层同款逻辑的拷贝）驱动骨架全场景——完整回合（含三段式 tool_call 流、真实 signal → permissionHandler 审批链、审计 transport:'acp'）、stopReason 映射、取消（`trustUpdatesAfterCancel` 两分支）、`auth-required` 短路、`cli-missing` fail-fast、中途消息回合边界交付（`acceptMessage` 排队 / `_inputClosed` 后拒绝）、`getLiveStatus`。原 §8 用例 1-3 的骨架侧断言在此层。
- **协议层（真子进程，常跑）**：`src/services/acp/__tests__/`（§2 表），transport 用 fixtures/*.mjs——原 §8 用例 6 已交付；用例 5 的失配形态（超时、无响应、退出码）由协议层与骨架测试分担。
- **真机（opt-in，默认跳过）**：§5——原 §8 用例 1-3 的 provider 侧行为（真实 CLI 的形态与时延）在此层证明。
- 用例 4（审批记忆）由 `permission-bridge.test.ts` 覆盖（granted-by-memory + grantId + clearTask 清空）。

分工纪律：**fake 断言证明骨架行为，真机证明 provider 行为**，两层都不许冒充对方（§5）。多阶段（idle worker 复用时新起进程、新 session）与中途消息的场景断言在 `acp-worker.test.ts`；断言与 claude-code 场景同构，复用同一组断言函数（transcript 条目形状一致，02 分册 §7）。

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

## 5. 真机验收（已交付，opt-in；如实，禁止把 fake 行为写成真机行为）

- **开关**：`ACP_REAL_CODEBUDDY=1` / `ACP_REAL_OPENCODE=1`；未设置时全部跳过（`describe.skipIf`），默认套件（CI）从不拉起真实 CLI。
- **文件**：`src/services/agents/acp/__tests__/real-codebuddy.test.ts` / `real-opencode.test.ts`，共享夹具 `real-acp-harness.ts`（wire 侦听 worker、录制信号队列、目录跟踪、证据落盘）。
- **运行**：

  ```bash
  ACP_REAL_CODEBUDDY=1 npx vitest run src/services/agents/acp/__tests__/real-codebuddy.test.ts
  ACP_REAL_OPENCODE=1 npx vitest run src/services/agents/acp/__tests__/real-opencode.test.ts
  ```

- **覆盖**（两家同三场景，本册原「真机验收纪律」的落成用例）：① **完整回合**——读 + 写 + bash 的真实任务 → completed，transcript 同构（text + toolCalls/toolResults）、`runtimeState.acp.pid`、进程干净退出；② **权限 ask→deny**——workspace 外写浮出 `permission_request`，controller 拒绝（resolvePermission false）后回合收尾——实测两家均以 `stopReason:'cancelled'` 收尾，按 04 分册 §9.1 映射为 `failed('Permission denied by user: <tool>')`；③ **取消**——工具执行中途 `session/cancel` → `failed('Aborted')`，无残留 agent / 工具子进程，transcript 无撕裂行。opencode 的 ask 场景经 `OPENCODE_CONFIG` 注入权限闸后跑（03 分册 §3.2），完整回合与取消场景**有意不注入**，保持对默认行为的度量。
- **收尾判定回归（拒绝后 cancelled，fake 层锁行为）**：拒绝后的 `cancelled` 收尾不再「有过一次重投 + 本回合任意 ≥1 字符」就判 completed——判据收紧为三条件同时满足：本轮是重投回合（重投证据按回合计数、回合切换清零，不沿用 run 级累计）、本回合有 trim 后 ≥8 字符的有效正文、且非外部 cancel/abort 打断（cancelFact 优先）。回归用例（`src/services/agents/acp/__tests__/acp-turn-loop.test.ts`）：`deny → agent continues with final text → stopReason=cancelled → completed`（残留完成保留）、`deny → reissue → continue → abort in a later round → failed (Aborted), not completed`（M1）、`deny after in-turn text → reissue round with NO text + cancelled → failed (per-turn text isolation)`（M2）、`deny → reissue → continue → later round text + cancelled (no cancel sent) → failed`（run 级粘滞回归）。**M2 有效性验证**：删除 `acp-worker-run.ts` 回合循环里的 `resetTurnProgress()` 调用后，M2 用例必须失败（2026-11-10 实测：`AssertionError: expected 'completed' to be 'failed'`）——该验证防的是「reset 被误删而用例照样绿」的假锁。
- **证据落盘**：每用例经 `onTestFinished` 把双向 wire transcript（带时间戳）、收集到的信号与摘要写进 `.agents/tmp/real-evidence/<provider>-*.json`——断言失败时证据仍在（AGENTS.md 临时文件纪律）。
- **默认常跑**：`real-opencode.test.ts` 内置受控 PATH 的 fail-fast 用例——测试把自己的 PATH 指向空临时目录（finally 恢复），验证 opencode 缺失时 preflight 报 `cli-missing`（文案含官方 URL）且任务不卡 running；与真机是否装了 opencode 无关地常绿。
- **实测耗时基线**（2026-11-05，回归对照，详见 07 分册 §5）：codebuddy 完整回合 26.8-31.2s、ask→deny 11.1-23.4s、取消 13.9-17.5s；opencode 完整回合 19.4-31.7s、ask→deny 11.7s、取消 6.7-7.0s。回归偏差超一个数量级先查环境（版本 / 登录态 / 网络），不要先改代码。
- **纪律**：能力矩阵（05 分册 §7）回填实测值，没有「猜」出来的值；未实测项照实写；CHANGELOG 与实际交付一致；复核 07 分册 §2 的探测命令确认 CLI 状态没变；新发现的未核实项补进 03 分册与主文档风险表。

## 6. 门槛与覆盖率

- 协议层单测覆盖率 ≥ 85%；`session`/client 级测试至少 6 个用例走真子进程。
- 修改核心模块（state / controller / worker / agent loop）后重跑全量 `npx vitest run`。
- 分层禁令的 grep 断言（`src/services/acp/**` 无 `@/services/agents` / `@/types/config` import、无 provider 名字）进 CI 或 lint 脚本。
