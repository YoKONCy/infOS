/**
 * useChatScroll — 聊天滚动管理
 *
 * 功能：
 * 1. 自动判断是否在底部 (isAtBottom)
 * 2. scrollToBottom 平滑滚动
 * 3. 流式生成时自动吸底
 * 4. 滚动测量与内容尺寸变化按帧合并
 *
 */

import {
  inject,
  ref,
  shallowRef,
  watch,
  nextTick,
  onActivated,
  onDeactivated,
  onUnmounted,
} from 'vue'
import type { Ref } from 'vue'
import { useEventListener } from '../useEventListener'

/** 底部判定阈值 (px) */
const BOTTOM_THRESHOLD = 96

/**
 * @param containerRef - 可滚动容器
 * @param messageCount - 消息数量 (Ref), 用于监听变化自动滚动
 */
export function useChatScroll(
  containerRef: Ref<HTMLElement | null>,
  messageCount?: Ref<number>,
  shouldAutoScroll = () => true,
) {
  /** 是否在底部 */
  const isAtBottom = ref(true)
  /** 是否显示"回到底部"按钮 */
  const showScrollDown = ref(false)
  const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
  const contentElements = new Set<Element>()
  let active = true
  let scrollFrame = 0
  let followFrame = 0
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleFollow) : undefined

  function selectionInside(): boolean {
    const selection = window.getSelection()
    return (
      !!selection &&
      !selection.isCollapsed &&
      !!selection.anchorNode &&
      !!containerRef.value?.contains(selection.anchorNode)
    )
  }
  function scheduleFollow(): void {
    if (!active || !mainVisible.value || !isAtBottom.value || !shouldAutoScroll() || followFrame)
      return
    followFrame = requestAnimationFrame(() => {
      followFrame = 0
      if (
        active &&
        mainVisible.value &&
        isAtBottom.value &&
        shouldAutoScroll() &&
        !selectionInside()
      )
        scrollToBottom(false)
    })
  }
  function observeContent(element: Element | null): void {
    if (!element) return
    contentElements.add(element)
    if (active && mainVisible.value) resizeObserver?.observe(element)
  }
  function unobserveContent(element: Element | null): void {
    if (!element) return
    resizeObserver?.unobserve(element)
    contentElements.delete(element)
  }
  function syncObserver(): void {
    resizeObserver?.disconnect()
    if (active && mainVisible.value) {
      for (const element of contentElements) resizeObserver?.observe(element)
      scheduleFollow()
    }
  }
  watch(mainVisible, syncObserver)
  onActivated(() => {
    active = true
    syncObserver()
  })
  onDeactivated(() => {
    active = false
    resizeObserver?.disconnect()
  })
  onUnmounted(() => {
    resizeObserver?.disconnect()
    contentElements.clear()
    if (scrollFrame) cancelAnimationFrame(scrollFrame)
    if (followFrame) cancelAnimationFrame(followFrame)
  })

  /** 检测是否在底部 */
  function checkBottom() {
    const el = containerRef.value
    if (!el) return

    const { scrollTop, scrollHeight, clientHeight } = el
    const bottom = scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD
    isAtBottom.value = bottom
    showScrollDown.value = !bottom
  }

  /** 每帧最多一次测量；用户上翻时立即解除吸底，避免下一次流式更新抢滚动。 */
  const onScroll = () => {
    if (scrollFrame) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0
      checkBottom()
    })
  }
  function releaseFollow(event: Event): void {
    if (
      (event instanceof WheelEvent && event.deltaY < 0) ||
      event.type === 'touchmove' ||
      (event instanceof KeyboardEvent && ['PageUp', 'Home', 'ArrowUp'].includes(event.key))
    ) {
      isAtBottom.value = false
      showScrollDown.value = true
    }
  }

  /** 滚动到底部 */
  function scrollToBottom(smooth = true) {
    const el = containerRef.value
    if (!el) return

    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    })
    isAtBottom.value = true
    showScrollDown.value = false
  }

  // 绑定滚动事件
  useEventListener(containerRef, 'scroll', onScroll, { passive: true })
  useEventListener(containerRef, 'wheel', releaseFollow, { passive: true })
  useEventListener(containerRef, 'touchmove', releaseFollow, { passive: true })
  useEventListener(containerRef, 'keydown', releaseFollow)

  // 消息数变化 → 如果在底部则自动吸底
  if (messageCount) {
    watch(messageCount, async () => {
      if (active && mainVisible.value && isAtBottom.value && shouldAutoScroll()) {
        await nextTick()
        scheduleFollow()
      }
    })
  }

  return {
    isAtBottom,
    showScrollDown,
    scrollToBottom,
    checkBottom,
    observeContent,
    unobserveContent,
  }
}
