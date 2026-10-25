import { onBeforeUnmount, onDeactivated, reactive, watch, type Ref } from 'vue'
import { rememberMediaPosition, restoreMediaPosition } from '../../lib/resourcePlayback'

// 同一页面只保留一个媒体播放源，避免行内卡片与预览窗口叠音。
let currentPlayback: HTMLMediaElement | null = null

export function mediaTime(seconds: number) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const minutes = Math.floor(value / 60)
  const tail = String(value % 60).padStart(2, '0')
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`
    : `${minutes}:${tail}`
}

export function useMediaPlayer(
  media: Ref<HTMLMediaElement | null>,
  source: () => string,
  active: () => boolean,
  options: { background?: boolean } = {},
) {
  const state = reactive({
    playing: false,
    waiting: false,
    position: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    muted: false,
    rate: 1,
    loop: false,
    error: '' as '' | 'format' | 'play',
  })
  let operation = 0

  function failure() {
    const code = media.value?.error?.code
    return code === 3 || code === 4 ? 'format' : 'play'
  }
  function pause() {
    ++operation
    media.value?.pause()
    if (currentPlayback === media.value) currentPlayback = null
    state.playing = false
    state.waiting = false
  }
  function track() {
    const element = media.value
    if (!element) return
    state.position = Number.isFinite(element.currentTime) ? element.currentTime : 0
    if (element.readyState >= 1) rememberMediaPosition(source(), element.ended ? 0 : state.position)
  }
  function buffer() {
    const element = media.value
    if (!element) return
    state.buffered = 0
    for (let index = 0; index < element.buffered.length; index++) {
      // 只显示当前位置所在的缓冲区，跳转后不把中间空缺标成已缓存。
      if (
        element.buffered.start(index) <= element.currentTime + 0.1 &&
        element.buffered.end(index) >= element.currentTime
      )
        state.buffered = element.buffered.end(index)
    }
  }
  function durationChanged() {
    const value = media.value?.duration ?? 0
    state.duration = Number.isFinite(value) ? Math.max(0, value) : 0
  }
  function metadata() {
    durationChanged()
    restoreMediaPosition(media.value, source())
    track()
    buffer()
  }
  async function toggle() {
    const element = media.value
    if (!element || !active()) return
    if (!element.paused) {
      pause()
      return
    }
    const version = ++operation
    state.error = ''
    state.waiting = true
    try {
      await element.play()
      if (version !== operation || element !== media.value || (!active() && !options.background))
        return
      state.waiting = false
    } catch (error) {
      if (version !== operation || element !== media.value || (!active() && !options.background))
        return
      state.waiting = false
      if (!(error instanceof DOMException && error.name === 'AbortError')) state.error = failure()
    }
  }
  function seek(value: number) {
    const element = media.value
    if (!element || !state.duration || !Number.isFinite(value)) return
    element.currentTime = Math.max(0, Math.min(value, state.duration))
    track()
    buffer()
  }
  function skip(seconds: number) {
    seek(state.position + seconds)
  }
  function toggleMute() {
    if (!state.volume) {
      state.volume = 1
      state.muted = false
    } else state.muted = !state.muted
  }
  function retry() {
    pause()
    state.error = ''
    media.value?.load()
    void toggle()
  }
  function keyboard(event: KeyboardEvent) {
    const target = event.target as HTMLElement
    if (target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key.toLowerCase()
    if (key === ' ' || key === 'k') void toggle()
    else if (key === 'arrowleft') skip(-5)
    else if (key === 'arrowright') skip(5)
    else if (key === 'm') toggleMute()
    else return
    event.preventDefault()
  }
  const events = {
    loadedmetadata: metadata,
    durationchange: durationChanged,
    timeupdate: track,
    progress: buffer,
    play: () => {
      if ((!active() || document.hidden) && !options.background) {
        pause()
        return
      }
      if (!media.value || media.value.paused) return
      if (currentPlayback && currentPlayback !== media.value) currentPlayback.pause()
      currentPlayback = media.value
      state.playing = true
      state.error = ''
    },
    playing: () => {
      state.waiting = false
    },
    pause: () => {
      if (currentPlayback === media.value) currentPlayback = null
      state.playing = false
      state.waiting = false
    },
    waiting: () => {
      state.waiting = !media.value?.paused
    },
    seeking: () => {
      state.waiting = !media.value?.paused
    },
    seeked: () => {
      state.waiting = false
      track()
      buffer()
    },
    canplay: () => {
      state.waiting = false
    },
    ended: () => {
      if (currentPlayback === media.value) currentPlayback = null
      state.playing = false
      state.waiting = false
      track()
    },
    error: () => {
      if (currentPlayback === media.value) currentPlayback = null
      state.error = failure()
      state.waiting = false
      state.playing = false
    },
    volumechange: () => {
      if (!media.value) return
      state.volume = media.value.volume
      state.muted = media.value.muted
    },
    ratechange: () => {
      state.rate = media.value?.playbackRate ?? 1
    },
  }
  watch([media, () => state.volume, () => state.muted, () => state.rate, () => state.loop], () => {
    const element = media.value
    if (!element) return
    element.volume = state.volume
    element.muted = state.muted
    element.playbackRate = state.rate
    element.loop = state.loop
  })
  watch(
    source,
    () => {
      pause()
      state.position = 0
      state.duration = 0
      state.buffered = 0
      state.error = ''
    },
    { flush: 'sync' },
  )
  watch(
    active,
    (value) => {
      if (!value && !options.background) pause()
    },
    { flush: 'sync' },
  )
  const visibility = () => {
    if (document.hidden && !options.background) pause()
  }
  document.addEventListener('visibilitychange', visibility)
  onDeactivated(() => {
    if (!options.background) pause()
  })
  onBeforeUnmount(() => {
    pause()
    document.removeEventListener('visibilitychange', visibility)
  })
  return { state, events, toggle, seek, skip, retry, toggleMute, keyboard }
}
