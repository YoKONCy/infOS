import { describe, expect, it } from 'vitest'
import { parsePackageWebUiMessage } from '@infos/frontend/lib/packageWebUiBridge'

describe('插件页面交互协议', () => {
  const packet = {
    protocol: 'infos.package-ui.v1',
    channel: 'current-page',
    type: 'call',
    id: '1',
    action: 'settings.save',
    input: { enabled: true },
  }
  it('保留动作输入，错误页面及非法动作不能转发', () => {
    expect(parsePackageWebUiMessage(packet, 'current-page')).toEqual({
      type: 'call',
      id: '1',
      action: 'settings.save',
      input: { enabled: true },
    })
    expect(parsePackageWebUiMessage(packet, 'other-page')).toBeUndefined()
    expect(
      parsePackageWebUiMessage({ ...packet, action: '../other' }, 'current-page'),
    ).toBeUndefined()
    expect(
      parsePackageWebUiMessage({ ...packet, input: 'x'.repeat(256 * 1024) }, 'current-page'),
    ).toBeUndefined()
  })
})
