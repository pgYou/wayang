# Wayang Monorepo 分包架构设计

> 状态：第 2–3 节（拆包结构、职责分层）为定案，按 release/1.0.0 实际落地校准；第 4 节改造执行计划为待评审稿。
> 本文取代旧版 `v1.0-monorepo-design.md`：蓝本目标已落地为现状，旧文退役；core/cli 改造计划为本次新增。
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
│   └── desktop/                ← Electron 产品（占位，M3 在 feat/desktop-m3 推进）
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
- **MCP bridge 是 core 的内部运行期资产**：core 双入口构建，`mcp-bridge-entry.js` 平铺在 `core/dist/` 根；app 构建脚本机械复制到宿主入口同目录，缺失即构建期失败；
- **构建拓扑**：turbo 编排 build / lint / test（`^build` 依赖 + 输入哈希缓存）；所有门槛一律经 `turbo run`，禁止绕过 turbo 直跑下游包脚本（陈旧产物纪律）。

### 2.4 发布模型

现状（release/1.0.0）：

- 发布单元是根包 `wayang-ai`：`bin` `wayang` / `waya` → `apps/cli/dist/cli.js`；`files: ["apps/cli/dist", "!apps/cli/dist/**/*.map"]`；`prepublishOnly: npm run build`；
- tarball 含三个入口：`cli.js`（TUI）、`server-entry.js`（server 宿主）、`mcp-bridge-entry.js`（MCP 桥，复制进入）；
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

## 4. core/cli 改造执行计划（待评审）

### 4.0 背景与工作流

- 改造目标（源自《Wayang Desktop 与 Core 解耦宏观架构方案》Part 1，本文只做执行计划化，不新增架构决策）：让 core 退化为「**零路径假设、零终端交互、纯配置对象驱动**」的无头逻辑内核；
- 背景：desktop 第一版迭代确认还需改 core/cli 逻辑；先完成本节两项改造作为阶段成果，合入 main 后发布 `1.0.0-alpha.1`；
- 分支工作流：从 `release/1.0.0` 切 `feat/core-app-decouple` → 完成改造 + 全量单测 / E2E → 合回 `release/1.0.0` → `feat/desktop-m3` rebase 到新基线后再推进 Part 2。

### 4.1 改造一：配置解析上移

**动机**

1. `packages/core/src/onboard.ts` 混杂两个职责：① 交互式 CLI 引导（依赖 `prompts` 终端库，不应留在无头 core）；② 文件读取 + 环境变量注入 + Schema 校验（`loadConfig`）；
2. 同一配置在一次启动中被解析两次：客户端 `bootstrap.ts` 调一次 `loadConfig(configPath)`，服务端 `runWayangServer` 又拿 `configPath` 读盘解析一次；
3. desktop 主进程无法按自身目录规范（`app.getPath('userData')`）接管配置装载，设置页也没有运行时热更新通道。

**方案要点**

- 剥离终端交互：`onboard.ts` 中的 `prompts` 交互式引导迁入 `apps/cli`；core 对终端交互库的依赖清零；
- 纯配置对象注入：App 层（CLI 或 desktop main 进程）全权负责定位配置文件路径、读写 JSON、合并环境变量，产出合法的 `WayangConfig` 对象；`SupervisorOptions` 直接接收 `config: WayangConfig`；`WayangServerOptions` 支持宿主直传（或经初始化握手传入），不再强制 server 自己读 `--config` 文件；
- core（或 protocol）仅保留纯函数式的配置归一化与校验能力；
- 新增配置热更新 RPC：protocol 新增 `METHOD.UPDATE_CONFIG`，宿主在运行期把更新后的 `WayangConfig` 推给 Supervisor 动态替换（Provider、Model、`maxConcurrency`、权限配置等），无需重启会话进程。

**影响面**

- `packages/core`：`onboard.ts`（拆分）、`server/wayang-server.ts`、`services/supervisor.ts`（SupervisorOptions）；
- `packages/protocol`：新增 `UPDATE_CONFIG` 方法定义与负载类型；
- `apps/cli`：`bootstrap.ts`（配置装载收口）、新增交互式 onboard 模块；
- `apps/desktop`（后续阶段消费）：main 进程配置装载与设置页热更新。

**验收标准**

