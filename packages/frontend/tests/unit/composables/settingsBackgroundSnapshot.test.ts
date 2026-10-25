// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { useAppBackground } from '@infos/frontend/composables/ui/useAppBackground'

const api = vi.hoisted(() => ({ batch: vi.fn(), set: vi.fn() }))
vi.mock('@infos/frontend/api/modules/configApi', () => ({ configApi: api }))
vi.mock('@infos/frontend/api/modules/systemApi', () => ({
  systemApi: { appBackgroundContentUrl: () => '/managed-background' },
}))

describe('整页保存的背景快照', () => {
  it('排队保存固定当时的预设和参数，不读取后来的草稿', async () => {
    api.batch.mockResolvedValue({
      data: {
        'ui.chatBackground.activePreset': 'preset-1',
        'ui.chatBackground.mime': 'image/png',
        'ui.chatBackground.settings': '{"enabled":true,"opacity":0.95}',
      },
    })
    api.set.mockResolvedValue({})
    const background = useAppBackground()
    await background.load()
    background.settings.value.opacity = 0.7
    const first = background.captureSave()
    background.settings.value.opacity = 0.9
    const second = background.captureSave()
    await Promise.all([first(), second()])
    const values = api.set.mock.calls
      .filter((call) => call[0] === 'ui.chatBackground.settings')
      .map((call) => JSON.parse(call[1]).opacity)
    expect(values).toEqual([0.7, 0.9])
    expect(background.settings.value.opacity).toBe(0.9)
  })
})
