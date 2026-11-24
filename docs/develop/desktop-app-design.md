# Wayang Desktop 应用架构设计（草稿）

> 状态：**草稿 / 非正式**——供讨论与迭代规划用，未定案；随 core/cli 改造（阶段一）落地后需校准。
> 依据：`feat/desktop-m3` 现状 + 《Wayang Desktop 与 Core 解耦宏观架构方案》Part 2；现状事实以分支代码为准。
> 关联：core/cli 侧正式设计见主仓 `release/1.0.0` 的 `docs/develop/monorepo-design.md`（第 4 节为改造执行计划）。

## 1. 定位与双进程结构

desktop 是 Electron 壳：**main 进程当 RPC 客户端 + UtilityProcess 当无头 server 宿主**，RPC 帧与 CLI 完全同协议（stdio 上的 NDJSON-RPC），只换传输层。四个执行上下文：

| 上下文 | 技术栈 | 职责 |
|---|---|---|
| renderer | React 19 + Tailwind v4（sandbox） | UI 渲染；触达外部世界的唯一方式是 `window.wayang`（preload 白名单：2 个订阅 + 7 个 invoke） |
| preload | contextBridge + ipcRenderer | 把 IPC 通道包成 api 对象一次性暴露；沙箱内只能用受限 Node 面 |
| main | Electron 41 + core（构建期内联） | GUI PATH 修复、窗口、fork utility、建 RPC、状态转发、进程生命周期与退出协议 |
| utility | 纯 Node（core 的 serverMain 内联） | 把父进程当 message port，转成 `{stdin, stdout}` 交给 core 的 server 入口 |

一条用户消息的路径：renderer `invoke` → main 的 `RemoteSupervisor` → RPC `submit_input` → utility 侧 `SignalQueue` 唤醒 controller loop → 状态变更经 `NOTIFY state.event` 推回 main 的 `RemoteStateStore` → `webContents.send` 回 renderer 重渲染。

## 2. 与 core / protocol 的接缝

- **serverMain 可选 io 注入**：core 的 `serverMain(options, io?)` 接收 `ServerIo { stdin, stdout }`；非纯 stdio 的宿主（UtilityProcess over message port）传自己的流对，默认 `process` 保持 CLI 行为不变。desktop 的 utility 入口即以此接入，异常即 `process.exit(1)`；
- **messagePortToStreams**：protocol 的 MessagePort↔流适配器。utility 侧 `process.parentPort` → 流对交给 `serverMain`；main 侧 `asMessagePort(child)`（修补 Electron 双向事件形状不对称）后同样转流，再 `RpcClient(createStreamTransport(io.stdin, io.stdout))`；
- **main 侧客户端栈与 CLI 完全同源**：`RpcClient` + `RemoteStateStore` + `RemoteSupervisor`（core 客户端 SDK），对传输无感；
- **依赖形态**：core / protocol 构建期内联（electron-vite resolve 库 dist），desktop 运行期不依赖任何 `@wayang-ai/*` npm 包；MCP bridge 经 extraResources 复制到宿主入口同目录；
- **前置依赖（阶段一 core/cli 改造，见主仓 monorepo-design.md 第 4 节）**：
  - 配置解析上移后，desktop main 进程全权装载配置、直传 `WayangConfig` 对象（server 不再自行读 `--config` 文件）；设置页保存经 `METHOD.UPDATE_CONFIG` 运行时热更新；
  - `StoragePaths` / `WorkspacePolicy` 双轨注入后，desktop 按 macOS 规范注入（见第 3 节），worker 默认工作区不再被应用数据目录绑架。

## 3. 目录与环境基线（规划）

不再照搬 CLI 的 `~/.wayang` 模式，严格遵循 macOS / Electron 应用目录规范：

| 项 | 位置（macOS） | 用途 |
|---|---|---|
| dataDir | `~/Library/Application Support/<应用名>/`（`app.getPath('userData')`） | `config.json`、`window-state.json`、`sessions/`、`workspaces.json` |
| logDir | `~/Library/Logs/<应用名>/`（`app.getPath('logs')`） | `main.log`、`renderer.log`、`sessions/<id>/wayang.log` |
| cacheDir | `~/Library/Caches/<Bundle ID>/` | 运行时临时文件、MCP socket 句柄、缓存 |
| defaultWorkerWorkspace | `~/.agents/wayang-workspace`（启动自动 mkdir） | 未显式指定项目目录时的默认 worker 工作区 |
| controllerCwd | `~`（`os.homedir()`） | 进程工作目录与 Controller 起点 |

