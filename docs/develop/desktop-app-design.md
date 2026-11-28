# Wayang Desktop 应用架构设计

> 状态：正式设计文档，随实现演进校准；现状事实以本分支代码为准（基线 bbf91d1，rebase 自 `release/1.0.0`；域一至域四工作项已全部落地，3.2 缺口清单与第 4 节状态已按实际交付校准）。
> 本文按维护者范围裁定重构为单一范围版：废弃此前按批次划分的推进框架，桌面端全部工作并入本次交付；八项既有设计决策保留并按新范围改写，并新增三项，决策枚举共十一项——第九项 desktop 自有配置存储与首启 onboard（2.11，取代「与 CLI 共用 config 文件」旧条款）、第十项 平台配置与常量模块（2.6：路径与平台常量收敛为单一产源并预留 override 入口，自定义路径与跨平台扩展只改一处——可扩展性）、第十一项 shadcn 初始风格主题体系与通用组件（2.8：颜色 / 圆角 / 间距全量 token 化并沉淀 ui 组件，杜绝散落样式——一致性与规范化）；会话形态决策（决策一）修订为单窗口多会话（应用内切换）——修订既有决策而非新增，决策枚举仍为十一项，header 右上角设置与会话切换入口规格一并纳入（2.1、2.2、2.7、2.9、4.2、4.3）；范围裁定为唯一权威，覆盖此前一切分段表述。
> 关联：主仓 `docs/develop/monorepo-design.md`（第 4 节 core/cli 改造为本设计前置成果）；`CHANGELOG.md` 的 v1.0.0 段桌面待办；研发纪律见仓库根 `AGENTS.md`。

## 1. 目标与范围

本次 Desktop 开发范围为**桌面端全部工作**：交付可安装、可日常使用的 macOS 应用，并完成架构与 UI 的目标态演进。明确不做的仅两项（见下）；其余此前规划的一切工作——含曾被划入后续批次者——均纳入本次范围。

**纳入清单（按工作域组织，与第 4 节开发计划一一对应）**：

- **功能修复与地基**（域一）：ready 状态黑洞修复、tasks 订阅死路径修复、崩溃 resume、存储目录切换（注入面落地）、平台配置与常量模块、workspace 依赖声明；
- **架构升级**（域二）：IPC 单一契约、主进程分层（含 ServerProcessHost 自愈状态机与会话切换语义）、会话索引通道（list-sessions）、renderer 状态重构（`useSyncExternalStore`，含首屏快照竞态修复与切换重放）、renderer 日志桥；
- **功能与 UI**（域三）：主题体系与通用组件、设置页与配置热更 UI（接 core 8 个细粒度 update 方法，入口为 header 右上角设置图标）、UI/UX 全套（Sender/Footer 合一、上下文圆环、TurnDotsNav、长消息折叠等）、会话切换 UI（header 右上角【…】下拉与历史会话弹框）、conversation 分页与 worker 级通道；
- **打包分发**（域四）：electron-builder 分发（含应用图标）、单实例锁、README / 版本号 / 文档收口。

**明确不做（仅此两项，成文于此；全文其余部分不得扩大排除面）**：

1. **Windows / Linux 跨平台**：目录规范、打包目标、GUI PATH 修复的跨平台化均不做。纪律先行——路径与平台常量一律经平台配置模块（2.6）取值，模块内预留 override 入口，禁止直调 `app.getPath` 与硬编码平台路径（见 2.6、第 5 节），未来引入时只改 override 与模块分支，不改消费点；
2. **多窗口**：不做第二个 `BrowserWindow`、不做 `windowId↔sessionId` 会话路由，会话切换不经侧栏；会话形态为单窗口多会话（应用内切换，切换语义见 2.1 / 2.2 / 2.9，入口规格见 4.3）。

**本次验收口径**：

1. 构建链路确定：清 `dist` 与 `node_modules` 后全新 install，turbo 冷启动 build 一次通过；
2. 功能面完整：「已连接」状态可达、任务完成计数真实、kill utility 进程后自动重连且历史仍在、刷新后界面立即有内容、设置页保存后配置不经重启即时生效；
3. 架构面达标：IPC 通道唯一契约源落地、主进程分层成型、renderer 经 `useSyncExternalStore` 按 slice 细粒度订阅（流式输出只重绘当前条目）；
4. 可分发：干净 macOS 机器安装 `.app` → 双击启动 → 已连接 → 发消息 → worker 跑 bash（GUI PATH 生效）→ 退出无残留 utility 进程；第二实例启动即退出并聚焦已有窗口；
5. 交付物对齐：README 重写、`version` 对齐 alpha.1、本文档与主仓 `CHANGELOG.md` 桌面段按实际交付校准；
6. 全新环境首启：无配置 → 欢迎页 → onboard 完成 / 导入完成 → 确认写入 → 主界面可用；二次启动不再出现欢迎页；
7. UI 一致性：界面全部经主题 token 与 `components/ui` 组件实现，无散落样式（硬编码色值、逐组件自定圆角为零）；
8. 入口与会话切换：header 右上角设置图标（lucide-react `settings-2`）点击打开设置页；【…】下拉「新会话」确认后进入全新会话；「历史会话」弹框（时间 / 摘要列表）选中确认后切换成功且界面恢复目标会话内容。

## 2. 架构设计

### 2.1 双进程与四上下文

Desktop 是 Electron 壳：**main 进程当 RPC 客户端 + UtilityProcess 当无头 server 宿主**，RPC 帧与 CLI 完全同协议（NDJSON-RPC），只换传输层。四个执行上下文：

| 上下文 | 技术栈 | 职责 |
|---|---|---|
| renderer | React 19 + Tailwind v4（sandbox） | UI 渲染；触达外部世界的唯一方式是 `window.wayang`（preload 白名单：2 个订阅 + 7 个 invoke，快照与会话三通道落地后 11 个） |
| preload | contextBridge + ipcRenderer | 把 IPC 通道包成 api 对象一次性暴露；沙箱内只能用受限 Node 面 |
| main | Electron 41 + core（构建期内联） | GUI PATH 修复、配置装载与校验、窗口、fork utility、建 RPC、状态转发、进程生命周期与退出协议、崩溃 resume（分层形态见 2.9） |
| utility | 纯 Node（core 的 serverMain 内联） | 把父进程当 message port，转成 `{stdin, stdout}` 交给 core 的 server 入口 |

