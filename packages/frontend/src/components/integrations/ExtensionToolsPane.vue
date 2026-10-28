<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref } from 'vue'
import type { ExtensionToolId } from '@infos/shared'
import { PCard, PButton, PDialog, PInput, PInputNumber, PSwitch } from '../pixel'
import IntegrationBrand from './IntegrationBrand.vue'
import { useIntegrations } from '../../composables/tools/useIntegrations'

const { state, busy, updateExtension } = useIntegrations()
const props = defineProps<{ packageId?: string }>()
const extensions: Array<{
  id: ExtensionToolId
  name: string
  description: string
  tool: string
  url: string
}> = [
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    get description() {
      return __t('ui.integrations', '读懂代码仓库，查找文档与实现说明。')
    },
    tool: '查询代码仓库',
    url: 'https://deepwiki.com',
  },
  {
    id: 'sciverse',
    name: 'Sciverse.space',
    get description() {
      return __t('ui.integrations', '查找学术文献与可追溯的原文证据。')
    },
    tool: '检索学术资料',
    url: 'https://sciverse.space',
  },
]
const visibleExtensions = computed(() =>
  props.packageId
    ? extensions.filter((item) => props.packageId === `infos.extension.${item.id}`)
    : extensions,
)
const selected = ref<ExtensionToolId | null>(null)
const dialog = ref(false)
const form = ref({
  enabled: false,
  chatEnabled: false,
  endpoint: '',
  apiKey: '',
  clearApiKey: false,
  maxResults: 5,
})
function open(id: ExtensionToolId): void {
  const value = state.value?.extensions[id]
  if (!value) return
  selected.value = id
  form.value = {
    enabled: value.enabled,
    chatEnabled: value.chatEnabled,
    endpoint: value.endpoint,
    apiKey: '',
    clearApiKey: false,
    maxResults: value.maxResults,
  }
  dialog.value = true
}
async function save(): Promise<void> {
  if (selected.value && (await updateExtension(selected.value, form.value))) dialog.value = false
}
</script>
<template>
  <section>
    <div class="integration-section-heading">
      <h2>{{ __t('ui.integrations', '官方扩展') }}</h2>
      <span>{{ __t('ui.integrations', 'infOS 自带') }}</span>
    </div>
    <div class="integration-grid">
      <PCard
        v-for="extension in visibleExtensions"
        :key="extension.id"
        pixel
        padding="lg"
        class="integration-market-card"
      >
        <div class="integration-card-heading">
          <IntegrationBrand :brand="extension.id" />
          <div>
            <h3>{{ extension.name }}</h3>
            <span class="integration-publisher">
              {{ __t('ui.integrations', 'infOS 官方适配') }}
            </span>
          </div>
        </div>
        <p class="integration-description">{{ extension.description }}</p>
        <div class="integration-card-foot">
          <span
            class="integration-state"
            :class="{ 'integration-state--ready': state?.extensions[extension.id].ready }"
          >
            {{
              state?.extensions[extension.id].ready
                ? __t('ui.integrations', '已启用')
                : state?.extensions[extension.id].configured
                  ? __t('ui.integrations', '已停用')
                  : __t('ui.integrations', '待配置')
            }}
          </span>
          <PButton
            type="button"
            variant="secondary"
            size="sm"
            :disabled="busy || !state"
            @click="open(extension.id)"
          >
            {{ __t('ui.integrations', '配置') }}
          </PButton>
        </div>
      </PCard>
    </div>
    <PDialog
      v-model="dialog"
      :title="selected === 'deepwiki' ? 'DeepWiki' : 'Sciverse.space'"
      width="560px"
    >
      <div v-if="selected" class="integration-form">
        <div class="integration-dialog-brand">
          <IntegrationBrand :brand="selected" />
          <div>
            <strong>{{ extensions.find((item) => item.id === selected)?.tool }}</strong>
            <p>{{ __t('ui.integrations', '配置完整并启用后，加入 Agent 工具列表。') }}</p>
          </div>
        </div>
        <label>
          {{ __t('ui.integrations', '服务地址') }}
          <PInput v-model="form.endpoint" :disabled="busy" />
        </label>
        <template v-if="selected === 'sciverse'">
          <label>
            API Key
            <PInput
              v-model="form.apiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="
                state?.extensions.sciverse.hasApiKey
                  ? __t('ui.integrations', '已设置，留空保留')
                  : __t('ui.integrations', '输入 API Key')
              "
              :disabled="busy"
            />
          </label>
          <label v-if="state?.extensions.sciverse.hasApiKey" class="integration-switch">
            <span>{{ __t('ui.integrations', '清除已保存的 Key') }}</span>
            <PSwitch v-model="form.clearApiKey" :disabled="busy" />
          </label>
          <label>
            {{ __t('ui.integrations', '默认结果数') }}
            <PInputNumber
              :model-value="form.maxResults"
              :min="1"
              :max="20"
              :disabled="busy"
              @update:model-value="
                (value) => {
                  if (value !== null) form.maxResults = value
                }
              "
            />
          </label>
        </template>
        <label class="integration-switch">
          <span>{{ __t('ui.integrations', '启用扩展') }}</span>
          <PSwitch v-model="form.enabled" :disabled="busy" />
        </label>
        <label class="integration-switch">
          <span>{{ __t('ui.integrations', '聊天模式可用') }}</span>
          <PSwitch v-model="form.chatEnabled" :disabled="busy" />
        </label>
        <a
          :href="extensions.find((item) => item.id === selected)?.url"
          target="_blank"
          rel="noopener noreferrer"
          class="integration-doc-link"
        >
          {{ __t('ui.integrations', '前往官网') }}
        </a>
      </div>
      <template #footer>
        <PButton type="button" variant="ghost" :disabled="busy" @click="dialog = false">
          {{ __t('ui.integrations', '取消') }}
        </PButton>
        <PButton type="button" :loading="busy" @click="save">
          {{ __t('ui.integrations', '保存') }}
        </PButton>
      </template>
    </PDialog>
  </section>
</template>
