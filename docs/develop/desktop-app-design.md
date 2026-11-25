# Wayang Desktop 应用架构设计

> 状态：正式设计文档，随实现演进校准；现状事实以本分支代码为准（基线 88ae400，rebase 自 `release/1.0.0`）。
> 本文按维护者范围裁定重构为单一范围版：废弃此前按批次划分的推进框架，桌面端全部工作并入本次交付；八项既有设计决策保留并按新范围改写；范围裁定为唯一权威，覆盖此前一切分段表述。
> 关联：主仓 `docs/develop/monorepo-design.md`（第 4 节 core/cli 改造为本设计前置成果）；`CHANGELOG.md` 的 v1.0.0 段桌面待办；研发纪律见仓库根 `AGENTS.md`。

## 1. 目标与范围

本次 Desktop 开发范围为**桌面端全部工作**：交付可安装、可日常使用的 macOS 应用，并完成架构与 UI 的目标态演进。明确不做的仅两项（见下）；其余此前规划的一切工作——含曾被划入后续批次者——均纳入本次范围。

**纳入清单（按工作域组织，与第 4 节开发计划一一对应）**：

- **功能修复与地基**（域一）：ready 状态黑洞修复、tasks 订阅死路径修复、崩溃 resume、存储目录切换（注入面落地）、workspace 依赖声明；
- **架构升级**（域二）：IPC 单一契约、主进程分层（含 ServerProcessHost 自愈状态机）、renderer 状态重构（`useSyncExternalStore`，含首屏快照竞态修复）、renderer 日志桥；
- **功能与 UI**（域三）：设置页与配置热更 UI（接 core 8 个细粒度 update 方法）、UI/UX 全套（Sender/Footer 合一、上下文圆环、TurnDotsNav、长消息折叠等）、conversation 分页与 worker 级通道；
- **打包分发**（域四）：electron-builder 分发、单实例锁、README / 版本号 / 文档收口。

**明确不做（仅此两项，成文于此；全文其余部分不得扩大排除面）**：

1. **Windows / Linux 跨平台**：目录规范、打包目标、GUI PATH 修复的跨平台化均不做。纪律先行——路径一律经 `app.getPath` 集中获取，禁止硬编码平台路径（见 2.5、第 5 节），未来引入时只改注入值不改消费点；
2. **多窗口多会话**：不做第二个 `BrowserWindow`、不做侧栏会话切换与会话路由；会话形态为单窗口单会话（见 2.1）。

**本次验收口径**：

1. 构建链路确定：清 `dist` 与 `node_modules` 后全新 install，turbo 冷启动 build 一次通过；
2. 功能面完整：「已连接」状态可达、任务完成计数真实、kill utility 进程后自动重连且历史仍在、刷新后界面立即有内容、设置页保存后配置不经重启即时生效；
3. 架构面达标：IPC 通道唯一契约源落地、主进程分层成型、renderer 经 `useSyncExternalStore` 按 slice 细粒度订阅（流式输出只重绘当前条目）；
4. 可分发：干净 macOS 机器安装 `.app` → 双击启动 → 已连接 → 发消息 → worker 跑 bash（GUI PATH 生效）→ 退出无残留 utility 进程；第二实例启动即退出并聚焦已有窗口；
5. 交付物对齐：README 重写、`version` 对齐 alpha.1、本文档与主仓 `CHANGELOG.md` 桌面段按实际交付校准。

## 2. 架构设计

### 2.1 双进程与四上下文

Desktop 是 Electron 壳：**main 进程当 RPC 客户端 + UtilityProcess 当无头 server 宿主**，RPC 帧与 CLI 完全同协议（NDJSON-RPC），只换传输层。四个执行上下文：

