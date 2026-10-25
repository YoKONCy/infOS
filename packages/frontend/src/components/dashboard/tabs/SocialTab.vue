<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { PixelIcon, PButton } from '../../pixel'
import { useAgentStore } from '../../../stores'
import {
  socialApi,
  type SocialConnection,
  type SocialPlatform,
} from '../../../api/modules/socialApi'
import { useSocialConnectionStatus } from '../../../composables/social/useSocialConnectionStatus'
import { socialPlatformDefinitions } from '../../social/platforms/registry'
import SocialPlatformIcon from '../../social/platforms/SocialPlatformIcon.vue'
import SocialCommonSettings from '../../social/SocialCommonSettings.vue'
import SocialDataSettings from '../../social/SocialDataSettings.vue'
import StatusCardDesigner from '../../social/StatusCardDesigner.vue'
import AccountStickers from '../../social/AccountStickers.vue'

defineOptions({ name: 'SocialTab' })
const agentStore = useAgentStore()
const connections = ref<SocialConnection[]>([])
const platforms = ref<SocialPlatform[]>([])
const agentId = ref('')
const selectedPlatform = ref('qq')
const activeSection = ref('overview')
const loading = ref(true)
const error = ref('')
const enabling = ref(false)
const { adapters } = useSocialConnectionStatus()
let alive = true
let generation = 0
const definition = computed(() =>
  socialPlatformDefinitions.find((item) => item.platform === selectedPlatform.value),
)
const connection = computed(() =>
  connections.value.find((item) => item.adapter === definition.value?.adapter),
)
const agentName = computed(
  () => agentStore.agents.find((item) => item.id === agentId.value)?.name ?? '',
)
const platformName = computed(() =>
  definition.value ? t('ui.social', definition.value.label) : t('ui.social', '通用设置'),
)
const canEnable = computed(() =>
  platforms.value.some((item) => item.type === definition.value?.adapter),
)
const platformConnections = computed(() =>
  connections.value.filter((item) => item.platform === selectedPlatform.value),
)
const sections = computed(() => [
  { id: 'overview', label: t('ui.social', '连接与账号'), icon: 'desktop' },
  ...(definition.value?.qqFeatures
    ? [
        { id: 'cards', label: t('ui.settings', '状态卡片'), icon: 'desktop' },
        { id: 'stickers', label: t('ui.settings', '收藏表情'), icon: 'image' },
      ]
    : []),
  { id: 'contacts', label: t('ui.settings', '联系人'), icon: 'users' },
  { id: 'data', label: t('ui.social', '会话数据'), icon: 'settings' },
])
function state(platform: string) {
  if (loading.value) return t('ui.social', '加载中…')
  if (error.value) return t('ui.social', '状态不可用')
  if (!connections.value.some((item) => item.platform === platform)) return t('ui.social', '未启用')
  return adapters.value.find((item) => item.platform === platform)?.connected
    ? t('ui.social', '已连接')
    : t('ui.social', '未连接')
}
async function loadConnections() {
  const current = ++generation
  try {
    const [result, available] = await Promise.all([
      socialApi.getConnections(),
      socialApi.getPlatforms(),
    ])
    if (!alive || current !== generation) return
    connections.value = result.data?.connections ?? []
    platforms.value = available.data?.platforms ?? []
    error.value = ''
  } catch (cause) {
    if (alive && current === generation)
      error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
  }
}
async function enablePlatform() {
  const target = definition.value
  if (enabling.value || !target || !canEnable.value) return
  enabling.value = true
  try {
    await socialApi.enablePlatform(target.adapter)
    await loadConnections()
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
  } finally {
    enabling.value = false
  }
}
async function initialize() {
  loading.value = true
  error.value = ''
  try {
    const [, config, agents] = await Promise.allSettled([
      loadConnections(),
      socialApi.getAgentConfig(),
      agentStore.agents.length ? Promise.resolve() : agentStore.fetchAgents(),
    ])
    if (config.status === 'rejected') throw config.reason
    if (agents.status === 'rejected') throw agents.reason
    if (alive) agentId.value = config.value.data?.agentId ?? 'pero'
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : t('ui.social', '连接操作失败')
  } finally {
    if (alive) loading.value = false
  }
}
watch(selectedPlatform, () => {
  activeSection.value = 'overview'
})
onMounted(initialize)
onUnmounted(() => {
  alive = false
  generation++
})
</script>

