# @wayang-ai/desktop

Wayang 桌面端外壳（Electron）。主进程当 RPC 客户端、UtilityProcess 承载无头
server（NDJSON-RPC，与 CLI 同协议只换传输层）；renderer 为 React 19 +
Tailwind v4 的 shadcn 风格界面。

以工作区内的包形式复用 `@wayang-ai/core` 与 `@wayang-ai/protocol`
（构建期内联），并承载 Electron 主进程、preload 与渲染进程的入口。
设计与现状见 `docs/develop/desktop-app-design.md`。
