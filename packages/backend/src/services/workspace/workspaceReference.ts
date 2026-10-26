import path from 'node:path'
import { opendir, realpath, stat } from 'node:fs/promises'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import type { ExecutionSession } from '../execution/executionSession'
import { type VirtualWorkspace, WorkspaceError, WS_ERROR } from '../execution/virtualWorkspace'

/** 文件入口共用结构化错误，不把缺失、权限或占用错误伪装成服务端故障。 */
export function fileAccessError(error: unknown): Error {
  if (error instanceof AppError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (
    (error instanceof WorkspaceError &&
      [WS_ERROR.PATH_OUT_OF_SCOPE, WS_ERROR.PATH_PROTECTED].some((value) => value === code)) ||
    code === 'EACCES' ||
    code === 'EPERM'
  )
    return new AppError('FORBIDDEN', {
      message: t('server.resources', '无权访问此文件'),
      cause: error,
    })
  if (['ENOENT', 'ENOTDIR', WS_ERROR.FILE_NOT_FOUND].some((value) => value === code))
    return new AppError('NOT_FOUND', {
      message: t('server.resources', '文件不存在或已移动'),
      cause: error,
    })
  if (code === 'EBUSY' || code === 'ETXTBSY')
    return new AppError('RESOURCE_BUSY', {
      message: t('server.resources', '文件正忙，请稍后重试'),
      cause: error,
    })
  if (
    ['EINVAL', 'ERR_INVALID_ARG_VALUE', 'EISDIR', 'ELOOP', 'ENAMETOOLONG', WS_ERROR.NOT_A_FILE].some(
      (value) => value === code,
    )
  )
    return new AppError('BAD_REQUEST', {
      message: t('server.resources', '请提供有效的普通文件路径'),
      cause: error,
    })
  return error instanceof Error ? error : new Error(String(error))
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/** 引用补全限于当前真实工作区；只有唯一且完整的查找结果才能成为文件来源。 */
export async function resolveWorkspaceReference(
  workspace: VirtualWorkspace,
  session: ExecutionSession,
  input: string,
  options: { fallback?: boolean; signal?: AbortSignal } = {},
) {
  const source = input.replace(/^@principal[\\/]/i, '').replaceAll('\\', '/')
  if (
    !source ||
    source.includes('\0') ||
    /^[a-z]:(?:[^/]|$)/i.test(source) ||
    (process.platform !== 'win32' && /^(?:[a-z]:\/|\/\/)/i.test(source))
  )
    throw new AppError('BAD_REQUEST', {
      message: t('server.resources', '请提供当前服务器上的有效文件路径'),
    })
  const lexical = path.resolve(session.workspaceRoot, source)
  if (!isWithin(session.workspaceRoot, lexical))
    throw new AppError('FORBIDDEN', {
      message: t('server.resources', '此引用超出当前工作区，请从所属搜索结果打开'),
    })
  const root = await realpath(session.workspaceRoot).catch((error) => {
    throw fileAccessError(error)
  })
  const resolve = async (candidate: string) => {
    options.signal?.throwIfAborted()
    const filePath = await workspace.resolveReadablePath(session, candidate)
    if (!isWithin(root, filePath))
      throw new AppError('FORBIDDEN', { message: t('server.resources', '无权访问此文件') })
    const relative = path.relative(root, filePath).replaceAll('\\', '/')
    // 真实目标也检查受保护路径，避免工作区内的别名绕过 .env/.infos 等限制。
    await workspace.resolveReadablePath(session, relative)
    const info = await stat(filePath)
    if (!info.isFile())
      throw new AppError('BAD_REQUEST', { message: t('server.resources', '请提供有效的普通文件路径') })
    return { filePath, info, relative }
  }
  try {
    return await resolve(source)
  } catch (error) {
    // 明确的绝对路径和越界、拒绝访问等错误不能触发猜测性补全。
    if (
      !options.fallback ||
      path.isAbsolute(source) ||
      source.split('/').includes('..') ||
      !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw fileAccessError(error)
  }
  const suffix = path.relative(session.workspaceRoot, lexical).replaceAll('\\', '/')
  const comparable = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value
  const expected = comparable(suffix)
  const directories = ['.']
  const matches: string[] = []
  const deadline = Date.now() + 2000
  let entries = 0
  let incomplete = false
  for (let index = 0; index < directories.length; index++) {
    options.signal?.throwIfAborted()
    if (index >= 1000 || Date.now() >= deadline) {
      incomplete = true
      break
    }
    const directory = directories[index]!
    try {
      const actual = await workspace.resolveReadablePath(session, directory)
      if (!isWithin(root, actual)) continue
      const handle = await opendir(actual)
      for await (const entry of handle) {
        options.signal?.throwIfAborted()
        if (++entries > 20_000 || Date.now() >= deadline) {
          incomplete = true
          break
        }
        if (entry.isSymbolicLink()) continue
        const relative = path.posix.join(directory, entry.name)
        const name = comparable(relative)
        if (entry.isDirectory()) {
          if (!['.git', 'node_modules'].includes(entry.name)) directories.push(relative)
        } else if (entry.isFile() && (name === expected || name.endsWith(`/${expected}`))) {
          try {
            await resolve(relative)
            matches.push(relative)
          } catch (error) {
            const classified = fileAccessError(error)
            if (
              !(classified instanceof AppError) ||
              !['FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST'].includes(classified.code)
            )
              throw classified
          }
          if (matches.length >= 2) break
        }
      }
    } catch (error) {
      const classified = fileAccessError(error)
      if (!(classified instanceof AppError) || !['FORBIDDEN', 'NOT_FOUND'].includes(classified.code))
        throw classified
    }
    if (incomplete || matches.length >= 2) break
  }
  if (matches.length >= 2)
    throw new AppError('CONFLICT', {
      message: t('server.resources', '引用匹配到多个文件，请使用完整工作区路径：{0}', [
        matches.join('、'),
      ]),
      data: { candidates: matches },
    })
  if (incomplete)
    throw new AppError('BAD_REQUEST', {
      message: t('server.resources', '查找范围较大，请使用完整工作区路径'),
    })
  if (!matches.length)
    throw new AppError('NOT_FOUND', { message: t('server.resources', '文件不存在或已移动') })
  return resolve(matches[0]!).catch((error) => {
    throw fileAccessError(error)
  })
}
