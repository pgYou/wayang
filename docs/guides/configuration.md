# Wayang 配置指南

面向已经装好 wayang、想配置自己的 provider、controller 和几个 worker 的用户。你只需要编辑 `~/.wayang.config.json` 这一个文件，不需要了解 wayang 内部如何实现。

## 配置文件放在哪、找不到时会怎样

全部配置放在一个 JSON 文件里，默认路径为 `~/.wayang.config.json`。可用 CLI 参数覆盖：

- `wayang -c /path/to/config.json`（或 `--config`）指定其他路径。
- `--wayang-root <path>` 会连带把配置路径变为 `<path>/.wayang.config.json`。

wayang 启动时按下面的顺序找配置：

1. 配置文件存在 → 直接使用，文件里写的值优先生效。
2. 配置文件不存在，且环境变量 `WAYANG_LLM_API_KEY`、`WAYANG_ENDPOINT`、`WAYANG_MODEL` 三者齐全 → 用它们构造一个名为 `default` 的 provider，照常运行。
3. 两者都不满足 → 进入交互式引导（首次运行 `wayang` 时看到的就是它），回答几个问题后结果会自动写回配置文件。

注意：JSON 不支持注释。下文示例中若出现 `//` 旁注，仅是解释文字，抄入配置文件前必须删除该行。

## 最小可用示例

保存为 `~/.wayang.config.json` 即可直接运行（provider 名可自取，controller/worker 通过名字引用它）：

```json
{
  "providers": {
    "default": {
      "endpoint": "https://api.anthropic.com",
      "apiKey": "sk-xxx",
      "modelName": "claude-sonnet-4-20250514",
      "contextWindowTokens": 200000
    }
  },
  "controller": { "provider": "default" },
  "worker": { "provider": "default", "maxConcurrency": 3 },
  "workers": {
    "codebuddy": {
      "type": "codebuddy",
      "description": "Tencent CodeBuddy Code (ACP)",
      "capabilities": ["code", "refactor", "shell"]
    }
  }
}
```

## 字段参考

### 顶层字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `providers` | 对象 | 是 | — | LLM 服务定义，键为自定义名字 |
| `controller` | 对象 | 是 | — | controller 绑定的 provider 名，必须在 `providers` 中存在 |
| `worker` | 对象 | 是 | — | worker 默认绑定与并发设置 |
| `workers` | 对象 | 否 | 无 | 各个 worker 的定义，键为 worker ID |
| `tavilyApiKey` | 字符串 | 否 | — | 网页搜索工具的 Tavily key，未设置时该工具返回错误 |
| `skillsDirs` | 字符串数组 | 否 | — | 额外的技能扫描目录（全局与工作区之外） |
| `idleTimeoutMs` | 数字 | 否 | 1800000 | 常驻 worker 空闲多久后被回收（默认 30 分钟） |
| `signalWindowSize` | 数字 | 否 | 2000 | 已处理消息保留的热窗口大小 |
| `permission` | 对象 | 否 | 默认策略 | 路径权限策略，见下 |
| `logging` | 对象 | 否 | 默认策略 | 会话日志滚动策略 |

`worker` 子字段：

- `provider`（必填，字符串）：worker 默认使用的 provider 名，必须存在于 `providers`。
- `maxConcurrency`（必填，数字）：最多同时运行几个 worker。建议 1–10 之间；wayang 不校验这个值，请自己填 ≥1 的整数。
- `toolChoice`（可选，`'auto' | 'required' | 'none'`，默认 `'auto'`）：worker 调用工具的模式。部分模型服务（DeepSeek/GLM）会拒绝 `required`；仅当端点支持时用 `required` 强制每步都调用工具以保证收尾。
- `maxTurns`（可选，正整数，默认不限）：puppet worker 的 LLM 步数上限。未配置即不限制；非法值（非正整数、超过 1000000）视为不限并 warn 一次。达到上限仍未调用 done/fail 时按失败收尾。仅对 puppet 生效——claude-code 用 `workers.<id>.maxTurns`，ACP 类型不消费该键。

`providers.<name>` 子字段：

- `endpoint`（必填，字符串）：OpenAI 兼容 base URL。
- `apiKey`（必填，字符串）：可留空，留空时由环境变量 `WAYANG_LLM_API_KEY` 补齐。
- `modelName`（必填，字符串）：模型名。
- `temperature`、`maxOutputTokens`（可选，数字）：目前仅记录，不影响运行。
- `contextWindowTokens`（可选，正整数，默认 256000）：模型上下文窗口大小（输入侧预算）。controller 在用到 60% 时会自动压缩对话；小窗口模型请显式设置（如 128000），否则请求会在压缩前被 provider 拒绝。

