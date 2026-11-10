import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useMobileLayout } from '../ui/useMobileLayout'

/** 工作区局部使用抽屉布局，不改变 Electron 其他页面的桌面交互。 */
export function useWorkspaceLayout(root: Ref<HTMLElement | null>) {
  const { isMobile } = useMobileLayout()
  const width = ref<number>()
  let observer: ResizeObserver | undefined
  watch(root, (element) => {
    observer?.disconnect()
    if (!element) return
    if (element.clientWidth > 0) width.value = element.clientWidth
    observer = new ResizeObserver(([entry]) => {
      // KeepAlive 切页时会收到零宽度，不能因此收起用户在宽窗口展开的面板。
      if (entry && entry.contentRect.width > 0) width.value = entry.contentRect.width
    })
    observer.observe(element)
  })
  onBeforeUnmount(() => observer?.disconnect())
  return {
    isCompact: computed(() => isMobile.value || (width.value !== undefined && width.value <= 1000)),
  }
}
