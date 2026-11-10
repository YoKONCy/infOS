/**
 * 确认原地等待：她的文件工具遇到要问的操作时，这次工具调用就挂着等用户应答，
 * 应答后在同一次调用里从头再走一遍原操作。模型只看到普通结果或一句话。
 *
 * - 等待发生在这里，不在任何文件锁、数据库事务里：attempt 抛出需要确认后所有锁都已释放；
 *   只暂停当前回合（waitGuard），其他会话不受影响。
 * - 每次重试都重新读文件、走 enforce，指纹、revision、过期、一次性消费等校验一条不少；这里没有放行的捷径。
 * - 只有 answer() 能把确认改成已批准，它只挂在管理 HTTP 通道和聊天审批卡片上，Agent 没有入口。
 * - 裁决顺序：等待结束后先看停止信号，再看应答，再核对文件。停止优先于批准；
 *   等待期间文件变了（before 对不上）按 HOME_CONFLICT 处理，不覆盖。
 * - 超时等于没批准也没执行。等待只活在内存里：后端重启后旧确认随 runtimeId 失效，不会重放。
 * - 去哪里确认：桌面客户端在线（订阅着 /events）走右下角通知；只开了网页端时显示成聊天审批卡片；
 *   哪儿都不能确认时立刻返回一句话，不白等。
 */

import type { HomeChoice, HomeConfirmation } from '@infos/shared'
import { HomeError } from './homeErrors'
import type { HomeService } from './homeService'
import type { ApprovalRequest, CreateApprovalInput } from '../execution/approvalService'
import { t } from '../../lib/i18n'

/** 聊天审批卡片上的工具名；不是真实工具，模型调用不到，也不会和真实工具的审批串号。 */
export const HOME_CHAT_CONFIRM_TOOL = 'home_confirmation'

/** 一次操作最多连着走几轮（系统回收站失败后改走后端回收区要再确认一次；新建被抢先后转成覆盖确认）。 */
const MAX_ROUNDS = 4

/** 聊天界面这个确认入口（容器接到 ApprovalService）。 */
export interface HomeChatConfirmation {
  /** 现在有没有在线的界面能显示审批卡片。 */
  available(): boolean
  /** 显示卡片，用户点了就回调；返回收起卡片的函数。 */
  open(request: HomeConfirmation, answer: (choice: HomeChoice) => void): () => void
}

/** ApprovalService 里这里用到的部分。 */
interface ApprovalPort {
  create(input: CreateApprovalInput): ApprovalRequest
  waitForResolution(id: string, signal?: AbortSignal): Promise<ApprovalRequest>
}

const describe = (request: HomeConfirmation) => {
  const { paths, app } = request.intent
  const objects = paths.length ? paths : app ? [app] : []
  const shown = objects.slice(0, 3).join(', ')
  return objects.length > 3 ? `${shown}…` : shown
}

/** 复用现有聊天审批卡片：不用改前端，只允许「这一次」或拒绝。 */
export function approvalChatConfirmation(
  approvals: ApprovalPort,
  available: () => boolean,
): HomeChatConfirmation {
  return {
    available,
    open(request, answer) {
      const controller = new AbortController()
      const approval = approvals.create({
        agentId: request.agentId,
        channel: 'desktop',
        sessionId: request.sessionId,
        threadId: request.sessionId,
        toolName: HOME_CHAT_CONFIRM_TOOL,
        args: {
          confirmationId: request.id,
          action: request.intent.action,
          paths: request.intent.paths,
          reasons: request.reasons,
          ...(request.summary ? { summary: request.summary } : {}),
        },
        reason: request.summary
          ? t('server.home', '她想动 {0} 个文件（{1}），等你确认', [
              request.summary.count,
              request.summary.root,
            ])
          : t('server.home', '她想动你的文件，等你确认：{0}', [describe(request)]),
        riskLevel: 'high',
      })
      void approvals.waitForResolution(approval.id, controller.signal).then(
        (resolved) => answer(resolved.status === 'approved' ? 'once' : 'deny'),
        () => undefined,
      )
      return () => controller.abort()
    },
  }
}

