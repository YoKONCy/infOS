/**
 * 右下角通知窗口要显示的内容：确认卡片（带按钮）与活动小提示。
 * 文案在主进程翻译好再发给页面，页面只用 textContent 填充，不拼 HTML。
 */

import { t as __t } from '../utils/i18n'
import type { HomeChoice, HomeIntent } from '../../../packages/shared/src/home'
import type { ConfirmationCard } from './homeConfirmations'
import type { ActivityToast } from './homeActivityBoard'
import { desktopFactLines } from './homeDesktopFacts'

const ui = (text: string, args?: unknown[]) => __t('electron.ui.home', text, args)

export interface NoticeButton {
  choice: HomeChoice
  label: string
  danger?: boolean
}
export interface ConfirmationNotice {
  kind: 'confirmation'
  id: string
  title: string
  lines: string[]
  reasons: string[]
  buttons: NoticeButton[]
  expiresAt: number
  busy: boolean
  error?: string
  /** 正在核对将保存的范围：显示目标与「确认保存 / 返回」。 */
  review?: { choice: HomeChoice; title: string; targets: string[]; confirm: string; back: string }
}
export interface ActivityNotice {
  kind: 'activity'
  id: string
  title: string
  lines: string[]
  failed: boolean
  expanded: boolean
  details: string[]
  undo?: string
  open: string
  close: string
  busy: boolean
  error?: string
}
export type HomeNotice = ConfirmationNotice | ActivityNotice

export function actionText(action: string): string {
  const labels: Record<string, string> = {
    read: '读取文件',
    write: '修改文件',
    move: '移动文件',
    delete: '删除文件',
    undo: '撤回改动',
    restore: '恢复文件',
    declare: '声明这次要动的范围',
    app: '操作应用',
    send: '发送消息',
    pay: '付款',
    settings: '修改系统设置',
    terminal: '运行终端命令',
  }
  return labels[action] ? ui(labels[action]) : action
}

export function reasonText(reason: string): string {
  const labels: Record<string, string> = {
    existing: '要改你已有的文件，或写入没授权的文件夹',
    app: '这个应用还没授权',
    undeclared: '超出了她事先说的范围',
    delete: '删除文件每次都要问（只会进回收站）',
    system: '涉及系统或程序目录',
    sensitive: '发消息、付款、改系统设置、跑终端命令每次都要问',
    autorun: '启动项、PATH 这类放进去就会自动生效的位置，每次都要问',
    mass: '短时间内改动的文件太多',
  }
  return labels[reason] ? ui(labels[reason]) : reason
}

export function choiceText(choice: HomeChoice): string {
  switch (choice) {
    case 'once':
      return ui('允许这一次')
    case 'session':
      return ui('这次会话都允许')
    case 'permanent':
      return ui('以后都允许')
    case 'deny':
      return ui('拒绝')
  }
}

/**
 * 动作参数的说明：桌面动作只列宿主核实过的事实（见 homeDesktopFacts）；
 * 其他动作不显示参数。不再显示 command、模型自报的 title / window / text。
 */
function parameterLines(intent: HomeIntent): string[] {
  const parameters = intent.parameters ?? {}
  return typeof parameters.program === 'string' ? desktopFactLines(parameters) : []
}

export function confirmationNotice(card: ConfirmationCard): ConfirmationNotice {
  const { confirmation } = card
  const intent = confirmation.intent
  const lines = [
    ...(intent.app ? [ui('应用：{0}', [intent.app])] : []),
    ...(confirmation.summary
      ? [ui('一共 {0} 个文件，在 {1}', [confirmation.summary.count, confirmation.summary.root])]
      : []),
    ...intent.paths.slice(0, 5),
    ...(intent.paths.length > 5 ? [ui('另外 {0} 个路径', [intent.paths.length - 5])] : []),
    ...parameterLines(intent),
  ]
  const notice: ConfirmationNotice = {
    kind: 'confirmation',
    id: card.id,
    title: ui('她想{0}', [actionText(intent.action)]),
    lines,
    reasons: confirmation.reasons.map(reasonText),
    // 只用后端给的 choices，原样保序。
    buttons: confirmation.choices.map((choice) => ({
      choice,
      label: choiceText(choice),
      ...(choice === 'deny' ? { danger: true } : {}),
    })),
    expiresAt: confirmation.expiresAt,
    busy: card.busy === true,
    ...(card.error ? { error: card.error } : {}),
  }
  if (card.reviewing)
    notice.review = {
      choice: card.reviewing,
      title:
        card.reviewing === 'permanent'
          ? ui('以后不再问这些范围：')
          : ui('这次会话里不再问这些范围：'),
      targets: confirmation.grantTargets.map((target) =>
        ui('{0}（{1}）：{2}', [
          target.kind === 'folder' ? ui('文件夹') : ui('应用'),
          target.access === 'write' ? ui('读写') : ui('只读'),
          target.target,
        ]),
      ),
      confirm: ui('确认保存'),
      back: ui('返回'),
    }
  return notice
}

/** 活动提示标题模板：{0} 是对象（文件名，或「N 个文件」）。 */
const ACTIVITY_TITLES: Record<string, [success: string, failed: string]> = {
  write: ['改了 {0}', '没能改 {0}'],
  move: ['移动了 {0}', '没能移动 {0}'],
  delete: ['把 {0} 放进了回收区', '没能删除 {0}'],
  undo: ['撤回了 {0} 的改动', '没能撤回 {0} 的改动'],
  restore: ['恢复了 {0}', '没能恢复 {0}'],
  declare: ['说明了这次要动的范围：{0}', '没能说明要动的范围：{0}'],
  app: ['在 {0} 里操作了一下', '在 {0} 里的操作没做成'],
  send: ['在 {0} 里发了消息', '在 {0} 里发消息没成功'],
  pay: ['在 {0} 里付了款', '在 {0} 里付款没成功'],
  settings: ['改了系统设置（{0}）', '没能改系统设置（{0}）'],
  terminal: ['在 {0} 里跑了终端命令', '在 {0} 里跑终端命令没成功'],
}

function baseName(file: string): string {
  return file.split(/[\/]/).filter(Boolean).at(-1) ?? file
}

export function activityNotice(toast: ActivityToast, canUndo: boolean): ActivityNotice {
  const objects = [...new Set(toast.activities.flatMap((row) => row.objects))]
  const failed = toast.activities.some((row) => row.result !== 'success')
  const subject =
    objects.length === 1
      ? baseName(objects[0]!)
      : objects.length
        ? ui('{0} 个文件', [objects.length])
        : ui('一些东西')
  const [success, failure] = ACTIVITY_TITLES[toast.action] ?? ['{0}', '{0}']
  const lines =
    toast.activities.length > 1 ? [ui('合并了 {0} 次操作', [toast.activities.length])] : []
  if (toast.undone) lines.push(ui('已撤回'))
  const last = toast.activities.at(-1)!
  return {
    kind: 'activity',
    id: toast.id,
    title: ui(failed ? failure : success, [subject]),
    lines,
    failed,
    expanded: toast.expanded,
    details: [
      ...objects.slice(0, 10),
      ...(objects.length > 10 ? [ui('另外 {0} 个路径', [objects.length - 10])] : []),
      ...(last.detail ? [ui('说明：{0}', [last.detail])] : []),
      ui('时间：{0}', [new Date(last.time).toLocaleTimeString()]),
    ],
    ...(canUndo ? { undo: ui('撤回') } : {}),
    open: ui('查看全部记录'),
    close: ui('关闭'),
    busy: toast.busy,
    ...(toast.error ? { error: toast.error } : {}),
  }
}
