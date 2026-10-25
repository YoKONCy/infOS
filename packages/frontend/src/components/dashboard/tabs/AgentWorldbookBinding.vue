<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * AgentWorldbookBinding.vue — 角色世界书绑定入口
 *
 * 角色档案头部的地球按钮：左键打开已绑定的主要世界书，右键或箭头打开绑定窗口。
 * 世界书本身在「提示词 → 世界书」中编辑；这里只维护角色与书库之间的绑定关系，保存后立即生效。
 */
import { computed, onActivated, ref, watch } from 'vue'
import {
  normalizeWorldbookBinding,
  WORLDBOOK_LIMITS,
  type Worldbook,
  type WorldbookBinding,
  type WorldbookSummary,
} from '@infos/shared'
import { PButton, PDialog, PInput, PSelect, PixelIcon } from '../../pixel'
import { worldbookApi } from '../../../api/modules/worldbookApi'
import { ApiError } from '../../../api/errors'
import { requestWorldbookNavigation } from '../../../composables/main/useWorldbookNavigation'
import { useMainNav } from '../../../composables/main/useMainNav'
import { useNotificationStore } from '../../../stores'

const props = defineProps<{
  agentId: string
  agentName: string
}>()

const notif = useNotificationStore()
const { setTab } = useMainNav()

const books = ref<WorldbookSummary[]>([])
const binding = ref<WorldbookBinding>({ primary: null, additional: [] })
/** 书库读取成功后才判断“已删除”，避免加载中误报。 */
const libraryReady = ref(false)
const loading = ref(false)
const loadFailed = ref(false)
const dialogOpen = ref(false)
const saving = ref(false)
const creating = ref(false)
const draftPrimary = ref('')
const draftAdditional = ref<string[]>([])
const additionalQuery = ref('')
// 切换角色时丢弃过期响应，防止上一个角色的绑定覆盖当前角色。
let loadRequest = 0
let activatedOnce = false

const bookMap = computed(() => new Map(books.value.map((book) => [book.id, book])))
const sortedBooks = computed(() => [...books.value].sort((a, b) => a.name.localeCompare(b.name)))
const busy = computed(() => loading.value || saving.value || creating.value)
const additionalLimit = WORLDBOOK_LIMITS.additionalBooks
const atAdditionalLimit = computed(() => draftAdditional.value.length >= additionalLimit)

function isMissing(bookId: string): boolean {
  return libraryReady.value && !bookMap.value.has(bookId)
}

function bookName(bookId: string): string {
  return bookMap.value.get(bookId)?.name ?? __t('ui.worldbook-binding', '已删除的世界书')
}

const hasPrimary = computed(() => Boolean(binding.value.primary))
const primaryMissing = computed(() =>
  binding.value.primary ? isMissing(binding.value.primary) : false,
)

const globeTitle = computed(() => {
  if (loading.value && !libraryReady.value)
    return __t('ui.worldbook-binding', '正在读取世界书绑定…')
  if (loadFailed.value) return __t('ui.worldbook-binding', '世界书绑定读取失败，点击重试')
  const primary = binding.value.primary
  if (!primary) return __t('ui.worldbook-binding', '未绑定世界书')
  if (primaryMissing.value) return __t('ui.worldbook-binding', '绑定的世界书已被删除')
  const status = binding.value.additional.length
    ? __t('ui.worldbook-binding', '世界书：{0}（另附加 {1} 本）', [
        bookName(primary),
        binding.value.additional.length,
      ])
    : __t('ui.worldbook-binding', '世界书：{0}', [bookName(primary)])
  return [status, __t('ui.worldbook-binding', '单击打开，右键更换绑定')].join('\n')
})

const primaryOptions = computed(() => {
  const options: Array<{ label: string; value: string }> = [
    { label: __t('ui.worldbook-binding', '不绑定'), value: '' },
  ]
  if (draftPrimary.value && !bookMap.value.has(draftPrimary.value))
    options.push({
      label: __t('ui.worldbook-binding', '已删除的世界书'),
      value: draftPrimary.value,
    })
  for (const book of sortedBooks.value) options.push({ label: book.name, value: book.id })
  return options
})

const additionalCandidates = computed(() => {
  const query = additionalQuery.value.trim().toLowerCase()
  return sortedBooks.value.filter(
    (book) =>
      book.id !== draftPrimary.value &&
      !draftAdditional.value.includes(book.id) &&
      (!query || book.name.toLowerCase().includes(query)),
  )
})