`permission` 子字段（全部可选，相对路径以你的 home 目录解析）：

- `allowedDirs: string[]`：读写都始终允许的目录。
- `autoAllowRoots: string[]`：额外免审批放行的根目录。
- `sensitiveDirs: string[]`：追加到内置敏感目录列表（内置项不可移除），命中时按 `sensitiveMode` 处理。
- `deniedDirs: string[]`：已废弃的旧写法，仍会被读取并与 `sensitiveDirs` 合并，启动时会提示一次。
- `sensitiveMode`：`'ask'`（默认，命中即请求 controller 审批）或 `'deny'`（直接拒绝，从不询问）。
- `approvalMemory`：`'task'`（默认，同一任务内已批准的读路径不再重复询问）或 `'off'`。
- `extraWorkspaceRoots: string[]`：add_task 声明的工作区（`workspace` 参数）允许落在 home 之外的根目录，默认空（仅 home 内）。给仓库统一放在 home 之外的部署用（如 `/codev`）。生效时启动会提示一次，且每次经由它放行的工作区都会写入会话审计日志（`audit: "workspace"`）；敏感目录列表仍优先生效。

`workspace` 与 `allowedDirs` 的校验差异（两者都只收 home 内路径，`extraWorkspaceRoots` 是共同的例外出口）：

- `workspace` 是任务的执行根：归一化（含软链解析）后必须位于 home 内或某个 `extraWorkspaceRoots` 根下，且不得命中敏感目录列表；不在范围内时直接拒绝创建任务，也不会创建目录。任务工作区内的读写按"工作区内"放行。
- `allowedDirs` 是任务工作区之外的补充授权：逐条校验（home 内、不碰敏感列表），一条非法即整单拒绝；授予的目录享受与工作区同级的放行，但敏感目录列表同样优先。
- 需要让任务访问工作区以外的目录，用 `allowedDirs`，不要试图把工作区指到别处。

`logging` 子字段：`maxFileSizeBytes`（默认 10485760）、`maxFiles`（默认 3），均为正整数。

### 运行时长限制已移除

v0.9.7 移除了 worker 单次运行的 wall time 上限（原 #76 能力撤回）：全局配置 `workerRunTimeoutMs` 与 `add_task` 的 `runTimeoutMs` 均已废弃，不再有任何基于运行时长的终止。旧配置仍带入这两个键时不会报错——加载时提示一次弃用告警后忽略，可以安全地从配置里删掉。

### workers.<id> 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | 字符串 | 是 | — | `claude-code` / `acp` / `codebuddy` / `opencode` 四选一 |
| `description` | 字符串 | 是 | — | 给 controller 看的自然语言描述，非空 |
| `enable` | 布尔值 | 否 | `true` | 是否启用这个 worker |
| `emoji` | 字符串 | 否 | 按类型 | 界面显示图标；缺省为 🤖（claude-code）/ 🧩（acp）/ 🐧（codebuddy）/ 🦉（opencode） |
| `capabilities` | 字符串数组 | 否 | — | 能力标签，供 controller 路由任务时参考 |
| `maxTurns` | 数字 | 否 | — | 单个任务的最大轮数；只对 claude-code 有意义（未配置即不限制），写在 ACP 类型上不生效（仅在 worker 运行时打一条 debug 日志） |
| `cliPath` | 字符串 | 否 | 自动探测 | Claude Code CLI 可执行文件路径，仅 claude-code 使用 |
| `permissionMode` | `'client' \| 'agent'` | 否 | `'client'` | `client`：权限请求经 wayang 审批；`agent`：worker 自己管权限，漏过来的请求会被取消并记录，绝不静默放行 |

### ACP 类 worker 的额外字段（type 为 `acp` / `codebuddy` / `opencode`）

