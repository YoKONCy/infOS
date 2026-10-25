<script setup lang="ts">
import { PButton } from '../../pixel'
import type { SocialConnection } from '../../../api/modules/socialApi'
import { t } from '../../../i18n'
import NapcatSettings from './NapcatSettings.vue'
import PlatformOwnerSettings from './PlatformOwnerSettings.vue'
defineProps<{ connection?: SocialConnection; enabling: boolean }>()
const emit = defineEmits<{ enable: []; changed: [] }>()
</script>
<template>
  <section class="sp-qq-settings">
    <template v-if="connection">
      <NapcatSettings />
      <div class="sp-qq-owner">
        <PlatformOwnerSettings
          :connection="connection"
          :label="t('ui.social', '主人 QQ 号')"
          :hint="t('ui.settings', '用于识别主人；删除好友、修改设置等操作仅向主人开放。')"
          @changed="emit('changed')"
        />
      </div>
    </template>
    <section v-else class="sp-platform-card sp-qq-intro">
      <h3>{{ t('ui.social', '连接 QQ') }}</h3>
      <p>
        {{ t('ui.social', '通过 NapCat 登录 QQ；进程管理、登录验证与运行日志在此平台内完成。') }}
      </p>
      <PButton :loading="enabling" @click="emit('enable')">{{ t('ui.social', '启用 QQ') }}</PButton>
    </section>
  </section>
</template>
<style scoped src="./platformSettings.css"></style>
