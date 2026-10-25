<script setup lang="ts">
import { t as __t } from '../../i18n/index'

import { computed, ref, watch } from 'vue'
import { PixelIcon, PCard, PInput, PButton } from '../pixel'
import { useWeather } from '../../composables/useWeather'
import {
  registerSettingsParticipant,
  useSystemSettingsPage,
} from '../../composables/ui/useSystemSettingsPage'

const props = withDefaults(defineProps<{ settings?: boolean }>(), { settings: false })
const { status, loaded, saving, error, setLocation } = useWeather()
const editing = ref(props.settings)
const expanded = ref(false)
const draft = ref('')
const page = props.settings ? useSystemSettingsPage() : undefined
registerSettingsParticipant(page, {
  capture: () => {
    const location = draft.value.trim()
    if (location === status.value.query) return {}
    return {
      persist: async () => {
        if (!(await setLocation(location)))
          throw new Error(error.value || __t('ui.weather', '城市未保存，请检查地点或稍后重试'))
      },
    }
  },
})
const snapshot = computed(() => status.value.snapshot)
function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const today = computed(() =>
  snapshot.value?.days.find((day) => day.date === localDateKey(new Date())),
)
function forecastDateLabel(date: string): string {
  const day = new Date()
  for (const label of ['今天', '明天', '后天']) {
    if (date === localDateKey(day)) return `${label} ${date.slice(5).replace('-', '/')}`
    day.setDate(day.getDate() + 1)
  }
  return date.slice(5).replace('-', '/')
}
const updated = computed(() => {
  if (!snapshot.value) return ''
  return new Date(snapshot.value.fetchedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
})
watch(
  () => status.value.query,
  (value, previous) => {
    if (previous === undefined || draft.value === previous) draft.value = value
  },
  { immediate: true },
)
function edit(): void {
  draft.value = status.value.query
  editing.value = !editing.value
}
async function save(): Promise<void> {
  if (page ? await page.save() : await setLocation(draft.value)) editing.value = props.settings
}
async function clear(): Promise<void> {
  if (page) {
    draft.value = ''
    await page.save()
  } else if (await setLocation('')) draft.value = ''
}
const symbol = computed(() => {
  switch (snapshot.value?.kind) {
    case 'rain':
      return 'M3 3h8v2h2v4H2V5h1z M3 11h2v3H3z M7 12h2v3H7z M11 11h2v3h-2z'
    case 'snow':
      return 'M3 2h8v2h2v4H2V4h1z M3 10h2v2H3z M7 12h2v2H7z M11 10h2v2h-2z'
    case 'thunder':
      return 'M3 2h8v2h2v4H2V4h1z M8 8h3l-2 3h2l-5 5 1-5H5z'
    case 'cloud':
      return 'M4 4h5v2h3v2h2v5H2V7h2z'
    case 'mist':
      return 'M2 3h9v2H2z M4 7h10v2H4z M1 11h10v2H1z'
    default:
      return 'M6 0h3v3H6z M6 12h3v3H6z M0 6h3v3H0z M12 6h3v3h-3z M4 4h7v7H4z M1 1h2v2H1z M12 1h2v2h-2z M1 12h2v2H1z M12 12h2v2h-2z'
  }
})
</script>

<template>
  <PCard
    pixel
    :padding="settings ? 'lg' : 'md'"
    class="weather-card"
    :class="{ 'weather-card--settings': settings }"
    role="region"
    :aria-label="__t('ui.weather', '天气')"
    :aria-busy="saving || status.refreshing"
  >
    <div class="weather-topline">
      <h3 class="weather-caption">
        <PixelIcon name="sun" size="sm" />
        <span>{{ __t('ui.weather', '天气') }}</span>
      </h3>
      <span v-if="status.refreshing" class="weather-updating">
        {{ __t('ui.weather', '更新中') }}
      </span>
      <button
        v-if="!settings"
        type="button"
        class="weather-edit"
        :aria-expanded="editing"
        @click="edit"
      >
        {{ status.query ? __t('ui.weather', '更换城市') : __t('ui.weather', '设置城市') }}
      </button>
    </div>
    <button
      v-if="snapshot"
      type="button"
      class="weather-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <svg
        class="weather-symbol"
        viewBox="0 0 16 16"
        aria-hidden="true"
        shape-rendering="crispEdges"
      >
        <path :d="symbol" fill="currentColor" />
      </svg>
      <span class="weather-place">
        <strong>{{ status.query }}</strong>
        <span>
          {{ __t('ui.weather', '当前 ·') }} {{ __t('ui.weather', snapshot.condition) }}
          <span v-if="status.stale">{{ __t('ui.weather', '· 已过期') }}</span>
        </span>
      </span>
      <span class="weather-temperature">
        {{ snapshot.temperature }}
        <small>°C</small>
      </span>
      <PixelIcon :name="expanded ? 'chevron-up' : 'chevron-down'" size="xs" />
    </button>
    <p v-else class="weather-empty">
      {{
        status.query
          ? status.error || __t('ui.weather', '正在获取天气…')
          : loaded
            ? __t('ui.weather', '设置城市，看看今天的天气')
            : error || __t('ui.weather', '正在读取天气…')
      }}
    </p>
    <div v-if="today" class="weather-range">
      <span>{{ today.low }}～{{ today.high }}°C</span>
      <span v-if="today.rainChance !== null">
        {{ __t('ui.weather', '降水') }} {{ today.rainChance }}%
      </span>
    </div>
    <div v-if="expanded && snapshot" class="weather-details">
      <div class="weather-metrics">
        <span>{{ __t('ui.weather', '体感') }} {{ snapshot.feelsLike }}°C</span>
        <span>{{ __t('ui.weather', '湿度') }} {{ snapshot.humidity }}%</span>
        <span>{{ __t('ui.weather', '风速') }} {{ snapshot.windKmh }} km/h</span>
      </div>
      <p class="weather-forecast-caption">{{ __t('ui.weather', '三日预报') }}</p>
      <div v-for="day in snapshot.days" :key="day.date" class="weather-day">
        <time :datetime="day.date">{{ forecastDateLabel(day.date) }}</time>
        <span>{{ __t('ui.weather', day.condition) }}</span>
        <span>{{ day.low }}～{{ day.high }}°C</span>
      </div>
      <p>
        {{ __t('ui.weather', '匹配地点：') }}{{ snapshot.location }} · {{ snapshot.latitude }},
        {{ snapshot.longitude }}
      </p>
      <p>
        {{ __t('ui.weather', '上游观测时间：') }}{{ snapshot.observedTime
        }}{{ __t('ui.weather', '（未提供完整日期与时区）') }}
      </p>
    </div>
    <form v-if="editing" class="weather-form" @submit.prevent="save">
      <label>
        {{ __t('ui.weather', '所在城市') }}
        <PInput
          v-model="draft"
          maxlength="80"
          :placeholder="__t('ui.weather', '如 上海、上海杨浦 或 31.23,121.47')"
          :disabled="saving || page?.disabled.value"
        />
      </label>
      <div class="weather-actions">
        <PButton
          type="submit"
          :size="settings ? 'md' : 'sm'"
          :disabled="saving || page?.disabled.value || !draft.trim()"
        >
          {{ saving ? __t('ui.weather', '保存中…') : __t('ui.weather', '保存') }}
        </PButton>
        <PButton
          v-if="status.query"
          type="button"
          variant="secondary"
          :size="settings ? 'md' : 'sm'"
          :disabled="saving || page?.disabled.value"
          @click="clear"
        >
          {{ __t('ui.weather', '清除') }}
        </PButton>
        <PButton
          v-if="!settings"
          type="button"
          variant="ghost"
          size="sm"
          :disabled="saving"
          @click="editing = false"
        >
          {{ __t('ui.weather', '取消') }}
        </PButton>
      </div>
    </form>
    <p v-if="error || (snapshot && status.error)" class="weather-error" role="status">
      {{ error || status.error }}
    </p>
    <div v-if="snapshot" class="weather-source">
      <a href="https://wttr.in" target="_blank" rel="noopener noreferrer">wttr.in</a>
      <span>
        {{ updated }} {{ __t('ui.weather', '获取') }}
        <span v-if="status.stale">{{ __t('ui.weather', '· 待更新') }}</span>
      </span>
    </div>
  </PCard>
</template>

<style scoped>
/* 使用页面现有的卡片与表单组件，配色随主应用主题变化。 */
.weather-card {
  --weather-muted: var(--ui-text-secondary);
  --weather-accent: var(--ui-accent-sky);
  --weather-divider: var(--ui-border-subtle);
  min-width: 0;
  font-size: 12px;
  line-height: 1.6;
}
.weather-topline,
.weather-range,
.weather-actions,
.weather-source,
.weather-metrics {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.weather-topline {
  gap: 8px;
}
.weather-caption {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--ui-text-primary);
  font-family: var(--ui-font-pixel);
  font-size: 14px;
  font-weight: 900;
}
.weather-updating {
  color: var(--weather-muted);
  font-size: 10px;
}
.weather-edit,
.weather-summary {
  font: inherit;
  color: inherit;
  border-radius: 0;
  cursor: pointer;
}
.weather-edit {
  margin-left: auto;
  border: 0;
  padding: 2px 0;
  background: transparent;
  color: var(--weather-muted);
  font-size: 11px;
}
.weather-edit:hover {
  color: var(--weather-accent);
}
.weather-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  border: 0;
  background: transparent;
  text-align: left;
  padding: 12px 0 6px;
}
.weather-symbol {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  color: var(--weather-accent);
}
.weather-place {
  flex: 1;
  min-width: 0;
}
.weather-place strong {
  display: block;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.weather-place > span {
  color: var(--weather-muted);
  font-size: 11px;
}
.weather-temperature {
  font-size: 32px;
  line-height: 1;
  white-space: nowrap;
  font-family: var(--ui-font-pixel);
}
.weather-temperature small {
  font-size: 13px;
  vertical-align: top;
  margin-left: 3px;
}
.weather-range {
  color: var(--weather-muted);
  font-size: 11px;
}
.weather-empty {
  margin: 12px 0 4px;
  color: var(--weather-muted);
}
.weather-details,
.weather-form {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--weather-divider);
}
.weather-details p {
  margin: 8px 0 0;
  font-size: 10px;
  color: var(--weather-muted);
  overflow-wrap: anywhere;
}
.weather-metrics {
  font-size: 11px;
  margin-bottom: 8px;
}
.weather-day {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr) auto;
  gap: 10px;
  font-size: 11px;
  padding: 4px 0;
}
.weather-form label {
  display: block;
  color: var(--weather-muted);
  flex: 1;
  min-width: min(100%, 240px);
  font-size: 12px;
  font-weight: 700;
}
.weather-form :deep(.p-input) {
  display: block;
  box-sizing: border-box;
  margin-top: 8px;
}
.weather-form {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.weather-actions {
  gap: 8px;
  padding-bottom: 3px;
}
.weather-edit:focus-visible,
.weather-summary:focus-visible {
  outline: 2px solid var(--weather-accent);
  outline-offset: 3px;
}
.weather-error {
  color: var(--weather-muted);
  font-size: 11px;
  margin: 8px 0 0;
}
.weather-source {
  justify-content: space-between;
  margin-top: 10px;
  color: var(--weather-muted);
  font-size: 10px;
}
.weather-source a {
  color: inherit;
  text-decoration: none;
}
.weather-source a:hover {
  color: var(--weather-accent);
}
.weather-card--settings .weather-topline {
  padding-bottom: 12px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--weather-divider);
}
.weather-card--settings .weather-form {
  max-width: 700px;
  margin-top: 16px;
  padding-top: 0;
  border-top: 0;
}
.weather-card--settings :is(.weather-summary, .weather-range, .weather-details, .weather-source) {
  max-width: 560px;
}
</style>
