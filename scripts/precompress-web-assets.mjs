import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const compressible = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.ttf',
  '.otf',
  '.wasm',
  '.bcmap',
  '.pfb',
  '.icc',
])

/** 镜像构建时预压缩公开静态文件；运行时由 Nginx 按 Accept-Encoding 选择。 */
export async function precompressWebAssets(directory) {
  const root = path.resolve(directory)
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await precompressWebAssets(target)
    } else if (entry.isFile() && compressible.has(path.extname(entry.name).toLowerCase())) {
      const source = await fs.readFile(target)
      const compressed = source.length >= 1024 ? gzipSync(source, { level: 9 }) : null
      if (compressed && compressed.length < source.length * 0.95) {
        await fs.writeFile(`${target}.gz`, compressed)
      } else {
        // 同目录重复处理时不能遗留与现有原件不同的旧压缩版本。
        await fs.rm(`${target}.gz`, { force: true })
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('WEB_ASSET_DIRECTORY_REQUIRED')
  await precompressWebAssets(process.argv[2])
}
