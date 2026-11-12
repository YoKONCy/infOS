/**
 * useMessageVisibility — IntersectionObserver 不可见消息暂停
 *
 * 替代虚拟滚动的轻量方案：
 * - 不可见消息的动画、视频、Canvas 全部暂停
 * - 通知文本组件暂停解析，不固化或伪造消息高度
 * - 恢复时自动 resume
 *
 */

import {
  inject,
  ref,
  shallowRef,
  watch,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
} from 'vue'
import type { Ref } from 'vue'

/**
 * 自动暂停不可见消息的动画和媒体资源
 *
 * @param chatContainer - 聊天容器 Ref (作为 IntersectionObserver 的 root)
 */
export function useMessageVisibility(
  chatContainer: Ref<HTMLElement | null>,
  onVisibilityChange?: (element: HTMLElement, visible: boolean) => void,
  onBatchVisibilityChange?: (changes: Array<readonly [HTMLElement, boolean]>) => void,
) {
  const observer = ref<IntersectionObserver | null>(null)
  const visibility = new WeakMap<HTMLElement, boolean>()
  const elements = new Set<HTMLElement>()
  const mainVisible = inject('infos:main-surface-visible', shallowRef(true))
  let activated = true
  let observerGeneration = 0

  function setVisible(
    el: HTMLElement,
    visible: boolean,
    batch?: Array<readonly [HTMLElement, boolean]>,
  ): void {
    if (visibility.get(el) === visible) return
    visibility.set(el, visible)
    if (visible) {
      resumeMessage(el)
    } else {
      pauseMessage(el)
    }
    onVisibilityChange?.(el, visible)
    batch?.push([el, visible] as const)
  }

  function createObserver() {
    if (
      observer.value ||
      !chatContainer.value ||
      !activated ||
      !mainVisible.value ||
      document.hidden
    )
      return

    chatContainer.value.classList.remove('chat-surface-paused')
    const generation = ++observerGeneration
    observer.value = new IntersectionObserver(
      (entries) => {
        if (
          generation !== observerGeneration ||
          !activated ||
          !mainVisible.value ||
          document.hidden
        )
          return
        const batch: Array<readonly [HTMLElement, boolean]> = []
        for (const entry of entries) {
          const el = entry.target as HTMLElement
          if (elements.has(el)) setVisible(el, entry.isIntersecting, batch)
        }
        if (batch.length) onBatchVisibilityChange?.(batch)
      },
      {
        root: chatContainer.value,
        // 提前 200px 开始预加载
        rootMargin: '200px 0px',
        threshold: 0,
      },
    )
    for (const element of elements) observer.value.observe(element)
  }

  function destroyObserver() {
    observerGeneration++
    observer.value?.disconnect()
    observer.value = null
    chatContainer.value?.classList.add('chat-surface-paused')
    const batch: Array<readonly [HTMLElement, boolean]> = []
    for (const element of elements) setVisible(element, false, batch)
    if (batch.length) onBatchVisibilityChange?.(batch)
  }

  // ── 暂停策略 ──

  function pauseMediaList(list: HTMLCollectionOf<HTMLMediaElement>) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (!m.paused) {
        m.dataset.wasPlaying = 'true'
        m.pause()
      }
    }
  }

  function resumeMediaList(list: HTMLCollectionOf<HTMLMediaElement>) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!
      if (m.dataset.wasPlaying === 'true') {
        void m.play().catch(() => {})
        delete m.dataset.wasPlaying
      }
    }
  }

  function pauseMessage(el: HTMLElement) {
    el.classList.add('msg-paused')
    // 仅在存在音视频元素时暂停，避免对 60 条消息逐棵子树执行同步 getAnimations 强制样式重算
    pauseMediaList(el.getElementsByTagName('video'))
    pauseMediaList(el.getElementsByTagName('audio'))
  }

  function resumeMessage(el: HTMLElement) {
    el.classList.remove('msg-paused')
    el.style.removeProperty('contain-intrinsic-size')
    resumeMediaList(el.getElementsByTagName('video'))
    resumeMediaList(el.getElementsByTagName('audio'))
  }

  // ── 公开 API ──

  /** 开始观察一个消息元素 */
  function observe(messageEl: Element | null | undefined) {
    if (!(messageEl instanceof HTMLElement)) return
    elements.add(messageEl)
    if (!observer.value) createObserver()
    observer.value?.observe(messageEl)
    if (!observer.value) {
      const batch: Array<readonly [HTMLElement, boolean]> = []
      setVisible(messageEl, false, batch)
      if (batch.length) onBatchVisibilityChange?.(batch)
    }
  }

  /** 停止观察 */
  function unobserve(messageEl: Element | null | undefined) {
    if (!(messageEl instanceof HTMLElement)) return
    observer.value?.unobserve(messageEl)
    elements.delete(messageEl)
    visibility.delete(messageEl)
  }

  // ── 生命周期 ──
  onMounted(createObserver)
  const syncVisibility = () => {
    if (activated && mainVisible.value && !document.hidden) createObserver()
    else destroyObserver()
  }
  watch(mainVisible, syncVisibility)
  onActivated(() => {
    activated = true
    syncVisibility()
  })
  onDeactivated(() => {
    activated = false
    destroyObserver()
  })
  onMounted(() => document.addEventListener('visibilitychange', syncVisibility))
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', syncVisibility)
    observer.value?.disconnect()
    elements.clear()
  })

  return { observe, unobserve }
}
