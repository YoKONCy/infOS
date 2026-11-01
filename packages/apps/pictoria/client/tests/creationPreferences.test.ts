import { describe, expect, it } from 'vitest'
import { normalizeCreationPreferences } from '../src/services/creationPreferences'

describe('Pictoria 草稿创作参数', () => {
  it.each([undefined, null, {}, [], { inputsByStep: null }])(
    '不完整草稿仍可打开画布：%j',
    (value) => {
      expect(normalizeCreationPreferences(value)).toEqual({
        stepId: '',
        text: '',
        inputsByStep: {},
        referenceUsesByStep: {},
      })
    },
  )

  it('保留有效模型配置并丢弃损坏的参数分组', () => {
    expect(
      normalizeCreationPreferences({
        stepId: 'image',
        text: '海边',
        inputsByStep: { image: { aspectRatio: '16:9', resolution: '2k' }, invalid: null },
      }),
    ).toEqual({
      stepId: 'image',
      text: '海边',
      inputsByStep: { image: { aspectRatio: '16:9', resolution: '2k' } },
      referenceUsesByStep: {},
    })
  })

  it('恢复按步骤保存的参考图用途，丢弃损坏分组和不支持的用途', () => {
    const restored = normalizeCreationPreferences({
      referenceUsesByStep: {
        image: [
          { field: 'images', assetId: 'subject-image', purpose: 'subject' },
          { field: 'images', assetId: 'style-image', purpose: 'style' },
          { field: 'images', assetId: 'invalid-image', purpose: 'unknown' },
          { assetId: 'missing-field', purpose: 'scene' },
          null,
        ],
        invalid: null,
      },
    })
    expect(restored.referenceUsesByStep).toEqual({
      image: [
        { field: 'images', assetId: 'subject-image', purpose: 'subject' },
        { field: 'images', assetId: 'style-image', purpose: 'style' },
      ],
    })
  })
})