const draftBinding = (): WorldbookBinding => ({
  primary: draftPrimary.value || null,
  additional: draftAdditional.value.filter((id) => id !== draftPrimary.value),
})

const draftDirty = computed(() => {
  const draft = draftBinding()
  return (
    draft.primary !== binding.value.primary ||
    draft.additional.join('\n') !== binding.value.additional.join('\n')
  )
})

const canOpenDraft = computed(
  () => Boolean(draftPrimary.value) && bookMap.value.has(draftPrimary.value),
)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : __t('ui.worldbook-binding', '未知错误')
}

function resetDraft(): void {
  draftPrimary.value = binding.value.primary ?? ''
  draftAdditional.value = [...binding.value.additional]
}

async function loadState(): Promise<void> {
  const agentId = props.agentId
  const request = ++loadRequest
  loading.value = true
  loadFailed.value = false
  try {
    const [libraryResponse, bindingResponse] = await Promise.all([
      worldbookApi.list(),
      worldbookApi.getBinding(agentId),
    ])
    if (request !== loadRequest) return
    books.value = libraryResponse.data?.books ?? []
    binding.value = normalizeWorldbookBinding(bindingResponse.data)
    libraryReady.value = true
  } catch {
    if (request === loadRequest) loadFailed.value = true
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

function openBook(bookId: string): void {
  requestWorldbookNavigation(bookId, props.agentId)
  void setTab('prompts')
}

async function openDialog(): Promise<void> {
  additionalQuery.value = ''
  resetDraft()
  dialogOpen.value = true
  // 每次打开都刷新书库，反映提示词页中的新建、改名与删除。
  await loadState()
  if (dialogOpen.value && !loadFailed.value) resetDraft()
}

function handleGlobeClick(): void {
  if (loadFailed.value) {
    void loadState()
    return
  }
  const primary = binding.value.primary
  if (primary && !primaryMissing.value) openBook(primary)
  else void openDialog()
}

function setPrimary(value: string | number): void {
  draftPrimary.value = String(value)
  // 主要世界书不能同时作为附加世界书。
  draftAdditional.value = draftAdditional.value.filter((id) => id !== draftPrimary.value)
}

function addAdditional(bookId: string): void {
  if (atAdditionalLimit.value || draftAdditional.value.includes(bookId)) return
  draftAdditional.value = [...draftAdditional.value, bookId]
}

function removeAdditional(bookId: string): void {
  draftAdditional.value = draftAdditional.value.filter((id) => id !== bookId)
}

function openDraftBook(): void {
  if (!canOpenDraft.value) return
  dialogOpen.value = false
  openBook(draftPrimary.value)
}

const isConflict = (error: unknown) => error instanceof ApiError && error.code === 'CONFLICT'

/** 其他窗口已修改绑定：载入最新绑定并重置草稿，由用户确认后再保存。 */
async function reloadAfterConflict(): Promise<void> {
  notif.toast(
    __t('ui.worldbook-binding', '世界书绑定已在其他位置被修改，已载入最新绑定，请确认后再保存。'),
    'warning',
  )
  await loadState()
  resetDraft()
}

async function saveDraft(): Promise<void> {
  if (!draftDirty.value) {
    dialogOpen.value = false
    return
  }
  const agentId = props.agentId
  const next = draftBinding()
  saving.value = true
  try {
    const response = await worldbookApi.saveBinding(agentId, next, binding.value)
    if (agentId !== props.agentId) return
    binding.value = normalizeWorldbookBinding(response.data ?? next)
    dialogOpen.value = false
    notif.toast(__t('ui.worldbook-binding', '世界书绑定已保存'), 'success')
  } catch (error) {
    if (isConflict(error)) return void (await reloadAfterConflict())
    notif.toast(
      __t('ui.worldbook-binding', '保存世界书绑定失败：{0}', [errorMessage(error)]),
      'error',
    )
  } finally {
    saving.value = false
  }
}

/** 名称超长时截断主体，保留 “ (n)” 后缀。 */
function suffixedName(base: string, index: number): string {
  if (index <= 1) return base.slice(0, WORLDBOOK_LIMITS.name)
  const suffix = ` (${index})`
  return base.slice(0, WORLDBOOK_LIMITS.name - suffix.length) + suffix
}

/** 以角色名新建世界书；重名时依次追加 (2)、(3)…，以服务端的 DUPLICATE_NAME 为准。 */
async function createUniqueBook(base: string): Promise<Worldbook> {
  const taken = new Set(books.value.map((book) => book.name))
  for (let index = 1; index <= 100; index++) {
    const name = suffixedName(base, index)
    if (taken.has(name)) continue
    try {
      const response = await worldbookApi.create({ name })
      if (!response.data) throw new Error(__t('ui.worldbook-binding', '服务端没有返回世界书'))
      return response.data
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DUPLICATE_NAME') continue
      throw error
    }
  }
  throw new Error(__t('ui.worldbook-binding', '无法生成不重复的世界书名称'))
}

async function createAndBind(): Promise<void> {
  const agentId = props.agentId
  const base = props.agentName.trim() || agentId
  creating.value = true
  let book: Worldbook | undefined
  try {
    const created = await createUniqueBook(base)
    book = created
    if (agentId !== props.agentId) return
    books.value = [
      ...books.value.filter((item) => item.id !== created.id),
      {
        id: book.id,
        name: book.name,
        entryCount: book.entries.length,
        revision: book.revision,
        updatedAt: book.updatedAt,
      },
    ]
    setPrimary(book.id)
    // 新建即绑定：连同窗口中已调整的附加世界书一起保存，窗口保持打开以便继续打开编辑。
    const next = draftBinding()
    const response = await worldbookApi.saveBinding(agentId, next, binding.value)
    if (agentId !== props.agentId) return
    binding.value = normalizeWorldbookBinding(response.data ?? next)
    notif.toast(__t('ui.worldbook-binding', '已新建并绑定「{0}」', [book.name]), 'success')
  } catch (error) {
    if (book && isConflict(error) && agentId === props.agentId) {
      // 书已建好，只是绑定未保存：载入最新绑定后把新书选为主要世界书，等待用户确认。
      await reloadAfterConflict()
      setPrimary(book.id)
      return
    }
    notif.toast(__t('ui.worldbook-binding', '新建世界书失败：{0}', [errorMessage(error)]), 'error')
  } finally {
    creating.value = false
  }
}

watch(
  () => props.agentId,
  () => {
    // 切换角色时立即清空旧状态，不沿用上一个角色的绑定。
    dialogOpen.value = false
    binding.value = { primary: null, additional: [] }
    void loadState()
  },
  { immediate: true },
)

// 页面被缓存后重新显示时刷新，反映在世界书模块中做出的修改。
onActivated(() => {
  if (activatedOnce && !dialogOpen.value) void loadState()
  activatedOnce = true
})
</script>

<template>
  <div
    class="worldbook-binding"
    :class="{ bound: hasPrimary && !primaryMissing, missing: primaryMissing }"
    @contextmenu.prevent="openDialog"
  >
    <button
      type="button"
      class="worldbook-globe"
      :title="globeTitle"
      :aria-label="globeTitle"
      @click="handleGlobeClick"
    >
      <PixelIcon
        :name="loading && !libraryReady ? 'refresh' : 'globe'"
        size="sm"
        :animation="loading && !libraryReady ? 'spin' : ''"
      />
      <i v-if="binding.additional.length">+{{ binding.additional.length }}</i>
    </button>
    <button
      type="button"
      class="worldbook-caret"
      aria-haspopup="dialog"
      :title="__t('ui.worldbook-binding', '选择世界书')"
      :aria-label="__t('ui.worldbook-binding', '选择世界书')"
      @click="openDialog"
    >
      <PixelIcon name="chevron-down" size="xs" />
    </button>

    <PDialog
      v-model="dialogOpen"
      :title="__t('ui.worldbook-binding', '为「{0}」选择世界书', [agentName || agentId])"
      width="560px"
    >
      <div class="binding-body">
        <div v-if="loadFailed" class="binding-alert">
          <PixelIcon name="alert" size="sm" />
          <span>{{ __t('ui.worldbook-binding', '读取书库失败，请重试。') }}</span>
          <PButton size="sm" variant="secondary" :loading="loading" @click="openDialog">
            {{ __t('ui.worldbook-binding', '重试') }}
          </PButton>
        </div>
        <div v-else-if="loading && !libraryReady" class="binding-loading">
          <PixelIcon name="refresh" size="sm" animation="spin" />
          <span>{{ __t('ui.worldbook-binding', '正在读取书库…') }}</span>
        </div>

        <section class="binding-part">
          <header>
            <span>01</span>
            <div>
              <b>{{ __t('ui.worldbook-binding', '主要世界书') }}</b>
              <small>
                {{
                  __t(
                    'ui.worldbook-binding',
                    '作为角色自己的世界书，生成时与全局启用的世界书合并生效，并随角色一起导出。',
                  )
                }}
              </small>
            </div>
          </header>
          <PSelect
            :model-value="draftPrimary"
            :options="primaryOptions"
            :disabled="busy || loadFailed"
            teleport
            @update:model-value="setPrimary"
          />
          <p v-if="draftPrimary && isMissing(draftPrimary)" class="binding-note warning">
            {{
              __t('ui.worldbook-binding', '这本世界书已被删除，请改选其他世界书或选择「不绑定」。')
            }}
          </p>
          <p v-else-if="libraryReady && !books.length" class="binding-note">
            {{ __t('ui.worldbook-binding', '书库中还没有世界书，可以点击「新建并绑定」。') }}
          </p>
        </section>

        <section class="binding-part">
          <header>
            <span>02</span>
            <div>
              <b>{{ __t('ui.worldbook-binding', '附加世界书') }}</b>
              <small>
                {{ __t('ui.worldbook-binding', '可选，额外为此角色启用；不随角色导出。') }}
              </small>
            </div>
            <i>{{ draftAdditional.length }} / {{ additionalLimit }}</i>
          </header>

          <div class="binding-chips">
            <span
              v-for="bookId in draftAdditional"
              :key="bookId"
              class="binding-chip"
              :class="{ missing: isMissing(bookId) }"
            >
              <PixelIcon name="book" size="xs" />
              <em>{{ bookName(bookId) }}</em>
              <button
                type="button"
                :disabled="busy"
                :title="__t('ui.worldbook-binding', '移除「{0}」', [bookName(bookId)])"
                :aria-label="__t('ui.worldbook-binding', '移除「{0}」', [bookName(bookId)])"
                @click="removeAdditional(bookId)"
              >
                <PixelIcon name="close" size="xs" />
              </button>
            </span>
            <small v-if="!draftAdditional.length">
              {{ __t('ui.worldbook-binding', '未选择附加世界书') }}
            </small>
          </div>

          <div class="binding-picker">
            <PInput
              v-model="additionalQuery"
              size="sm"
              :disabled="loadFailed || !libraryReady"
              :placeholder="__t('ui.worldbook-binding', '搜索世界书名称')"
            />
            <ul v-if="additionalCandidates.length">
              <li v-for="book in additionalCandidates" :key="book.id">
                <button
                  type="button"
                  :disabled="busy || atAdditionalLimit"
                  @click="addAdditional(book.id)"
                >
                  <PixelIcon name="plus" size="xs" />
                  <span>{{ book.name }}</span>
                  <small>
                    {{ __t('ui.worldbook-binding', '{0} 个条目', [book.entryCount]) }}
                  </small>
                </button>
              </li>
            </ul>
            <p v-else-if="libraryReady" class="binding-note">
              {{
                additionalQuery.trim()
                  ? __t('ui.worldbook-binding', '没有匹配的世界书')
                  : __t('ui.worldbook-binding', '没有可添加的世界书')
              }}
            </p>
            <p v-if="atAdditionalLimit" class="binding-note warning">
              {{ __t('ui.worldbook-binding', '最多附加 {0} 本世界书', [additionalLimit]) }}
            </p>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="binding-footer">
          <div>
            <PButton
              size="sm"
              variant="secondary"
              :loading="creating"
              :disabled="busy || loadFailed"
              @click="createAndBind"
            >
              {{ __t('ui.worldbook-binding', '新建并绑定') }}
            </PButton>
            <PButton
              size="sm"
              variant="ghost"
              :disabled="busy || !canOpenDraft"
              @click="openDraftBook"
            >
              {{ __t('ui.worldbook-binding', '打开世界书') }}
            </PButton>
          </div>
          <div>
            <PButton size="sm" variant="secondary" :disabled="saving" @click="dialogOpen = false">
              {{ __t('ui.worldbook-binding', '取消') }}
            </PButton>
            <PButton size="sm" :loading="saving" :disabled="busy || loadFailed" @click="saveDraft">
              {{ __t('ui.worldbook-binding', '确定') }}
            </PButton>
          </div>
        </div>
      </template>
    </PDialog>
  </div>
</template>

<style scoped>
.worldbook-binding {
  display: inline-flex;
  flex: none;
  align-items: stretch;
  border: 1px solid var(--ui-border-default);
  background: color-mix(in srgb, var(--ui-bg-elevated) 82%, transparent);
  box-shadow: 2px 2px 0 var(--ui-border-subtle);
  transition:
    border-color var(--ui-duration-fast),
    background var(--ui-duration-fast);
}
.worldbook-binding button {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--ui-text-tertiary);
  cursor: pointer;
  transition:
    color var(--ui-duration-fast),
    background var(--ui-duration-fast);
}
.worldbook-binding button:hover {
  background: var(--ui-bg-hover);
  color: var(--ui-accent-primary);
}
.worldbook-binding button:focus-visible {
  outline: 2px solid var(--ui-accent-primary);
  outline-offset: -2px;
}
.worldbook-globe {
  position: relative;
  width: 28px;
  height: 26px;
}
.worldbook-globe > i {
  position: absolute;
  right: 1px;
  bottom: 0;
  font: 800 7px var(--ui-font-mono);
  font-style: normal;
}
.worldbook-binding .worldbook-caret {
  width: 16px;
  border-left: 1px solid var(--ui-border-subtle);
}
/* 已绑定主要世界书：绿色提示 */
.worldbook-binding.bound {
  border-color: var(--ui-success);
  background: var(--ui-success-soft);
}
.worldbook-binding.bound button {
  color: var(--ui-success);
}
.worldbook-binding.bound .worldbook-caret {
  border-left-color: color-mix(in srgb, var(--ui-success) 35%, transparent);
}
/* 绑定的书已被删除：警告色，提示用户重新选择 */
.worldbook-binding.missing {
  border-color: var(--ui-warning);
  background: var(--ui-warning-soft);
}
.worldbook-binding.missing button {
  color: var(--ui-warning);
}

.binding-body {
  display: grid;
  gap: 14px;
}
.binding-alert,
.binding-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border-default);
  background: var(--ui-bg-surface-soft);
  color: var(--ui-text-secondary);
  font-size: 11px;
}
.binding-alert {
  border-color: var(--ui-danger);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}
