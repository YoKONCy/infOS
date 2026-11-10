<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { PButton, PDialog, PInput, PSelect, PixelIcon } from '../pixel'
import MotionList from '../motion/MotionList.vue'
import BrandSelect from '../brands/BrandSelect.vue'
import BrandIcon from '../brands/BrandIcon.vue'
import ProviderConnectionChecks from './ProviderConnectionChecks.vue'
import { resolveProviderBrand } from '../../lib/modelBrands'
import {
  providerApi,
  type ProviderConnectionInput,
  type ProviderConnectionItem,
} from '../../api/modules/providerApi'
import { useNotificationStore } from '../../stores/useNotificationStore'

const props = defineProps<{
  modelValue: boolean
  connections: ProviderConnectionItem[]
  templates: Array<{ label: string; value: string }>
  defaults: Record<string, string>
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; changed: [] }>()
const notify = useNotificationStore()
const selectedId = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const removing = ref(false)
const replacementId = ref('')
const pendingSelection = ref<string | null>(null)
let sequence = 0
const emptyDraft = (): ProviderConnectionInput => ({
  name: '',
  brand: 'custom',
  protocol: 'openai',
  apiBase: '',
  authMode: 'api_key',
  apiKey: '',
})
const draft = ref(emptyDraft())
const baseline = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const current = computed(() => props.connections.find((item) => item.id === selectedId.value))
const templateOptions = computed(() => {
  const options = props.templates.map((option) => ({
    ...option,
    brand: resolveProviderBrand(option.value),
  }))
  if (!options.some((option) => option.value === draft.value.brand)) {
    options.unshift({
      value: draft.value.brand,
      label: `${draft.value.brand}`,
      brand: resolveProviderBrand(draft.value.brand),
    })
  }
  return options
})
const replacements = computed(() =>
  props.connections
    .filter((item) => item.id !== selectedId.value)
    .map((item) => ({ value: item.id, label: item.name })),
)
const protocols = [
  {
    value: 'openai',
    get label() {
      return __t('ui.settings', 'OpenAI 兼容')
    },
  },
  {
    value: 'anthropic',
    get label() {
      return __t('ui.settings', 'Anthropic 原生')
    },
  },
  {
    value: 'gemini',
    get label() {
      return __t('ui.settings', 'Gemini 原生')
    },
  },
]
const protocolNames = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }
const authModes = [
  { value: 'api_key', label: 'API Key' },
  {
    value: 'none',
    get label() {
      return __t('ui.settings', '无需认证')
    },
  },
]

