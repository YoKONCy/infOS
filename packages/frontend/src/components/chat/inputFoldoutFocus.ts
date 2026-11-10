/**
 * inputFoldoutFocus — InputBarFoldout 面板的焦点选择。
 *
 * 面板里可能有折叠列表、滑块等，只把真正看得见、点得到的按钮算进键盘轮转和初始焦点。
 */

/** 按钮是否可见可达：折叠列表仍保留 DOM，不能把其中的已选按钮当作面板初始焦点。 */
export function isReachableFoldoutButton(button: HTMLButtonElement): boolean {
  if (button.closest('[inert], [hidden], [aria-hidden="true"], .session-collapse:not(.is-open)'))
    return false
  for (let element: HTMLElement | null = button; element; element = element.parentElement) {
    const style = getComputedStyle(element)
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false
  }
  return true
}

/**
 * 打开面板后选初始焦点：标了 data-foldout-initial 的优先，其次已选项，再次第一项；
 * last 为 true 时选最后一项。关闭按钮与 data-foldout-skip 不参与。
 */
export function focusFoldoutOption(
  buttons: HTMLButtonElement[],
  last: boolean,
  panel: HTMLElement | null,
): void {
  const options = buttons.filter(
    (button) =>
      !button.hasAttribute('data-foldout-close') && !button.hasAttribute('data-foldout-skip'),
  )
  const initial = options.find((button) => button.hasAttribute('data-foldout-initial'))
  const selected = options.find((button) => button.getAttribute('aria-pressed') === 'true')
  const preferred = last ? options.at(-1) : (initial ?? selected ?? options[0])
  // 样式或浏览器规则仍可能阻止聚焦；确认成功后才结束，避免焦点留在入口。
  for (const candidate of [preferred, ...options]) {
    candidate?.focus({ preventScroll: true })
    if (candidate && document.activeElement === candidate) return
  }
  panel?.focus({ preventScroll: true })
}
