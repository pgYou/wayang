# @wayang-ai/desktop

Wayang 桌面端（macOS）。Electron 壳：主进程当 RPC 客户端、UtilityProcess 承载无头
server（NDJSON-RPC，与 CLI 同协议只换传输层）；renderer 为 React 19 + Tailwind v4
的 shadcn 风格界面。设计与实现现状见 `docs/develop/desktop-app-design.md`。

## 环境要求

- Node ≥ 20，仓库根执行过 `npm install`（npm workspaces：`apps/*`、`packages/*`）；
- 打包（`dist` / `dist:dir`）面向 macOS（dmg 先行）；本包源码经平台配置模块
  （`src/shared/platform-config.ts`）取路径，未做 Windows / Linux 桌面目标。

## 日常开发

```bash
# 仓库根（首次）
npm install && npm run build        # cli/core/protocol 产物就绪（MCP 桥源 apps/cli/dist/）

# apps/desktop
npm run dev                         # electron-vite dev（热更 renderer）
npm run test                        # vitest 单测
npm run lint                        # tsc --noEmit + eslint src/
```

dev 运行期数据落在 Electron 默认目录（`~/Library/Application Support/@wayang-ai/desktop`
等，均经平台配置模块取值，可用 `WAYANG_DESKTOP_*` env 覆盖调试）。

## 构建与分发

```bash
npm run build                       # electron-vite build + MCP 桥复制进 out/main/
npm run dist                        # build + 依赖 staging + electron-builder --mac（dmg）
npm run dist:dir                    # 同上但 --dir：解包 .app（冒烟/检视用）
```

产物在 `apps/desktop/release/`（已 gitignore）：

- `mac/Wayang.app` —— 解包应用；`Wayang-<version>-arch.dmg` 为正式分发物。
- dmg 构建需要 macOS 宿主：electron-builder 的 vendor `dmgbuild` 是 macOS 二进制，
  Linux 上执行会 `Exec format error`（已实证）；非 macOS 环境请以 `dist:dir` 产物
  做文件级核验。签名未配置时构建为未签名包（本仓未配 identity）。

打包形态要点（设计文档 §2.10）：

- **asar + 整目录解包**：`asarUnpack: ["out/main/**"]`——utility 入口与 MCP 桥
  以构建哈希 chunk 命名，清单式 unpack 会随哈希漂移静默失效；Electron 41 下
  `utilityProcess.fork` 与「electron 可执行文件 + asar 内路径」两种形态均实测可用，
  整目录解包保留为稳健基线（纯 `node`/外部进程 spawn 仍需物理文件）。
- **运行时 node_modules**：electron-vite 把全部源码内联进 `out/`，唯 ajv 的
  生成代码在运行期 `require("ajv/dist/runtime/*")` / `require("ajv-formats/dist/formats")`，
  因此 `dependencies` 仅声明 ajv / ajv-formats，`scripts/stage-runtime-deps.mjs`
  按解析闭包把它们复制到 `.runtime-node-modules/` 并经 `files` 显式入包
  （electron-builder 对 workspace 提升布局的自动收集不稳定，勿依赖）。
- **图标**：单一来源 `assets/logo/wayang-mark-icon-512.png`（≥512），
  electron-builder 自动转 `icon.icns`；`BrowserWindow` icon 引用同源资产，
  打包态 mac 使用 bundle 图标，desktop 内不复制图标副本。
- **单实例**：`src/main/index.ts` 首行 `requestSingleInstanceLock`——第二实例
  直接退出，锁持有方聚焦已有窗口（Application 注册 `second-instance`）。
- **应用标识**：appId `ai.wayang.desktop`、productName `Wayang`；打包应用
  userData 为 `~/Library/Application Support/Wayang`（经 extraMetadata 注入
  productName，与 dev 目录天然隔离）。
