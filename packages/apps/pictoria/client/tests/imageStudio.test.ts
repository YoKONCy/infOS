import { afterEach, describe, expect, it, vi } from 'vitest'
import { cropImage, resizeImage, splitImage } from '../src/services/imageStudio'
const draws: unknown[][] = []
const contexts: Array<{
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  drawImage: (...args: unknown[]) => void
}> = []
function browser() {
  draws.splice(0)
  contexts.splice(0)
  vi.stubGlobal('document', {
    createElement: () => {
      const context = {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        drawImage: (...args: unknown[]) => {
          draws.push(args.slice(1))
        },
      }
      contexts.push(context)
      return {
        width: 0,
        height: 0,
        getContext: () => context,
        toBlob: (done: (blob: Blob) => void) => done(new Blob(['png'], { type: 'image/png' })),
      }
    },
  })
}
afterEach(() => vi.unstubAllGlobals())
describe('原图像素编辑', () => {
  it('奇数宽度网格切图不遗漏边缘像素', async () => {
    browser()
    const source = { naturalWidth: 7, naturalHeight: 5 } as HTMLImageElement
    expect((await splitImage(source, 3, 1)).length).toBe(3)
    expect(draws).toEqual([
      [0, 0, 2, 5, 0, 0, 2, 5],
      [2, 0, 2, 5, 0, 0, 2, 5],
      [4, 0, 3, 5, 0, 0, 3, 5],
    ])
  })
  it('拒绝越界裁剪及超过切片上限的操作', async () => {
    browser()
    const source = { naturalWidth: 100, naturalHeight: 80 } as HTMLImageElement
    await expect(cropImage(source, { x: 90, y: 0, width: 20, height: 20 })).rejects.toThrow(
      'IMAGE_CROP_INVALID',
    )
    await expect(splitImage(source, 7, 3)).rejects.toThrow('IMAGE_SPLIT_INVALID')
    expect(draws).toEqual([])
  })
  it('最近邻缩放明确禁用平滑，并使用用户指定的输出尺寸', async () => {
    browser()
    const source = { naturalWidth: 10, naturalHeight: 10 } as HTMLImageElement
    await resizeImage(source, 40, 30, true)
    expect(contexts[0]?.imageSmoothingEnabled).toBe(false)
    expect(draws).toEqual([[0, 0, 40, 30]])
  })
})
