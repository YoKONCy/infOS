import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isObsoleteRetrievalStatePath } from '@infos/shared'

/** 升级与旧快照安装时清理退役状态文件，逐个移除受管目录中的普通文件。 */
export function removeObsoleteRetrievalState(dataDir: string): void {
  const root = path.resolve(dataDir)
  if (!existsSync(root)) return
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
      !/^(?:agent_.+|shared)$/.test(directory.name)) continue
    const target = path.resolve(root, directory.name)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || lstatSync(target).isSymbolicLink())
      throw new Error('OBSOLETE_RETRIEVAL_STATE_PATH_INVALID')
    for (const file of readdirSync(target, { withFileTypes: true })) {
      if (file.isFile() && isObsoleteRetrievalStatePath(`${directory.name}/${file.name}`))
        rmSync(path.join(target, file.name), { force: true })
    }
  }
}
