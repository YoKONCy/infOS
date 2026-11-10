import type { Pattern, Nudge, Settings } from './algorithmTypes'
export function findPatterns(replies: { text: string }[], settings: Settings): Pattern[]
export function decideNudge(input: {
  patterns: Pattern[]
  nudge: Nudge
  seq: number
  now: number
  settings: Settings
}): Pattern[] | undefined
export function markNudge(
  nudge: Nudge,
  chosen: Pattern[],
  seq: number,
  now: number,
  settings: Settings,
): Nudge
export function nudgeLine(chosen: Pattern[]): string
