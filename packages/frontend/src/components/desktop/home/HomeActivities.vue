<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { HomeActivity } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { homeApi } from '../../../api/modules/homeApi'
import { MotionList, MotionSkeleton } from '../../motion'
import { PButton, PDialog, PSelect } from '../../pixel'
import {
  actionLabel,
  baseName,
  formatFullTime,
  formatTime,
  homeErrorText,
  resultLabel,
} from './homeFormat'

// 活动记录：分页翻看她做过什么；可看详情、从列表移除（不影响备份与批量保护）。
const props = defineProps<{ agentId: string; sessionId?: string }>()
const PAGE_SIZE = 20
const items = ref<HomeActivity[]>([])
const total = ref(0)
const page = ref(1)
const action = ref('')
const opened = ref<HomeActivity | null>(null)
const removing = ref<HomeActivity | null>(null)
const confirm = ref(false)
const error = ref('')
const loading = ref(false)
const loaded = ref(false)

const actionOptions = computed(() => [
  { value: '', label: __t('ui.desktop', '全部动作') },
  ...[
    'write',
    'move',
    'delete',
    'undo',
    'declare',
    'app',
    'send',
    'pay',
    'settings',
    'terminal',
    'confirmation',
  ].map((value) => ({ value, label: actionLabel(value) })),
])
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function refresh() {
  if (!props.agentId) return
  loading.value = true
  try {
    const result = await homeApi.activities({
      agentId: props.agentId,
      sessionId: props.sessionId || undefined,
      action: action.value || undefined,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
    items.value = result.items
    total.value = result.total
    error.value = ''
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    loading.value = false
    loaded.value = true
  }
}
watch(
  () => [props.agentId, props.sessionId, action.value],
  () => {
    page.value = 1
    opened.value = null
    void refresh()
  },
  { immediate: true },
)
defineExpose({ refresh })

function go(delta: number) {
  page.value = Math.min(pages.value, Math.max(1, page.value + delta))
  void refresh()
}
async function view(row: HomeActivity) {
  try {
    opened.value =
      opened.value?.id === row.id ? null : await homeApi.activity(props.agentId, row.id)
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}
function askRemove(row: HomeActivity) {
  removing.value = row
  confirm.value = true
}
async function remove() {
  if (!removing.value) return
  try {
    await homeApi.removeActivity(props.agentId, removing.value.id)
    await refresh()
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}
const summary = (row: HomeActivity) =>
  row.objects.length > 1
    ? __t('ui.desktop', '{0} 等 {1} 项', [baseName(row.objects[0]!), row.objects.length])
    : baseName(row.objects[0] ?? '')
</script>

<template>
  <section class="home-panel">
    <header>
      <div>
        <h4>{{ __t('ui.desktop', '她做过什么') }}</h4>
        <p class="home-muted">
          {{ __t('ui.desktop', '她改文件、用程序、问过你的事，都按时间记在这里。') }}
        </p>
      </div>
      <div class="home-filters">
        <div class="home-filter-select">
          <PSelect
            v-model="action"
            :options="actionOptions"
            size="sm"
            :aria-label="__t('ui.desktop', '按动作筛选')"
          />
        </div>
        <PButton size="sm" variant="ghost" :loading="loading" @click="refresh">
          {{ __t('ui.desktop', '刷新') }}
        </PButton>
      </div>
    </header>
    <MotionSkeleton v-if="!loaded" :rows="3" />
    <p v-else-if="!items.length && !error" class="home-empty">
      {{ action ? __t('ui.desktop', '没有这类记录。') : __t('ui.desktop', '还没有记录。') }}
    </p>
    <MotionList tag="ul" class="home-list">
      <li v-for="row in items" :key="row.id">
        <div class="home-row">
          <span class="home-tag" :title="formatFullTime(row.time)">{{ formatTime(row.time) }}</span>
          <span class="home-tag">{{ actionLabel(row.action) }}</span>
          <span class="home-path" :title="row.objects.join('\n')">{{ summary(row) }}</span>
          <span
            :class="[
              'home-tag',
              {
                'is-bad': row.result === 'failed' || row.result === 'conflict',
                'is-warn': row.result === 'waiting',
              },
            ]"
          >
            {{ resultLabel(row.result) }}
          </span>
          <span class="home-row-actions">
            <PButton size="sm" variant="ghost" @click="view(row)">
              {{ opened?.id === row.id ? __t('ui.desktop', '收起') : __t('ui.desktop', '详情') }}
            </PButton>
            <PButton size="sm" variant="ghost" @click="askRemove(row)">
              {{ __t('ui.desktop', '移除') }}
            </PButton>
          </span>
        </div>
        <Transition name="motion-rise">
          <dl v-if="opened?.id === row.id" class="home-detail">
            <dt>{{ __t('ui.desktop', '对象') }}</dt>
            <dd>
              <div v-for="object in opened.objects" :key="object">{{ object }}</div>
            </dd>
            <dt>{{ __t('ui.desktop', '对话') }}</dt>
            <dd>{{ opened.sessionId }}</dd>
            <template v-if="opened.detail">
              <dt>{{ __t('ui.desktop', '说明') }}</dt>
              <dd>{{ opened.detail }}</dd>
            </template>
            <template v-if="opened.checkpointId">
              <dt>{{ __t('ui.desktop', '备份') }}</dt>
              <dd>{{ opened.checkpointId }}</dd>
            </template>
          </dl>
        </Transition>
      </li>
    </MotionList>
    <div v-if="pages > 1" class="home-actions">
      <PButton
        size="sm"
        variant="ghost"
        :disabled="page <= 1"
        :aria-label="__t('ui.desktop', '上一页')"
        @click="go(-1)"
      >
        ‹
      </PButton>
      <span class="home-muted">{{ page }} / {{ pages }}</span>
      <PButton
        size="sm"
        variant="ghost"
        :disabled="page >= pages"
        :aria-label="__t('ui.desktop', '下一页')"
        @click="go(1)"
      >
        ›
      </PButton>
    </div>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
    <PDialog
      v-model="confirm"
      :title="__t('ui.desktop', '移除记录')"
      :message="
        __t(
          'ui.desktop',
          '只是从列表里拿掉这一条。备份、撤回和批量保护的计数都不受影响。',
        )
      "
      @confirm="remove"
    />
  </section>
</template>

<style scoped src="./homePanel.css"></style>
