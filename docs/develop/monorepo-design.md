# Wayang Monorepo 分包架构设计

> 状态：第 2–3 节（拆包结构、职责分层）为定案，按 release/1.0.0 实际落地校准；第 4 节 core/cli 改造设计按评审决议定稿，作为实施规范。
> 本文取代旧版 `v1.0-monorepo-design.md`：蓝本目标已落地为现状，旧文退役；core/cli 改造设计为本次新增。
> 关联：`CHANGELOG.md` 的 v1.0.0 段；desktop 侧设计草稿见 `feat/desktop-m3` 分支 `docs/develop/desktop-app-design.md`。

## 1. 目标与原则

1.0 的两个交付物共用一套逻辑内核：

- **npm 包（CLI 产品）**：命令行工具 `wayang` / `waya`，发布链路与 0.9.x 保持一致；
- **Wayang Desktop**：Electron 桌面产品，安装包分发，不走 npm。

支撑目标的三条架构原则：

| 原则 | 含义 |
|---|---|
| 行为一致性 | 每个包的运行时代码**编译恰好一次**；任何交付物里的同一段代码出自同一次构建 |
| 宿主归应用 | core 不选择进程模型（依赖倒置）：进程宿主与通信策略由各 app 自定 |
| 发布收敛 | npm 上只暴露一个 CLI 发布单元；其余子包 private、永不发布 |

## 2. 拆包结构

### 2.1 目录布局

```
wayang-ai/                      ← workspace 根
├── apps/                       ← 应用包：可独立交付的构建边缘
│   ├── cli/                    ← 终端产品（TUI + stdio 宿主）
│   └── desktop/                ← Electron 产品（在 feat/desktop-m3 分支推进，设计见 desktop-app-design.md）
└── packages/                   ← 库包：编译一次、被 apps 消费产物
    ├── core/                   ← 逻辑内核（服务端 + 客户端 SDK）
    └── protocol/               ← 类型 + RPC 契约 + transport
```

root `package.json` 的 `workspaces: ["apps/*", "packages/*"]`。

### 2.2 包清单

| 包 | npm 名 | 职责 | 依赖 |
|---|---|---|---|
| `packages/protocol` | `@wayang-ai/protocol` | 共享类型（config / conversation / signal / task / worker / acp / inquiry / state）；RPC 契约（`METHOD` / `NOTIFY` / `RpcError`）；`RpcClient` / `RpcServer`；NDJSON `LineCodec` 与 stream / MessagePort transport；配置归一化与校验纯函数（`validateConfig` 等） | 无 |
| `packages/core` | `@wayang-ai/core` | 逻辑内核：Supervisor 装配、controller / worker agents（puppet、claude-code、ACP）、任务引擎、信号、权限、会话与状态持久化、headless server（`serverMain` / `runWayangServer`）、客户端 SDK（`RemoteSupervisor`） | protocol |
| `apps/cli` | `@wayang-ai/cli` | 终端产品：参数解析（`--config` / `--wayang-root` / `-w`）、onboard 与会话选择交互、TUI（React + Ink）、进程宿主（spawn `server-entry.js`）、发布产物载体 | core、protocol |
| `apps/desktop` | `@wayang-ai/desktop` | 占位：仅 `package.json` + `README`；Electron 壳（UtilityProcess 宿主）在 `feat/desktop-m3` 分支开发，设计草稿另见 | （规划：core、protocol） |

### 2.3 构建模型要点