<template>
  <div class="social-panel">
    <div class="sp-workspace">
      <header class="sp-page-heading">
        <PixelIcon name="chat" size="sm" />
        <h2>{{ t('ui.settings', '社交适配器') }}</h2>
      </header>
      <nav class="sp-platform-nav" :aria-label="t('ui.social', '社交平台')">
        <button
          v-for="item in socialPlatformDefinitions"
          :key="item.platform"
          type="button"
          :data-platform="item.platform"
          :style="{ '--platform-accent': item.color }"
          :class="['sp-platform-tab', selectedPlatform === item.platform && 'is-selected']"
          :aria-current="selectedPlatform === item.platform ? 'page' : undefined"
          @click="selectedPlatform = item.platform"
        >
          <span class="sp-platform-emblem"><SocialPlatformIcon :platform="item.platform" /></span>
          <span class="sp-platform-tab-copy">
            <strong>{{ t('ui.social', item.label) }}</strong>
            <small>
              <i
                :class="{
                  'is-online': adapters.find((a) => a.platform === item.platform)?.connected,
                }"
              />
              {{ state(item.platform) }}
            </small>
          </span>
        </button>
        <button
          type="button"
          :class="[
            'sp-platform-tab',
            'sp-shared-tab',
            selectedPlatform === 'shared' && 'is-selected',
          ]"
          :aria-current="selectedPlatform === 'shared' ? 'page' : undefined"
          @click="selectedPlatform = 'shared'"
        >
          <span class="sp-platform-emblem"><PixelIcon name="settings" size="sm" /></span>
          <span class="sp-platform-tab-copy">
            <strong>{{ t('ui.social', '通用设置') }}</strong>
            <small>{{ t('ui.social', '所有平台') }}</small>
          </span>
        </button>
      </nav>
      <div v-if="error" class="sp-page-error" role="alert">
        <span>{{ error }}</span>
        <PButton size="sm" variant="secondary" @click="initialize">
          {{ t('ui.social', '重新加载') }}
        </PButton>
      </div>
      <div v-if="loading" class="sp-page-loading" role="status">
        {{ t('ui.social', '加载中…') }}
      </div>
      <SocialCommonSettings
        v-else-if="selectedPlatform === 'shared'"
        :agent-id="agentId"
        :connections="connections"
        @changed="agentId = $event"
      />
      <section
        v-else-if="definition"
        :key="selectedPlatform"
        class="sp-platform-workspace"
        :style="{ '--platform-accent': definition.color }"
        :aria-label="platformName"
      >
        <header class="sp-platform-heading">
          <div>
            <h3>{{ platformName }}</h3>
            <p>{{ t('ui.social', definition.description) }}</p>
          </div>
          <span class="sp-platform-summary">{{ state(selectedPlatform) }}</span>
        </header>
        <nav class="sp-sections" :aria-label="t('ui.social', '{0} 平台设置', [platformName])">
          <button
            v-for="section in sections"
            :key="section.id"
            type="button"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            :class="['sp-section', activeSection === section.id && 'sp-section-active']"
            @click="activeSection = section.id"
          >
            <PixelIcon :name="section.icon" size="xs" />
            {{ section.label }}
          </button>
        </nav>
        <p
          v-if="activeSection === 'overview' && !error && !connection && !canEnable"
          class="sp-page-error"
          role="status"
        >
          {{ t('ui.social', '后端尚未提供此平台适配器，请更新后重试。') }}
        </p>
        <component
          :is="definition.panel"
          v-if="activeSection === 'overview' && !error && (connection || canEnable)"
          :key="`${selectedPlatform}:${connection?.id ?? 'new'}`"
          :connection="connection"
          :enabling="enabling"
          @enable="enablePlatform"
          @changed="loadConnections"
        />
        <StatusCardDesigner
          v-else-if="activeSection === 'cards' && definition.qqFeatures"
          :key="agentId"
        />
        <AccountStickers
          v-else-if="activeSection === 'stickers' && definition.qqFeatures"
          :platform="selectedPlatform"
        />
        <SocialDataSettings
          v-else-if="activeSection === 'contacts' || activeSection === 'data'"
          :key="`${selectedPlatform}:${agentId}`"
          :section="activeSection"
          :platform="selectedPlatform"
          :agent-id="agentId"
          :agent-name="agentName"
          :connections="platformConnections"
          :allow-groups="definition.groups"
        />
      </section>
    </div>
  </div>
</template>
<style scoped src="../../social/socialPanel.css"></style>
<style scoped src="../../social/socialWorkspace.css"></style>
