# 分册 07：环境就绪（fail-fast，人类可执行）

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05。
- **契约归属**：错误分类、判定依据、文案模板以冻结页 `00-interface-freeze.md` §4 为准（`acpUserMessage` 产出）；本册写**就绪判定的过程**（CLI 探测、握手探测）、三类失败的退出行为、以及验收前人类可执行的就绪清单。
- 核心原则：**不以静默降级代替报错**。缺 CLI 就报缺 CLI，未登录就报未登录，协议不匹配就报不匹配；安装与登录是用户的事，wayang 不自动装、不自动引导、不静默跳过该 provider、不吞错误继续跑。

## 1. 判定总览（两级：进程前探测、进程内握手）

```
worker.run() 进入前的就绪路径
  1. CLI 探测（不启动 agent 进程）：command 在 PATH / 绝对路径可达？
     否 → AcpError('cli-missing')，run 立刻 failed
  2. 握手探测（起进程）：
     2a. initialize：handshakeMs(15s) 内有响应且 protocolVersion === 1？
         否/超时 → handshake-timeout；版本≠1 → protocol-mismatch
     2b. session/new：sessionNewMs(30s) 内有响应？
         超时且握手 authMethods 非空 → auth-required；
         stderr 命中 login/auth/unauthor/token/401 → 短路 auth-required（不等超时）
  3. opencode 附加项：权限闸配置已注入（gatePermissions 未关闭时 wayang 自动注入，
     05 分册 §3.1）——不注入则 opencode 默认全 allow、权限桥被旁路（03 分册 §3.2）
```

每一级失败都**先 `transport.close` 再抛**（不留孤儿进程），任务直接进 failed，不卡 running，不自动重试（冻结页 §4「重派」列给出哪些失败重派有效）。

## 2. CLI 探测（人类可执行命令）

| provider | 探测命令 | 就绪判定 |
| --- | --- | --- |
| codebuddy | `codebuddy --version`（ACP 入口 `codebuddy --acp`；`codebuddy --help` 应列出 `--acp`） | 输出版本号；本机实测 2.180.0（`/usr/local/nodejs/bin/codebuddy`，别名 `cbc`） |
| opencode | `opencode --version`（ACP 入口 `opencode acp`；`opencode acp --help` 仅 `--login` 一个 flag） | 输出版本号；本机实测 2.2.5（npm 全局 `@opencode/cli`，Bun standalone 二进制） |

wayang 内部判定（对应上面的命令）：`buildLaunch` 前由 worker 层 preflight 解析 `command`（PATH / 绝对路径）；未找到 → `cli-missing`。协议层 spawn 的 ENOENT/EACCES/ENOEXEC 同样折成 `cli-missing`（双保险，02 分册 §3）。`--version` / `--help` 是**人类核对命令**：机器判定只看可执行性，不额外起进程。

安装指引（只出现在文案里，wayang 不代装）：

- codebuddy：`npm i -g @tencent-ai/codebuddy-code`。
- opencode：见 `https://opencode.ai/docs/acp/`。

## 3. 握手探测（initialize + session/new）判定

正常时延基准（2.167.0 探针，冻结页 §9；2.180.0 复测见 03 分册 §2.1）：`initialize` 2921ms、`session/new` 231ms——阈值 15s/30s 有一个数量级的裕度，超时几乎必然是环境问题而不是慢。两家 `initialize` 均实测返回 `protocolVersion:1`；codebuddy `authMethods` 4 项（iOA / Google-Github / WeChat / Enterprise Domain），opencode 单项 `["Login with opencode"]` 且带 `agentInfo {name:"OpenCode", version:"2.2.5"}`。

判定矩阵（wayang 自动执行；人类可用 §5 的单行管线复现）：

| 观测 | 归因 | 依据 |
| --- | --- | --- |
| `initialize` 超时 | `handshake-timeout`（可重派） | 进程起来但不应答；偶发，重试可恢复 |
| `initialize` 回包 `protocolVersion !== 1` | `protocol-mismatch`（不可重派） | 需升级该 CLI |
| `session/new` 超时 + 握手 `authMethods` 非空 | `auth-required`（不可重派，需登录） | codebuddy 未登录实测形态（03 分册 §2.2）：握手成功、session/new 无任何输出 |
| stderr 命中 login/auth/unauthor/token/401 | `auth-required`（短路，不等超时） | 命中即判，避免白等 30s |
| 进程 exit/error 时仍有未 settle 回合 | `transport-closed`（可重派，偶发崩溃） | 文案含 exit code 与 stderr 尾 |

## 4. 三类失败的 fail-fast 文案与退出行为

