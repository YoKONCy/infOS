import type { Note, Glow } from './algorithmTypes'
export function compose(input: {
  memories?: Note[]
  glow?: Glow
  nudge?: string
  now: number
  maxChars?: number
}): string
