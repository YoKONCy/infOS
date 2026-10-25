// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { inspectAudio } from '@infos/shared'
import { pcm16Wave } from '../../src/lib/recordingAudio'
import AudioRecordingHud from '../../src/components/chat/AudioRecordingHud.vue'

describe('原音录制与 HUD', () => {
  it('输出真实 PCM16 WAV，样本截幅且时长可由服务端读取', () => {
    const samples = new Float32Array(24000)
    samples[0] = -2
    samples[1] = 2
    const bytes = pcm16Wave(samples, 24000)
    expect(inspectAudio(new Uint8Array(bytes), 'audio/wav')).toEqual({
      mimeType: 'audio/wav',
      sampleRate: 24000,
      channels: 1,
      durationMs: 1000,
    })
    const view = new DataView(bytes)
    expect(view.getInt16(44, true)).toBe(-32768)
    expect(view.getInt16(46, true)).toBe(32767)
  })
  it('录音时可停止和取消，处理时不显示停止按钮，错误可关闭', async () => {
    const wrapper = mount(AudioRecordingHud, {
      props: { state: 'recording', mode: 'native', seconds: 65, level: 0.1 },
    })
    expect(wrapper.text()).toContain('01:05')
    expect(wrapper.text()).toContain('Gemini')
    await wrapper.get('.audio-hud__stop').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
    await wrapper.setProps({ state: 'processing' })
    expect(wrapper.find('.audio-hud__stop').exists()).toBe(false)
    await wrapper.setProps({ state: 'error', error: '麦克风已断开' })
    expect(wrapper.text()).toContain('麦克风已断开')
    await wrapper.get('[aria-label="关闭"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })
})
