import { onMounted, onUnmounted, ref } from 'vue'

/** 用户是否开启了「减少动态效果」，随系统设置实时变化 */
export function useReducedMotion() {
  const reduced = ref(false)
  let mq: MediaQueryList | null = null
  const sync = () => (reduced.value = !!mq?.matches)
  onMounted(() => {
    mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    sync()
    mq.addEventListener('change', sync)
  })
  onUnmounted(() => mq?.removeEventListener('change', sync))
  return reduced
}

/**
 * 元素进入视口时加上 data-shown，用于入场动画；只触发一次。
 * 用属性而不是 class：Vue 更新动态 class 时会覆盖手动加的 class。
 */
export function useReveal(root: () => HTMLElement | null) {
  let io: IntersectionObserver | null = null
  onMounted(() => {
    const el = root()
    if (!el) return
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          e.target.setAttribute('data-shown', '')
          io?.unobserve(e.target)
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
    )
    el.querySelectorAll('[data-reveal]').forEach((n) => io!.observe(n))
  })
  onUnmounted(() => io?.disconnect())
}

/** 打字机：逐字显示文本，返回当前显示的文字与是否打完 */
export function useTypewriter(speed = 34) {
  const shown = ref('')
  const typing = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let full = ''

  function type(text: string, instant = false) {
    clearTimeout(timer)
    full = text
    if (instant) {
      shown.value = text
      typing.value = false
      return
    }
    shown.value = ''
    const chars = Array.from(text)
    if (!chars.length) return
    typing.value = true
    let i = 0
    const step = () => {
      shown.value += chars[i++] ?? ''
      if (i < chars.length) {
        // 标点后稍作停顿，读起来更像在说话
        const ch = chars[i - 1] ?? ''
        timer = setTimeout(step, '，。！？~…'.includes(ch) ? speed * 5 : speed)
      } else typing.value = false
    }
    step()
  }

  function finish() {
    clearTimeout(timer)
    shown.value = full
    typing.value = false
  }

  onUnmounted(() => clearTimeout(timer))
  return { shown, typing, type, finish }
}