async function select(id: string): Promise<void> {
  if (loading.value || saving.value) return
  if (id && id === selectedId.value) return
  if (dirty.value) {
    pendingSelection.value = id
    return
  }
  await load(id)
}
async function load(id: string): Promise<void> {
  const request = ++sequence
  selectedId.value = id
  error.value = ''
  removing.value = false
  replacementId.value = ''
  draft.value = emptyDraft()
  baseline.value = JSON.stringify(draft.value)
  if (!id) return
  loading.value = true
  try {
    const value = (await providerApi.get(id)).data
    if (!value) throw new Error('未能读取服务商连接')
    if (sequence !== request) return
    const { name, brand, protocol, apiBase, authMode, apiKey } = value
    draft.value = { name, brand, protocol, apiBase, authMode, apiKey }
    baseline.value = JSON.stringify(draft.value)
  } catch (failure) {
    if (sequence === request) error.value = (failure as Error).message
  } finally {
    if (sequence === request) loading.value = false
  }
}
function applyTemplate(value: string | number): void {
  const brand = String(value)
  if (brand === draft.value.brand) return
  draft.value.apiKey = ''
  draft.value.brand = brand
  draft.value.protocol =
    brand === 'gemini' ? 'gemini' : brand === 'anthropic' ? 'anthropic' : 'openai'
  draft.value.apiBase = props.defaults[brand] ?? ''
  draft.value.authMode = brand === 'ollama' ? 'none' : 'api_key'
  if (!draft.value.name)
    draft.value.name = props.templates.find((item) => item.value === brand)?.label ?? ''
}
async function save(): Promise<void> {
  if (saving.value || loading.value || error.value) return
  saving.value = true
  const initialDraft = JSON.stringify(draft.value)
  const input = {
    ...draft.value,
    name: draft.value.name.trim(),
    apiBase: draft.value.apiBase.trim().replace(/\/+$/, ''),
    apiKey: draft.value.authMode === 'none' ? '' : draft.value.apiKey.trim(),
  }
  try {
    const response = selectedId.value
      ? await providerApi.update(selectedId.value, input)
      : await providerApi.create(input)
    const id = response.data?.id
    if (!id) throw new Error('保存连接未返回标识')
    if (JSON.stringify(draft.value) === initialDraft) draft.value = input
    baseline.value = JSON.stringify(input)
    selectedId.value = id
    emit('changed')
    notify.toast(__t('ui.settings', '连接已保存'), 'success')
  } catch (failure) {
    notify.toast(__t('ui.settings', '保存连接失败：') + (failure as Error).message, 'error')
  } finally {
    saving.value = false
  }
}
async function remove(): Promise<void> {
  if (!selectedId.value || saving.value || (current.value?.models.length && !replacementId.value))
    return
  saving.value = true
  try {
    await providerApi.remove(selectedId.value, replacementId.value || undefined)
    baseline.value = JSON.stringify(draft.value)
    await load('')
    emit('changed')
    notify.toast(__t('ui.settings', '连接已删除'), 'success')
  } catch (failure) {
    notify.toast(__t('ui.settings', '删除连接失败：') + (failure as Error).message, 'error')
  } finally {
    saving.value = false
  }
}
function close(): void {
  if (saving.value) return
  if (dirty.value) {
    pendingSelection.value = '__close__'
    return
  }
  emit('update:modelValue', false)
}
async function discard(): Promise<void> {
  const target = pendingSelection.value
  pendingSelection.value = null
  if (target === '__close__') emit('update:modelValue', false)
  else if (target !== null) await load(target)
}
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      pendingSelection.value = null
      void load(props.connections[0]?.id ?? '')
    } else {
      sequence++
      loading.value = false
      draft.value.apiKey = ''
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  sequence++
})
</script>

