# 分册 05：配置 schema 与能力声明

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05。
- **契约归属**：超时数值与 `AcpTimeouts` 形状见冻结页 `00-interface-freeze.md` §2.1；`WORKER_TYPES` 与 `WorkerConfig` 增字段见其 §7 ③。本册写**完整配置面**：字段表、校验规则、默认启动方式、配置示例，以及能力声明对 controller / TUI / 审计的影响。
- 现状缺口（0.8.4）：`validateConfig`（src/types/config.ts:153）**完全不校验 `workers`**——写错 `type` 要到派发时才在 `createWorker` 抛错。provider 一多，配置错误的暴露点会从 1 个变成 N 个，本册的校验规则就是补这个缺口。

## 1. 类型与枚举

```ts
export type WorkerType = 'claude-code' | 'acp' | 'codebuddy' | 'opencode';
export const WORKER_TYPES: readonly WorkerType[] = ['claude-code', 'acp', 'codebuddy', 'opencode'];
```

`WORKER_TYPES` 是唯一真源（`src/types/config.ts`）：`switch` 的 case、`validateConfig` 的允许值、错误文案、文档示例全部引用它。加 provider 时 `switch` 末尾的穷尽检查（`const _exhaustive: never = config.type`）让 `npm run lint` 直接报错，不会漏 case（02 分册 §1）。

旧拼写 `codebuddy-acp` / `opencode-acp` 在配置解析出口（`loadConfig` → `normalizeWorkerTypes`）一次性规范化为新值并输出弃用告警（形如 `worker type 'codebuddy-acp' is deprecated, use 'codebuddy'`）；校验与所有使用方只见新值。存量配置无需改动。

## 2. `WorkerConfig` 扩展（ACP 行新增字段）

| 字段 | 类型 | 默认 | 说明 / 校验 |
| --- | --- | --- | --- |
| `type` | `WorkerType` | **必填** | 允许值即 `WORKER_TYPES`。缺失或不在枚举内 → 加载期报错（不再拖到派发） |
| `command` | `string` | 由 provider 类的 `buildLaunch()` 提供；`type: 'acp'` 时**必填** | 覆盖该 provider 的 ACP 可执行文件；相对路径不解析，要求可从 `PATH` 找到 |
| `args` | `string[]` | 同上（`type: 'acp'` 默认 `[]`） | 覆盖默认参数（`['--acp']` / `['acp']`） |
| `env` | `Record<string,string>` | `{}` | 与 `process.env` 合并后作为子进程环境（合并由 worker 层完成，冻结页 §2.1） |
| `protocol` | `AcpProtocolConfig` | 见 §3 | 超时、能力与权限闸覆盖（§3、§3.1）；不填即用 provider 默认 |
| `permissionMode` | `'client' \| 'agent'` | `'client'` | 见 04 分册 §6 |
| `trustUpdatesAfterCancel` | `boolean` | `false` | 仅 `type: 'acp'` 生效：取消后到达的 `session/update` 是否仍写入 transcript；默认 false（保守丢弃并计数）。专用 provider 行沿用各自实测策略，忽略该字段 |
| `maxTurns` / `cliPath` / `enable` / `emoji` / `description` / `capabilities` | — | 沿用 0.8.4 | `maxTurns` / `cliPath` 对 ACP 行不生效（见 §5） |

## 3. `AcpProtocolConfig`（字段名与冻结页 §2.1 的 `AcpTimeouts` 对齐，不再另起一套）

```ts
export interface AcpProtocolConfig {
  handshakeMs?: number;        // 默认 15000；必须 > 0
  sessionNewMs?: number;       // 默认 30000；必须 > 0
  promptMs?: number;           // 默认 0 = 不限；>= 0；>0 到点走取消路径收口为 cancelled（冻结页 §4 注）
  permissionMs?: number;       // 默认 300000；必须 > 0
  cancelGraceMs?: number;      // 默认按 stopPolicy()（codebuddy 8000 / opencode 5000）；必须 > 0
  sigtermWaitMs?: number;      // 默认 2000；必须 > 0
  /** 覆盖实测观察到的能力（permissionRequests / toolCalls），如实表达、不做降级假设。 */
  capabilities?: Partial<Pick<AcpCapabilities, 'permissionRequests' | 'toolCalls'>>;
  /** opencode 权限闸注入开关，见 §3.1。默认 true；仅对 opencode 生效，codebuddy 忽略。 */
  gatePermissions?: boolean;
}
```

配置层把 `AcpProtocolConfig` 折成 `resolveAcpTimeouts` 的入参（冻结页 §2.1）；`gatePermissions` 不属于超时，由 worker 层在 `buildLaunch` 的 env 合并阶段消费（§3.1）。违例（`promptMs<0`、其余 ≤0）抛 `AcpError('protocol-mismatch')`。

