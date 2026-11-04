# 权限策略实施拆解（0.8.1）

范围：issue #24 全部 + issue #35 的一小部分（敏感列表命中不再硬拒，改为触发 controller 审批）。
基线：`release/0.8.1`，version 0.8.1。#35 的专用工具脱敏（原 Phase 3）与 OS 级隔离不在本轮。

> **0.8.4 变更**：本文中「敏感命中的写方向 = 硬拒」的表述已被取代。写方向不再直接 `deny`，改为与读方向一样走 controller 审批（`ask`）；`matchedRule` 统一为 `sensitive-list`，读写方向由 `access` 字段区分。只有 `sensitiveMode: 'deny'` 仍然是"不问直接拒"。不变量改为：**敏感列表仍优先于一切 allow 规则，任何路径都不会因为敏感而被自动放行；但敏感命中不再"不可审批"**。
>
> **0.8.4 新增**：任务级审批记忆（#46，C.7 的最小可用子集）已落地，见 C.9 —— 只记忆读方向、按规范化路径、按任务失效；写方向与敏感命中永远一次一批。开关 `permission.approvalMemory: 'task' | 'off'`（默认 `'task'`）。
>
> 以下 0.8.1 的历史记录保持原样，不再逐句改写。

## A. 目标与非目标

### 目标

- 减少 controller 审批次数：典型只读任务（`ls` / `cat` / `grep` / `stat` / `date`，路径在 workspace 内）接近零审批。
- 判定可分类：bash 从"路径越界即问"升级为"先判命令语义（只读 / 写），再判路径"。
- 判定可解释：每次 `ask` 的审批请求带命中规则、命中条目、规范化后的目标路径、操作类型。
- 判定可记忆：一次批准可以按 `once` / `task` 两种粒度生效，deny 不可被 grant 覆盖。
- 敏感列表（原 denylist）命中改为审批：展示命中条目与目标路径，批准后可读原文，拒绝不泄露内容，批准/拒绝都审计。
- 判定可观测：审批次数、命中规则分布、被拒次数可统计，且不污染业务输出（不打印到 worker 输出、不注入业务信号）。
- 两个 worker 入口（puppet 的 permission middleware、claude-code worker 的 `handleCanUseTool`）共用同一份判定、记忆与审计实现，不再各有偏差。

### 非目标（本轮明确不做）

- 不做敏感内容脱敏投影：批准后 API key / token 允许进入上下文与 transcript。用户已明确接受该取舍；边界是"不读与本任务无关的内容"，不是"读到了也要打码"。
- 不实现 #35 Phase 3 的专用只读工具（`inspect_config` / `read_config`）与键名正则脱敏。
- 不做 OS 级进程隔离（seatbelt / bwrap / landlock）。
- 不引入通用 shell 解析器依赖（不新增 `shell-quote` / `bash-parser` 之类的运行时依赖）；只实现最小词法器，解析不确定一律 `ask`。
- 不改变 controller 自身 `search_files` 的边界：它没有审批通道（人类是审批者，但 0.8.1 没有面向 controller 发起审批的 UI/RPC 链路），因此对它而言 `ask` 仍然等于拒绝。controller 读敏感文件的能力留作后续 issue。
- 不改 `/tasks` 的截断与 20 条预算（#39 已完成，与本轮无关）。
- 不把 grant 持久化：审批记忆是本进程运行时状态，重启 / `--resume` 后重新开始（避免"上次批准过"变成静默的长期放行）。
- 不改 `add_task` 的 `allowedDirs` 校验语义：把敏感目录整体授予一个任务仍然硬性拒绝（这正好违反"不读与本任务无关的内容"）。

## B. 分 PR 计划

每个 PR 都能独立通过四道门槛：`npm run lint`（tsc + eslint）、`npx vitest run`、`npm run build`、`e2e/scenarios/permission.test.ts` 相关场景；每个 PR 都能单独 `git revert` 而不牵连后一个。

### PR1：sensitiveList 命中改 ask + 审计（含改名与配置键兼容）

改动文件与函数

- `src/infra/permission/policy.ts`
  - 表改名：`DEFAULT_DENIED_RELATIVE_PATHS` → `DEFAULT_SENSITIVE_RELATIVE_PATHS`；`SENSITIVE_SEGMENTS` 与 `SENSITIVE_FILENAMES` 合并为一张 `SENSITIVE_NAME_SEGMENTS`（文件名就是段名，没有独立语义）；`.docker/config.json` 的成对规则保留为 `SENSITIVE_SEGMENT_PAIRS`。
  - 新增 `defaultSensitivePaths(homeDir)`（原 `defaultDeniedPaths` 保留为薄别名一个版本，供 `add-task.ts` 过渡）。
  - 新增 `matchSensitiveEntry(absPath, sensitivePaths): string | undefined`，返回命中条目本身（例如 `.ssh`、`.docker/config.json`），而不是 boolean；原 `isSensitiveSegmentPath` / `isDenied` 改为在它之上实现，语义不变。
  - `AccessMode` 扩展为 `'read' | 'write' | 'unknown'`：`unknown` 表示"命令语义未知"（bash 默认），作用域按写判、敏感性按读判。
  - `MatchedRule` 的 `'denylist'` 改为 `'sensitive-list'`；`DecideAccessResult` 增加 `matchedEntry?: string` 与 `access?: AccessMode`。
  - `decideAccess` 规则 1 拆成两段：敏感命中时 `access === 'write'` → `deny`，`access === 'read' | 'unknown'` → `ask`。其余规则（2..7）顺序不变；规则 6 `read-within-home` 只对 `access === 'read'` 生效，`unknown` 不吃这条（保留 bash 的严格性）。
- `src/services/tools/permission-rules.ts`
  - `denyMessage` 文案从 "deny list" 改为 "sensitive list"；仍然只回显 worker 自己给的路径，不回显命中条目（拒绝不泄露）。
  - `evaluateBashAccess`：候选路径的判定模式从"一律 `write`"改为"`unknown`，除非该候选出现在写动词片段里则为 `write`"。为此引入最小写动词表 `BASH_WRITE_VERBS`（`rm rmdir mv cp ln tee dd chmod chown truncate install mkdir touch sed -i perl -i find -delete` 等），PR3 会把它并入完整分类器。
  - `evaluateFileAccess`：读写不变，`write_file` / `edit_file` 打敏感路径仍是 `deny`（见 C.4）。
  - `ToolAccessDecision` 增加 `access?: AccessMode`、`matchedEntry?: string`、`resolvedPath?: string`，供审批请求与审计使用。
