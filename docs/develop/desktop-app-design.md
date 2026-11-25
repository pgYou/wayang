# Wayang Desktop 应用架构设计

> 状态：正式设计文档，随实现演进校准；现状事实以 `feat/desktop-m3` 分支代码为准（基线 88ae400，rebase 自 `release/1.0.0`）。
> 本文由旧稿草稿与 M3 调研结论融合重写为正式执行版：现状基线、缺口分级、S0–S5 执行计划与八项设计决策并入正文。
> 关联：主仓 `docs/develop/monorepo-design.md`（第 4 节 core/cli 改造为本设计前置成果）；`CHANGELOG.md` 的 v1.0.0 段桌面待办；研发纪律见仓库根 `AGENTS.md`。

## 1. 目标与范围

M3 是 Desktop 首个可运行里程碑：**Electron 壳与无头 server 的双进程形态打通，交付可安装的 macOS 应用**。范围口径来源于主仓 `CHANGELOG.md` 的 1.0.0 桌面待办与 monorepo-design.md 3.4。

- **纳入 M3**：UtilityProcess 宿主与生命周期协议、MessagePort RPC 传输、配置对象交接、单页主题 UI、ready 状态与任务计数修复、首屏快照重放、崩溃 resume、存储目录切换、electron-builder 分发、工程债清偿（workspace 依赖声明 / 版本号 / README / 文档校准）；
- **不纳入 M3**：设置页与配置热更 UI、IPC 单一契约、主进程分层、renderer 状态重构、UI/UX 全套、Windows / Linux、多窗口多会话——归入 M4+ 路线（第 5 节）。

M3 整体验收口径：

1. 构建链路确定：清 `dist` 与 `node_modules` 后全新 install，turbo 冷启动 build 一次通过；
2. 功能面完整：「已连接」状态可达、任务完成计数真实、kill utility 进程后自动重连且历史仍在、刷新后界面立即有内容；
3. 可分发：干净 macOS 机器安装 `.app` → 双击启动 → 已连接 → 发消息 → worker 跑 bash（GUI PATH 生效）→ 退出无残留 utility 进程；
4. 交付物对齐：README 重写、`version` 对齐 alpha.1、本文档与主仓 `CHANGELOG.md` 桌面段按实际交付校准。

## 2. 架构

### 2.1 双进程与四上下文

Desktop 是 Electron 壳：**main 进程当 RPC 客户端 + UtilityProcess 当无头 server 宿主**，RPC 帧与 CLI 完全同协议（NDJSON-RPC），只换传输层。四个执行上下文：

| 上下文 | 技术栈 | 职责 |
|---|---|---|
| renderer | React 19 + Tailwind v4（sandbox） | UI 渲染；触达外部世界的唯一方式是 `window.wayang`（preload 白名单：2 个订阅 + 7 个 invoke，快照通道落地后 8 个） |
| preload | contextBridge + ipcRenderer | 把 IPC 通道包成 api 对象一次性暴露；沙箱内只能用受限 Node 面 |
| main | Electron 41 + core（构建期内联） | GUI PATH 修复、配置装载与校验、窗口、fork utility、建 RPC、状态转发、进程生命周期与退出协议、崩溃 resume |
| utility | 纯 Node（core 的 serverMain 内联） | 把父进程当 message port，转成 `{stdin, stdout}` 交给 core 的 server 入口 |

一条用户消息的路径：renderer `invoke` → main 的 `RemoteSupervisor` → RPC `submit_input` → utility 侧 `SignalQueue` 唤醒 controller loop → 状态变更经 `NOTIFY state.event` 推回 main 的 `RemoteStateStore` → `webContents.send` 回 renderer 重渲染。

**会话形态**：单窗口。M3 不做第二个 `BrowserWindow`、不做会话路由；M4 以侧栏会话切换引入多会话，单窗口多会话优先于多窗口形态。

### 2.2 IPC 通道形态

preload 白名单即 renderer 的全部能力面（通道名一律 `wayang:` 前缀）：

