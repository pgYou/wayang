# apps/desktop 开发规范

包级规范与根级 `AGENTS.md` 叠加生效。通用纪律（边界、测试门槛、版本流程）看根级，这里只讲 desktop 特有的。

## 命令（pnpm 口径，勿用 npm）

```bash
pnpm dev          # Electron 开发模式（turbo：先构建 protocol/core 依赖再启动）
pnpm test         # vitest 单测（含 ui-discipline / renderer-boundary / 纪律测试）
pnpm run lint     # tsc --noEmit + eslint
pnpm run build    # electron-vite 三段构建（main / preload / renderer）
pnpm run dist:dir # 打包冒烟（含 runtime deps staging）
```

## 目录结构

```
src/
  main/         # Electron 主进程（窗口、安全、SessionService）
  preload/      # IPC 桥
  utility/      # UtilityProcess 宿主（server fork）
  shared/       # 跨上下文代码（IPC 契约、platform-config、onboard）
  renderer/
    main-window/   # 主窗口（多入口之一；未来窗口并列同层级）
      App.tsx / main.tsx / index.html
      pages/<page>/        # 页面：chat-page 编排 + rows/（消息行）+ parts/（部件）+ markdown/
    shared/       # 跨窗口公共代码：components/ui（原子组件）、lib、styles、types
```

- 新窗口 = `renderer/<window-name>/index.html` + electron.vite.config 的 input 表加一行 + WindowManager load 对应路径。
- 跨窗口复用的组件放 `renderer/shared/`，页面私有的放 `pages/<page>/rows|parts/`。

## UI 规范（ui-discipline 测试强制执行大部分条目）

- **按钮一律用 `@/renderer/shared/components/ui/button` 的 Button**（icon / 常规 / link 文本形态都已有）。
  原生 `<button>` 仅允许一种例外：非标准按钮样式的「可点击交互容器」（工具调用行、空态建议卡片、
  会话列表条目这类整行/整卡交互，用原生 button 承载无障碍语义）。
- **主题 token**：颜色/背景一律走 token（`bg-muted`、`text-muted-foreground`…），不写死色值。
  token 值统一用 **oklch** 书写（感知均匀，层次调节只动 L 通道）。深色为主色 + 多灰阶主体；
  灰蓝（`sky-*`）只用于少数特殊位（用户气泡、链接、进行中状态、数据可视化）。
  例外：**动画驱动的动态测量值**（如折叠 max-height）允许命令式 `el.style.x` 设置——
  JSX 里仍禁 `style={{}}`（散落静态样式才是反模式）。
- **间距走 4/8 网格**（py-1、gap-2…，不用 0.5 步进）；行类组件行高统一 `h-6`（24px）。
- **样式模块化**：组件样式放同名 `.scss` 就近 import，`globals.css` 只保留 token 与 Tailwind 入口；
  `.scss` 里不用 `@apply`（Tailwind 的 Vite 插件不处理 scss 入口）。
- **语义类名前缀 `wayang-*`**：需要 DevTools 定位 / 测试选择器 / 样式覆盖锚点时加（如 `wayang-user-row`）。
- hover 高亮需要 padding 但不能破坏左对齐时，用负外边距抵消（`-mx-2 px-2`）。

## import 规范

- 跨目录引用一律 alias：`@/renderer/shared/...`、`@/renderer/main-window/...`、`@/shared/...`（`@` = desktop `src/`）。
- 同目录 / 子目录用浅相对（`./xxx`）。
- 边界：renderer 只经 `lib/wayang-api.ts` 访问 IPC 桥；跨包引用只用 `@wayang-ai/protocol`（类型）。
  `check-boundaries.mjs` 强制执行，desktop 的 `@/` 白名单命名空间：main/preload/renderer/utility/shared。

## 测试注意

- `ui-discipline` 扫描 `renderer/shared/components` 与各 window 的 `pages`——新页面目录要加进扫描范围。
- `vi.mock` 的路径相对测试文件解析且必须与被测组件的 import 同源（alias 改动时同步改 mock 路径）。
- 测试里 fixture 路径要 realpath 化（macOS `/var` symlink 会让字符串精确匹配的断言失败）。
