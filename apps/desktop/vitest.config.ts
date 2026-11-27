import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      // 仓库级静态资产（assets/logo 单一来源）；必须排在 `@` 之前（先到先得）。
      { find: '@assets', replacement: path.resolve(__dirname, '../../assets') },
      // `@/*` is package-local only; cross-package reads use `@wayang-ai/*`.
      { find: '@', replacement: path.resolve(__dirname, 'src') },
      // npm 把 apps/cli 的 react@18 提升到了根；让经过 Vite 管线的模块统一用 desktop 的 react@19。
      { find: /^react(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/react$1') },
      { find: /^react-dom(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/react-dom$1') },
      // lucide-react 的 exports 先命中 node 条件（CJS），会被 externalize 而绕过上面的 alias；
      // 显式指向 ESM 入口，让它进入 Vite 管线（pnpm 布局下从本包 node_modules 解析）。
      {
        find: /^lucide-react$/,
        replacement: path.resolve(__dirname, 'node_modules/lucide-react/dist/esm/lucide-react.mjs'),
      },
    ],
  },
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    server: {
      deps: {
        inline: ['lucide-react', /^@radix-ui\//, /^@ant-design\//, 'html-react-parser'],
      },
    },
  },
});
