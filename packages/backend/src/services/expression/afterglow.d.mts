import type { Note, Glow, Settings } from './algorithmTypes'
export function glowFromNote(note: Note, now: number, settings: Settings): Glow | undefined
export function mergeGlows(
  list: Glow[],
  additions: (Glow | undefined)[],
  now: number,
  settings: Settings,
): Glow[]
export function pickGlow(
  list: Glow[],
  now: number,
  settings: Settings,
  exclude?: string[],
): Glow | undefined
export function glowLine(glow: Glow, now: number, maxChars?: number): string
