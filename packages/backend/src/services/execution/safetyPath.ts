import { realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { safetyResourceZone } from '@infos/shared'
import { t } from '../../lib/i18n'
import { isProtectedCredentialFile } from './protectedFiles'

/**
 * 同时保留用户路径与真实目标。新文件不存在时解析最近存在的父目录，
 * 防止写入 Junction 或符号链接下面的新文件漏过敏感目录规则。
 */
export async function resolveSafetyFilePaths(
  target: string,
  resolveRealPath: (file: string) => Promise<string> = realpath,
): Promise<{ paths: string[]; unresolved: boolean }> {
  const original = path.resolve(target)
  let current = original
  const missing: string[] = []
  while (current) {
    try {
      const resolved = path.join(await resolveRealPath(current), ...missing)
      return { paths: [...new Set([original, resolved])], unresolved: false }
    } catch (error) {
      // 权限不足、链接循环等失败不能被当作普通路径放行。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return { paths: [original], unresolved: true }
      // 悬空链接不能当作普通的“尚不存在的目录”；保留不确定状态要求审批。
      try {
        await lstat(current)
        return { paths: [original], unresolved: true }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT')
          return { paths: [original], unresolved: true }
      }
      const parent = path.dirname(current)
      if (parent === current) return { paths: [original], unresolved: true }
      missing.unshift(path.basename(current))
      current = parent
    }
  }
  return { paths: [original], unresolved: true }
}

/** 按参数定义递归提取路径；兼容现有契约名称，也支持自定义字段声明 format: path。 */
export function toolPathArguments(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): Array<{ key: string; value: string; segments: string[] }> {
  const result: Array<{ key: string; value: string; segments: string[] }> = []
  const pathName =
    /^(?:path|paths|cwd|directory|directories|destination|source|file|folder)$|(?:^|_)(?:path|paths|directory|dir|folder)$|(?:Path|Paths|Directory|Dir|Folder)$/
  const visit = (
    value: unknown,
    definition: Record<string, unknown> | undefined,
    key: string,
    location: string,
    inherited = false,
    segments: string[] = [],
  ): void => {
    const isPath =
      inherited ||
      pathName.test(key) ||
      definition?.format === 'path' ||
      definition?.format === 'file-path' ||
      definition?.['x-resource'] === 'file'
    if (typeof value === 'string' && value && isPath)
      result.push({ key: location, value, segments })
    else if (Array.isArray(value))
      value.forEach((item, i) =>
        visit(item, definition?.items as Record<string, unknown>, key, `${location}.${i}`, isPath, [
          ...segments,
          String(i),
        ]),
      )
    else if (value && typeof value === 'object') {
      const properties = definition?.properties as
        | Record<string, Record<string, unknown>>
        | undefined
      for (const [child, item] of Object.entries(value))
        visit(item, properties?.[child], child, location ? `${location}.${child}` : child, false, [
          ...segments,
          child,
        ])
    }
  }
  visit(args, schema, '', '')
  return result
}

/** 在实际读取与递归遍历边界再次检查；普通父目录不代表其子目录也可访问。 */
export async function assertSafetyFileAccess(target: string): Promise<void> {
  const resolved = await resolveSafetyFilePaths(target)
  const context = { platform: process.platform, env: process.env, home: os.homedir() }
  // infOS 自己的凭据与访问控制文件（client-access.json 等）同样属于禁区，读写删都不行。
  if (
    resolved.paths.some(
      (file) =>
        isProtectedCredentialFile(file) ||
        safetyResourceZone('file', file, 'read', context) === 'forbidden',
    )
  )
    throw new Error(`DESKTOP_FORBIDDEN: ${t('server.agent', '凭据库属于禁区，工具未执行')}`)
  if (resolved.unresolved) throw new Error('SAFETY_PATH_UNRESOLVED')
}
export async function safetyFileAccessible(target: string): Promise<boolean> {
  try {
    await assertSafetyFileAccess(target)
    return true
  } catch {
    return false
  }
}
