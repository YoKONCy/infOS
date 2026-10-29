import {
  SOCIAL_PASS_BACKOFF_MINUTES,
  socialGroupPolicyKey,
  type SocialActivityMode,
  type SocialGroupActivity,
} from '@infos/shared'

interface ActivityScope {
  platform?: string
  agentId: string
  accountId: string
  channelId: string
}
interface ConfigPort {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}
const CONFIG_KEY = 'social.groupActivity'
const initial = (): SocialGroupActivity => ({ mode: 'normal', passCount: 0, reviewNotBefore: 0 })

/** 只保存参与节奏，不保存消息正文；所有群的更新串行合并，保存成功后才发布状态。 */
export class SocialActivityStore {
  private states: Record<string, SocialGroupActivity> = {}
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly config?: ConfigPort) {}

  async load(): Promise<void> {
    const raw = await this.config?.get(CONFIG_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('SOCIAL_ACTIVITY_STATE_INVALID')
    const states: Record<string, SocialGroupActivity> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const identity: unknown = JSON.parse(key)
      const state = value as SocialGroupActivity | null
      if (
        !Array.isArray(identity) ||
        identity.length !== 4 ||
        identity.some((part) => typeof part !== 'string' || !part || part.length > 200) ||
        !state ||
        !['normal', 'mention_only'].includes(state.mode) ||
        !Number.isInteger(state.passCount) ||
        state.passCount < 0 ||
        state.passCount > 4 ||
        !Number.isFinite(state.reviewNotBefore) ||
        state.reviewNotBefore < 0
      )
        throw new Error('SOCIAL_ACTIVITY_STATE_INVALID')
      states[key] = {
        mode: state.mode,
        passCount: state.passCount,
        reviewNotBefore: state.reviewNotBefore,
        ...(typeof state.lastTurnId === 'string' ? { lastTurnId: state.lastTurnId } : {}),
      }
    }
    this.states = states
  }

  private key(scope: ActivityScope): string {
    return socialGroupPolicyKey(scope.agentId, scope.accountId, scope.channelId, scope.platform)
  }

  get(scope: ActivityScope): SocialGroupActivity {
    return { ...(this.states[this.key(scope)] ?? initial()) }
  }

  entries(): Array<{ identity: string[]; state: SocialGroupActivity }> {
    return Object.entries(this.states).map(([key, state]) => ({
      identity: JSON.parse(key) as string[],
      state: { ...state },
    }))
  }

  private update(
    scope: ActivityScope,
    change: (state: SocialGroupActivity) => SocialGroupActivity,
  ) {
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        const key = this.key(scope)
        const previous = this.get(scope)
        const state = change(previous)
        if (state === previous) return previous
        const next = { ...this.states, [key]: state }
        await this.config?.set(CONFIG_KEY, JSON.stringify(next))
        this.states = next
        return { ...state }
      })
    this.writes = operation
    return operation
  }

  wake(scope: ActivityScope): Promise<SocialGroupActivity> {
    return this.update(scope, (state) => ({ ...state, passCount: 0, reviewNotBefore: 0 }))
  }

  setMode(scope: ActivityScope, mode: SocialActivityMode): Promise<SocialGroupActivity> {
    return this.update(scope, (state) => ({ ...state, ...initial(), mode }))
  }

  complete(
    scope: ActivityScope,
    outcome: { type: 'reply' | 'pass'; lowActivity?: boolean },
    turnId?: string,
  ): Promise<SocialGroupActivity> {
    return this.update(scope, (state) => {
      if (turnId && state.lastTurnId === turnId) return state
      const passCount = outcome.type === 'pass' ? Math.min(4, state.passCount + 1) : 0
      const mode =
        outcome.lowActivity || passCount > SOCIAL_PASS_BACKOFF_MINUTES.length
          ? 'mention_only'
          : state.mode
      return {
        mode,
        passCount,
        reviewNotBefore:
          mode === 'normal' && passCount > 0
            ? Date.now() + SOCIAL_PASS_BACKOFF_MINUTES[passCount - 1]! * 60_000
            : 0,
        ...(turnId ? { lastTurnId: turnId } : {}),
      }
    })
  }
}
