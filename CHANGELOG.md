# Changelog

## v0.9.4 (2026-11-09)

### 新增

- ACP worker 注入 `wayang` MCP server，暴露 `update_progress` 与 `ask_controller` 两个工具（仅文本进度、无百分比）；`update_progress` 为进度上报主路径，`session/update` 500ms 去抖降为降级路径。
- 进度兜底：连续 120s 无 `update_progress` 上报时，用最新一条完整回复自动补报一次（上限 20000 字符、按 reply id 去重）。
- agent 不接受 `mcpServers` 时只重试一次并 fail-soft 降级，任务不失败。

### 修复

- ACP 降级进度改为按消息上报，不再逐 chunk 播报：无 MCP 时原先对每个 `session/update` chunk 做 500ms 去抖，流式输出（如 knot 把一句拆成「你」「好」「。」）只剩单字碎片；现在直接复用 `AcpTurnWriter` 聚合出的完整消息，由 120s 空闲计时器与回合结束补报触发（上限 20000 字符），并用「水位线 + key 标量」去重，真实 `update_progress` 覆盖过的内容不再重复播报。

## v0.9.3 (2026-11-07)

### 新增

- 新增通用 ACP worker 类型 `acp`：由 `workers.<id>` 的 `command`（必填）/ `args` / `env` / `permissionMode` / `protocol` / `trustUpdatesAfterCancel` 声明式驱动，无需为每个 ACP CLI 新增子类；就绪判定沿用基类默认（`protocolVersion === 1`），取消后更新默认丢弃（`trustUpdatesAfterCancel` 可改为信任）。
- 类型改名：`codebuddy-acp` → `codebuddy`，`opencode-acp` → `opencode`。旧值仍可用：配置解析出口（`loadConfig`）将其规范化为新值并输出弃用告警，存量配置无需改动。

### 改进

- `BaseAcpWorker` 的 `buildLaunch` / `isReady` / `stopPolicy` 由 abstract 改为带默认实现的可选 override（通用启动透传、`protocolVersion === 1` 就绪检查、中性保守停止策略 5000/2000/取消后不信任），codebuddy / opencode 两个专用类的实测覆写保持不变。

## v0.9.2 (2026-11-06)

### 修复

- ACP worker 区分权限拒绝来源：policy 硬拒绝与审批超时不再统一映射为 `Aborted`，分别报 `Permission denied by policy: <tool>` 与 `Permission request timed out: <tool>`；真取消与 abort 清理路径保持不变（#56）。
- ACP 回合循环重构：按「我们是否发过 session/cancel」而不是 agent 返回的 stopReason 归因回合结束，新增 `our_timeout` 类别区分协议超时与用户取消；policy / timeout 拒绝不再一次即终止，改为把脱敏后的拒绝原因以 `[SYSTEM NOTICE]` 注入下一轮 prompt 继续执行（同一 key 最多 1 次、每次 run 最多 3 次）；新增六个护栏：单 run 最多 12 回合、连续 2 个拒绝回合熔断、连续 2 回合无进展终止、墙钟 30 分钟上限、拒绝补发配额、同 key 配额。用户主动拒绝与 `permissionMode=agent` 的协议级拒绝不注入、不补发（#56）。
- claude-code worker 接入任务级审批记忆与 grant：`canUseTool` 消费与 puppet 相同的 `reusableGrantKeys`，同一任务内同一 key 不再重复询问，任务结束统一失效（#58）。

### 改进

- `/tasks` 每行补充 worker 类型、耗时与结果/错误摘要，失败任务显示 error 摘要；`list_tasks` 对 `result` / `error` 统一按工具输出上限（默认 20000 字符）截断并标注省略（#49）。
- bash 判定兜底：`xargs`、`find -exec/-execdir/-ok`、`eval`、`cd <dir> && ...`、脚本文件（`bash script.sh`）、复合关键字（`for/do/then` 等）这些含内层命令但未递归解析的形态，由 `allow(no-path)` 升级为 `ask`，reason 指明形态；只读命令与带显式路径的普通命令行为不变（#51）；同一 issue 的行为细化：开头仅以 `&&` 相连的单段字面量 `cd <dir>` 链不再一律 ask，而是以 workspace 为基准 cwd 用逐段推进的局部游标做绝对化与规范化（realpath 最深已存在祖先 + 补齐不存在尾部），再按敏感清单与边界判定放行，越界或命中敏感仍 ask 并在 reason 中指明 cd 目标与解析出的绝对路径，变量 cd（`cd $X`）、子 shell（`(cd …)`）、`cd -`、pushd/popd 与 `;` 相连形态维持 ask。注：0.8.4 曾冻结该范围，本版恢复。

## v0.9.1 (2026-11-05)

### 文档

- README 增加 ACP worker 接入说明：codebuddy / opencode 的安装前置、workers 配置示例、默认启动命令与覆盖方式、权限闸（含 opencode 默认注入 ask-all 的 OPENCODE_CONFIG 与 `protocol.gatePermissions` 开关）、能力与限制、设计文档索引（#59）。
- 修正 v0.9.0 段落中日志轮转的表述，与实现一致（单文件 10MB 上限、保留 3 份历史）（#60）。

## v0.9.0 (2026-11-05)

### ACP worker 适配层（Refs #25）

- 新增协议层 `src/services/acp/`：自实现 ndjson 分帧与 JSON-RPC（零新增依赖）、超时矩阵、错误分类、取消时序（session/cancel → 宽限 → SIGTERM → SIGKILL）、pending 请求收敛。
- 新增 worker 层 `src/services/agents/acp/`：BaseAcpWorker 骨架 + codebuddy-acp / opencode-acp 两个 provider 薄类；事件映射按 toolCallId 合并，兼容 codebuddy 的「空首事件三段式」与 opencode 的「首事件即全量」；回合内 transcript 写入与信号通道复用既有实现。
- 权限：ACP request_permission 接入既有 decideToolAccess 与任务级审批记忆；optionId 按 kind 选择（不依赖顺序与字面值），未知形态 fail-closed；审计新增 allowed / granted-by-memory 决策与 transport/provider 字段。
- 接线：`WORKER_TYPES` 增加两种类型；WorkerConfig 支持 command/args/env/protocol/permissionMode；引擎 worker 分发与接线改用能力探测替代 instanceof；controller prompt 标注 `[acp:<provider>]`；provider 默认 emoji。
- 实测：codebuddy 2.180.0 与 opencode 2.2.5 的 initialize / session/new / prompt / cancel 全链路跑通（耗时基线见设计文档 07 分册）。
- opencode 权限闸：其默认权限为全放行，不注入配置时 bash 与文件写完全不经 wayang 审批。本版在 opencode provider 默认注入 ask-all 的 `OPENCODE_CONFIG`；可用 `protocol.gatePermissions=false` 关闭（会告警），父进程已有 `OPENCODE_CONFIG` 时不覆盖（会告警），闸文件写入失败则直接失败，绝不无闸启动。
- 拒绝语义：agent 被拒后以 stopReason cancelled 收尾，本版按「本回合拒绝次数」区分——拒绝映射为 `failed("Permission denied by user: <tool>")`，真取消仍为 `Aborted`。
- 真机验收测试为 opt-in（`ACP_REAL_CODEBUDDY=1` / `ACP_REAL_OPENCODE=1`），另含受控 PATH 的 opencode CLI 缺失 fail-fast 用例（默认常跑）。

### 大文件拆分（Refs #50）

- 拆分 7 个超过 500 行的源文件（permission-rules 1832 / task-execute-engine 1488 / claude-code-worker 1186 / controller-agent 924 / shell-lexer 606 / worker-transcript 573 / input-area 530），纯搬移并保留原路径门面；src 下已无 >500 行源文件。

### 日志与缓冲（Fixes #52, #53）

