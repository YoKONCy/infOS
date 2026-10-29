<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { SocialGroupActivityItem } from '@infos/shared'
import { socialApi } from '../../api/modules/socialApi'
import { getDisplayLocale, t } from '../../i18n'
import { PButton, PixelIcon } from '../pixel'

const props = defineProps<{ agentId: string }>()
const records = ref<SocialGroupActivityItem[]>([])
const error = ref('')
const loading = ref(false)
const busy = ref('')
const now = ref(Date.now())
let request = 0
let active = true
let timer: ReturnType<typeof setTimeout> | undefined
const key = (item: SocialGroupActivityItem) =>
  JSON.stringify([item.platform, item.accountId, item.groupId])

function status(item: SocialGroupActivityItem): string {
  if (item.participation === 'engaged') return t('ui.social', '活跃续聊')
  if (item.mode === 'mention_only') return t('ui.social', '低活跃 · 仅新 @ 唤醒')
  return item.reviewNotBefore > now.value
    ? t('ui.social', 'PASS 冷却中')
    : t('ui.social', '普通旁观')
}
function nextReview(item: SocialGroupActivityItem): string {
  if (item.mode === 'mention_only') return t('ui.social', '不会自动恢复观察')
  return item.nextReviewAt
    ? t('ui.social', '最早观察：{0}', [
        new Date(item.nextReviewAt).toLocaleString(getDisplayLocale()),
      ])
    : t('ui.social', '等待足够的新消息')
}
async function load(): Promise<void> {
  if (timer) clearTimeout(timer)
  const sequence = ++request
  if (!props.agentId || !active) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const response = await socialApi.getGroupActivity(props.agentId)
    if (!active || sequence !== request) return
    records.value = response.data ?? []
    now.value = Date.now()
    error.value = ''
  } catch (cause) {
    if (active && sequence === request)
      error.value = cause instanceof Error ? cause.message : t('ui.social', '群聊参与状态加载失败')
  } finally {
    if (active && sequence === request) {
      loading.value = false
      timer = setTimeout(() => void load(), 15_000)
    }
  }
}
async function resume(item: SocialGroupActivityItem): Promise<void> {
  if (busy.value) return
  const agentId = props.agentId
  busy.value = key(item)
  try {
    await socialApi.resumeGroupObservation(agentId, item)
    if (agentId === props.agentId) await load()
  } catch (cause) {
    if (active && agentId === props.agentId)
      error.value = cause instanceof Error ? cause.message : t('ui.social', '恢复群聊观察失败')
  } finally {
    busy.value = ''
  }
}
watch(
  () => props.agentId,
  () => {
    records.value = []
    error.value = ''
    void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  active = false
  request++
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <section class="sp-config-block sp-mode-wide">
    <div class="sp-block-header">
      <PixelIcon name="chat" size="xs" />
      <span>{{ t('ui.social', '群聊参与节奏') }}</span>
    </div>
    <div class="sp-mode-body">
      <p>
        {{
          t(
            'ui.social',
            '连续 PASS 后依次冷却 10、20、60 分钟；再次 PASS 进入低活跃。新 @ 可唤醒，普通消息不会缩短冷却。',
          )
        }}
      </p>
      <small>
        {{ t('ui.social', '低活跃仅限制群聊唤醒，社交记忆整理与明确委派的任务仍独立运行。') }}
      </small>
      <PButton size="sm" variant="ghost" :loading="loading" @click="load">
        {{ t('ui.social', '刷新参与状态') }}
      </PButton>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="!records.length && !loading && !error">{{ t('ui.social', '暂无群聊参与记录') }}</p>
      <div v-for="item in records" :key="key(item)" class="sp-bot-mark">
        <strong>{{ item.platform }} · {{ item.accountId }} · {{ item.groupId }}</strong>
        <p>{{ status(item) }} · {{ t('ui.social', '连续 PASS：{0} 次', [item.passCount]) }}</p>
        <small>{{ nextReview(item) }}</small>
        <PButton
          v-if="item.mode === 'mention_only' || item.passCount > 0"
          size="sm"
          variant="ghost"
          :loading="busy === key(item)"
          :disabled="!!busy"
          @click="resume(item)"
        >
          {{ t('ui.social', '恢复正常观察') }}
        </PButton>
      </div>
    </div>
  </section>
</template>

<style scoped src="./socialPanel.css"></style>
