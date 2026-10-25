import {
  createDrizzleConnection,
  closeDrizzleConnection,
  type DrizzleDb,
} from '@infos/backend/database/connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDeliveryPort, TaskOrigin } from '@infos/shared'
import * as schema from '@infos/backend/database/schema'
import { BackgroundTaskRepository } from '@infos/backend/repositories/backgroundTask.repo'
import { TaskDeliveryService } from '@infos/backend/services/task/taskDeliveryService'
import { readTaskLifecycle } from '@infos/backend/services/task/taskLifecycle'
import type { GatewayHub } from '@infos/backend/services/gateway/gatewayHub'

const connections: DrizzleDb[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) closeDrizzleConnection(connection)
})

const origin: TaskOrigin = {
  platform: 'other',
  accountId: 'account-A',
  senderId: '@owner:example.org',
  channelType: 'private',
  channelId: 'dm-channel-9',
  messageId: 'message-1',
}

function setup() {
  const db = createDrizzleConnection(':memory:')
  connections.push(db)
  const gateway = { pushNotification: vi.fn(async () => {}) } as unknown as GatewayHub
  const service: TaskDeliveryService = new TaskDeliveryService(db, gateway, (value) =>
    service.authorizeOrigin(value),
  )
  const authorizeOrigin = vi.fn(async (value: TaskOrigin) =>
    value.platform === origin.platform && value.senderId === origin.senderId ? 'pero' : undefined,
  )
  const port: TaskDeliveryPort = {
    authorizeOrigin,
    ready: vi.fn(async () => true),
    send: vi.fn(async () => {}),
    sendResources: vi.fn(async () => {}),
  }
  return { db, service, port, authorizeOrigin }
}

describe('平台无关的任务投递', () => {
  it('按平台提供者核验身份，私聊会话标识无需等于主人账号，旧租约不撤销新提供者', async () => {
    const { service, port } = setup()
    const releaseOld = service.register(port)
    const sendResources = vi.fn(async () => {})
    const release = service.register({ ...port, sendResources })
    releaseOld()
    expect(await service.authorizeOrigin(origin)).toBe('pero')
    expect(await service.authorizeOrigin({ ...origin, platform: 'foreign' })).toBeUndefined()
    await service.sendApplicationResources(origin, 'pero', '完成', [])
    expect(sendResources).toHaveBeenCalledWith(origin, '完成', [])
    release()
    expect(await service.applicationReady(origin, 'pero')).toBe(false)
  })

  it('应用停止时保留待投递记录，重新注册平台提供者后向原始会话投递一次', async () => {
    const { db, service, port, authorizeOrigin } = setup()
    const repo = new BackgroundTaskRepository(db)
    const task = await repo.create({
      id: 'platform-task',
      agentId: 'pero',
      threadId: 'task-thread',
      title: '测试任务',
      instruction: '整理资料',
      status: 'completed',
      lifecycleJson: JSON.stringify({ ...readTaskLifecycle(null, '整理资料'), origin }),
    })
    const now = new Date().toISOString()
    db.insert(schema.taskDeliveries)
      .values({
        id: 'platform-delivery',
        taskId: task.id,
        channel: 'social',
        payloadJson: JSON.stringify(task),
        createdAt: now,
        updatedAt: now,
      })
      .run()
    await service.flush()
    expect(service.list(task.id)[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(authorizeOrigin).not.toHaveBeenCalled()
    service.register(port)
    db.update(schema.taskDeliveries).set({ nextAttemptAt: null }).run()
    await service.flush()
    await service.flush()
    expect(service.list(task.id)[0]).toMatchObject({ status: 'sent', attempts: 1 })
    expect(port.send).toHaveBeenCalledExactlyOnceWith(origin, expect.any(String), {
      agentId: 'pero',
      deliveryId: 'platform-delivery',
      taskId: 'platform-task',
      revision: 1,
      status: 'completed',
    })
  })

  it('桌面结果回填与持久唤醒各投递一次，不截断权威结果', async () => {
    const { db, service } = setup()
    db.insert(schema.threads).values({ id: 'origin', agentId: 'pero', channel: 'desktop' }).run()
    const repo = new BackgroundTaskRepository(db)
    const task = await repo.create({
      id: 'desktop-task',
      agentId: 'pero',
      threadId: 'background',
      targetThreadId: 'origin',
      completionAction: 'send_to_chat',
      title: '长报告',
      instruction: '整理',
      status: 'running',
    })
    await repo.transition(task.id, 'running', 'completed', { result: '甲'.repeat(16000) }, 1)
    const saved = (await repo.findById(task.id))!
    service.enqueue({ type: 'task.notification', eventId: 'result-event', payload: saved } as never)
    service.enqueue({ type: 'task.notification', eventId: 'result-event', payload: saved } as never)
    const enqueue = vi.fn(async () => undefined)
    service.setConversationDelivery(enqueue)
    await service.flush()
    await service.flush()
    expect(db.select().from(schema.threadMessages).all()).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        threadId: 'origin',
        agentId: 'pero',
        taskResultEvent: { deliveryId: 'result-event:resume', taskId: task.id },
      }),
      'task-result:result-event:resume',
    )
    expect((await repo.findById(task.id))!.result).toHaveLength(16000)
    expect(service.list(task.id).every((delivery) => delivery.status === 'sent')).toBe(true)
  })
})