- DEBUG 级 LLM 调用日志默认只记元数据（model / 消息数 / token 估算）；全量 prompt 需 `WAYANG_LOG_PROMPTS=1` 且强制脱敏，单条日志从约 286KB 降到百字节量级。
- 日志按大小轮转（单文件 10MB 上限，保留 3 份历史），总量有界；resume 不读日志，行为不变。
- 工具结果写入 transcript 增加统一上限（`WAYANG_TOOL_OUTPUT_MAX_CHARS`，默认 20000，保留头尾并标注省略）。

### 修复

- `resolveAcpTimeouts` 不再把 protocol 中的非超时键（capabilities、gatePermissions）当作超时值校验；此前用户一旦配置 `protocol.capabilities` 该 worker 必然启动失败。

### 文档

- ACP 设计文档改为 v3：索引页 + `docs/design/acp/` 分册（协议、骨架、providers、权限、配置、测试、就绪）+ 冻结页「实测勘误」；codex 不在本版范围。

### 已知限制

- 权限策略硬拒绝（`sensitiveMode: 'deny'`）与权限超时引发的 cancelled 仍映射为 Aborted（Refs #56）。
- 冻结页原规划的 fake-acp-agent e2e 夹具未交付，暂以 worker 层 fake + 协议层真子进程 + 真机 opt-in 测试替代。
- claude-code worker 的 `setSignalContext` 尚不接收 grants/approvalMemory，任务级审批记忆对 claude-code 不生效。

## v0.8.4 (2026-11-05)

### 路径语义与 CLI

- `~` 展开与读策略边界拆分（#47）：`~` / `$HOME` 的展开结果恒与 shell 一致（锚定进程 `$HOME`），权限边界（敏感列表与 read-within-home 的锚点）是另一个概念——生产环境二者同为用户主目录，但策略锚点可注入（测试），展开绝不跟随它。此前二者共用「策略 homeDir」展开，当锚点偏离进程 `$HOME` 时，`read_file('~/x')` 打开的文件与 `cat ~/x` 不同，权限门裁决的也是另一条路径。
- 删除「从 sessionDir 反推用户主目录」的逻辑（#47）：engine、controller agent 与 Claude Code worker 三处均改为直接取进程 `$HOME`。此前 `--home-dir` 指向自定义目录时，反推出的「用户主目录」等于该目录，读边界与敏感列表全部锚在错误的位置。
- 统一 `~` 展开器：read_file / write_file / edit_file / search_files / search_content / add_task 的 workspace 声明全部走同一个 `expandHome`（锚定进程 `$HOME`），`$HOME` / `${HOME}` 前缀同样展开，`~user` 仍不展开（无法安全解析，门按 `home-other-user` 询问）。bash 侧 `$HOME` 替换与候选展开同样改锚进程 `$HOME`，`cat ~/x` 与 `cat $HOME/x` 在裁决上等价。
- CLI：`--home-dir` 更名 `--wayang-root`（默认 `~`，即 `$HOME`），语义不变——它是 wayang 运行时状态的根目录（数据在 `<root>/.wayang`，配置在 `<root>/.wayang.config.json`），从来不是操作系统用户主目录。`--home-dir` 保留为弃用别名，使用时警告一次；两者同时给出时 `--wayang-root` 优先。
- 全局技能目录跟随 wayang 数据目录（`<wayang-root>/.wayang/skills`，默认 `~/.wayang/skills`），不再硬编码进程主目录。
- Claude Code worker 自动放行 wayang 自家 MCP server 的工具（`mcp__wayang__*`，如 ask_controller）：它们是面向 controller 的工具而非文件 IO，若被「未识别工具」分支拦下，需要 controller 审批才能调用的 ask_controller 会死锁。其它 server 的 MCP 工具（`mcp__other__*`）仍按未识别工具询问。

### 权限

- bash 只读命令分类（#47）：引入显式只读命令表，段首命令命中即判 read，命令替换内部与顶层共用同一张表。判定前剥离 sudo / env / nohup / time / nice / ionice / command / exec / builtin 等前缀与前导变量赋值；git 只放行 status、log、diff、show、rev-parse、ls-files、blame、grep、describe、shortlog 与 branch -a / remote -v。写动词、写 flag、真实重定向仍优先判写；不在表内一律 unknown。这里的 fail-closed 是**方向口径**上的，不产生审批：unknown 只表示「方向未知」——它不吃 read-within-home、敏感命中仍按读判，本身既不是 ask 也不是 deny；没有任何路径候选的命令（`ls -la`、`npm test`、`git status`）照旧默认 `allow`（`matchedRule: 'no-path'`）。唯一会因此升级成 ask 的是「命中只读表、但该表声明的延迟条件无法验证」（`sed -f`、脚本里可执行或可写），记 `read-only-unverified`。
- 危险命令 tier 与路径判定口径统一：危险关键词（rm / sudo / chmod / chown / mkfs / dd / shutdown / reboot / kill -9）改为在「命令位置」判定，不再用行首正则。此前 `rm -rf x` 走 `ask(dangerous-bash)`，而 `nohup rm -rf x` / `nice rm -rf x` / `env FOO=1 rm -rf x` 因为正则不认 wrapper 前缀落到 `allow(no-path)`——现在两条路径读同一个命令词，`sudo rm -rf x` 仍 `ask`。
- `bash -c` / `sh -c` 内层命令递归判定：识别 bash / sh / dash / zsh 的 `-c`（含 `-lc` / `-ic` 组合与 `--command`），取脚本文本递归走同一套规则，结果按更严格者合并（deny > ask > allow）并保留内层命中条目与方向：`bash -c "cat ~/.ssh/id_rsa"` → `ask(sensitive-list)`、`bash -c "rm -rf /"` → `ask(dangerous-bash)`、`bash -c "cat /etc/hostname"` → `ask(outside-all)`、`bash -c "ls -la"` → `allow`。深度上限与命令替换共用（5 层），超限、引号不闭合、脚本由变量或命令替换拼成一律 ask；`bash script.sh`（无 `-c`）行为不变。剩余绕过面（xargs / find -exec / eval / cd 跟踪）见 #51。
- 审批 description 显示真实解析路径：`~` / `$HOME` 与权限门使用同一个 `expandHome`，并优先复用门已确认的 `resolvedPath`。此前 `read_file ~/.wayang.config.json` 在审批与 TUI 里显示成 `<workspace>/~/.wayang.config.json`；`~user` 无法解析时保留原文并标注。
- allow 决策写审计：审计枚举新增 `allowed`，在 allow 快路径执行前落一条记录（matchedRule / access / resolvedPath / operation / taskId / workerId / toolName / ts）。不记命令原文，与既有立场一致：决策可观测，内容不可观测。
- 收紧 sed 的只读准入：脚本按白名单校验，`e` / `w` / `W` / `r` / `R` 命令与 `s///e` 等 flag 一律不判只读，`-f script.sed` 因无法在判定期确认同样不判只读。
- 敏感写改为审批：敏感命中不再是「不可审批」，而是「不可静默」——敏感列表仍压过所有 allow 规则，命中只可能是 ask 或 deny。默认 `sensitiveMode: 'ask'` 时读写都走审批（请求带命中条目、来源、路径与方向），`sensitiveMode: 'deny'` 时读写都直接拒。`matchedRule` 统一为 `sensitive-list`，方向由审计的 `access` 字段承载，旧的 `sensitive-list-write` 移除。
- 任务级审批记忆（#46）：同一任务内，同一路径的读方向批准一次后不再重复询问；key 为「方向 + 规范化路径」，文件工具与 bash 共享；敏感命中、写方向、deny 结果永不记忆；任务进入 completed / failed / cancelled 即清除，不跨任务、不跨 session、不持久化。新增 `permission.approvalMemory: 'task' | 'off'`（默认 `task`）。审计新增 `granted-by-memory` 决策与 `grantId` 字段。

### 说明

- 本版尚未发布到 npm；发布由 `v0.8.4` tag 触发。
- 权限改造在 0.8.x 收口，后续版本不再扩展该范围。

