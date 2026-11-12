<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/**
 * 桌面操作 → 分区与信任名单（阶段 2，仅 Electron 主应用）
 *
 * - 查看内置名单（草案）、自己追加的禁区 / 高危区与信任名单；撤销信任、调严普通区权限立即生效。
 * - 放宽（调松普通区权限、接受文件中的放宽改动）一律由主进程弹出原生确认框，页面无法代替用户确认。
 * - 名单保存在用户数据目录的 desktop-safety.json，可在文件夹中打开手动编辑；在应用外修改后需在这里接受。
 *
 * @see .docs/P03_DESKTOP_SHELL.md 阶段 2
 */
import { computed, onMounted, onUnmounted, onActivated, ref } from 'vue'
import type {
  DesktopNormalMode,
  DesktopSafetyIssue,
  DesktopProgramLists,
  DesktopSafetySettings as SafetySettings,
} from '@infos/shared'
import { invoke, isElectron, isToastOverlay } from '../../utils/ipcAdapter'
import { PButton, PSelect } from '../pixel'

interface SafetyState {
  draftStatus: string
  draftValid: boolean
  draftIssues: DesktopSafetyIssue[]
  draft: DesktopProgramLists | null
  settings: SafetySettings
  externalEdit: boolean
  fileIssues: DesktopSafetyIssue[]
  filePath: string
}

const enabled = isElectron() && !isToastOverlay() && window.electron?.embedded !== true
const state = ref<SafetyState | null>(null)
const busy = ref(false)
const error = ref('')

const modeOptions = computed(() => [
  { value: 'notify', label: __t('ui.desktop', '只提醒') },
  { value: 'once', label: __t('ui.desktop', '每个程序问一次') },
  { value: 'always', label: __t('ui.desktop', '每次都问') },
])

function issueLabel(code: DesktopSafetyIssue['code']): string {
  switch (code) {
    case 'SIGNATURE_INVALID':
      return __t('ui.desktop', '设置签名无效或版本已过期')
    case 'BASELINE_INVALID':
      return __t('ui.desktop', '受信设置基线无效，需要确认恢复')
    case 'NOT_OBJECT':
      return __t('ui.desktop', '不是有效的 JSON 对象')
    case 'UNSUPPORTED_VERSION':
      return __t('ui.desktop', '版本不受支持')
    case 'UNSUPPORTED_DRAFT_VERSION':
      return __t('ui.desktop', '名单结构版本不受支持，请使用 schemaVersion 2 的名单')
    case 'DUPLICATE_ENTRY':
      return __t('ui.desktop', '名单条目重复')
    case 'CONFLICTING_ENTRY':
      return __t('ui.desktop', '名单分区或宿主引用冲突')
    case 'UNKNOWN_FIELD':
      return __t('ui.desktop', '未知字段')
    case 'INVALID_MODE':
      return __t('ui.desktop', '普通区权限无效')
    case 'INVALID_LIST':
      return __t('ui.desktop', '应为列表')
    case 'INVALID_ENTRY':
      return __t('ui.desktop', '名单条目无效')
    case 'TOO_MANY_ENTRIES':
      return __t('ui.desktop', '条目过多')
    case 'TRUST_NOT_ALLOWED':
      return __t('ui.desktop', '禁区或高危区程序不能信任')
  }
}

function issueText(issue: DesktopSafetyIssue): string {
  return [issueLabel(issue.code), issue.field, issue.value ?? ''].filter(Boolean).join(' · ')
}

async function call(channel: string, value?: unknown): Promise<void> {
  busy.value = true
  try {
    const result = await invoke(channel, value)
    if (result && typeof result === 'object') state.value = result as SafetyState
    error.value = ''
  } catch (cause) {
    error.value = __t('ui.desktop', '桌面安全设置失败：{0}', [
      cause instanceof Error ? cause.message : String(cause),
    ])
  } finally {
    busy.value = false
  }
}

function setMode(value: string | number): void {
  void call('desktop-safety:set-normal-mode', value as DesktopNormalMode)
}