- **库编译恰好一次**：tsup `preserveModules` 镜像 `src/` 目录结构；`tsc` 产相邻 d.ts；exports 指向 dist，子路径 import 全仓零改动；
- **兄弟包 external**：core 的构建不内联 protocol，引用其 dist——任何一段运行时代码只存在一份编译输出；
- **apps 内联**：cli 用 tsup `noExternal: [/^@wayang-ai\//]` 读库 dist 内联；desktop 用 electron-vite resolve 到库 dist 后内联；全 ESM 纪律（任何边缘输出 CJS 即为事故）；
- **MCP bridge 是 core 的内部运行期资产**：桥源码在 core，但由 apps/cli 的 tsup 作为第三入口直出（读 core 源码构建自包含 bundle，并经 `define` 把 `@wayang-ai/cli` 版本烤进 MCP initialize 应答的 `serverInfo.version`）；core 自身只构建库产物，不再产出桥 bundle、app 也不再复制；
- **构建拓扑**：turbo 编排 build / lint / test（`^build` 依赖 + 输入哈希缓存）；所有门槛一律经 `turbo run`，禁止绕过 turbo 直跑下游包脚本（陈旧产物纪律）。

### 2.4 发布模型

现状（release/1.0.0）：

- 发布单元是根包 `wayang-ai`：`bin` `wayang` / `waya` → `apps/cli/dist/cli.js`；`files: ["apps/cli/dist", "!apps/cli/dist/**/*.map"]`；`prepublishOnly: npm run build`；
- tarball 含三个入口：`cli.js`（TUI）、`server-entry.js`（server 宿主）、`mcp-bridge-entry.js`（MCP 桥，cli tsup 第三入口直出）；
- 子包全部 `private: true`，任何情况下不发布；prerelease 版本按首段自动 dist-tag（`1.0.0-alpha.0` → `alpha`），不顶掉 `latest`；
- desktop 走 electron-builder 安装包（dmg / exe 等），不走 npm。

目标（待落实，随 core/cli 改造批次推进）：

- **根包退役**：根 `package.json` 退化为纯 workspace 根（编排脚本与开发依赖），不再承载 `bin` / `files` / `prepublishOnly` 与运行时依赖声明；
- **`@wayang-ai/cli` 转正为对外发布单元**：`bin` `wayang` / `waya` 随迁，命令名与用户体验不变；
- 发布链路语义不变：tag 驱动、prerelease dist-tag、版本号与 tag 一致性校验；
- **待讨论**：release workflow 的打包目录与 `files` 路径调整、版本号从根包迁至 cli 包的方式、根包剩余职责的最终清单。

## 3. 职责分层

### 3.1 protocol —— 类型与 RPC 契约

- 定位：两个 app 与 core 之间全部共享语义的单点来源；
- 内容：领域类型桶（`types/`）、RPC 信封 / 错误码 / 状态机（`rpc/protocol.ts`）、客户端（`RpcClient`、`RemoteStateStore`）、服务端（`RpcServer`）、传输（`LineCodec`、`createTransport`、`createStreamTransport`、MessagePort 适配）；
- 纪律：零业务逻辑、零 Node 内建依赖、零文件系统访问——保证类型可安全进浏览器环境（desktop renderer 只允许 import protocol 的类型）。

### 3.2 core —— 领域逻辑（无头内核）

- 定位：全部业务语义所在；不选择进程模型、不渲染 UI、不解析命令行参数、不决定 spawn 策略；
- 服务端面：`serverMain` / `runWayangServer`（io 可注入）、Supervisor（装配根，无业务逻辑）、TaskExecuteEngine、ControllerLoop、SignalQueue、三种 worker 实现、controller / worker 工具面、PermissionTransport、会话与状态持久化（JsonFile / JsonlFile）；
- 客户端面：`RemoteSupervisor` 等客户端 SDK（cli 与 desktop 共用，跑在宿主进程）；
- 已知越界负债（第 4 节改造对象）：`onboard.ts` 混有 prompts 终端交互与配置文件读取；`dataDir` 与工作区策略耦合，存在路径反推假设。

### 3.3 cli —— 宿主与 TUI

