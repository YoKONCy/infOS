import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PackageActivationContext } from './types'
import { packagePath } from './packageFiles'
import { packageTimeout } from './packageTimeout'

/** 只由已完成源码授权校验的 PackageRuntime 调用。 */
export async function loadPackageModule<T>(context: PackageActivationContext): Promise<T> {
  if (!context.rootDir || !context.contribution.entry) throw new Error('PACKAGE_ENTRY_REQUIRED')
  const root = await realpath(context.rootDir)
  const file = await realpath(packagePath(root, context.contribution.entry))
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('PACKAGE_ENTRY_OUTSIDE_ROOT')
  const module = await packageTimeout(import(pathToFileURL(file).href), 10_000)
  context.host?.signal.throwIfAborted()
  return typeof module.createContribution === 'function'
    ? ((await packageTimeout(
        Promise.resolve(module.createContribution(context.host)),
        10_000,
      )) as T)
    : (module as T)
}
