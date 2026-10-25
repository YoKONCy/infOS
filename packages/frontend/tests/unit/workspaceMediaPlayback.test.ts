// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import Viewer from '../../src/components/workspace/WorkspaceMediaViewer.vue'
import ResourceAudio from '../../src/components/resources/ResourceAudioPlayer.vue'
import { createPreviewState } from '../../src/components/workspace/workspacePreview'
import { useMediaPlayer } from '../../src/composables/resources/useMediaPlayer'

class AudioFixture extends EventTarget {
  src = ''
  preload = ''
  paused = true
  ended = false
  currentTime = 0
  duration = 180
  readyState = 1
  volume = 1
  muted = false
  playbackRate = 1
  loop = false
  error = null
  buffered = { length: 0 }
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
  })
  load = vi.fn()
  removeAttribute = vi.fn()
}
const wrappers: VueWrapper[] = []
let audios: AudioFixture[] = []
function audioRuntime() {
  audios = []
  vi.stubGlobal(
    'Audio',
    class extends AudioFixture {
      constructor() {
        super()
        audios.push(this)
      }
    },
  )
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('音乐后台播放与视频离屏暂停', () => {
  it('工作区音频切屏后继续播放，回到页面不重新创建播放源，关闭才清理', async () => {
    audioRuntime()
    const wrapper = mount(Viewer, {
      props: {
        src: '/song.mp3',
        name: '音乐',
        kind: 'audio',
        active: true,
        state: createPreviewState(),
      },
    })
    wrappers.push(wrapper)
    const audio = audios[0]!
    audio.dispatchEvent(new Event('loadedmetadata'))
    await nextTick()
    await wrapper.get('.workspace-media__play').trigger('click')
    await wrapper.setProps({ active: false })
    expect(audio.pause).not.toHaveBeenCalled()
    audio.currentTime = 42
    audio.dispatchEvent(new Event('timeupdate'))
    expect(wrapper.emitted('state')!.at(-1)![0]).toEqual({ position: 42 })
    await wrapper.setProps({ active: true })
    expect(audios).toHaveLength(1)
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(wrapper.find('audio').exists()).toBe(false)
    wrappers.pop()
    wrapper.unmount()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.removeAttribute).toHaveBeenCalledWith('src')
  })

  it('KeepAlive 移走工作区 DOM 不会暂停独立的音频源', async () => {
    audioRuntime()
    const shown = ref(true)
    const host = defineComponent({
      setup: () => () =>
        h(
          KeepAlive,
          {},
          {
            default: () =>
              shown.value
                ? h(Viewer, {
                    src: '/song.mp3',
                    name: '音乐',
                    kind: 'audio',
                    active: true,
                    state: createPreviewState(),
                  })
                : h('div'),
          },
        ),
    })
    wrappers.push(mount(host))
    await audios[0]!.play()
    shown.value = false
    await nextTick()
    expect(audios[0]!.pause).not.toHaveBeenCalled()
    shown.value = true
    await nextTick()
    expect(audios).toHaveLength(1)
  })

  it('显式更换音频资源会停止旧内容并准备新地址', async () => {
    audioRuntime()
    const wrapper = mount(Viewer, {
      props: {
        src: '/old.mp3',
        name: '音乐',
        kind: 'audio',
        active: true,
        state: createPreviewState(),
      },
    })
    wrappers.push(wrapper)
    await audios[0]!.play()
    await wrapper.setProps({ src: '/new.mp3' })
    expect(audios[0]!.pause).toHaveBeenCalledOnce()
    expect(audios[0]!.src).toBe('/new.mp3')
    expect(audios[0]!.play).toHaveBeenCalledOnce()
  })

  it('视频切屏会暂停，返回页面不会擅自恢复播放', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const wrapper = mount(Viewer, {
      props: {
        src: '/movie.mp4',
        name: '视频',
        kind: 'video',
        active: true,
        state: createPreviewState(),
      },
    })
    wrappers.push(wrapper)
    const video = wrapper.get('video').element as HTMLVideoElement
    video.pause = vi.fn()
    video.play = vi.fn(async () => {})
    await wrapper.setProps({ active: false })
    expect(video.pause).toHaveBeenCalledOnce()
    await wrapper.setProps({ active: true })
    expect(video.play).not.toHaveBeenCalled()
    await wrapper.setProps({ active: false })
    await wrapper.get('video').trigger('play')
    expect(video.pause).toHaveBeenCalledTimes(3)
  })

  it('聊天音频离屏与系统切屏都保留播放，显式关闭播放器才停止', async () => {
    audioRuntime()
    const wrapper = mount(ResourceAudio, {
      props: { src: '/song.mp3', name: '音乐.mp3', active: true },
    })
    wrappers.push(wrapper)
    const audio = audios[0]!
    await wrapper.get('.media-button--play').trigger('click')
    await flushPromises()
    await wrapper.setProps({ active: false })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(audio.pause).not.toHaveBeenCalled()
    expect(audio.paused).toBe(false)
    hidden.mockRestore()
    wrappers.pop()
    wrapper.unmount()
    expect(audio.pause).toHaveBeenCalledOnce()
  })

  it('共享控制器的视频策略仍在窗口隐藏时暂停', async () => {
    const element = new AudioFixture()
    let controller!: ReturnType<typeof useMediaPlayer>
    const host = defineComponent({
      setup() {
        controller = useMediaPlayer(
          ref(element as unknown as HTMLMediaElement),
          () => '/video.mp4',
          () => true,
        )
        return () => h('div')
      },
    })
    wrappers.push(mount(host))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(element.pause).toHaveBeenCalledOnce()
    expect(controller.state.playing).toBe(false)
  })
})
