# Wayang 配置指南

面向第一次配置 Wayang 的用户。所有字段以 `src/types/config.ts` 为准，本文不引入代码之外的行为。

## 配置文件是什么、放在哪

Wayang 的全部配置放在一个 JSON 文件里，默认路径为 `~/.wayang.config.json`。可用 CLI 参数覆盖：

- `wayang -c /path/to/config.json`（或 `--config`）指定其他路径。
- `--wayang-root <path>` 会连带把配置路径变为 `<path>/.wayang.config.json`。

加载顺序（`src/onboard.ts` 的 `loadConfig`）：

1. 配置文件存在 → 直接读取，文件里的值优先生效。
2. 配置文件不存在，且环境变量 `WAYANG_LLM_API_KEY`、`WAYANG_ENDPOINT`、`WAYANG_MODEL` 三者齐全 → 用环境变量构造一个名为 `default` 的 provider。
3. 都不满足 → 进入交互式引导（首次运行 `wayang` 时看到的就是它），并把结果写回配置文件。

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
| `providers` | `Record<string, ProviderConfig>` | 是 | — | LLM provider 定义，键为自定义名字 |
| `controller` | `{ provider: string }` | 是 | — | Controller 使用的 provider 名，必须在 `providers` 中存在 |
| `worker` | 对象 | 是 | — | worker 默认绑定与并发设置 |
| `workers` | `Record<string, WorkerConfig>` | 否 | 无 | 第三方 worker 定义，键为 worker ID |
| `tavilyApiKey` | `string` | 否 | — | web_search 工具的 Tavily key，未设置时该工具返回错误 |
| `skillsDirs` | `string[]` | 否 | — | 额外的技能扫描目录（全局与工作区之外） |
| `idleTimeoutMs` | `number` | 否 | 1800000 | 多阶段 worker 空闲多久后被回收（30 分钟） |
| `signalWindowSize` | `number` | 否 | 2000 | 已处理信号保留的热窗口大小 |
| `permission` | `PermissionConfig` | 否 | 默认策略 | 路径权限策略，见下 |
| `logging` | `LoggingConfig` | 否 | 默认策略 | 会话日志滚动策略 |

`worker` 子字段：

- `provider`（必填，string）：worker 默认 provider 名，必须存在于 `providers`。
- `maxConcurrency`（必填，number）：并发 worker 上限。引导向导建议范围 1–10；配置加载时没有专门校验，请自行填正整数。
- `toolChoice`（可选，`'auto' | 'required' | 'none'`，默认 `'auto'`）：puppet worker 的工具选择模式。thinking 类端点（DeepSeek/GLM）会拒绝 `required`；仅在端点支持时用 `required` 强制每步调用工具以保证收尾。

`providers.<name>` 子字段：

- `endpoint`（必填，string）：OpenAI 兼容 base URL。
- `apiKey`（必填，string）：可留空由 `WAYANG_LLM_API_KEY` 补齐。
- `modelName`（必填，string）。
- `temperature`、`maxOutputTokens`（可选，number）：目前仅记录为元数据。
- `contextWindowTokens`（可选，正整数，默认 256000）：模型上下文窗口（输入侧预算）。Controller 在达到 90% 时触发压缩；小窗口模型请显式设置（如 128000），否则 provider 会在压缩前拒绝请求。

`permission` 子字段（全部可选，相对路径以用户 home 目录解析）：

- `allowedDirs: string[]`：读写都始终允许的目录。
- `autoAllowRoots: string[]`：额外免审批放行的根目录。
- `sensitiveDirs: string[]`：追加到内置敏感目录列表（不可移除内置项），命中时按 `sensitiveMode` 处理。
- `deniedDirs: string[]`（已废弃别名，仍会被读取并与 `sensitiveDirs` 合并，加载时告警一次）。
- `sensitiveMode`：`'ask'`（默认，命中即请求 Controller 审批）或 `'deny'`（直接拒绝，从不询问）。
- `approvalMemory`：`'task'`（默认，同一任务内已批准的读路径不再重复询问）或 `'off'`。

`logging` 子字段：`maxFileSizeBytes`（默认 10485760）、`maxFiles`（默认 3），均为正整数。

