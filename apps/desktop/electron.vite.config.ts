import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@wayang-ai/core', '@wayang-ai/protocol'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'utility-entry': resolve(__dirname, 'src/utility/server-host.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          // Sandboxed renderers (Electron) require a CJS preload.
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    // 多入口结构（renderer/<window-name>/index.html）：当前唯一主窗口；
    // 未来并列窗口各加一个 rollupOptions.input 条目即可。
    root: 'src/renderer',
    resolve: {
      // npm 把 apps/cli 的 react@18 提升到了根 node_modules，而 desktop 用 react@19；
      // 显式指向本包 node_modules，避免提升到根的依赖（lucide-react 等）解析到 react 18。
      // 已用构建产物验证：renderer 包内只有一份 react@19（无 __SECRET_INTERNALS_ 标识）。
      dedupe: ['react', 'react-dom'],
      alias: [
        { find: /^react(\/.*)?$/, replacement: resolve(__dirname, 'node_modules/react$1') },
        { find: /^react-dom(\/.*)?$/, replacement: resolve(__dirname, 'node_modules/react-dom$1') },
        // `@/` 与 tsconfig paths / vitest alias 同源：解析到本包 src/（含 '/' 边界，不误伤 @scope 包）。
        { find: '@', replacement: resolve(__dirname, 'src') },
      ],
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          'main-window': resolve(__dirname, 'src/renderer/main-window/index.html'),
        },
      },
    },
  },
});