| 形态 | 通道 | 用途 |
|---|---|---|
| invoke | `wayang:sendInput` / `wayang:abort` / `wayang:answerInquiry` / `wayang:listTasks` / `wayang:cancelTask` / `wayang:contextUsage` | 转发 `RemoteSupervisor` 调用 |
| invoke | `wayang:respondPermission` | M3 声明不接线；M4 接 worker 级权限卡片 |
| invoke（S2 新增） | `wayang:getInitialState` | 全量快照拉取，首屏与 resume 重放共用 |
| 订阅 | `wayang:state` | `NOTIFY state.event` 逐条转发（target + path + data） |
| 订阅 | `wayang:status` | 连接状态机：connecting / reconnecting / ready / crashed |

权限流走 controller inquire 通道：controller 发起 inquire → renderer 渲染 InquiryCard → 用户应答经 `answerInquiry` 回流。M3 不新增权限 UI 面；worker 级权限卡片为 M4 工作，届时启用 `respondPermission`。

### 2.3 与 core / protocol 的接缝

- **serverMain 可选 io 注入**：core 的 `serverMain(options, io?)` 接收 `ServerIo { stdin, stdout }`；非纯 stdio 的宿主传自己的流对，默认 `process` 保持 CLI 行为不变。desktop 的 utility 入口即以此接入，异常即 `process.exit(1)`；
- **messagePortToStreams**：protocol 的 MessagePort↔流适配器。utility 侧 `process.parentPort` → 流对交给 `serverMain`；main 侧 `asMessagePort(child)`（修补 Electron 双向事件形状不对称）后同样转流，再 `RpcClient(createStreamTransport(io.stdin, io.stdout))`；
- **main 侧客户端栈与 CLI 完全同源**：`RpcClient` + `RemoteStateStore` + `RemoteSupervisor`（core 客户端 SDK），对传输无感；`RemoteStateStore` 自带 per-path 缓存与 `GET_SNAPSHOT`，是首屏快照与 resume 重放的机制基础，零 core 改动；
- **依赖形态**：core / protocol 构建期内联（electron-vite resolve 库 dist），desktop 运行期产物不依赖 `@wayang-ai/*` 安装包；`@wayang-ai/core` / `@wayang-ai/protocol` 以 `workspace:*` 声明在 devDependencies，仅为 turbo 建立构建图边（S0），不动 electron-vite 内联语义；MCP bridge 复制到宿主入口同目录（现源 `apps/cli/dist/mcp-bridge-entry.js`），core 桥的同目录回退路径已预留。

### 2.4 配置装载与热更接缝

- **装载**：配置解析上移已落地（monorepo-design.md 4.1）。main 进程全权装载 `~/.wayang.config.json`、经 `validateConfig` 校验，以 `WAYANG_CONFIG_OBJECT` env 把合法 `WayangConfig` 对象交接给 utility；utility 手动运行（壳外直启）时回退读 `--config` 文件；缺配置走 crashed 状态 UX；
- **热更**：无单一 `UPDATE_CONFIG` 大方法，core 暴露 8 个细粒度 update 方法——`updateProvider` / `updateModel` / `addProvider` / `addModel` / `removeProvider` / `removeModel` / `updateControllerModel` / `updateWorkerSettings`——每个方法的 schema 即字段白名单，宿主直调对应方法，可用 protocol 纯函数在发起前本地预校验。M3 不暴露热更 UI；M4 设置页按所选字段映射到对应方法；
- **`WAYANG_DESKTOP_*` env**（`WAYANG_DESKTOP_WORKSPACE` / `WAYANG_DESKTOP_SESSION`）：定位为 dev 调试覆盖入口（直达指定工作区与 resume 会话），正式路径不依赖；M4 设置页落地后移除。

### 2.5 存储与目录基线

会话 / 日志 / 缓存遵循 macOS / Electron 应用目录规范，经 monorepo-design.md 4.2 的 `StoragePaths` / `WorkspacePolicy` 注入面传入（`defaultWorkerWorkspace` 与 `controllerWorkspace` 同走注入面）。现状走 serverMain 的 legacy `dataDir` / `workspaceDir` 二元组（`~/.wayang` + `~/wayang-desktop`），切换即改为显式注入，改动集中在宿主接缝两处文件：

