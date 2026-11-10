/**
 * 她删除用户文件时走 Windows 系统回收站（用户能在熟悉的回收站里还原）。
 *
 * - 只用于 Agent 的删除（home_files delete、旧 delete_file）；她自己地方的文件与临时文件
 *   维持后端回收区；设置为「进 infOS 回收区」时也一律走后端回收区。
 * - 系统回收站由 Electron 主进程执行（desktop.environment/homeRecycle → NativeTrash.recycle：
 *   prepare → 核对 → shell.trashItem → complete）。prepare 会走确认，需要确认时原样把
 *   HOME_CONFIRMATION_REQUIRED 交回工具层，工具层在锁外等用户回答后重新调用（homeConfirmWait）。
 * - 回退规则（.docs/home/electron-integration.md）：主进程不可用、回收失败或回执失败时，
 *   改走后端回收区；后端回收区重新走确认，不挪用已经消费的确认；任何情况下都不会永久删除。
 */

import os from 'node:os'
import type { HomeScope } from '@infos/shared'
import { HomeError } from './homeErrors'
import { canonicalPath, containsPath, pathKey } from './homePaths'
import type { HomeService } from './homeService'

/** 主进程回收的结果：进了系统回收站、没进（原件保留），或后端在 prepare 时给出的家错误码。 */
export type NativeRecycleOutcome =
  | { recycled: boolean; checkpointId?: string }
  | { homeCode: string; detail?: unknown }

/** 主进程提供的系统回收站（容器接到 desktop.environment/homeRecycle）。 */
export interface HomeNativeTrashHost {
  available(): boolean
  recycle(scope: HomeScope, file: string, signal?: AbortSignal): Promise<NativeRecycleOutcome>
}

/** 系统回收站刚失败过的文件：一段时间内直接走后端回收区，避免回答确认后又绕回系统回收站。 */
const FALLBACK_MS = 10 * 60_000
const failures = new WeakMap<HomeService, Map<string, number>>()
const failureKey = (scope: HomeScope, file: string) =>
  `${scope.agentId}\u0000${scope.sessionId}\u0000${pathKey(file)}`

/** 她自己地方的文件、临时文件、刚在系统回收站失败过的文件留在后端回收区。 */
function staysInBackend(
  home: HomeService,
  scope: HomeScope,
  file: string,
  temporaryRoots: string[],
): boolean {
  const failed = failures.get(home)?.get(failureKey(scope, file))
  if (failed !== undefined && failed > Date.now()) return true
  return (
    home.files.isOwn(scope, file) ||
    temporaryRoots.some((root) => containsPath(canonicalPath(root), file))
  )
}

/** Agent 删除文件：优先系统回收站，失败回退到后端回收区。 */
export async function deleteForAgent(
  home: HomeService,
  scope: HomeScope,
  file: string,
  signal?: AbortSignal,
  temporaryRoots: string[] = [os.tmpdir()],
): Promise<unknown> {
  const host = home.nativeTrash
  const resolved = canonicalPath(file)
  if (
    home.settings.deleteTarget() === 'system' &&
    host?.available() &&
    !staysInBackend(home, scope, resolved, temporaryRoots)
  ) {
    let outcome: NativeRecycleOutcome | undefined
    try {
      outcome = await host.recycle(scope, resolved, signal)
    } catch {
      outcome = undefined
    }
    // 需要确认、被拒绝、路径无效等：原样交回（工具层等用户回答后重新调用，不会转去后端回收区绕开确认）。
    if (outcome && 'homeCode' in outcome) throw new HomeError(outcome.homeCode, outcome.detail)
    if (outcome?.recycled)
      return { checkpointId: outcome.checkpointId, files: [resolved], provider: 'system' }
    const list = failures.get(home) ?? new Map<string, number>()
    list.set(failureKey(scope, resolved), Date.now() + FALLBACK_MS)
    failures.set(home, list)
    signal?.throwIfAborted()
  }
  return home.files.mutate(scope, 'delete', file)
}
