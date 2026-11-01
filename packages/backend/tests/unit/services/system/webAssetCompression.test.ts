import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const temporary = path.resolve('TEMP')
let root: string | undefined
afterEach(async () => {
  if (!root) return
  if (path.dirname(root) !== temporary) throw new Error('测试目录越界')
  await fs.rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Web 静态资源预压缩', () => {
  it('模块、字体与解码器生成可还原的 gzip，重复处理不会留下旧内容', async () => {
    root = await fs.mkdtemp(path.join(temporary, 'web-compression-'))
    const script = pathToFileURL(path.resolve('scripts/precompress-web-assets.mjs')).href
    const { precompressWebAssets } = await import(script)
    // 使用已知字节验证解压后的传输内容，不借被测压缩器生成预期值。
    for (const name of ['worker.mjs', 'font.ttf', 'decoder.wasm']) {
      await fs.writeFile(path.join(root, name), '公开测试内容'.repeat(1000))
    }
    await precompressWebAssets(root)
    for (const name of ['worker.mjs', 'font.ttf', 'decoder.wasm']) {
      const compressed = await fs.readFile(path.join(root, `${name}.gz`))
      expect(gunzipSync(compressed).toString()).toBe('公开测试内容'.repeat(1000))
      expect(await fs.readFile(path.join(root, name), 'utf8')).toBe('公开测试内容'.repeat(1000))
    }
    await fs.writeFile(path.join(root, 'font.ttf'), '更新后的小文件')
    await precompressWebAssets(root)
    await expect(fs.readFile(path.join(root, 'font.ttf.gz'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.readFile(path.join(root, 'font.ttf'), 'utf8')).toBe('更新后的小文件')
  })
})
