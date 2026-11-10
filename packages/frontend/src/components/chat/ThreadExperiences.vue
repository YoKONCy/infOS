<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, useId, watch } from 'vue'
import { t, getDisplayLocale } from '../../i18n'
import { threadsApi, type AgentExperience } from '../../api/modules/threadsApi'
import { getApiBaseUrl } from '../../api/transport'
import { useAgentStore } from '../../stores/useAgentStore'
import PDrawer from '../pixel/PDrawer.vue'
import PixelIcon from '../pixel/PixelIcon.vue'
import UserAvatar from '../user/UserAvatar.vue'
import ChatRichText from './ChatRichText.vue'

const props = withDefaults(
  defineProps<{
    threadId: string
    generation: number
    agentId: string
    agentName: string
    agentAvatarUrl?: string
    compact?: boolean
    disabled?: boolean
  }>(),
  { agentAvatarUrl: '', compact: false, disabled: false },
)
const emit = defineEmits<{ open: [] }>()
const agents = useAgentStore()
const sourceId = `experience-source-${useId()}`
const items = ref<AgentExperience[]>([])
const open = ref(false)
const loading = ref(false)
const loaded = ref(false)
const failed = ref(false)
const query = ref('')
const expanded = ref(new Set<number>())
const failedAvatars = ref(new Set<string>())
let version = 0

// 接口按来源顺序返回近期记录，阅读列表从最近的经历开始。
const records = computed(() =>
  [...items.value].reverse().map((item) => {
    const narration = ['system', 'butler'].includes(item.senderId.toLowerCase())
    const agent = agents.agents.find((candidate) => candidate.id === item.senderId)
    let sender = agent?.name || item.senderId
    if (item.senderId === 'user') sender = t('ui.chat', '你')
    else if (narration) sender = t('ui.chat', '据点旁白')
    let avatar = agent?.avatarUrl ? `${getApiBaseUrl()}${agent.avatarUrl}` : ''
    if (item.senderId === props.agentId && props.agentAvatarUrl) avatar = props.agentAvatarUrl
    const timestamp = new Date(item.timestamp.replace(' ', 'T'))
    const date = Number.isNaN(timestamp.getTime()) ? null : timestamp
    const day = date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      : ''
    return { ...item, sender, avatar, narration, date, day, room: item.roomName || item.roomId }
  }),
)
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase(getDisplayLocale())
  return search
    ? records.value.filter((item) =>
        [item.content, item.sender, item.room].some((text) =>
          text.toLocaleLowerCase(getDisplayLocale()).includes(search),
        ),
      )
    : records.value
})
const days = computed(() => {
  const groups = new Map<string, { key: string; date: Date | null; items: typeof records.value }>()
  for (const item of filtered.value) {
    let group = groups.get(item.day)
    if (!group) {
      group = { key: item.day, date: item.date, items: [] }
      groups.set(item.day, group)
    }
    group.items.push(item)
  }
  return [...groups.values()]
})

