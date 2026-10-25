<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref } from 'vue'
import { INTEGRATION_PROVIDERS, type IntegrationFeature } from '@infos/shared'
import { PCard, PButton, PixelIcon } from '../pixel'
import McpTab from '../dashboard/tabs/McpTab.vue'
import ExtensionToolsPane from './ExtensionToolsPane.vue'
import FeatureSourcesPage from './FeatureSourcesPage.vue'
import IntegrationBrand from './IntegrationBrand.vue'
import PackageManagerPane from './PackageManagerPane.vue'
import ResourceVersionsPane from './ResourceVersionsPane.vue'
import { useIntegrations } from '../../composables/tools/useIntegrations'

const { state, error } = useIntegrations()
const tab = ref<'extensions' | 'features' | 'mcp' | 'skills' | 'packages' | 'versions'>(
  'extensions',
)
const page = ref<IntegrationFeature | null>(null)
const tabs = [
  {
    id: 'versions',
    get label() {
      return __t('ui.resource-versions', '资源版本')
    },
  },
  {
    id: 'packages',
    get label() {
      return __t('ui.packages', '插件')
    },
  },
  {
    id: 'extensions',
    get label() {
      return __t('ui.integrations', '扩展工具')
    },
  },
  {
    id: 'features',
    get label() {
      return __t('ui.integrations', '拓展功能')
    },
  },
  {
    id: 'mcp',
    get label() {
      return __t('ui.integrations', 'MCP 服务')
    },
  },
  {
    id: 'skills',
    get label() {
      return __t('ui.integrations', '技能')
    },
  },
] as const
const searchLogo = computed(() => {
  const feature = state.value?.features.search
  const source = feature?.sources.find((item) => item.id === feature.selectedSourceId)
  return INTEGRATION_PROVIDERS.find((item) => item.id === source?.provider)?.logo
})
const pdfLogo = computed(() => {
  const feature = state.value?.features.pdf
  const source = feature?.sources.find((item) => item.id === feature.selectedSourceId)
  return INTEGRATION_PROVIDERS.find((item) => item.id === source?.provider)?.logo
})
</script>
<template>
  <div class="integrations-page">
    <header class="integration-heading">
      <PixelIcon name="terminal" size="lg" />
      <div>
        <h1>{{ __t('ui.integrations', '工具与扩展') }}</h1>
        <p>TOOLS & EXTENSIONS</p>
      </div>
    </header>
    <nav class="integration-tabs" :aria-label="__t('ui.integrations', '工具与扩展分类')">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        :class="{ active: tab === item.id }"
        :aria-current="tab === item.id ? 'page' : undefined"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </nav>
    <p v-if="error" class="integration-error" role="status">{{ error }}</p>
    <div class="integration-content">
      <ExtensionToolsPane v-if="tab === 'extensions'" />
      <PackageManagerPane v-else-if="tab === 'packages'" />
      <ResourceVersionsPane v-else-if="tab === 'versions'" />
      <template v-else-if="tab === 'features'">
        <FeatureSourcesPage v-if="page" :key="page" :kind="page" @back="page = null" />
        <section v-else>
          <div class="integration-section-heading">
            <h2>{{ __t('ui.integrations', '拓展功能') }}</h2>
          </div>
          <div class="integration-grid">
            <PCard pixel padding="lg" class="integration-market-card">
              <div class="integration-card-heading">
                <IntegrationBrand :brand="searchLogo" fallback="search" />
                <div>
                  <h3>{{ __t('ui.integrations', '联网搜索') }}</h3>
                  <span class="integration-publisher">
                    {{ __t('ui.integrations', '搜索来源') }}
                  </span>
                </div>
              </div>
              <p class="integration-description">
                {{ __t('ui.integrations', '选择搜索服务，让助手查找网页与相关信息。') }}
              </p>
              <div class="integration-card-foot">
                <span
                  class="integration-state"
                  :class="{ 'integration-state--ready': state?.features.search.ready }"
                >
                  {{
                    state?.features.search.ready
                      ? __t('ui.integrations', '已启用')
                      : __t('ui.integrations', '未启用')
                  }}
                </span>
                <PButton type="button" variant="secondary" size="sm" @click="page = 'search'">
                  {{ __t('ui.integrations', '管理来源') }}
                  <PixelIcon name="chevron-right" size="xs" />
                </PButton>
              </div>
            </PCard>
            <PCard pixel padding="lg" class="integration-market-card">
              <div class="integration-card-heading">
                <IntegrationBrand :brand="pdfLogo" fallback="file" />
                <div>
                  <h3>{{ __t('ui.integrations', 'PDF 解析') }}</h3>
                  <span class="integration-publisher">
                    {{ __t('ui.integrations', '附件输入') }}
                  </span>
                </div>
              </div>
              <p class="integration-description">
                {{ __t('ui.integrations', '配置解析来源，上传 PDF 后自动提取文字。') }}
              </p>
              <div class="integration-card-foot">
                <span
                  class="integration-state"
                  :class="{ 'integration-state--ready': state?.features.pdf.ready }"
                >
                  {{
                    state?.features.pdf.ready
                      ? __t('ui.integrations', '上传已开启')
                      : __t('ui.integrations', '未启用')
                  }}
                </span>
                <PButton type="button" variant="secondary" size="sm" @click="page = 'pdf'">
                  {{ __t('ui.integrations', '管理来源') }}
                  <PixelIcon name="chevron-right" size="xs" />
                </PButton>
              </div>
            </PCard>
          </div>
        </section>
      </template>
      <McpTab v-else embedded :section="tab === 'skills' ? 'skill' : 'mcp'" />
    </div>
  </div>
</template>
<style src="./integrations.css" />
