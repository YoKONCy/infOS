export interface Note {
  id: string
  narrative: string
  eventAt?: string
  createdAt?: string
  importance?: number
  affect?: { tones: string[]; valence: number; arousal: number }
  tags?: string[]
  status?: string
}
export interface Glow {
  id: string
  source: string
  at: number
  text: string
  tones: string[]
  intensity: number
  halfLifeH: number
  strength?: number
}
export interface Pattern {
  type: 'opening' | 'ending' | 'question' | 'phrase'
  key: string
  count: number
  of: number
}
export interface Nudge {
  lastSeq?: number
  lastAt?: number
  shown?: Record<string, number>
}
export const settings = {
  memoryCooldownHours: 48,
  memoryMinAgeHours: 6,
  memoryMinRelevance: 0.34,
  memoryMax: 1,
  afterglowMinIntensity: 0.7,
  afterglowMaxHours: 96,
  afterglowMinAgeMinutes: 30,
  repeatMinReplies: 8,
  repeatWindow: 30,
  repeatEveryReplies: 8,
  repeatPatternCooldownHours: 24,
  ignorePhrases: [] as string[],
}
export type Settings = typeof settings