## v0.8.3 (2026-11-04)

### 权限

- `~/.wayang` 与 `~/.wayang.config.json` 移出敏感列表：它们属于 wayang 自身的运行时数据（会话、审计、worker 临时文件）与配置，不再按敏感条目判定。第三方凭据（`.ssh`、`.aws`、`.npmrc`、`.docker/config.json` 等）保持敏感，读仍审批、写仍硬拒。`SENSITIVE_FILENAMES` 表随之删除。

### 工作区

- 新增通用工作区 `~/.wayang/workspace`：不关联代码库、或用户未指定目录的任务（调研、资料整理、起草文档）在它下面执行，首次使用时自动创建。
- `add_task` 的 workspace 支持 `~` / `$HOME` 展开，声明的绝对路径不存在时自动创建；无法解析或创建时任务不创建，不再静默回落到默认工作区。
- worker 与 controller 的提示词统一临时文件约定：中间产物放任务 workspace 内的 `.agents/tmp/`，不用 `/tmp`、不写用户主目录或仓库根；controller 派发任务时在描述里交代这一点。

### 文档

- AGENTS.md 增加临时文件约定小节；权限设计文档同步 0.8.3 的放行范围。

### 说明

- 本版尚未发布到 npm；发布由 `v0.8.3` tag 触发。

## v0.8.2 (2026-11-04)

### 构建与发布

- 新增 GitHub Actions 发布流水线（.github/workflows/release.yml）：推送 v* tag 时自动执行 lint、全量测试与构建，校验 tag 与 package.json 版本一致、目标版本尚未发布，再以 npm Trusted Publishing（OIDC）发布，无需长期 token，自动生成 provenance。手动 dispatch 默认 dry-run。
- 本版本无功能变更，仅用于打通自动发布链路。

## v0.8.1 (2026-11-04)

### Features

- **敏感列表命中改为审批并留审计（#24、#35 的一部分）**：denylist 更名为 sensitiveList；读方向的命中不再直接拒绝，转为 controller 审批（请求里带命中条目、命中来源 segment/filename/pair/home-default/config-dir、规则与读写方向，批准后可读原文，拒绝不泄露内容）；写方向仍硬拒且不可被 allowedDirs / task allowedDirs / workspace 覆盖。批准、拒绝、硬拒三种情况都写结构化审计（pino，字段限定为路径、命中条目、taskId、workerId、时间、读写方向、决策、来源，不含文件内容）。新增 permission.sensitiveDirs；旧的 permission.deniedDirs 保留为 deprecated 别名（与 sensitiveDirs 合并去重，首次使用打一次 warn）；新增 permission.sensitiveMode: ask | deny，默认 ask，可用于回到旧行为。
- **bash 丢弃型重定向与只读命令替换豁免（#24）**：新增最小 shell 词法器（不认识构造一律视为无法解析）。输出重定向目标为 /dev/null、/dev/stdout、/dev/stderr 及 fd 复制（2>&1、&>）不再触发审批；真实文件重定向仍按写判定。$(...) 与反引号内为只读白名单命令（cat/ls/grep/head/tail/wc/stat/file/which/command/readlink/echo/printf/date/pwd）时递归判定其路径，嵌套上限 5 层；无法解析一律转审批。
- **TUI 展示任务 workspace 与 /projects（#36）**：/tasks 仅对非默认 workspace 的任务追加 slug 标记，默认任务输出不变；controller 对话流中 add_task 行显示该任务声明的工作区 slug（默认工作区不显示，未知 slug 回退目录名）；新增 /projects 列出本 session 使用过的工作区（slug 与绝对路径一一对应，默认工作区标 *，无数据输出 No projects，长路径按显示宽度中间省略）。
- **controller 启动时加载 AGENTS.md（#38）**：home 目录的 AGENTS.md 作为基线、启动目录的作为补充（冲突以工作目录为准，提示中明确说明），启动时计算一次注入 controller 系统提示；同文件按 realpath 去重，缺失静默跳过，总量上限 32KB 按 UTF-8 字节截断并在字符边界切分、末尾标注。worker 侧按任务 workspace 加载规则的行为不变。

### Fixes

- **/tasks 不再渲染完整任务描述（#39）**：描述按显示宽度截断为单行（80 列上限，CJK/emoji 双宽），列表设 20 条预算且优先保留 pending/running，超出时提示真实总数与未显示的历史条数。修复任务描述很长时 /tasks 导致 TUI 卡死。
- **直接启动时恢复最后活跃的 session（#40）**：默认自动恢复改为按最近活动时间选取（conversation.jsonl 最新条目时间与 meta.lastActiveAt 取较大者，缺失回退 createdAt，再缺失回退索引快照），时间相同按 sessionId 字节序降序做确定性 tie-break。显式 --resume <id> 与交互选择器语义不变。

### Breaking

- **sensitiveList 的读命中由硬拒改为审批**：原先命中即拒绝、无审批通道；现在读方向会向 controller 发起审批，批准后可读原文（密钥等内容可能进入模型上下文，这是有意的取舍）。写方向仍是硬拒。
- **permission.deniedDirs 标记为 deprecated**：仍然生效（与 sensitiveDirs 合并），但首次使用会打印一次迁移提示；后续版本将移除。

### 未纳入本版本

- #24 的后续项：bash 只读命令分类、审批记忆/任务级授权、审批可观测性统计，留待后续版本（设计见 docs/design/permission-policy-0.8.1.md）。

### 验证

- lint（tsc --noEmit + eslint）通过；全量测试 102 文件 / 1685 用例通过；build 成功（dist/cli.js 约 542 KB）。

## v0.8.0 (未发布)

### Features

**任务级 workspace 作用域（#14）** — The workspace is demoted from a process-level argument to a per-task scope, so one resident controller can dispatch workers into several projects. `add_task` accepts an optional `workspace` path (omitted → the current directory); the value is canonicalized and stamped on the task together with its registry slug — a handle assigned once and never reused — so a task really runs where it says it does: worker creation, the puppet tool cwd, the permission boundary, the project-rules lookup and the prompt's `WorkspaceDir` all come from `task.workspace.path` rather than the process workspace, and legacy tasks without a stamp still fall back to it. Workspace identity is also persisted on the session meta, the worker runtime state and the turn envelope. A session accumulates every workspace it dispatches work into (idempotent by canonical path) and is matched — by restore, the interactive session picker and `--resume` — against ANY of them, while legacy single-valued `meta.workspace` and unstamped tasks keep reading as before and are backfilled in memory only. The CLI picker shows each session's workspace handle (one slug, or "first + N" for several), the TUI's status bar tags each worker row with its task's workspace slug (dropped first when the line is short) and the session banner summarizes the same list

**worker 身份补齐与启动信号（#30）** — Every worker signal header now identifies the worker: `[WORKER PROGRESS SIGNAL: TYPE task=<id> worker=<id>]` carries the task and worker segments whenever known (previously only the task id survived rendering, so progress/completed/failed/task_cancelled were anonymous to the controller), and the worker id no longer appears in three different body templates. Two new lifecycle signals make the dispatch states distinguishable: `TASK_QUEUED` (all concurrency slots busy — the task waits, exactly once per task) and `WORKER STARTED` (a worker actually spawned or an idle multi-stage worker was reused, marked `reused`); spawn failures keep the existing FAILED signal. `add_task` returns the started worker's id in its result (or says the task is queued), and `list_tasks` shows each task's worker id, with an explicit "none" while queued. The controller prompt now documents that header format — including the `worker=` segment and its absence while a task is queued — and the queued / started / failed lifecycle