export interface HomeWaitOptions {
  signal?: AbortSignal
  /** 后台任务：聊天卡片属于会话，任务那边看不到，不能走卡片。 */
  backgroundTask?: boolean
  onStatus?: (status: string) => void
}

/** 给模型的结果带操作标识（确认 ID），用来区分重复调用，也方便和活动记录对上。 */
const failure = (code: string, request: HomeConfirmation) =>
  new HomeError(code, {
    paths: request.intent.paths,
    app: request.intent.app,
    operationId: request.id,
  })

/** 批准之后、重试之前：文件和当时问用户时已经不一样了，就不能拿这次批准去覆盖。 */
function assertUnchanged(home: HomeService, request: HomeConfirmation) {
  const before = request.intent.parameters?.before
  if (!Array.isArray(before)) return
  const changed = request.intent.paths.some((file, index) => {
    try {
      return home.storage.read(file).snapshot.hash !== before[index]
    } catch {
      return true
    }
  })
  if (!changed) return
  home.authorization.dismiss(request.id, 'conflict')
  throw failure('HOME_CONFLICT', request)
}

/** 等这一个确认的结果；挑一个用户能应答的地方。 */
async function waitForUser(home: HomeService, request: HomeConfirmation, options: HomeWaitOptions) {
  let closeCard: (() => void) | undefined
  if (!home.activity.hasListeners()) {
    if (options.backgroundTask || !home.chatConfirmation?.available()) {
      home.authorization.dismiss(request.id, 'no_surface')
      throw failure('HOME_NO_CONFIRM_SURFACE', request)
    }
    closeCard = home.chatConfirmation.open(request, (choice) => {
      try {
        home.authorization.answer(request.id, choice)
      } catch {
        /* 已经过期或别处答过了：等待方自己会收到结果。 */
      }
    })
  }
  options.onStatus?.(t('server.home', '正在等你确认，文件还没动……'))
  try {
    return await home.authorization.waitForAnswer(request, options.signal)
  } finally {
    closeCard?.()
  }
}

/**
 * 跑一次可能要确认的操作。attempt 必须能重入：每轮都从头读文件、走 enforce，确认要在锁外抛出来。
 * 拒绝、超时、取消、冲突都抛带路径和操作标识的 HomeError，文件没动。
 */
export async function withHomeConfirmation<T>(
  home: HomeService,
  options: HomeWaitOptions,
  attempt: () => T | Promise<T>,
): Promise<T> {
  let last: HomeConfirmation | undefined
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (options.signal?.aborted) {
      if (last) home.authorization.dismiss(last.id, 'cancelled')
      throw last ? failure('HOME_CANCELLED', last) : new HomeError('HOME_CANCELLED')
    }
    try {
      return await attempt()
    } catch (error) {
      // 新建时被别人抢先：不覆盖，再走一轮，这次它就是已有文件，按覆盖确认。
      if (error instanceof HomeError && error.code === 'HOME_CREATE_RACE') continue
      if (!(error instanceof HomeError) || error.code !== 'HOME_CONFIRMATION_REQUIRED') throw error
      last = error.data as HomeConfirmation
    }
    const outcome = await waitForUser(home, last, options)
    if (options.signal?.aborted || outcome === 'cancelled') {
      home.authorization.dismiss(last.id, 'cancelled')
      throw failure('HOME_CANCELLED', last)
    }
    if (outcome === 'denied') throw failure('HOME_DENIED', last)
    if (outcome === 'expired') throw failure('HOME_CONFIRMATION_TIMEOUT', last)
    assertUnchanged(home, last)
    options.onStatus?.(t('server.home', '已确认，继续执行……'))
  }
  if (!last) throw new HomeError('HOME_CONFLICT')
  // 连着问了几轮还没过去：按没等到确认收口，不把确认细节交给模型。
  home.authorization.dismiss(last.id, 'expired')
  throw failure('HOME_CONFIRMATION_TIMEOUT', last)
}
