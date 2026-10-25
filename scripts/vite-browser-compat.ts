/**
 * Vite 6 默认包含 Safari 14.0，而 esbuild 0.28 按完整解构支持要求 Safari 14.1。
 * 显式声明真实兼容范围，避免依赖预打包尝试执行已不支持的解构降级转换。
 * 保留其他浏览器与 ES2020 基线；不能通过伪造 supported 或回退安全依赖绕过。
 */
export const browserTargets = ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14.1']

// 依赖预打包不继承 build.target，每个浏览器入口都需要单独设置。
export const browserDependencyOptions = {
  esbuildOptions: { target: browserTargets },
}