**三层路径允许 + denylist（权限模型）** — Path access is decided by one shared, side-effect-free policy instead of per-tool regexes. Allows come in three tiers — the user's config (`allowedDirs` / `autoAllowRoots` / `deniedDirs`), the task's own `allowedDirs` (declared at `add_task` time, validated against the home boundary and the denylist, stored normalized and deduped, never inherited by another task) and a single approval for everything else — and the built-in denylist outranks all of them. The denylist gained a rule that does not depend on the injected home anchor: sensitive path segments (`.ssh` / `.gnupg` / `.aws` / `.azure` / `.gcloud` / `.kube` / `.netrc` / `.git-credentials` / `.npmrc` / `.pypirc` / `.wayang`, plus `.wayang.config.json` and `.docker/config.json`) are matched as whole segments against every absolute path and denied outright, with no approval prompt, so a credential directory under another root or behind a symlink can no longer fall through to "ask". Paths are canonicalized to their deepest existing ancestor before judging, which closes the symlinked-ancestor bypass, and targets that cannot be determined statically (`~user`, command substitution, output redirection) escalate to approval instead of being allowed silently. Workers are auto-allowed only inside their task workspace, the task's `allowedDirs` and the configured roots — reading the rest of home still asks, because the denylist only covers credentials and tool config, not `.env` files or other projects' sources — and writes are never justified by "inside home" alone. The controller's own `search_files` is read-only and bounded by home (`ask` becomes a hard refusal, since the controller has no approval channel), and the claude-code worker's `canUseTool` routes through the same policy, closing the gap where its regex-only gate let denylisted paths through

**会话独占锁（同一 session 只允许一个实例）** — Two wayang processes resuming the same session used to append to the same `conversation.jsonl` concurrently and interleave unrelated turns. Each session directory now carries an atomic `.owner.json` (`pid` / `hostname` / `startedAt` / `heartbeatAt` / `token`) that the owning process refreshes every 20s and deletes on shutdown; a second process is refused with an explicit error naming the holder's pid and start time, and the client prints next steps (`--resume` to pick another session, `--new` to start a new one) instead of "server exited". A lock whose heartbeat expired (60s) or whose pid is gone is treated as a zombie and taken over, so SIGKILL/crash needs no manual cleanup. Sessions remain independent: different sessions still run in parallel — there is no global single-instance restriction

**add_task 附带目标 workspace 的规则摘要** — The controller's system prompt is built once and shared by every task, so a project's rules file could never live in it — with several workspaces that would leak one project's conventions into another project's work. The rules now travel with the dispatch: `add_task` appends a summary of the TARGET workspace's rules file to its own result, read fresh on every call (nothing cached) and looked up shallowly in that directory only, AGENTS.md before CLAUDE.md. The summary is capped at 40 lines / 2000 characters and its header names the source file, so it is always clear which project's rules were summarized. The read goes through the same permission policy: a file that exists but is denied or unapproved is reported as "unavailable" instead of being silently treated as missing

### Fixes

**窄终端状态栏按显示列排版** — Worker rows in the status bar were fitted by string length, so a double-width (CJK / fullwidth / emoji) task title counted as half its real width and a long row overflowed the terminal, pushing the elapsed time onto a second line. Row fitting now measures display columns (CJK = 2, combining marks = 0), the per-row label is capped by columns rather than code units, and under pressure the workspace slug is dropped first, then the label truncated, while the status and elapsed suffix is always preserved

### Breaking

**`--fresh` 改名为 `--new`** — `-n` and the behavior are unchanged; `--fresh` still parses and means the same thing, but it is no longer advertised in the help text's Options block (a "Deprecated" footer lists it instead). A duplicate `--new` in any spelling (`--new`, `--fresh`, `-n`, also inside a short group) is rejected

**权限命中 denylist 直接拒绝，不再弹审批** — A denylisted path used to reach the controller as an approval request; it is now refused outright, for workers and for the controller's `search_files`. Refusal messages name only the path the caller supplied — never which denylist entry matched, nor where a symlink points — so a refusal discloses nothing new. The claude-code worker's permission verdicts now come from the same policy as the puppet worker's, so its previously silent allowances for denylisted paths are gone

**跨 workspace 复用 idle worker 被拒绝** — A worker's workspace, cwd, permission boundary and the relative-path assumptions in its accumulated context are fixed at construction, so `add_task(assignToWorker=…)` into a different workspace now fails with an explicit "create a new worker instead" message rather than silently re-pointing the run at another directory. Multi-stage reuse within the same workspace is unaffected

**`--resume` 的失败条件变严格** — Resuming a session whose startup directory has since been moved or deleted now fails fast with a message (instead of adopting a nonexistent workspace and failing opaquely on the first restore dispatch), and resuming a session owned by another live process fails with the holder's pid and start time. Both cases print the next steps (`--resume` for another session, `--new` for a fresh one)

## v0.7.2 (2026-11-03)

### Fixes

**Ctrl+C 只退出，不再中止回合** — Ctrl+C now has a single meaning: quit. Previously, while a turn was running, every press aborted the turn and returned early without arming the quit window, so two presses could never exit (and with back-to-back turns the controller could stay busy indefinitely). Every press now arms the same 1s double-press window regardless of state: the first press shows the notice, the second within one second shuts down and exits. Aborting a turn is ESC's job alone. BREAKING: this changes behavior for anyone relying on Ctrl+C to abort a turn — use ESC instead

**注释与快捷键目录同步** — The Ctrl+C comment in render.ts, its render test, the controller-agent abort comments and the /shortcut catalog all still described the old busy→abort semantics. They now match the quit-only behavior: Esc is listed as the abort key and Ctrl+C is a single quit-only row in the session category

**LLM 失败不再只显示泛化错误** — When the provider rejected a request (e.g. gateway 403 "模型已下线"), the AI SDK swallowed the real error and the UI only showed the generic "No output generated. Check the stream for errors.", with the cause buried in wayang.log. The streaming loop now records the last provider error delivered via onError and, when the final awaits reject with the SDK's NoOutputGeneratedError, re-throws the recorded provider error instead (the generic one kept as its cause). Controller error entries in the TUI now show the formatted cause (e.g. `LLM API error: [403] 当前应用组 5203, 模型 … 已下线，请切换模型使用`) plus a `详情: <sessionDir>/wayang.log` pointer for full details; worker failed signals get the same treatment

## v0.7.1 (2026-11-03)

### Features

**CLI 短参数与严格参数校验** — Adds -v/--version and -h/--help (-r/--resume was already short). BREAKING: -v previously meant --verbose and now prints the version and exits; --verbose is long-only. Unknown options, missing values, boolean flags given a value, case variants and --no- forms now fail fast — error to stderr, help printed, exit code 1 — instead of being silently ignored

**输入框手动换行** — Ctrl+J and Alt+Enter insert a newline instead of sending, while Enter still sends. Terminals speaking the kitty keyboard protocol additionally deliver Ctrl+Enter as a newline. Newlines join the existing snapshot undo history like any typed character

**/shortcut 命令** — Lists every available key binding grouped by input editing, app and session, rendered from a single catalog shared with the implementation so the help text cannot drift from the real bindings

### Fixes

**ESC 中止 controller 回合** — ESC in the input area aborts the controller's current turn. The draft is preserved in every case; an active selection or an open suggestion panel consumes ESC first. Partial output is kept as one truncated message followed by an explicit interrupt marker, replayed to the model as [USER INTERRUPT]; a zero-output abort records only the marker

**工具执行期间中止不再丢失派发记录** — Aborting while the controller was running a tool dropped the finished step together with its tool calls and results, so a dispatched task vanished from the conversation and the interrupted turn was reported as cancelled. Steps completing before the interrupt record lands are now persisted, keeping task ids linkable

**Ctrl+C 归还应用层** — Ink's default exitOnCtrlC consumed Ctrl+C before the app saw it, so a single press quit regardless of state. Ctrl+C is now owned by the app: while a turn is running it aborts that turn; when idle the first press shows a "Press Ctrl+C again to quit" notice and a second press within one second exits