<template>
  <PDialog
    :model-value="modelValue"
    :title="__t('ui.settings', '服务商连接')"
    width="min(1000px, calc(100vw - 32px))"
    :body-scroll="false"
    :loading="saving"
    :auto-close="false"
    @update:model-value="close"
  >
    <div class="provider-manager">
      <aside class="provider-list">
        <div class="provider-list__toolbar">
          <span class="provider-list__heading">
            {{ __t('ui.settings', '连接') }}
            <small>{{ connections.length }}</small>
          </span>
          <PButton
            size="sm"
            variant="ghost"
            :disabled="loading || saving"
            :aria-label="__t('ui.settings', '新建连接')"
            @click="select('')"
          >
            <PixelIcon name="plus" size="xs" />
            {{ __t('ui.settings', '新建') }}
          </PButton>
        </div>
        <MotionList
          class="provider-list__items"
          role="group"
          tabindex="0"
          :aria-label="__t('ui.settings', '服务商连接')"
        >
          <button
            v-for="item in connections"
            :key="item.id"
            type="button"
            class="provider-item"
            :class="{ active: item.id === selectedId }"
            :aria-pressed="item.id === selectedId"
            :disabled="loading || saving"
            @click="select(item.id)"
          >
            <span class="provider-item__brand">
              <BrandIcon
                :brand="resolveProviderBrand(item.brand, item.apiBase)"
                size="md"
                fallback="provider"
              />
            </span>
            <span class="provider-item__copy">
              <strong :title="item.name">{{ item.name }}</strong>
              <span class="provider-item__meta">
                <span class="provider-item__protocol">{{ protocolNames[item.protocol] }}</span>
                <span>{{ item.models.length }} {{ __t('ui.settings', '模型') }}</span>
              </span>
            </span>
            <PixelIcon
              v-if="item.id === selectedId"
              class="provider-item__selected"
              name="check"
              size="xs"
              aria-hidden="true"
            />
          </button>
          <p v-if="!connections.length" key="empty" class="provider-list__empty">
            {{ __t('ui.settings', '暂无连接') }}
          </p>
        </MotionList>
      </aside>
      <section
        class="provider-detail"
        tabindex="0"
        :aria-label="selectedId ? __t('ui.settings', '编辑连接') : __t('ui.settings', '新建连接')"
        :aria-busy="loading"
      >
        <p v-if="loading" role="status">{{ __t('ui.settings', '正在读取连接…') }}</p>
        <div v-else-if="error" class="provider-error" role="alert">
          {{ error }}
          <PButton size="sm" variant="ghost" @click="load(selectedId)">
            {{ __t('ui.settings', '重新读取') }}
          </PButton>
        </div>
        <template v-else>
          <header>
            <h3>
              {{ selectedId ? __t('ui.settings', '编辑连接') : __t('ui.settings', '新建连接') }}
            </h3>
            <span v-if="dirty" class="provider-hint">{{ __t('ui.settings', '未保存') }}</span>
          </header>
          <label>
            {{ __t('ui.settings', '连接名称') }}
            <PInput
              v-model="draft.name"
              :disabled="saving"
              :placeholder="__t('ui.settings', '如：主用、备用、本地')"
            />
          </label>
          <label>
            {{ __t('ui.settings', '品牌模板') }}
            <BrandSelect
              :model-value="draft.brand"
              :options="templateOptions"
              :disabled="saving"
              fallback="provider"
              teleport
              @change="applyTemplate"
            />
            <small>{{ __t('ui.settings', '切换模板会重置地址、协议和密钥。') }}</small>
          </label>
          <div class="provider-fields">
            <label>
              {{ __t('ui.settings', '请求协议') }}
              <PSelect v-model="draft.protocol" :options="protocols" :disabled="saving" teleport />
            </label>
            <label>
              {{ __t('ui.settings', '认证方式') }}
              <PSelect v-model="draft.authMode" :options="authModes" :disabled="saving" teleport />
            </label>
          </div>
          <label>
            {{ __t('ui.settings', 'API 地址') }}
            <PInput
              v-model="draft.apiBase"
              :disabled="saving"
              placeholder="https://api.example.com/v1"
            />
            <small>{{ __t('ui.settings', '不包含 /chat/completions 等接口后缀。') }}</small>
          </label>
          <label v-if="draft.authMode === 'api_key'">
            API Key
            <PInput
              v-model="draft.apiKey"
              :disabled="saving"
              type="password"
              :placeholder="__t('ui.settings', '输入 API Key')"
            />
            <small>{{ __t('ui.settings', '留空将清除密钥。') }}</small>
          </label>
          <div class="provider-usage">
            <strong>{{ __t('ui.settings', '关联模型') }}</strong>
            <p>
              {{
                current?.models
                  .map(
                    (model) =>
                      model.name + (model.override ? __t('ui.settings', '（自定义连接）') : ''),
                  )
                  .join('、') || __t('ui.settings', '暂无关联模型')
              }}
            </p>
          </div>
          <ProviderConnectionChecks
            :connection-id="selectedId"
            :disabled="dirty || saving"
            :active="modelValue"
          />
          <section v-if="removing" class="provider-delete">
            <strong>{{ __t('ui.settings', '确认删除「') }}{{ current?.name }}」？</strong>
            <p v-if="current?.models.length">
              {{ __t('ui.settings', '请为') }} {{ current?.models.length }}
              {{ __t('ui.settings', '个关联模型选择替换连接。') }}
            </p>
            <PSelect
              v-if="current?.models.length"
              v-model="replacementId"
              :options="replacements"
              :disabled="saving"
              :placeholder="__t('ui.settings', '选择替换连接')"
              teleport
            />
            <p v-if="current?.models.length && !replacements.length">
              {{ __t('ui.settings', '请先添加其他连接。') }}
            </p>
            <div class="provider-actions">
              <PButton size="sm" variant="ghost" :disabled="saving" @click="removing = false">
                {{ __t('ui.settings', '取消删除') }}
              </PButton>
              <PButton
                size="sm"
                variant="danger"
                :disabled="saving || (!!current?.models.length && !replacementId)"
                @click="remove"
              >
                {{ __t('ui.settings', '确认删除') }}
              </PButton>
            </div>
          </section>
          <div class="provider-actions provider-save">
            <PButton
              v-if="selectedId && !removing"
              size="sm"
              variant="ghost"
              :disabled="saving"
              @click="removing = true"
            >
              {{ __t('ui.settings', '删除连接') }}
            </PButton>
            <PButton
              :disabled="saving || !draft.name.trim() || !draft.apiBase.trim()"
              :loading="saving"
              @click="save"
            >
              {{ selectedId ? __t('ui.settings', '保存连接') : __t('ui.settings', '创建连接') }}
            </PButton>
          </div>
        </template>
      </section>
    </div>
    <template #footer>
      <PButton variant="ghost" :disabled="saving" @click="close">
        {{ __t('ui.settings', '关闭') }}
      </PButton>
    </template>
  </PDialog>
  <PDialog
    :model-value="pendingSelection !== null"
    :title="__t('ui.settings', '尚有未保存的修改')"
    :message="__t('ui.settings', '切换或关闭会放弃当前修改。')"
    :confirm-text="__t('ui.settings', '放弃修改')"
    @confirm="discard"
    @update:model-value="
      (visible: boolean) => {
        if (!visible) pendingSelection = null
      }
    "
  />