- `src/services/permission/permission-gate.ts`（新增）：把"判定 → 记忆查询 → 发 permission_request → 等答复 → 审计 → 返回裁决"合成唯一实现，puppet middleware 与 claude-code worker 都调用它。
- `src/services/permission/audit-log.ts`（新增）：`PermissionAuditLog.append(entry)`，写 `<sessionDir>/permission-audit.jsonl`（复用 `JSONLFileHelper`，与 `conversation.jsonl` 同一落点约定）。
- `src/services/tools/permission-middleware.ts`：内联判定逻辑改为委托 gate，`permission_request` 载荷补新字段（C.5）。
- `src/services/agents/claude-code-worker.ts`：`handleCanUseTool` 与 `requestPermission` 改为走 gate，保证 payload 与审计和 puppet 完全一致。
- `src/services/task-execute-engine.ts`：`wireWorker()` 里为每个 task 构造一个 gate（含 grant/deny 记忆与审计实例），`accessScope` 原样传入；`permissionResolvers` 的 `resolvePermission` 签名增加可选 `scope`（PR1 只接受 `once`，PR4 启用 `task`）。
- `src/types/signal.ts`：`PermissionRequestSignalPayload` 增字段。
- `src/types/config.ts`：`PermissionConfig` 增加 `sensitiveDirs`，`deniedDirs` 标 `@deprecated` 但仍读取；新增可选 `sensitiveMode?: 'ask' | 'deny'`；`validateConfig` 同时校验两个键。
- `src/services/tools/add-task.ts`：改用 `defaultSensitivePaths` / `matchSensitiveEntry`，拒绝文案改成"sensitive list"；语义不变（硬拒）。
- `src/services/tools/search-files.ts`：`deny` 分支改为"敏感列表命中 → 拒绝"；`ask` 分支文案保持"超出 home 边界"。因为它没有审批通道，`ask` 等于拒绝，但审计里要记一条 `ask-unavailable`。
- `src/tui/utils/permission-summary.ts`：审批行副标题展示 `命中条目 + 目标路径 + 操作类型`（纯展示层，来自新 payload 字段）。

判定语义变化

- 敏感路径只读：`deny` → `ask`（一次审批，批准后可读原文）。
- 敏感路径写：仍是 `deny`，不出请求。这是本轮最重要的边界（见 C.4）。
- 敏感路径 + bash 且命令是写动词：仍是 `deny`（`rm -rf ~/.ssh`、`tee ~/.ssh/authorized_keys`）。
- 敏感路径 + bash 且命令是读（`cat ~/.ssh/id_rsa`）：`deny` → `ask`。
- 其他一切（作用域判定、`read-within-home` 的降级、URL/相对路径不抽取）不变。

对现有测试的影响

- `src/services/tools/__tests__/permission-rules.test.ts`
  - "denylist is a hard deny and outranks every allow" 组：`cat ~/.ssh/id_rsa` 类用例期望改为 `ask`（读取语义），`rm -rf ~/.ssh`、`tee ~/.ssh/authorized_keys` 保持 `deny`（写动词）。理由：这正是 #35 的产品决策，且"写仍硬拒"保证不变量"高危操作不出请求"仍成立。
  - 组标题与 `matchedRule` 断言改为 `'sensitive-list'`。
  - `~user and shell constructs` 组里 `cat $HOME/.ssh/id_rsa → deny` 改为 `ask`；`rm` 变体新增一条保持 `deny`。
  - "anchor-independent denylist" 组：`read_file` 读 `<realHome>/.ssh/id_rsa` 由 `deny` 改为 `ask`，并新增 `write_file` 同一路径仍 `deny`。理由：锚点无关匹配规则本身不变，变的只是"读命中后的处置"。
- `src/infra/permission/__tests__/policy.test.ts`
  - `decideAccess: denylist wins over every allow rule` 组：`access: 'read'` 的用例改为断言 `ask` + `matchedRule: 'sensitive-list'` + `matchedEntry`；补 `access: 'write'` 与 `access: 'unknown'` 的对照用例，把不变量重写为"敏感命中优先于一切 allow：读/未知 → ask，写 → deny"。
  - `anchor-independent sensitive segments` 组：断言由 `deny` 改为按 access 分叉（读 `ask` / 写 `deny`），`matchedEntry` 断言补齐。
- `src/services/__tests__/task-execute-engine-permission.test.ts`
  - 5 / 5b / 6 / 7a / 7b 组：写路径的用例保持"拒绝且不发 permission_request"；读路径的用例改成"发一次 permission_request → 拒绝则报错、批准则执行"（新增 4a 风格的对照）。7a 用 `cat` 的话要换成写动词或补一条读用例。
- `e2e/scenarios/permission.test.ts`：该场景是 `chmod`（写动词、非敏感），不受影响；新增一个场景：`cat ~/.ssh/id_rsa` → 一次 `permission_request` → 批准 → 输出包含原文 → 审计文件出现一条 allow 记录。

新增测试清单

- `policy.test.ts`：敏感命中在 read/unknown/write 三种 access 下的裁决；`matchedEntry` 精确性（`.ssh` 命中 `.ssh`，不命中 `.sshfoo` / `.SSH`）；`.docker/config.json` 成对规则在 ask 模式下仍带条目名；`unknown` 不吃 `read-within-home`。
- `permission-rules.test.ts`：读动词 + 敏感路径 → `ask`；写动词 + 敏感路径 → `deny`；混排命令（`cat ok.txt && tee ~/.ssh/authorized_keys`）→ `deny`。
- `permission-audit.test.ts`（新增）：批准写一条、拒绝写一条、超时按拒绝写一条；字段齐全（路径、命中条目、taskId、时间、操作类型、决策）；文件内容绝不出现；append 失败时批准路径返回拒绝（fail-closed）。
- `task-execute-engine-permission.test.ts`：敏感读批准后原样读到内容；拒绝后错误信息不含内容也不含命中条目；同一路径再读会再问一次（PR1 没有记忆）。
- `config.test.ts`：`sensitiveDirs` 与 `deniedDirs` 同时存在时合并去重；只写 `deniedDirs` 时仍生效并打一条 deprecation warn。

回滚风险

- 低：policy 与 rules 各自是纯函数，回滚只需还原两个文件 + payload 字段（payload 新增字段是可选的，回滚后旧字段仍在，不会破坏反序列化）。
- 唯一需要留意的部分：审计文件在回滚后会停止写入（不会写坏已有文件，append-only）。

### PR2：丢弃型重定向与 $() 只读内层递归

改动文件与函数

- `src/services/tools/permission-rules.ts`
  - 新增最小词法器 `tokenizeShellLite(command): Segment[] | { error }`：引号（单/双引号、反斜杠转义）、操作符（`|`、`||`、`&&`、`;`、`&`）、重定向（`>`、`>>`、`<`、`<<`、`<<<`、`2>`、`&>`、`&>>`、`N>&M`）、命令替换（`$(...)` 平衡括号、反引号）；单引号内的一切按字面量处理（今天把单引号里的反引号当成替换，是误报）。解析失败返回 error。
  - `hasOutputRedirection` 退役，改为 `classifyRedirections(segments)`：丢弃目标（`/dev/null`、`/dev/stderr`、`/dev/stdout`、`&>/dev/null`、`&>>/dev/null`）不产生候选、不触发 ask；fd 复制（`2>&1`、`1>&2`、`>&2`、`N>&M`）忽略；其余文件目标按写处理并作为候选路径。
  - `extractPathCandidates` 改为消费词法器输出：丢弃目标（`/dev/null` 一族）先从候选里剔除，避免 `tee /dev/null` 因为 `/dev/null` 越界而 ask。
  - `detectUnsafeDynamicTarget` 改为：遇到命令替换时，把内层命令文本递归交给 `evaluateBashAccess`（深度上限 3，超限即 ask）。内层 `deny` → 整体 `deny`；内层 `ask` → 整体 `ask` 并把内层原因拼进 `reason`；内层 `allow` → 用占位符 `__cmdsubst__` 替换该构造后继续判外层。反引号同一套处理。
