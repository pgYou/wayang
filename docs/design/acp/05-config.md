# 分册 05：配置 schema 与能力声明

- 主文档：`../worker-adapter-0.9.0.md`（v3 索引）。关联 issue：#25。基线：release/0.9.0 @ `7bfd1e2`。本册日期：2026-11-05。
- **契约归属**：超时数值与 `AcpTimeouts` 形状见冻结页 `00-interface-freeze.md` §2.1；`WORKER_TYPES` 与 `WorkerConfig` 增字段见其 §7 ③。本册写**完整配置面**：字段表、校验规则、默认启动方式、配置示例，以及能力声明对 controller / TUI / 审计的影响。
- 现状缺口（0.8.4）：`validateConfig`（src/types/config.ts:153）**完全不校验 `workers`**——写错 `type` 要到派发时才在 `createWorker` 抛错。provider 一多，配置错误的暴露点会从 1 个变成 N 个，本册的校验规则就是补这个缺口。

## 1. 类型与枚举

```ts
export type WorkerType = 'claude-code' | 'codebuddy-acp' | 'opencode-acp';
export const WORKER_TYPES: readonly WorkerType[] = ['claude-code', 'codebuddy-acp', 'opencode-acp'];
```

`WORKER_TYPES` 是唯一真源（`src/types/config.ts`）：`switch` 的 case、`validateConfig` 的允许值、错误文案、文档示例全部引用它。加 provider 时 `switch` 末尾的穷尽检查（`const _exhaustive: never = config.type`）让 `npm run lint` 直接报错，不会漏 case（02 分册 §1）。

## 2. `WorkerConfig` 扩展（`*-acp` 行新增字段）