| 上下文 | 技术栈 | 职责 |
|---|---|---|
| renderer | React 19 + Tailwind v4（sandbox） | UI 渲染；触达外部世界的唯一方式是 `window.wayang`（preload 白名单：2 个订阅 + 7 个 invoke，快照通道落地后 8 个） |
| preload | contextBridge + ipcRenderer | 把 IPC 通道包成 api 对象一次性暴露；沙箱内只能用受限 Node 面 |
| main | Electron 41 + core（构建期内联） | GUI PATH 修复、配置装载与校验、窗口、fork utility、建 RPC、状态转发、进程生命周期与退出协议、崩溃 resume（分层形态见 2.7） |
| utility | 纯 Node（core 的 serverMain 内联） | 把父进程当 message port，转成 `{stdin, stdout}` 交给 core 的 server 入口 |

一条用户消息的路径：renderer `invoke` → main 的 `RemoteSupervisor` → RPC `submit_input` → utility 侧 `SignalQueue` 唤醒 controller loop → 状态变更经 `NOTIFY state.event` 推回 main 的 `RemoteStateStore` → `webContents.send` 回 renderer 重渲染。

**会话形态**：单窗口单会话。不做第二个 `BrowserWindow`、不做会话路由；侧栏会话切换与多窗口均不在本次范围（第 1 节明确不做第 2 项）。轮次导航等 UI 层增强（4.3）不引入会话概念。

### 2.2 IPC 通道形态（目标态单一契约）

preload 白名单即 renderer 的全部能力面（通道名一律 `wayang:` 前缀）：

| 形态 | 通道 | 用途 |
|---|---|---|
| invoke | `wayang:sendInput` / `wayang:abort` / `wayang:answerInquiry` / `wayang:listTasks` / `wayang:cancelTask` / `wayang:contextUsage` | 转发 `RemoteSupervisor` 调用 |
| invoke | `wayang:respondPermission` | 声明不接线；worker 级权限卡片列为后续按需，届时启用 |
| invoke（状态重构新增） | `wayang:getInitialState` | 全量快照拉取，首屏 hydrate 与刷新重放共用 |
| 订阅 | `wayang:state` | `NOTIFY state.event` 逐条转发（target + path + data） |
| 订阅 | `wayang:status` | 连接状态机（现状 connecting / reconnecting / ready / crashed；目标态相位随 ServerProcessHost 扩展，见 2.7） |

**目标态契约（域二落地）**：`src/shared/ipc-contract.ts` 作为通道名 / 入参 / 返回 / 推送负载的唯一契约源；main 侧 `ipc/router.ts` 泛型 `typedHandle`（Sender 校验 + 入参校验 + `{ok, data, error}` 信封）；preload 侧 `typedInvoke`（统一超时保护 + 解包信封，导出 `WayangBridge` 类型，`global.d.ts` 零重复声明）；renderer 侧 `lib/wayang-api.ts` 薄封装，组件禁止直访 `window.wayang`。新增通道（设置页、分页、日志桥）一律先入契约再实现。

权限流走 controller inquire 通道：controller 发起 inquire → renderer 渲染 InquiryCard → 用户应答经 `answerInquiry` 回流。本次不新增权限 UI 面；worker 级权限卡片为后续按需工作，`respondPermission` 保持声明不接线。

### 2.3 与 core / protocol 的接缝

- **serverMain 可选 io 注入**：core 的 `serverMain(options, io?)` 接收 `ServerIo { stdin, stdout }`；非纯 stdio 的宿主传自己的流对，默认 `process` 保持 CLI 行为不变。desktop 的 utility 入口即以此接入，异常即 `process.exit(1)`；
- **messagePortToStreams**：protocol 的 MessagePort↔流适配器。utility 侧 `process.parentPort` → 流对交给 `serverMain`；main 侧 `asMessagePort(child)`（修补 Electron 双向事件形状不对称）后同样转流，再 `RpcClient(createStreamTransport(io.stdin, io.stdout))`；
- **main 侧客户端栈与 CLI 完全同源**：`RpcClient` + `RemoteStateStore` + `RemoteSupervisor`（core 客户端 SDK），对传输无感；`RemoteStateStore` 自带 per-path 缓存与 `GET_SNAPSHOT`，是首屏快照与 resume 重放的机制基础，零 core 改动；
- **依赖形态**：core / protocol 构建期内联（electron-vite resolve 库 dist），desktop 运行期产物不依赖 `@wayang-ai/*` 安装包；`@wayang-ai/core` / `@wayang-ai/protocol` 以 `workspace:*` 声明在 devDependencies，仅为 turbo 建立构建图边（域一落地），不动 electron-vite 内联语义；MCP bridge 复制到宿主入口同目录（现源 `apps/cli/dist/mcp-bridge-entry.js`），core 桥的同目录回退路径已预留。

