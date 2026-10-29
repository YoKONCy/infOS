<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { DEFAULT_SOCIAL_SCHEDULER_CONFIG, SOCIAL_GROUP_POLICY_LIMITS } from '@infos/shared'
import { PixelIcon, PButton, PSwitch, PInputNumber } from '../pixel'
import { useAgentStore, useNotificationStore } from '../../stores'
import {
  socialApi,
  type SocialModeConfig,
  type SocialConnection,
} from '../../api/modules/socialApi'
import { t as __t } from '../../i18n'
import { logger } from '../../lib/logger'
import SocialTurnPanel from './SocialTurnPanel.vue'
import SocialDataSettings from './SocialDataSettings.vue'
import SocialActivityPanel from './SocialActivityPanel.vue'
const props = defineProps<{ agentId: string; connections: SocialConnection[] }>()
const emit = defineEmits<{ changed: [agentId: string] }>()
const agentStore = useAgentStore()
const notification = useNotificationStore()
const socialAgentId = ref(props.agentId)
const socialAgentName = computed(
  () => agentStore.agents.find((a) => a.id === props.agentId)?.name ?? '',
)
const agentSaving = ref(false)
const modeSaving = ref(false)
const activeSection = ref('identity')
const sections = computed(() => [
  { id: 'identity', label: __t('ui.settings', '社交身份'), icon: 'user' },
  { id: 'mode', label: __t('ui.settings', '社交模式'), icon: 'chat' },
  { id: 'data', label: __t('ui.social', '全局数据维护'), icon: 'settings' },
])
watch(
  () => props.agentId,
  (value) => {
    socialAgentId.value = value
  },
)
const modeConfig = ref<SocialModeConfig>({
  ...DEFAULT_SOCIAL_SCHEDULER_CONFIG,
  strangerPolicy: 'allow',
  groupWhitelist: [],
  groupBlacklist: [],
  userBlacklist: [],
  ownerPrivateOnlyAgentIds: [],
  loopGuard: {
    knownBotIds: [],
    trustedHumanIds: [],
    botMarks: [],
    maxBotTurns: 4,
    maxTurnsPerWindow: 20,
    windowSeconds: 60,
    maxModelRequests: 24,
    maxSends: 16,
    cooldownSeconds: 600,
  },
})
const groupWhitelistText = ref('')
const groupBlacklistText = ref('')
const userBlacklistText = ref('')
const knownBotText = ref('')
const trustedHumanText = ref('')
async function saveSocialAgent(): Promise<void> {
  if (!socialAgentId.value) return
  agentSaving.value = true
  try {
    const response = await socialApi.saveAgentConfig(socialAgentId.value)
    socialAgentId.value = response.data?.agentId ?? socialAgentId.value
    emit('changed', socialAgentId.value)
    notification.toast(__t('ui.settings', '社交角色已切换并立即生效'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '保存成功')
      },
    })
  } catch (error) {
    logger.error('SocialTab', __t('logs.frontend.settings', '切换社交角色失败'), error)
    notification.toast(__t('ui.settings', '社交角色切换失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '保存失败')
      },
    })
  } finally {
    agentSaving.value = false
  }
}

async function loadModeConfig(): Promise<void> {
  try {
    const response = await socialApi.getModeConfig()
    if (response.data)
      modeConfig.value = {
        ...modeConfig.value,
        ...response.data,
        loopGuard: { ...modeConfig.value.loopGuard, ...response.data.loopGuard },
      }
    groupWhitelistText.value = modeConfig.value.groupWhitelist.join('\n')
    groupBlacklistText.value = modeConfig.value.groupBlacklist.join('\n')
    userBlacklistText.value = modeConfig.value.userBlacklist.join('\n')
    knownBotText.value = modeConfig.value.loopGuard.knownBotIds.join('\n')
    trustedHumanText.value = modeConfig.value.loopGuard.trustedHumanIds.join('\n')
  } catch (error) {
    logger.error('SocialTab', __t('logs.frontend.settings', '加载社交模式配置失败'), error)
  }
}

function parseIdList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