function dateLabel(date: Date | null): string {
  if (!date) return t('ui.chat', '时间未记录')
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return t('ui.chat', '今天')
  if (date.toDateString() === yesterday.toDateString()) return t('ui.chat', '昨天')
  return date.toLocaleDateString(getDisplayLocale(), {
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

function toggleSource(id: number): void {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

function close(): void {
  open.value = false
}

function show(): void {
  if (props.disabled || !props.threadId || open.value) return
  emit('open')
  query.value = ''
  open.value = true
  void load()
}

async function load(): Promise<void> {
  if (loading.value || !props.threadId) return
  const current = ++version
  const threadId = props.threadId
  loading.value = true
  failed.value = false
  try {
    const response = await threadsApi.experiences(threadId)
    if (current !== version || threadId !== props.threadId) return
    items.value = response.data?.items ?? []
    const currentIds = new Set(items.value.map((item) => item.id))
    expanded.value = new Set([...expanded.value].filter((id) => currentIds.has(id)))
    loaded.value = true
  } catch {
    if (current === version) failed.value = true
  } finally {
    if (current === version) loading.value = false
  }
}

watch(() => [props.threadId, props.generation, props.agentId], () => {
  version++
  close()
  items.value = []
  expanded.value.clear()
  failedAvatars.value.clear()
  query.value = ''
  loaded.value = false
  loading.value = false
  failed.value = false
})
watch(() => props.disabled, (disabled) => {
  if (disabled) close()
})
onDeactivated(close)
onBeforeUnmount(() => version++)
</script>

<template>
  <span class="experience-access">
    <button
      type="button"
      class="experience-trigger input-tool-trigger"
      :class="{ 'is-compact': compact, 'is-open': open }"
      :disabled="disabled || !threadId"
      :title="t('ui.chat', '生活经历')"
      :aria-label="t('ui.chat', '生活经历')"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="show"
    >
      <PixelIcon name="clock" size="xs" aria-hidden="true" />
      <span v-if="!compact">{{ t('ui.chat', '生活经历') }}</span>
    </button>

    <PDrawer v-if="open" :title="t('ui.chat', '生活经历')" :width="520" @close="close">
      <section class="experience-sheet" :aria-busy="loading">
        <header class="experience-intro">
          <span class="experience-portrait" aria-hidden="true">
            <img
              v-if="agentAvatarUrl && !failedAvatars.has(agentAvatarUrl)"
              :src="agentAvatarUrl"
              alt=""
              @error="failedAvatars.add(agentAvatarUrl)"
            />
            <PixelIcon v-else name="cat" size="lg" />
          </span>
          <div class="experience-intro__copy">
            <h2>{{ agentName }}</h2>
            <p>{{ t('ui.chat', '据点里的所见所闻') }}</p>
          </div>
          <button
            type="button"
            class="experience-icon-button"
            :title="t('ui.chat', '刷新经历')"
            :aria-label="t('ui.chat', '刷新经历')"
            :disabled="loading"
            @click="load"
          >
            <PixelIcon name="refresh" size="sm" :animation="loading ? 'spin' : undefined" />
          </button>
        </header>

        <div class="experience-search">
          <PixelIcon name="search" size="sm" aria-hidden="true" />
          <input
            v-model="query"
            type="search"
            :aria-label="t('ui.chat', '搜索经历')"
            :placeholder="t('ui.chat', '搜索内容、发言者或据点')"
          />
          <button
            v-if="query"
            type="button"
            class="experience-icon-button"
            :aria-label="t('ui.chat', '清除搜索')"
            @click="query = ''"
          >
            <PixelIcon name="close" size="xs" />
          </button>
        </div>

        <p v-if="loaded" class="experience-count" role="status">
          {{ query.trim()
            ? t('ui.chat', '找到 {0} 条经历', [filtered.length])
            : t('ui.chat', '最近 {0} 条经历', [items.length]) }}
        </p>

        <div v-if="failed" class="experience-error" role="alert">
          <PixelIcon name="alert" size="sm" aria-hidden="true" />
          <span>{{ t('ui.chat', '亲历记录读取失败，请重试') }}</span>
          <button type="button" :disabled="loading" @click="load">
            {{ t('ui.chat', '重试') }}
          </button>
        </div>
        <div v-if="loading && !loaded" class="experience-state" role="status">
          <PixelIcon name="book" size="xl" aria-hidden="true" />
          <p>{{ t('ui.chat', '正在读取亲历记录') }}</p>
        </div>
        <div v-else-if="!items.length && !failed" class="experience-state">
          <PixelIcon name="users" size="xl" aria-hidden="true" />
          <h3>{{ t('ui.chat', '还没有据点经历') }}</h3>
          <p>{{ t('ui.chat', '这里会记录角色在据点亲历的事情。') }}</p>
        </div>
        <div v-else-if="items.length && !filtered.length" class="experience-state">
          <PixelIcon name="search" size="xl" aria-hidden="true" />
          <h3>{{ t('ui.chat', '没有找到相关经历') }}</h3>
          <button type="button" class="experience-text-button" @click="query = ''">
            {{ t('ui.chat', '清除搜索') }}
          </button>
        </div>

        <section v-for="day in days" :key="day.key" class="experience-day">
          <h3 class="experience-day__heading">
            <time :datetime="day.key || undefined">{{ dateLabel(day.date) }}</time>
            <span aria-hidden="true" />
          </h3>
          <ol class="experience-timeline">
            <li v-for="item in day.items" :key="item.id" class="experience-event">
              <article>
                <header class="experience-event__header">
                  <UserAvatar v-if="item.senderId === 'user'" :size="30" :framed="false" />
                  <span v-else class="experience-avatar" aria-hidden="true">
                    <img
                      v-if="item.avatar && !failedAvatars.has(item.avatar)"
                      :src="item.avatar"
                      alt=""
                      loading="lazy"
                      @error="failedAvatars.add(item.avatar)"
                    />
                    <PixelIcon v-else :name="item.narration ? 'sparkle' : 'user'" size="sm" />
                  </span>
                  <strong>{{ item.sender }}</strong>
                  <time
                    v-if="item.date"
                    :datetime="item.date.toISOString()"
                    :title="item.date.toLocaleString(getDisplayLocale())"
                  >{{ item.date.toLocaleTimeString(getDisplayLocale(), { hour: '2-digit', minute: '2-digit' }) }}</time>
                </header>
                <div class="experience-room" :title="item.room">
                  <PixelIcon name="users" size="xs" aria-hidden="true" />
                  <span>{{ item.room }}</span>
                </div>
                <button
                  type="button"
                  class="experience-source-toggle"
                  :aria-expanded="expanded.has(item.id)"
                  :aria-controls="`${sourceId}-${item.id}`"
                  @click="toggleSource(item.id)"
                >
                  <span v-if="!expanded.has(item.id)" class="experience-excerpt">{{ item.content }}</span>
                  <span class="experience-source-toggle__label">
                    {{ expanded.has(item.id) ? t('ui.chat', '收起原文') : t('ui.chat', '查看原文') }}
                    <PixelIcon :name="expanded.has(item.id) ? 'chevron-up' : 'chevron-down'" size="xs" />
                  </span>
                </button>
                <div
                  v-show="expanded.has(item.id)"
                  :id="`${sourceId}-${item.id}`"
                  class="experience-source"
                >
                  <ChatRichText
                    v-if="expanded.has(item.id)"
                    :content="item.content"
                    :agent-id="agentId"
                    :thread-id="threadId"
                    :web-preview="false"
                    compact
                  />
                </div>
              </article>
            </li>
          </ol>
        </section>
      </section>
    </PDrawer>
  </span>
</template>

<style scoped src="./thread-experiences.css"></style>
