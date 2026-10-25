<script setup lang="ts">
import { ref } from 'vue'
import { PButton, PixelIcon } from '../../pixel'
import type { SocialManagementSnapshot } from '../../../api/modules/socialApi'
import { t } from '../../../i18n'
defineProps<{
  accounts: SocialManagementSnapshot['accounts']
  busy: boolean
  loading: boolean
  groupLabel?: string
}>()
const emit = defineEmits<{ action: [name: string, input: Record<string, unknown>] }>()
const removing = ref('')
function confirmRemove(accountId: string) {
  emit('action', 'account_remove', { accountId })
  removing.value = ''
}
</script>
<template>
  <section class="sp-platform-card sp-account-list">
    <header class="sp-platform-card-head">
      <div>
        <h3>{{ t('ui.social', '已连接账号') }}</h3>
        <p>{{ t('ui.social', '账号凭据仅保存在后端私有存储。') }}</p>
      </div>
      <span class="sp-account-count">{{ accounts.length }}</span>
    </header>
    <div v-if="loading" class="sp-account-empty" role="status">{{ t('ui.social', '加载中…') }}</div>
    <div v-else-if="!accounts.length" class="sp-account-empty">
      <PixelIcon name="user" size="md" />
      <p>{{ t('ui.social', '尚未添加账号') }}</p>
    </div>
    <article v-for="account in accounts" :key="account.id" class="sp-account-row">
      <div class="sp-account-identity">
        <strong>{{ account.name }}</strong>
        <code>{{ account.id }}</code>
      </div>
      <span class="sp-account-state" :class="{ 'is-online': account.connected }">
        <i />
        {{ account.connected ? t('ui.social', '已连接') : t('ui.social', '未连接') }}
      </span>
      <p v-if="groupLabel" class="sp-account-permission">
        {{ groupLabel }} ·
        {{ account.fullGroupMessages ? t('ui.social', '已开启') : t('ui.social', '未开启') }}
      </p>
      <p v-if="account.error" class="sp-platform-error" role="alert">
        {{ t('errors.social', account.error) }}
      </p>
      <div class="sp-account-actions">
        <PButton
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="emit('action', 'account_reconnect', { accountId: account.id })"
        >
          {{ t('ui.social', '重新连接') }}
        </PButton>
        <template v-if="removing === account.id">
          <PButton size="sm" variant="danger" :disabled="busy" @click="confirmRemove(account.id)">
            {{ t('ui.social', '确认移除账号') }}
          </PButton>
          <PButton size="sm" variant="ghost" :disabled="busy" @click="removing = ''">
            {{ t('ui.social', '取消') }}
          </PButton>
        </template>
        <PButton v-else size="sm" variant="ghost" :disabled="busy" @click="removing = account.id">
          {{ t('ui.social', '移除') }}
        </PButton>
      </div>
    </article>
  </section>
</template>
<style scoped src="./platformSettings.css"></style>