- `command`（字符串）：要启动的可执行文件名，需要能从 PATH 找到。**type 为 `acp` 时必填**（通用类型不知道该启动什么）；codebuddy 默认 `codebuddy`，opencode 默认 `opencode`。
- `args`（字符串数组）：启动参数。默认 codebuddy 为 `["--acp"]`、opencode 为 `["acp"]`。
- `env`（对象）：传给 worker 进程的额外环境变量。
- `trustUpdatesAfterCancel`（布尔值，默认 `false`）：仅 type `acp` 有效。任务取消之后才返回的结果是否仍写入记录；默认丢弃并计数。
- `protocol`（对象）：等待时间与行为开关，一般不用配，出现超时再调。
  - 等待时间字段（`promptMs` 允许 0 表示不限时，其余必须为正数）：`handshakeMs`（默认 15000，等 CLI 完成启动连接）、`sessionNewMs`（默认 30000，为任务开新会话）、`promptMs`（默认 0，等 CLI 完成单个任务）、`permissionMs`（默认 300000，等审批结果）、`cancelGraceMs`（默认 5000，取消后等 CLI 停下的缓冲）、`sigtermWaitMs`（默认 2000，关闭进程前的等待）。
  - `capabilities`：`{ permissionRequests?: boolean, toolCalls?: boolean }`，覆盖 wayang 观测到的该 worker 能力声明，只在观测值不准时用。
  - `gatePermissions`（布尔值，默认 `true`）：仅 opencode 有效。`true` 时 wayang 注入 ask-all 权限闸接管 opencode 的权限审批（门禁文件写在 worker 专属目录，run 结束自动删除）；`false` 则不注入，opencode 的工具操作不经 wayang 审批。`permissionMode: "agent"` 也会跳过注入（agent 自管权限，优先级更高）。父进程已有 `OPENCODE_CONFIG` 时 wayang 会校验其内容：含 ask-all 规则才放行，否则拒绝启动并在任务结果里说明原因。对 codebuddy 无效。

注意：`command` / `args` / `env` / `protocol` / `trustUpdatesAfterCancel` 写在 `claude-code` 行会导致启动校验失败。

### 环境变量

| 变量 | 作用 | 与配置文件的关系 |
| --- | --- | --- |
| `WAYANG_LLM_API_KEY` | provider API key | 文件存在时仅补齐留空的 `apiKey`，文件值优先；无文件时是构造来源之一 |
| `WAYANG_ENDPOINT` | endpoint | 仅在配置文件不存在时使用，文件优先 |
| `WAYANG_MODEL` | 模型名 | 同上 |
| `WAYANG_CONTEXT_WINDOW_TOKENS` | 上下文窗口 | 仅环境变量配置方式（无文件）时使用 |
| `WAYANG_TAVILY_API_KEY` | Tavily key | 配置文件的 `tavilyApiKey` 优先 |

## 四类 worker 怎么选

### claude-code

```json
{
  "workers": {
    "claude-code": {
      "type": "claude-code",
      "description": "Coding assistant powered by Claude Code",
      "capabilities": ["code", "debug", "refactor", "git"],
      "maxTurns": 1000,
      "cliPath": "/usr/local/bin/claude"
    }
  }
}
```

什么时候选它：已安装并登录 Claude Code CLI、需要强编码能力。`cliPath` 留空会自动探测；不要写 `command`/`args`/`env`/`protocol`（会被拒绝）；想控制轮数用 `maxTurns`。

### acp（通用 ACP）

```json
{
  "workers": {
    "gemini": {
      "type": "acp",
      "command": "gemini",
      "args": ["--experimental-acp"],
      "description": "Gemini CLI via ACP",
      "capabilities": ["code", "shell"],
      "protocol": { "sessionNewMs": 60000 }
    }
  }
}
```

什么时候选它：手上的 agent CLI 支持 ACP（Agent Client Protocol），但 wayang 没有为它提供专用类型。`command` 必填——通用类型不内置任何可执行文件，由它决定启动什么；`args`/`env`/`protocol` 按需覆盖。如果该 CLI 已有专用类型（codebuddy/opencode），优先用专用类型：它们自带实测好的启动参数与策略。

### codebuddy（原 codebuddy-acp）

```json
{
  "workers": {
    "codebuddy": {
      "type": "codebuddy",
      "description": "Tencent CodeBuddy Code (ACP)",
      "capabilities": ["code", "refactor", "shell"]
    }
  }
}
```

什么时候选它：安装并登录腾讯 CodeBuddy CLI 之后（终端跑 `codebuddy --version` 确认）。默认以 `codebuddy --acp` 启动（仅 `cbc` 别名存在时会回退）。需要代理或额外环境变量时用 `env` 注入；工具调用会经 wayang 权限闸，敏感操作会弹审批。

### opencode（原 opencode-acp）

```json
{
  "workers": {
    "opencode": {
      "type": "opencode",
      "description": "OpenCode (ACP)",
      "capabilities": ["code", "refactor", "shell"],
      "env": { "HTTPS_PROXY": "http://127.0.0.1:7890" }
    }
  }
}
```