### workers.<id> 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `type` | `WorkerType` | 是 | — | `claude-code` / `acp` / `codebuddy` / `opencode` |
| `description` | `string` | 是 | — | 给 Controller LLM 看的自然语言描述，非空 |
| `enable` | `boolean` | 否 | `true` | 是否启用 |
| `emoji` | `string` | 否 | 按类型 | 界面显示图标；ACP 行缺省为 🧩（acp）/ 🐧（codebuddy）/ 🦉（opencode） |
| `capabilities` | `string[]` | 否 | — | 能力标签，供任务路由参考 |
| `maxTurns` | `number` | 否 | — | 单任务最大轮数；对 ACP 行无效（ACP 无轮数上限），配置了会告警 |
| `cliPath` | `string` | 否 | 自动探测 | worker CLI 可执行文件路径，仅 claude-code 使用 |
| `permissionMode` | `'client' \| 'agent'` | 否 | `'client'` | `client`：权限请求经 wayang 审批桥；`agent`：agent 自管权限，仍到达的请求会被取消并记录，绝不静默放行 |

### ACP 专用字段（type 为 `acp` / `codebuddy` / `opencode`）

- `command`（string）：可执行文件名，需能从 PATH 解析。**type 为 `acp` 时必填**（通用类型没有内置可执行文件）；codebuddy 默认 `codebuddy`，opencode 默认 `opencode`。
- `args`（string[]）：启动参数。默认 codebuddy `["--acp"]`、opencode `["acp"]`。
- `env`（`Record<string, string>`）：合并到 `process.env` 之上传给子进程的额外环境变量。
- `trustUpdatesAfterCancel`（boolean，默认 `false`）：仅 type `acp` 有效。取消之后到达的 session/updates 是否仍写入记录；保守默认是丢弃并计数。
- `protocol`（对象）：协议级覆盖，省略时用各 provider 实测默认值。
  - 超时字段（`promptMs` 允许 0=不限，其余必须为正数）：`handshakeMs`（默认 15000）、`sessionNewMs`（默认 30000）、`promptMs`（默认 0）、`permissionMs`（默认 300000）、`cancelGraceMs`（默认 5000）、`sigtermWaitMs`（默认 2000）。
  - `capabilities`：`{ permissionRequests?: boolean, toolCalls?: boolean }`，用诚实值覆盖观测到的能力声明。
  - `gatePermissions`（boolean，默认 `true`）：仅 opencode 有效。`true` 时注入 ask-all 权限矩阵收回裁决权；`false` 则 opencode 的工具操作不经 wayang 审批。对 codebuddy 无效。

注意：`command` / `args` / `env` / `protocol` / `trustUpdatesAfterCancel` 出现在 `claude-code` 行会直接校验失败。

### 环境变量

| 变量 | 作用 | 与配置文件的关系 |
| --- | --- | --- |
| `WAYANG_LLM_API_KEY` | provider API key | 文件存在时仅补齐留空的 `apiKey`，文件值优先；无文件时是构造来源之一 |
| `WAYANG_ENDPOINT` | endpoint | 仅在配置文件不存在时使用，文件优先 |
| `WAYANG_MODEL` | 模型名 | 同上 |
| `WAYANG_CONTEXT_WINDOW_TOKENS` | 上下文窗口 | 仅环境变量配置方式（无文件）时使用 |
| `WAYANG_TAVILY_API_KEY` | Tavily key | 配置文件的 `tavilyApiKey` 优先 |

## Worker 类型详解

### claude-code

```json
"claude-code": {
  "type": "claude-code",
  "description": "Coding assistant powered by Claude Code",
  "capabilities": ["code", "debug", "refactor", "git"],
  "maxTurns": 1000,
  "cliPath": "/usr/local/bin/claude"
}
```

适用：已安装并登录 Claude Code CLI、需要强编码能力的场景。注意事项：`cliPath` 留空则自动探测；不要写 `command`/`args`/`env`/`protocol`（会被拒绝）；需要控制轮数用 `maxTurns`。

### acp（通用 ACP）

```json
"gemini": {
  "type": "acp",
  "command": "gemini",
  "args": ["--experimental-acp"],
  "description": "Gemini CLI via ACP",
  "capabilities": ["code", "shell"],
  "protocol": { "sessionNewMs": 60000 },
  "trustUpdatesAfterCancel": false
}
```

适用：任何支持 ACP（Agent Client Protocol）的 agent CLI，且没有专用类型时。`command` 必填——通用类型不内置任何可执行文件，由它决定启动什么；`args`/`env`/`protocol` 按需覆盖。若 CLI 已有专用类型（codebuddy/opencode），优先用专用类型：它们带有实测的启动参数与策略。

### codebuddy（原 codebuddy-acp）