| 项 | 位置（macOS） | 用途 |
|---|---|---|
| dataDir | `app.getPath('userData')` | `sessions/`、`window-state.json`、`workspaces.json` |
| logDir | `app.getPath('logs')` | `main.log`、`renderer.log`、会话日志 |
| cacheDir | `app.getPath('caches')` | 运行时临时文件、MCP socket 句柄、缓存 |
| config | `~/.wayang.config.json` | 与 CLI 共用同一份用户配置；M4 设置页落地时迁 `userData/config.json` |
| defaultWorkerWorkspace | `~/.agents/wayang-workspace`（启动自动 mkdir） | 未显式指定项目目录时的默认 worker 工作区 |
| controllerWorkspace | `~`（`os.homedir()`） | 进程工作目录与 Controller 起点 |

- **切换时点**：M3 收尾、S4 打包前落地。注入面改动集中、成本可控；拖到 M4 则 `~/.wayang/sessions` 下桌面会话积累越多、迁移越痛，且装包应用写 `~/.wayang` 不合规；
- **跨平台**：Windows / Linux 目录对应在首个真实需求出现时定案；纪律先行——路径一律经 `app.getPath` 集中获取，禁止硬编码平台路径，届时只改注入值不改消费点。

### 2.6 状态重放与崩溃 resume

