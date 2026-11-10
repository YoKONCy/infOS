/** 只传递有限的本机动作名称，不接受任意动画脚本或模型指令。 */
export const HOME_PET_PRESETS = ['greeting', 'notice', 'acknowledge'] as const
export type HomePetPreset = (typeof HOME_PET_PRESETS)[number]
export interface HomePetSignal {
  agentId: string
  cardId: string
  preset: HomePetPreset
}
export const HOME_PET_CHANNEL = 'home-card:pet'

export function isHomePetSignal(value: unknown): value is HomePetSignal {
  const row = value as HomePetSignal | undefined
  return Boolean(
    row &&
    typeof row.agentId === 'string' &&
    typeof row.cardId === 'string' &&
    HOME_PET_PRESETS.includes(row.preset),
  )
}
