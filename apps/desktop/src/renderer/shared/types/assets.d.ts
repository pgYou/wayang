/**
 * Renderer-imported static assets 与样式模块声明：
 * - `@assets/*.svg`（仓库根 assets/ 经 @assets 别名）：Vite 把 SVG import
 *   编译为资源 URL（小文件构建期内联为 data URI）；
 * - `*.scss`：组件就近样式（组件自己 import，Tailwind 的 Vite 插件只处理
 *   .css 入口），side-effect import 无导出。
 * 本包 tsconfig 只带 node types（无 vite/client），在此统一声明模块形态。
 */
declare module '*.svg' {
  const src: string;
  export default src;
}

/** SVG 源码（`?raw`）：要动到图形内部的组件（WayangMark 逐条折线做动画）用。 */
declare module '*.svg?raw' {
  const src: string;
  export default src;
}

/** 位图（electron-builder 图标源 / 未来 UI 资产）：Vite 一律编译为资源 URL。 */
declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.ico' {
  const src: string;
  export default src;
}

/** 字体文件（Vite 资源 URL）。 */
declare module '*.woff' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}

declare module '*.ttf' {
  const src: string;
  export default src;
}

declare module '*.otf' {
  const src: string;
  export default src;
}

/** 全局样式入口（globals.css 经 Vite 管线，side-effect import）。 */
declare module '*.css';

/** 组件就近样式（side-effect import 无导出）。 */
declare module '*.scss';
