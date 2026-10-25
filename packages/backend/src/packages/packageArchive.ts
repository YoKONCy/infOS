import { mkdir, writeFile } from 'node:fs/promises'
import { dirname as pathDirname } from 'node:path'
import { unzipSync } from 'fflate'
import type { PackageManifest } from '@infos/shared'
import { packagePath } from './packageFiles'
import { validatePackageManifest } from './packageManifest'

export const PACKAGE_UPLOAD_LIMIT = 20 * 1024 * 1024
const EXPANDED_LIMIT = 64 * 1024 * 1024

/** 上传包只解出普通文件，拒绝路径逃逸、依赖目录与包管理器配置注入。 */
export async function extractPackage(bytes: Uint8Array, root: string): Promise<PackageManifest> {
  if (!bytes.length || bytes.length > PACKAGE_UPLOAD_LIMIT) throw new Error('PACKAGE_SIZE_LIMIT')
  let expanded = 0
  let count = 0
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      if (
        !Number.isSafeInteger(entry.originalSize) ||
        entry.originalSize < 0 ||
        ++count > 2000 ||
        (expanded += entry.originalSize) > EXPANDED_LIMIT
      )
        throw new Error('PACKAGE_SIZE_LIMIT')
      packagePath(root, entry.name.replace(/\/$/, ''))
      return !entry.name.endsWith('/')
    },
  })
  const names = Object.keys(entries)
  const prefix = names.includes('manifest.json')
    ? ''
    : names.find((name) => /^[^/]+\/manifest\.json$/.test(name))?.split('/')[0] + '/'
  if (prefix === 'undefined/' || names.some((name) => !name.startsWith(prefix)))
    throw new Error('PACKAGE_MANIFEST_MISSING')
  let total = 0
  const normalized = new Set<string>()
  for (const [name, content] of Object.entries(entries)) {
    const relative = name.slice(prefix.length)
    const target = packagePath(root, relative)
    const key = relative.toLowerCase()
    if (
      normalized.has(key) ||
      relative
        .split('/')
        .some((part) =>
          [
            'node_modules',
            '.npmrc',
            '.pnpmfile.cjs',
            '.pnpmfile.mjs',
            'pnpm-workspace.yaml',
            '.git',
          ].includes(part.toLowerCase()),
        )
    )
      throw new Error('PACKAGE_FILE_FORBIDDEN')
    normalized.add(key)
    if ((total += content.length) > EXPANDED_LIMIT) throw new Error('PACKAGE_SIZE_LIMIT')
    await mkdir(pathDirname(target), { recursive: true })
    await writeFile(target, content, { flag: 'wx' })
  }
  const manifestFile = entries[`${prefix}manifest.json`]
  if (!manifestFile || manifestFile.length > 128 * 1024) throw new Error('PACKAGE_MANIFEST_MISSING')
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile)) as PackageManifest
  validatePackageManifest(manifest)
  for (const contribution of manifest.contributions) {
    if (contribution.entry) packagePath(root, contribution.entry)
  }
  return manifest
}
