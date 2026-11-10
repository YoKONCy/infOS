<script setup lang="ts">
import { ref, watch } from 'vue'
import { t as __t } from '../../../i18n/index'
import { homeApi, type HomeRecycleSummary } from '../../../api/modules/homeApi'
import { MotionSkeleton } from '../../motion'
import { PButton, PDialog } from '../../pixel'
import { formatBytes, homeErrorText } from './homeFormat'

// 回收区：她删掉的文件都先进这里。只有用户在这里能手动清空（永久删除），二次确认并说清删什么。
const props = defineProps<{ agentId: string }>()
const summary = ref<HomeRecycleSummary | null>(null)
const confirm = ref(false)
const busy = ref(false)
const done = ref('')
const error = ref('')

async function refresh() {
  if (!props.agentId) return
  try {
    summary.value = await homeApi.recycleSummary(props.agentId)
    error.value = ''
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}
watch(() => props.agentId, refresh, { immediate: true })

async function purge() {
  busy.value = true
  try {
    const result = await homeApi.purgeRecycle(props.agentId)
    done.value = __t('ui.desktop', '已永久删除 {0} 个文件。', [result.items])
    setTimeout(() => (done.value = ''), 4000)
    await refresh()
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="home-panel">
    <header>
      <div>
        <h4>{{ __t('ui.desktop', '回收区') }}</h4>
        <p class="home-muted">
          {{
            __t(
              'ui.desktop',
              '选了「infOS 回收区」，或放进 Windows 回收站失败时，她删掉的文件会放在这里。不会自己清空，只有你能清空。',
            )
          }}
        </p>
      </div>
      <PButton
        size="sm"
        variant="danger"
        :disabled="!summary?.items || busy"
        :loading="busy"
        @click="confirm = true"
      >
        {{ __t('ui.desktop', '清空回收区') }}
      </PButton>
    </header>
    <MotionSkeleton v-if="!summary && !error" variant="text" :rows="1" />
    <Transition v-else name="motion-swap" mode="out-in">
      <p v-if="summary?.items" :key="summary.items" class="home-recycle-count">
        {{
          __t('ui.desktop', '现在有 {0} 个文件，占用 {1}', [
            summary.items,
            formatBytes(summary.bytes),
          ])
        }}
      </p>
      <p v-else-if="summary" key="empty" class="home-empty">
        {{ __t('ui.desktop', '回收区是空的。') }}
      </p>
    </Transition>
    <Transition name="motion-rise">
      <p v-if="done" role="status" class="home-ok">{{ done }}</p>
    </Transition>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
    <PDialog
      v-model="confirm"
      :title="__t('ui.desktop', '清空回收区')"
      :message="
        __t(
          'ui.desktop',
          '回收区里的 {0} 个文件（{1}）会被永久删除，之后没法从这里找回。改动备份不受影响，备份期限内的改动仍然能撤回。确定清空？',
          [summary?.items ?? 0, formatBytes(summary?.bytes ?? 0)],
        )
      "
      :confirm-text="__t('ui.desktop', '永久删除')"
      confirm-variant="danger"
      @confirm="purge"
    />
  </section>
</template>

<style scoped src="./homePanel.css"></style>
<style scoped>
.home-recycle-count {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ui-text-primary);
}
.home-ok {
  margin-top: 8px;
}
</style>