**get_worker_status 活动字段恒为空** — The tool resolved the transcript by the engine worker id (w-…), while transcripts live under the worker's own id (agent-… / cw-…), so every activity field came back null. It now resolves through memory, the persisted transcript id and id candidates, and exposes activitySource so "no activity" is distinguishable from "this worker type reports none"（Closes #28）

**TUI 活动 worker 条目** — A finished worker could linger on screen with a truncated task id and an ever-growing timer. Rows now prefer the task title with a documented fallback chain, disambiguate colliding labels, mark idle entries and count them from idleSince, and render elapsed time as 42s / 1m41s / 1h05m

**状态栏上下文占用去掉 ctx 前缀** — The context usage segment keeps the token counts and the percentage (e.g. `227.9k/1M (23%)`) and only drops the "ctx" label

### Refactoring

**eslint 存量告警清零** — 466 warnings (452 no-explicit-any, 14 no-unused-vars) reduced to zero. Implementation files received real types or per-line disables with reasons; test files get scoped overrides for the two type-loose rules only, with correctness rules still enforced

## v0.7.0 (2026-11-02)

### Features

**Controller 能读 worker 对话、能判断 worker 是不是卡住了** — Two new tools (issue #16): `read_worker_conversation` returns a worker's transcript — the live in-memory conversation while the engine still tracks it, the on-disk `conversation.jsonl` once it has ended or been cancelled, so finished and cancelled workers stay inspectable; `get_worker_status` reports `runningForMs`, `lastActivityAt` (+ how long ago), `currentTool`, `streamEnded`, `resultReceived` and `idleSince`, which makes a "finished but never released" worker visible instead of just silent. `chat_worker` now also says outright that `queued` is not delivery

**心跳与进度信号带上活动时间和当前工具** — `progress` and `heartbeat` signals now carry `lastActivityAt` and `currentTool`, so routine controller check-ins can tell a worker that is working from one that has gone quiet

**get_task_detail 分页与截断标注** — Task detail reads take `limit` (default 10 entries, counted back from the newest), `offset`, `maxChars` (per-entry cap, default 200) and `full=true`; truncation is always marked explicitly, the output is ordered oldest→newest, type filtering happens before pagination, and the meta line reports what was actually returned

**Puppet worker 注入 AGENTS.md 项目规则** — Rules from the project's rules file now reach the worker's system prompt: `findProjectRules()` walks up from the task workspace for at most 5 levels (never crossing a git root), checks `AGENTS.md` before `CLAUDE.md` in each directory, and injects the first non-empty hit as a `Project rules (<name>)` section with its source path, truncated at 8000 characters; no rules file means no section. Only puppet workers inject — Claude Code runs in isolated mode and never auto-loads `CLAUDE.md`, so nothing is duplicated

**inquire 增加「其他（自行输入）」** — Select-type questions auto-append a trailing `其他（自行输入）` choice (`allowOther`, default true) so a preset list is never a dead end; picking it swaps the list for free-form text input and the answer comes back prefixed with `[Other] ` so custom input stays distinguishable. `allowOther=false` keeps the list strict

**claude-code worker 记录工具调用与结果** — Tool activity is no longer dropped from worker conversations: `tool_use` blocks become `toolCalls` (id, name, arguments, status, timestamps) and `tool_result` blocks land as `toolResults` on the same entry (matched by id, error flags kept), buffered until the results arrive so text, calls and results land atomically; results are truncated at 2000 chars and arguments at 8000 with an explicit `... [truncated, N chars]` marker, and calls still unanswered at stream end are marked `cancelled`

**Controller 工作准则** — The controller prompt now spells out how to split tasks, separate design from implementation, run work in parallel safely, tell a busy worker from a stuck one, and verify changes before calling them done

**输入框完整编辑能力** — The input box now supports selection (Shift+arrows with reverse-video highlight), readline-style keys (Ctrl-A select all, Ctrl-E line end, Ctrl-K/U/W kill, Ctrl+←/→ and Alt+B/F word motion) and snapshot-based undo/redo (Ctrl-Z / Ctrl-Y, quick typing folds into one step). Multi-line paste, CJK width and surrogate pairs keep the existing rendering guarantees

### Fixes

**运行中读不到 worker 对话（engine id 与落盘 id 命名空间不一致）** — The transcript tools built disk paths from the engine's `w-…` id while `WorkerState` writes `conversation.jsonl` under the worker instance's own id (`agent-…` / `cw-…`), so the files were never found — not a persistence problem (entries are appended in real time) but an id mismatch. Reads are now layered (memory while tracked, disk after end, `meta.source` says which), tasks persist `workerTranscriptId` so finished workers stay locatable, the three failure modes (unknown worker / known but not locatable / empty transcript) are reported separately, a torn last JSON line is kept with complete entries plus an explicit `incompleteTail` note, and disk reads are tail-bounded (2 MB hard cap) instead of loading a whole 5000-entry transcript

**输入框多行粘贴渲染错乱（Closes #22）** — Terminals send pasted newlines as CR and Ink positions sibling text nodes per node, so a paste inserted literal `\r`, a mid-paste cursor scrambled the rows and long lines lost characters. Pasted newlines are now normalized to LF, the input renders one row per visual line pre-wrapped by display width (`stringWidth`, so CJK counts as two columns), the cursor block keeps its own row and the cursor/backspace step by code point so emoji are not split

**TUI 不再把无投递信息的消息标成「已送达」** — The chat_worker result row used to fall back to 已送达 whenever the delivery timing was unknown; it now shows 已排队 / 已送达 / 已发送 according to what the result actually says

## v0.6.3 (2026-11-02)

### Features

**心跳默认间隔 30s → 60s** — The controller's idle heartbeat now defaults to 60s instead of 30s (`heartbeatIntervalMs`), so quiet runs while workers are running get fewer routine check-ins

### Fixes

**修复：claude-code 消息打断投递致死（回归）** — The v0.6 interrupt delivery above was wrong: `interrupt()` during an in-flight tool call aborts the turn with an orphaned tool_use and the CLI kills the session with `error_during_execution` (`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`) — the same failure the permission PoC observed, mis-scoped to the permission window. Controller messages are now delivered ONLY at safe turn boundaries: they are handed to the SDK when it pulls the next prompt and the CLI queues them for the next turn (never mid-tool_use; `interruptOnMessage` removed). `run()` no longer stops at the first result, so a delivered message's follow-up turn is actually processed and the last result wins. Once a run's input has closed (final result in / aborted), `acceptMessage` fails, the engine reports a new `finished` delivery status, and `chat_worker` returns an explicit `[ERROR] … has already finished; message not delivered` instead of a fake "queued"; the `CHAT_WORKER` RPC now returns the delivery status instead of discarding it

**控制器补话消息在后续请求里重复出现（同一条始终是"最新" user 消息）** — Every step re-appended the injected list to the tail of the request, so the same `[Controller message]` was the newest user message in every later request and the model kept re-acknowledging it. Each message now records its arrival position and appears exactly once, pinned right before that step's assistant reply

**TUI 把仅排队的 chat_worker 消息标成"已送达"** — The delivery parse ran two independent checks and the `delivered` one won, while the queued result text says "QUEUED only, not delivered yet" — so a merely queued message rendered as 已送达. `queued` is now checked first (a queued result can never be misread), and tests cover the queued wording, the delivered wording, and a result that says neither

## v0.6.2 (2026-11-02)

### Fixes

**用户消息背景不超出内容宽度** — A user message's background band spanned the whole terminal instead of following the content width, which looked wrong while streaming. The band is now sized to the content, so it grows with the text and stops at the content width

## v0.6.1 (2026-11-02)

### Fixes

**claude-code 在 result 到达时关闭 stream** — The claude-code stream was closed only when the child process exited, so a finished turn stayed open and the engine kept waiting for the exit. The stream is now closed as soon as the result arrives, and the process exit no longer gates delivery

**streaming 期间 pending 消息独占一行** — A pending (not yet sent) user message was rendered on the same line as the in-flight assistant text while streaming, garbling both. Pending messages now take their own line until they are sent

## v0.6.0 (2026-11-02)

### Features

**Worker → Controller 阻塞式提问(全新能力)** — Workers stuck mid-task can now call `ask_controller` and block for the controller's answer (5-minute timeout, then they continue on their own judgment — with an `inquiry_timeout` signal telling the controller). The controller answers via the new `respond_inquiry` tool or the `respond_worker_inquiry` RPC command; questions render as structured TUI rows (`? 提问 #xxxx` → `✔ 已答复 #xxxx`). Puppet workers get the tool directly; Claude Code workers get it as a real in-process SDK MCP tool (`createSdkMcpServer`), with `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` raised so a 5-minute block survives the SDK's 60s MCP default

**Controller → Worker 补话时效(2a)** — `chat_worker` messages now reach a running puppet worker at its **next LLM step** via the AI SDK `prepareStep` hook (injected as `[Controller message]` user messages, each recorded at its arrival position and appearing exactly once in the conversation — pinned right before that step's assistant reply — and persisted into the worker's conversation so they survive compaction rebuilds and multi-stage handovers). `check_controller_messages` is deprecated (stub kept one minor version). Claude Code workers get queued messages handed over at the next safe turn boundary instead of interrupting the current turn, and idle-period messages are folded into the next stage's opening prompt

**工程** — Shared `BlockingRequestMap` abstraction (pending map + timeout + cleanup, duplicate-id rejection) backs the permission, Claude Code permission, and inquiry flows alike; the claude-code child env is a spread of `process.env` plus the timeout override (the SDK replaces the env wholesale); new signals `worker_inquiry` / `inquiry_timeout` / `message_undelivered` with controller-side converters and TUI rows; ask_controller Q&A lands as audit entries in claude-code worker conversations; late answers to aborted inquiries report `worker_gone` via id tombstones instead of a misleading "timed out"; PoC scripts `scripts/poc-interrupt-permission.mjs` / `scripts/poc-mcp-timeout.mjs` for the two unproven SDK behaviors (run locally with a real claude CLI); design doc `docs/develop/v0.6-design.md` (reviewed, WAY-N moved out of this version)

### Fixes

**修投递"说谎"** — `sendMessageToWorker` now judges delivery by the activeWorkers runtime state instead of the workers Map, closing the `setTimeout(0)` disposal window where a message was accepted for a dying worker while `chat_worker` reported success; unread messages at run end (or idle-worker disposal) are reported back via a `message_undelivered` signal instead of vanishing — including the Claude Code "task finished before reading" case that used to flush the queue silently

## v0.5.2 (2026-10-30)

### Features

**Context usage in the TUI** — The status bar now leads with a persistent context segment (`ctx 6.4k/256k (3%)`), turning yellow from 70% and red from 90%. New `/context` slash command prints a breakdown of the prompt by group (system prompt, user, assistant, tool calls, tool results, compact summary) next to the provider-reported usage of the last step, fetched from the server on demand

**Structured action rows** — Permission requests render as `• 权限申请 <tool> <target>` with the asking worker and a `#xxxx` request handle on a secondary line; descriptions that only restate the args are dropped. Resolutions look the original request up by id and read `✔ 已批准 <tool> <target> #xxxx` (or `✘ 已拒绝` with the reason) instead of a bare id. `chat_worker` calls render as `✉ 发送给 <worker>` with delivery state and a message preview; `add_task` calls render as `⊕ 派发任务 <title>` (or `↻ 续派任务` when reusing an idle worker) with worker type, priority and multi-stage flags, marked `✔ 已派发` once dispatched. The paired tool results of these calls are folded into the row

**Per-provider context window** — New optional `providers.<name>.contextWindowTokens` declares the model's context window (input side; distinct from the protocol's `max_tokens`, which caps output). Controller compaction triggers at 90% of it. The default rises from 100k to 256k — **providers serving smaller-window models (e.g. 128k) should set it explicitly**, otherwise compaction will not trigger before the provider rejects the request. The onboarding wizard now asks for it, env-only setups can use `WAYANG_CONTEXT_WINDOW_TOKENS`, and config validation rejects anything but a positive integer. Workers do not compact yet, so the value only affects the controller