- `src/services/permission/audit-log.ts`：reason 字段记录 `dynamic-shell` 时补充 `inner` 摘要（只记命令文本，不记输出）。

判定语义变化

- `date +%F`、`$(git rev-parse --short HEAD)`、`$(pwd)` 这类只读替换不再强制 ask。
- `$(echo /etc/passwd)` 仍然 ask，但原因从"存在命令替换"变成"内层命令需要审批（目标 /etc/passwd）"——更可解释。
- `> /dev/null`、`2>/dev/null`、`&>/dev/null`、`> /dev/null 2>&1` 不再 ask（这是诊断类命令最大的噪音源）。
- `echo hi > notes.txt`、`echo x > $HOME/notes.txt` 仍 ask（真实文件目标）。
- 单引号内的反引号 / `$(` 不再被当成命令替换。

对现有测试的影响

- `permission-rules.test.ts` "shell constructs" 组：`cat $(echo /etc/passwd)` 与反引号两条从"reason 含 command substitution"改为"reason 含内层命令与目标路径"（断言 `toContain('/etc/passwd')`）。理由：语义变精确了，断言应跟随新的可解释性。
- `echo x > $HOME/notes.txt`、`echo hi > notes.txt`、`2>&1` 三条不变（继续通过）。
- `awk '{print $1}' file`（引号内的 `$1`）不变。

新增测试清单

- 丢弃型：`ls -la >/dev/null`、`cmd &>/dev/null`、`cmd >/dev/null 2>&1`、`tee /dev/null` → `allow`；`cmd 2>/dev/null` → `allow`。
- fd 复制：`cmd 2>&1`、`cmd >&2`、`cmd 1>&2` → `allow`。
- 混合：`cmd > /dev/null && echo x > real.txt` → `ask`（只因为真实目标）。
- 命令替换：`$(date)` / `$(pwd)` / `$(git rev-parse --short HEAD)` → `allow`；嵌套 `$(echo $(date))` → `allow`；`$(cat /etc/shadow)` → `ask`；`$(rm -rf /)` → `ask` 或 `deny`（依内层写动词）；不平衡括号 `$(echo x` → `ask`。
- 引号：`echo 'a\`b'`、`echo "x $(date)"`（双引号内仍算替换 → 内层只读 → allow）。

回滚风险

- 中低：词法器是新增的单一函数，回滚即恢复到"任何 `$(` / 反引号 / `>` 都 ask"的保守行为，副作用只是噪音回到旧水平，不会漏放行。
- 需注意：`classifyRedirections` 与 `extractPathCandidates` 共用词法器输出，回滚要一起回（同一 PR 内，不跨 PR）。

### PR3：bash 只读命令分类（子命令切分 + 白名单 + 参数按 read 判路径 + 相对路径/cd/管道；解析不确定即 ask）

改动文件与函数

- `src/services/tools/permission-rules.ts`
  - 新增 `classifySegment(segment, cwdContext): SegmentClass`，`SegmentClass = { kind: 'read-only', verb, args } | { kind: 'write', reason } | { kind: 'unknown', verb }`。
  - 新增 `BASH_READONLY_VERBS: Map<string, { forbiddenFlags: RegExp[]; forbiddenArgPatterns?: RegExp[] }>`（清单见 C.6）。
  - 新增 `trackCd(segments)`：只跟踪静态 `cd <path>`（绝对或相对，含 `cd -` 视为未知）；跟踪后的 cwd 用于解析后续相对路径；`cd` 目标本身按 read 判定（只读的要求），若 `cd` 到 workspace 之外且后续有读操作，则该读操作按该目录解析后仍要过 policy。
  - `evaluateBashAccess` 重写为三档：
    - Tier A（全部片段都是白名单只读且无禁止 flag）：所有路径参数按 `read` 判定；全部在 workspace / task allowedDirs / config 根内 → `allow`（`matchedRule: 'read-only-command'`）；任一在范围内但越界 → `ask`（`'read-outside-scope'`，`access: 'read'`）；敏感命中 → 按 access=read → `ask`（带 `matchedEntry`）。
    - Tier B（存在写动词 / 禁止 flag / 写重定向目标 / `unknown` 片段里带写语义）：沿用今天的行为——候选按写判定，`deny` 优先，然后危险命令正则 → `ask`。`matchedRule` 标记 `'write-command'`。
    - Tier C（动词不在白名单也不在写动词表，例如 `npm`、`npx`、`node`、`python`）：完全沿用今天的候选扫描（写判定 + 绝对值/tilde 候选），**不强制 ask**。理由：`npm test`、`npx vitest run`、`npm run build` 目前是 allow，改成 ask 会让门槛命令每次都弹窗，是明显倒退。
  - 相对路径：Tier A 下相对路径不再"不参与判定"，而是按跟踪后的 cwd 解析成绝对路径再过 policy（这样 `cat ../x`、`cat ../../.ssh/id_rsa` 能被看见）；Tier C 保持"相对路径不是候选"（避免 `grep -rn '/api/' src` 这类误报复活）。
  - 未解析变量：参数含未展开 `$VAR` 且不以 `-` 开头 → 视为无法静态确定的目标 → `ask`（`'dynamic-shell'`，reason 含变量名）；以 `-` 开头的 flag 里的变量忽略（`--pretty=$FMT` 不 ask）。
  - `find` / `xargs` / `bash -c` / `sh -c` / `eval` / `env`：`env` 剥掉前置赋值后按同一片段继续判；`find ... -exec CMD ...`、`xargs CMD` 把 `CMD` 递归成片段判（深度 +1）；`bash -c '...'`、`sh -c '...'`、`eval '...'` 递归，递归失败或深度超限 → `ask`。
  - 输出的 `ToolAccessDecision` 增加 `access`（`read` / `write` / `unknown`）与 `segments` 摘要（进审计，不进 worker 输出）。
- `src/services/agents/claude-code-worker.ts`：`Bash` 分支已经走 `decideToolAccess`，无需另改；但要确认 `toolArgs` 里带的是原始 command（保持原样），新字段由 gate 统一补充。

判定语义变化

- workspace 内只读命令（`ls -la`、`cat src/cli.ts`、`grep -rn TODO src`、`sed -n 1,80p x`、`git diff`、`git log`、`wc -l`、`stat`）从"靠'无绝对路径候选'侥幸 allow"升级为"命中只读白名单且路径都在范围内 → allow"，`matchedRule` 从 `'no-path'` 变成 `'read-only-command'`。
- `cat ../x` 从 allow 变成"解析后过 policy"：workspace 外 → `ask`（今天直接放行，是漏拦）。
- 模式参数不再被当成路径（修 #24 记录的已知误报 `grep -rn '/api/' src`）：白名单为每个动词声明"哪些位置参数是模式、哪些是路径"——`grep` / `rg` 的第一个非 flag 参数是 pattern，`sed` 的第一个是脚本，`awk` 的第一个是程序，其余位置参数才按路径判。不做 `existsSync` 探测（那会把判定变成文件系统状态的函数，不可复现）。
- `rm /tmp/x` 与 `cat /tmp/x` 从此判定不同：前者 `write` + 危险命令层（即使 `/tmp` 在 `autoAllowRoots` 也 ask），后者 `read` 且可被 `autoAllowRoots` / 任务级读授权放行（D 节验收）。
- 敏感路径：`cat /tmp/.aws/credentials` → `ask`（读）；`rm /tmp/.aws/credentials` → `deny`（写动词片段）。

