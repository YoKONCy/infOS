/**
 * Vite 构建时注入的全局常量类型声明
 *
 * @see packages/frontend/vite.config.ts — define 配置
 * @see scripts/sync-version.ts — 版本号同步脚本
 */

/** 应用版本号 (构建时由 vite.config.ts 从根 package.json 注入) */
declare const __APP_VERSION__: string

interface Window {
  electron?: {
    clientCredential?: () => string
    backendOrigin?: () => string
    connectionMode?: () => 'local' | 'remote' | ''
    embedded?: boolean
    toastOverlay?: boolean
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    send(channel: string, ...args: unknown[]): void
    on(channel: string, listener: (...args: unknown[]) => void): () => void
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
