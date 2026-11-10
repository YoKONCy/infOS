/**
 * search_files — 文件搜索工具
 *
 * 按文件名搜索文件。
 * 使用 Node.js 遍历，每个目录和条目分别检查凭据禁区。
 *
 * 搜索目录默认为当前 ExecutionSession 的 Workspace；设备只读权限允许显式指定本机目录。
 * 搜索根由 VirtualWorkspace 校验，父目录授权不覆盖凭据子目录。
 *
 * @module packages/backend/src/tools/fileSearch
 */

import { safetyFileAccessible } from '../../services/execution/safetyPath'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BuiltinTool } from '../index'
import { getProductivityRuntime, resolveExecutionSession } from '../productivityRuntimeHolder'
import { toolSuccess } from '../../services/execution/toolResult'

const MAX_RESULTS = 50
const MAX_RESULT_LIMIT = 200

export const fileSearchTool: BuiltinTool = {
  name: 'search_files',

  async execute(args, ctx) {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('文件名关键词不能为空')
    const requestedLimit = args.limit === undefined ? MAX_RESULTS : Number(args.limit)
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1)
      throw new Error('文件搜索结果上限必须是正整数')
    const limit = Math.min(requestedLimit, MAX_RESULT_LIMIT)
    // 多取一项以确认是否截断，不把返回上限误报为全部命中数。
    const probeLimit = limit + 1

    // 纯只读搜索默认从Agent工作区开始；用户可显式指定任意本机现有目录。
    const session = await resolveExecutionSession(ctx)
    const searchDir = await getProductivityRuntime().virtualWorkspace.resolveDirectory(
      session,
      args.directory ? String(args.directory) : '.',
      { deviceScope: ctx.deviceReadScope },
    )

    // 逐目录、逐条目检查禁区；不把普通父目录整体交给不可插入护栏的递归搜索程序。
    return searchResult(await nodeFallbackSearch(query, searchDir, probeLimit), limit, 'node')
  },
}

/** 文件与目录分别统计，避免把同名文件夹计入文件数。 */
async function searchResult(paths: string[], limit: number, engine: string) {
  const entries = await Promise.all(
    [...new Set(paths)].map(async (filePath) => {
      try {
        const info = await stat(filePath)
        return info.isFile()
          ? { path: filePath, kind: 'file' }
          : info.isDirectory()
            ? { path: filePath, kind: 'directory' }
            : null
      } catch {
        // 搜索索引可能滞后，已不存在或无法读取的条目不计入结果。
        return null
      }
    }),
  )
  const available = entries.filter((entry) => entry !== null)
  const selected = available.slice(0, limit)
  const files = selected.filter((entry) => entry.kind === 'file').map((entry) => entry.path)
  const directories = selected
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.path)
  const summary = {
    count: files.length,
    directoryCount: directories.length,
    truncated: paths.length > limit,
    engine,
  }
  return toolSuccess(JSON.stringify({ ...summary, files, directories }), summary)
}

/** Node.js 回退搜索 (简易递归，有深度/数量限制) */
async function nodeFallbackSearch(
  query: string,
  rootDir: string,
  limit: number,
): Promise<string[]> {
  const results: string[] = []
  const lowerQuery = query.toLowerCase()
  const maxDepth = 5

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= limit) return
    try {
      if (!(await safetyFileAccessible(dir))) return
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (results.length >= limit) break
        if (entry.startsWith('.') || entry === 'node_modules') continue

        const fullPath = path.join(dir, entry)
        if (!(await safetyFileAccessible(fullPath))) continue
        if (entry.toLowerCase().includes(lowerQuery)) {
          results.push(fullPath)
        }

        try {
          if ((await stat(fullPath)).isDirectory()) {
            await walk(fullPath, depth + 1)
          }
        } catch {
          // 权限不足，跳过
        }
      }
    } catch {
      // 跳过
    }
  }

  await walk(rootDir, 0)
  return results
}
