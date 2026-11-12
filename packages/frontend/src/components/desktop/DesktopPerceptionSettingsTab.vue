<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { DesktopHomeSection } from '@infos/shared'
import { t as __t } from '../../i18n/index'
import { useDesktopHome } from '../../composables/useDesktopHome'
import { useMainNav } from '../../composables/main/useMainNav'
import { PixelIcon } from '../pixel'
import PetControlSettings from '../pet/PetControlSettings.vue'
import HomeOverview from './home/HomeOverview.vue'
import DesktopHomePerception from './perception/DesktopHomePerception.vue'

/**
 * DesktopPerceptionSettingsTab — 感知与桌宠设置页
 *
 * 集中管理桌宠语音/全局快捷键与桌面感知（看屏幕、听声音、主动开口、陪看），
 * 扁平呈现，不再嵌套第三层竖向侧边栏。
 */
defineOptions({ name: 'DesktopPerceptionSettingsTab' })

const home = useDesktopHome()
const { settings, status, error } = home
const { openSettings } = useMainNav()
const local = computed(() => (home.supported ? settings.value : null))

const savedKey = ref('')
let savedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(savedTimer))

async function save(section: DesktopHomeSection, patch: Record<string, unknown>): Promise<void> {
  await home.update(section, patch as never)
  if (error.value) return
  clearTimeout(savedTimer)
  savedKey.value = `${section}.${Object.keys(patch)[0] ?? ''}`
  savedTimer = setTimeout(() => {
    savedKey.value = ''
  }, 1600)
}
</script>

<template>
  <div class="perception-pet-page p-8">
    <header class="perception-pet-header">
      <PixelIcon name="eye" size="md" class="perception-pet-icon" />
      <div>
        <h2>{{ __t('ui.navigation', '感知与桌宠') }}</h2>
        <p>{{ __t('ui.desktop', '管理桌宠语音快捷键，以及看屏幕、听声音与陪看设置。') }}</p>
      </div>
    </header>

    <HomeOverview
      v-if="home.supported"
      class="perception-pet-overview"
      :supported="home.supported"
      :settings="local"
      :status="status"
      :error="error"
      @stop="home.stopListening()"
      @desktop="openSettings('desktop_security')"
    />
    <p v-if="error" role="alert" class="perception-pet-error">{{ error }}</p>

    <div class="perception-pet-body">
      <PetControlSettings />

      <section v-if="home.supported" class="perception-pet-card">
        <header class="perception-pet-section-head">
          <h3>{{ __t('ui.desktop', '桌面感知与陪伴') }}</h3>
          <p>{{ __t('ui.desktop', '设置看屏幕、听声音、主动开口与视频陪看。') }}</p>
        </header>
        <DesktopHomePerception
          v-if="local"
          :settings="local"
          :status="status"
          :saved-key="savedKey"
          @save="save"
          @model="home.model($event)"
          @stop="home.stopListening()"
        />
        <p v-else-if="!error" class="perception-pet-loading" role="status">
          {{ __t('ui.desktop', '正在读取桌面设置…') }}
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.perception-pet-page {
  container: desktop-home / inline-size;
  max-width: 1080px;
  margin: 0 auto;
  color: var(--ui-text-primary);
}

.perception-pet-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.perception-pet-icon {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 32%, var(--ui-border-default));
  border-left: 3px solid var(--ui-accent-primary);
  border-radius: 2px;
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
}

[data-theme='dark'] .perception-pet-icon {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 36%, var(--ui-border-default));
  border-left-color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}

.perception-pet-header h2 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  line-height: 1.4;
}

.perception-pet-header p {
  margin: 4px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}

.perception-pet-overview {
  margin: 0 0 20px !important;
}

.perception-pet-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.perception-pet-card {
  container: desktop-home-content / inline-size;
  padding: 20px 22px;
  border: 1px solid var(--ui-border-default);
  background: var(--dash-panel-bg, var(--ui-bg-surface));
}

.perception-pet-card :deep(.perception-sub) {
  display: flex;
  align-items: center;
  margin-top: 22px;
  padding: 8px 11px;
  border: 1px solid var(--ui-border-subtle);
  border-left: 2px solid var(--ui-accent-primary);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-primary);
  font: 700 12.5px/1.4 var(--ui-font-pixel);
}

[data-theme='dark'] .perception-pet-card :deep(.perception-sub) {
  border-left-color: var(--ui-accent-purple);
}

.perception-pet-section-head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ui-border-subtle);
}

.perception-pet-section-head h3 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 14px;
  line-height: 1.4;
}

.perception-pet-section-head p {
  margin: 4px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}

.perception-pet-error {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-left: 3px solid var(--ui-danger);
  background: var(--ui-danger-soft);
  font-size: 12px;
}

.perception-pet-loading {
  color: var(--ui-text-tertiary);
  font-size: 12px;
}
</style>