一条用户消息的路径：renderer `invoke` → main 的 `RemoteSupervisor` → RPC `submit_input` → utility 侧 `SignalQueue` 唤醒 controller loop → 状态变更经 `NOTIFY state.event` 推回 main 的 `RemoteStateStore` → `webContents.send` 回 renderer 重渲染。

**会话形态**：单窗口多会话（应用内切换）。不做第二个 `BrowserWindow`、不做 `windowId↔sessionId` 会话路由（第 1 节明确不做第 2 项）；会话切换入口为 header 右上角【…】下拉（4.3），切换语义为优雅停当前 server → 以 `resume:<目标 sessionId>` 重新 boot → renderer store 重置并经 `getInitialState` 快照重放恢复目标会话初始态，会话列表数据源为 core 会话索引（Supervisor conversation index 经 list-sessions 通道暴露；通道与重放详见 2.2、2.7，宿主切换路径见 2.9）。轮次导航等 UI 层增强（4.3）不引入会话概念。

### 2.2 IPC 通道形态（目标态单一契约）

preload 白名单即 renderer 的全部能力面（通道名一律 `wayang:` 前缀）：

| 形态 | 通道 | 用途 |
|---|---|---|
| invoke | `wayang:sendInput` / `wayang:abort` / `wayang:answerInquiry` / `wayang:listTasks` / `wayang:cancelTask` / `wayang:contextUsage` | 转发 `RemoteSupervisor` 调用 |
| invoke | `wayang:respondPermission` | 声明不接线；worker 级权限卡片列为后续按需，届时启用 |
| invoke（状态重构新增） | `wayang:getInitialState` | 全量快照拉取，首屏 hydrate 与刷新重放共用 |
| invoke（会话切换新增） | `wayang:newSession` / `wayang:switchSession` / `wayang:listSessions` | new-session 开新会话；switch-session 入参目标 sessionId（宿主以 `resume:<id>` 重新 boot），切换完成后全部订阅重放（复用既有重放机制，2.7）；list-sessions 返回 core 会话索引（Supervisor conversation index，含时间 / 摘要） |
| 订阅 | `wayang:state` | `NOTIFY state.event` 逐条转发（target + path + data） |
| 订阅 | `wayang:status` | 连接状态机（现状 connecting / reconnecting / ready / crashed；目标态相位随 ServerProcessHost 扩展，见 2.9） |

**目标态契约（域二落地）**：`src/shared/ipc-contract.ts` 作为通道名 / 入参 / 返回 / 推送负载的唯一契约源；main 侧 `ipc/router.ts` 泛型 `typedHandle`（Sender 校验 + 入参校验 + `{ok, data, error}` 信封）；preload 侧 `typedInvoke`（统一超时保护 + 解包信封，导出 `WayangBridge` 类型，`global.d.ts` 零重复声明）；renderer 侧 `lib/wayang-api.ts` 薄封装，组件禁止直访 `window.wayang`。新增通道（设置页、分页、日志桥、会话切换三通道）一律先入契约再实现。

权限流走 controller inquire 通道：controller 发起 inquire → renderer 渲染 InquiryCard → 用户应答经 `answerInquiry` 回流。本次不新增权限 UI 面；worker 级权限卡片为后续按需工作，`respondPermission` 保持声明不接线。

### 2.3 与 core / protocol 的接缝

- **serverMain 可选 io 注入**：core 的 `serverMain(options, io?)` 接收 `ServerIo { stdin, stdout }`；非纯 stdio 的宿主传自己的流对，默认 `process` 保持 CLI 行为不变。desktop 的 utility 入口即以此接入，异常即 `process.exit(1)`；
- **messagePortToStreams**：protocol 的 MessagePort↔流适配器。utility 侧 `process.parentPort` → 流对交给 `serverMain`；main 侧 `asMessagePort(child)`（修补 Electron 双向事件形状不对称）后同样转流，再 `RpcClient(createStreamTransport(io.stdin, io.stdout))`；
- **main 侧客户端栈与 CLI 完全同源**：`RpcClient` + `RemoteStateStore` + `RemoteSupervisor`（core 客户端 SDK），对传输无感；`RemoteStateStore` 自带 per-path 缓存与 `GET_SNAPSHOT`，是首屏快照与 resume 重放的机制基础，零 core 改动；
- **依赖形态**：core / protocol 构建期内联（electron-vite resolve 库 dist），desktop 运行期产物不依赖 `@wayang-ai/*` 安装包；`@wayang-ai/core` / `@wayang-ai/protocol` 以 `workspace:*` 声明在 devDependencies，仅为 turbo 建立构建图边（域一落地），不动 electron-vite 内联语义；MCP bridge 复制到宿主入口同目录（现源 `apps/cli/dist/mcp-bridge-entry.js`），core 桥的同目录回退路径已预留。

### 2.4 配置装载与热更接缝

- **装载**：配置解析上移已落地（monorepo-design.md 4.1）。desktop 配置来源为自身信封文件——经平台配置模块（2.6）取得的 userData 路径下 `config.json`（决策九，2.11）：main 进程全权装载信封中的 `wayangConfig`、经 `validateConfig` 校验，以 `WAYANG_CONFIG_OBJECT` env 把合法 `WayangConfig` 对象交接给 utility；utility 侧 env 对象优先；utility 手动运行（壳外直启）时回退读 `--config` 文件的调试语义保留。冷启动遇 `config.json` 不存在、校验失败或必要核心缺失不再走 crashed 状态 UX，改经欢迎页与 onboard 产出配置（2.11）；`~/.wayang.config.json` 仅在「导入 CLI 配置」动作中被读取且只读，desktop 永不写入、运行期永不依赖，CLI 侧行为不受任何影响；
- **热更**：无单一 `UPDATE_CONFIG` 大方法，core 暴露 8 个细粒度 update 方法——`updateProvider` / `updateModel` / `addProvider` / `addModel` / `removeProvider` / `removeModel` / `updateControllerModel` / `updateWorkerSettings`——每个方法的 schema 即字段白名单，宿主直调对应方法，可用 protocol 纯函数在发起前本地预校验。设置页（域三）按所选字段映射到对应方法，映射关系随契约入 `ipc-contract.ts`；
- **`WAYANG_DESKTOP_*` env**（`WAYANG_DESKTOP_WORKSPACE` / `WAYANG_DESKTOP_SESSION`）：定位为 dev 调试覆盖入口（直达指定工作区与 resume 会话），正式路径不依赖；设置页落地后移除（域三）。

