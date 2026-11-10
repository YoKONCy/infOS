import type { Note, Settings } from './algorithmTypes'
export function slimNote(note: unknown): Note | undefined
export function feeling(note: Note): number
export function idfTable(terms: string[], pool: Note[]): Map<string, number>
export function relevanceOf(note: Note, terms: string[], idf: Map<string, number>): number
export function pickMemories(input: {
  query: string
  candidates: Note[]
  ragIds?: string[]
  cooldown?: Record<string, number>
  exclude?: string[]
  now: number
  settings: Settings
}): Note[]
export function memoryLine(note: Note, now: number, maxChars?: number): string
