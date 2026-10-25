import type { Component } from 'vue'
import QqSettings from './QqSettings.vue'
import WeixinSettings from './WeixinSettings.vue'
import TelegramSettings from './TelegramSettings.vue'
import DiscordSettings from './DiscordSettings.vue'

/** 平台是一级导航；各平台拥有独立的登录与配置界面。 */
export interface SocialPlatformDefinition {
  platform: string
  adapter: string
  label: string
  description: string
  color: string
  groups: boolean
  qqFeatures?: boolean
  panel: Component
}
export const socialPlatformDefinitions: readonly SocialPlatformDefinition[] = [
  {
    platform: 'qq',
    adapter: 'napcat',
    label: 'QQ',
    description: 'NapCat · 私聊与群聊',
    color: '#38bdf8',
    groups: true,
    qqFeatures: true,
    panel: QqSettings,
  },
  {
    platform: 'weixin',
    adapter: 'weixin-ilink',
    label: '微信',
    description: 'ClawBot / iLink · 私聊',
    color: '#36bd78',
    groups: false,
    panel: WeixinSettings,
  },
  {
    platform: 'telegram',
    adapter: 'telegram-bot',
    label: 'Telegram',
    description: 'Bot API · 群组与话题',
    color: '#39a8db',
    groups: true,
    panel: TelegramSettings,
  },
  {
    platform: 'discord',
    adapter: 'discord-bot',
    label: 'Discord',
    description: 'Gateway · 频道与线程',
    color: '#9297f5',
    groups: true,
    panel: DiscordSettings,
  },
]
