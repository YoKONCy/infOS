<script setup lang="ts">
/**
 * 世界书页 → 全局启用的世界书与激活设置
 *
 * 增删全局世界书立即保存；扫描深度与 Token 上限需点击「保存设置」，
 * 未保存的输入不会因为增删全局世界书或刷新到相同设置而被重置。
 */
import { computed, ref, watch } from 'vue'
import { WORLDBOOK_LIMITS, type WorldbookSettings, type WorldbookSummary } from '@infos/shared'
import { t as __t } from '../../../i18n/index'
import { worldbookApi } from '../../../api/modules/worldbookApi'
import { useNotificationStore } from '../../../stores/useNotificationStore'
import { PButton, PInputNumber, PixelIcon } from '../../pixel'
import WorldbookBookPicker from './WorldbookBookPicker.vue'

const props = defineProps<{
  /** 已按名称排序的书库。 */
  books: WorldbookSummary[]
  settings: WorldbookSettings
  loading: boolean
  /** 编辑区有操作进行中时禁止跳转到其他书。 */
  locked: boolean
}>()
const emit = defineEmits<{
  'update:settings': [settings: WorldbookSettings]
  open: [bookId: string]
}>()

const notifications = useNotificationStore()
const open = ref(false)
const saving = ref(false)
const scanDepth = ref<number | null>(props.settings.scanDepth)
const tokenBudget = ref<number | null>(props.settings.tokenBudget)

// 只在已保存的数值变化时同步输入框，保留尚未保存的修改；
// 两个数值分别监听，避免 getter 每次返回新数组导致任何设置更新都触发。
watch([() => props.settings.scanDepth, () => props.settings.tokenBudget], ([depth, budget]) => {
  scanDepth.value = depth
  tokenBudget.value = budget
})

const changed = computed(
  () =>
    scanDepth.value !== props.settings.scanDepth ||
    tokenBudget.value !== props.settings.tokenBudget,
)
const bookName = (id: string) => props.books.find((item) => item.id === id)?.name

async function write(request: () => Promise<{ data?: WorldbookSettings }>) {
  saving.value = true
  try {
    const response = await request()
    if (response.data) emit('update:settings', response.data)
    return true
  } catch (cause) {
    notifications.toast(
      __t('ui.worldbook', '保存设置失败：{0}', [
        cause instanceof Error ? cause.message : String(cause),
      ]),
      'error',
    )
    return false
  } finally {
    saving.value = false
  }
}
// 全局世界书按单本增删，不提交整个列表与激活设置：其他窗口的修改不会被覆盖，未保存的扫描深度仍保留为草稿。
function addGlobal(id: string) {
  if (props.settings.globalBooks.includes(id)) return
  void write(() => worldbookApi.addGlobalBook(id))
}
function removeGlobal(id: string) {
  void write(() => worldbookApi.removeGlobalBook(id))
}
async function saveActivation() {
  const next = {
    scanDepth: Math.min(WORLDBOOK_LIMITS.scanDepth, Math.max(1, Math.trunc(scanDepth.value ?? 1))),
    tokenBudget: Math.min(
      WORLDBOOK_LIMITS.tokenBudget,
      Math.max(0, Math.trunc(tokenBudget.value ?? 0)),
    ),
  }
  if (!(await write(() => worldbookApi.saveSettings(next)))) return
  // 输入被收敛（如空值）而保存值未变时，输入框也回到保存值。
  scanDepth.value = next.scanDepth
  tokenBudget.value = next.tokenBudget
  notifications.toast(__t('ui.worldbook', '激活设置已保存'), 'success')
}
</script>

