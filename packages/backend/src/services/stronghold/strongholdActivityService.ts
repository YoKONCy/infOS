import { z } from 'zod'
import type { StrongholdActivity, StrongholdInvitation, StrongholdMemberRef } from '@infos/shared'
import { AppError } from '../../lib/appError'
import { t } from '../../lib/i18n'
import type { LifeRecord } from '../../repositories/strongholdLife.repo'
import { lifeView, type LifeScope, type StrongholdLifeService } from './strongholdLifeService'

type ActivityData = Omit<StrongholdActivity, 'id' | 'roomId' | 'revision'>
type InvitationData = Omit<StrongholdInvitation, 'id' | 'roomId' | 'revision'>
const inputSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'join', 'leave', 'pause', 'resume', 'end', 'invite', 'respond']),
  id: z.string().optional(), revision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(),
  progress: z.string().max(2000).optional(), agentIds: z.array(z.string()).min(1).max(5).optional(),
  memberStatus: z.enum(['participating', 'observing', 'away', 'left']).optional(),
  response: z.enum(['accepted', 'declined', 'later', 'cancelled']).optional(),
  expiresAt: z.number().int().positive().optional(),
})
export { inputSchema as strongholdActivityInputSchema }

/** 活动公共进展、本人参与及邀请回应分别校验，操作回执与公共事件同事务提交。 */
export class StrongholdActivityService {
  constructor(private readonly life: StrongholdLifeService) {}

  list(roomId: string): StrongholdActivity[] {
    return this.life.repo.list<ActivityData>('activity', roomId).filter((row) => row.data.status !== 'ended').map(lifeView)
  }

  invitations(roomId: string): StrongholdInvitation[] {
    return this.life.repo.list<InvitationData>('invitation', roomId)
      .filter((row) => ['pending', 'later'].includes(row.data.status) && row.data.expiresAt > Date.now()).map(lifeView)
  }

  isMember(activityId: string, ref: StrongholdMemberRef, roomId: string): boolean {
    const activity = this.life.repo.get<ActivityData>(activityId)
    return activity?.kind === 'activity' && activity.roomId === roomId && activity.data.status !== 'ended' &&
      activity.data.members.some((member) => member.agentId === ref.agentId && member.threadId === ref.threadId &&
        member.generation === ref.generation && member.status !== 'left')
  }

  execute(scope: LifeScope, operationId: string, args: unknown) {
    const input = inputSchema.parse(args)
    this.life.assertScope(scope)
    if (input.action === 'list') return { activities: this.list(scope.roomId), invitations: this.invitations(scope.roomId) }
    return this.life.perform(scope, operationId, () => {
      if (scope.agentId === 'user') this.life.setPresence(scope.roomId, true, `activity:${operationId}`)
      if (input.action === 'create') {
        if (!input.title) throw new AppError('INVALID_PARAMETER', { message: 'STRONGHOLD_ACTIVITY_TITLE_REQUIRED' })
        const id = `life-activity:${scope.threadId}:${scope.generation}:${operationId}`
        let record = this.life.create<ActivityData>(id, 'activity', scope, {
          creatorId: scope.agentId, title: input.title, description: input.description ?? '', progress: input.progress ?? '',
          status: 'active', members: [{ agentId: scope.agentId, threadId: scope.threadId, generation: scope.generation, status: 'participating' }],
        } satisfies ActivityData, false)
        record = this.publish(scope, operationId, record)
        return lifeView(record)
      }
      if (input.action === 'respond') return this.respond(scope, operationId, input)
      let record = this.life.repo.get<ActivityData>(input.id ?? '')
      if (!record || record.kind !== 'activity' || record.roomId !== scope.roomId)
        throw new AppError('NOT_FOUND', { message: 'STRONGHOLD_ACTIVITY_NOT_FOUND' })
      if (record.revision !== input.revision) throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
      if (record.data.status === 'ended') throw new AppError('CONFLICT', { message: 'STRONGHOLD_ACTIVITY_ENDED' })
      if (input.action === 'invite') return this.invite(scope, operationId, record, input)
      const member = record.data.members.find((entry) => entry.agentId === scope.agentId &&
        entry.threadId === scope.threadId && entry.generation === scope.generation)
      if (!['join', 'leave'].includes(input.action) && member?.status !== 'participating')
        throw new AppError('FORBIDDEN', { message: 'STRONGHOLD_ACTIVITY_MEMBERSHIP_REQUIRED' })
      const data = { ...record.data }
      if (input.action === 'join' || input.action === 'leave') {
        if (input.action === 'leave' && !member) throw new AppError('FORBIDDEN', { message: 'STRONGHOLD_ACTIVITY_MEMBERSHIP_REQUIRED' })
        const status = input.action === 'leave' ? 'left' : input.memberStatus ?? 'participating'
        if (member?.status === status) return lifeView(record)
        data.members = record.data.members.filter((entry) => entry.agentId !== scope.agentId)
        data.members.push({ agentId: scope.agentId, threadId: scope.threadId, generation: scope.generation,
          status })
        if (data.members.every((entry) => entry.status === 'left')) data.status = 'ended'
      } else if (input.action === 'pause') data.status = 'paused'
      else if (input.action === 'resume') data.status = 'active'
      else if (input.action === 'end') data.status = 'ended'
      else {
        data.progress = input.progress ?? data.progress
        data.description = input.description ?? data.description
        data.title = input.title ?? data.title
      }
      if (JSON.stringify(data) === JSON.stringify(record.data)) return lifeView(record)
      record = this.life.repo.update(record, data)
      record = this.publish(scope, operationId, record)
      return lifeView(record)
    })
  }

