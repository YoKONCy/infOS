<script setup lang="ts">
import { ref } from 'vue'
import { t as __t } from '../../i18n/index'
import { useDesktopHome } from '../../composables/useDesktopHome'
import { PixelIcon } from '../pixel'
import DesktopControlSettings from './DesktopControlSettings.vue'
import DesktopSafetySettings from './DesktopSafetySettings.vue'
import HomeSafetySettings from './home/HomeSafetySettings.vue'
import HomeScopePicker from './home/HomeScopePicker.vue'
import HomeTrust from './home/HomeTrust.vue'
import { useHomeScope } from './home/useHomeScope'

/**
 * DesktopSecuritySettingsTab — 桌面权限与安全设置页
 *
 * 将桌面操作开关、程序名单、文件安全与授权活动记录用轻量双标签收拢，
 * 非激活子面板通过 v-if 卸载，消除第三层竖向侧边栏套娃。
 */
defineOptions({ name: 'DesktopSecuritySettingsTab' })

const home = useDesktopHome()
const scope = useHomeScope()
const activeTab = ref<'rules' | 'trust'>('rules')
</script>

<template>
  <div class="desktop-security-page p-8">
    <header class="desktop-security-header">
      <div class="desktop-security-brand">
        <PixelIcon name="shield" size="md" class="desktop-security-icon" />
        <div>
          <h2>{{ __t('ui.navigation', '桌面权限与安全') }}</h2>
          <p>{{ __t('ui.desktop', '管理桌面操作权限、程序保护名单与授权记录。') }}</p>
        </div>
      </div>

      <nav class="desktop-security-tabs" :aria-label="__t('ui.navigation', '桌面权限与安全')">
        <button
          type="button"
          class="desktop-security-tab"
          :class="{ 'is-active': activeTab === 'rules' }"
          :aria-current="activeTab === 'rules' ? 'page' : undefined"
          @click="activeTab = 'rules'"
        >
          <PixelIcon name="shield" size="xs" />
          <span>{{ __t('ui.desktop', '权限与保护规则') }}</span>
        </button>
        <button
          type="button"
          class="desktop-security-tab"
          :class="{ 'is-active': activeTab === 'trust' }"
          :aria-current="activeTab === 'trust' ? 'page' : undefined"
          @click="activeTab = 'trust'"
        >
          <PixelIcon name="list" size="xs" />
          <span>{{ __t('ui.desktop', '授权与记录') }}</span>
        </button>
      </nav>
    </header>

    <div v-if="activeTab === 'rules'" class="desktop-security-body">
      <section v-if="home.supported" class="desktop-security-card">
        <h3 class="desktop-security-card-title">{{ __t('ui.desktop', '桌面操作') }}</h3>
        <DesktopControlSettings />
      </section>

      <section v-if="home.supported" class="desktop-security-card">
        <DesktopSafetySettings />
      </section>

      <section class="desktop-security-card">
        <h3 class="desktop-security-card-title">{{ __t('ui.desktop', '文件与记录保护') }}</h3>
        <HomeSafetySettings />
      </section>
    </div>

    <div v-else class="desktop-security-body">
      <section class="desktop-security-card">
        <HomeScopePicker :state="scope" />
        <HomeTrust :agent-id="scope.agentId.value" :scope="scope.scope.value" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.desktop-security-page {
  max-width: 1080px;
  margin: 0 auto;
  color: var(--ui-text-primary);
}

.desktop-security-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.desktop-security-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.desktop-security-icon {
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

[data-theme='dark'] .desktop-security-icon {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 36%, var(--ui-border-default));
  border-left-color: var(--ui-accent-purple);
  background: var(--ui-accent-purple-soft);
  color: var(--ui-accent-purple);
}

.desktop-security-brand h2 {
  margin: 0;
  font-family: var(--ui-font-pixel);
  font-size: 20px;
  line-height: 1.4;
}

.desktop-security-brand p {
  margin: 4px 0 0;
  color: var(--ui-text-secondary);
  font-size: 12px;
}

/* 与主工作台一致的反圆角像素分段栏 */
.desktop-security-tabs {
  display: inline-flex;
  align-items: stretch;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ui-border-default);
  border-radius: 2px;
  background: color-mix(in srgb, var(--ui-bg-canvas) 62%, var(--ui-bg-surface-soft));
}

.desktop-security-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 13px;
  border: 1px solid transparent;
  border-radius: 1px;
  background: transparent;
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-pixel);
  font-size: 12px;
  cursor: pointer;
  transition:
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard),
    color var(--ui-duration-fast) var(--ui-ease-standard),
    box-shadow var(--ui-duration-fast) var(--ui-ease-standard);
}

.desktop-security-tab:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-text-primary);
}

.desktop-security-tab.is-active {
  border-color: color-mix(in srgb, var(--ui-accent-primary) 34%, var(--ui-border-default));
  background: var(--ui-bg-surface);
  color: var(--ui-accent-primary);
  box-shadow: inset 0 -2px 0 var(--ui-accent-primary);
}

[data-theme='dark'] .desktop-security-tab.is-active {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 40%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-accent-purple) 14%, var(--ui-bg-elevated));
  color: var(--ui-accent-purple);
  box-shadow: inset 0 -2px 0 var(--ui-accent-purple);
}

.desktop-security-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.desktop-security-card {
  padding: 18px 22px;
  border: 1px solid var(--ui-border-default);
  background: var(--dash-panel-bg, var(--ui-bg-surface));
}

.desktop-security-card-title {
  margin: 0 0 10px;
  font-family: var(--ui-font-pixel);
  font-size: 13px;
  line-height: 1.5;
}
</style>