### 2.4 配置装载与热更接缝

- **装载**：配置解析上移已落地（monorepo-design.md 4.1）。main 进程全权装载 `~/.wayang.config.json`、经 `validateConfig` 校验，以 `WAYANG_CONFIG_OBJECT` env 把合法 `WayangConfig` 对象交接给 utility；utility 手动运行（壳外直启）时回退读 `--config` 文件；缺配置走 crashed 状态 UX；
- **热更**：无单一 `UPDATE_CONFIG` 大方法，core 暴露 8 个细粒度 update 方法——`updateProvider` / `updateModel` / `addProvider` / `addModel` / `removeProvider` / `removeModel` / `updateControllerModel` / `updateWorkerSettings`——每个方法的 schema 即字段白名单，宿主直调对应方法，可用 protocol 纯函数在发起前本地预校验。设置页（域三）按所选字段映射到对应方法，映射关系随契约入 `ipc-contract.ts`；
- **`WAYANG_DESKTOP_*` env**（`WAYANG_DESKTOP_WORKSPACE` / `WAYANG_DESKTOP_SESSION`）：定位为 dev 调试覆盖入口（直达指定工作区与 resume 会话），正式路径不依赖；设置页落地后移除（域三）。

### 2.5 存储与目录基线

会话 / 日志 / 缓存遵循 macOS / Electron 应用目录规范，经 monorepo-design.md 4.2 的 `StoragePaths` / `WorkspacePolicy` 注入面传入（`defaultWorkerWorkspace` 与 `controllerWorkspace` 同走注入面）。现状走 serverMain 的 legacy `dataDir` / `workspaceDir` 二元组（`~/.wayang` + `~/wayang-desktop`），切换即改为显式注入，改动集中在宿主接缝两处文件：

| 项 | 位置（macOS） | 用途 |
|---|---|---|
| dataDir | `app.getPath('userData')` | `sessions/`、`window-state.json`、`workspaces.json` |
| logDir | `app.getPath('logs')` | `main.log`、`renderer.log`、会话日志 |
| cacheDir | `app.getPath('caches')` | 运行时临时文件、MCP socket 句柄、缓存 |
| config | `~/.wayang.config.json` | 与 CLI 共用同一份用户配置；设置页落地时迁 `userData/config.json`（域三） |
| defaultWorkerWorkspace | `~/.agents/wayang-workspace`（启动自动 mkdir） | 未显式指定项目目录时的默认 worker 工作区 |
| controllerWorkspace | `~`（`os.homedir()`） | 进程工作目录与 Controller 起点 |

- **切换时点**：域一落地、域四打包前完成。注入面改动集中、成本可控；拖后则 `~/.wayang/sessions` 下桌面会话积累越多、迁移越痛，且装包应用写 `~/.wayang` 不合规；
- **跨平台**：Windows / Linux 目录规范不在本次范围（第 1 节明确不做第 1 项）；路径纪律先行——一律经 `app.getPath` 集中获取，禁止硬编码平台路径。

### 2.6 状态与快照（含 renderer 状态重构目标态）