### 2.5 存储与目录基线

会话 / 日志 / 缓存遵循 macOS / Electron 应用目录规范，经 monorepo-design.md 4.2 的 `StoragePaths` / `WorkspacePolicy` 注入面传入（`defaultWorkerWorkspace` 与 `controllerWorkspace` 同走注入面），注入值一律由平台配置模块（2.6）产出。现状走 serverMain 的 legacy `dataDir` / `workspaceDir` 二元组（`~/.wayang` + `~/wayang-desktop`），切换即改为显式注入，改动集中在宿主接缝两处文件：

| 项 | 位置（macOS） | 用途 |
|---|---|---|
| dataDir | `getPaths().userData` | `sessions/`、`window-state.json`、`workspaces.json` |
| logDir | `getPaths().logs` | `main.log`、`renderer.log`、会话日志 |
| cacheDir | `getPaths().caches` | 运行时临时文件、MCP socket 句柄、缓存 |
| config | `getPaths().userData` 下 `config.json` | desktop 自有信封配置 `{ schemaVersion, wayangConfig, desktop }`（决策九，2.11）；`~/.wayang.config.json` 降格为导入源（只读） |
| defaultWorkerWorkspace | `~/.agents/wayang-workspace`（启动自动 mkdir） | 未显式指定项目目录时的默认 worker 工作区 |
| controllerWorkspace | `~`（`os.homedir()`） | 进程工作目录与 Controller 起点 |

- **切换时点**：域一落地、域四打包前完成。注入面改动集中、成本可控；拖后则 `~/.wayang/sessions` 下桌面会话积累越多、迁移越痛，且装包应用写 `~/.wayang` 不合规；
- **与 CLI 数据隔离**：`~/.wayang/sessions` 仍为 CLI 会话地，与桌面数据隔离；desktop 对 `~/.wayang` 域的唯一触达是「导入 CLI 配置」动作只读 `~/.wayang.config.json`（决策九，2.11），除此之外零读写；
- **跨平台**：Windows / Linux 目录规范不在本次范围（第 1 节明确不做第 1 项）；路径纪律先行——路径与平台常量一律经平台配置模块（2.6）取值，禁止直调 `app.getPath` 与手拼平台路径，平台差异收敛为模块内 override 分支。

### 2.6 平台配置与常量模块（决策十）

**决策十：路径与平台常量经统一封装模块产出，取代「调用方集中调 `app.getPath`」的直接表述**——仅约定集中调用点不足以支撑未来自定义路径与多平台兼容，需要真正的封装层。

- **定位**：`src/shared/platform-config.ts` 是进程内唯一的路径与平台常量来源（单一产源）；
- **API 形态**：`getPaths()` 返回类型化路径集，覆盖现有消费面（userData / logs / caches / dataDir 等，即 2.5 目录基线全表）；`getPlatformConfig()` 返回平台相关常量（平台标识、协议名等）；
- **实现规则**：模块内部是全应用唯一允许调用 `app.getPath` 的位置，对外永不暴露 Electron 原生路径 API；每类路径预留 override 入口——现有 `WAYANG_DESKTOP_*` env 即第一组 override（语义见 2.4），未来设置页自定义 dataDir、Windows / Linux 分支一律走同一 override 机制，不改消费方；
- **调用方纪律**：任何模块不得直接调用 `app.getPath` 或手拼平台路径，一律经该模块取值（第 5 节）；模块支持注入假路径，路径解析与 override 优先级可独立单测；
- **与 core 注入面的衔接**：desktop 向 core 注入的 `StoragePaths` / `WorkspacePolicy`（monorepo-design.md 4.2 注入面）的值即由该模块产出，存储目录切换与信封存储（4.1）取值同源。

### 2.7 状态与快照（含 renderer 状态重构目标态）

- **权威源与缓存**：UtilityProcess 为业务状态唯一权威源；main 侧 `RemoteStateStore` 逐 path 缓存收到的状态事件，并可经 `GET_SNAPSHOT` 主动拉全量，作可重放缓存（Replay Cache）；机制零 core 改动；
- **renderer 状态重构目标态**：废弃顶层 `useState` 聚合散装 slice 的现状（一次 `setSlices` 触发全列表重渲染），改模块级外部单例 Store + React 19 `useSyncExternalStore` 按 slice key 细粒度订阅——流式输出只重绘当前条目。boot 序列固定为「先经 `wayang:getInitialState` 拉快照建初始态，再挂 `wayang:state` 订阅增量」：首屏快照竞态（server ready 即推快照、早于 renderer 挂监听则初始态永久丢失，a4）由此在架构层消解，不再作为独立补丁（融入方式见 4.2）；窗口刷新（`did-finish-load`）时全量重发缓存；
- **会话切换重放**：切换（ServerProcessHost 切换路径见 2.9）后 renderer store 重置，经既有 `wayang:getInitialState` 快照拉取重建目标会话初始态、`wayang:state` 订阅重挂——全部订阅重放复用既有重放机制（与刷新重放、resume 重放同源），不新增重放通道；会话列表数据源为 core 会话索引，经 `wayang:listSessions` 暴露（2.2）。

### 2.8 主题体系与通用组件（决策十一）

**决策十一：以 shadcn/ui 初始风格为基座建立主题体系并沉淀通用组件**——颜色 / 圆角 / 间距全面 token 化，UI 实现规范化。本节是域三全部 UI 面的实现基座（4.3）。

1. **基座**：shadcn/ui 初始风格；组件经 shadcn CLI 生成后入 `components/ui/` 沉淀，业务复用不复制粘贴；业务代码不得内联样式绕过体系；
2. **颜色 token**：CSS variables（shadcn HSL 体系：`--background` / `--foreground` / `--primary` / `--muted` / `--accent` / `--border` / `--ring` / `--radius` 等）落于 renderer 全局样式；现有淡蓝主题作为 primary 色相定制映射到 token，不散落硬编码色值；
3. **圆角**：单一 `--radius` 基准 + 组件级派生（`rounded-lg` / `rounded-md` / `rounded-sm` 与 token 绑定），不逐组件自定圆角；
4. **间距**：统一 spacing 尺度（4 / 8 倍数），padding / gap 一律取尺度值；
5. **通用组件沉淀**：Button / Card / Dialog / Input / Badge / Skeleton / ScrollArea 等按需引入；
6. **暗色模式**：token 体系天然支持，列后续版本可选，本次不实现。

