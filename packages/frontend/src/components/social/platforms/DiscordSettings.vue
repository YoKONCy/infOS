<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { PButton, PSwitch } from '../../pixel'
import type { SocialConnection } from '../../../api/modules/socialApi'
import { usePlatformAccounts } from '../../../composables/social/usePlatformAccounts'
import { t } from '../../../i18n'
import PlatformAccountList from './PlatformAccountList.vue'
import PlatformOwnerSettings from './PlatformOwnerSettings.vue'
const props = defineProps<{ connection?: SocialConnection; enabling: boolean }>()
const emit = defineEmits<{ enable: []; changed: [] }>()
const { snapshot, busy, loading, error, action } = usePlatformAccounts(
  () => props.connection,
  () => emit('changed'),
)
const token = ref('')
const messageContent = ref(false)
async function addBot() {
  if (!token.value.trim()) return
  if (
    await action('account_add', {
      token: token.value.trim(),
      fullGroupMessages: messageContent.value,
    })
  )
    token.value = ''
}
onUnmounted(() => {
  token.value = ''
})
</script>
<template>
  <div class="sp-platform-layout sp-discord-layout">
    <div class="sp-platform-main">
      <section class="sp-platform-card">
        <header class="sp-platform-card-head">
          <div>
            <h3>{{ t('ui.social', '连接 Discord Bot') }}</h3>
            <p>{{ t('ui.social', '使用 Developer Portal 中的 Bot Token，通过 Gateway 连接。') }}</p>
          </div>
          <span class="sp-platform-tag">Gateway</span>
        </header>
        <form v-if="connection" class="sp-platform-form" @submit.prevent="addBot">
          <label for="discord-token">{{ t('ui.social', 'Discord Bot Token') }}</label>
          <input
            id="discord-token"
            v-model="token"
            class="sp-platform-input"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            :disabled="busy"
          />
          <section class="sp-platform-permission">
            <div class="sp-platform-switch">
              <div>
                <strong>Message Content Intent</strong>
                <p>{{ t('ui.social', '已在 Developer Portal → Bot 中开启消息内容权限') }}</p>
              </div>
              <PSwitch
                v-model="messageContent"
                :disabled="busy"
                aria-label="Message Content Intent"
              />
            </div>
            <p>
              {{
                t(
                  'ui.social',
                  '开启后请求消息内容 Intent 并允许频道主动观察；仍需服务器和频道授权。',
                )
              }}
            </p>
          </section>
          <div class="sp-platform-actions">
            <PButton type="submit" :loading="busy" :disabled="!token.trim()">
              {{ t('ui.social', '添加或更新 Bot') }}
            </PButton>
            <span class="sp-platform-footnote">
              {{ t('ui.social', '更新权限或凭据时，重新提交该 Bot 的 Token。') }}
            </span>
          </div>
        </form>
        <PButton v-else :loading="enabling" @click="emit('enable')">
          {{ t('ui.social', '启用 Discord') }}
        </PButton>
        <p v-if="error" class="sp-platform-error" role="alert">{{ error }}</p>
      </section>
      <PlatformAccountList
        :accounts="snapshot.accounts"
        :busy="busy"
        :loading="loading"
        group-label="Message Content Intent"
        @action="action"
      />
    </div>
    <aside class="sp-platform-side">
      <section class="sp-platform-card sp-platform-guide">
        <h3>{{ t('ui.social', '服务器与频道授权') }}</h3>
        <ol class="sp-platform-steps">
          <li>{{ t('ui.social', '在 Developer Portal 创建应用并添加 Bot') }}</li>
          <li>{{ t('ui.social', '通过 OAuth2 的 bot scope 将机器人邀请到服务器') }}</li>
          <li>{{ t('ui.social', '授予查看频道、读取历史、发送消息与附件权限') }}</li>
        </ol>
        <p>{{ t('ui.social', '支持私聊、文字频道与线程；线程内发送还需对应线程权限。') }}</p>
      </section>
      <PlatformOwnerSettings
        v-if="connection"
        :connection="connection"
        :label="t('ui.social', '主人 Discord User ID')"
        :hint="t('ui.social', '开启 Discord 开发者模式后复制用户 ID；不使用显示名称。')"
        @changed="emit('changed')"
      />
    </aside>
  </div>
</template>
<style scoped src="./platformSettings.css"></style>