<template>
  <section class="wb-card wb-global surface">
    <header class="wb-card__head">
      <div>
        <h3>
          <PixelIcon name="globe" size="sm" />
          {{ __t('ui.worldbook', '已启用的世界书（全局有效）') }}
        </h3>
        <p class="wb-muted">
          {{ __t('ui.worldbook', '对所有角色生效，与角色绑定的世界书合并使用。') }}
        </p>
      </div>
      <button type="button" class="wb-collapse" :aria-expanded="open" @click="open = !open">
        <PixelIcon name="settings" size="xs" />
        {{ __t('ui.worldbook', '全局世界书激活设置') }}
        <PixelIcon :name="open ? 'chevron-up' : 'chevron-down'" size="xs" />
      </button>
    </header>
    <div class="wb-chips">
      <span
        v-for="id in settings.globalBooks"
        :key="id"
        class="wb-chip"
        :class="{ missing: !bookName(id) }"
      >
        <button
          type="button"
          class="wb-chip__name"
          :disabled="!bookName(id) || locked"
          @click="emit('open', id)"
        >
          {{ bookName(id) ?? __t('ui.worldbook', '已删除的世界书') }}
        </button>
        <button
          type="button"
          class="wb-chip__remove"
          :disabled="saving"
          :aria-label="__t('ui.worldbook', '从全局移除「{0}」', [bookName(id) ?? id])"
          @click="removeGlobal(id)"
        >
          <PixelIcon name="close" size="xs" />
        </button>
      </span>
      <span v-if="!settings.globalBooks.length" class="wb-muted">
        {{ __t('ui.worldbook', '没有激活的世界书') }}
      </span>
      <WorldbookBookPicker
        variant="button"
        icon="plus"
        :books="books"
        :exclude="settings.globalBooks"
        :placeholder="__t('ui.worldbook', '添加')"
        :disabled="saving || loading || !books.length"
        @select="addGlobal"
      />
    </div>
    <Transition name="wb-fold">
      <div v-if="open" class="wb-settings">
        <label class="wb-setting">
          <span class="wb-label">{{ __t('ui.worldbook', '扫描深度') }}</span>
          <PInputNumber
            v-model="scanDepth"
            :min="1"
            :max="WORLDBOOK_LIMITS.scanDepth"
            :disabled="saving"
          />
          <small class="wb-muted">
            {{ __t('ui.worldbook', '在最近多少条消息（含当前输入）中查找关键词。') }}
          </small>
        </label>
        <label class="wb-setting">
          <span class="wb-label">{{ __t('ui.worldbook', 'Token 上限') }}</span>
          <PInputNumber
            v-model="tokenBudget"
            :min="0"
            :max="WORLDBOOK_LIMITS.tokenBudget"
            :step="100"
            :disabled="saving"
          />
          <small class="wb-muted">
            {{ __t('ui.worldbook', '世界书最多占用的 Token，超出时按顺序舍弃；0 表示不限制。') }}
          </small>
        </label>
        <div class="wb-setting wb-setting--actions">
          <PButton
            size="sm"
            :disabled="saving || !changed"
            :loading="saving"
            @click="saveActivation"
          >
            {{ __t('ui.worldbook', '保存设置') }}
          </PButton>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
/* 卡片外观与世界书页其他卡片一致（.surface / .wb-card 等同名样式）。 */
.surface {
  background: var(--dash-panel-bg, var(--ui-bg-surface));
  border: 2px solid var(--ui-border-default);
  box-shadow: 4px 4px 0 color-mix(in srgb, var(--ui-border-default) 55%, transparent);
  transition:
    background-color 0.2s,
    border-color 0.2s,
    box-shadow 0.2s;
}
.wb-card {
  padding: 16px 20px;
}
.wb-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font: 700 16px/1.5 var(--ui-font-pixel);
}
.wb-muted {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-tertiary);
}
.wb-label {
  font: 700 12px/1.5 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
}

/* 全局启用 */
.wb-collapse {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font: 700 12px/1.5 var(--ui-font-pixel);
  color: var(--ui-text-secondary);
  border-bottom: 2px solid transparent;
  transition:
    color var(--ui-duration-fast) var(--ui-ease-standard),
    background-color var(--ui-duration-fast) var(--ui-ease-standard),
    border-color var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-collapse:hover,
.wb-collapse[aria-expanded='true'] {
  color: var(--ui-accent-sky);
  background: color-mix(in srgb, var(--ui-accent-sky) 8%, transparent);
  border-bottom-color: var(--ui-accent-sky);
}
.wb-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.wb-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky) 45%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-accent-sky) 9%, transparent);
  font-size: 13px;
}
.wb-chip.missing {
  border-style: dashed;
  border-color: var(--ui-border-default);
  background: transparent;
  color: var(--ui-text-tertiary);
}
.wb-chip__name {
  padding: 4px 4px 4px 10px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-chip__name:hover:not(:disabled) {
  color: var(--ui-accent-sky);
}
.wb-chip__remove {
  display: inline-flex;
  padding: 6px 8px;
  color: var(--ui-text-tertiary);
}
.wb-chip__remove:hover:not(:disabled) {
  color: var(--ui-danger);
}
.wb-settings {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px 24px;
  align-items: end;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--ui-border-subtle);
}
.wb-setting {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wb-setting--actions {
  align-items: flex-start;
  align-self: center;
}

.wb-fold-enter-active,
.wb-fold-leave-active {
  transition:
    opacity var(--ui-duration-fast) var(--ui-ease-standard),
    transform var(--ui-duration-fast) var(--ui-ease-standard);
}
.wb-fold-enter-from,
.wb-fold-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (max-width: 800px) {
  .wb-card {
    padding: 14px 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wb-fold-enter-active,
  .wb-fold-leave-active {
    transition: none;
  }
}
</style>