| 字段 | 类型 | 默认 | 说明 / 校验 |
| --- | --- | --- | --- |
| `type` | `WorkerType` | **必填** | 允许值即 `WORKER_TYPES`。缺失或不在枚举内 → 加载期报错（不再拖到派发） |
| `command` | `string` | 由 provider 类的 `buildLaunch()` 提供 | 覆盖该 provider 的 ACP 可执行文件；相对路径不解析，要求可从 `PATH` 找到 |
| `args` | `string[]` | 同上 | 覆盖默认参数（`['--acp']` / `['acp']`） |
| `env` | `Record<string,string>` | `{}` | 与 `process.env` 合并后作为子进程环境（合并由 worker 层完成，冻结页 §2.1） |
| `protocol` | `AcpProtocolConfig` | 见 §3 | 超时、能力与权限闸覆盖（§3、§3.1）；不填即用 provider 默认 |
| `permissionMode` | `'client' \| 'agent'` | `'client'` | 见 04 分册 §6 |
| `maxTurns` / `cliPath` / `enable` / `emoji` / `description` / `capabilities` | — | 沿用 0.8.4 | `maxTurns` / `cliPath` 对 `*-acp` 不生效（见 §5） |

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
  /** opencode 权限闸注入开关，见 §3.1。默认 true；仅对 opencode-acp 生效，codebuddy-acp 忽略。 */
  gatePermissions?: boolean;
}
```

配置层把 `AcpProtocolConfig` 折成 `resolveAcpTimeouts` 的入参（冻结页 §2.1）；`gatePermissions` 不属于超时，由 worker 层在 `buildLaunch` 的 env 合并阶段消费（§3.1）。违例（`promptMs<0`、其余 ≤0）抛 `AcpError('protocol-mismatch')`。

### 3.1 `gatePermissions`：opencode 权限闸注入（实测依据 03 分册 §3.2）

- **为什么必须**：opencode 2.2.5 默认 agent 权限全 allow（仅 `.env` 读取 ask）——不注入时对 bash 与文件写（**含 workspace 外**）从不发 `session/request_permission`，越界写静默落盘，权限桥被整体旁路（04 分册 §9.2）。
- **注入内容**：`{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}`（ask-all，把每次工具执行的裁决权交回 wayang 权限桥）。
- **注入方式**：子进程 env `OPENCODE_CONFIG=<json>`，在 `buildLaunch` 的 env 合并阶段写入。实测确认**不影响用户全局 provider/model 配置**（不改写 `~/.config/opencode`）；用户也可自管 workspace 根 `opencode.json`（内容相同），两种方式均实测有效。
- **边界行为**（两个 warn 都进启动期日志，不报错、不阻断）：
  - `gatePermissions:false` → **不注入并 warn**：agent 的工具执行（含越界写）将不经审批直接落地，风险由配置者承担（安全边界旁注同 §6）。
  - 父 `process.env` 已有 `OPENCODE_CONFIG` → **不覆盖并 warn**：用户配置优先；权限闸是否生效取决于该配置的内容。
- **生效范围**：仅 `type:'opencode-acp'`；`codebuddy-acp` 原生即对副作用工具发请求，该字段忽略。

## 4. provider 默认启动方式（写在各自 `buildLaunch()` 里，不放 profile 表——表里的值必须和类里的兜底挨着看，分开放迟早对不上）

| type | command | args | 备注 |
| --- | --- | --- | --- |
| `codebuddy-acp` | `codebuddy` | `['--acp']` | 原生；主路径，实测 2026-11-05（2.180.0，03 分册 §2） |
| `opencode-acp` | `opencode` | `['acp']` | 原生，实测 2.2.5（03 分册 §3）；`gatePermissions !== false` 时在 env 合并阶段注入 `OPENCODE_CONFIG` 权限闸（§3.1） |

`maxTurns` 对 `*-acp` 不生效（ACP 没有「最大回合数」字段；回合上限由 agent 自己的配置决定）；加载期对 `*-acp` + `maxTurns` 给 warning 而不报错，避免存量配置直接失败。`cliPath` 同理：`claude-code` 用 `cliPath`，`*-acp` 用 `command`（校验规则 4 防混用）。

## 5. `validateConfig` 对 `workers` 段的校验规则（新增，src/types/config.ts）

1. `type` 必填且必须是 `WORKER_TYPES` 之一。缺失 → `workers.<id>.type is required (allowed: claude-code, codebuddy-acp, opencode-acp)`；未知 → `workers.<id>.type "foo" is not supported (allowed: …)`。文案必须带字段路径 + 允许值。
2. `type: 'puppet'` 写进 `workers` → 报错：`puppet is a built-in worker type, do not declare it under workers`。
3. `description` 必须非空字符串；`capabilities` 必须字符串数组；`emoji` 必须字符串。
4. `type === 'claude-code'`：`command` / `args` / `env` / `protocol` 一律禁止（提示「claude-code 用 cliPath」），避免两套启动语义混用。
5. `type` 为任一 `*-acp`：`command` 出现时必须非空字符串；`args` 必须字符串数组；`env` 必须 `Record<string,string>`；`protocol.*` 必须正数（`promptMs` 允许 0）、`protocol.gatePermissions` 必须是 boolean；`protocol.capabilities` 的键必须是已知键。
6. `permissionMode` 必须是 `'client'` 或 `'agent'`。
7. `enable === false` 的 worker 仍要校验形状（配置错误不因禁用而隐藏）。

## 6. 配置示例（可直接粘贴运行）

```json
{
  "workers": {
    "codebuddy": {
      "type": "codebuddy-acp",
      "description": "Tencent CodeBuddy Code agent (ACP, 主路径，实测 2.180.0)",
      "capabilities": ["code", "refactor", "shell"]
    },
    "opencode": {
      "type": "opencode-acp",
      "description": "OpenCode (native ACP, 实测 2.2.5)",
      "protocol": { "capabilities": { "permissionRequests": true } }
    }
  }
}
```

示例旁必须注明的安全边界（04 分册 §7）：client 声明不支持 `fs/*` / `terminal/*` 后，工具由 agent 自己执行；只有 agent 主动发 `request_permission` 时 wayang 才能拦。示例里不许出现 `type: 'acp'` 这类旧写法（校验规则 1 会拒绝并给出允许值）。opencode 行的权限闸默认开启（§3.1）；显式关闭写 `"protocol": { "gatePermissions": false }`——启动期 warn，此后 agent 的工具执行（含越界写）不经审批直接落地。

## 7. 能力声明对 controller / TUI / 审计的影响

- **controller prompt**：`buildWorkerList`（controller-prompt.ts:351）继续用 `capabilities` 字符串标签，并对 `*-acp` 类型追加 `[acp:<provider>]` 后缀（如 `[acp:codebuddy]`），让 controller 知道这是外部 agent（没有 `update_progress`/`done` 工具，靠回合结束收尾，中途消息只能回合边界交付）。这是**唯一需要改 controller prompt 的地方**，不改调度模型（主文档「不做」第 7 条）。
- **TUI**：零改动（冻结页 §7）。`ActiveWorkerInfo.workerType`/`emoji`（src/types/worker.ts:12-28）已够用；工具行展示沿用 `ToolCallRecord` 既有渲染；`getLiveStatus()` 两标志见 02 分册 §3。
- **transcript**：与 puppet / claude-code 同构（02 分册 §7），读取路径不变；`read_worker_conversation` / `get_worker_status` / `get_task_detail` 不为 provider 分叉。
- **审计**：`transport: 'acp'` + `provider: <config.type>` 两字段（04 分册 §4）；不新增文件、不新增格式。
- **能力差异矩阵**：`docs/develop/acp-capability-matrix.md`（新增），两 provider × 七列（流式 / 工具可见性 / 权限请求 / 取消 / resume / 中途注入 / 认证失败形态），值来自实测，写「未实测」而不是猜（06 分册 §5 的回填纪律）。
- **onboard 提示**：`src/onboard.ts` 初始化流程补一句「也可选填 ACP worker（codebuddy-acp / opencode-acp）」，不改默认生成内容。
