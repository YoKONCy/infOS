<script setup lang="ts">
import { ref, watch } from 'vue'
import type { HomeGrant } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { homeApi } from '../../../api/modules/homeApi'
import { MotionList, MotionSkeleton } from '../../motion'
import { PButton, PDialog } from '../../pixel'
import { homeErrorText } from './homeFormat'

// 授权列表：按文件夹 / 应用、读 / 写、本对话 / 一直有效显示；可查看详情、立即收回。
const props = defineProps<{ agentId: string }>()
const grants = ref<HomeGrant[]>([])
const loaded = ref(false)
const opened = ref<HomeGrant | null>(null)
const revoking = ref<HomeGrant | null>(null)
const confirm = ref(false)
const error = ref('')
const loading = ref(false)

async function refresh() {
  if (!props.agentId) return
  loading.value = true
  try {
    grants.value = await homeApi.grants(props.agentId)
    error.value = ''
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    loading.value = false
    loaded.value = true
  }
}
watch(
  () => props.agentId,
  () => {
    loaded.value = false
    opened.value = null
    void refresh()
  },
  { immediate: true },
)
defineExpose({ refresh })

async function view(grant: HomeGrant) {
  try {
    opened.value =
      opened.value?.id === grant.id ? null : await homeApi.grant(props.agentId, grant.id)
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}
function askRevoke(grant: HomeGrant) {
  revoking.value = grant
  confirm.value = true
}
async function revoke() {
  const grant = revoking.value
  if (!grant) return
  try {
    await homeApi.revokeGrant(props.agentId, grant.id)
    if (opened.value?.id === grant.id) opened.value = null
    await refresh()
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}

const kindText = (grant: HomeGrant) =>
  grant.kind === 'folder' ? __t('ui.desktop', '文件夹') : __t('ui.desktop', '应用')
const accessText = (grant: HomeGrant) =>
  grant.access === 'write' ? __t('ui.desktop', '能改') : __t('ui.desktop', '只能看')
const durationText = (grant: HomeGrant) =>
  grant.duration === 'permanent' ? __t('ui.desktop', '一直有效') : __t('ui.desktop', '仅这段对话')
</script>

<template>
  <section class="home-panel">
    <header>
      <div>
        <h4>{{ __t('ui.desktop', '授权') }}</h4>
        <p class="home-muted">
          {{
            __t(
              'ui.desktop',
              '你允许过「以后不用问」的文件夹和应用。收回后，她下次再用会重新问你。',
            )
          }}
        </p>
      </div>
      <PButton size="sm" variant="ghost" :loading="loading" @click="refresh">
        {{ __t('ui.desktop', '刷新') }}
      </PButton>
    </header>
    <MotionSkeleton v-if="!loaded" :rows="2" />
    <p v-else-if="!grants.length && !error" class="home-empty">
      {{ __t('ui.desktop', '还没有授权过任何东西。') }}
    </p>
    <MotionList tag="ul" class="home-list">
      <li v-for="grant in grants" :key="grant.id">
        <div class="home-row">
          <span class="home-tag">{{ kindText(grant) }}</span>
          <span class="home-path" :title="grant.target">{{ grant.target }}</span>
          <span class="home-tag">{{ accessText(grant) }}</span>
          <span class="home-tag">{{ durationText(grant) }}</span>
          <span class="home-row-actions">
            <PButton size="sm" variant="ghost" @click="view(grant)">
              {{ opened?.id === grant.id ? __t('ui.desktop', '收起') : __t('ui.desktop', '详情') }}
            </PButton>
            <PButton size="sm" variant="danger" @click="askRevoke(grant)">
              {{ __t('ui.desktop', '收回') }}
            </PButton>
          </span>
        </div>
        <Transition name="motion-rise">
          <dl v-if="opened?.id === grant.id" class="home-detail">
            <dt>{{ __t('ui.desktop', '位置') }}</dt>
            <dd>{{ opened.target }}</dd>
            <dt>{{ __t('ui.desktop', '对话') }}</dt>
            <dd>{{ opened.sessionId }}</dd>
          </dl>
        </Transition>
      </li>
    </MotionList>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
    <PDialog
      v-model="confirm"
      :title="__t('ui.desktop', '收回授权')"
      :message="
        __t('ui.desktop', '收回对「{0}」的授权？马上生效，她下次要用会重新问你。', [
          revoking?.target ?? '',
        ])
      "
      confirm-variant="danger"
      @confirm="revoke"
    />
  </section>
</template>

<style scoped src="./homePanel.css"></style>
