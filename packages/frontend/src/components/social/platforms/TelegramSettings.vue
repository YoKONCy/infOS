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
const fullGroupMessages = ref(false)
async function addBot() {
  if (!token.value.trim()) return
  if (
    await action('account_add', {
      token: token.value.trim(),
      fullGroupMessages: fullGroupMessages.value,
    })
  )
    token.value = ''
}
onUnmounted(() => {
  token.value = ''
})
</script>
<template>
  <div class="sp-platform-layout">
    <div class="sp-platform-main">
      <section class="sp-platform-card">
        <header class="sp-platform-card-head">
          <div>
            <h3>{{ t('ui.social', '连接 Telegram Bot') }}</h3>
            <p>{{ t('ui.social', '在 @BotFather 创建机器人，使用 Token 连接。') }}</p>
          </div>
          <span class="sp-platform-tag">Bot API</span>
        </header>
        <ol class="sp-platform-steps">
          <li>{{ t('ui.social', '向 @BotFather 发送 /newbot 创建机器人') }}</li>
          <li>{{ t('ui.social', '粘贴 Token；添加已有账号会更新其凭据和群聊设置') }}</li>
          <li>{{ t('ui.social', '私聊先向机器人发送 /start，群聊则将机器人加入群组') }}</li>
        </ol>
        <PButton v-if="!connection" :loading="enabling" @click="emit('enable')">
          {{ t('ui.social', '启用 Telegram') }}
        </PButton>
        <form v-else class="sp-platform-form" @submit.prevent="addBot">
          <label for="telegram-token">{{ t('ui.social', 'Telegram Bot Token') }}</label>
          <div class="sp-platform-input-row">
            <input
              id="telegram-token"
              v-model="token"
              class="sp-platform-input"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              :disabled="busy"
            />
            <PButton type="submit" :loading="busy" :disabled="!token.trim()">
              {{ t('ui.social', '添加或更新 Bot') }}
            </PButton>
          </div>
          <section class="sp-platform-permission">
            <div class="sp-platform-switch">
              <div>
                <strong>{{ t('ui.social', '群聊主动观察') }}</strong>
                <p>{{ t('ui.social', '已关闭 Group Privacy 或已授予机器人群管理员权限') }}</p>
              </div>
              <PSwitch
                v-model="fullGroupMessages"
                :disabled="busy"
                :aria-label="t('ui.social', '群聊主动观察')"
              />
            </div>
            <p>
              {{
                t(
                  'ui.social',
                  '仅在完成 Telegram 群权限配置后开启；未开启时仍可处理私聊与群内提及。',
                )
              }}
            </p>
          </section>
          <p class="sp-platform-footnote">
            {{ t('ui.social', '同一 Token 只能由一个服务接收更新，请先停止其他消费者。') }}
          </p>
        </form>
        <p v-if="error" class="sp-platform-error" role="alert">{{ error }}</p>
      </section>
      <PlatformAccountList
        :accounts="snapshot.accounts"
        :busy="busy"
        :loading="loading"
        :group-label="t('ui.social', '群聊主动观察')"
        @action="action"
      />
    </div>
    <aside class="sp-platform-side">
      <section class="sp-platform-card sp-platform-guide">
        <h3>{{ t('ui.social', '群组与话题') }}</h3>
        <p>
          {{ t('ui.social', '支持私聊、群组和论坛话题；群消息读取范围由 Telegram 权限决定。') }}
        </p>
        <dl>
          <dt>Group Privacy</dt>
          <dd>{{ t('ui.social', '在 @BotFather 的 /setprivacy 中配置') }}</dd>
          <dt>{{ t('ui.social', '论坛话题') }}</dt>
          <dd>{{ t('ui.social', '回复保留原话题，无需另建连接') }}</dd>
        </dl>
      </section>
      <PlatformOwnerSettings
        v-if="connection"
        :connection="connection"
        :label="t('ui.social', '主人 Telegram User ID')"
        :hint="t('ui.social', '填写数字 User ID，用于识别主人；不使用 @用户名。')"
        @changed="emit('changed')"
      />
    </aside>
  </div>
</template>
<style scoped src="./platformSettings.css"></style>