对现有测试的影响

- "regression: relative sub-paths are not absolute paths" 组：`mkdir -p build/out`（写动词、相对、workspace 内）仍 allow，但 `matchedRule` 不再是 `'no-path'`；`sed -n 1,10p src/cli.ts`、`wc -l < src/cli.ts` 变成 `'read-only-command'`；`npx vitest run …` 仍是 `'no-path'`（Tier C）。断言改成"decision 不变、rule 显式化"。
- "plain commands run" 组：`ls -la` / `cat package.json` / `git status` → `'read-only-command'`；`npm test` → `'no-path'`。
- "paths outside the workspace still require approval" 组全部不变（`cat /etc/hosts`、`./configure --prefix=/usr/local`、`tee /tmp/x.yml`、`ln -s …` 仍 ask），只是 `matchedRule` 更精确。
- `task-execute-engine-permission.test.ts` 7c（普通越界路径仍 ask）不变。

新增测试清单

- 白名单只读、路径全在 workspace：`ls -lt`、`cat a.txt b.txt`、`grep -rn foo src`、`stat package.json`、`date`、`pwd`、`head -n 20 x`、`git diff --stat`、`git log --oneline -5`、`sed -n 1,20p x` → `allow`（`read-only-command`）。
- 禁止 flag：`sed -i 's/a/b/' x`、`sort -o out x`、`git commit -m x`、`git checkout .`、`git config --set`、`tar -xf a.tar`、`unzip a.zip` → `ask` / `deny` 按写路径。
- 越界只读：`cat /etc/hosts`、`cat /tmp/x` → `ask` 且 `access: 'read'`；配 `autoAllowRoots: ['/tmp']` → `allow`。
- 写越界：`rm /tmp/x` → `ask`（危险层）且 `access: 'write'`；`touch /tmp/y` → `ask`；同一命令配 `autoAllowRoots: ['/tmp']` 时 `touch /tmp/y` → `allow`，而 `rm /tmp/x` 仍 `ask`。
- 相对路径与 cd：`cd .. && cat x`、`cat ../x`、`cd /tmp && cat x`（越界 → ask）；`cd sub && ls` → allow；`cd -` → ask。
- 管道：`ps aux | grep node | head`、`cat x | wc -l` → allow；`cat x | tee y` → ask（tee 是写动词）。
- 间接调用：`find . -name '*.ts' -exec cat {} \;` → allow（内层只读、目标在 workspace）；`find . -delete` → ask；`xargs rm` → ask；`bash -c 'ls'` → allow；`bash -c 'rm -rf /'` → ask/deny；`eval "$CMD"` → ask。
- 模式参数不算路径：`grep -rn '/api/' src`、`sed 's|/a/|b|' f`、`awk '{print $1}' f` → allow。
- 未解析变量：`cat $F` → ask；`git log --pretty=$FMT` → allow。

回滚风险

- 中：Tier A 引入的"放行面"最大，回滚时要确认 Tier C 分支仍在（回滚到 PR2 行为不会漏放行，只是噪音回到两侧）。风险点集中 `patternPosition` 与 `cd` 跟踪两处；建议两者分别有独立开关式常量，便于在回归时单独关掉。

### PR4：审批记忆 / 任务级授权（scope: once / task）

改动文件与函数

- `src/services/permission/grant-store.ts`（新增）：`GrantStore`，按 taskId 持有 `grants: Map<key, GrantEntry>` 与 `denials: Map<key, DenyEntry>`；`check(subject)` 返回 `'granted' | 'denied' | undefined`；`remember(...)`、`clearTask(taskId)`、`stats()`。
- `src/services/permission/permission-gate.ts`：裁决顺序变为 硬拒（敏感写）→ 记忆（deny 优先）→ policy → 发请求 → 记入记忆 + 审计。
- `src/services/tools/respond-permission.ts`：`respond_permission` 参数增加 `scope: 'once' | 'task'`（默认 `once`），返回值回显实际生效的粒度。
- `src/services/tools/permission-middleware.ts` / `src/services/agents/claude-code-worker.ts`：`resolvePermission(requestId, approved, reason?, scope?)`。
- `src/services/task-execute-engine.ts`：`handleDone` / 失败 / 取消 / dispose 时 `grantStore.clearTask(taskId)`；`this.permissionResolvers` 的清理路径保持（两个入口同一份 store）。
- `src/prompts/*`（controller 提示词）：说明 `respond_permission` 的 `scope` 语义与"敏感条目最多 once"。

判定语义变化

- `scope: 'task'` 的批准会被后续同类请求直接命中，不再弹窗；`once` 只覆盖本次调用（与今天等价）。
- deny 记忆：拒绝过的 subject 在同一 task 内不再问（直接拒绝，消息与拒绝时一致）；deny 不可被后来的 grant 覆盖（grant 只影响 `undefined` 状态）。
- 敏感路径的批准强制 `once`：请求带 `scope: 'task'` 时降级为 `once` 并回显说明。
- 任务结束即失效；进程重启不恢复（不持久化）。

对现有测试的影响

- `permission-middleware.test.ts`：`resolvePermission` 调用点需要传 `scope`（可选，默认可省），断言"同一次 run 内两次相同 `ask` 各发一条 request"的用例要显式传 `once` 保持原语义。
- `task-execute-engine-permission.test.ts` 4a / 4b：4a 批准后如需再验证一次，改为 `scope: 'task'` 才不弹窗；补一条 4d：`once` 批准后第二次仍 ask。
- `e2e/scenarios/permission.test.ts`：不传 `scope` → 默认 once，现有场景不受影响。

新增测试清单

- 相同路径读第二次：`once` → 再问；`task` → 不问且直接 allow。
- 目录粒度：批准读 `/tmp/a/b.txt`（`task`）后，`cat /tmp/a/c.txt` 不再问；`cat /tmp/other/x` 仍问。
- 写粒度：批准 `touch /tmp/y`（`task`）后，`touch /tmp/z` 仍问（写授权只按精确路径）。
- deny 记忆：拒绝 `cat /tmp/x` 后同一 task 内再读直接拒绝、且不发 request；随后 `respond_permission(approved=true, scope='task')` 对同 key 不生效。
- 敏感不可记忆：批准读 `~/.ssh/id_rsa`（`task`）后第二次仍 ask，且审计里第二次仍是一条 ask。
- 任务边界：task A 的 grant 不影响 task B；任务完成后 store 为空（`stats()` 断言）。
- 并发：两个 worker 同 task 同时命中同一 subject，只发一条 request（或各自发一条但都命中记忆），不出现"批准后仍被拒"。

回滚风险

