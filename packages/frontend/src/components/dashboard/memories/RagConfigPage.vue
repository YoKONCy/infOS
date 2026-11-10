<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { maintenanceApi, type MemoryRuntimeConfig } from '../../../api/modules/maintenanceApi'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { logger } from '../../../lib/logger'
import { PButton, PDialog, PixelIcon, PSwitch } from '../../pixel'
import RagNumberControl from './RagNumberControl.vue'
import RagChannelFields from './RagChannelFields.vue'
import RagBasicRelevanceFields from './RagBasicRelevanceFields.vue'

const emit = defineEmits<{ back: [] }>()
type Section = 'desktop' | 'group' | 'advanced'
type ExtensionKey =
  | 'enableFista'
  | 'enableDpp'
  | 'enableContextRnn'
  | 'enableLeiden'
  | 'enableFeedback'
const section = ref<Section>('desktop')
const config = ref<MemoryRuntimeConfig | null>(null)
const saved = ref('')
const loading = ref(true)
const saving = ref(false)
const loadError = ref(false)
const saveError = ref(false)
const confirmLeave = ref(false)
const heading = ref<HTMLElement | null>(null)
const notif = useNotificationStore()
let alive = true

const dirty = computed(() => config.value !== null && JSON.stringify(config.value) !== saved.value)
const activeChannel = computed(() => (section.value === 'group' ? 'group' : 'desktop'))
const sections = computed(() => [
  { id: 'desktop' as const, icon: 'desktop', label: t('ui.rag', '桌面对话') },
  { id: 'group' as const, icon: 'chat', label: t('ui.rag', '据点群聊') },
  { id: 'advanced' as const, icon: 'link', label: t('ui.rag', '检索策略') },
])
const currentLabel = computed(() => sections.value.find((item) => item.id === section.value)?.label)
const currentDescription = computed(() =>
  section.value === 'advanced'
    ? t('ui.rag', '基础与高级检索参数由两个场景共用')
    : section.value === 'group'
      ? t('ui.rag', '仅影响据点群聊')
      : t('ui.rag', '桌面对话与轻量陪伴共用'),
)
const extensions = computed<
  Array<{ key: ExtensionKey; label: string; description: string; tag: string }>
>(() => [
  {
    key: 'enableFista',
    label: t('ui.rag', '补充线索'),
    description: t('ui.rag', '补充较弱的关联线索'),
    tag: 'FISTA',
  },
  {
    key: 'enableDpp',
    label: t('ui.rag', '结果去重'),
    description: t('ui.rag', '减少召回内容之间的重复'),
    tag: 'DPP',
  },
  {
    key: 'enableContextRnn',
    label: t('ui.rag', '对话轨迹'),
    description: t('ui.rag', '参考近期对话调整检索方向'),
    tag: 'ContextRNN',
  },
  {
    key: 'enableLeiden',
    label: t('ui.rag', '事件聚类'),
    description: t('ui.rag', '利用相关事件分组辅助检索'),
    tag: 'Leiden',
  },
  {
    key: 'enableFeedback',
    label: t('ui.rag', '反馈学习'),
    description: t('ui.rag', '根据记忆引用情况调整检索'),
    tag: '',
  },
])

// 与后端依赖关系保持一致：关闭主管线会关闭子模块，反馈依赖对话轨迹。
watch(
  () => config.value?.advanced.enableSaPpr,
  (enabled) => {
    if (enabled || !config.value) return
    const advanced = config.value.advanced
    advanced.enableFista = false
    advanced.enableDpp = false
    advanced.enableContextRnn = false
    advanced.enableLeiden = false
    advanced.enableFeedback = false
  },
  { flush: 'sync' },
)
watch(
  () => config.value?.advanced.enableContextRnn,
  (enabled) => {
    if (!enabled && config.value) config.value.advanced.enableFeedback = false
  },
  { flush: 'sync' },
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = false
  try {
    const response = await maintenanceApi.getMemoryConfig()
    if (!alive) return
    if (!response.data) throw new Error('MEMORY_CONFIG_MISSING')
    config.value = response.data
    saved.value = JSON.stringify(config.value)
  } catch (error) {
    if (!alive) return
    loadError.value = true
    logger.error('RagConfigPage', t('logs.frontend.settings', '读取记忆运行配置失败'), error)
  } finally {
    if (alive) loading.value = false
  }
}