- **权威源与缓存**：UtilityProcess 为业务状态唯一权威源；main 侧 `RemoteStateStore` 逐 path 缓存收到的状态事件，并可经 `GET_SNAPSHOT` 主动拉全量，作可重放缓存（Replay Cache）；机制零 core 改动；
- **renderer 状态重构目标态**：废弃顶层 `useState` 聚合散装 slice 的现状（一次 `setSlices` 触发全列表重渲染），改模块级外部单例 Store + React 19 `useSyncExternalStore` 按 slice key 细粒度订阅——流式输出只重绘当前条目。boot 序列固定为「先经 `wayang:getInitialState` 拉快照建初始态，再挂 `wayang:state` 订阅增量」：首屏快照竞态（server ready 即推快照、早于 renderer 挂监听则初始态永久丢失，a4）由此在架构层消解，不再作为独立补丁（融入方式见 4.2）；窗口刷新（`did-finish-load`）时全量重发缓存。

### 2.7 主进程分层与 ServerProcessHost 自愈

- **分层目标**：`index.ts` 退化为纯 Bootstrap，职责归位到组件——

| 组件 | 职责 |
|---|---|
| Application | 编排根；`Disposable` 退出队列统一收口 `before-quit` / `will-quit` / `window-all-closed`（macOS 关窗不退进程） |
| WindowManager | **单窗口管理器**：窗口创建、bounds 持久化、`ready-to-show` 防白屏；不做 `windowId↔sessionId` 多会话路由（单会话形态无此需求） |
| SecurityGuard | `will-navigate` 拦截、外链走系统浏览器、默认权限清零、`senderFrame.url` 校验 |
| ServerProcessHost | UtilityProcess 生命周期状态机与自愈（见下） |
| SessionService | 持有 `RemoteSupervisor` 与状态订阅 |
| UnifiedLogger | 三进程日志汇聚 + renderer 日志桥 + `{proc, windowId, sessionId, reqId}` 关联上下文 + `render-process-gone` / `child-process-gone` 崩溃记录 |

原生菜单维持 Electron 默认（Edit 剪贴板项即默认可用），不单设菜单管理组件；工作区选择归设置页表单（`dialog.showOpenDialog`，域三）。