### 2.9 主进程分层与 ServerProcessHost 自愈

- **分层目标**：`index.ts` 退化为纯 Bootstrap，职责归位到组件——

| 组件 | 职责 |
|---|---|
| Application | 编排根；`Disposable` 退出队列统一收口 `before-quit` / `will-quit` / `window-all-closed`（macOS 关窗不退进程） |
| WindowManager | **单窗口管理器**：窗口创建、bounds 持久化、`ready-to-show` 防白屏；不做 `windowId↔sessionId` 会话路由（单窗口多会话经应用内切换，窗口与会话无绑定） |
| SecurityGuard | `will-navigate` 拦截、外链走系统浏览器、默认权限清零、`senderFrame.url` 校验 |
| ServerProcessHost | UtilityProcess 生命周期状态机与自愈（见下） |
| SessionService | 持有 `RemoteSupervisor` 与状态订阅 |
| UnifiedLogger | 三进程日志汇聚 + renderer 日志桥 + `{proc, windowId, sessionId, reqId}` 关联上下文 + `render-process-gone` / `child-process-gone` 崩溃记录 |

原生菜单维持 Electron 默认（Edit 剪贴板项即默认可用），不单设菜单管理组件；工作区选择归设置页表单（`dialog.showOpenDialog`，域三）。