## 4. 后续迭代方向（要点式）

- **IPC 单一契约**：`src/shared/ipc-contract.ts` 作为通道名 / 入参 / 返回 / 推送负载的唯一契约源；main 侧 `ipc/router.ts` 泛型 `typedHandle`（Sender 校验 + 入参校验 + `{ok,data,error}` 信封）；preload 侧 `typedInvoke`（统一超时保护 + 解包信封，导出 `WayangBridge` 类型，`global.d.ts` 零重复声明）；renderer 侧 `lib/wayang-api.ts` 薄封装，组件禁止直访 `window.wayang`；
- **主进程分层**：`index.ts` 退化为纯 Bootstrap（首行 `requestSingleInstanceLock`）；`Application` 编排根 + `Disposable` 退出队列统一收口 `before-quit`/`will-quit`/`window-all-closed`（macOS 关窗不退进程）；`WindowManager`（bounds 持久化、`ready-to-show` 防白屏、`windowId↔sessionId` 映射精准路由）；`MenuManager`（原生菜单、Edit 的 Copy/Paste/SelectAll、`dialog.showOpenDialog` 选工作区）；`SecurityGuard`（`will-navigate` 拦截、外链走系统浏览器、默认权限清零、`senderFrame.url` 校验）；`ServerProcessHost`（UtilityProcess 状态机 starting→ready→degraded→restarting→fatal、指数退避自愈、`resume:<sessionId>` 重连、首屏全量快照重放消除「server 比窗口先 ready」竞态）；`SessionService`（持有 RemoteSupervisor 与状态订阅）；`UnifiedLogger`（三进程日志汇聚 + IPC 日志桥 + `{proc,windowId,sessionId,reqId}` 关联上下文 + `render-process-gone`/`child-process-gone` 崩溃记录）；
- **状态管理**：UtilityProcess 为业务状态唯一权威源；main 的 `RemoteStateStore` 作可重放缓存（Replay Cache，提供 `getInitialState` 全量快照通道）；renderer 废弃顶层 `useState`，改模块级外部单例 Store + React 19 `useSyncExternalStore` 按 slice key 细粒度订阅（流式输出只重绘当前条目）；`SUBSCRIBED_PATHS`/`SLICE` 中 `tasks.completed` 修正为 `tasks.history` 对齐 core；
- **UI / UX 升级**：对话列表通铺 + 悬浮 Sender（Footer 合一：连接态 / 任务 / worker 计数 + 上下文圆环进度条 + 发送/停止按 busy 切换）；Controller 输出 Borderless 撑开、user 消息淡蓝灰卡片（>300px 默认折叠 + 展开按钮）；侧边 `TurnDotsNav` 轮次圆点导航（数据源只取 user 消息、≤20 圆点滑动窗口、hover 预览、点击平滑滚动、`IntersectionObserver` 联动高亮，封装为独立组件不侵入气泡渲染）；表单化 `SettingsPage`（Provider 增删改查、Agent 绑定与 `maxConcurrency`、工作区与权限配置），保存时 main 校验持久化并经 `UPDATE_CONFIG` 热更新到运行中的 server。

## 5. 待定项

- 多窗口 / 多会话的 UI 形态与路由细节（`windowId↔sessionId` 映射已规划，入口交互待定）；
- `UPDATE_CONFIG` 可热更字段白名单与拒绝语义（依赖阶段一定案）；
- 现有 `WAYANG_DESKTOP_WORKSPACE` / `WAYANG_DESKTOP_SESSION` 等环境变量与 `WorkspacePolicy` 的映射去留；
- electron-builder 打包配置与 extraResources 清单（utility-entry、MCP bridge）最终形态；
- Windows / Linux 的目录规范对应（当前以 macOS 为基线）；
- `feat/desktop-m3` rebase 到改造后 `release/1.0.0` 基线的时点与冲突处理。