- **ServerProcessHost 状态机**：starting → ready → degraded → restarting → fatal，指数退避自愈。域一先落地一次性重试的 resume 语义（a1 缺口修复），域二将其收编升级为完整状态机：
  - utility 意外退出（exit 时非 stopping）→ `restarting`（renderer 侧呈现 reconnecting）→ 指数退避后以 `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + `GET_SNAPSHOT` 重拉经既有 `wayang:state` 通道重放 → 重注册 IPC 转发；连续失败达上限落 `fatal`（附 stderr tail 诊断）；
  - `ready` 前崩溃或 sessionId 未知直接 `fatal`，不盲目重试；
  - 正常退出协议不变（SHUTDOWN RPC → 5s 宽限 → 强杀），`before-quit` 竞态由 stopping 标记吞掉 exit 事件、不发 restarting。

### 2.8 打包形态

- electron-builder 分发，macOS dmg 先行：`appId` / `productName` / 图标齐备，`requestSingleInstanceLock` 前置（第二实例直接退出并聚焦已有窗口）；
- **asar 整目录解包**：`asarUnpack` 对 `out/main/**` 整目录生效——utility 入口与 MCP bridge 以构建哈希 chunk 命名，清单式 unpack 在哈希变化后静默失效，整目录解包是唯一稳健形态；
- **asar 与 `utilityProcess.fork` / spawn 的兼容性是分发首要验证点**：打包后 fork 失败即回退 extraResources + `process.resourcesPath` 显式解析（core 桥同目录回退已预留），不修改 core。

## 3. 现状基线（88ae400）

### 3.1 已实现

- **UtilityProcess 宿主**：fork + `waitForReady` / shutdown 协议（ready 超时 30s / 退出宽限 5s），崩溃附 stderr tail 诊断；
- **MessagePort transport 双端接通**：`messagePortToStreams` + main 侧 `asMessagePort` 修补事件形状，RPC 回环测试钉住；
- **GUI PATH 修复**：`fixGuiPath` 前置 brew / local bin，worker bash 工具在 GUI 环境可用；
- **配置对象交接**：main 装载 + `validateConfig`、`WAYANG_CONFIG_OBJECT` env 交接、utility 手动运行回退 `--config`、缺配置走 crashed UX；
- **单页主题 UI**：header + 会话通铺 + 悬浮输入 + inquiry 卡 + 状态条；10 状态 slice、7 invoke、2 订阅；
- **日志**：`main.log` 落 `app.getPath('logs')`，server stdio 行拆分入库。

### 3.2 缺口与归组（按本次口径）

**本次必做（功能缺口）**：

| # | 缺口 | 现象 | 落位 |
|---|---|---|---|
| a1 | 崩溃 resume 缺失 | utility 意外退出仅发 crashed，无 resume 重连 | 域一（域二升级为状态机） |
| a2 | electron-builder 分发缺失 | 无打包依赖 / 配置 / dist 脚本 / 图标 | 域四 |
| a3 | ready 状态黑洞 | `onStatus('ready')` 从未发出（connection.ts 仅 connecting / crashed），「已连接」不可达 | 域一 |
| a4 | 首屏快照竞态 | server ready 即推快照，早于 renderer 挂监听则初始态永久丢失，无重放通道 | 域二（随状态重构消解） |
| a5 | tasks 死路径 | renderer 订阅 `tasks.completed` 而 core 写 `tasks.history`，完成计数恒 0 | 域一 |

**本次必做（工程债）**：`apps/desktop/package.json` 零 `@wayang-ai/*` workspace 依赖声明（turbo 冷启动竞态根因，已两次复现，域一）；`version` `1.0.0-alpha.0` 落后基线（域四收口）；README 占位文案（域四）；单实例锁缺失（域四）；设计文档热更方法引用过时（单一 `UPDATE_CONFIG` → 实际 8 个细粒度方法，本文重写即清偿）。

**本次做（架构与体验升级项，原后续批次规划全部转入）**：IPC 单一契约；主进程分层（Application / SecurityGuard / SessionService / UnifiedLogger / ServerProcessHost 状态机；WindowManager 为单窗口管理器）；renderer 状态重构（`useSyncExternalStore`）；UI/UX 全套（设置页 / Sender 合一 / 上下文圆环 / TurnDotsNav / 长消息折叠）；配置热更设置页；conversation 分页与 worker 级通道；renderer 日志桥。

**明确不做**：Windows / Linux 跨平台、多窗口多会话（第 1 节成文）。另 worker 级权限卡片（`respondPermission` 接线）列为后续按需，不在本次范围。

## 4. 开发计划（四工作域）

### 4.0 域间依赖与推进顺序

域一 → 域二 → 域三 → 域四 主线串行，域内可并行（见下）。依赖理由：

- **机制依赖**：域二快照通道的拉取时机建立在域一修正后的 ready 语义与订阅路径之上（快照 10 个 slice 含 `tasks.history`）；resume 重放不依赖新通道——重连后 main 侧 `GET_SNAPSHOT` 重拉经既有 `wayang:state` 转发，故崩溃修复可先行落在域一；域二的状态重构与 IPC 契约是域三的结构前置（细粒度订阅未定型先铺 UI 只会返工；新通道必须先入契约再实现）；
- **功能面依赖**：域四打包以域一至域三功能面收齐为前提——装包验证的是「已连接 → 发消息 → worker bash → 设置热更 → 干净退出」完整链路，功能未收齐即打包只会反复重打；装包后首屏立即有内容以域二快照通道为前提；
- **交付依赖**：域四收口以实际交付为输入，最后校准文档与版本。

域内并行：域一的依赖声明只动 `apps/desktop/package.json`，与该域其余项（connection.ts / store.ts 等）互不触碰，可并行推进。

### 4.1 域一：功能修复与地基

**工作项**：①workspace 依赖声明——`apps/desktop/package.json` 声明 `"@wayang-ai/core": "workspace:*"`、`"@wayang-ai/protocol": "workspace:*"`（devDependencies，建 turbo 图边，不动 electron-vite 内联语义）；②ready 状态——connection.ts 补 `onStatus('ready')`（`waitForReady` 成功后发出，含 sessionId）；③tasks 路径——订阅路径改 `tasks.history`（SUBSCRIBED_PATHS 与 renderer `SLICE` 同步）；④崩溃 resume（一次性语义）——exit 非 stopping → 发 reconnecting → `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + `GET_SNAPSHOT` 重拉重放 → 重注册 IPC；一次性重试，失败落 crashed；ready 前崩溃或 sessionId 未知直接 crashed；处理 before-quit 竞态；⑤存储目录切换——目录与工作区经 `StoragePaths` / `WorkspacePolicy` 注入面显式传入（2.5），serverMain legacy `dataDir` / `workspaceDir` 二元组退役。

**文件面**：`apps/desktop/package.json`；`src/main/connection.ts`、`src/main/index.ts`；`src/utility/server-host.ts`；`src/renderer/src/lib/store.ts`。

**验收**：清 `dist` 全新 install 后冷启动 build 一次通过；状态条显示已连接；任务完成计数 ≥1 且单测钉住 `SLICE` 字面量；kill utility 进程后 reconnecting → 恢复且历史仍在，单测断言第二次 fork argv 带 `resume:<id>`；运行期数据只写 `userData` / `logs` / `caches`，不写 `~/.wayang`。

### 4.2 域二：架构升级

**工作项**：①IPC 单一契约——2.2 目标态全量（契约源 / `typedHandle` / `typedInvoke` / `WayangBridge` / `wayang-api.ts` 薄封装）；②主进程分层——2.7 组件全量落地，`index.ts` 退化为 Bootstrap，UnifiedLogger 含 renderer 日志桥；③renderer 状态重构——模块级外部单例 Store + `useSyncExternalStore` 按 slice 细粒度订阅；新增 `wayang:getInitialState` 通道与 preload `getInitialState`。**原首屏快照项的融入方式**：竞态修复不再作为独立步骤——快照拉取成为新 Store 固定 boot 序列第一步（先拉快照建初始态、再挂订阅），`did-finish-load` 全量重发保留为刷新重放路径，a4 随重构消解；④ServerProcessHost 状态机——收编域一 resume 实现并升级为指数退避自愈（2.7）。

**文件面**：`src/shared/ipc-contract.ts`、`src/main/ipc/router.ts`、`src/main/application.ts` / `window-manager.ts` / `security-guard.ts` / `session-service.ts` / `server-process-host.ts` / `unified-logger.ts`（均新增）；`src/main/index.ts`（退化为 Bootstrap）；`src/preload/index.ts`（typedInvoke 化）；`src/renderer/src/lib/wayang-api.ts`（新增）、`src/renderer/src/lib/store.ts`（重构为外部单例）、`src/renderer/src/types/global.d.ts`。

**验收**：契约文件为通道唯一来源，`global.d.ts` 零重复声明；组件零直访 `window.wayang`（边界检查钉住）；先拉快照后订阅收齐 10 slice，刷新后界面立即有内容；流式输出只重绘当前条目（渲染计数断言）；ServerProcessHost 状态机单测覆盖退避序列、fatal 终态与 before-quit 竞态；`render-process-gone` / `child-process-gone` 记录入统一日志。

### 4.3 域三：功能与 UI

**工作项**：①表单化 `SettingsPage`——Provider 增删改查、Agent 绑定与 `maxConcurrency`、工作区（`dialog.showOpenDialog` 选择）与权限配置；保存时 main 校验持久化并经 8 个细粒度 update 方法热更到运行中的 server（2.4）；config 随之迁 `userData/config.json`，`WAYANG_DESKTOP_*` dev env 移除；②UI/UX 全套——对话列表通铺 + 悬浮 Sender/Footer 合一（连接态 / 任务 / worker 计数 + 上下文圆环进度条 + 发送 / 停止按 busy 切换）；Controller 输出 Borderless 撑开、user 消息淡蓝灰卡片（>300px 默认折叠 + 展开按钮）；侧边 `TurnDotsNav` 轮次圆点导航（数据源只取 user 消息、≤20 圆点滑动窗口、hover 预览、点击平滑滚动、`IntersectionObserver` 联动高亮，封装为独立组件不侵入气泡渲染）；③会话运维面——conversation 分页与 worker 级通道（controller 读取 worker 会话的分页通道，对齐 CLI 的 worker-transcript 语义）。

**文件面**：`src/renderer/src/components/settings/`（新增页面与表单组件）；`src/renderer/src/components/turn-dots-nav.tsx`（新增）；`src/renderer/src/components/chat/*`、`input-area.tsx`、`status-bar.tsx`（改造合一）；`src/shared/ipc-contract.ts` / `src/main/ipc/router.ts` / `src/renderer/src/lib/wayang-api.ts`（新增通道条目）；main 侧设置持久化与热更调用面。

**验收**：设置页保存后不重启即生效（运行中 server 可观察 provider / model 变更）；校验失败有错误呈现且不落盘；折叠阈值与导航窗口（≤20 圆点）行为符合参数；点击圆点平滑滚动且高亮联动；分页通道翻页正确且带显式截断标记；移除 dev env 后壳外直启回退路径不受影响。

### 4.4 域四：打包分发与收口

**工作项**：electron-builder 分发（mac dmg 先行：appId / productName / 图标齐备；`asarUnpack` 整目录 `out/main/**`——utility 入口与 MCP bridge 以构建哈希 chunk 命名，清单式 unpack 会静默失效；asar 与 `utilityProcess.fork` / spawn 兼容性为首要验证点，有坑回退 extraResources + `process.resourcesPath` 显式解析，不修改 core）；`requestSingleInstanceLock` 于 main 首行前置（第二实例退出并聚焦已有窗口）；README 重写；`version` 对齐 alpha.1；本文档随实现校准；主仓 `release/1.0.0` 的 `CHANGELOG.md` 桌面段按实际交付校准。

**文件面**：`apps/desktop/package.json`（builder 配置 / dist 脚本 / 打包依赖）；图标资源目录；`apps/desktop/README.md`；主仓 `CHANGELOG.md`。

**验收**：干净 macOS 装 `.app` → 双击 → 已连接 → 发消息 → worker 跑 bash（验 PATH）→ 设置热更 → 退出无残留 utility 进程；第二实例启动即退出并聚焦已有窗口；README / `version` / 文档对齐实际交付。

## 5. 边界与纪律

- **渲染层边界**（check-boundaries 机械检查，monorepo-design.md 3.5）：desktop renderer 只 import protocol 的类型与自身 IPC 胶水，禁止 import core（Node 内建依赖进浏览器环境必炸）；preload 只经 contextBridge 暴露白名单 api；跨包引用一律 `@wayang-ai/*` 包名，`@/` 必须解析到本包 `src/`；desktop 与 cli 互不 import、互不引用对方产物；
- **单实例**：`requestSingleInstanceLock` 于 main 首行前置，第二实例退出并聚焦已有窗口（域四落地）；
- **目录纪律**：路径一律经 `app.getPath` 集中获取，禁止硬编码平台路径；装包应用不写 `~/.wayang`；
- **进程纪律**：连接状态机只存在于 main，renderer 经 `wayang:status` 消费；renderer 不持有进程 / 连接概念；
- **研发流程**（AGENTS.md）：开发中发现的问题先开 issue（现象 / 影响 / 期望行为 / 验收标准），不以对话记录或 TODO 注释代替；修复合入时 commit 信息与合入说明引用 `Fixes #N` / `Refs #N`；门槛全绿才合入（`npm run lint` / `npx vitest run` / `npm run build`，一律经 turbo）；rebase 节奏——本次开发期间不主动 rebase `release/1.0.0`（88ae400 已还清接缝债），仅当 release 动到 serverMain / protocol / 桥位置时同步 rebase，合入前做最终一次。