### Reliability

**LLM idle watchdog** — An LLM call that makes no progress (no text chunk, no step finish) for 5 minutes is aborted and surfaced as an `LLM call idle timeout` error instead of leaving the controller busy forever. Observed root cause: the proxy accepted a large request and then hung it silently, so the TUI stayed on the loading spinner until the process was killed. The watchdog is paused while a tool is executing — including waiting for a permission approval or a user's `inquire` answer — so slow approvals are not misread as a hung provider. It uses a per-call abort controller, so the long-lived agent stays reusable after a timeout

**Compaction driven by real usage** — The provider-reported `inputTokens` of the latest step now feeds the compaction check (`max(estimate, reported)`), so compaction triggers even when the local estimate undercounts. On restore the check is seeded with the last real usage recorded after the latest compaction, so the cold-start compaction check sees real numbers. A successful compaction is now logged (`Compaction done`), and the status bar / `/context` refresh right after a compaction instead of on the next step

### Fixes

**Token estimate ignored tool payloads** — The local estimator stringified SDK message content arrays (`"[object Object]"`), so tool-call arguments and tool results — usually most of an agent prompt — were not counted. Estimates were far too low, the estimate-based compaction check almost never fired, and `/context` showed a usage total far below its own breakdown. Array content is now read part by part, so the estimate and the breakdown agree

**Compaction fallback kept truncating** — When summarization failed, the half-truncation fallback left a stale real-usage mark (so every loop judged the context full and cut history again) and an out-of-range verbatim index (so, after an earlier successful compaction, no recent history was sent at all). Truncation now goes through the context manager, which clears the mark and shifts the index

**Compaction summary sent twice** — After a compaction the summary was placed both in the system prompt and as a system message at the head of the messages, so every request carried two copies. It now lives only in the system prompt; `/context` counts it once, as sent

**Summaries missed tool activity** — The summarizer input kept only the first 300 characters of each entry's text, so tool-only steps (empty text) contributed nothing: the summarizer never saw which commands ran, which tasks were dispatched or what came back. Each step now lists its tool calls as `→ tool(args) ← result` (errors marked), signals carry their task / worker tag, and heartbeats, compaction markers and `skip_reply` are left out. The input is budgeted against the context window — per-field caps shrink first, and only then are the oldest entries dropped, with a note

**Undeterminable approvals shown as denied** — A `respond_permission` call whose outcome cannot be parsed now renders as `? 结果未知` instead of a red `✘ 已拒绝`

**Slash command failures** — A slash command whose RPC fails (e.g. `/context` after the server died) now shows `Command failed: …` instead of an unhandled rejection that could take the TUI down

**Empty thinking rows** — Whitespace-only reasoning or content (emitted by some providers on pure tool-call steps) no longer renders an empty `thinking:` row

**Lingering lint error** — Hand-run `.mjs` fixture generators under `src/**/__tests__/fixtures/` are excluded from eslint (the project service cannot resolve them without `allowJs`); any other `.mjs` under `src/` is still linted

### Refactoring

`ContextManager.maxTokens` / `ContextUsage.maxTokens` renamed to `contextWindowTokens` to avoid confusion with the OpenAI-protocol `max_tokens`. The stream watchdog option is named `llmIdleTimeoutMs`, distinct from the `idleTimeoutMs` config field (multi-stage worker reaping). Shared display-width and token-count formatting helpers extracted to `src/tui/utils/`. README worker `toolChoice` docs corrected (the default has been `auto` since 0.5.0)

## v0.5.1 (2026-10-30)

### Architecture

**Conversation envelope** — `conversation-envelope` is now the single source for entry versioning, `parentId` chaining and compaction-boundary rules. Agent entries carry turn lineage (`turnId`, `rootTurnId`, `causationId`, `actor`) and step timestamps

