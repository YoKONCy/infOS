import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { packagePath } from './packageFiles'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}
export class PackageAssets {
  private roots = new Map<string, string>()
  async register(id: string, directory: string, packageRoot?: string): Promise<() => void> {
    if (this.roots.has(id)) throw new Error('PACKAGE_ASSET_CONFLICT')
    const canonical = await realpath(directory)
    const root = await realpath(packageRoot ?? directory)
    const relative = path.relative(root, canonical)
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !(await stat(canonical)).isDirectory()
    )
      throw new Error('PACKAGE_PATH_INVALID')
    this.roots.set(id, canonical)
    return () => {
      if (this.roots.get(id) === canonical) this.roots.delete(id)
    }
  }
  async read(id: string, relative: string): Promise<{ bytes: Uint8Array; type: string }> {
    const directory = this.roots.get(id)
    if (!directory) throw new Error('PACKAGE_ASSET_UNAVAILABLE')
    const root = await realpath(directory)
    if (root !== directory) throw new Error('PACKAGE_PATH_INVALID')
    const file = await realpath(packagePath(root, relative))
    const fromRoot = path.relative(root, file)
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
      throw new Error('PACKAGE_PATH_INVALID')
    const type = MIME[path.extname(file).toLowerCase()]
    const info = await stat(file)
    if (!type || !info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error('PACKAGE_ASSET_INVALID')
    return { bytes: new Uint8Array(await readFile(file)), type }
  }
}