</template>

<style scoped>
.provider-manager {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 228px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  height: min(70vh, 780px);
  height: min(70dvh, 780px);
  overflow: hidden;
  color: var(--ui-text-primary);
  font-size: 12px;
}
.provider-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 10px;
  padding-right: 16px;
  border-right: 1px solid var(--ui-border-subtle);
  overflow: hidden;
}
.provider-list__toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 3px;
}
.provider-list__heading {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ui-text-secondary);
  font-size: 11px;
  font-weight: 600;
}
.provider-list__heading small {
  min-width: 20px;
  padding: 1px 5px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 3px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.provider-list__items {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  gap: 5px;
  padding: 3px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.provider-list__empty {
  margin: 0;
  padding: 24px 10px;
  color: var(--ui-text-tertiary);
  font-size: 12px;
  text-align: center;
}
.provider-detail {
  min-height: 0;
  padding: 0 4px 4px 22px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.provider-detail > * {
  flex-shrink: 0;
}
.provider-detail header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.provider-detail h3 {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
}
.provider-hint,
.provider-detail small {
  color: var(--ui-text-muted);
  font-size: 11px;
  line-height: 1.8;
}
.provider-item {
  position: relative;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 12px;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  min-height: 66px;
  width: 100%;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-text-primary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}
.provider-item:hover:not(:disabled):not(.active) {
  border-color: var(--ui-border-subtle);
  background: var(--ui-bg-hover);
}
.provider-item.active {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 28%, var(--ui-border-subtle));
  background:
    linear-gradient(
      100deg,
      color-mix(in srgb, var(--ui-accent-purple) 10%, transparent),
      transparent
    ),
    var(--ui-bg-surface-soft);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ui-text-primary) 3%, transparent);
}
.provider-item.active::before {
  position: absolute;
  top: 14px;
  bottom: 14px;
  left: -1px;
  width: 3px;
  border-radius: 2px;
  background: var(--ui-accent-purple);
  content: '';
}
.provider-item:focus-visible {
  outline: 2px solid var(--ui-accent-purple);
  outline-offset: 1px;
}
.provider-item:disabled {
  cursor: wait;
  opacity: 0.65;
}
.provider-item__brand {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  background: var(--ui-bg-surface);
}
.provider-item__copy {
  display: grid;
  min-width: 0;
  gap: 5px;
}
.provider-item__copy strong {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-item__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 7px;
  color: var(--ui-text-tertiary);
  font-size: 10px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.provider-item__protocol {
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ui-text-primary) 5%, transparent);
  color: var(--ui-text-secondary);
  font-size: 9px;
}
.provider-item__selected {
  color: var(--ui-accent-purple);
}
.provider-detail label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-weight: 600;
}
.provider-detail label small {
  font-weight: 400;
}
.provider-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.provider-usage,
.provider-delete {
  border: 1px solid var(--ui-border-default);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.provider-detail p {
  margin: 0;
  line-height: 1.8;
}
.provider-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.provider-save {
  justify-content: flex-end;
  padding-bottom: 2px;
}
.provider-delete {
  border-color: var(--ui-accent-rose);
}
.provider-error {
  color: var(--ui-accent-rose);
}
@media (max-width: 680px) {
  .provider-manager {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(92px, min(26vh, 190px)) minmax(0, 1fr);
    grid-template-rows: minmax(92px, min(26dvh, 190px)) minmax(0, 1fr);
  }
  .provider-list {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border-subtle);
    padding: 0 0 12px;
  }
  .provider-list__items {
    flex: 1 1 0;
  }
  .provider-detail {
    padding: 18px 4px 4px 0;
  }
  .provider-fields {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .provider-item {
    transition: none;
  }
}
</style>
