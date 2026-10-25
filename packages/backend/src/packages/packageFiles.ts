import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { writeAtomicJson } from '../lib/atomicJson'

export function packagePath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.startsWith('/'))
    throw new Error('PACKAGE_PATH_INVALID')
  if (
    relative.split('/').some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        // eslint-disable-next-line no-control-regex -- 显式拦截控制字符，防止标识或路径混入不可见内容。
        /[. ]$|[<>"|?*\x00-\x1f]/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error('PACKAGE_PATH_INVALID')
  const result = path.resolve(root, relative)
  const fromRoot = path.relative(path.resolve(root), result)
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot))
    throw new Error('PACKAGE_PATH_INVALID')
  return result
}

/** 授权绑定源码及锁文件；依赖目录只由独立的安装器管理。 */
export async function packageDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (name === 'node_modules') continue
      if (
        ['.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', 'pnpm-workspace.yaml', '.git'].includes(
          name.toLowerCase(),
        )
      )
        throw new Error('PACKAGE_FILE_FORBIDDEN')
      const file = path.join(dir, name)
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK_FORBIDDEN')
      if (stat.isDirectory()) await visit(file)
      else if (stat.isFile()) {
        hash.update(path.relative(root, file).replaceAll('\\', '/')).update('\0')
        hash.update(await readFile(file)).update('\0')
      } else throw new Error('PACKAGE_FILE_INVALID')
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export async function atomicPackageJson(file: string, data: unknown): Promise<void> {
  await writeAtomicJson(file, data)
}