什么时候选它：安装并配置好 OpenCode CLI 之后（终端跑 `opencode --version` 确认）。默认以 `opencode acp` 启动。opencode 自身默认权限全放行，wayang 默认会接管它的权限审批（注入 ask-all `OPENCODE_CONFIG`，run 结束自动清理）。若你已在外层设置了 `OPENCODE_CONFIG`，wayang 会校验其内容：含 ask-all 规则（`{"action":"*","resource":"*","effect":"ask"}`）才放行，否则拒绝启动并提示修复。想完全不干预用 `"protocol": { "gatePermissions": false }` 或 `"permissionMode": "agent"`，但此后其工具操作不经 wayang 审批。

## 常见配置任务

- 定并发数：`worker.maxConcurrency` 是全局上限——最多同时跑几个 worker，与 worker 个数无关。受机器与 provider 限流约束，建议从 3 起，看到限流报错再调。
- 给 worker 加能力：把标签写进 `capabilities`（如 `"test"`、`"docs"`），并在 `description` 里说清楚，controller 按这些信息决定把任务分给谁。
- 限制可见目录：用 `permission.allowedDirs`（始终允许）与 `permission.sensitiveDirs`（命中需审批）。敏感目录列表优先级高于一切 allow 规则，只能选"问"或"拒"（`sensitiveMode`）。
- 让 add_task 的工作区落在 home 外：`permission.extraWorkspaceRoots` 列出根目录（如 `/codev`），声明的 `workspace` 指向其内路径才放行；默认一律拒绝并提示改用 `allowedDirs`。
- controller 与 worker 用不同模型：定义两个 provider，分别绑定 `controller.provider` 与 `worker.provider`：

```json
{
  "providers": {
    "strong": { "endpoint": "https://api.anthropic.com", "apiKey": "sk-a", "modelName": "claude-sonnet-4-20250514" },
    "cheap": { "endpoint": "https://api.deepseek.com/v1", "apiKey": "sk-b", "modelName": "deepseek-chat", "contextWindowTokens": 128000 }
  },
  "controller": { "provider": "strong" },
  "worker": { "provider": "cheap", "maxConcurrency": 3 }
}
```

## 常见报错与改法

配置有问题时，交互模式下启动会报错退出并提示 `Run \`wayang\` without arguments to configure.`；server 模式会抛出 `Invalid config: <错误>`。下表"你会看到"为程序打印的原文（`<id>` 是你配置里的 worker ID）：

| 你会看到 | 怎么改 |
| --- | --- |
| `workers.<id>.type "foo" is not supported (allowed: claude-code, acp, codebuddy, opencode)` | type 拼错了，改为四个合法值之一 |
| `workers.<id>.type is required (allowed: claude-code, acp, codebuddy, opencode)` | 缺少 type 字段，补上 |
| `workers.<id>.command is required for type "acp" (set workers.<id>.command to the ACP agent executable)` | 通用 acp 行必须写 `command`，填该 CLI 的可执行文件名 |
| `workers.<id>.<key> is not supported for type "claude-code" (claude-code uses cliPath)` | claude-code 行混入了 ACP 字段，删掉 `command`/`args`/`env`/`protocol`/`trustUpdatesAfterCancel` |
| `controller.provider "foo" not found`（worker.provider 同理） | 绑定的名字不在 `providers` 里，检查拼写 |
| `providers.<name>.apiKey is required (set WAYANG_LLM_API_KEY or configure in config file)` | key 缺失，填进文件或设环境变量 |
| `providers.<name>.contextWindowTokens must be a positive integer (got ...)` | 该字段须为正整数 |
| `permission.sensitiveMode must be 'ask' or 'deny' (got ...)` | 改为 `ask` 或 `deny` |

另外两处不会报错但要留意：`maxConcurrency` 填 0 或负数不会被拦截，请自行填 ≥1 的整数；`maxTurns`/`cliPath` 写在 ACP 类 worker 上无效，会各提示一次 no effect。

## 0.9.3 类型改名说明

0.9.3 起 worker 类型改名：`codebuddy-acp` → `codebuddy`、`opencode-acp` → `opencode`。旧写法 `codebuddy-acp` 仍可用，启动时会给一条提示并自动按新写法处理：

`Warning: worker type 'codebuddy-acp' is deprecated, use 'codebuddy' (workers.<id>)`

（opencode 同理。）配置文件不急着改也能正常跑，但建议尽早更新为新名字。

## 已知限制

通用 `acp` worker 只根据协议版本判断是否就绪；如果你的 CLI 还没登录，可能表现为启动后长时间无响应，而不是明确的"请先登录"提示。遇到这种情况，先在终端手动跑一次该 CLI 并完成登录，再回来用 wayang。