```json
"codebuddy": {
  "type": "codebuddy",
  "description": "Tencent CodeBuddy Code (ACP)",
  "capabilities": ["code", "refactor", "shell"]
}
```

适用：安装并登录腾讯 CodeBuddy CLI 后（`codebuddy --version` 确认）。默认以 `codebuddy --acp` 启动（仅 `cbc` 别名存在时会回退）。注意事项：需要代理或额外环境变量时用 `env` 注入；工具调用经 wayang 权限闸，敏感操作会弹审批。

### opencode（原 opencode-acp）

```json
"opencode": {
  "type": "opencode",
  "description": "OpenCode (ACP)",
  "capabilities": ["code", "refactor", "shell"],
  "env": { "HTTPS_PROXY": "http://127.0.0.1:7890" }
}
```

适用：安装并配置好 OpenCode CLI 后（`opencode --version` 确认）。默认以 `opencode acp` 启动。注意事项：opencode 自身默认权限全放行，wayang 默认注入 ask-all 的 `OPENCODE_CONFIG` 收回裁决权；若父进程已有 `OPENCODE_CONFIG`，wayang 不覆盖并会告警。想完全不干预用 `"protocol": { "gatePermissions": false }`，但此后其工具操作不经 wayang 审批。

## 常见配置任务

- 定并发数：`worker.maxConcurrency` 受机器与 provider 限流约束，建议从 3 起，观察限流报错再调。它是全局上限，与 worker 个数无关。
- 给 worker 加能力：把标签写进 `capabilities`（如 `"test"`、`"docs"`），并在 `description` 里说清楚，Controller 按这些信息路由任务。
- 限制可见目录：用 `permission.allowedDirs`（始终允许）与 `permission.sensitiveDirs`（命中需审批）。敏感目录列表优先级高于一切 allow 规则，只能选"问"或"拒"（`sensitiveMode`）。
- Controller 与 worker 用不同 provider：定义两个 provider，分别绑定 `controller.provider` 与 `worker.provider`：

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

## 校验与排错

配置在加载时统一校验，交互模式下报错后退出并提示 `Run \`wayang\` without arguments to configure.`；server 模式抛 `Invalid config: <错误>`。常见错误（文案摘自源码，`<id>` 为 worker ID）：

| 报错 | 原因与改法 |
| --- | --- |
| `workers.<id>.type "foo" is not supported (allowed: claude-code, acp, codebuddy, opencode)` | type 拼错，改为四个合法值之一 |
| `workers.<id>.type is required (allowed: claude-code, acp, codebuddy, opencode)` | 缺少 type 字段 |
| `workers.<id>.command is required for type "acp" (set workers.<id>.command to the ACP agent executable)` | 通用 acp 行必须写 `command` |
| `workers.<id>.<key> is not supported for type "claude-code" (claude-code uses cliPath)` | claude-code 行混入了 ACP 字段，删掉 `command`/`args`/`env`/`protocol`/`trustUpdatesAfterCancel` |
| `controller.provider "foo" not found`（worker.provider 同理） | 绑定的名字不在 `providers` 里，检查拼写 |
| `providers.<name>.apiKey is required (set WAYANG_LLM_API_KEY or configure in config file)` | key 缺失，填入文件或设环境变量 |
| `providers.<name>.contextWindowTokens must be a positive integer (got ...)` | 该字段须为正整数 |
| `permission.sensitiveMode must be 'ask' or 'deny' (got ...)` | 改为 `ask` 或 `deny` |

`maxConcurrency` 在配置加载时没有专门校验——填 0 或负数不会被拦截，请自行填 ≥1 的整数。`maxTurns`/`cliPath` 写在 ACP 行不会报错，但会各告警一次 no effect 提示。

## 迁移说明（0.9.3）

0.9.3 起 worker 类型改名：`codebuddy-acp` → `codebuddy`、`opencode-acp` → `opencode`。旧值仍然可用：加载时自动改写并打印一次

`Warning: worker type 'codebuddy-acp' is deprecated, use 'codebuddy' (workers.<id>)`

（opencode 同理）。配置文件无需修改，但建议尽早更新为新名字。

## 已知限制

通用 `acp` worker 的就绪检查只校验握手返回的 `protocolVersion === 1`，不判断登录状态。未登录的 CLI 可能表现为 `session/new` 超时，而不是明确的 auth-required 提示——遇到超时先确认 CLI 本身可用（手动跑一次对应命令并登录）。