async function saveModeConfig(): Promise<void> {
  modeSaving.value = true
  try {
    modeConfig.value.groupWhitelist = parseIdList(groupWhitelistText.value)
    modeConfig.value.groupBlacklist = parseIdList(groupBlacklistText.value)
    modeConfig.value.userBlacklist = parseIdList(userBlacklistText.value)
    modeConfig.value.loopGuard.knownBotIds = parseIdList(knownBotText.value)
    modeConfig.value.loopGuard.trustedHumanIds = parseIdList(trustedHumanText.value)
    const response = await socialApi.saveModeConfig(modeConfig.value)
    if (response.data)
      modeConfig.value = {
        ...modeConfig.value,
        ...response.data,
        loopGuard: { ...modeConfig.value.loopGuard, ...response.data.loopGuard },
      }
    knownBotText.value = modeConfig.value.loopGuard.knownBotIds.join('\n')
    trustedHumanText.value = modeConfig.value.loopGuard.trustedHumanIds.join('\n')
    notification.toast(__t('ui.settings', '社交模式配置已保存并生效'), {
      type: 'success',
      get title() {
        return __t('ui.settings', '保存成功')
      },
    })
  } catch (error) {
    logger.error('SocialTab', __t('logs.frontend.settings', '保存社交模式配置失败'), error)
    notification.toast(__t('ui.settings', '社交模式配置保存失败'), {
      type: 'error',
      get title() {
        return __t('ui.settings', '保存失败')
      },
    })
  } finally {
    modeSaving.value = false
  }
}

