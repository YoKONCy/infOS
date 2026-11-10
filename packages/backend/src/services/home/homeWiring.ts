/**
 * 「家」在应用容器中的装配：创建服务、会话关闭清理、确认等待、桌面卡片投递与原生回收站。
 */
import type { AppContext } from '../../container'
import type { DrizzleDb } from '../../database'
import type { LifecycleScope } from '../../kernel'
import { setHomeService } from '../../tools/home'
import { registerProtectedDataDir } from '../execution/protectedFiles'
import type { ConversationQueueService } from '../conversation/conversationQueueService'
import type { GatewayHub } from '../gateway/gatewayHub'
import type { RuntimeStateService } from '../runtime/runtimeStateService'
import { approvalChatConfirmation } from './homeConfirmWait'
import type { NativeRecycleOutcome } from './homeNativeDelete'
import { HomeService } from './homeService'

/** 创建家服务并注册给 home_* 工具；内核关闭时解除注册。 */
export function createHome(
  db: DrizzleDb,
  dataDir: string,
  workspace: (agentId: string) => string,
  lifecycle: LifecycleScope,
): HomeService {
  // 她的文件工具读不到、写不到、删不到 infOS 自己的凭据与访问控制文件。
  registerProtectedDataDir(dataDir)
  const home = new HomeService(db, dataDir, workspace)
  setHomeService(home)
  lifecycle.defer(() => setHomeService(undefined))
  return home
}

/** 会话删除时关闭该会话在家里的授权、待确认与占用。 */
export function homeSessionCleanup(home: HomeService): (sessionId: string) => void {
  return (sessionId) => {
    const agentIds = new Set(
      home.repo.list<{ agentId: string }>('grant', undefined, sessionId).map((row) => row.agentId),
    )
    for (const row of home.repo.list<{ agentId: string }>('confirmation', undefined, sessionId))
      agentIds.add(row.agentId)
    for (const row of home.repo.list<{ agentId: string }>('owned', undefined, sessionId))
      agentIds.add(row.agentId)
    for (const agentId of agentIds) home.close({ agentId, sessionId })
  }
}

/** 家的确认原地等待：同样暂停回合超时；没有桌面客户端时借聊天审批卡片应答。 */
export function wireHomeConfirmation(
  home: HomeService,
  runtimeStateService: Pick<RuntimeStateService, 'suspendTimeout'>,
  approvalService: Parameters<typeof approvalChatConfirmation>[0],
  gatewayHub: Pick<GatewayHub, 'hasInteractiveClient'>,
): void {
  home.authorization.setWaitGuard((threadId) => runtimeStateService.suspendTimeout(threadId))
  home.chatConfirmation = approvalChatConfirmation(approvalService, () =>
    gatewayHub.hasInteractiveClient(),
  )
}

/** 桌面卡片里的消息经对话队列送达她；返回解除投递的函数。 */
export function deliverHomeCards(
  home: HomeService,
  conversationQueue: Pick<ConversationQueueService, 'enqueue'>,
) {
  return home.cards.setDelivery(async (message) => {
    await conversationQueue.enqueue(message.id, {
      threadId: message.sessionId,
      agentId: message.agentId,
      content: `[桌面卡片 ${message.cardId}，消息 ${message.id}]\n${message.text}`,
    })
  })
}

/** 她删除用户文件走 Windows 回收站：主进程的 desktop.environment/homeRecycle（见 homeNativeDelete）。 */
export function wireHomeNativeTrash(ctx: AppContext): void {
  ctx.home.nativeTrash = {
    available: () => ctx.desktopCapabilities.isOperationAvailable('homeRecycle'),
    recycle: async (scope, file, signal) =>
      (await ctx.desktopCapabilities.invoke(
        'homeRecycle',
        { scope, path: file },
        { principalId: 'system', correlationId: `home-recycle:${Date.now()}` },
        signal,
      )) as NativeRecycleOutcome,
  }
}
