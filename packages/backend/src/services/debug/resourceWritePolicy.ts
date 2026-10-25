import path from 'node:path'
import { realpath } from 'node:fs/promises'

const kinds = ['skills', 'custom', 'agents', 'packages', 'resource-versions'] as const
const within = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
async function physical(input: string): Promise<string> {
  let parent = path.resolve(input)
  const missing: string[] = []
  for (;;) {
    try {
      return path.join(await realpath(parent), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      missing.push(path.basename(parent))
      parent = next
    }
  }
}

/** 普通 Agent 写工具也遵循候选流程；此策略不是任意 Node 或终端代码的沙箱。 */
export async function protectedResourceWrite(
  dataRoot: string,
  file: string,
): Promise<string | undefined> {
  const target = await physical(file)
  for (const kind of kinds) {
    const root = await physical(path.join(dataRoot, kind))
    if (!within(root, target)) continue
    if (kind === 'resource-versions') {
      const relative = path.relative(root, target).replaceAll('\\', '/')
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/candidate\//i.test(relative))
        return undefined
    }
    return kind
  }
  return undefined
}