### 3.1 `gatePermissions`：opencode 权限闸注入（实测依据 03 分册 §3.2）

- **为什么必须**：opencode 2.2.5 默认 agent 权限全 allow（仅 `.env` 读取 ask）——不注入时对 bash 与文件写（**含 workspace 外**）从不发 `session/request_permission`，越界写静默落盘，权限桥被整体旁路（04 分册 §9.2）。
- **注入内容**：`{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}`（ask-all，把每次工具执行的裁决权交回 wayang 权限桥）。
- **注入方式**：子进程 env `OPENCODE_CONFIG` 指向**门禁文件路径**，在 `buildLaunch` 的 env 合并阶段写入。实测确认**不影响用户全局 provider/model 配置**（不改写 `~/.config/opencode`）；用户也可自管 workspace 根 `opencode.json`（内容相同），两种方式均实测有效。
- **文件生命周期（#62）**：门禁文件写入 **worker 专属目录** `<sessionDir>/workers/<workerId>/opencode-acp-gate.json`（不放共享会话根目录——并发 opencode worker 互不干扰，清理也无竞态）；每次 launch 覆盖写入、不信任陈旧内容；run 结束（含失败、取消路径）在 finally 中删除。仅 wayang 自身异常终止时可能残留（惰性 JSON，无副作用）。
- **边界行为**：
  - `permissionMode:'agent'` → **不注入并 warn**（优先级高于 `gatePermissions`，04 分册 §6）：agent 自管权限，wayang 不注入闸也不桥接审批。
  - `gatePermissions:false` → **不注入并 warn**：agent 的工具执行（含越界写）将不经审批直接落地，风险由配置者承担（安全边界旁注同 §6）。
  - 父 `process.env` / `workers.<id>.env` 已有 `OPENCODE_CONFIG` → **校验后放行或拒绝（#62，不再静默告警）**：读取该值（文件路径或内联 JSON），仅当 ruleset **含 ask-all 规则**且 `allow` 规则只涉及显式只读豁免表（`read`/`grep`/`glob`/`list`，**精确匹配**，不接受前缀/子串）时放行（warn 一次「已校验」）；否则**拒绝启动**，任务结果携带原因与修复建议（补 ask-all 规则，或改用上面两条显式接管路径）。**无匹配规则 = 默认拒绝**（fail-closed：无法证明受闸 → 不启动）。
- **生效范围**：仅 `type:'opencode'`；`codebuddy` 原生即对副作用工具发请求，该字段忽略。

## 4. provider 默认启动方式（写在各自 `buildLaunch()` 里，不放 profile 表——表里的值必须和类里的兜底挨着看，分开放迟早对不上）

| type | command | args | 备注 |
| --- | --- | --- | --- |
| `acp` | **配置必填**（`workers.<id>.command`） | `[]` | 通用类型（§4.1），完全由配置驱动，无内置默认 |
| `codebuddy` | `codebuddy` | `['--acp']` | 原生；主路径，实测 2026-11-05（2.180.0，03 分册 §2）；PATH 上只有别名 `cbc` 时回退到 `cbc` |
| `opencode` | `opencode` | `['acp']` | 原生，实测 2.2.5（03 分册 §3）；`gatePermissions !== false` 时在 env 合并阶段注入 `OPENCODE_CONFIG` 权限闸（§3.1） |

`maxTurns` 对 ACP 行不生效（ACP 没有「最大回合数」字段；回合上限由 agent 自己的配置决定）；加载期对 ACP 行 + `maxTurns` 给 warning 而不报错，避免存量配置直接失败。`cliPath` 同理：`claude-code` 用 `cliPath`，ACP 行用 `command`（校验规则 4 防混用）。

### 4.1 通用 `acp` 类型（0.9.3 新增）

`type: 'acp'` 由配置声明式驱动，不需要为每个 ACP CLI 写子类：启动、就绪判定与停止策略全部走 `BaseAcpWorker` 的默认实现（`GenericAcpWorker` 只覆写 `stopPolicy` 以读取 `trustUpdatesAfterCancel`）。专用类（cbc 回退、8000ms 宽限、opencode 权限闸）的定制不属于通用类型。

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `command` | **是** | — | ACP agent 可执行文件；缺失 → 加载期报错 `workers.<id>.command is required for type "acp"` |
| `args` | 否 | `[]` | 传给子进程的参数 |
| `env` | 否 | `{}` | 与 `process.env` 合并后作为子进程环境 |
| `permissionMode` | 否 | `'client'` | 同 04 分册 §6 |
| `protocol` | 否 | 超时矩阵默认 | `AcpProtocolConfig`（§3）；`cancelGraceMs` 默认 5000 |
| `trustUpdatesAfterCancel` | 否 | `false` | 取消后的 `session/update` 是否仍写入 transcript（§2） |