async function save(): Promise<void> {
  if (!config.value || !dirty.value || saving.value || loading.value) return
  saving.value = true
  saveError.value = false
  try {
    // 提交快照；保存期间禁用编辑，响应只会替换对应版本的草稿。
    const snapshot = JSON.parse(JSON.stringify(config.value)) as MemoryRuntimeConfig
    const response = await maintenanceApi.setMemoryConfig(snapshot)
    if (!alive) return
    config.value = response.data ?? snapshot
    saved.value = JSON.stringify(config.value)
    notif.toast(t('ui.rag', 'RAG 配置已保存'), 'success')
  } catch (error) {
    if (!alive) return
    saveError.value = true
    logger.error('RagConfigPage', t('logs.frontend.settings', '保存记忆配置失败'), error)
  } finally {
    if (alive) saving.value = false
  }
}

function undo(): void {
  if (!saved.value || saving.value) return
  config.value = JSON.parse(saved.value) as MemoryRuntimeConfig
  saveError.value = false
}
function back(): void {
  if (saving.value) return
  if (dirty.value) confirmLeave.value = true
  else emit('back')
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  void load()
  await nextTick()
  heading.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  alive = false
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <section class="rag-page" :aria-label="t('ui.rag', 'RAG 配置')">
    <header class="rag-header">
      <div class="rag-heading">
        <button
          type="button"
          class="rag-back"
          :disabled="saving"
          :aria-label="t('ui.rag', '返回核心记忆')"
          @click="back"
        >
          <PixelIcon name="chevron-left" size="sm" />
        </button>
        <div>
          <div class="rag-breadcrumb">
            <button type="button" :disabled="saving" @click="back">
              {{ t('ui.rag', '核心记忆') }}
            </button>
            <PixelIcon name="chevron-right" size="xs" />
            <span>{{ t('ui.rag', 'RAG 配置') }}</span>
          </div>
          <h2 ref="heading" tabindex="-1">{{ t('ui.rag', 'RAG 配置') }}</h2>
          <p>{{ t('ui.rag', '对话上下文与长期记忆召回') }}</p>
        </div>
      </div>
      <div class="rag-actions">
        <span
          v-if="config && !loading"
          class="rag-save-state"
          :class="{ 'is-dirty': dirty }"
          role="status"
        >
          <PixelIcon :name="dirty ? 'circle' : 'check'" size="xs" />
          {{ dirty ? t('ui.rag', '未保存') : t('ui.rag', '已保存') }}
        </span>
        <PButton variant="ghost" size="sm" :disabled="!dirty || saving || loading" @click="undo">
          {{ t('ui.rag', '撤销修改') }}
        </PButton>
        <PButton size="sm" :loading="saving" :disabled="!dirty || loading || !config" @click="save">
          <PixelIcon v-if="!saving" name="save" size="xs" />
          {{ t('ui.rag', '保存配置') }}
        </PButton>
      </div>
    </header>

    <div v-if="loading" class="rag-state" role="status">
      <PixelIcon name="refresh" animation="spin" size="md" />
      <span>{{ t('ui.rag', '加载配置中') }}</span>
    </div>
    <div v-else-if="loadError" class="rag-state" role="alert">
      <PixelIcon name="alert" size="md" />
      <span>{{ t('ui.rag', '配置加载失败') }}</span>
      <PButton variant="secondary" size="sm" @click="load">{{ t('ui.rag', '重试') }}</PButton>
    </div>
    <div v-else-if="config" class="rag-layout">
      <nav class="rag-nav" :aria-label="t('ui.rag', 'RAG 配置')">
        <span class="rag-scope">{{ t('ui.rag', '所有角色共用') }}</span>
        <button
          v-for="item in sections"
          :key="item.id"
          type="button"
          :class="{ 'is-active': section === item.id }"
          :aria-current="section === item.id ? 'page' : undefined"
          @click="section = item.id"
        >
          <PixelIcon :name="item.icon" size="sm" />
          <span>{{ item.label }}</span>
          <PixelIcon class="rag-nav-arrow" name="chevron-right" size="xs" />
        </button>
      </nav>

      <div class="rag-scroll custom-scrollbar">
        <div class="rag-content">
          <div class="rag-section-heading">
            <h3>{{ currentLabel }}</h3>
            <p>{{ currentDescription }}</p>
          </div>
          <p v-if="saveError" class="rag-error" role="alert">
            <PixelIcon name="alert" size="sm" />
            {{ t('ui.rag', '保存失败，请重试') }}
          </p>
          <fieldset class="rag-fields" :disabled="saving" :aria-busy="saving">
            <RagChannelFields
              v-if="section !== 'advanced'"
              :key="activeChannel"
              v-model:channel="config.channels[activeChannel]"
              :channel-id="activeChannel"
            />
            <template v-else>
              <RagBasicRelevanceFields
                v-model:basic="config.basic"
                :advanced-enabled="config.advanced.enableSaPpr"
              />
              <div class="rag-switch-row rag-switch-row--featured">
                <span class="rag-feature-icon"><PixelIcon name="link" size="md" /></span>
                <div class="rag-row-copy">
                  <label id="rag-advanced-label">
                    {{ t('ui.rag', '启用高级检索') }}
                    <span class="rag-tag">SA-PPR</span>
                  </label>
                  <p>{{ t('ui.rag', '使用关联图谱扩展记忆线索') }}</p>
                </div>
                <PSwitch
                  v-model="config.advanced.enableSaPpr"
                  aria-labelledby="rag-advanced-label"
                />
              </div>
              <p v-if="!config.advanced.enableSaPpr" class="rag-dependency">
                <PixelIcon name="info" size="xs" />
                {{ t('ui.rag', '开启高级检索后可调整以下选项') }}
              </p>
              <fieldset class="rag-fields" :disabled="!config.advanced.enableSaPpr">
                <div class="rag-number-grid rag-number-grid--advanced">
                  <RagNumberControl
                    id="rag-depth"
                    v-model="config.advanced.expandDepth"
                    :label="t('ui.rag', '扩散深度')"
                    :description="t('ui.rag', '查找关联记忆的层数')"
                    :min="1"
                    :max="6"
                    :disabled="!config.advanced.enableSaPpr"
                  />
                  <RagNumberControl
                    id="rag-alpha"
                    v-model="config.advanced.teleportAlpha"
                    :label="t('ui.rag', '回跳概率')"
                    :description="t('ui.rag', '控制检索回到初始线索的概率')"
                    :min="0"
                    :max="1"
                    :step="0.05"
                    :disabled="!config.advanced.enableSaPpr"
                  />
                  <RagNumberControl
                    id="rag-score"
                    v-model="config.advanced.minScore"
                    :label="t('ui.rag', '最低分数')"
                    :description="t('ui.rag', '过滤低于此分数的候选记忆')"
                    :min="-1"
                    :max="1"
                    :step="0.05"
                    :disabled="!config.advanced.enableSaPpr"
                  />
                </div>
                <div class="rag-extension-list">
                  <h4>{{ t('ui.rag', '检索增强') }}</h4>
                  <div
                    v-for="option in extensions"
                    :key="option.key"
                    class="rag-switch-row"
                    :class="{
                      'is-disabled':
                        !config.advanced.enableSaPpr ||
                        (option.key === 'enableFeedback' && !config.advanced.enableContextRnn),
                    }"
                  >
                    <div class="rag-row-copy">
                      <label :id="`rag-option-${option.key}`">
                        {{ option.label }}
                        <span v-if="option.tag" class="rag-tag">{{ option.tag }}</span>
                      </label>
                      <p>{{ option.description }}</p>
                      <small
                        v-if="option.key === 'enableFeedback' && !config.advanced.enableContextRnn"
                      >
                        {{ t('ui.rag', '需先开启对话轨迹') }}
                      </small>
                    </div>
                    <PSwitch
                      v-model="config.advanced[option.key]"
                      :aria-labelledby="`rag-option-${option.key}`"
                      :disabled="
                        !config.advanced.enableSaPpr ||
                        (option.key === 'enableFeedback' && !config.advanced.enableContextRnn)
                      "
                    />
                  </div>
                </div>
              </fieldset>
            </template>
          </fieldset>
        </div>
      </div>
    </div>
    <PDialog
      v-model="confirmLeave"
      :title="t('ui.rag', '放弃未保存的修改？')"
      :message="t('ui.rag', '离开会丢弃未保存的修改。')"
      :confirm-text="t('ui.rag', '放弃修改')"
      :cancel-text="t('ui.rag', '继续编辑')"
      confirm-variant="danger"
      @confirm="emit('back')"
    />
  </section>
</template>

<style scoped src="./rag-config.css"></style>