- 定位：终端产品 + 进程宿主；
- 宿主职责：参数解析（`parseCliArgs` / `resolveWayangRoot`）、配置文件定位与 onboard 引导、会话选择、spawn 瘦 `server-entry.js`、stdio 上的 NDJSON-RPC、退出协议（SHUTDOWN RPC → 5s 宽限 → SIGKILL；server 意外死亡则终端报错退出）；
- TUI 职责：React + Ink 的唯一渲染者，经 `RemoteSupervisor` / `RemoteStateStore` 消费 core，自身不含业务逻辑。

### 3.4 desktop —— Electron 壳（占位 / 推进中）

- 双进程结构：main 进程当 RPC 客户端 + UtilityProcess 当 server 宿主（`messagePortToStreams` 接缝），renderer 只经 preload 白名单触达；
- 详细设计（草稿）见 `feat/desktop-m3` 分支 `docs/develop/desktop-app-design.md`。

### 3.5 依赖方向与边界规则（check-boundaries）

```
protocol ◀── core ◀──┬── cli（apps）
                     └── desktop（apps）      apps 之间零依赖
```

`scripts/check-boundaries.mjs` 机械检查的规则：

| 规则 | 内容 |
|---|---|
| 依赖方向 | protocol 不依赖任何兄弟包；core 只依赖 protocol；cli / desktop 依赖 core + protocol；cli 与 desktop 互不 import、互不引用对方产物 |
| 跨包命名 | 跨包引用必须走 `@wayang-ai/*` 包名；`@/` 是包内别名，必须解析到本包 `src/` 内的文件；相对导入不许爬出包根 |

导入纪律与示例（现状约束）：

- **core 包内一律相对导入**（d.ts 可移植，包内 `@/` 别名已全部改写）：
  `import type { WorkspaceRef } from '../infra/workspace-registry';`
- **跨包一律 `@wayang-ai/*` 子路径**：
  `import { getSession } from '@wayang-ai/core/infra/session-helpers';`（cli 引 core）
  `import type { TaskDetail } from '@wayang-ai/protocol';`
- 渲染层纪律：desktop renderer 只 import protocol 的类型与自身 IPC 胶水，禁止 core（Node 内建依赖进浏览器环境必炸）。

## 4. core/cli 改造设计（定稿）

### 4.0 背景与工作流

- 改造目标：让 core 退化为「**零路径假设、零终端交互、纯配置对象驱动**」的无头逻辑内核；
- 背景：desktop 第一版迭代确认还需改 core/cli 逻辑；先完成本节两项改造作为阶段成果，合入 main 后发布 `1.0.0-alpha.1`；
- 分支工作流：从 `release/1.0.0` 切 `feat/core-app-decouple` → 完成改造 + 全量单测 / E2E → 合回 `release/1.0.0` → `feat/desktop-m3` rebase 到新基线后再推进 Part 2。

### 4.1 改造一：配置解析上移

**职责与纯函数归属**

- 配置的纯函数归 `packages/protocol`（零 Node 依赖，cli / desktop / core 三方共享）：`validateConfig`、`collectWorkerWarnings`、`collectProviderWarnings`、`normalizeWorkerTypes`、`resolveModelRef`；
- 文件读取、env 兜底、onboard 交互 prompts 归 `apps/cli`：宿主全权负责定位配置文件、读写 JSON、合并环境变量，产出合法的 `WayangConfig` 对象；
- core 只以配置对象形式经 `SupervisorOptions` / `ServerOptions` 注入，不感知配置来源——不读盘、不读 env、不做交互引导。

**运行时热更（粒度化 update 方法）**

热更不做单一 `UPDATE_CONFIG` 大方法，每个方法的 schema 即字段白名单：

| 方法 | 负载（字段白名单） |
|---|---|
| `updateProvider(name, patch)` | `{baseURL?, apiKey?, type?}` |
| `updateModel(name, patch)` | `{provider?, contextWindowTokens?, temperature?, maxOutputTokens?}` |
| `addProvider(name, def)` | `{type, baseURL, apiKey}` |
| `addModel(name, def)` | `{provider, contextWindowTokens, temperature?, maxOutputTokens?}` |
| `removeProvider(name)` | — |
| `removeModel(name)` | — |
| `updateControllerModel(model)` | — |
| `updateWorkerSettings(patch)` | `{model?, maxConcurrency?, toolChoice?}` |