function refresh(): void {
  if (enabled && !busy.value && document.visibilityState !== 'hidden')
    void call('desktop-safety:get')
}
onMounted(() => {
  refresh()
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
})
onActivated(refresh)
onUnmounted(() => {
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <div v-if="enabled && (error || !state)" class="desktop-safety">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else role="status">{{ __t('ui.desktop', '正在读取桌面安全设置…') }}</p>
    <PButton size="sm" :disabled="busy" @click="call('desktop-safety:get')">
      {{ __t('ui.desktop', '重新读取') }}
    </PButton>
  </div>
  <section v-if="enabled && state" class="desktop-safety">
    <h3 class="desktop-safety__summary">
      {{ __t('ui.desktop', '分区与信任名单') }}
      <span
        v-if="!state.draftValid || state.externalEdit || state.fileIssues.length"
        class="desktop-safety__alert"
      >
        {{ __t('ui.desktop', '需要处理') }}
      </span>
    </h3>

    <div v-if="state.externalEdit" class="desktop-safety__notice" role="alert">
      <p>
        {{
          __t(
            'ui.desktop',
            '设置文件在应用外被修改。收紧的部分已生效，放宽的部分要你确认后才生效。',
          )
        }}
      </p>
      <div class="flex gap-1.5">
        <PButton
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="call('desktop-safety:accept-external')"
        >
          {{ __t('ui.desktop', '接受修改') }}
        </PButton>
        <PButton
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="call('desktop-safety:discard-external')"
        >
          {{ __t('ui.desktop', '撤销修改') }}
        </PButton>
      </div>
    </div>
    <div v-if="state.fileIssues.length" class="desktop-safety__notice" role="alert">
      <p>{{ __t('ui.desktop', '设置文件有错误，已保守限制为逐次确认；恢复需要你确认：') }}</p>
      <p v-for="issue in state.fileIssues" :key="issueText(issue)" class="desktop-safety__mono">
        {{ issueText(issue) }}
      </p>
      <PButton size="sm" :disabled="busy" @click="call('desktop-safety:discard-external')">
        {{ __t('ui.desktop', '确认恢复当前安全设置') }}
      </PButton>
    </div>

    <div class="desktop-safety__row">
      <span>{{ __t('ui.desktop', '普通区权限') }}</span>
      <PSelect
        :model-value="state.settings.normalMode"
        :options="modeOptions"
        :disabled="busy"
        @update:model-value="setMode"
      />
    </div>

    <div class="desktop-safety__block">
      <span>{{ __t('ui.desktop', '信任名单') }}</span>
      <p v-if="!state.settings.trusted.length" class="desktop-safety__muted">
        {{ __t('ui.desktop', '空') }}
      </p>
      <div v-for="program in state.settings.trusted" :key="program" class="desktop-safety__row">
        <span class="desktop-safety__mono">{{ program }}</span>
        <PButton
          size="sm"
          variant="ghost"
          :disabled="busy"
          @click="call('desktop-safety:untrust', program)"
        >
          {{ __t('ui.desktop', '撤销信任') }}
        </PButton>
      </div>
    </div>

    <div
      v-if="state.settings.forbidden.length || state.settings.mustConfirm.length"
      class="desktop-safety__block"
    >
      <span>{{ __t('ui.desktop', '自己追加的名单') }}</span>
      <p v-if="state.settings.forbidden.length" class="desktop-safety__muted">
        {{ __t('ui.desktop', '禁区：{0}', [state.settings.forbidden.join('、')]) }}
      </p>
      <p v-if="state.settings.mustConfirm.length" class="desktop-safety__muted">
        {{ __t('ui.desktop', '高危区：{0}', [state.settings.mustConfirm.join('、')]) }}
      </p>
    </div>

    <div class="desktop-safety__block">
      <span>{{ __t('ui.desktop', '内置保护名单') }}</span>
      <p v-if="!state.draftValid" class="desktop-safety__notice" role="alert">
        {{ __t('ui.desktop', '内置名单无效，所有程序按高危区处理。') }}
      </p>
      <p
        v-for="(issue, index) in state.draftIssues"
        :key="`draft-${index}`"
        class="desktop-safety__notice"
      >
        {{ issueText(issue) }}
      </p>
      <details v-if="state.draft" class="desktop-safety__details">
        <summary>{{ __t('ui.desktop', '查看内置保护程序名单') }}</summary>
        <div class="desktop-safety__details-body">
          <p
            v-for="(programs, group) in state.draft.forbidden"
            :key="`f-${group}`"
            class="desktop-safety__muted"
          >
            {{
              __t('ui.desktop', '禁区 · {0}：{1}', [__t('ui.desktop', group), programs.join('、')])
            }}
          </p>
          <p
            v-for="(programs, group) in state.draft.mustConfirm"
            :key="`c-${group}`"
            class="desktop-safety__muted"
          >
            {{
              __t('ui.desktop', '高危区 · {0}：{1}', [
                __t('ui.desktop', group),
                programs.join('、'),
              ])
            }}
          </p>
        </div>
      </details>
    </div>

    <div class="desktop-safety__row">
      <p class="desktop-safety__muted">
        {{ __t('ui.desktop', '终端与脚本每次均需确认，禁区程序一律拦截。') }}
      </p>
      <PButton
        size="sm"
        variant="secondary"
        :disabled="busy"
        @click="call('desktop-safety:show-file')"
      >
        {{ __t('ui.desktop', '打开配置文件目录') }}
      </PButton>
    </div>
  </section>
</template>

<style scoped>
.desktop-safety {
  color: var(--ui-text-primary);
}
.desktop-safety__summary {
  font: 13px/1.5 var(--ui-font-pixel);
}
.desktop-safety__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
}
.desktop-safety__block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}
.desktop-safety__muted {
  font-size: 11px;
  color: var(--ui-text-secondary);
}
.desktop-safety__mono {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}
.desktop-safety__alert {
  margin-left: 6px;
  font-size: 10px;
  color: var(--ui-danger, #d9534f);
}
.desktop-safety__notice {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ui-danger, #d9534f);
}
.desktop-safety__details {
  margin-top: 4px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: var(--ui-radius-xs);
  background: var(--ui-bg-surface-soft);
}
.desktop-safety__details summary {
  padding: 7px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ui-text-secondary);
  cursor: pointer;
  user-select: none;
}
.desktop-safety__details summary:hover {
  color: var(--ui-text-primary);
}
.desktop-safety__details-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--ui-border-subtle);
}
</style>
