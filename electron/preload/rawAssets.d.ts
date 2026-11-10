/** Vite 的 `?raw` 导入：以字符串形式内联文件内容（预制件 preload 内联公共动效层样式）。 */
declare module '*.css?raw' {
  const content: string
  export default content
}