.binding-alert > span {
  flex: 1;
}
.binding-part {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--ui-border-default);
  background: color-mix(in srgb, var(--ui-bg-surface) 82%, transparent);
}
.binding-part > header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.binding-part > header > span {
  display: grid;
  width: 22px;
  height: 22px;
  flex: none;
  place-items: center;
  border: 1px solid var(--ui-accent-primary);
  color: var(--ui-accent-primary);
  font: 800 8px var(--ui-font-mono);
}
.binding-part > header > div {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}
.binding-part > header b {
  font-size: 12px;
}
.binding-part > header small {
  color: var(--ui-text-tertiary);
  font-size: 10px;
  line-height: 1.5;
}
.binding-part > header > i {
  color: var(--ui-text-disabled);
  font: 800 8px var(--ui-font-mono);
  font-style: normal;
}
.binding-note {
  margin: 0;
  color: var(--ui-text-tertiary);
  font-size: 10px;
}
.binding-note.warning {
  color: var(--ui-warning);
}
.binding-chips {
  display: flex;
  min-height: 26px;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.binding-chips > small {
  color: var(--ui-text-disabled);
  font-size: 10px;
}
.binding-chip {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 5px;
  padding: 2px 2px 2px 7px;
  border: 1px solid var(--ui-accent-primary);
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
  font-size: 11px;
}
.binding-chip em {
  overflow: hidden;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.binding-chip.missing {
  border-color: var(--ui-warning);
  background: var(--ui-warning-soft);
  color: var(--ui-warning);
}
.binding-chip button {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.binding-chip button:hover:not(:disabled) {
  background: var(--ui-bg-hover);
}
.binding-picker {
  display: grid;
  gap: 6px;
}
.binding-picker ul {
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--ui-border-subtle);
  list-style: none;
}
.binding-picker li + li {
  border-top: 1px solid var(--ui-border-subtle);
}
.binding-picker li button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  color: var(--ui-text-primary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.binding-picker li button:hover:not(:disabled) {
  background: var(--ui-accent-primary-soft);
  color: var(--ui-accent-primary);
}
.binding-picker li button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.binding-picker li span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.binding-picker li small {
  flex: none;
  color: var(--ui-text-tertiary);
  font: 9px var(--ui-font-mono);
}
.binding-footer {
  display: flex;
  width: 100%;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
.binding-footer > div {
  display: flex;
  gap: 8px;
}
</style>
