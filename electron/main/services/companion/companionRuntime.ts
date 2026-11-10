/**
 * @file 陪看的实际接线：盯窗口、耳朵、设置，以及经后端触发主动插话回合。
 *
 * @platform ELECTRON
 * @see companionService.ts
 */

import { getBackendOrigin } from '../clientConnection'
import { getClientCredential } from '../../utils/clientCredential'
import { desktopWatch } from '../desktopWatchService'
import { earsService } from '../ears/earsRuntime'
import { formatLines } from '../ears/earsTranscript'
import { homeSettings } from '../home/homeSettings'
import { CompanionService, type TriggerResult } from './companionService'

/** 一次插话回合最长等多久（毫秒）；后端回合本身最长 30 分钟，这里只等到合理的上限。 */
const TRIGGER_TIMEOUT_MS = 10 * 60_000

async function trigger(input: {
  agentId: string
  threadId: string
  content: string
  signal: AbortSignal
  frames?: {mimeType: 'image/png' | 'image/jpeg'; data: string}
}): Promise<TriggerResult> {
  const token = getClientCredential()
  const response = await fetch(`${getBackendOrigin()}/api/scheduler/proactive/watch-along`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      agentId: input.agentId,
      threadId: input.threadId,
      content: input.content,
      ...(input.frames ? {frames: input.frames} : {}),
      pace: {
        minIntervalSec: homeSettings.section('companion').minIntervalSec,
        maxPerHour: homeSettings.section('companion').maxPerHour,
      },
    }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(TRIGGER_TIMEOUT_MS)]),
    redirect: 'error',
  })
  const body = (await response.json()) as { code?: string; data?: TriggerResult; message?: string }
  if (!response.ok || body.code !== 'OK' || !body.data)
    throw new Error(body.message ?? `HTTP ${response.status}`)
  return body.data
}

export const companionService = new CompanionService({
  settings: () => homeSettings.section('companion'),
  watch: {
    onActivity: listener => desktopWatch.onActivity(listener),
    running: owner => desktopWatch.running(owner),
    recentGrid: owner => homeSettings.section('perception').screenImages ? desktopWatch.recentGrid(owner) : undefined,
  },
  ears: {
    on: (event, listener) => earsService.on(event, listener),
    pending: (owner) => earsService.transcript.pending(owner),
    recent: (from, to) => {
      const result = earsService.query(from, to) as {lines?: unknown}
      return typeof result.lines === 'string' ? result.lines : ''
    },
    take: (owner) => {
      const cursor = earsService.transcript.cursor(owner)
      const { lines } = earsService.transcript.takeNew(owner)
      return {
        text: formatLines(lines),
        count: lines.length,
        rewind: () => {
          if (cursor !== undefined && lines.length)
            earsService.transcript.rewind(owner, cursor, lines.at(-1)!.id)
        },
      }
    },
  },
  trigger,
})
