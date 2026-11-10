<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { HomeCheckpoint, HomeScope } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { homeApi, type HomeCheckpointDiff } from '../../../api/modules/homeApi'
import { MotionList, MotionSkeleton } from '../../motion'
import { PButton, PDialog } from '../../pixel'
import {
  actionLabel,
  baseName,
  checkpointStateLabel,
  formatBytes,
  formatFullTime,
  formatTime,
  homeCode,
  homeErrorText,
} from './homeFormat'
import { checkpointAbilities, checkpointPaths, undoAllState } from './homeCheckpointRules'

// 对话改动清单：她在这段对话里动过的文件。每条可看前后差异、单独撤回；也可以一键全撤。
const props = defineProps<{ scope: HomeScope | null }>()
const emit = defineEmits<{ changed: [] }>()
const rows = ref<HomeCheckpoint[]>([])
const diff = ref<HomeCheckpointDiff | null>(null)
const pendingUndo = ref<HomeCheckpoint | 'all' | null>(null)
const confirm = ref(false)
const error = ref('')
const loading = ref(false)
const loaded = ref(false)

const ordered = computed(() => [...rows.value].reverse())
const all = computed(() => undoAllState(rows.value))

async function refresh() {
  if (!props.scope) {
    rows.value = []
    loaded.value = true
    return
  }
  loading.value = true
  try {
    rows.value = await homeApi.checkpoints(props.scope)
    error.value = ''
  } catch (cause) {
    error.value = homeErrorText(cause)
  } finally {
    loading.value = false
    loaded.value = true
  }
}
watch(
  () => props.scope,
  () => {
    loaded.value = false
    diff.value = null
    void refresh()
  },
  { immediate: true, deep: true },
)
defineExpose({ refresh })

async function showDiff(row: HomeCheckpoint) {
  if (!props.scope) return
  if (diff.value?.id === row.id) {
    diff.value = null
    return
  }
  try {
    diff.value = await homeApi.diff(props.scope, row.id)
  } catch (cause) {
    error.value = homeErrorText(cause)
  }
}
async function reconcile(row: HomeCheckpoint) {
  if (!props.scope) return
  try {
    await homeApi.reconcile(props.scope, row.id)
    await refresh()
  } catch (cause) {
    // 混合状态不会被自动覆盖：说明需要用户自己看一下文件。
    error.value =
      homeCode(cause) === 'HOME_CONFLICT'
        ? __t('ui.desktop', '文件现在和她改之前、改之后都对不上，所以没有自动处理。请先自己看一下这些文件。')
        : homeErrorText(cause)
  }
}
function askUndo(target: HomeCheckpoint | 'all') {
  pendingUndo.value = target
  confirm.value = true
}
async function undo() {
  const target = pendingUndo.value
  if (!props.scope || !target) return
  try {
    await homeApi.undo(props.scope, target === 'all' ? undefined : target.id)
    diff.value = null
    await refresh()
    emit('changed')
  } catch (cause) {
    error.value =
      homeCode(cause) === 'HOME_CONFLICT'
        ? __t(
            'ui.desktop',
            '有文件在她改完之后又被改过了。为了不覆盖你的修改，这次一个文件都没有撤回。',
          )
        : homeErrorText(cause)
  }
}
const confirmText = computed(() =>
  pendingUndo.value === 'all'
    ? __t('ui.desktop', '把这段对话里还能撤回的改动全部撤回？')
    : __t('ui.desktop', '撤回这条改动，把文件恢复到改之前？'),
)
const sideText = (snapshot: HomeCheckpointDiff['before'][number]) =>
  snapshot.hash === null
    ? __t('ui.desktop', '（不存在）')
    : snapshot.binary
      ? __t('ui.desktop', '（不是文字或太大，没法显示；{0}）', [formatBytes(snapshot.size)])
      : (snapshot.text ?? '')
</script>

<template>
  <section class="home-panel">
    <header>
      <div>
        <h4>{{ __t('ui.desktop', '这段对话改过的文件') }}</h4>
        <p class="home-muted">
          {{ __t('ui.desktop', '每一条都能看前后对比、单独撤回；也可以一次全部撤回。') }}
        </p>
      </div>
      <div class="home-filters">
        <PButton size="sm" variant="ghost" :loading="loading" :disabled="!scope" @click="refresh">
          {{ __t('ui.desktop', '刷新') }}
        </PButton>
        <PButton size="sm" variant="danger" :disabled="!all.enabled" @click="askUndo('all')">
          {{ __t('ui.desktop', '全部撤回') }}
        </PButton>
      </div>
    </header>
    <p v-if="all.blockedByPending" class="home-muted">
      {{
        __t('ui.desktop', '有一条改动还没确认结果。先点它的「核对」看看实际情况，才能全部撤回。')
      }}
    </p>
    <p v-if="!scope" class="home-empty">{{ __t('ui.desktop', '先在上面选一段对话。') }}</p>
    <MotionSkeleton v-else-if="!loaded" :rows="2" />
    <p v-else-if="!rows.length && !error" class="home-empty">
      {{ __t('ui.desktop', '这段对话里她还没改过文件。') }}
    </p>
    <MotionList tag="ul" class="home-list">
      <li v-for="row in ordered" :key="row.id">
        <div class="home-row">
          <span class="home-tag" :title="formatFullTime(row.createdAt)">
            {{ formatTime(row.createdAt) }}
          </span>
          <span class="home-tag">{{ actionLabel(row.action) }}</span>
          <span class="home-path" :title="checkpointPaths(row).join('\n')">
            {{ checkpointPaths(row).map(baseName).join(' → ') }}
          </span>
          <span :class="['home-tag', { 'is-warn': row.state === 'pending' }]">
            {{ checkpointStateLabel(row.state) }}
          </span>
          <span class="home-row-actions">
            <PButton
              v-if="row.state !== 'expired'"
              size="sm"
              variant="ghost"
              @click="showDiff(row)"
            >
              {{ diff?.id === row.id ? __t('ui.desktop', '收起') : __t('ui.desktop', '看改动') }}
            </PButton>
            <PButton
              v-if="checkpointAbilities(row).reconcile"
              size="sm"
              variant="secondary"
              @click="reconcile(row)"
            >
              {{ __t('ui.desktop', '核对') }}
            </PButton>
            <PButton
              v-if="checkpointAbilities(row).undo"
              size="sm"
              variant="secondary"
              @click="askUndo(row)"
            >
              {{ __t('ui.desktop', '撤回') }}
            </PButton>
          </span>
        </div>
        <Transition name="motion-rise">
          <div v-if="diff?.id === row.id">
            <div v-for="(before, index) in diff.before" :key="before.path" class="home-diff">
              <div>
                <small class="home-muted">
                  {{ __t('ui.desktop', '改之前') }} · {{ before.path }}
                </small>
                <pre>{{ sideText(before) }}</pre>
              </div>
              <div v-if="diff.after[index]">
                <small class="home-muted">
                  {{ __t('ui.desktop', '改之后') }} · {{ diff.after[index]!.path }}
                </small>
                <pre>{{ sideText(diff.after[index]!) }}</pre>
              </div>
            </div>
          </div>
        </Transition>
      </li>
    </MotionList>
    <Transition name="motion-rise">
      <p v-if="error" role="alert" class="home-error">{{ error }}</p>
    </Transition>
    <PDialog
      v-model="confirm"
      :title="__t('ui.desktop', '撤回改动')"
      :message="confirmText"
      @confirm="undo"
    />
  </section>
</template>

<style scoped src="./homePanel.css"></style>