- core 产物不再依赖 `prompts`（构建与运行时依赖均移除）；
- server 启动不再自行读盘解析配置；同一配置在一次启动中只解析一次；
- CLI 现有行为 100% 兼容（`--config`、环境变量合并、onboard 引导体验一致），全量单测 / E2E 通过；
- `UPDATE_CONFIG` 生效后不重启即可变更 Provider / Model / `maxConcurrency`。

**待讨论**

- `UPDATE_CONFIG` 可热更字段的白名单，与不可热更字段（存储路径类）的拒绝语义；
- 归一化 / 校验纯函数最终归属 core 还是 protocol；
- `--config` 文件路径参数在 server 侧的兼容过渡期长度（一次性切换还是双轨保留）。

### 4.2 改造二：rootDir（dataDir）与 controller-workspace 解耦

**动机**

1. 耦合点一（默认工作区硬编码反推）：`packages/core/src/infra/general-workspace.ts` 将无代码库任务的默认工作区硬编码反推为 `<dataDir>/workspace`；当 desktop 按 macOS 规范把应用数据放到 `~/Library/Application Support/Wayang` 后，worker 默认会去 Application Support 下写文件，违背系统规范；
2. 耦合点二（派发边界与自身起点混用）：`packages/core/src/services/tools/add-task.ts` 的 `validateDeclaredWorkspace` 锚定 `userHome`（`~`）+ `permission.extraWorkspaceRoots`，而默认任务工作区取自 `ctx.workspaceDir`——存储位置与工作区策略没有分轨。

**方案要点**

- 废除单一模糊的 `dataDir` + `workspaceDir` 二元组，拆分为两组显式参数注入 `Supervisor` / `SystemContext`：

| 契约分组 | 字段 | 职责 | CLI 注入值 | Desktop 注入值（macOS） |
|---|---|---|---|---|
| StoragePaths | `dataDir` | 会话持久化、`workspaces.json`、全局 skills | `~/.wayang`（或 `--wayang-root`） | `~/Library/Application Support/Wayang` |
| | `logDir` | 会话日志输出目录 | `<sessionDir>` | `~/Library/Logs/Wayang/sessions/<id>` |
| | `cacheDir` | 临时文件、MCP socket、缓存 | `<sessionDir>/.mcp` | `~/Library/Caches/<BundleId>` |
| WorkspacePolicy | `controllerCwd` | Controller 读 `AGENTS.md` 与 `search_files` 的起点 | 启动时 `process.cwd()` | `~`（`os.homedir()`） |
| | `controllerWorkspace` | Controller 受控根边界（只能在此树下派发 worker 子目录与 `allowedDirs`） | `userHome`（`~`） | `~` 或配置的受控根 |
| | `defaultWorkerWorkspace` | 未显式指定项目目录时的默认 worker 工作区（原 `generalWorkspaceDir`） | `<dataDir>/workspace` | `~/.agents/wayang-workspace` |

- core 内部消费点改造：`general-workspace.ts` 不再从 `sessionDir` 向上反推，改读 `workspacePolicy.defaultWorkerWorkspace`；`add-task.ts` 的边界校验基准改为 `workspacePolicy.controllerWorkspace`；`system-context.ts` 日志路径改 `${storagePaths.logDir}/wayang.log`；`mcp-transport.ts` 的 MCP bridge socket 目录改用 `storagePaths.cacheDir`。

**影响面**

- `packages/core`：`infra/general-workspace.ts`、`services/tools/add-task.ts`、`system-context.ts`、MCP transport、`SupervisorOptions` / `SystemContext` 契约；
- `apps/cli`：bootstrap 处按现状值注入（见上表 CLI 列）；
- `apps/desktop`（后续阶段）：按 macOS 规范注入。

**验收标准**

- core 内不再存在从 `sessionDir` / `dataDir` 反推 workspace 的路径假设（可 grep 验证）；
- 任务派发边界校验统一以 `controllerWorkspace` 为基准，默认行为与现状一致（home 内放行）；
- CLI 按现状值注入后，全部默认路径与现状逐项一致，全量单测 / E2E 通过；
- 注入自定义 `StoragePaths`（如 Application Support）不改变 worker 默认工作区——有单测覆盖该正交性。

**待讨论**

- `StoragePaths` / `WorkspacePolicy` 的最终字段命名与放置层级（SupervisorOptions 顶层 vs SystemContext 内分组的细节）；
- `controllerCwd` 与 `controllerWorkspace` 在 CLI 侧的取值是否需要暴露为命令行参数；
- 现有 `--workspace-dir` / `WAYANG_DESKTOP_WORKSPACE` 类环境变量的去留与映射。
