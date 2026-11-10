import { z } from 'zod'
import { HOME_DEFAULT_SETTINGS, HOME_SETTINGS_KEY } from '@infos/shared'

export const homeSettingsFields = z
  .object({
    massChangeThreshold: z.number().int().min(1).max(10_000),
    massChangeWindowMs: z.number().int().min(1).max(3_600_000),
    checkpointRetentionMs: z.number().int().min(1).max(31_536_000_000),
    snapshotMaxBytes: z.number().int().min(1).max(68_719_476_736),
    fileMaxBytes: z.number().int().min(1).max(268_435_456),
    shelfMaxBytes: z.number().int().min(1).max(68_719_476_736),
    shelfMaxItems: z.number().int().min(1).max(10_000),
    confirmationTimeoutMs: z.number().int().min(1000).max(600_000),
    activityRetentionMs: z.number().int().min(1).max(31_536_000_000),
    mapMaxItems: z.number().int().min(1).max(10_000),
    mapBlockedTerms: z.array(z.string().trim().min(1).max(128)).max(100),
  })
  .strict()
export const homeSettingsSchema = homeSettingsFields.refine(
  (value) => value.activityRetentionMs >= value.massChangeWindowMs,
)
export function validHomeSettings(key: string, value: string): boolean {
  if (key !== HOME_SETTINGS_KEY) return true
  try {
    const partial = homeSettingsFields.partial().parse(JSON.parse(value))
    return homeSettingsSchema.safeParse({ ...HOME_DEFAULT_SETTINGS, ...partial }).success
  } catch {
    return false
  }
}
