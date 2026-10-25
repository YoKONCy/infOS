import { describe, expect, it } from 'vitest'
import { avatarCropRect, avatarCropStyle, clampAvatarCrop } from '../../src/lib/userAvatarCrop'
import { isLocalOwnerMessage } from '../../src/lib/userMessageIdentity'

describe('用户头像裁切', () => {
  it.each([
    [2400, 800],
    [800, 2400],
    [512, 512],
  ])('任意长宽比拖动到边缘后仍填满方框：%s × %s', (width, height) => {
    for (const zoom of [1, 1.1, 2, 3]) {
      for (const direction of [-1, 1]) {
        const crop = clampAvatarCrop({
          width,
          height,
          zoom,
          x: direction * 100,
          y: -direction * 100,
        })
        const rect = avatarCropRect(crop)
        expect(rect.x).toBeGreaterThanOrEqual(-0.00001)
        expect(rect.y).toBeGreaterThanOrEqual(-0.00001)
        expect(rect.x + rect.size).toBeLessThanOrEqual(width + 0.00001)
        expect(rect.y + rect.size).toBeLessThanOrEqual(height + 0.00001)
      }
    }
  })
  it('显示预览和上传裁切使用同一位置，而非保存时重新居中', () => {
    const crop = { width: 1600, height: 800, zoom: 2, x: 0.35, y: -0.2 }
    expect(avatarCropStyle(crop)).toEqual({
      width: '400%',
      height: '200%',
      left: '85%',
      top: '30%',
    })
    expect(avatarCropRect(crop)).toEqual({ x: 460, y: 280, size: 400 })
  })
  it('原图尺寸下的方形图不允许拖出空白，放大后可以拖动', () => {
    const value = { width: 512, height: 512, zoom: 1, x: 0.1, y: -0.1 }
    expect(Math.abs(clampAvatarCrop(value).x)).toBe(0)
    expect(Math.abs(clampAvatarCrop(value).y)).toBe(0)
    expect(clampAvatarCrop({ ...value, zoom: 2 })).toMatchObject({ x: 0.1, y: -0.1 })
  })
})

describe('用户头像身份边界', () => {
  it('桌面和工作区的用户消息，以及据点明确的 user 身份可以使用头像', () => {
    expect(isLocalOwnerMessage({ role: 'user', channel: 'desktop' })).toBe(true)
    expect(
      isLocalOwnerMessage({
        role: 'user',
        channel: 'group',
        platform: 'stronghold',
        senderId: 'user',
      }),
    ).toBe(true)
  })
  it.each(['qq', 'wechat', 'telegram', 'discord'])('不把 %s 联系人当成本地用户', (platform) => {
    expect(
      isLocalOwnerMessage({ role: 'user', channel: 'social', platform, senderId: 'user' }),
    ).toBe(false)
    expect(
      isLocalOwnerMessage({ role: 'user', channel: 'group', platform, senderId: 'user' }),
    ).toBe(false)
  })
  it('角色、未知频道和身份不明确的群聊消息保持原头像', () => {
    expect(isLocalOwnerMessage({ role: 'assistant', channel: 'desktop' })).toBe(false)
    expect(isLocalOwnerMessage({ role: 'user', channel: 'unknown' })).toBe(false)
    expect(
      isLocalOwnerMessage({
        role: 'user',
        channel: 'group',
        platform: 'stronghold',
        senderId: 'pero',
      }),
    ).toBe(false)
    expect(isLocalOwnerMessage({ role: 'user', channel: 'group', platform: 'stronghold' })).toBe(
      false,
    )
  })
})
