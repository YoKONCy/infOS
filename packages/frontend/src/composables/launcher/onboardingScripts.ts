/** 启动器和主界面共用的首次上手引导。 */
import '@infos/shared/i18n/catalogs/onboarding'
import { t } from '../../i18n'
import type { OnboardingStep } from '../../components/overlays/OnboardingOverlay.vue'

const tr = (source: string) => t('ui.onboarding', source)

export function getLauncherSteps(): OnboardingStep[] {
  return [
    {
      speaker: 'Pero',
      title: tr('你好呀，我是 Pero！'),
      text: tr('欢迎来到萌动链接！第一次见面，就让我带你一起开始吧。'),
      expression: 'normal',
      tab: 'launch',
      focusSelector: null,
    },
    {
      speaker: 'Pero',
      title: tr('先选一位伙伴吧'),
      text: tr('点点头像，选一位想一起聊天的伙伴吧！以后也可以随时更换哦。'),
      expression: 'none',
      tab: 'launch',
      focusSelector: '#launcher-agent-stage',
      interactive: true,
    },
    {
      speaker: 'Pero',
      title: tr('准备好就出发！'),
      text: tr('准备好了就点「启动」吧。如果遇到问题，这里会告诉你怎么处理哦！'),
      expression: 'none',
      tab: 'launch',
      focusSelector: '#launcher-primary-action',
      action: 'launch-desktop',
      placement: 'top',
    },
  ]
}

export function getDesktopSteps(hasAssignedModel: boolean): OnboardingStep[] {
  const steps: OnboardingStep[] = [
    {
      speaker: 'Pero',
      title: tr('进来啦！'),
      text: tr('这里就是聊天的地方啦。除了聊天，以后还可以和伙伴一起做事、到据点玩哦！'),
      expression: 'normal',
      tab: 'chat',
      focusSelector: null,
    },
    {
      speaker: 'Pero',
      title: tr('想和谁聊天？'),
      text: tr('在这里可以切换伙伴，聊天记录也会留在旁边。想接着聊，随时点开就好！'),
      expression: 'none',
      tab: 'chat',
      focusSelector: '.chat-agent-section',
    },
  ]

  if (hasAssignedModel) {
    steps.push({
      speaker: 'Pero',
      title: tr('来打个招呼吧！'),
      text: tr('模型已经选好啦！在这里输入想说的话，点发送就可以开始聊天。要是没有回复，可以去「模型配置」检查连接哦。'),
      expression: 'proud',
      tab: 'chat',
      focusSelector: '.chat-input-area',
    })
  } else {
    steps.push({
      speaker: 'Pero',
      title: tr('聊天前先准备一下'),
      text: tr('伙伴需要连接模型才能回复。如果还没配置，我可以带你去设置；已经通过其他方式配置好了，也可以先去聊天试试哦。'),
      expression: 'normal',
      tab: 'chat',
      focusSelector: null,
      choices: [
        { label: tr('去配置模型'), value: 'setup-model' },
        { label: tr('先去聊天'), value: 'start-chat' },
      ],
    })
  }
  return steps
}