- 低：记忆是可选的旁路，回滚后回到"每次都问"，安全方向不变（只会更烦）。唯一需要注意的是审计字段里 `scope` 变成常量 `once`，报表口径要跟着调整。

### PR5：可观测性（审批次数、命中规则分布、被拒次数）

改动文件与函数

- `src/services/permission/metrics.ts`（新增）：`PermissionMetrics`，进程内计数器：`requests`、`approved`、`denied`、`timeout`、`autoAllowed`、`hardDenied`，另外按 `matchedRule` 分桶、按 `matchedEntry` 分桶、按 `workerType` 分桶；`snapshot()` 返回纯对象。
- `src/services/permission/permission-gate.ts`：每个决策点 `metrics.record(...)`（与审计同源，保证两处口径一致）。
- `src/services/permission/audit-log.ts`：在关闭时把 `metrics.snapshot()` 写成 `<sessionDir>/permission-metrics.json`（一次覆盖写，`JSONFileHelper`）；运行时也可由 `/permissions` 读取。
- `src/tui`（可选，放本 PR 末尾单独 commit）：`/permissions` 命令渲染一张纯文本摘要（总数 / 自动放行 / 审批 / 拒绝 / 超时 / Top 命中规则），复用 `permission-summary.ts` 的宽度工具。
- 输出位置纪律：只落 `<sessionDir>/wayang.log`（`pino` 结构化字段 `perm.decision`）、`permission-audit.jsonl`、`permission-metrics.json`；**不**新增信号类型、**不**往 worker 输出或 controller 对话里插统计文本（避免污染业务上下文）。

判定语义变化

- 无。纯观测，必须能通过"关闭 metrics 后所有测试仍然通过"的自检。

对现有测试的影响

- 无既有用例需要改。若某个测试对 `<sessionDir>` 下的文件集合做严格断言（例如 assets/session 布局测试），需要把两个新文件加入白名单。

新增测试清单

- `metrics.test.ts`：一次 allow / 一次 ask+批准 / 一次 ask+拒绝 / 一次超时 → 计数与分桶正确；敏感命中单独计数。
- 断言审计与 metrics 口径一致（同一次决策两边都 +1）。
- 断言 metrics 不写 worker 输出：`bash` 工具返回文本里不含统计字样。
- 关卡测试（friction budget）：脚本化 12 条典型只读命令（全部 workspace 内），断言 `requests === 0`——把 #24 的"零审批"目标变成可回归的断言。

回滚风险

- 极低：纯旁路。唯一风险是关闭时写文件失败影响 shutdown，必须 try/catch 且不阻塞 `closeLogger()`。

## C. 关键设计细节

### C.1 三张敏感表如何合并 / 保留与匹配语义

现状三张表（`DEFAULT_DENIED_RELATIVE_PATHS`、`SENSITIVE_SEGMENTS`、`SENSITIVE_FILENAMES`）里有重复：`.ssh`、`.aws`、`.wayang` 等在两张表里都出现，同一个路径改一处不生效（#35 的核心抱怨）。合并规则：

- 保留两条**匹配维度**，不保留三张表：
  - 维度 1「锚点无关段名」：任意绝对路径的任意整段等于集合里的名字即命中。目录名与文件名统一进这一个集合（`.ssh`、`.gnupg`、`.aws`、`.azure`、`.gcloud`、`.kube`、`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc`）。之所以能合并：判定只关心"整段相等"，目录与文件在匹配上没有区别。
  - 0.8.3 起 wayang 自身的配置与会话目录（`~/.wayang` 目录与 `~/.wayang.config.json` 配置文件）**都不在敏感列表内**：它们属于工具自有路径，worker 需要读取自身配置与会话，因此两者都不再命中敏感列表，改由常规作用域规则裁决（home 内读 → worker 层仍降级为 ask，workspace 外写 → ask）。真正的第三方凭据（`.ssh`、`.aws`、`.npmrc` 等）保持敏感。
  - 维度 2「home 锚定的多段路径」：只剩确实需要多段语义的条目（`.docker/config.json`、`.config/gh`）。这些条目无法用单段名表达（单段 `.docker` 会误伤普通 docker 配置目录）。
- 匹配语义**完全不变**（这是不回退安全性的前提）：整段相等、大小写敏感（`.SSH` ≠ `.ssh`）、命中即覆盖其下所有子孙、先 `realpath` 规范化再匹配、`.docker` 只在紧跟 `config.json` 时算命中。
- 单一段名表之外，`~/.config/gh` 这类条目在选择上保持现状（0.8.1 不新增、不删除任何条目，避免本轮同时改"命中处置"和"命中范围"两件事）。
- `matchSensitiveEntry()` 返回**命中的那一条**（段名或相对路径），这是审批请求与审计要展示的"命中条目"；`isSensitivePath()` = `matchSensitiveEntry() !== undefined`。

### C.2 realpath 规范化

保持 `normalizePath` 现有实现不动（先 `realpathSync`，失败则解析最深的已存在祖先再拼回尾部，上限 32 层，永不抛异常）。所有新增逻辑（记忆 key、审计里的 `resolvedPath`、bash 相对路径解析后的目标）都必须经过同一个函数，禁止另写词法前缀判断：

- 记忆 key 用规范化后的路径，否则 `/tmp/a/../b` 与 `/tmp/b` 会各自占一个 grant。
- 授予目录读权限时，存的是 `realpath(dirname(target))`，所以经符号链接的两次访问会命中同一条 grant。
- 审批请求里同时给 `requestedPath`（worker 原文，用于人对照）与 `resolvedPath`（规范化结果，用于判定与审计）；拒绝消息只用 `requestedPath`，不泄露链接目标。

### C.3 配置键兼容

- 内外部命名统一为 sensitiveList / sensitive 语义：类型字段 `permission.sensitiveDirs`，代码常量 `DEFAULT_SENSITIVE_RELATIVE_PATHS` / `SENSITIVE_NAME_SEGMENTS`，日志与文案 "sensitive list"。
- **旧键 `permission.deniedDirs` 保留为 deprecated 别名，继续读取**，理由有三条：
  - 配置在磁盘上（`~/.wayang.config.json`），没有迁移工具；把旧键静默忽略等于把用户自己声明的保护目录**悄悄取消**，是 fail-open 方向的破坏（比多留一个键危险得多）。
  - 别名成本很低：加载时 `sensitiveDirs = dedupe([...sensitiveDirs, ...deniedDirs])`，校验函数对两个键做同一套"字符串数组"检查。
  - 保留别名不需要在运行时区分来源；一旦合并，"这个目录是旧键还是新键给的"对判定毫无影响。
- 解析与合并只在一处发生（配置加载处，`bootstrap.ts` / `wayang-server.ts` 共用的 `loadConfig` 之后），其它模块只看到 `sensitiveDirs`；命中旧键时打一条 `warn`（只打一次），文案给出新键名。
- 新增可选开关 `permission.sensitiveMode: 'ask' | 'deny'`（默认 `ask`）：给"我就是要它硬拒、不要问我"的用户一个一行逃生舱，也让 PR1 的回滚成本更低（改配置即可回到 deny）。
- 历史 `CHANGELOG.md` 里出现 denylist 的条目**不改**（保留历史准确性）；0.8.1 段落用新名。