  private invite(scope: LifeScope, operationId: string, activity: LifeRecord<ActivityData>, input: z.infer<typeof inputSchema>) {
    if (!activity.data.members.some((member) => member.agentId === scope.agentId && member.threadId === scope.threadId &&
      member.generation === scope.generation && member.status === 'participating') || !input.agentIds)
      throw new AppError('FORBIDDEN', { message: 'STRONGHOLD_ACTIVITY_MEMBERSHIP_REQUIRED' })
    if (input.expiresAt !== undefined && input.expiresAt <= Date.now())
      throw new AppError('INVALID_PARAMETER', { message: 'STRONGHOLD_INVITATION_FINISHED' })
    const result: StrongholdInvitation[] = []
    for (const agentId of new Set(input.agentIds)) {
      const recipient = this.life.ref(agentId)
      if (!recipient || agentId === scope.agentId || !this.life.current(recipient, scope.roomId))
        throw new AppError('INVALID_PARAMETER', { message: 'STRONGHOLD_INVITATION_RECIPIENT_INVALID' })
      const existing = this.invitations(scope.roomId).find((invitation) => invitation.activityId === activity.id &&
        invitation.recipient.threadId === recipient.threadId && invitation.recipient.generation === recipient.generation)
      if (existing) { result.push(existing); continue }
      let record = this.life.create<InvitationData>(`life-invitation:${scope.threadId}:${scope.generation}:${operationId}:${agentId}`,
        'invitation', scope, { activityId: activity.id, inviterId: scope.agentId, recipient,
          status: 'pending', expiresAt: input.expiresAt ?? Date.now() + 15 * 60_000,
        } satisfies InvitationData)
      const event = this.life.emit(scope, record.id, { kind: 'invitation', actorId: scope.agentId, objectId: record.id,
        details: { revision: record.revision + 1, activityId: activity.id, activityRevision: activity.revision,
          recipientId: agentId, status: 'pending', expiresAt: record.data.expiresAt,
          text: t('server.stronghold', '邀请 {0} 一起{1}', [this.life.displayName(agentId), activity.data.title]) } })
      record = this.life.repo.save({ ...record, sourceMessageId: event.id }, record.revision)
      if (agentId !== 'user' && (scope.agentId === 'user' || this.life.allowsAutonomy(agentId)))
        this.life.chat.commitReplyRequest(event.id, [agentId], scope.agentId !== 'user', recipient, { kind: 'invitation' })
      result.push(lifeView(record))
    }
    return result
  }

  private respond(scope: LifeScope, operationId: string, input: z.infer<typeof inputSchema>) {
    const invitation = this.life.repo.get<InvitationData>(input.id ?? '')
    if (!invitation || invitation.kind !== 'invitation' || invitation.roomId !== scope.roomId)
      throw new AppError('NOT_FOUND', { message: 'STRONGHOLD_INVITATION_NOT_FOUND' })
    if (invitation.revision !== input.revision) throw new AppError('CONFLICT', { message: 'STRONGHOLD_LIFE_REVISION_CONFLICT' })
    if (!input.response || !['pending', 'later'].includes(invitation.data.status) || invitation.data.expiresAt <= Date.now())
      throw new AppError('CONFLICT', { message: 'STRONGHOLD_INVITATION_FINISHED' })
    if (input.response === 'cancelled' ? invitation.data.inviterId !== scope.agentId :
      invitation.data.recipient.agentId !== scope.agentId || !this.life.current(invitation.data.recipient, scope.roomId))
      throw new AppError('FORBIDDEN', { message: 'STRONGHOLD_INVITATION_RECIPIENT_INVALID' })
    let activity = this.life.repo.get<ActivityData>(invitation.data.activityId)
    if (!activity || activity.data.status === 'ended') throw new AppError('CONFLICT', { message: 'STRONGHOLD_ACTIVITY_ENDED' })
    if (invitation.data.status === input.response) return lifeView(invitation)
    if (input.response === 'accepted') {
      const members = activity.data.members.filter((member) => member.agentId !== scope.agentId)
      members.push({ ...invitation.data.recipient, status: 'participating' })
      activity = this.life.repo.update(activity, { ...activity.data, members })
    }
    const result = this.life.repo.update(invitation, { ...invitation.data, status: input.response })
    const responseText = { accepted: '接受了活动邀请', declined: '婉拒了活动邀请', later: '稍后再回应邀请', cancelled: '取消了活动邀请' }
    this.life.emit(scope, operationId, { kind: 'invitation', actorId: scope.agentId, objectId: invitation.id,
      details: { revision: result.revision, activityId: activity.id, recipientId: invitation.data.recipient.agentId, status: input.response,
        text: t('server.stronghold', responseText[input.response]) } })
    if (input.response === 'accepted') this.publish(scope, `${operationId}:activity`, activity)
    return lifeView(result)
  }

