/**
 * Renderer-imported static assets（仓库根 `assets/`，经 `@assets` 别名）：
 * Vite 把 SVG import 编译为资源 URL（小文件构建期内联为 data URI）。
 * 本包 tsconfig 只带 node types（无 vite/client），在此声明模块形态。
 */
declare module '*.svg' {
  const src: string;
  export default src;
}