**Tool call recording** — New `tool-call-recorder` tracks each tool execution's start, end, status and duration by `toolCallId`, merged into the persisted `ToolCallRecord` / `ToolResultRecord` when the assistant entry is built

**Conversation module** — New `src/services/conversation`: `conversation-index` groups entries into turns in memory (with backfill rules for legacy entries without `turnId`), and `turn-serialize` produces JSON-safe turns for the RPC layer; `wayang-server` and the RPC protocol are extended accordingly

### Testing

New and updated suites for the conversation envelope, entry envelope, tool call recorder, context manager and server conversation APIs; the resume e2e scenario is extended

## v0.5.0 (2026-10-28)

### Architecture

**Headless logic process (`wayang server`)** — The orchestration core (Supervisor, ControllerAgent, TaskExecuteEngine, SignalQueue, SkillRegistry) now runs in a separate process with zero ink/react dependencies. `wayang` spawns the server as a child and connects over stdio; interactive UX (onboard, session select) stays in the client process. E2E tests drive the exact binary + protocol the TUI uses

**RPC v1 (`src/rpc/`)** — Transport-agnostic protocol over newline-delimited JSON on stdio. Command surface: `submit_input`, `resolve_inquiry`, `list_tasks`, `cancel_task`, `update_task`, `respond_permission`, `chat_worker`, `dispose_worker`, `perform_compaction`, `abort_controller`, `get_status`, `get_snapshot`, `subscribe`, `unsubscribe`, `shutdown`. State surface: per-path subscriptions where every event carries the full value at the subscribed path (idempotent client-side cache, snapshot returned on subscribe). WebSocket transport reserved for the 0.6 WebUI

**TUI slimmed to a thin client** — New `RemoteSupervisor` (`src/client/`) presents the same consumption surface over RPC. Removed worker-list overlay, worker-detail page and routing; `/workers` is now a text listing; slash commands became async. The TUI keeps basic conversation, `/tasks`, approval/inquiry prompts

### Features

**Worker `toolChoice` configuration** — New `worker.toolChoice` config field (`auto` | `required` | `none`) forwarded to the provider's `tool_choice`. Defaults to `auto` — thinking endpoints (DeepSeek/GLM) reject `tool_choice: "required"` with HTTP 400 ("Thinking mode does not support this tool_choice"), so forcing tool calls cannot be the universal default; the worker system prompt already instructs finishing via `done`/`fail`, and a text-only final turn still completes the task. LLM stream errors (HTTP 400/403, aborts) are now surfaced through an `onStreamError` hook and logged instead of being silently dropped by `textStream`

### Reliability

**Atomic state persistence** — JSON persistence writes go through a temp file + rename, so a crash mid-write can no longer truncate state files. Signal state is split into an append-only event log plus a compact `signals.json` snapshot carrying an id high-water mark; the signal window is trimmed to 2000 entries by default to bound file growth. Corruption is now reported explicitly instead of silently resetting state, and a one-shot migration upgrades legacy sessions (covered by a real-session fixture)

**RPC transport hardening** — `LineCodec` (pure framing) is split from `createTransport` (framing + dispatch + terminal events), and `createDuplexTransport` lets a future socket transport reuse framing without touching RpcServer/RpcClient. Transport capabilities (incl. `privateChannel`) are declared explicitly, making the stdio-pipe vs named-endpoint distinction readable in code. Close on either side is now a terminal transition — a SIGKILLed peer fails all in-flight and subsequent requests instead of leaving them pending forever

**In-memory session index** — New `SessionIndex` (list/get/latestForWorkspace/upsert/invalidate) with workspace filtering, archived exclusion and cursor paging. The index lives purely in memory — no shared index file is ever written, so concurrent instances cannot clobber each other. `SessionMeta` gains optional `title`/`archived`/`archivedAt` plus `sessionDisplayTitle` (explicit title, else first input), and `SessionManager` exposes `rename`/`setArchived` persisted to `meta.json`

### Testing

**E2E framework** — Fake OpenAI-compatible provider (`src/__tests__/fake-openai-provider.ts`) replaying scripted SSE with content-based matching (immune to controller/worker request races); harness spawning `dist/cli.js server` and driving it over RPC; four scenarios: single-task full chain, permission approval (chmod intercepted → approved via RPC → really executed), multi-stage worker reuse (same workerId across stages), and resume across server restarts (a second server spawned the way the TUI client spawns it must find and restore the session)

**Unit/integration** — New suites for rpc transport/server/client (in-memory stream pairs), WayangServer-over-RPC (in-process, fake provider), session index, client connect, bootstrap, and state persistence (atomic write, JSON/JSONL corruption handling). A spawn-level suite drives the built CLI binary directly: ready handshake, RPC round trip, notification stream, shutdown exit code, SIGTERM, resume failure and abrupt kill. Totals: 425 unit tests + 4 e2e scenarios

**CI (GitHub Actions)** — lint + unit + build + e2e on every push and pull request, with dependency installs pinned to the official npm registry

### Fixes

**Assigned-task invisibility** — Tasks dispatched straight to an idle multi-stage worker were never recorded in `running`/`history` (`moveToRunning` no-ops on the pending-list miss), so they executed and signalled but stayed invisible to `list_tasks` and every view. `assignToExistingWorker` now appends to `running` directly; regression-covered by unit + e2e tests

**bash tool error detail** — Non-zero exits with empty stderr (spawn failures, timeout kills) now include the thrown message instead of a bare `Exit code 1`

**Pre-existing lint errors** — `no-useless-escape`, `no-empty`, `prefer-const` fixed so the new CI lint gate can land

**`--home-dir` double pathing** — The client pre-joined `.wayang` before passing `--home-dir`, and the server joined `.wayang` again, putting sessions under `<home>/.wayang/.wayang` and breaking `--resume`. `--home-dir` is now treated as a root everywhere: bootstrap passes the root and the server resolves `.wayang` itself, so a resumed server finds the session. Covered by bootstrap/connect unit tests and the resume e2e scenario

**Permission-rule false positives** — The bash permission extractor matched any `/word` substring, so `src/cli.ts` was read as the absolute path `/cli.ts` and URL path components as local paths — nearly every worker command referencing a sub-path or URL (`git diff ... src/types/config.ts`, `curl https://...`) demanded approval. Rules extracted to `permission-rules.ts`: URLs are stripped first, only whole shell words starting with `/` or `~` count as path candidates, and `~` is expanded for both bash and file tools (also fixes `~/...` paths bypassing the file-tool gate). Verified against a live reproduction from a failing session

**Thinking-model reasoning passthrough** — `@ai-sdk/openai` silently discarded `reasoning_content` from thinking models (e.g. `deepseek-flash`), so reasoning was never persisted and never replayed; DeepSeek rejects requests with HTTP 400 (`The reasoning_content in the thinking mode must be passed back`) once replayed history contains assistant messages without it, which bricked the controller loop after the first tool-calling turn. Model factory switched to `@ai-sdk/openai-compatible` (parses `reasoning_content` from responses and re-sends it on replay), `buildAssistantEntry` captures per-step reasoning with a reasoning-parts fallback, and `conversationToSdkMessages` emits the reasoning part on replay — including a non-empty placeholder for steps where the model skipped thinking, detected per conversation (a thinking endpoint rejects the replay even if a single assistant message lacks the field). Verified end-to-end against the live DeepSeek endpoint. Sessions saved before this fix have no stored reasoning and remain unrecoverable on such endpoints — start a fresh session

### Documentation

Added v0.5 design doc (`docs/v0.5-server-rpc-design.md`) and the 0.5→1.0 roadmap (`docs/roadmap-0.5-1.0.md`); renamed `CLAUDE.md` to `AGENTS.md`

### Dependencies