- **快照与重放机制**：main 侧 `RemoteStateStore` 逐 path 缓存收到的状态事件，并可经 `GET_SNAPSHOT` 主动拉全量。renderer 启动先经 `wayang:getInitialState` 拉快照建初始态、再挂订阅；窗口刷新（`did-finish-load`）时全量重发缓存。server 早于 renderer 就绪推送的初始态由此不丢失，机制零 core 改动；
- **崩溃 resume 语义**：utility 意外退出（exit 时非 stopping）→ 发 `reconnecting` 状态 → 以 `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + 重放快照 → 重注册 IPC 转发。M3 一次性重试，失败落 `crashed`（附 stderr tail 诊断）；`ready` 前崩溃或 sessionId 未知直接 `crashed`，不盲目重试；正常退出协议不变（SHUTDOWN RPC → 5s 宽限 → 强杀），`before-quit` 竞态由 stopping 标记吞掉 exit 事件、不发 reconnecting。

### 2.7 打包形态

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

### 3.2 已知缺口（分级）

a 级（M3 收尾必需）：

| # | 缺口 | 现象 |
|---|---|---|
| a1 | 崩溃 resume 缺失 | utility 意外退出仅发 crashed，无 resume 重连 |
| a2 | electron-builder 分发缺失 | 无打包依赖 / 配置 / dist 脚本 / 图标 |
| a3 | ready 状态黑洞 | `onStatus('ready')` 从未发出（connection.ts 仅 connecting / crashed），「已连接」不可达 |
| a4 | 首屏快照竞态 | server ready 即推快照，早于 renderer 挂监听则初始态永久丢失，无重放通道 |
| a5 | tasks 死路径 | renderer 订阅 `tasks.completed` 而 core 写 `tasks.history`，完成计数恒 0 |

b 级（工程债，M3 一并清偿）：`apps/desktop/package.json` 零 `@wayang-ai/*` workspace 依赖声明（turbo 冷启动竞态根因，已两次复现）；`version` `1.0.0-alpha.0` 落后基线；README 占位文案；设计文档热更方法引用过时（单一 `UPDATE_CONFIG` → 实际 8 个细粒度方法，本文重写即清偿）；单实例锁缺失。

c 级（M4+ 路线，见第 5 节）：IPC 单一契约；主进程分层（Application / WindowManager / MenuManager / SecurityGuard / ServerProcessHost 完整状态机 / SessionService / UnifiedLogger）；renderer 状态重构（`useSyncExternalStore`）；UI/UX 全套（设置页 / Sender 合一 / 上下文圆环 / TurnDotsNav / 长消息折叠）；配置热更设置页；Windows / Linux；多窗口多会话；renderer 日志桥；conversation 分页与 worker 级通道。

## 4. M3 执行计划（S0–S5，约 6 人日）

### 4.0 并行与串行关系

S0 ∥ S1：S0 只动 `apps/desktop/package.json` 依赖声明与 turbo 构建图，S1 只动 connection.ts / store.ts，互不触碰。S1 → S2 → S3 → S4 → S5 串行，依赖理由：

- **机制依赖**：S2 的快照通道建立在 S1 修正后的订阅路径与 ready 语义之上（快照的 10 个 slice 含 `tasks.history`，拉取时机在 ready 之后）；S2 落地的快照 / 重放机制是 S3 与 S4 的共同前置——resume 的重连重放直接复用该通道，装包后的首屏立即有内容同样以它为前提；
- **功能面依赖**：S4 打包以 S1–S3 功能面收齐为前提——装包验证的是「已连接 → 发消息 → worker bash → 干净退出」完整链路，功能未收齐即打包只会反复重打；
- **交付依赖**：S5 以实际交付为输入，最后校准文档与版本。

### 4.1 S0：workspace 依赖声明（与 S1 并行）

`apps/desktop/package.json` 声明 `"@wayang-ai/core": "workspace:*"`、`"@wayang-ai/protocol": "workspace:*"`（devDependencies，建 turbo 图边，不动 electron-vite externalize 语义）。

验收：清 `dist` 全新 install 后冷启动 build 一次通过。

### 4.2 S1：ready 状态与 tasks 路径

connection.ts 补 `onStatus('ready')`（`waitForReady` 成功后发出，含 sessionId）；订阅路径改 `tasks.history`；renderer store 的 `SLICE` 同步。

验收：状态条显示已连接；任务完成计数 ≥1；单测钉住 `SLICE` 字面量。

### 4.3 S2：首屏快照

复用 `RemoteStateStore` per-path 缓存与 `GET_SNAPSHOT`（零 core 改动）：新增 `wayang:getInitialState` IPC（或 `did-finish-load` 全量重发缓存）；preload 增 `getInitialState`；store 启动先拉快照再订阅。

验收：先订阅后请求收齐 10 slice；刷新后界面立即有内容。

### 4.4 S3：崩溃 resume

exit 非 stopping → 发 `reconnecting` → `resume:<sessionId>` 重新 fork → 重建 rpc / store / 重订阅 + 重放 → 重注册 IPC；M3 一次性重试，失败落 crashed；ready 前崩溃或 sessionId 未知直接 crashed；处理 before-quit 竞态。

验收：单测断言第二次 fork argv 带 `resume:<id>`；kill utility 进程后 reconnecting → 恢复且历史仍在。

### 4.5 S4：electron-builder 分发

前置完成 2.5 目录切换（装包应用不写 `~/.wayang`）。mac dmg 先行（appId / productName / 图标）；`asarUnpack` 整目录 `out/main/**`（chunk 哈希名清单式 unpack 会静默失效）；asar 与 `utilityProcess.fork` / spawn 兼容性为首要验证点（有坑回退 extraResources + resourcesPath 显式解析，core 桥同目录回退已预留）；`requestSingleInstanceLock` 前置。

验收：干净 macOS 装 `.app` → 双击 → 已连接 → 发消息 → worker 跑 bash（验 PATH）→ 退出无残留 utility 进程。

### 4.6 S5：收尾校准

README 重写；`version` 对齐 alpha.1；本文档随实现校准；主仓 `release/1.0.0` 的 `CHANGELOG.md` M3 段按实际交付校准。

## 5. M4+ 路线图

c 级缺口的消化按「架构面 → 状态面 → UX 面」分层推进：

- **IPC 单一契约**：`src/shared/ipc-contract.ts` 作为通道名 / 入参 / 返回 / 推送负载的唯一契约源；main 侧 `ipc/router.ts` 泛型 `typedHandle`（Sender 校验 + 入参校验 + `{ok, data, error}` 信封）；preload 侧 `typedInvoke`（统一超时保护 + 解包信封，导出 `WayangBridge` 类型，`global.d.ts` 零重复声明）；renderer 侧 `lib/wayang-api.ts` 薄封装，组件禁止直访 `window.wayang`；
- **主进程分层**：`index.ts` 退化为纯 Bootstrap；`Application` 编排根 + `Disposable` 退出队列统一收口 `before-quit` / `will-quit` / `window-all-closed`（macOS 关窗不退进程）；`WindowManager`（bounds 持久化、`ready-to-show` 防白屏、`windowId↔sessionId` 映射精准路由）；`MenuManager`（原生菜单、Edit 的 Copy / Paste / SelectAll、`dialog.showOpenDialog` 选工作区）；`SecurityGuard`（`will-navigate` 拦截、外链走系统浏览器、默认权限清零、`senderFrame.url` 校验）；`ServerProcessHost`（UtilityProcess 完整状态机 starting → ready → degraded → restarting → fatal、指数退避自愈——M3 单次 resume 升级为自愈策略）；`SessionService`（持有 RemoteSupervisor 与状态订阅）；`UnifiedLogger`（三进程日志汇聚 + renderer 日志桥 + `{proc, windowId, sessionId, reqId}` 关联上下文 + `render-process-gone` / `child-process-gone` 崩溃记录）；
- **状态管理**：UtilityProcess 为业务状态唯一权威源；main 的 `RemoteStateStore` 作可重放缓存（Replay Cache，`getInitialState` 全量快照通道）；renderer 废弃顶层 `useState`，改模块级外部单例 Store + React 19 `useSyncExternalStore` 按 slice key 细粒度订阅（流式输出只重绘当前条目）；
- **UI / UX**：对话列表通铺 + 悬浮 Sender 合一（连接态 / 任务 / worker 计数 + 上下文圆环进度条 + 发送 / 停止按 busy 切换）；Controller 输出 Borderless 撑开、user 消息淡蓝灰卡片（>300px 默认折叠 + 展开按钮）；侧边 `TurnDotsNav` 轮次圆点导航（数据源只取 user 消息、≤20 圆点滑动窗口、hover 预览、点击平滑滚动、`IntersectionObserver` 联动高亮，封装为独立组件不侵入气泡渲染）；表单化 `SettingsPage`（Provider 增删改查、Agent 绑定与 `maxConcurrency`、工作区与权限配置），保存时 main 校验持久化并经 8 个细粒度 update 方法热更到运行中的 server；worker 级权限卡片接通 `respondPermission`；
- **多会话与跨平台**：侧栏会话切换（单窗口多会话优先于多 `BrowserWindow`）；Windows / Linux 目录规范与打包目标；
- **会话运维面**：conversation 分页与 worker 级通道（controller 读取 worker 会话的分页通道，对齐 CLI 的 worker-transcript 语义）。

## 6. 边界与纪律

- **渲染层边界**（check-boundaries 机械检查，monorepo-design.md 3.5）：desktop renderer 只 import protocol 的类型与自身 IPC 胶水，禁止 import core（Node 内建依赖进浏览器环境必炸）；preload 只经 contextBridge 暴露白名单 api；跨包引用一律 `@wayang-ai/*` 包名，`@/` 必须解析到本包 `src/`；desktop 与 cli 互不 import、互不引用对方产物；
- **单实例**：`requestSingleInstanceLock` 于 main 首行前置，第二实例退出并聚焦已有窗口（S4 落地）；
- **目录纪律**：路径一律经 `app.getPath` 集中获取，禁止硬编码平台路径；装包应用不写 `~/.wayang`；
- **进程纪律**：连接状态机只存在于 main，renderer 经 `wayang:status` 消费；renderer 不持有进程 / 连接概念；
- **研发流程**（AGENTS.md）：开发中发现的问题先开 issue（现象 / 影响 / 期望行为 / 验收标准），不以对话记录或 TODO 注释代替；修复合入时 commit 信息与合入说明引用 `Fixes #N` / `Refs #N`；门槛全绿才合入（`npm run lint` / `npx vitest run` / `npm run build`，一律经 turbo）；rebase 节奏——M3 收尾期间不主动 rebase `release/1.0.0`（88ae400 已还清接缝债），仅当 release 动到 serverMain / protocol / 桥位置时同步 rebase，合入前做最终一次。
