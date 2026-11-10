/**
 * @file 桌面操作护栏的通道、审批请求与状态结构。
 * @platform ELECTRON
 */

import type { SettingsSigner } from './settingsSigner'
import type {
  DesktopProgramLists,
  DesktopSafetyIssue,
  DesktopSafetyLoosening,
  DesktopSafetySettings,
  DesktopZoneResult,
} from '../../../packages/shared/src/desktopSafety'

export const DESKTOP_SAFETY_ACCEPTED_FILE = 'desktop-safety.accepted.json'

export const DESKTOP_SAFETY_CHANNELS = {
  get: 'desktop-safety:get',
  setNormalMode: 'desktop-safety:set-normal-mode',
  untrust: 'desktop-safety:untrust',
  showFile: 'desktop-safety:show-file',
  acceptExternal: 'desktop-safety:accept-external',
  discardExternal: 'desktop-safety:discard-external',
} as const

/** 审批对话框的请求与回答（生产环境为原生对话框，测试中替换）。 */
export type GuardPrompt =
  | { kind: 'action'; ask: 'every' | 'once'; zone: DesktopZoneResult; detail: string }
  | { kind: 'plan'; covered: string[]; excluded: string[]; purpose: string }
  | {
      kind: 'loosen'
      changes: DesktopSafetyLoosening[]
      source: 'agent' | 'user' | 'file'
      recovery?: boolean
      settings?: DesktopSafetySettings
    }
  | { kind: 'enable-control' }

/** once：允许这一次；thread：本次对话都允许；trust：以后都信任；approve：同意（预批、放宽）；deny：拒绝。 */
export type GuardAnswer = 'once' | 'thread' | 'trust' | 'approve' | 'deny'

export interface GuardCaller {
  agentId?: string
  threadId?: string
  taskId?: string
  /** 家的声明与授权所用的任务 ID（普通回合为 pairId）。 */
  homeTaskId?: string
}

export interface DesktopGuardDeps {
  userFile(): string
  acceptedFile(): string
  signer: SettingsSigner
  draft: unknown
  /** infOS 自己的进程名（审批弹窗与 infOS 窗口属于它）。 */
  selfPrograms(): string[]
  prompt(request: GuardPrompt): Promise<GuardAnswer>
  now(): number
}

export interface DesktopSafetyState {
  draftStatus: string
  draftValid: boolean
  draftIssues: DesktopSafetyIssue[]
  draft: DesktopProgramLists | null
  settings: DesktopSafetySettings
  /** 用户文件在应用外被修改：放宽的部分尚未生效。 */
  externalEdit: boolean
  /** 名单、签名或版本异常：保留可验证禁令并改为逐次确认。 */
  fileIssues: DesktopSafetyIssue[]
  filePath: string
}
