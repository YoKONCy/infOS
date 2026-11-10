/**
 * 系统回收站的两阶段接入（HomeNativeTrashPort 的 Electron 实现，不依赖 Electron 本体，便于测试）。
 *
 * 1. POST /native-trash/prepare：后端确认、快照，返回 {path, expectedHash, checkpointId, scope}，原件仍在。
 * 2. trashItem：只接受第 1 步刚由本进程拿到的检查点（不接受卡片脚本或渲染页自报的路径），
 *    再核对普通文件、真实路径、内容摘要，然后调用 shell.trashItem。
 * 3. POST /native-trash/complete：按磁盘事实回执 success / failed。
 *
 * 失败绝不退化成永久删除：本模块没有任何 unlink / rm 路径；失败只回执 failed，原件保留，
 * 之后由后端兜底回收区重新请求（不能挪用已经消费的确认）。
 *
 * @see .docs/home/checkpoints.md 回收区
 */

import { createHash } from 'node:crypto'
import type { HomeNativeTrashPort, HomeScope } from '../../../packages/shared/src/home'
import type { HomeApiCall } from './homeApiCore'

export interface NativeTrashRequest {
  path: string
  expectedHash: string
  checkpointId: string
  scope: HomeScope
}

export interface NativeTrashDeps {
  api: HomeApiCall
  now(): number
  /** 读取文件元信息（不跟随链接）。 */
  lstat(file: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; nlink: number }>
  realpath(file: string): Promise<string>
  readFile(file: string): Promise<Buffer>
  /** Electron shell.trashItem。 */
  trash(file: string): Promise<void>
  exists(file: string): Promise<boolean>
}

/** prepare 拿到的请求只在这么久内有效，过期就不再接受。 */
const PREPARED_TTL_MS = 60_000

const sameScope = (a: HomeScope, b: HomeScope) =>
  a.agentId === b.agentId && a.sessionId === b.sessionId && (a.taskId ?? '') === (b.taskId ?? '')

/** Windows 路径不区分大小写，统一分隔符后比较。 */
const samePath = (a: string, b: string) =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

export class NativeTrash implements HomeNativeTrashPort {
  private readonly prepared = new Map<string, { request: NativeTrashRequest; at: number }>()

  constructor(private readonly deps: NativeTrashDeps) {}

  /** 完整流程：prepare → trashItem → complete。返回是否真的进了系统回收站。 */
  async recycle(
    scope: HomeScope,
    file: string,
  ): Promise<{ recycled: boolean; checkpointId: string }> {
    const request = await this.deps.api<NativeTrashRequest>('POST', '/native-trash/prepare', {
      scope,
      input: file,
    })
    this.prepared.set(request.checkpointId, { request, at: this.deps.now() })
    let recycled = false
    try {
      await this.trashItem(request)
      recycled = true
    } catch {
      recycled = false
    }
    // 回执按磁盘事实：成功时原件应已不在；失败时原件应原样保留。
    const result = recycled && !(await this.deps.exists(request.path)) ? 'success' : 'failed'
    await this.deps.api('POST', '/native-trash/complete', {
      scope: request.scope,
      input: { checkpointId: request.checkpointId, result },
    })
    return { recycled: result === 'success', checkpointId: request.checkpointId }
  }

  async trashItem(request: NativeTrashRequest): Promise<{ recycled: true; provider: 'system' }> {
    // 只接受本进程刚从后端 prepare 拿到的检查点，且每个检查点只用一次。
    const entry = this.prepared.get(request?.checkpointId)
    this.prepared.delete(request?.checkpointId)
    if (
      !entry ||
      this.deps.now() - entry.at > PREPARED_TTL_MS ||
      entry.request.path !== request.path ||
      entry.request.expectedHash !== request.expectedHash ||
      !sameScope(entry.request.scope, request.scope)
    )
      throw new Error('HOME_NATIVE_TRASH_UNTRUSTED: request was not prepared by the backend')
    const stat = await this.deps.lstat(request.path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)
      throw new Error('HOME_NATIVE_TRASH_NOT_FILE: only plain files can be recycled')
    if (!samePath(await this.deps.realpath(request.path), request.path))
      throw new Error('HOME_NATIVE_TRASH_PATH_CHANGED: real path differs from the checkpoint')
    const hash = createHash('sha256')
      .update(await this.deps.readFile(request.path))
      .digest('hex')
    if (hash !== request.expectedHash)
      throw new Error('HOME_NATIVE_TRASH_CHANGED: file content changed after the checkpoint')
    await this.deps.trash(request.path)
    return { recycled: true, provider: 'system' }
  }
}

/** desktop.environment/homeRecycle 的返回：进没进系统回收站，或后端 prepare 给的家错误码。 */
export type HomeRecycleResult =
  | { recycled: boolean; checkpointId?: string }
  | { homeCode: string; detail?: unknown }

/**
 * 后端（她删除用户文件时）经能力通道请求放进系统回收站。prepare 仍由本进程向后端发起并走确认，
 * 需要确认、被拒绝等家错误码原样交回，后端工具层据此暂停等用户回答；其他失败只报没进回收站，
 * 原件保留，由后端改走自己的回收区。
 */
export async function recycleForBackend(
  trash: Pick<NativeTrash, 'recycle'>,
  input: unknown,
): Promise<HomeRecycleResult> {
  const raw = (input ?? {}) as { scope?: Partial<HomeScope>; path?: unknown }
  const scope = raw.scope
  if (
    !scope ||
    typeof scope.agentId !== 'string' ||
    typeof scope.sessionId !== 'string' ||
    (scope.taskId !== undefined && typeof scope.taskId !== 'string') ||
    typeof raw.path !== 'string' ||
    !raw.path
  )
    return { homeCode: 'HOME_INVALID' }
  try {
    const result = await trash.recycle(
      {
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        ...(scope.taskId ? { taskId: scope.taskId } : {}),
      },
      raw.path,
    )
    return { recycled: result.recycled, checkpointId: result.checkpointId }
  } catch (error) {
    const homeCode = (error as { homeCode?: unknown } | null)?.homeCode
    if (typeof homeCode === 'string' && homeCode.startsWith('HOME_'))
      return { homeCode, detail: (error as { detail?: unknown }).detail }
    return { recycled: false }
  }
}
