# @wayang-ai/desktop

桌面端外壳（Electron）在 **M3** 落地。

本包当前只占位：不参与构建、不参与 workspaces 脚本，也不被 `@wayang-ai/cli` 依赖。
M3 接入时它会以工作区内的包形式复用 `@wayang-ai/core` 与 `@wayang-ai/protocol`，
并承载 Electron 主进程与渲染进程的入口。