  private publish(scope: LifeScope, operationId: string, record: LifeRecord<ActivityData>): LifeRecord<ActivityData> {
    const message = this.life.emit(scope, operationId, { kind: 'activity', actorId: scope.agentId, objectId: record.id,
      details: { ...record.data, revision: record.revision + 1,
        text: t('server.stronghold', '活动更新 · {0}', [record.data.title]) } })
    return this.life.repo.save({ ...record, sourceMessageId: message.id }, record.revision)
  }

  recover(origin?: LifeScope): void {
    for (const invitation of this.life.repo.list<InvitationData>('invitation')) {
      if (!['pending', 'later'].includes(invitation.data.status)) continue
      const activity = this.life.repo.get<ActivityData>(invitation.data.activityId)
      const valid = activity && activity.data.status !== 'ended' &&
        (invitation.sourceMessageId === null || Boolean(this.life.chat.getMessageEvent(invitation.sourceMessageId))) &&
        this.life.current(invitation.data.recipient, invitation.roomId) &&
        this.life.current({ agentId: invitation.agentId!, threadId: invitation.threadId!, generation: invitation.generation! }, invitation.roomId)
      const status = !valid ? 'cancelled' : invitation.data.expiresAt <= Date.now() ? 'expired' : undefined
      if (status) {
        this.life.repo.update(invitation, { ...invitation.data, status })
        this.life.emit({ ...invitation.data.recipient, roomId: invitation.roomId }, `invitation-expiry:${invitation.id}:${invitation.revision}`, {
          kind: 'invitation', actorId: invitation.data.recipient.agentId, objectId: invitation.id,
          details: { activityId: invitation.data.activityId, status, text: t('server.stronghold', '活动邀请已结束') },
        })
      }
    }
    for (let activity of this.life.repo.list<ActivityData>('activity')) {
      if (activity.sourceMessageId !== null && !this.life.chat.getMessageEvent(activity.sourceMessageId) && !activity.data.sourceWithdrawn)
        activity = this.life.repo.update(activity, { ...activity.data, sourceWithdrawn: true })
      if (activity.data.status === 'ended') continue
      const userPresent = this.life.repo.get<{ present: boolean }>(`life-presence:user:${activity.roomId}`)?.data.present ?? false
      const members = activity.data.members.map((member) => ['participating', 'observing'].includes(member.status) &&
        (member.agentId === 'user' ? !userPresent : !this.life.current(member, activity.roomId))
        ? { ...member, status: 'away' as const } : member)
      if (members.some((member, index) => member.status !== activity.data.members[index]!.status)) {
        const status = members.some((member) => member.status === 'participating') ? activity.data.status : 'paused'
        const updated = this.life.repo.update(activity, { ...activity.data, members, status })
        this.publish({ agentId: 'system', threadId: 'system', generation: 0, roomId: activity.roomId,
          sourceMessageId: origin?.sourceMessageId, causeAgentId: origin?.causeAgentId ?? origin?.agentId },
          `activity-away:${activity.id}:${activity.revision}`, updated)
      }
    }
  }

  invalidate(threadId?: string, sourcePairId?: string, roomId?: string, origin?: LifeScope): void {
    for (const invitation of this.life.repo.list<InvitationData>('invitation', roomId)) {
      if (['pending', 'later'].includes(invitation.data.status) &&
        (!threadId || invitation.threadId === threadId || invitation.data.recipient.threadId === threadId) &&
        (!sourcePairId || invitation.sourcePairId === sourcePairId))
        this.life.repo.update(invitation, { ...invitation.data, status: 'cancelled' })
    }
    for (const activity of this.life.repo.list<ActivityData>('activity', roomId)) {
      if (sourcePairId && activity.sourcePairId === sourcePairId)
        this.life.repo.update(activity, { ...activity.data, sourceWithdrawn: true })
    }
    this.recover(origin)
  }
}
