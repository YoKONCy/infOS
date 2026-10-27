<script setup lang="ts">
/**
 * @file 根组件
 * @description
 *
 * Electron 与 Docker/浏览器模式均由 MainView 承载综合面板，
 * 顶层缓存 MainView 以保留 Tab 状态和 Dashboard 上下文。
 */
import PToast from './components/notification/PToast.vue'
import PModal from './components/notification/PModal.vue'
import { computed, onMounted, watch } from 'vue'
import { useAchievements } from './composables/system/useAchievements'
import { applyLanguage } from './i18n'
import { configApi } from './api/modules/configApi'
import { LANGUAGE_CONFIG_KEY } from '@infos/shared/i18n'
import ClientPairing from './components/connection/ClientPairing.vue'
import { useClientSession } from './composables/system/useClientSession'
import { useMobileViewport } from './composables/ui/useMobileLayout'

const { session, check } = useClientSession()
useAchievements(computed(() => session.value.authenticated))
watch(
  () => session.value.authenticated,
  (authenticated) => {
    if (!authenticated) return
    void configApi
      .get<{ value: string | null }>(LANGUAGE_CONFIG_KEY)
      .then((response) => {
        if (session.value.authenticated && response.data?.value) applyLanguage(response.data.value)
      })
      .catch(() => {
        /* 连接恢复前保留本机语言 */
      })
  },
  { immediate: true },
)
onMounted(check)
useMobileViewport()

const keepAliveInclude = ['MainView']
</script>

<template>
  <ClientPairing v-if="!session.authenticated" />
  <router-view v-else v-slot="{ Component }">
    <keep-alive :include="keepAliveInclude" :max="2">
      <component :is="Component" />
    </keep-alive>
  </router-view>

  <!-- 全局通知 -->
  <PToast />
  <PModal />
</template>

<style>
/* 全局样式将在后续迁移时完善 */
</style>