### C.4 ask 替代 deny 之后如何守住边界

明确仍硬拒（不出请求、不进审批流程）的情形：

1. **写敏感路径**：`read_file` 之外的 `write_file` / `edit_file` 打敏感路径 → `deny`；bash 里出现在写动词片段（`rm`、`mv`、`cp`、`tee`、`chmod`、`chown`、`dd`、`truncate`、`install`、`sed -i`、`find -delete`、`sh -c` 里的写动词等）的敏感目标 → `deny`。理由：产品决策接受的是"密钥进入上下文"的读风险，不是"agent 改写 `authorized_keys`"的持久化风险；后者一旦放行，审批就变成一句话的事，而收益为零（写敏感目录几乎没有正当任务）。
2. **wayang 自身路径不是敏感条目（0.8.3 起）**：`~/.wayang` 目录与 `~/.wayang.config.json` 都不在敏感列表内，因此对它们的写不再走"敏感写硬拒"，而是落到常规规则（workspace 外写 → `ask`）。会话目录 / 审计文件 / `conversation.jsonl` 同样不靠敏感表保护。
3. **敏感路径的整体授权**：`add_task` 的 `allowedDirs` 报敏感目录 → 仍然整体拒绝创建任务（不允许把敏感目录一次性"预授权"进任务边界）。
4. **controller 自身工具**：`search_files` 等没有审批通道的调用点，政策 `ask` 一律按拒绝处理（不引入"没人可问就放行"）。

审批请求必须携带（人/controller 需要这些信息才能判断）：

- `hit: { matchedRule: 'sensitive-list', matchedEntry: '.ssh' }`
- `resolvedPath: '/home/u/.ssh/id_rsa'`（规范化的具体目标）
- `operation: 'read' | 'write' | 'exec'`
- `sensitive: true`

审计字段（`<sessionDir>/permission-audit.jsonl`，一行一条，append-only）：

- `ts`（ISO 8601 与 epoch 毫秒双写）、`sessionId`、`taskId`、`taskTitle`、`workerId`、`workerType`、`workspace`
- `toolName`、`operation`、`requestedPath`、`resolvedPath`、`matchedRule`、`matchedEntry`
- `decision: 'allow' | 'deny'`、`source: 'policy-allow' | 'policy-deny' | 'controller-approve' | 'controller-deny' | 'timeout' | 'aborted'`
- `scope: 'once' | 'task'`（被批准时生效的粒度）、`reason`（controller 给的拒绝理由；超时为 `'timeout'`）
- 绝不写入：文件内容、工具输出、token 值。审计只记路径与判定元数据。
- 写入时机：**执行之前**（批准路径先落审计再跑工具）；append 抛异常时该次调用按拒绝返回（fail-closed），并 `logger.error`。审计不是业务输出，不进 worker/controller 对话。

拒绝后的会话记忆（与 C.7 同一份 store）：

- 拒绝按 subject 记住，作用域限定在该 task；命中记忆直接返回拒绝消息（与首次拒绝文案一致，不回显命中条目）。
- 超时视为拒绝并记忆（避免 controller 打盹导致同一命令无限重问）。
- 拒绝记忆不可被后续 grant 覆盖（顺序：硬拒 → deny 记忆 → grant → policy）。
- 敏感路径的拒绝与批准都**不进记忆**（见 C.7），所以敏感读永远一次一批。

### C.5 审批信号新增字段

`PermissionRequestSignalPayload` 增加（全部可选，向后兼容旧消费方）：

- `matchedRule?: string`（例如 `sensitive-list`、`outside-all`、`dangerous-bash`、`read-outside-scope`）
- `matchedEntry?: string`（敏感列表命中的具体条目）
- `resolvedPath?: string`（规范化后的目标；bash 为命中的第一个候选或 `cd` 后的解析结果）
- `operation?: 'read' | 'write' | 'exec'`
- `sensitive?: boolean`
- `access?: 'read' | 'write' | 'unknown'`
- `scopeHint?: 'once' | 'task'`（建议粒度；敏感命中固定 `once`）
- `reason` 继续走 `description` 的后缀（保持现有渲染路径），但描述文本升级为 `tool: <requested> (resolved: <resolved>) [hit: <matchedEntry> ; rule: <matchedRule> ; op: read]`

TUI 侧（`permission-summary.ts`）把 `matchedEntry` / `resolvedPath` / `operation` 渲染成副标题一行，主行仍是工具名 + 目标，超宽时按现有宽度工具截断。

### C.6 bash 只读白名单（命令 + 禁止 flag）

准入原则：白名单是**封闭集合**，未列入的动词不获得只读豁免（回落到今天的候选扫描），这样白名单漏列只损失收益、不损失安全性。

只读动词（括号内为禁止事项，命中即整条命令降级为 Tier B）：

- 目录/文件查看：`ls`（`-R` 允许；无写 flag）、`cat`、`head`、`tail`（禁止 `-f`? `-f` 只读但会阻塞，允许）、`stat`、`file`、`wc`、`du`、`df`、`readlink`、`realpath`、`basename`、`dirname`、`tree`
- 文本检索：`grep`、`egrep`、`fgrep`、`rg`、`ack`（第一个非 flag 参数是 pattern）
- 文本处理：`sed`（禁止 `-i`、`--in-place`、`-s` 里的写脚本；脚本位置是 program）、`awk`/`gawk`（禁止 `system(`、`print >`、`printf >`、`| "cmd"`）、`cut`、`sort`（禁止 `-o`、`--output`）、`uniq`、`tr`、`comm`、`diff`、`column`、`rev`、`nl`、`paste`、`fold`、`jq`（禁止 `-i`? jq 无；禁止 `--argfile`? 允许）、`xxd`、`od`、`strings`、`base64`、`md5sum`/`sha1sum`/`sha256sum`、`cksum`、`md5`
- 系统诊断：`date`、`pwd`、`whoami`、`id`、`uname`、`hostname`、`uptime`、`free`、`vmstat`、`iostat`、`mpstat`、`ps`、`pstree`、`top`（禁止 `-b` 之外的交互？只允许 `-b -n N`）、`ss`、`netstat`、`lsof`、`dmesg`、`lsblk`、`lsmod`、`lspci`、`lsusb`、`lsof`、`nproc`、`getconf`、`ulimit`、`printenv`、`env`（仅无 `-S`/`-i` 且无赋值后跟命令时；跟命令则递归）、`which`、`type`、`command -v`、`echo`、`printf`、`seq`、`expr`、`test`、`[`、`true`、`sleep`、`timeout`（后跟只读命令则递归）
- 归档只读：`tar` 仅允许 `-t`/`--list`（禁止 `-x`、`-c`、`-u`、`-r`、`--delete`）、`unzip` 仅允许 `-l`、`zipinfo`、`gzip -l`
- git 只读子命令：`status`、`log`、`diff`、`show`、`blame`、`rev-parse`、`ls-files`、`ls-tree`、`cat-file`、`grep`、`describe`、`shortlog`、`reflog`（只读）、`branch --list`、`tag --list`、`remote -v`、`config --get`、`config --list`、`stash list`、`worktree list`、`show-ref`、`for-each-ref`、`count-objects`。禁止子命令：`commit`、`push`、`pull`、`fetch`、`merge`、`rebase`、`reset`、`checkout`、`switch`、`restore`、`clean`、`rm`、`mv`、`add`、`apply`、`am`、`stash`（除 `list`）、`gc`、`prune`、`filter-branch`、`submodule`、`config`（除 `--get`/`--list`）、`-c core.pager=…` 之外的 `-c`（`-c` 可设置别名绕过 → 出现 `-c` 即 Tier B）
- 包管理只读：`npm ls`、`npm run`（不在白名单：会执行脚本）、`yarn list`

