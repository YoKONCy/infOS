<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import qrcode from 'qrcode-generator'
import { PButton, PixelIcon } from '../../pixel'
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
const verification = ref('')
const qr = computed(() => {
  if (!snapshot.value.login?.qrText) return ''
  try {
    const code = qrcode(0, 'M')
    code.addData(snapshot.value.login.qrText)
    code.make()
    return code.createDataURL(5, 12)
  } catch {
    return ''
  }
})
const loginStatus = computed(() => {
  const labels: Record<string, string> = {
    wait: '等待扫码',
    scaned: '已扫码，等待确认',
    confirmed: '连接成功',
    expired: '二维码已过期，请重新获取',
    need_verifycode: '请输入微信显示的验证码',
    verify_code_blocked: '验证码尝试过多，请重新扫码',
    scaned_but_redirect: '正在切换登录服务',
    binded_redirect: '此账号已绑定，请查看账号列表',
  }
  return t('ui.social', labels[snapshot.value.login?.status ?? ''] ?? '等待扫码')
})
const canScan = computed(
  () =>
    !!qr.value &&
    ['wait', 'scaned', 'scaned_but_redirect', 'need_verifycode'].includes(
      snapshot.value.login?.status ?? '',
    ),
)
async function verify() {
  if (
    await action('login_verify', {
      loginId: snapshot.value.login?.id,
      code: verification.value.trim(),
    })
  )
    verification.value = ''
}
function startLogin() {
  verification.value = ''
  void action('login_start')
}
function cancelLogin() {
  verification.value = ''
  void action('login_cancel')
}
onUnmounted(() => {
  verification.value = ''
})
</script>
<template>
  <div class="sp-platform-layout sp-weixin-layout">
    <section class="sp-platform-card sp-weixin-login">
      <header class="sp-platform-card-head">
        <div>
          <h3>{{ t('ui.social', '扫码连接微信') }}</h3>
          <p>{{ t('ui.social', '通过微信 ClawBot 扫码连接，目前支持私聊。') }}</p>
        </div>
        <span class="sp-platform-tag">ClawBot / iLink</span>
      </header>
      <div class="sp-weixin-scan">
        <div class="sp-qr-frame" :class="{ 'is-inactive': !canScan }">
          <img
            v-if="canScan"
            :src="qr"
            :alt="t('ui.social', '微信登录二维码')"
            width="208"
            height="208"
          />
          <div v-else class="sp-qr-placeholder">
            <PixelIcon name="chat" size="lg" />
            <span>{{ snapshot.login ? loginStatus : t('ui.social', '获取二维码后扫码') }}</span>
          </div>
        </div>
        <div class="sp-weixin-instructions">
          <ol class="sp-platform-steps">
            <li>{{ t('ui.social', '获取登录二维码') }}</li>
            <li>{{ t('ui.social', '使用微信扫一扫，并在手机上确认') }}</li>
            <li>{{ t('ui.social', '连接后，在微信私聊中与角色交流') }}</li>
          </ol>
          <p v-if="snapshot.login" class="sp-login-status" role="status" aria-live="polite">
            {{ loginStatus }}
          </p>
          <div class="sp-platform-actions">
            <PButton v-if="!connection" :loading="enabling" @click="emit('enable')">
              {{ t('ui.social', '启用微信') }}
            </PButton>
            <PButton v-else :loading="busy" @click="startLogin">
              {{ t('ui.social', snapshot.login ? '重新获取二维码' : '获取登录二维码') }}
            </PButton>
            <PButton v-if="snapshot.login" variant="ghost" :disabled="busy" @click="cancelLogin">
              {{ t('ui.social', '取消登录') }}
            </PButton>
          </div>
          <form
            v-if="snapshot.login?.status === 'need_verifycode'"
            class="sp-platform-form"
            @submit.prevent="verify"
          >
            <label for="weixin-verification">{{ t('ui.social', '微信验证码') }}</label>
            <div class="sp-platform-input-row">
              <input
                id="weixin-verification"
                v-model="verification"
                class="sp-platform-input"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="12"
                :disabled="busy"
              />
              <PButton
                type="submit"
                size="sm"
                :disabled="busy || !/^\d{1,12}$/.test(verification.trim())"
              >
                {{ t('ui.social', '提交验证码') }}
              </PButton>
            </div>
          </form>
        </div>
      </div>
      <p v-if="error" class="sp-platform-error" role="alert">{{ error }}</p>
    </section>
    <div class="sp-platform-side">
      <PlatformAccountList
        :accounts="snapshot.accounts"
        :busy="busy"
        :loading="loading"
        @action="action"
      />
      <PlatformOwnerSettings
        v-if="connection"
        :connection="connection"
        :label="t('ui.social', '微信主人标识')"
        :hint="t('ui.social', '默认识别扫码账号为主人；需要覆盖时填写 iLink 返回的用户标识。')"
        @changed="emit('changed')"
      />
    </div>
  </div>
</template>
<style scoped src="./platformSettings.css"></style>