| 失败 | 文案模板（`acpUserMessage`，冻结页 §4） | 退出行为 |
| --- | --- | --- |
| 缺 CLI | `ACP agent "<command>" 无法启动：<errno 摘要>。codebuddy：npm i -g @tencent-ai/codebuddy-code；opencode：见 https://opencode.ai/docs/acp/` | run 立刻 failed（< 1s，preflight 不起进程）；任务不卡 running；**不静默跳过该 provider、不换备用实现** |
| 握手超时 | `与 "<command>" 握手超时（<N>s 无 initialize 响应），进程已终止。请重试；持续失败请检查 CLI 是否需要登录` | 杀进程（无孤儿）；可重派；不自动重试 |
| 认证失败 | `"<provider>" 未登录：先在终端运行一次 "<command>" 完成登录（<authMethods 名单>）再重试` | run failed；重派无效（需登录）；不做 `authenticate` 交互引导（主文档风险表）；stderr 命中即短路 |

补充退出行为（全类通用）：失败先 `transport.close` 再抛；`close` 幂等，SIGTERM → `sigtermWaitMs` → SIGKILL；待决 permission 一律按拒绝结算（audit source `'aborted'`）；不写半截 transcript 条目（回合未 settle 的 tool_call 标 cancelled，冻结页 §3）。

## 5. 验收前就绪清单（人类可执行，逐项打勾）

实现方在跑 06 分册的 e2e 与真机验收**之前**按此清单确认环境；每项都给出预期结果与失败时对应的归因。

1. `command -v codebuddy` → 输出路径（预期 `/usr/local/nodejs/bin/codebuddy` 或等价）。失败 → `cli-missing` 路径验收（文案断言）。
2. `codebuddy --version` → 输出版本号（本机实测 2.180.0）；`codebuddy --help | grep -- --acp` → 至少一行含 `--acp`。不支持 `--acp` 的老版本按 `protocol-mismatch` 预案核对。
3. codebuddy 登录态：终端运行一次 `codebuddy`（或别名 `cbc`），能正常对话即登录态正常；未登录态按 §3 矩阵验收 `auth-required` 文案（stderr 短路 + 30s 超时两路都要测）。
4. 一次性握手探测（单行管线，等价于 wayang 的 §1 两级判定）：

   ```bash
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"auth":{"terminal":false}},"clientInfo":{"name":"readiness-check","version":"0.9.0"}}}' | timeout 20 codebuddy --acp
   ```

   预期：1-3 秒内回一行 JSON，含 `"protocolVersion":1` 与 `authMethods`。回包后该进程会因 stdin EOF / timeout 退出，属预期（探测只验握手，不建 session）。
5. opencode：`command -v opencode` + `opencode --version` → 本机实测 2.2.5（npm 全局 `@opencode/cli`）；`opencode acp --help` 仅 `--login`。**权限闸确认（就绪链第 3 级）**：`gatePermissions` 默认 true，wayang 启动时自动注入（05 分册 §3.1）；自管配置时确认 workspace 根 `opencode.json` 或父 env `OPENCODE_CONFIG` 含 ask-all 规则——不注入则 opencode 默认全 allow、越界写静默执行（03 分册 §3.2）。`cli-missing` 验收由受控 PATH 用例覆盖（06 分册 §5），无需卸载真机。
6. 配置就绪：`~/.wayang.config.json`（或 `--config`）里 `workers` 段使用 05 分册 §6 示例；`validateConfig` 无报错（05 分册 §5 七条规则全过）。
7. 探针复核（可选，进阶）：`.agents/tmp/` 内跑一次探针（不入库），对照下表的耗时基线；偏差超过一个数量级时先查环境（登录态 / 网络 / 版本），不要先改代码。
8. 真机验收（已交付，opt-in）：`ACP_REAL_CODEBUDDY=1 npx vitest run src/services/agents/acp/__tests__/real-codebuddy.test.ts`、`ACP_REAL_OPENCODE=1 npx vitest run src/services/agents/acp/__tests__/real-opencode.test.ts`——未设开关时全部跳过，`real-opencode` 内的受控 PATH `cli-missing` 用例默认常跑。覆盖：完整回合 / 权限 ask→deny / 取消（06 分册 §5）。

**实测耗时基线**（2026-11-05 真机验收，回归对照用）：

| 场景 | codebuddy 2.180.0 | opencode 2.2.5 |
| --- | --- | --- |
| 完整回合 | 26.8-31.2s | 19.4-31.7s |
| 权限 ask→deny | 11.1-23.4s | 11.7s |
| 取消 | 13.9-17.5s | 6.7-7.0s |

## 6. 「不以静默降级代替报错」的边界（实现方自查）

- 禁止：缺 CLI 时跳过该 provider 继续调度；握手失败时重试 N 次不告知；`auth-required` 被折成普通 `failed` 丢失归因；未知 `type` 静默忽略；`permissionMode:'agent'` 下收到请求静默放行（04 分册 §6）。
- 允许：`handshake-timeout` 与 `transport-closed` 标注「可重派」（重派是用户/上层的决定，不是 worker 内部循环）；`stopReason` 携带的厂商字段（`_meta` 等）原样透传不解释（01 分册 §4 第 5 条）。
- 检查法：06 分册 §4 的降级场景表中，每一条都必须让任务进入 failed 且文案可读；任何「任务 completed 但环境明明没就绪」的路径都是缺陷。