显式排除（永不获得只读豁免）：`rm`、`rmdir`、`mv`、`cp`、`ln`、`tee`、`dd`、`truncate`、`install`、`touch`、`mkdir`、`chmod`、`chown`、`chgrp`、`mkfs*`、`mount`、`umount`、`kill`、`pkill`、`shutdown`、`reboot`、`sudo`、`su`、`curl`（可 `-o`）、`wget`、`scp`、`rsync`、`nc`、`ssh`、`git push/pull/…`、`node`、`python*`、`perl`、`ruby`、`sh`、`bash`、`zsh`、`eval`、`exec`、`source`、`.`。

`find` 的专项规则：允许 `-name`、`-type`、`-maxdepth`、`-newer`、`-size`、`-print`、`-print0`、`-quit`；`-exec` / `-execdir` / `-ok` 递归判定内层命令（内层必须整体只读，否则 Tier B）；`-delete`、`-fprint`、`-fls`、`-fprintf` 直接 Tier B。`xargs` 同理：单独出现 → 递归内层；带 `-I`（可把任意位置塞成路径）→ Tier B。

### C.7 grant key 设计与失效

subject 只有三种（都基于规范化路径）：

- 读：`read:dir:<realpath(dirname(target))>`——批准一次覆盖该目录及其子树（这是"减少审批"的主要来源：`ls ~/.claude/x` 之后 `cat ~/.claude/x/y` 不再问）。目录级而非文件级是刻意的：逐文件记忆在诊断场景里仍然会产生几十次审批。
- 写：`write:file:<realpath(target)>`——只按精确路径，绝不做目录级写授权（写放大是不可接受的）。
- 命令级授权（`exec:cmd:<sha256(normalized command)>`）**不实现**：审一个命令串等于审它携带的所有副作用，而命令串稍改一个字符就要重问，收益低、语义糊。

作用域：`once` / `task`。默认 `once`（与现状等价，保守）；`task` 存在 per-task store 里，任务进入终态（completed / failed / cancelled）或 worker dispose 时 `clearTask`。不持久化，`--resume` 后重新开始。

顺序与失效语义：

- 判定顺序：硬拒（敏感写 / `allowedDirs` 校验）→ deny 记忆 → grant 记忆 → policy → ask。
- deny 不可被 grant 覆盖：grant 只在"当前状态为 undefined"时写入。
- 敏感 subject 既不进 grant 也不进 deny 记忆（永远一次一批）：这样"task 级授权"永远不会变成"这个任务从此可以随便读 `~/.ssh`"。若 controller 请求 `scope: 'task'` 且 subject 敏感，降级为 `once` 并回显说明。
- 任务隔离：store 以 taskId 为键，跨任务绝不共享（`#14` 的 workspace 隔离延伸到授权）；同一 task 因 idle 复用换 worker 时继承（授权是任务的，不是 worker 的）。
- 统计：`stats()` 暴露 grants / denials 计数，PR5 落盘。

### C.8 两套 worker 入口共用实现

现状：puppet 侧 `wrapWithPermissionMiddleware` 自己发信号、自己等答复；claude-code 侧 `handleCanUseTool` → `requestPermission` 另写一遍。两者判定已经共用 `decideToolAccess`，但**记忆 / 审批 / 审计**三件事各写一遍，必然发散。

方案：抽出 `PermissionGate`（`src/services/permission/permission-gate.ts`），只做一件事：

`resolve(scope, ctx, toolName, args) → { decision, message?, reason? }`

内部顺序：`decideToolAccess` → 硬拒直接返回 → 查 store（deny/grant）→ 命中即返回 → 否则发 `permission_request`（payload 由 gate 统一补字段）→ `await` 答复（超时按拒绝，复用现有 5 分钟）→ 写审计 → `once` 时只对本次生效、`task` 时写 store → 返回裁决。

接线：

- puppet：`wrapWithPermissionMiddleware` 退化为薄包装（保留 API 与 `cleanup()`，内部 `deps.gate.resolve(...)`）。
- claude-code：`handleCanUseTool` 用同一个 gate 实例（engine 在 `wireWorker()` 里把 gate 与 `accessScope` 一起交给 `setSignalContext`），`PermissionResult` 由裁决映射（`allow` → `{behavior:'allow'}`，`deny` → `{behavior:'deny', message}`，`ask` → gate 内部走完审批后返回同样的三值）。
- gate 由 engine 按 task 构造并注入（依赖 `ctx`、`signalQueue`、`grantStore`、`auditLog`、`metrics`），符合"依赖注入、不全局读取"的约定；两套 worker 拿到的必是同一个实例，因此口径不可能分叉。
- 单元测试可以脱离 engine 直接构造 gate（注入假 SignalQueue），避免 e2e 才能验证审批语义。

### C.9 任务级审批记忆（0.8.4 落地，#46）

C.7 是 #44 的完整设计（once / task / session 三档作用域、目录级读 grant、命令模板 key、deny 记忆、metrics）。0.8.4 只落最小可用子集（#46），其余仍留在 #44：

- **作用域只有 `task` 一档**：grant 绑定 `taskId`，任务进入终态（completed / failed / cancelled）即清空；不跨任务、不跨 session、不持久化（`--resume` 后为空）。
- **key = `方向 + 规范化路径`**，只存读方向：`read:<resolvedPath>`。路径来自策略已算出的 `resolvedPath`（realpath 归一），不引入新的 bash 解析，也不使用整条命令串或命令模板。bash 的每个候选路径各自成一个 key（多候选命令需要全部已授予才复用，见 `ToolAccessDecision.askPaths`）。
- **不做目录级读授权**：C.7 的 `read:dir:<dir>` 覆盖面更大但会放大授权，0.8.4 先按精确路径，等 #44 再讨论。
- **不记忆**：写方向、`deny`、拒绝、任何敏感命中（含 `sensitiveMode: 'ask'` 下可审批的敏感读/写）。敏感路径永远一次一批。
- **判定顺序**：policy → `allow` 直接执行 / `deny` 直接拒 → `ask` 且 `access === 'read'` 且非敏感且所有候选路径都在 grant 里 → 直接执行（审计 `decision: 'granted-by-memory'`，带原 `grantId`）→ 否则发 `permission_request`；批准后写入 grant，拒绝/超时/中断不写。
- **开关**：`permission.approvalMemory: 'task' | 'off'`，默认 `'task'`；`'off'` 时完全不走记忆路径（不查、不写，行为与 0.8.3 一致）。
- **清理**：`TaskExecuteEngine` 在终态转换处**直接调用** `ApprovalMemory.clearTask(taskId)`（`moveToHistory` 与 `cancel()` 的 pending 分支），不走 `LifecycleHooks`——grant 的存活期属于核心判定语义，不是外围副作用。
- **实施位置**：`src/services/permission/approval-memory.ts`（store）、`permission-middleware.ts`（查/写）、`permission-audit.ts`（`granted-by-memory` + `grantId`）、`permission-rules.ts`（`askPaths`）、`types/config.ts` + `infra/permission/permission-config.ts`（开关与校验）。
- **未覆盖**：claude-code worker 的 `canUseTool` 仍走自己的审批通道，不查 grant（随后续把两个入口合成一个 gate 时一并接入，见 C.8）。

