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
      components/          # 窗口级共享组件（不属于任何单一页面，暂不为其他窗口所用）
        settings/          # 设置页与 onboard 向导共用的配置组件：原子表单 + 卡片容器
    shared/       # 跨窗口公共代码：components/ui（原子组件）、lib、styles、types
```

- 新窗口 = `renderer/<window-name>/index.html` + electron.vite.config 的 input 表加一行 + WindowManager load 对应路径。
- 跨窗口复用的组件放 `renderer/shared/`，只被一个窗口的多个页面复用的放该窗口的 `components/`，页面私有的放 `pages/<page>/rows|parts/`。

## UI 规范（ui-discipline 测试强制执行大部分条目）

- **按钮一律用 `@/renderer/shared/components/ui/button` 的 Button**（icon / 常规 / link 文本形态都已有）；只放图标的用 `ui/icon-button` 的 `IconButton`（`label` 必填，默认小一号、平时次要色、悬停正文字色；变体管颜色、尺寸管「只有图标」，两者可组合）。
  原生 `<button>` 仅允许一种例外：非标准按钮样式的「可点击交互容器」（工具调用行、
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
- 多行输入用 `ui/textarea`：高度跟内容走（一行时与 Input 等高，随内容长高，7 行封顶后框内滚动），不要传 `rows` 或手写测量——靠 CSS `field-sizing` 实现。
- **一次性提示（保存反馈、操作结果）用 sonner toast**：`ui/sonner` 的 `Toaster` 已挂在 App 根上，业务代码只调 `toast()`（来自 `sonner`）；不在页面里手写提示条。toast 的配色经 `ui/sonner.scss` 接回 token。

## 设置组件（`main-window/components/settings/`）——设置页与 onboard 向导共用

原子表单：
- 每个组件只管「一个配置实体的表单」：受控（`value` / `onChange`），值是输入框里的原始文本，不管持久化——设置页把保存接到 `commit`，向导接进本地草稿。表单值 ⇄ 配置的转换与校验函数跟组件同文件导出，保存前一律走它，页面里不另写一份校验。
- 下拉类控件要放在 `FormField` 的渲染函数里，把拿到的 `id` 传给触发器（`<SelectTrigger id={id}>` / `<ModelBindingSelect id={id}>`），否则 label 关联不到控件；开关同理（`<Switch id={id}>`）。
- 字段随某个枚举变化的实体（如 `workers.<id>` 按 `type`）不写一张通吃的大表单：公共字段一组组件，每个取值各自的专属字段各一组，只摆这个取值真正会读的键（去 core 里核对，别照文档想当然）；表单值仍是一份扁平对象，校验与写回只看当前取值的字段。写回时留空的可选字段、停在默认值的开关不落盘。

卡片容器（`ProviderCard` / `ModelCard` / `WorkerCard` / `ModelsGroup` / `AgentGroup`、`FormDialog`、`SettingsSection` 等）也在这里，设置页和向导用同一套——交互要改就改这里的组件，**不要在向导里另写一套卡片**（出现过向导是「文字按钮 + 原地表单」、设置页是「图标按钮 + 弹窗」的分叉）。
- 提交口统一是 `ConfigCommit`（`commit.ts`）：设置页接后端保存（`pages/settings/use-config-commit.ts`），向导接本地草稿；卡片组件不关心背后是谁。组件目录不要反向 import `pages/`。
- 向导的两步就是设置页的「模型」「Agent」两个分组原样渲染，只靠入参略作裁剪：`ModelsGroup` 的 `title={null}`（步骤名在 timeline 上，不再放分区标题）、`AgentGroup` 的 `thirdPartyWorkers={false}`（第三方 worker 不在 onboard 里添加，之后在设置页加）。
- 向导的两步和最后的确认页用的是同一套分组：确认页把两个分组一起摆出、可原地修改（不要再写只读的汇总清单），整份配置合法才能「进入应用」；从 CLI 导入的配置也直接落到确认页。
- 设置卡片的边框 / 投影是按灰底的设置页调的（透明边框 + 柔影）。放到白底页面上时通过分组组件的 `cardClassName` 换外观（onboard 传 `border-border shadow-none`，它会一路传到分组里的每张卡片）——不要为不同底色再复制一套卡片。
- 第三方 worker 停用的行不参与协议校验（`validateConfig` 跳过 `enable: false` 的行），所以它可能不合法（如导入 CLI 配置时被置为停用的行）。**启用前必须校验这一行**：`workerEntryProblem(config, id)` 非空就拦下并显示原因，不提交。

## 设置页自有的分组（`pages/settings/parts/`）

只放只有设置页用的分组：`DraftRow` 与权限 / 工作区 / 高级分组。
- 分区用 `SettingsSection`（大标题 + 卡片，标题行右侧可放 `action`）；「输入类」的一行用 `DraftRow`：标签 + 控件 + 草稿 + 保存 / 取消，控件由 children 渲染，校验用 `problem` 就近显示。不要在业务代码里手拼 `useDraftSection` + `SaveCancelBar`。
- 保存 / 取消只在有改动时出现；新增 / 编辑走弹窗（`FormDialog`），卡片本身只读。

## import 规范

- 跨目录引用一律 alias：`@/renderer/shared/...`、`@/renderer/main-window/...`、`@/shared/...`（`@` = desktop `src/`）。
- 同目录 / 子目录用浅相对（`./xxx`）。
- 边界：renderer 只经 `lib/wayang-api.ts` 访问 IPC 桥；跨包引用只用 `@wayang-ai/protocol`（类型）。
  `check-boundaries.mjs` 强制执行，desktop 的 `@/` 白名单命名空间：main/preload/renderer/utility/shared。

## 测试注意

- 跑桌面端测试在 `apps/desktop` 下 `pnpm exec vitest run`；全仓用 `pnpm run test`（turbo 逐包）。仓库根目录的 `pnpm exec vitest run` 只包含 `packages/*`，**不含 apps/**。

- `ui-discipline` 扫描 `renderer/shared/components`、各 window 的 `pages` 与 `main-window/components`——新目录要加进扫描范围。
- **测试里找元素一律用 `data-testid`**，按「在哪、做什么」命名，不含文案（`wizard-next`、`provider-add`、`nav-agent`）；同一动作出现在多行上（provider / 模型 / worker 的编辑、删除）时配 `data-id` 标明是哪一行。辅助函数在 `renderer/shared/lib/__tests__/anchors.ts`（`byTestId` / `queryByTestId` / `allByTestId` / `rowAction`）。**不要按可见文案或 aria-label 找**：那些是给用户看的，改一次文案测试就得跟着改。`label[for]` → 控件的关联是无障碍契约，找输入框可以继续用它。要断言「用户看到了哪句提示」，先用锚点定位到那个元素再看它的文字。给组件加锚点时同样只加 `data-testid` / `data-id`，不加测试专用的类名。
- `vi.mock` 的路径相对测试文件解析且必须与被测组件的 import 同源（alias 改动时同步改 mock 路径）。
- 测试里 fixture 路径要 realpath 化（macOS `/var` symlink 会让字符串精确匹配的断言失败）。
