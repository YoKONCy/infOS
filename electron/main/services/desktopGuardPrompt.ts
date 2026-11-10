/**
 * @file 桌面操作护栏的原生审批对话框。
 * @platform ELECTRON
 */

import { t as __t } from '../utils/i18n'
import { dialog, BrowserWindow } from 'electron'
import type {
  DesktopNormalMode,
  DesktopSafetyLoosening,
  DesktopZone,
} from '../../../packages/shared/src/desktopSafety'
import type { GuardAnswer, GuardPrompt } from './desktopGuardModel'

// ─── 原生对话框 ───────────────────────────────────────

const ui = (text: string, args?: unknown[]) => __t('electron.ui.desktopGuard', text, args)

const ZONE_LABELS: Record<DesktopZone, string> = {
  normal: '普通区',
  mustConfirm: '高危区',
  forbidden: '禁区',
}
const MODE_LABELS: Record<DesktopNormalMode, string> = {
  notify: '只提醒',
  once: '每个程序问一次',
  always: '每次都问',
}

function looseningText(change: DesktopSafetyLoosening): string {
  switch (change.kind) {
    case 'normal-mode':
      return ui('普通区权限：{0} → {1}', [ui(MODE_LABELS[change.from]), ui(MODE_LABELS[change.to])])
    case 'trust':
      return ui('加入信任名单：{0}', [change.program])
    case 'unforbid':
      return ui('移出追加的禁区：{0}', [change.program])
    case 'unconfirm':
      return ui('移出追加的高危区：{0}', [change.program])
  }
}

/** 主进程原生对话框：挂在聚焦的主窗口上，没有可用窗口时独立显示。 */
export async function nativeGuardPrompt(request: GuardPrompt): Promise<GuardAnswer> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
  let options: Electron.MessageBoxOptions
  let answers: GuardAnswer[]
  if (request.kind === 'action') {
    const program = request.zone.program || ui('无法识别的程序')
    answers = request.ask === 'every' ? ['once', 'deny'] : ['once', 'thread', 'trust', 'deny']
    options = {
      type: request.zone.zone === 'mustConfirm' ? 'warning' : 'question',
      title: ui('角色想操作你的电脑'),
      message: ui('{0}（{1}）', [program, ui(ZONE_LABELS[request.zone.zone])]),
      detail: request.detail,
      buttons:
        request.ask === 'every'
          ? [ui('允许这一次'), ui('拒绝')]
          : [ui('允许这一次'), ui('本次对话都允许'), ui('以后都信任这个程序'), ui('拒绝')],
    }
  } else if (request.kind === 'plan') {
    answers = ['approve', 'deny']
    options = {
      type: 'question',
      title: ui('任务预批'),
      message: ui('允许角色在本次任务中操作这些程序？'),
      detail: [
        request.purpose,
        ui('预批：{0}', [request.covered.join('、')]),
        ...(request.excluded.length
          ? [ui('不在预批范围（每次单独确认或禁止）：{0}', [request.excluded.join('、')])]
          : []),
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: [ui('允许'), ui('拒绝')],
    }
  } else if (request.kind === 'enable-control') {
    answers = ['approve', 'deny']
    options = {
      type: 'warning',
      title: ui('打开桌面操作'),
      message: ui('允许角色截图并操作你的电脑？'),
      detail: ui('只有在你本人打开这个开关时才确认。不确定请点拒绝。'),
      buttons: [ui('打开'), ui('拒绝')],
    }
  } else {
    answers = ['approve', 'deny']
    options = {
      type: 'warning',
      title: ui(request.recovery ? '恢复桌面安全设置' : '放宽桌面操作权限'),
      message: request.recovery
        ? ui('这些设置尚未在本次启动中确认。是否恢复？')
        : request.source === 'agent'
          ? ui('角色申请放宽桌面操作权限：')
          : request.source === 'file'
            ? ui('设置文件在应用外被修改，其中包含放宽的改动：')
            : ui('确认放宽桌面操作权限：'),
      detail: [
        ...request.changes.map(looseningText),
        ...(request.recovery && request.settings
          ? [
              ui('普通区权限：{0}', [ui(MODE_LABELS[request.settings.normalMode])]),
              ui('信任程序：{0}', [request.settings.trusted.join('、') || '—']),
              ui('追加禁区：{0}', [request.settings.forbidden.join('、') || '—']),
              ui('追加高危区：{0}', [request.settings.mustConfirm.join('、') || '—']),
            ]
          : []),
      ].join('\n'),
      buttons: [ui('允许'), ui('拒绝')],
    }
  }
  const cancelId = answers.indexOf('deny')
  const result = parent
    ? await dialog.showMessageBox(parent, {
        ...options,
        cancelId,
        defaultId: cancelId,
        noLink: true,
      })
    : await dialog.showMessageBox({ ...options, cancelId, defaultId: cancelId, noLink: true })
  return answers[result.response] ?? 'deny'
}
