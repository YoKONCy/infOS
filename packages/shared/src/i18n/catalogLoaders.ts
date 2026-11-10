/**
 * 按语言延迟装配词库的注册表。
 *
 * 前端构建会把各语言词库拆成独立分块，并在此登记加载器；首屏只装配当前语言，
 * 切换语言时再加载目标语言。未登记加载器的运行端（后端、Electron 主进程、单元测试）
 * 仍按原方式同步注册全部语言，`ensureLocaleCatalogs` 对它们恒为已就绪。
 */
import type { AppLocale } from './index'

/** 返回 Promise 表示该语言词库正在异步装配；返回 undefined 表示该语言无需额外装配。 */
export type CatalogLoader = (language: AppLocale) => Promise<unknown> | undefined

const loaders: CatalogLoader[] = []
const loaded = new Set<AppLocale>()
const pending = new Map<AppLocale, Promise<void>>()

export function registerCatalogLoader(loader: CatalogLoader): void {
  loaders.push(loader)
  // 新加载器尚未为任何语言执行过，已就绪记录需要重新确认。
  loaded.clear()
}

/**
 * 确保指定语言的延迟词库已装配。
 * 已就绪时同步返回 undefined，调用方可立即切换；否则返回装配完成的 Promise。
 * 装配失败也会 resolve：`translate` 会回退简中原文，下次切换到该语言时重试。
 */
export function ensureLocaleCatalogs(language: AppLocale): Promise<void> | undefined {
  if (loaders.length === 0 || loaded.has(language)) return undefined
  const current = pending.get(language)
  if (current) return current
  const results = loaders.map((loader) => loader(language))
  // 无需装配的语言（如与原文一致的简中）同步就绪，切换不经过异步等待。
  if (results.every((result) => result === undefined)) {
    loaded.add(language)
    return undefined
  }
  const task = Promise.all(results)
    .then(
      () => {
        loaded.add(language)
      },
      () => {
        /* 词库分块缺失时回退原文显示 */
      },
    )
    .finally(() => {
      pending.delete(language)
    })
  pending.set(language, task)
  return task
}