第三方 agent 定义（workers 节点）不纳入 alpha 热更范围，记为后续扩展。

**语义**

1. **声明值与生效值分离**：所有方法只改声明值，生效发生在消费点惰性解析——worker 于下一次 spawn、controller 于每一 turn。进行中的 turn / spawn 继续使用旧的 `ResolvedModel` 快照，连接与参数切换永远发生在边界上。controller 的模型解析从「启动时一次定型」改为逐 turn 解析（或等价的更新时缓存失效）。
2. **依赖是引用不是拷贝**：provider / model / 绑定构成三层引用链，update 不回写、不触发任何下游重写。update / add / remove 的返回值带影响面清单（从引用图派生，供宿主 UI 展示「哪些绑定受影响、下一轮生效」）。
3. **引用完整性**：add 严格拒绝重名；`removeProvider` 被任何 model 条目引用、`removeModel` 被任何绑定引用时拒绝并返回引用清单——不级联、无 force；新增 / 修改条目一律通过同一套 protocol 校验器。

**验收标准**

- CLI 行为与 0.9.9 逐项一致；
- core 零 prompts 依赖、零配置来源感知；
- desktop 可用 protocol 纯函数在发起更新前本地预校验；
- 新增 provider + model 并改绑 worker 后，下一次 spawn 即使用新链，全程无重启；进行中任务不受影响。

### 4.2 改造二：rootDir（dataDir）与 controller-workspace 解耦

**双轨注入**

- 废除单一模糊的 `dataDir` + `workspaceDir` 二元组，拆分为两组显式契约：`StoragePaths {dataDir, logDir, cacheDir}` 与 `WorkspacePolicy {controllerWorkspace, defaultWorkerWorkspace}`；
- 类型定义在 `packages/protocol`；值由宿主层（cli bootstrap / desktop main）构造后经 `SupervisorOptions` / `SystemContext` 注入。二者不进入 `WayangConfig` 配置 schema——部署事实与用户配置分离，亦不参与热更。

**controllerWorkspace 双锚点与 cwd 禁令**

- `controllerWorkspace` 统一承担两个锚点：controller 的任务工作区基准 + controller 执行工具的起点（cwd 语义）；
- core 禁止依赖进程启动目录：check-boundaries 新增「core 源码禁止 `process.cwd()`」规则；执行改造时做一次 cwd 审计（grep `process.cwd` 与相对路径解析锚点），确需「启动目录」语义的消费点改用 `controllerWorkspace` 或显式参数承接。

**取值**

- `dataDir` 由既有 `--wayang-root` 派生，`logDir` / `cacheDir` 为其子目录（物理布局不变）；
- `controllerWorkspace` 与 `defaultWorkerWorkspace` 默认值均为 `<dataDir>/workspace`（CLI 行为与 0.9.9 逐项一致）；
- alpha 不新增任何 CLI flag：desktop 场景经程序化注入不同值；`--workspace-dir` 记为后续候选。

**消费点改造（四个）**

| 消费点 | 改造 |
|---|---|
| `general-workspace` | 删除 `<dataDir>/workspace` 反推，改读注入的 `defaultWorkerWorkspace` |
| `add-task` | 派发边界统一以 `controllerWorkspace` 为基准 |
| `system-context` | 日志路径改用注入的 `logDir`，注入替代推导 |
| `mcp-transport` | MCP bridge socket 目录改用注入的 `cacheDir` |

**验收标准**

- core 零路径反推、零 `process.cwd`（可 grep 验证）；
- CLI 默认路径逐项一致、无新增参数；
- 注入自定义 `StoragePaths` 后 worker 默认工作区不受影响（正交性单测）；
- cwd 审计结论入改造报告。