## D. 验收标准

- 在 workspace 内执行 12 条典型只读命令（`ls -lt`、`cat package.json`、`grep -rn TODO src`、`stat`、`date`、`git status`、`git diff --stat`、`git log --oneline -5`、`wc -l src/cli.ts`、`sed -n 1,40p src/cli.ts`、`head -n 5 README.md`、`find . -name '*.ts' -maxdepth 2`），产生的 `permission_request` 数量为 0（PR3 + PR5 的 friction budget 测试断言 `metrics.requests === 0`）。
- `evaluateBashAccess(scope, 'cat /tmp/x')` 返回 `decision: 'ask'`、`access: 'read'`、`matchedRule: 'read-outside-scope'`，且同一 scope 加上 `permission.autoAllowRoots = ['/tmp']` 后返回 `'allow'`；而 `evaluateBashAccess(scope, 'rm /tmp/x')` 在两种 scope 下都返回 `'ask'`、`access: 'write'`（危险命令层不会被 `autoAllowRoots` 抵消）。
- `evaluateToolAccess(scope, 'read_file', { path: '~/.ssh/id_rsa' })` 返回 `decision: 'ask'`、`matchedEntry: '.ssh'`；`evaluateToolAccess(scope, 'write_file', { path: '~/.ssh/authorized_keys' })` 返回 `decision: 'deny'`。
- 敏感路径命中在 puppet 与 claude-code 两个 worker 上产生**恰好一条** `permission_request`（用 e2e 场景断言 `signals.filter(type === 'permission_request').length === 1`），批准后 `cat ~/.ssh/id_rsa` 的输出包含文件原文，且 `<sessionDir>/permission-audit.jsonl` 新增一条 `decision: 'allow'`、`matchedEntry: '.ssh'`、带 `taskId` / `ts` / `operation: 'read'` 的记录。
- 拒绝同一条请求时，worker 收到的错误文本不含文件内容、不含命中条目名、不含规范化的符号链接目标；审计同样新增一条 `decision: 'deny'` 记录。
- 敏感路径的第二次读取仍然产生一次新的 `permission_request`（即使第一次用的是 `scope: 'task'`）。
- 同一路径的普通越界读在 `scope: 'task'` 批准之后不再产生 `permission_request`，同一 task 内换一个子目录读仍然产生一次。
- `metrics.snapshot()` 能给出 `requests` / `approved` / `denied` / `timeout` / `autoAllowed` / `hardDenied` 与按 `matchedRule`、`matchedEntry` 的分桶，且 shutdown 后 `<sessionDir>/permission-metrics.json` 存在；`bash` 工具的输出里不出现任何统计文本。
- 只写 `permission.deniedDirs` 的旧配置在 0.8.1 上仍然生效（与写在 `sensitiveDirs` 里等价），加载时输出一条指向新键的 deprecation warn。
- 四道门槛全绿：`npm run lint`、`npx vitest run`、`npm run build`、`e2e/scenarios/permission.test.ts`。

## E. 风险清单

### 风险 1：bash 只读白名单误判，把写操作当读放行

最可能的形态：白名单动词里的"隐藏写"——`sed -i`、`sort -o`、`awk 'print > "f"'`、`tar -xf`、`git config --set`、`git -c alias.x=!rm x`、`find -delete`、`xargs -I{} cp {} dest`。

保守兜底：

- 白名单是封闭集合，未列动词不获得豁免（漏列只损失收益）。
- 每个动词配显式禁止 flag 表，命中即整条命令降级 Tier B（按写判、按写问）。
- 任何重定向到真实文件的目标一律按写处理，且不从候选里剔除（丢弃型目标除外，且在 PR2 里白名单式穷举 `/dev/null` 一族）。
- 出现 `-c`（git 别名）、`-I`（xargs）、`-exec`（find）等能把任意字符串塞成命令/路径的 flag，直接 Tier B，不尝试"聪明地"解析。
- 兜底原则写进代码注释与测试名：**Tier A 只允许"无法表达写语义"的命令**。

### 风险 2：敏感列表从硬拒改审批后，controller 盲目批准

最可能的形态：controller 把 `permission_request` 当噪音，回一句"approve"就过；或者长任务里连续批准，密钥随 transcript 落盘，而没有人真正看过。

保守兜底：

- 写敏感路径仍硬拒（不提供审批路径），把最高危的一半彻底关掉。
- 敏感请求的描述强制包含命中条目 + 规范化路径 + 操作类型（信息不足时人无法判断，信息充分时才有资格批）。
- 敏感 subject 永远 `scope: 'once'`，不能一次批准覆盖后续（避免"批一次 = 批一个任务"）。
- 审计 fail-closed：批准路径先落审计再执行，落不下去就拒绝。
- PR5 把"敏感命中次数 / 批准率"做成可统计指标，让"批准率接近 100%"这种漂移可见；后续可据此把某些条目退回硬拒。

### 风险 3：命令替换递归与相对路径 / cd 跟踪把"看不见的目标"当成了 allow

最可能的形态：`cd /etc && cat passwd`（跟踪错了 cwd 就等于放行越界读）、`cat ../../.ssh/id_rsa`（相对路径解析基准错）、`$(echo rm) -rf x`（把替换结果当普通词）、单引号/双引号混淆导致的 token 边界错误。

保守兜底：

- 递归深度上限 3；任何深度超限、引号不平衡、括号不平衡 → 整体 `ask`，不做"尽力而为"的解析。
- `cd` 只接受静态字面量目标；变量、`~user`、`cd -` 一律视为未知 → `ask`。
- 递归内层出现写动词 → 整体按写处理（不是只看外层）。
- 相对路径解析后的绝对路径必须再过一次 `normalizePath`（realpath），并保留一条独立测试：`cat ../../.ssh/id_rsa` → `ask` / `deny`。
- 提供"退回 PR2 行为"的单一开关（`BASH_CLASSIFY_ENABLED` 常量或 env），线上发现误放行可以立刻收回到"绝对/相对路径全按写判 + 不确定即问"。

### 其他需要盯的点

- `read-within-home` 降级（worker 读 home 内非 workspace 文件仍 ask）不能因为 bash 分类而被绕过：`cat ~/.zshrc` 必须仍然 `ask`，只是现在可以一次 `task` 授权覆盖该目录。
- grant 的目录粒度（`read:dir`）是这一轮唯一"放行面被放大"的地方；审计里必须能看出是"目录级授权"还是"精确路径"，便于事后审计发现过宽授权。
- 审计与 metrics 都不能进入 worker / controller 的上下文（否则会挤占预算，也与"输出不污染业务"冲突）。