Swapped `@ai-sdk/openai` for `@ai-sdk/openai-compatible` (2.x line — matches the `ai` v6 LanguageModelV3 spec; the 3.x line emits spec v4 and requires node ≥ 22) to gain `reasoning_content` support for thinking models

## v0.4.1 (2026-07-02)

### Fixes & Improvements

**AI SDK system-in-messages warning** — `streamText` now passes `allowSystemInMessages: true`. Worker signals are emitted as `system`-role messages inside `messages` (in-band, order-sensitive notifications from the orchestration system), but AI SDK ≥6.0.x warns that any system message in `messages` may be a prompt-injection risk unless explicitly opted in. Our signals are trusted system-generated content, so opting in is the correct and intended usage — preserving the `system` semantics and conversation ordering without rewriting the converter

### Dependencies

Pinned `ai` to `^6.0.218` (dev environment previously resolved 6.0.149, which predates the system-message guard; aligning dev with the released version that surfaces the warning)

## v0.4.0 (2026-07-01)

### Features

**Skill support** — New `SkillRegistry` (services/skills/) discovers Anthropic-style `SKILL.md` packages (frontmatter + optional resources) from global, project, and config dirs at startup, with lazy content loading and in-memory cache. Adds `use_skill` tool shared across Controller and Puppet Worker; Claude Code Worker reaches skills via the prompt catalog (it has no Wayang tools). `SkillRegistry` is owned by Supervisor and injected into agents/engine to keep `SystemContext` stateless. New optional `skillsDirs` field on `WayangConfig`

**Multi-stage worker persistence** — `TaskExecuteEngine` gains idle worker state with `assignToExistingWorker` dispatch path that reuses the worker instance and context across stages. Idle workers are reaped after a TTL (default 30min, configurable via `idleTimeoutMs`), count against `maxConcurrency`, and are disposed on shutdown. `add_task` now accepts `multiStage` + `assignToWorker` fields; new `dispose_worker` tool for explicit teardown. Controller prompt updated with multi-stage/assign/dispose guidance

**Per-workspace sessionless controller** — Default CLI behavior now inherits the latest session for the current workspace (per-workspace isolation, not a global stream); new `--fresh` flag starts a clean session. Cold-start compaction runs before the loop on resume, and a `previous_session_tasks` signal surfaces unfinished work so the controller decides whether to re-dispatch (workers are NOT auto-resumed). Explicit `--resume` continues the exact session without re-surfacing stale tasks

**TUI idle-state awareness** — Worker list/detail now distinguish running vs idle and display the last stage

### Fixes & Improvements

**Idle-worker dispose signal semantics** — Dedicated `cancelled` converter renders idle-worker disposal as `WorkerDisposed` instead of `WorkerFailed` + raw JSON, since its taskId points at an already-completed stage

**Multi-stage reentry fix** — `ClaudeCodeWorker` resets `_terminalResult` on `run()`, fixing the multi-stage reentry bug (SDK single-session limitation documented)

**`readSessionUnfinishedTasks` hardening** — Task status now tagged by bucket (not raw field) with malformed entries filtered out

### Documentation

Added long-running Worker & Sessionless Controller design doc, aligned with the implemented per-workspace + multi-stage plan (resolved decisions table, implemented tool choices)

Added research document on Multica's Workspace-Project-Issue model for future reference

### Dependencies

Added `yaml` for SKILL.md frontmatter parsing

### Tests

+15 for engine lifecycle and session resolution; SkillRegistry discovery/override/cache and `use_skill` tool coverage

## v0.3.0 (2026-04-19)

### Features

**Controller ↔ Worker communication** — Added `chat_worker` tool for controller to send messages to running workers; `check_controller_messages` tool for workers to receive controller guidance during execution

**Permission system** — New middleware layer intercepting worker operations that require controller approval before execution. Supports bash commands, file access outside workspace, and Claude Code Worker permissions via `respond_permission` tool

**Bash permission check (upgraded)** — Two-tier detection: dangerous commands (rm, sudo, chmod, etc.) always require permission; commands referencing absolute paths outside workspace also trigger permission requests

**File tool permission check** — File tools (read_file, write_file, edit_file, search_files, search_content) trigger permission request for workspace-external paths instead of hard-rejecting. Workspace-internal access passes through directly

**Tool selection priority** — Worker prompt now explicitly instructs preferring dedicated file tools over bash equivalents (read_file > cat, write_file > cp/tee, search_files > find, search_content > grep)

### Refactoring

**Path access control centralization** — Moved path validation from individual tool implementations to the permission middleware layer; removed `validatePath` in favor of `isInsideWorkspace` boolean helper

**Permission strategy extraction** — Extracted `needsBashPermission` and `needsFilePermission` as module-level strategy functions with `FILE_TOOL_NAMES` constant for maintainability

**ClaudeCodeWorker permissions** — Integrated with permission middleware via `@anthropic-ai/claude-agent-sdk`'s `PermissionResult` handling

### Fixes & Improvements

Worker prompt updated to discourage bash for file operations when dedicated tools are available

Added workspace-external path detection for bash commands to prevent `cp`/`mv` bypass of file tool permission checks

Removed dead `validatePath` code after migration to middleware layer

## v0.2.0 (2026-04-16)

### Features

**Inquiry system** — Added notebook and user interaction tools for agent-to-user communication

**Puppet worker tools** — New edit_file, search_files (glob), search_content (text search), and web_search (Tavily API) tools

**LifecycleHooks** — Replaced EventBus with type-safe system-level lifecycle event management

**WorkerAgent finish tracking** — Added finish reason and step count to StreamLoopResult; TUI worker detail page now shows task completion status

**HeartbeatProvider** — Refactored ControllerLoop to use heartbeat-driven signal processing

### Refactoring

**SystemContext integration** — Encapsulated provider configs and concurrency settings; simplified ControllerAgent/WorkerAgent access to logger and config

**TaskPool cleanup** — Removed obsolete task pool and scheduler tests; streamlined scheduling implementation

**TUI adaptation** — Updated components to use the new Supervisor structure

### Fixes & Improvements

read_file tool now supports line numbers and truncation

Improved skip_reply tool description clarity

Adjusted TUI animation timing

Enhanced WorkerAgent logging for step completion and max steps reached scenarios

### Dependencies

Added fast-glob for file search

Integrated Tavily API key into config (optional)

### Features

**Controller ↔ Worker communication** — Added `chat_worker` tool for controller to send messages to running workers; `check_controller_messages` tool for workers to receive controller guidance during execution

**Permission system** — New middleware layer intercepting worker operations that require controller approval before execution. Supports bash commands, file access outside workspace, and Claude Code Worker permissions via `respond_permission` tool

**Bash permission check (upgraded)** — Two-tier detection: dangerous commands (rm, sudo, chmod, etc.) always require permission; commands referencing absolute paths outside workspace also trigger permission requests

**File tool permission check** — File tools (read_file, write_file, edit_file, search_files, search_content) trigger permission request for workspace-external paths instead of hard-rejecting. Workspace-internal access passes through directly

**Tool selection priority** — Worker prompt now explicitly instructs preferring dedicated file tools over bash equivalents (read_file > cat, write_file > cp/tee, search_files > find, search_content > grep)

### Refactoring

**Path access control centralization** — Moved path validation from individual tool implementations to the permission middleware layer; removed `validatePath` in favor of `isInsideWorkspace` boolean helper

**Permission strategy extraction** — Extracted `needsBashPermission` and `needsFilePermission` as module-level strategy functions with `FILE_TOOL_NAMES` constant for maintainability

**ClaudeCodeWorker permissions** — Integrated with permission middleware via `@anthropic-ai/claude-agent-sdk`'s `PermissionResult` handling

### Fixes & Improvements

Worker prompt updated to discourage bash for file operations when dedicated tools are available

Added workspace-external path detection for bash commands to prevent `cp`/`mv` bypass of file tool permission checks

Removed dead `validatePath` code after migration to middleware layer
