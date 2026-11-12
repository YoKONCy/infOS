<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { DesktopHomeSection } from '@infos/shared'
import { t } from '../../i18n'
import { useDesktopHome } from '../../composables/useDesktopHome'
import { takePerceptionReveal, perceptionRevealRequest } from '../../composables/usePerception'
import { PixelIcon } from '../pixel'
import DesktopControlSettings from './DesktopControlSettings.vue'
import DesktopSafetySettings from './DesktopSafetySettings.vue'
import HomeOverview from './home/HomeOverview.vue'
import HomeSafetySettings from './home/HomeSafetySettings.vue'
import HomeScopePicker from './home/HomeScopePicker.vue'
import HomeTrust from './home/HomeTrust.vue'
import { useHomeScope } from './home/useHomeScope'
import HomeShelfPanel from './HomeShelfPanel.vue'
import HomeMapPanel from './HomeMapPanel.vue'
import DesktopHomePerception from './perception/DesktopHomePerception.vue'

/** 桌面与家独立工作台，原生设备偏好与后端共享空间各自持有数据。 */
type HomeSection = 'desktop' | 'perception' | 'belongings' | 'trust' | 'safety'
const home = useDesktopHome()
const { settings, status, error } = home
const scope = useHomeScope()
const local = computed(() => home.supported ? settings.value : null)
const content = ref<HTMLElement | null>(null)
const activeSection = ref<HomeSection>(home.supported ? 'desktop' : 'belongings')
const sections = computed(() => [
  ...(home.supported ? [
    {
      id: 'desktop' as const,
      icon: 'desktop',
      title: t('ui.desktop', '桌面操作'),
      hint: t('ui.desktop', '控制总开关、停止快捷键与当前操作状态。'),
    },
    {
      id: 'perception' as const,
      icon: 'eye',
      title: t('ui.desktop', '感知与陪伴'),
      hint: t('ui.desktop', '设置看屏幕、听声音、主动开口与陪看。'),
    },
  ] : []),
  {
    id: 'belongings' as const,
    icon: 'archive',
    title: t('ui.desktop', '共享空间'),
    hint: t('ui.desktop', '交换物品，管理角色记住的地点。'),
  },
  {
    id: 'trust' as const,
    icon: 'list',
    title: t('ui.desktop', '授权与记录'),
    hint: t('ui.desktop', '查看授权、文件改动、活动记录与回收区。'),
  },
  {
    id: 'safety' as const,
    icon: 'shield',
    title: t('ui.desktop', '保护设置'),
    hint: t('ui.desktop', '设置程序保护、文件安全与记录保留。'),
  },
])
const current = computed(() => sections.value.find((item) => item.id === activeSection.value)!)
const scopedSection = computed(() => ['belongings', 'trust'].includes(activeSection.value))

function selectSection(id: HomeSection): void {
  activeSection.value = id
  content.value?.scrollTo({ top: 0 })
}
watch(perceptionRevealRequest, () => {
  if (home.supported && takePerceptionReveal()) selectSection('perception')
}, { immediate: true, flush: 'post' })

const savedKey = ref('')
let savedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(savedTimer))
async function save(section: DesktopHomeSection, patch: Record<string, unknown>): Promise<void> {
  await home.update(section, patch as never)
  if (error.value) return
  clearTimeout(savedTimer)
  savedKey.value = `${section}.${Object.keys(patch)[0] ?? ''}`
  savedTimer = setTimeout(() => (savedKey.value = ''), 1600)
}
</script>

<template>
  <div class="desktop-home-page">
    <header class="desktop-home-heading">
      <span class="desktop-home-emblem" aria-hidden="true"><PixelIcon name="home" size="lg" /></span>
      <div>
        <h1>{{ t('ui.desktop', '桌面与家') }}</h1>
        <p>{{ t('ui.desktop', '管理桌面权限、感知与共享空间。') }}</p>
      </div>
    </header>
    <HomeOverview
      :supported="home.supported"
      :settings="local"
      :status="status"
      :error="error"
      @stop="home.stopListening()"
      @desktop="selectSection('desktop')"
    />
    <p v-if="error" role="alert" class="desktop-home-error">{{ error }}</p>

    <div class="desktop-home-layout">
      <nav class="desktop-home-nav" :aria-label="t('ui.desktop', '功能分区')">
        <button
          v-for="(section, index) in sections"
          :id="`home-section-${section.id}`"
          :key="section.id"
          type="button"
          :class="{ 'is-active': activeSection === section.id }"
          :aria-pressed="activeSection === section.id"
          :aria-controls="`home-panel-${section.id}`"
          @click="selectSection(section.id)"
        >
          <span class="desktop-home-nav__index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
          <PixelIcon :name="section.icon" size="sm" aria-hidden="true" />
          <span class="desktop-home-nav__label">{{ section.title }}</span>
        </button>
      </nav>

      <div ref="content" class="desktop-home-content">
        <header class="desktop-home-section-heading">
          <h2>{{ current.title }}</h2>
          <p>{{ current.hint }}</p>
        </header>
        <HomeScopePicker v-if="scopedSection" :state="scope" />

        <section
          v-if="activeSection === 'desktop' && home.supported"
          id="home-panel-desktop"
          aria-labelledby="home-section-desktop"
        >
          <DesktopControlSettings />
        </section>
        <section
          v-else-if="activeSection === 'perception' && home.supported"
          id="home-panel-perception"
          aria-labelledby="home-section-perception"
        >
          <DesktopHomePerception
            v-if="local"
            :settings="local"
            :status="status"
            :saved-key="savedKey"
            @save="save"
            @model="home.model($event)"
            @stop="home.stopListening()"
          />
          <p v-else-if="!error" class="desktop-home-loading" role="status">{{ t('ui.desktop', '正在读取桌面设置…') }}</p>
        </section>
        <section
          v-else-if="activeSection === 'belongings'"
          id="home-panel-belongings"
          class="desktop-home-space"
          aria-labelledby="home-section-belongings"
        >
          <HomeShelfPanel :scope="scope.scope.value" />
          <HomeMapPanel :scope="scope.scope.value" />
        </section>
        <section
          v-else-if="activeSection === 'trust'"
          id="home-panel-trust"
          aria-labelledby="home-section-trust"
        >
          <HomeTrust :agent-id="scope.agentId.value" :scope="scope.scope.value" />
        </section>
        <section
          v-else-if="activeSection === 'safety'"
          id="home-panel-safety"
          aria-labelledby="home-section-safety"
        >
          <DesktopSafetySettings v-if="home.supported" />
          <h3 v-if="home.supported" class="desktop-home-subheading">{{ t('ui.desktop', '文件与记录') }}</h3>
          <HomeSafetySettings />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped src="./desktop-home-page.css"></style>