就绪判定用基类默认（`protocolVersion === 1`），不做 CLI 专属探测——登录态归因（auth-required）目前只在 codebuddy / opencode 两个实测 provider 上有依据。

## 5. `validateConfig` 对 `workers` 段的校验规则（新增，src/types/config.ts）

1. `type` 必填且必须是 `WORKER_TYPES` 之一。缺失 → `workers.<id>.type is required (allowed: claude-code, acp, codebuddy, opencode)`；未知 → `workers.<id>.type "foo" is not supported (allowed: …)`。文案必须带字段路径 + 允许值。旧值 `codebuddy-acp` / `opencode-acp` 在校验前已被规范化（§1）。
2. `type: 'puppet'` 写进 `workers` → 报错：`puppet is a built-in worker type, do not declare it under workers`。
3. `description` 必须非空字符串；`capabilities` 必须字符串数组；`emoji` 必须字符串。
4. `type === 'claude-code'`：`command` / `args` / `env` / `protocol` / `trustUpdatesAfterCancel` 一律禁止（提示「claude-code 用 cliPath」），避免两套启动语义混用。
5. `type` 为任一 ACP 类型：`command` 出现时必须非空字符串，且 `type: 'acp'` 时必填（§4.1）；`args` 必须字符串数组；`env` 必须 `Record<string,string>`；`trustUpdatesAfterCancel` 必须是 boolean；`protocol.*` 必须正数（`promptMs` 允许 0）、`protocol.gatePermissions` 必须是 boolean；`protocol.capabilities` 的键必须是已知键。
6. `permissionMode` 必须是 `'client'` 或 `'agent'`。
7. `enable === false` 的 worker 仍要校验形状（配置错误不因禁用而隐藏）。

## 6. 配置示例（可直接粘贴运行）

```json
{
  "workers": {
    "codebuddy": {
      "type": "codebuddy",
      "description": "Tencent CodeBuddy Code agent (ACP, 主路径，实测 2.180.0)",
      "capabilities": ["code", "refactor", "shell"]
    },
    "opencode": {
      "type": "opencode",
      "description": "OpenCode (native ACP, 实测 2.2.5)",
      "protocol": { "capabilities": { "permissionRequests": true } }
    },
    "mycli": {
      "type": "acp",
      "command": "my-cli",
      "args": ["acp"],
      "description": "任意 ACP CLI（配置驱动，字段见 §4.1）"
    }
  }
}
```

示例旁必须注明的安全边界（04 分册 §7）：client 声明不支持 `fs/*` / `terminal/*` 后，工具由 agent 自己执行；只有 agent 主动发 `request_permission` 时 wayang 才能拦。示例里不许出现 `codebuddy-acp` / `opencode-acp` 这类旧拼写（会触发弃用告警并被规范化为新值）。opencode 行的权限闸默认开启（§3.1）；显式关闭写 `"protocol": { "gatePermissions": false }"`（或 `permissionMode: "agent"`）——启动期 warn，此后 agent 的工具执行（含越界写）不经审批直接落地；继承的 `OPENCODE_CONFIG` 会被校验，不含 ask-all 规则即拒绝启动（§3.1）。

## 7. 能力声明对 controller / TUI / 审计的影响

- **controller prompt**：`buildWorkerList`（controller-prompt.ts）继续用 `capabilities` 字符串标签，并对 ACP 类型追加 `[acp:<provider>]` 后缀（显式映射：`codebuddy` → `[acp:codebuddy]`、`opencode` → `[acp:opencode]`、`acp` → `[acp:<command>]`，command 缺失回退 `[acp:acp]`），让 controller 知道这是外部 agent（没有 `update_progress`/`done` 工具，靠回合结束收尾，中途消息只能回合边界交付）。这是**唯一需要改 controller prompt 的地方**，不改调度模型（主文档「不做」第 7 条）。
- **TUI**：零改动（冻结页 §7）。`ActiveWorkerInfo.workerType`/`emoji`（src/types/worker.ts:12-28）已够用；工具行展示沿用 `ToolCallRecord` 既有渲染；`getLiveStatus()` 两标志见 02 分册 §3。
- **transcript**：与 puppet / claude-code 同构（02 分册 §7），读取路径不变；`read_worker_conversation` / `get_worker_status` / `get_task_detail` 不为 provider 分叉。
- **审计**：`transport: 'acp'` + `provider: <config.type>` 两字段（04 分册 §4）；不新增文件、不新增格式。
- **能力差异矩阵**：`docs/develop/acp-capability-matrix.md`（新增），两 provider × 七列（流式 / 工具可见性 / 权限请求 / 取消 / resume / 中途注入 / 认证失败形态），值来自实测，写「未实测」而不是猜（06 分册 §5 的回填纪律）。
- **onboard 提示**：`src/onboard.ts` 初始化流程补一句「也可选填 ACP worker（acp / codebuddy / opencode）」，不改默认生成内容。
