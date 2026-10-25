import { AsyncLocalStorage } from 'node:async_hooks'
import type { SocialStoragePort, SocialStorageScope } from '@infos/shared'
import { currentSocialRecovery } from './socialRecovery'
import type { InboundMessage } from './types'

const scopes = new AsyncLocalStorage<SocialStorageScope>()

export function currentSocialScope(): SocialStorageScope | undefined {
  const explicit = scopes.getStore()
  const record = currentSocialRecovery()?.record
  if (record)
    return {
      platform:
        record.platform ??
        (record.checkpoint.inbound as InboundMessage[] | undefined)?.[0]?.platform,
      accountId: record.accountId,
      channelType: record.channelType,
      channelId: record.channelId,
      ...explicit,
    }
  return explicit
}

export function withSocialScope<T>(scope: SocialStorageScope, run: () => T): T {
  return scopes.run(scope, run)
}

/** 在存储端执行筛选，不能在 LIMIT 之后靠内存过滤来补救身份范围。 */
export function scopedSocialStorage(
  storage: SocialStoragePort,
  readScope: () => SocialStorageScope | undefined = currentSocialScope,
): SocialStoragePort {
  const indexes: Partial<Record<keyof SocialStoragePort, number>> = {
    getRecent: 4,
    getRecentPrivateBySender: 3,
    getRecentBySender: 3,
    getByMsgId: 3,
    getRecentGroupsByContact: 3,
    getRecentSelfGroupMessages: 3,
    getContactGroupMessages: 4,
    deleteTurns: 3,
    getDataVersion: 3,
    countChannelMessages: 3,
    deleteChannelMessages: 3,
    completeQueuedMessages: 3,
  }
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const index = indexes[property as keyof SocialStoragePort]
      if (index === undefined) return value.bind(target)
      return (...args: unknown[]) => {
        const scope = readScope()
        const explicit = args[index] as SocialStorageScope | undefined
        const base = { platform: scope?.platform, accountId: scope?.accountId }
        const address =
          property === 'getByMsgId' || property === 'completeQueuedMessages'
            ? { ...base, channelId: scope?.channelId, channelType: scope?.channelType }
            : base
        while (args.length <= index) args.push(undefined)
        args[index] = { ...address, ...explicit }
        return Reflect.apply(value, target, args)
      }
    },
  })
}
