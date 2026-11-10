import { ref, type Ref } from 'vue'
import { useEventListener } from '../useEventListener'

/**
 * 下拉选择器的键盘导航：方向键 / Home / End 移动高亮，Enter / 空格确认，Esc 关闭。
 * 打开期间在 document 捕获阶段接管按键；由 PSelect 接线。
 */
export function useSelectKeyboard(options: {
  /** 当前选项列表（只读取 disabled）。 */
  items: () => ReadonlyArray<{ disabled?: boolean }>
  isOpen: Ref<boolean>
  triggerRef: Ref<HTMLElement | null>
  dropdownRef: Ref<HTMLElement | null>
  /** 列表内单个选项的选择器，用于滚动定位。 */
  optionSelector: string
  open: () => void
  close: () => void
  select: (index: number) => void
}) {
  const { items, isOpen, triggerRef, dropdownRef } = options
  const activeIndex = ref(-1)

  /** 只滚列表自身，scrollIntoView 可能连带滚动外层页面。 */
  function revealActiveOption(): void {
    const dropdown = dropdownRef.value
    if (!dropdown || activeIndex.value < 0) return
    const element = dropdown.querySelectorAll<HTMLElement>(options.optionSelector)[
      activeIndex.value
    ]
    if (!element) return
    const top = element.offsetTop
    const bottom = top + element.offsetHeight
    if (top < dropdown.scrollTop) dropdown.scrollTop = top
    else if (bottom > dropdown.scrollTop + dropdown.clientHeight) {
      dropdown.scrollTop = bottom - dropdown.clientHeight
    }
  }

  function moveActive(step: 1 | -1, from: number): void {
    const list = items()
    const count = list.length
    for (let offset = 0, index = from; offset < count; offset += 1) {
      index = (index + step + count) % count
      if (!list[index]?.disabled) {
        activeIndex.value = index
        revealActiveOption()
        return
      }
    }
  }

  function confirmActive(): void {
    if (items()[activeIndex.value]) options.select(activeIndex.value)
    else options.close()
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (isOpen.value || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    options.open()
  }

  /** 打开期间在捕获阶段接管按键，Esc 只关列表，不会连带关掉外层对话框。 */
  function handleOpenKeydown(event: Event): void {
    if (!isOpen.value) return
    const { key } = event as KeyboardEvent
    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      options.close()
      triggerRef.value?.focus({ preventScroll: true })
      return
    }
    if (key === 'Tab') {
      options.close()
      return
    }
    const focused = document.activeElement
    if (focused !== triggerRef.value && focused !== document.body) return
    const handlers: Record<string, () => void> = {
      ArrowDown: () => moveActive(1, activeIndex.value),
      ArrowUp: () => moveActive(-1, Math.max(activeIndex.value, 0)),
      Home: () => moveActive(1, -1),
      End: () => moveActive(-1, items().length),
      Enter: confirmActive,
      ' ': confirmActive,
    }
    const handler = handlers[key]
    if (!handler) return
    event.preventDefault()
    event.stopPropagation()
    handler()
  }

  useEventListener(document, 'keydown', handleOpenKeydown, { capture: true })

  return { activeIndex, revealActiveOption, handleTriggerKeydown }
}
