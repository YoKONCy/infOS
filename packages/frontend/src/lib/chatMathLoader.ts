/**
 * chatMathLoader — 聊天富文本的 KaTeX 按需加载
 *
 * KaTeX 体积较大，只在内容可能含公式时加载。katex 以活绑定导出，
 * 加载完成后 chatRichRenderer 直接读到新值；就绪时通知订阅的渲染组件重绘。
 */
import type katexModule from 'katex'

export let katex: typeof katexModule | undefined
let katexLoading: Promise<void> | undefined
const mathReadyListeners = new Set<() => void>()

/** 依赖就绪后只通知受影响的渲染组件，调用方负责在销毁时取消订阅。 */
export function onChatMathReady(listener: () => void): () => void {
  mathReadyListeners.add(listener)
  return () => {
    mathReadyListeners.delete(listener)
  }
}

export function loadMathRenderer(): Promise<void> {
  katexLoading ??= import('katex').then(
    (module) => {
      katex = module.default
      for (const listener of [...mathReadyListeners]) listener()
    },
    (error: unknown) => {
      katexLoading = undefined
      throw error
    },
  )
  return katexLoading
}
