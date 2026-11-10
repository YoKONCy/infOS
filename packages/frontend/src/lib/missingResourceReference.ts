import { ApiError } from '../api/errors'

/** 后端解析文件引用时确认找不到文件（已写明查找范围），区别于越界、占用等其他失败。 */
export function isMissingReference(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    !!error.data &&
    typeof error.data === 'object' &&
    (error.data as { reason?: unknown }).reason === 'reference_not_found'
  )
}

/**
 * 把正文中的文件引用标记为失效：去掉可点击入口与箭头，悬停显示查找说明。
 * 只改本次渲染的 DOM；重新渲染后仍可再次尝试（文件可能已恢复）。
 */
export function markMissingReference(link: HTMLElement, message: string): void {
  link.removeAttribute('data-resource-source')
  link.removeAttribute('href')
  link.classList.add('chat-resource-chip--missing')
  link.setAttribute('aria-disabled', 'true')
  link.title = message
  link.querySelector('span[aria-hidden="true"]')?.remove()
  const last = link.lastChild
  if (last?.nodeType === Node.TEXT_NODE && last.textContent?.endsWith(' ↗'))
    last.textContent = last.textContent.slice(0, -2)
}
