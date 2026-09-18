/// <reference types="vite/client" />

/**
 * 构建期由 vite.config.ts 的 `define` 注入（见 docs/plans/2026-09-18-build-info-design.md）。
 *
 * ⚠️ define 是**文本替换**：值在构建时就被内联成对象字面量，运行时并不存在这个全局变量。
 * 用内联 `import(...)` 类型表达式而不是顶层 `import type`，是为了让本文件保持「全局脚本」
 * 的性质 —— 一旦出现顶层 import，`declare const` 就不再是全局声明了。
 */
declare const __BUILD_INFO__: import('./utils/buildInfo').BuildInfo;