onMounted(loadModeConfig)
</script>
<template>
  <section class="sp-shared-settings">
    <p class="sp-scope-note">
      {{ __t('ui.social', '以下设置作用于所有社交平台；账号连接与主人身份在各平台内配置。') }}
    </p>
    <nav class="sp-sections" :aria-label="__t('ui.social', '通用设置')">
      <button
        v-for="item in sections"
        :key="item.id"
        type="button"
        :aria-current="activeSection === item.id ? 'page' : undefined"
        :class="['sp-section', activeSection === item.id && 'sp-section-active']"
        @click="activeSection = item.id"
      >
        <PixelIcon :name="item.icon" size="xs" />
        {{ item.label }}
      </button>
    </nav>
    <div v-if="activeSection === 'identity'" class="sp-owner-config">
      <div class="sp-block-header">
        <PixelIcon name="user" size="xs" />
        {{ __t('ui.settings', '社交身份') }}
      </div>
      <div class="sp-owner-body">
        <label for="social-shared-agent">
          {{ __t('ui.settings', '选择负责社交回复的角色。') }}
        </label>
        <div class="sp-owner-row">
          <select
            id="social-shared-agent"
            v-model="socialAgentId"
            class="sp-owner-input"
            :disabled="agentSaving"
          >
            <option v-for="agent in agentStore.enabledAgents" :key="agent.id" :value="agent.id">
              {{ agent.name }}（{{ agent.id }}）
            </option>
          </select>
          <PButton
            size="sm"
            :loading="agentSaving"
            :disabled="!socialAgentId"
            @click="saveSocialAgent"
          >
            {{ __t('ui.settings', '切换角色') }}
          </PButton>
        </div>
      </div>
    </div>
    <SocialTurnPanel v-if="activeSection === 'mode'" class="sp-turn-panel" :agent-id="agentId" />
    <div v-if="activeSection === 'mode'" class="sp-mode-grid">
      <section class="sp-config-block sp-mode-wide">
        <div class="sp-block-header">
          <PixelIcon name="clock" size="xs" />
          <span>{{ __t('ui.settings', '任务与恢复') }}</span>
        </div>
        <div class="sp-mode-body sp-number-row">
          <PInputNumber
            v-model="modeConfig.taskTimeoutMinutes"
            :label="__t('ui.settings', '整轮上限（分钟）')"
            :min="1"
            :max="360"
          />
          <PInputNumber
            v-model="modeConfig.modelIdleMinutes"
            :label="__t('ui.settings', '无数据超时（分钟）')"
            :min="1"
            :max="60"
          />
          <PInputNumber
            v-model="modeConfig.modelRequestMinutes"
            :label="__t('ui.settings', '单次请求上限（分钟）')"
            :min="modeConfig.modelIdleMinutes"
            :max="360"
          />
          <PInputNumber
            v-model="modeConfig.maxRetries"
            :label="__t('ui.settings', '自动重试次数')"
            :min="0"
            :max="2"
          />
        </div>
      </section>
      <section class="sp-config-block">
        <div class="sp-block-header">
          <PixelIcon name="clock" size="xs" />
          <span>{{ __t('ui.settings', '夜间静音') }}</span>
        </div>
        <div class="sp-mode-body">
          <div class="sp-setting-line">
            <div>
              <strong>{{ __t('ui.settings', '安静时段') }}</strong>
              <small>{{ __t('ui.settings', '静音期间不主动审视群聊') }}</small>
            </div>
            <PSwitch v-model="modeConfig.nightSilenceEnabled" />
          </div>
          <div class="sp-number-row">
            <PInputNumber
              v-model="modeConfig.nightSilenceStart"
              :label="__t('ui.settings', '开始小时')"
              :min="0"
              :max="23"
            />
            <PInputNumber
              v-model="modeConfig.nightSilenceEnd"
              :label="__t('ui.settings', '结束小时')"
              :min="0"
              :max="23"
            />
          </div>
        </div>
      </section>
      <section class="sp-config-block">
        <div class="sp-block-header">
          <PixelIcon name="chat" size="xs" />
          <span>{{ __t('ui.settings', '群聊主动策略') }}</span>
        </div>
        <div class="sp-mode-body">
          <div class="sp-setting-line">
            <div>
              <strong>{{ __t('ui.settings', '允许主动参与') }}</strong>
              <small>
                {{ __t('ui.settings', '各群独立观察与冷却，群内单独配置优先于默认策略') }}
              </small>
            </div>
            <PSwitch v-model="modeConfig.proactiveGroupEnabled" />
          </div>
          <PInputNumber
            v-model="modeConfig.minMessagesForReview"
            :label="__t('ui.settings', '最少审视消息数')"
            :min="SOCIAL_GROUP_POLICY_LIMITS.minMessagesForReview[0]"
            :max="SOCIAL_GROUP_POLICY_LIMITS.minMessagesForReview[1]"
          />
          <PInputNumber
            v-model="modeConfig.reviewIntervalSeconds"
            :label="__t('ui.settings', '每群主动观察间隔（秒）')"
            :min="SOCIAL_GROUP_POLICY_LIMITS.reviewIntervalSeconds[0]"
            :max="SOCIAL_GROUP_POLICY_LIMITS.reviewIntervalSeconds[1]"
          />
        </div>
      </section>
      <section class="sp-config-block sp-mode-wide">
        <div class="sp-block-header">
          <PixelIcon name="users" size="xs" />
          <span>{{ __t('ui.settings', '名单策略') }}</span>
        </div>
        <div class="sp-mode-body">
          <div class="sp-setting-line">
            <div>
              <strong>{{ __t('ui.settings', '陌生人私聊') }}</strong>
              <small>{{ __t('ui.settings', '忽略时仅主人私聊可进入处理链') }}</small>
            </div>
            <select v-model="modeConfig.strangerPolicy" class="sp-pixel-select">
              <option value="allow">{{ __t('ui.settings', '允许') }}</option>
              <option value="ignore">{{ __t('ui.settings', '忽略') }}</option>
            </select>
          </div>
          <div class="sp-list-grid">
            <label>
              {{ __t('ui.settings', '群白名单') }}
              <textarea
                v-model="groupWhitelistText"
                :placeholder="__t('ui.settings', '每行一个 平台:会话标识；留空表示不限制')"
              />
            </label>
            <label>
              {{ __t('ui.settings', '群黑名单') }}
              <textarea
                v-model="groupBlacklistText"
                :placeholder="__t('ui.settings', '每行一个 平台:会话标识')"
              />
            </label>
            <label>
              {{ __t('ui.settings', '用户黑名单') }}
              <textarea
                v-model="userBlacklistText"
                :placeholder="__t('ui.settings', '每行一个 平台:账号')"
              />
            </label>
          </div>
        </div>
      </section>
      <SocialActivityPanel :agent-id="agentId" />
      <section class="sp-config-block sp-mode-wide">
        <div class="sp-block-header">
          <PixelIcon name="alert" size="xs" />
          <span>{{ __t('ui.settings', '连续互聊保护') }}</span>
        </div>
        <div class="sp-mode-body">
          <p>
            {{
              __t('ui.settings', '限制与机器人的连续互聊，避免循环回复。达到频率上限时自动等待。')
            }}
          </p>
          <div class="sp-number-row">
            <PInputNumber
              v-model="modeConfig.loopGuard.maxBotTurns"
              :label="__t('ui.settings', '同机器人连续发送回合')"
              :min="1"
              :max="20"
            />
            <PInputNumber
              v-model="modeConfig.loopGuard.cooldownSeconds"
              :label="__t('ui.settings', '机器人冷却／闲置重置（秒）')"
              :min="30"
              :max="86400"
            />
          </div>
          <div class="sp-number-row">
            <PInputNumber
              v-model="modeConfig.loopGuard.windowSeconds"
              :label="__t('ui.settings', '滑动窗口（秒）')"
              :min="10"
              :max="3600"
            />
            <PInputNumber
              v-model="modeConfig.loopGuard.maxTurnsPerWindow"
              :label="__t('ui.settings', '窗口内处理批次')"
              :min="1"
              :max="200"
            />
            <PInputNumber
              v-model="modeConfig.loopGuard.maxModelRequests"
              :label="__t('ui.settings', '窗口内模型请求')"
              :min="1"
              :max="100"
            />
            <PInputNumber
              v-model="modeConfig.loopGuard.maxSends"
              :label="__t('ui.settings', '窗口内发送条数')"
              :min="1"
              :max="100"
            />
          </div>
          <div class="sp-list-grid">
            <label>
              {{ __t('ui.settings', '已知外部机器人') }}
              <textarea
                v-model="knownBotText"
                :placeholder="__t('ui.settings', '每行一个 平台:账号；不按昵称猜测')"
              />
            </label>
            <label>
              {{ __t('ui.settings', '可信真人') }}
              <textarea
                v-model="trustedHumanText"
                :placeholder="__t('ui.settings', '每行一个 平台:账号；主人自动包含')"
              />
            </label>
          </div>
          <div class="sp-bot-marks">
            <div class="sp-setting-line">
              <strong>{{ __t('ui.settings', '模型添加的机器人标记') }}</strong>
              <PButton size="sm" variant="ghost" :disabled="modeSaving" @click="loadModeConfig">
                {{ __t('ui.settings', '重新载入配置') }}
              </PButton>
            </div>
            <small>
              {{
                __t(
                  'ui.settings',
                  '标记按平台和账号隔离，在该平台的群聊和私聊中生效。误标可移除，可信真人不会被自动标记。',
                )
              }}
            </small>
            <div
              v-for="mark in modeConfig.loopGuard.botMarks"
              :key="mark.userId"
              class="sp-bot-mark"
            >
              <strong>{{ mark.platform }} · {{ mark.userId }}</strong>
              <p>{{ mark.reason }}</p>
              <small>
                {{ __t('ui.settings', '由') }} {{ mark.agentId }} {{ __t('ui.settings', '判断 ·') }}
                {{ mark.messageId ? __t('ui.settings', '佐证来自') : __t('ui.settings', '标记于') }}
                {{
                  mark.channelType === 'group'
                    ? __t('ui.settings', '群聊')
                    : __t('ui.settings', '私聊')
                }}
                {{ mark.channelId }}
                <template v-if="mark.messageId">
                  {{ __t('ui.settings', '· 消息') }} {{ mark.messageId }}
                </template>
                · {{ new Date(mark.createdAt).toLocaleString() }}
              </small>
            </div>
            <small v-if="!modeConfig.loopGuard.botMarks?.length">
              {{ __t('ui.settings', '暂无模型添加的标记') }}
            </small>
          </div>
          <small>{{ __t('ui.settings', '可在社交回合中解除互聊限制。') }}</small>
        </div>
      </section>
      <div class="sp-mode-actions">
        <PButton size="sm" :loading="modeSaving" @click="saveModeConfig">
          <PixelIcon name="save" size="xs" />
          {{ __t('ui.settings', '保存社交模式') }}
        </PButton>
      </div>
    </div>

    <SocialDataSettings
      v-if="activeSection === 'data'"
      section="data"
      :agent-id="agentId"
      :agent-name="socialAgentName"
      :connections="connections"
    />
  </section>
</template>
<style scoped src="./socialPanel.css"></style>