- **ServerProcessHost 状态机**：starting → ready → degraded → restarting → fatal，指数退避自愈。域一先落地一次性重试的 resume 语义（a1 缺口修复），域二将其收编升级为完整状态机：
  - utility 意外退出（exit 时非 stopping）→ `restarting`（renderer 侧呈现 reconnecting）→ 指数退避后以 `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + `GET_SNAPSHOT` 重拉经既有 `wayang:state` 通道重放 → 重注册 IPC 转发；连续失败达上限落 `fatal`（附 stderr tail 诊断）；
  - `ready` 前崩溃或 sessionId 未知直接 `fatal`，不盲目重试；
  - 正常退出协议不变（SHUTDOWN RPC → 5s 宽限 → 强杀），`before-quit` 竞态由 stopping 标记吞掉 exit 事件、不发 restarting；
  - 会话切换路径（switch-session）：以正常退出协议优雅停当前 server（当前会话状态保留、仍可 resume）→ 以 `resume:<目标 sessionId>` 重新 boot → ready 后经重放恢复（2.7）；切换为用户主动动作，不视为 degraded / fatal、不计入自愈退避。

### 2.10 打包形态

- electron-builder 分发，macOS dmg 先行：`appId` / `productName` / 图标齐备，`requestSingleInstanceLock` 前置（第二实例直接退出并聚焦已有窗口）；
- **asar 整目录解包**：`asarUnpack` 对 `out/main/**` 整目录生效——utility 入口与 MCP bridge 以构建哈希 chunk 命名，清单式 unpack 在哈希变化后静默失效，整目录解包是唯一稳健形态；
- **asar 与 `utilityProcess.fork` / spawn 的兼容性是分发首要验证点**：打包后 fork 失败即回退 extraResources + `process.resourcesPath` 显式解析（core 桥同目录回退已预留），不修改 core；
- **应用图标**：单一资产源为仓库 `assets/logo/`（mark-icon 64 / 256 / 512 png、logo 1024 png 与 svg、banner、favicon 齐备）；mac 无现成 `.icns`，electron-builder 从 `wayang-mark-icon-512.png`（≥512）自动转换，转换即打包工作项步骤；`BrowserWindow` icon 参数引用同源 mark 资产（mac 窗口图标实际取应用图标，参数为形态统一预留），desktop 不散落图标副本；
- **域四落地校准**：①asar 兼容性验证结论——Electron 41 下 `utilityProcess.fork(asar 内路径)` 与「electron 可执行文件 + asar 内脚本路径」两种形态（含整目录解包与全 asar 两种对照）均实测通过，extraResources 回退未启用，`out/main/**` 整目录解包按设计保留（纯 node / 外部进程 spawn 仍需物理文件）；②运行期 node_modules 新事实——electron-vite 全量内联后，ajv 生成代码在运行期以裸说明符 `require("ajv/dist/runtime/*")` / `require("ajv-formats/dist/formats")`，`dependencies` 因此仅声明 ajv / ajv-formats 并经 staging 脚本显式入包（electron-builder 对 workspace 提升布局的自动依赖收集存在「提升依赖被静默丢弃」的不确定路径，不作为依赖手段）；③dmg 构建需 macOS 宿主（vendor dmgbuild 为 macOS 二进制，Linux 宿主实测 `Exec format error`），非 macOS 环境以 `--dir` 产物做文件级核验；④打包应用 `productName` 经 extraMetadata 注入，userData 为 `~/Library/Application Support/Wayang`，与 dev 目录天然隔离。

### 2.11 配置存储与首启 onboard（决策九）

**决策九：desktop 自有配置存储，取代「与 CLI 共用 config 文件」旧条款**——desktop 不复用 CLI 的 `~/.wayang.config.json`，在桌面应用自身配置路径维护配置；`~/.wayang.config.json` 仅在「导入 CLI 配置」动作中被读取且只读，desktop 永不写入、运行期永不依赖，CLI 侧行为不受任何影响。2.4 装载链路与 2.5 目录基线的相关表述已按本决策改写，此前「与 CLI 共用同一份用户配置」条款就此废止。

- **信封存储**：配置文件为平台配置模块（2.6）userData 路径下的单文件 `config.json`（macOS 即 `Application Support/wayang/config.json`，遵守调用方纪律）。格式为信封单文件：`{ schemaVersion: 1, wayangConfig: { …标准 WayangConfig… }, desktop: { …桌面偏好字段… } }`——核心配置保持 protocol 的 `WayangConfig` 原样，`validateConfig` 纯函数（packages/protocol）直接复用；`desktop` 区给桌面偏好（未来主题 / 窗口设置等）留位；单文件保证写入原子性；
- **必要核心配置（决定 onboard 哪些步骤不可跳过）**：① ≥1 个 provider（type / baseURL / apiKey 齐备）；② controller 与 worker 的模型绑定可解析（指向真实存在的 provider 与 model 条目）。其余全部可跳过（workers 第三方定义、`maxConcurrency`、日志级别等）。向导按步骤引导（Provider → 模型 → 模型绑定 → Worker（可选））：每一步列出草稿里已有的条目（可编辑 / 删除），并用与设置页同一套原子设置组件新增；从零填写与修改已有配置（导入的、或磁盘上不完整的）走同一条流程，只是草稿的起点不同——原先内建的「创建默认 provider + model」兜底步骤已被这条分步流程取代（兜底会写入占位值）；
- **首启流程**：冷启动判定——`config.json` 不存在、或 `validateConfig` 失败、或必要核心配置缺失 → 展示欢迎页。欢迎页两入口（磁盘上已有「结构合法但必要核心不完整」的配置时另加「修改现有配置」，以它为草稿进向导，落在第一个没填好的步骤）：「开始配置」→ onboard 向导（Provider → 模型 → 模型绑定 三步必做，Worker 一步可跳过；有未保存的表单时不能前进）；「导入 CLI 配置」→ 读 `~/.wayang.config.json` → `validate` → 直接跳最终确认页（读取失败显示具体校验错误；文件选择器支持非默认路径为可选增强）。最终确认页：全量展示 + 核心完整性校验（与保存路径同口径：结构合法 + 必要核心齐备）→ 确认写入 userData 信封 → 进入主界面（server 以新配置 boot），「返回修改」回到向导第一个没填好的步骤；
- **二次修改**：设置页（域三工作项）与最终确认页同源同校验；运行中修改走既有 8 个细粒度热更方法（2.4）。设置页与向导共用原子设置组件（`renderer/main-window/components/settings/`：Provider / Model / 模型绑定 / Worker / puppet 默认参数的受控表单，各自带表单值 ⇄ 配置的转换与校验；只管表单不管持久化——设置页把保存接到后端提交，向导接进本地草稿。字段随枚举变化的实体按取值定制：`workers.<id>` 公共字段一组、claude-code 与 ACP 类的专属字段各一组，只摆该类型真正会读的键）；

## 3. 现状基线（88ae400）

### 3.1 已实现

- **UtilityProcess 宿主**：fork + `waitForReady` / shutdown 协议（ready 超时 30s / 退出宽限 5s），崩溃附 stderr tail 诊断；
- **MessagePort transport 双端接通**：`messagePortToStreams` + main 侧 `asMessagePort` 修补事件形状，RPC 回环测试钉住；
- **GUI PATH 修复**：`fixGuiPath` 前置 brew / local bin，worker bash 工具在 GUI 环境可用；
- **配置对象交接**：main 装载 + `validateConfig`、`WAYANG_CONFIG_OBJECT` env 交接、utility 手动运行回退 `--config`、缺配置走 crashed UX；
- **单页主题 UI**：header + 会话通铺 + 悬浮输入 + inquiry 卡 + 状态条；10 状态 slice、7 invoke、2 订阅；
- **日志**：`main.log` 落 `app.getPath('logs')`，server stdio 行拆分入库。

### 3.2 缺口与归组（按本次口径；状态按域四收口时点校准，全部已落地）

**本次必做（功能缺口）**：

| # | 缺口 | 现象 | 落位 | 状态 |
|---|---|---|---|---|
| a1 | 崩溃 resume 缺失 | utility 意外退出仅发 crashed，无 resume 重连 | 域一（域二升级为状态机） | ✅ 已落地 |
| a2 | electron-builder 分发缺失 | 无打包依赖 / 配置 / dist 脚本 / 图标 | 域四 | ✅ 已落地（4.4 校准） |
| a3 | ready 状态黑洞 | `onStatus('ready')` 从未发出（connection.ts 仅 connecting / crashed），「已连接」不可达 | 域一 | ✅ 已落地 |
| a4 | 首屏快照竞态 | server ready 即推快照，早于 renderer 挂监听则初始态永久丢失，无重放通道 | 域二（随状态重构消解） | ✅ 已落地 |
| a5 | tasks 死路径 | renderer 订阅 `tasks.completed` 而 core 写 `tasks.history`，完成计数恒 0 | 域一 | ✅ 已落地 |

**本次必做（决策九新增：配置存储与首启 onboard）**：①信封存储读写与 `schemaVersion`——域一地基，server boot 与 onboard 都依赖（4.0）；②欢迎页检测与两入口；③onboard 向导（当时的默认 provider / model 兜底步骤其后被分步引导流程取代，见 2.11）；④CLI 导入（只读 `~/.wayang.config.json`）；⑤最终确认页。②–⑤为 UI 面，落域三，以 ① 就绪为前提。

**本次必做（工程债）**：路径取值散落——logger.ts 直调 `app.getPath`、index.ts / connection.ts 手拼 homedir 路径，无统一封装（域一收编入平台配置模块）；`apps/desktop/package.json` 零 `@wayang-ai/*` workspace 依赖声明（turbo 冷启动竞态根因，已两次复现，域一）；`version` `1.0.0-alpha.0` 落后基线（域四收口）；README 占位文案（域四）；单实例锁缺失（域四）；设计文档热更方法引用过时（单一 `UPDATE_CONFIG` → 实际 8 个细粒度方法，本文重写即清偿）。——以上全部落地：version 已对齐 `1.0.0-alpha.1`、README 已重写（真实 dev/build/dist 说明）、单实例锁已前置（4.4）。

**本次做（架构与体验升级项，原后续批次规划全部转入）**：平台配置与常量模块（决策十）；IPC 单一契约；主进程分层（Application / SecurityGuard / SessionService / UnifiedLogger / ServerProcessHost 状态机与会话切换语义；WindowManager 为单窗口管理器）；renderer 状态重构（`useSyncExternalStore`，含切换重放）；会话切换（域二：ServerProcessHost 切换语义 + list-sessions 会话索引通道；域三：header【…】下拉与历史会话弹框）；主题体系与通用组件（决策十一）；UI/UX 全套（设置页 / Sender 合一 / 上下文圆环 / TurnDotsNav / 长消息折叠 / header 右上角设置入口）；配置热更设置页；conversation 分页与 worker 级通道；renderer 日志桥。

**明确不做**：Windows / Linux 跨平台、多窗口（第 1 节成文）。另 worker 级权限卡片（`respondPermission` 接线）列为后续按需，不在本次范围。

## 4. 开发计划（四工作域）

### 4.0 域间依赖与推进顺序

域一 → 域二 → 域三 → 域四 主线串行，域内可并行（见下）。依赖理由：

- **机制依赖**：域二快照通道的拉取时机建立在域一修正后的 ready 语义与订阅路径之上（快照 10 个 slice 含 `tasks.history`）；resume 重放不依赖新通道——重连后 main 侧 `GET_SNAPSHOT` 重拉经既有 `wayang:state` 转发，故崩溃修复可先行落在域一；域二的状态重构与 IPC 契约是域三的结构前置（细粒度订阅未定型先铺 UI 只会返工；新通道必须先入契约再实现）；域三内主题体系与通用组件先于 UI/UX 全套与首启流落地（先立 token 与 ui 组件基座，全套 UI 一律以 token + ui 组件实现），不反向依赖域二状态重构的落地时序；域三会话切换 UI（header【…】下拉与历史会话弹框）以域二切换语义（ServerProcessHost stop → resume boot）与 list-sessions 索引通道就绪为前置；
- **配置存储依赖**：信封存储（决策九，2.11）属域一地基——server boot 与首启 onboard 都依赖它；平台配置与常量模块（决策十，2.6）同为域一地基，是存储目录切换与信封存储的路径取值产源；域三的欢迎页 / 向导 / 导入 / 最终确认页 UI 以域一存储就绪为前提；
- **功能面依赖**：域四打包以域一至域三功能面收齐为前提——装包验证的是「已连接 → 发消息 → worker bash → 设置热更 → 干净退出」完整链路，功能未收齐即打包只会反复重打；装包后首屏立即有内容以域二快照通道为前提；
- **交付依赖**：域四收口以实际交付为输入，最后校准文档与版本。

域内并行：域一的依赖声明只动 `apps/desktop/package.json`，与该域其余项（connection.ts / store.ts 等）互不触碰，可并行推进。

### 4.1 域一：功能修复与地基

**（状态：已落地——工作项①–⑦全部交付，含验收所列单测钉住。）**

**工作项**：①workspace 依赖声明——`apps/desktop/package.json` 声明 `"@wayang-ai/core": "workspace:*"`、`"@wayang-ai/protocol": "workspace:*"`（devDependencies，建 turbo 图边，不动 electron-vite 内联语义）；②ready 状态——connection.ts 补 `onStatus('ready')`（`waitForReady` 成功后发出，含 sessionId）；③tasks 路径——订阅路径改 `tasks.history`（SUBSCRIBED_PATHS 与 renderer `SLICE` 同步）；④崩溃 resume（一次性语义）——exit 非 stopping → 发 reconnecting → `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + `GET_SNAPSHOT` 重拉重放 → 重注册 IPC；一次性重试，失败落 crashed；ready 前崩溃或 sessionId 未知直接 crashed；处理 before-quit 竞态；⑤平台配置与常量模块（决策十，2.6）——`src/shared/platform-config.ts` 落地：`getPaths()` 类型化路径集、`getPlatformConfig()` 平台常量、每类路径的 override 入口（`WAYANG_DESKTOP_*` env 为第一组）；存量取值点迁入——logger.ts 的 `app.getPath` 调用与 index.ts / connection.ts 的手拼 homedir 路径一律改经模块取值，注入 core 的 `StoragePaths` / `WorkspacePolicy` 值由该模块产出（单一产源）；⑥存储目录切换——目录与工作区经 `StoragePaths` / `WorkspacePolicy` 注入面显式传入（2.5，取值经⑤模块），serverMain legacy `dataDir` / `workspaceDir` 二元组退役；⑦信封存储（决策九，2.11）——`userData/config.json` 信封读写（原子单文件写入，路径取值经⑤模块）与 `schemaVersion`、冷启动检测（不存在 / 校验失败 / 必要核心缺失 → 欢迎页判定）、「导入 CLI 配置」的只读装载与校验入口，为 server boot 与 onboard 的共同地基。

**文件面**：`apps/desktop/package.json`；`src/shared/platform-config.ts`（新增）；`src/main/logger.ts`（取值迁入）；`src/main/connection.ts`、`src/main/index.ts`；`src/main/config-store.ts`（新增）；`src/utility/server-host.ts`；`src/renderer/src/lib/store.ts`。

**验收**：清 `dist` 全新 install 后冷启动 build 一次通过；状态条显示已连接；任务完成计数 ≥1 且单测钉住 `SLICE` 字面量；kill utility 进程后 reconnecting → 恢复且历史仍在，单测断言第二次 fork argv 带 `resume:<id>`；运行期数据只写 `userData` / `logs` / `caches`，不写 `~/.wayang`；信封写入为原子单文件语义、校验失败走欢迎页判定而非 crashed（单测钉住），导入动作对 `~/.wayang.config.json` 只读；全仓 `app.getPath` 直调仅 `platform-config.ts` 一处命中（检查钉住），平台配置模块单测以注入假路径覆盖各类路径与 override 优先级。

### 4.2 域二：架构升级

**（状态：已落地——工作项①–⑤全部交付，含切换路径与退避序列单测。）**

**工作项**：①IPC 单一契约——2.2 目标态全量（契约源 / `typedHandle` / `typedInvoke` / `WayangBridge` / `wayang-api.ts` 薄封装），含会话切换三通道 new-session / switch-session / list-sessions（契约名 `wayang:newSession` / `wayang:switchSession` / `wayang:listSessions`）；②主进程分层——2.9 组件全量落地，`index.ts` 退化为 Bootstrap，UnifiedLogger 含 renderer 日志桥；③renderer 状态重构——模块级外部单例 Store + `useSyncExternalStore` 按 slice 细粒度订阅；新增 `wayang:getInitialState` 通道与 preload `getInitialState`。**原首屏快照项的融入方式**：竞态修复不再作为独立步骤——快照拉取成为新 Store 固定 boot 序列第一步（先拉快照建初始态、再挂订阅），`did-finish-load` 全量重发保留为刷新重放路径，a4 随重构消解；该 boot 序列同时承载会话切换恢复——切换后 store 重置，经同一快照拉取与订阅重挂恢复目标会话初始态（2.7）；④ServerProcessHost 状态机——收编域一 resume 实现并升级为指数退避自愈（2.9），并落会话切换语义（2.9 切换路径：优雅停当前 server、其会话状态保留 → `resume:<目标 sessionId>` 重新 boot；不视为 degraded / fatal、不计退避）；⑤会话索引通道——list-sessions 经契约暴露 core 会话索引（Supervisor conversation index：时间 / 摘要），为域三历史会话弹框数据源。

**文件面**：`src/shared/ipc-contract.ts`、`src/main/ipc/router.ts`、`src/main/application.ts` / `window-manager.ts` / `security-guard.ts` / `session-service.ts` / `server-process-host.ts` / `unified-logger.ts`（均新增）；`src/main/index.ts`（退化为 Bootstrap）；`src/preload/index.ts`（typedInvoke 化）；`src/renderer/src/lib/wayang-api.ts`（新增）、`src/renderer/src/lib/store.ts`（重构为外部单例）、`src/renderer/src/types/global.d.ts`。

**验收**：契约文件为通道唯一来源，`global.d.ts` 零重复声明；组件零直访 `window.wayang`（边界检查钉住）；先拉快照后订阅收齐 10 slice，刷新后界面立即有内容；流式输出只重绘当前条目（渲染计数断言）；ServerProcessHost 状态机单测覆盖退避序列、fatal 终态、before-quit 竞态与切换路径（stop → resume boot 不进退避、不落 fatal）；切换后经快照重放收齐目标会话 slice；list-sessions 返回会话索引条目（时间 / 摘要）；`render-process-gone` / `child-process-gone` 记录入统一日志。

### 4.3 域三：功能与 UI

**（状态：已落地——工作项①–⑥全部交付；会话级 logDir 分目录为域一遗留复议项，本文档无此要求锚点，未实施。）**

**工作项**：①主题体系与通用组件（决策十一，2.8）——renderer 全局样式落 CSS variables token（shadcn HSL 体系，现有淡蓝主题的 primary 色相映射入 token）、单一 `--radius` 基准与 4 / 8 倍数 spacing 尺度、`components/ui/` 经 shadcn CLI 沉淀通用组件（Button / Card / Dialog / Input / Badge / Skeleton / ScrollArea 按需引入）；本项为域三全部 UI 面的实现基座，先于 ③⑤ 落地（②亦经体系实现）；②表单化 `SettingsPage`——Provider 增删改查、Agent 绑定与 `maxConcurrency`、工作区（`dialog.showOpenDialog` 选择）与权限配置；保存时 main 校验后写入 userData 信封并经 8 个细粒度 update 方法热更到运行中的 server（2.4）；设置页与首启最终确认页同源同校验（共用核心完整性校验与信封写入口径，2.11）；`WAYANG_DESKTOP_*` dev env 移除；入口规格——header 右上角 lucide-react `settings-2` 图标，点击打开设置页；③UI/UX 全套——一律以主题 token 与 `components/ui` 组件实现：对话列表通铺 + 悬浮 Sender/Footer 合一（连接态 / 任务 / worker 计数 + 上下文圆环进度条 + 发送 / 停止按 busy 切换）；Controller 输出 Borderless 撑开、user 消息淡蓝灰卡片（>300px 默认折叠 + 展开按钮）；侧边 `TurnDotsNav` 轮次圆点导航（数据源只取 user 消息、≤20 圆点滑动窗口、hover 预览、点击平滑滚动、`IntersectionObserver` 联动高亮，封装为独立组件不侵入气泡渲染）；④会话运维面——conversation 分页与 worker 级通道（controller 读取 worker 会话的分页通道，对齐 CLI 的 worker-transcript 语义）；⑤首启配置流 UI（决策九，2.11）——欢迎页（冷启动判定触发，两入口）、onboard 向导（必要核心步骤靠前必做、含默认 provider + model 兜底步骤——该兜底其后被分步引导流程取代，见 2.11，完成必做后其余步骤可跳过）、CLI 导入入口（读 `~/.wayang.config.json` → validate → 直跳最终确认页，失败呈现具体校验错误）、最终确认页（全量展示 + 核心完整性校验 → 确认写入 userData 信封 → 进入主界面）；文件选择器支持非默认导入路径为可选增强；依赖域一信封存储就绪（4.0）；⑥会话切换入口——header 右上角设置入口旁【…】省略号图标（lucide-react `ellipsis` / `ellipsis-vertical` / `more-horizontal`，实现时取 lucide-react 现有图标名），点击展开下拉框，两项：【新会话】——确认后经 new-session 通道开启新会话；【历史会话】——打开历史会话弹框，经 list-sessions 展示历史会话列表（时间 / 摘要），选中后确认 → 经 switch-session 通道执行切换，界面重放恢复目标会话内容（2.7）；依赖域二切换语义与索引通道（4.0）。

**文件面**：`src/renderer/src/globals.css`（token 体系唯一落点）；`src/renderer/src/components/ui/`（新增，shadcn CLI 生成沉淀）；`src/renderer/src/components/onboard/`（新增欢迎页 / 向导 / 导入 / 最终确认页）；`src/renderer/src/components/settings/`（新增页面与表单组件）；`src/renderer/src/components/turn-dots-nav.tsx`（新增）；`src/renderer/src/components/chat/*`、`input-area.tsx`、`status-bar.tsx`（改造合一）；`src/shared/ipc-contract.ts` / `src/main/ipc/router.ts` / `src/renderer/src/lib/wayang-api.ts`（新增通道条目）；main 侧设置持久化与热更调用面；`apps/desktop/package.json`（新增 lucide-react 依赖，现无该依赖）；`src/renderer/src/components/session-menu.tsx`（新增：【…】下拉与历史会话弹框）；`src/renderer/src/App.tsx`（header 右上角设置与会话切换入口挂载）。

**验收**：设置页保存后不重启即生效（运行中 server 可观察 provider / model 变更）；校验失败有错误呈现且不落盘；折叠阈值与导航窗口（≤20 圆点）行为符合参数；点击圆点平滑滚动且高亮联动；分页通道翻页正确且带显式截断标记；header 右上角 `settings-2` 图标点击打开设置页；【…】下拉「新会话」确认后进入全新会话，「历史会话」弹框选中确认后切换成功且界面恢复目标会话内容；移除 dev env 后壳外直启回退路径不受影响；全新环境首启走欢迎页 → onboard 完成 / 导入完成 → 确认写入 → 主界面可用，二次启动不再出现欢迎页；界面全部经主题 token 与 `components/ui` 组件实现，无散落样式（硬编码色值、内联 style、逐组件自定圆角为零），圆角取 `--radius` 派生值、padding / gap 取 4 / 8 尺度值。

### 4.4 域四：打包分发与收口

**工作项**：electron-builder 分发（mac dmg 先行：appId / productName / 图标齐备——图标源为仓库 `assets/logo/`（512 / 1024 png 与 svg 资产齐备；mac 无 `.icns`，electron-builder 从 `wayang-mark-icon-512.png` 自动转换，转换归本域步骤）；`asarUnpack` 整目录 `out/main/**`——utility 入口与 MCP bridge 以构建哈希 chunk 命名，清单式 unpack 会静默失效；asar 与 `utilityProcess.fork` / spawn 兼容性为首要验证点，有坑回退 extraResources + `process.resourcesPath` 显式解析，不修改 core）；`requestSingleInstanceLock` 于 main 首行前置（第二实例退出并聚焦已有窗口）；README 重写；`version` 对齐 alpha.1；本文档随实现校准；主仓 `release/1.0.0` 的 `CHANGELOG.md` 桌面段按实际交付校准。

**落地校准（域四交付实录）**：
- electron-builder 配置落于 `apps/desktop/package.json` 的 `build` 字段：appId `ai.wayang.desktop`、productName `Wayang`、产物目录 `release/`、`files` 为 `out/**` + 运行期 node_modules staging、`asarUnpack: ["out/main/**"]`、`mac.icon` 指仓库 `assets/logo/wayang-mark-icon-512.png`（实测自动转出 16→512 全尺寸 `icon.icns`）；devDep 增 electron-builder 26、electron 版本锁定精确值（builder 要求非 range）；renderer 全量打包故 react 系依赖全部转 devDependencies；
- **运行期依赖新事实**：utility 产物内 ajv 生成代码运行期 `require("ajv/dist/runtime/validation_error")` 与 `require("ajv-formats/dist/formats")`（裸说明符不可内联），`dependencies` 声明 ajv / ajv-formats 并经 `scripts/stage-runtime-deps.mjs` 按解析闭包复制到 `.runtime-node-modules/`、以 `files` 对象条目显式入包——electron-builder 对 npm workspace 提升布局的自动收集存在「提升依赖无 path 被静默丢弃」的路径（实测复现），显式 staging 使 asar 内 node_modules 布局可满足上述 require（提取 asar 实测 resolve 成功）；
- asar 兼容性验证结论（本域首要验证点）：Electron 41 下 `utilityProcess.fork`（asar 路径、含解包洞与全 asar 两对照）与「electron 可执行文件 + asar 内脚本路径」（MCP 桥 descriptor 的 spawn 形态）均实测可用；extraResources 回退未启用，`out/main/**` 整目录解包按设计保留；
- 单实例锁：`src/main/index.ts` 首行 `requestSingleInstanceLock`，未获锁即 `app.quit()`；`Application` 注册 `second-instance` → `WindowManager.focus()`（restore + focus），窗口未建期为 no-op；
- dmg 可用性：dmg 目标配置就绪（纯色背景与窗口底色一致）；**本任务在 Linux 宿主执行，dmg 构建实证不可行**（vendor dmgbuild 为 macOS 二进制，`Exec format error`；签名亦仅 macOS 宿主），以 `electron-builder --mac --dir` 产物完成文件级核验：`Wayang.app` 结构完整、`app.asar.unpacked/out/main/` 物理齐备（index / utility-entry / mcp-bridge-entry / chunks）、asar 内 node_modules 闭包完整、Info.plist（CFBundleIdentifier/Name/IconFile/ShortVersionString）与可执行名核验通过。dmg 与实机安装链路验收留待 macOS 宿主执行；
- 收口：README 重写为真实 dev/build/dist 说明；`version` 对齐 `1.0.0-alpha.1`；本文档按实际交付校准（本节与 2.10/3.2）；**主仓 CHANGELOG 校准移至 desktop 合入 `release/1.0.0` 时点执行**（feat 分支不携带主仓 CHANGELOG 改动）。

**文件面**：`apps/desktop/package.json`（builder 配置 / dist 脚本 / 打包依赖）；图标资源目录；`apps/desktop/README.md`；主仓 `CHANGELOG.md`。（实际交付：前两项 + `apps/desktop/scripts/stage-runtime-deps.mjs`、`.gitignore`；主仓 CHANGELOG 按上条移至合流时点。）

**验收**：干净 macOS 装 `.app` → 双击 → 已连接 → 发消息 → worker 跑 bash（验 PATH）→ 设置热更 → 退出无残留 utility 进程；第二实例启动即退出并聚焦已有窗口；README / `version` / 文档对齐实际交付；安装包与窗口使用新 logo（dmg / App 图标与 `BrowserWindow` icon 同源 `assets/logo/`）。（本任务环境为 Linux 宿主：第二实例行为以单测钉住、asar/fork 以实证替代、其余实机项待 macOS 宿主验收。）

## 5. 边界与纪律

- **渲染层边界**（check-boundaries 机械检查，monorepo-design.md 3.5）：desktop renderer 只 import protocol 的类型与自身 IPC 胶水，禁止 import core（Node 内建依赖进浏览器环境必炸）；preload 只经 contextBridge 暴露白名单 api；跨包引用一律 `@wayang-ai/*` 包名，`@/` 必须解析到本包 `src/`；desktop 与 cli 互不 import、互不引用对方产物；
- **单实例**：`requestSingleInstanceLock` 于 main 首行前置，第二实例退出并聚焦已有窗口（域四落地）；
- **调用方纪律**：任何模块不得直接调用 `app.getPath` 或手拼平台路径，路径与平台常量一律经平台配置模块（2.6）取值——全应用唯一 `app.getPath` 调用点即该模块；装包应用不写 `~/.wayang`；
- **进程纪律**：连接状态机只存在于 main，renderer 经 `wayang:status` 消费；renderer 不持有进程 / 连接概念；
- **研发流程**（AGENTS.md）：开发中发现的问题先开 issue（现象 / 影响 / 期望行为 / 验收标准），不以对话记录或 TODO 注释代替；修复合入时 commit 信息与合入说明引用 `Fixes #N` / `Refs #N`；门槛全绿才合入（`npm run lint` / `npx vitest run` / `npm run build`，一律经 turbo）；rebase 节奏——本次开发期间不主动 rebase `release/1.0.0`（88ae400 已还清接缝债），仅当 release 动到 serverMain / protocol / 桥位置时同步 rebase，合入前做最终一次。
