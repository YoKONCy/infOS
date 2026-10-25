import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

let dependencyRequire = createRequire(import.meta.url)
for (const name of [
  '@nut-tree-fork/nut-js',
  '@nut-tree-fork/provider-interfaces',
  '@nut-tree-fork/shared',
  'jimp',
  '@jimp/custom',
  '@jimp/core',
]) {
  dependencyRequire = createRequire(dependencyRequire.resolve(name))
}
const fileType = dependencyRequire('file-type')

describe('旧版图片依赖的 ASF 长度边界补丁', () => {
  it.each([0, 1, 23, 999999])('拒绝不合法的子头长度 %s', async (size) => {
    const input = Buffer.alloc(80)
    Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]).copy(input)
    input.writeBigUInt64LE(BigInt(size), 46)
    await expect(fileType.fromBuffer(input)).resolves.toBeUndefined()
  })
  it('合法 PNG 仍能被现有 CommonJS 图片依赖识别', async () => {
    const input = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1kAAAAASUVORK5CYII=',
      'base64',
    )
    await expect(fileType.fromBuffer(input)).resolves.toMatchObject({
      ext: 'png',
      mime: 'image/png',
    })
  })
})
