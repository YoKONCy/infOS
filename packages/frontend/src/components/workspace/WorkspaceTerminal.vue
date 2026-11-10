<script setup lang="ts">
import { t as __t } from '../../i18n/index'

/** 多终端工作视窗：轮询增量输出，支持输入、中断、强杀与关闭。 */
import { computed, ref, watch, nextTick, onActivated, onDeactivated, onUnmounted } from 'vue'
import { PixelIcon } from '../pixel'
import { useEventListener } from '../../composables'
import { computeDropdownPlacement } from '../../lib/floatingPlacement'
import WorkspaceTerminalScreen from './WorkspaceTerminalScreen.vue'
import { terminalsApi, type TerminalInfo } from '../../api/modules/approvalsApi'
import { useNotificationStore } from '../../stores'
import { ApiError } from '../../api/errors'

const props = defineProps<{ agentId: string; threadId: string }>()
const emit = defineEmits<{ active: [terminalId: string] }>()
const notification = useNotificationStore()

interface TerminalState extends TerminalInfo {
  output: string
  cursor: number
  unread: boolean
  drained: boolean
  outputOffset: number
}
const items = ref<TerminalState[]>([])
const history = ref<TerminalInfo[]>([])
const shown = ref(true)
const tabRail = ref<HTMLElement>()
const tabs = computed(() => items.value.filter((item) => !item.archivedAt))
const activeId = ref('')
const input = ref('')
const activeTerminal = computed(() => items.value.find((item) => item.id === activeId.value))
const connectionError = ref('')
const blocked = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
let visible = true
let disposed = false
let inputQueue: Promise<unknown> = Promise.resolve()
const resizeVersions = new Map<string, number>()

/** 菜单用 fixed 定位：终端区很矮时不会被自身的 overflow: hidden 裁掉，放不下就向上翻。 */
function placeMenu(details: HTMLDetailsElement): void {
  const summary = details.querySelector('summary')
  const panel = details.querySelector<HTMLElement>('.terminal-menu__panel')
  if (!details.open || !summary || !panel) return
  const rect = summary.getBoundingClientRect()
  const width = panel.offsetWidth
  const placed = computeDropdownPlacement({
    // 菜单和触发器右对齐。
    anchor: { top: rect.top, bottom: rect.bottom, left: rect.right - width, right: rect.right },
    contentHeight: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
    width,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    gap: 0,
  })
  panel.style.left = `${placed.left}px`
  panel.style.maxHeight = `${placed.maxHeight}px`
  panel.style.top = placed.top === null ? 'auto' : `${placed.top}px`
  panel.style.bottom = placed.bottom === null ? 'auto' : `${placed.bottom}px`
}

useEventListener(window, 'resize', () => {
  document
    .querySelectorAll<HTMLDetailsElement>('.work-terminal .terminal-menu[open]')
    .forEach(placeMenu)
})

function session() {
  return { agentId: props.agentId, threadId: props.threadId }
}

type SessionRef = ReturnType<typeof session>

function isCurrent(requestGeneration: number): boolean {
  return !disposed && visible && requestGeneration === generation
}

function stopTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function recordError(error: unknown, requestGeneration: number): void {
  if (!isCurrent(requestGeneration)) return
  connectionError.value = error instanceof Error ? error.message : '终端连接失败'
  blocked.value =
    error instanceof ApiError &&
    ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'TOKEN_EXPIRED'].includes(error.code)
  if (blocked.value) {
    stopTimer()
    items.value = []
    select('')
  }
}

async function refreshList(scope: SessionRef, requestGeneration: number): Promise<void> {
  const res = await terminalsApi.list(scope)
  if (!isCurrent(requestGeneration)) return
  const known = new Map(items.value.map((item) => [item.id, item]))
  history.value = res.data?.history ?? []
  const selectedHistory = history.value.find((item) => item.id === activeId.value)
  items.value = [...(res.data?.terminals ?? []), ...(selectedHistory ? [selectedHistory] : [])].map(
    (info) => {
      const old = known.get(info.id)
      return {
        ...info,
        output: old?.output ?? '',
        cursor: old?.cursor ?? Math.max(0, (info.outputLength ?? 0) - 128_000),
        outputOffset: old?.outputOffset ?? 0,
        unread: old?.unread ?? false,
        drained: old?.drained ?? false,
      }
    },
  )
  if (!items.value.some((item) => item.id === activeId.value)) select(items.value[0]?.id ?? '')
}

/** 创建当前平台的交互式系统 Shell（Windows 为 PowerShell）。 */
async function create(): Promise<void> {
  if (blocked.value || !props.agentId || !props.threadId) return
  const requestGeneration = generation
  const scope = session()
  try {
    const res = await terminalsApi.create(scope, { cols: 120, rows: 30 })
    if (!isCurrent(requestGeneration)) return
    if (res.data)
      items.value.push({
        ...res.data,
        output: '',
        cursor: 0,
        unread: false,
        drained: false,
        outputOffset: 0,
      })
    if (res.data) select(res.data.id)
  } catch (error) {
    if (!isCurrent(requestGeneration)) return
    recordError(error, requestGeneration)
    notification.toast(
      __t('ui.workspace', '新建终端失败：{0}', [
        error instanceof Error ? error.message : __t('ui.workspace', '未知错误'),
      ]),
      {
        type: 'error',
      },
    )
  }
}

function select(id: string): void {
  activeId.value = id
  const item = items.value.find((entry) => entry.id === id)
  if (item) item.unread = false
  emit('active', id)
  void nextTick(() =>
    tabRail.value
      ?.querySelector('.terminal-tab.active')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
  )
}

async function poll(requestGeneration: number): Promise<void> {
  if (!isCurrent(requestGeneration) || blocked.value || !props.agentId || !props.threadId) return
  const scope = session()
  try {
    // 本次列表和增量读取固定使用同一身份，切换会话后的旧响应直接丢弃。
    await refreshList(scope, requestGeneration)
    if (!isCurrent(requestGeneration)) return
    connectionError.value = ''
    for (const item of [...items.value].sort(
      (a, b) => Number(b.id === activeId.value) - Number(a.id === activeId.value),
    )) {
      if (item.drained && item.status !== 'running') continue
      try {
        const res = await terminalsApi.read(scope, item.id, item.cursor)
        if (!isCurrent(requestGeneration)) return
        if (!res.data) continue
        if (res.data.droppedChars) {
          item.output += `\n[系统] 输出过快，已丢弃 ${res.data.droppedChars} 个历史字符。\n`
        }
        if (res.data.output) {
          item.output += res.data.output
          if (activeId.value !== item.id) item.unread = true
        }
        if (item.output.length > 128_000) {
          const dropped = item.output.length - 128_000
          item.output = item.output.slice(dropped)
          item.outputOffset += dropped
        }
        item.cursor = res.data.nextCursor
        item.status = res.data.status
        item.exitCode = res.data.exitCode
        item.drained = res.data.status !== 'running' && !res.data.hasMore
      } catch (error) {
        if (
          error instanceof ApiError &&
          ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'TOKEN_EXPIRED'].includes(error.code)
        ) {
          recordError(error, requestGeneration)
          return
        }
        // 单个终端可能已被其他视图关闭，下轮刷新列表后移除。
      }
    }
  } catch (error) {
    recordError(error, requestGeneration)
  } finally {
    // 请求结束后才安排下一次，避免慢请求叠加；身份失效后等待用户重试。
    if (isCurrent(requestGeneration) && !blocked.value) {
      timer = setTimeout(() => void poll(requestGeneration), connectionError.value ? 3000 : 800)
    }
  }
}

/** 串行提交按键、协议响应与整行输入，避免 HTTP 请求并发打乱字符顺序。 */
function writeInput(id: string, data: string): Promise<boolean> {
  const requestGeneration = generation
  const scope = session()
  const operation = inputQueue.then(async () => {
    if (!isCurrent(requestGeneration) || blocked.value || !data) return false
    if (!items.value.some((item) => item.id === id && item.status === 'running')) return false
    try {
      await terminalsApi.write(scope, id, data)
      return isCurrent(requestGeneration)
    } catch (error) {
      recordError(error, requestGeneration)
      return false
    }
  })
  inputQueue = operation
  return operation
}

async function sendInput(): Promise<void> {
  if (!activeId.value || !input.value) return
  const text = input.value
  if ((await writeInput(activeId.value, `${text}\r`)) && input.value === text) input.value = ''
}

function resize(id: string, cols: number, rows: number): Promise<void> {
  const requestGeneration = generation
  const scope = session()
  const version = (resizeVersions.get(id) ?? 0) + 1
  resizeVersions.set(id, version)
  // 尺寸变化与输入共用顺序队列，拖动时尚未提交的旧尺寸直接跳过。
  const operation = inputQueue.then(async () => {
    if (!isCurrent(requestGeneration) || blocked.value || resizeVersions.get(id) !== version) return
    const item = items.value.find((entry) => entry.id === id)
    if (!item || item.status !== 'running' || (item.cols === cols && item.rows === rows)) return
    try {
      await terminalsApi.resize(scope, id, cols, rows)
      const current = items.value.find((entry) => entry.id === id)
      if (isCurrent(requestGeneration) && current) Object.assign(current, { cols, rows })
    } catch (error) {
      recordError(error, requestGeneration)
    }
  })
  inputQueue = operation
  return operation
}

async function action(
  id: string,
  actionName: 'interrupt' | 'kill' | 'close' | 'archive',
): Promise<void> {
  const requestGeneration = generation
  try {
    await terminalsApi.action(session(), id, actionName)
    if (!isCurrent(requestGeneration)) return
    if (actionName === 'close' || actionName === 'archive') {
      resizeVersions.delete(id)
      items.value = items.value.filter((item) => item.id !== id)
      if (activeId.value === id) select(items.value[0]?.id ?? '')
    }
  } catch (error) {
    recordError(error, requestGeneration)
  }
}

async function openHistory(item: TerminalInfo): Promise<void> {
  if (!items.value.some((entry) => entry.id === item.id))
    items.value.push({
      ...item,
      output: '',
      cursor: Math.max(0, (item.outputLength ?? 0) - 128_000),
      outputOffset: 0,
      unread: false,
      drained: false,
    })
  select(item.id)
  restart()
}

async function pin(): Promise<void> {
  const item = activeTerminal.value
  if (!item) return
  const requestGeneration = generation
  try {
    const response = await terminalsApi.pin(session(), item.id, !item.pinned)
    if (isCurrent(requestGeneration) && response.data) Object.assign(item, response.data)
  } catch (error) {
    recordError(error, requestGeneration)
  }
}

async function cleanup(
  actionName: 'archive_completed' | 'stop_agent' | 'close_all',
): Promise<void> {
  const requestGeneration = generation
  try {
    await terminalsApi.cleanup(session(), actionName)
    if (isCurrent(requestGeneration)) restart()
  } catch (error) {
    recordError(error, requestGeneration)
  }
}

function stepTab(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !tabs.value.length) return
  event.preventDefault()
  const index = tabs.value.findIndex((item) => item.id === activeId.value)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.value.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.value.length) % tabs.value.length
  select(tabs.value[next]!.id)
  void nextTick(() =>
    (tabRail.value?.querySelector('.terminal-tab.active [role="tab"]') as HTMLElement)?.focus(),
  )
}

function restart(clear = false): void {
  stopTimer()
  generation += 1
  blocked.value = false
  connectionError.value = ''
  if (clear) {
    inputQueue = Promise.resolve()
    resizeVersions.clear()
    items.value = []
    history.value = []
    input.value = ''
    select('')
  }
  if (visible && !disposed) void poll(generation)
}

watch(
  () => [props.agentId, props.threadId],
  () => restart(true),
  { immediate: true },
)
onActivated(() => {
  if (visible) return
  visible = true
  shown.value = true
  restart()
})
onDeactivated(() => {
  visible = false
  shown.value = false
  items.value = []
  history.value = []
  resizeVersions.clear()
  generation += 1
  stopTimer()
})
onUnmounted(() => {
  disposed = true
  generation += 1
  stopTimer()
})
</script>

<template>
  <div class="work-terminal">
    <div class="terminal-heading">
      <div
        ref="tabRail"
        class="work-terminal__tabs"
        role="tablist"
        :aria-label="__t('ui.workspace', '终端')"
        @keydown="stepTab"
      >
        <div
          v-for="item in tabs"
          :key="item.id"
          class="terminal-tab"
          :class="{ active: item.id === activeId }"
        >
          <button
            role="tab"
            :aria-selected="item.id === activeId"
            :tabindex="item.id === activeId ? 0 : -1"
            :title="item.title"
            @click="select(item.id)"
          >
            <span :class="['status', item.status]" />
            <span class="terminal-tab__title">{{ item.title }}</span>
            <span
              v-if="item.pinned"
              class="terminal-pin"
              :aria-label="__t('ui.workspace', '已固定')"
            >
              ◆
            </span>
            <i v-if="item.unread" />
          </button>
          <button
            class="terminal-tab__close"
            :aria-label="__t('ui.workspace', '关闭 {0}', [item.title])"
            :title="__t('ui.workspace', '关闭并归档')"
            @click="action(item.id, 'close')"
          >
            ×
          </button>
        </div>
      </div>
      <div class="terminal-controls">
        <button
          class="terminal-create"
          :title="__t('ui.workspace', '新建系统终端')"
          :aria-label="__t('ui.workspace', '新建终端')"
          :disabled="blocked || !agentId || !threadId"
          @click="create"
        >
          <PixelIcon name="plus" size="xs" />
        </button>
        <details
          class="terminal-menu"
          @toggle="placeMenu($event.currentTarget as HTMLDetailsElement)"
        >
          <summary :title="__t('ui.workspace', '终端历史')">
            {{ __t('ui.workspace', '历史') }}
            <small>{{ history.length }}</small>
          </summary>
          <div class="terminal-menu__panel terminal-history">
            <span v-if="!history.length" class="terminal-menu__empty">
              {{ __t('ui.workspace', '暂无历史') }}
            </span>
            <button
              v-for="item in history"
              :key="item.id"
              :title="item.title"
              @click="openHistory(item)"
            >
              <span :class="['status', item.status]" />
              <span class="terminal-tab__title">{{ item.title }}</span>
              <small>
                {{
                  item.exitReason === 'timeout'
                    ? __t('ui.workspace', '超时')
                    : item.exitCode === 0
                      ? __t('ui.workspace', '完成')
                      : __t('ui.workspace', '已结束')
                }}
              </small>
            </button>
          </div>
        </details>
        <details
          class="terminal-menu"
          @toggle="placeMenu($event.currentTarget as HTMLDetailsElement)"
        >
          <summary
            :aria-label="__t('ui.workspace', '终端管理')"
            :title="__t('ui.workspace', '终端管理')"
          >
            ···
          </summary>
          <div class="terminal-menu__panel">
            <button @click="cleanup('archive_completed')">
              {{ __t('ui.workspace', '归档已结束') }}
            </button>
            <button @click="cleanup('stop_agent')">
              {{ __t('ui.workspace', '停止 Agent 终端') }}
            </button>
            <button @click="cleanup('close_all')">{{ __t('ui.workspace', '关闭全部终端') }}</button>
          </div>
        </details>
      </div>
    </div>
    <div v-if="connectionError" class="terminal-error" role="alert">
      <span>{{ connectionError }}</span>
      <button type="button" @click="restart()">{{ __t('ui.workspace', '重试连接') }}</button>
    </div>
    <template v-if="activeTerminal">
      <div class="terminal-toolbar">
        <span>{{ activeTerminal.backend.toUpperCase() }}</span>
        <span>PID {{ activeTerminal.pid ?? '—' }}</span>
        <span>
          {{
            activeTerminal.archivedAt
              ? __t('ui.workspace', '已归档')
              : activeTerminal.status === 'running'
                ? __t('ui.workspace', '运行中')
                : __t('ui.workspace', '已结束')
          }}
        </span>
        <span class="spacer" />
        <button :aria-pressed="!!activeTerminal.pinned" @click="pin">
          {{
            activeTerminal.pinned ? __t('ui.workspace', '取消固定') : __t('ui.workspace', '固定')
          }}
        </button>
        <template v-if="activeTerminal.status === 'running'">
          <button :title="__t('ui.workspace', '中断')" @click="action(activeId, 'interrupt')">
            Ctrl+C
          </button>
          <button :title="__t('ui.workspace', '强制终止')" @click="action(activeId, 'kill')">
            {{ __t('ui.workspace', '停止') }}
          </button>
        </template>
        <button v-else-if="!activeTerminal.archivedAt" @click="action(activeId, 'archive')">
          {{ __t('ui.workspace', '归档') }}
        </button>
      </div>
      <WorkspaceTerminalScreen
        v-if="shown"
        :key="activeTerminal.id"
        class="terminal-output"
        :output="activeTerminal.output"
        :output-offset="activeTerminal.outputOffset"
        :cols="activeTerminal.cols"
        :rows="activeTerminal.rows"
        :backend="activeTerminal.backend"
        :running="activeTerminal.status === 'running'"
        @data="(data) => writeInput(activeTerminal!.id, data)"
        @resize="(cols, rows) => resize(activeTerminal!.id, cols, rows)"
      />
      <form
        v-if="activeTerminal.status === 'running'"
        class="terminal-input"
        @submit.prevent="sendInput"
      >
        <span>›</span>
        <input v-model="input" :placeholder="__t('ui.workspace', '向终端输入…')" />
      </form>
    </template>
    <div v-else class="terminal-empty">{{ __t('ui.workspace', '输入命令创建第一个工作终端') }}</div>
  </div>
</template>

<style scoped>
.terminal-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  color: var(--work-terminal-danger);
  font-size: 12px;
}
.terminal-error button {
  flex-shrink: 0;
  cursor: pointer;
}
.work-terminal {
  /* 局部终端语义变量：浅色与深色都在此声明，子元素一律引用变量，不再硬编码。 */
  --work-terminal-bg: #f7f8fb;
  --work-terminal-surface: #eef1f6;
  --work-terminal-surface-active: #ffffff;
  --work-terminal-border: rgba(15, 23, 42, 0.11);
  --work-terminal-border-strong: rgba(15, 23, 42, 0.18);
  --work-terminal-text: #334155;
  --work-terminal-muted: #7c8598;
  --work-terminal-hover: rgba(15, 23, 42, 0.05);
  --work-terminal-accent: #0284c7;
  --work-terminal-success: #059669;
  --work-terminal-danger: #dc2626;
  --work-terminal-toolbar-bg: rgba(255, 255, 255, 0.55);
  --work-terminal-scrollbar: rgba(15, 23, 42, 0.22);
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  background: var(--work-terminal-bg);
  color: var(--work-terminal-text);
}
[data-theme='dark'] .work-terminal {
  --work-terminal-bg: #0b1020;
  --work-terminal-surface: #0e1626;
  --work-terminal-surface-active: #0b1020;
  --work-terminal-border: #263349;
  --work-terminal-border-strong: #334155;
  --work-terminal-text: #cbd5e1;
  --work-terminal-muted: #64748b;
  --work-terminal-hover: rgba(255, 255, 255, 0.04);
  --work-terminal-accent: #38bdf8;
  --work-terminal-success: #34d399;
  --work-terminal-danger: #fb7185;
  --work-terminal-toolbar-bg: rgba(15, 23, 42, 0.45);
  --work-terminal-scrollbar: #334155;
}

.terminal-heading {
  display: flex;
  min-width: 0;
  min-height: 34px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--work-terminal-border);
  background: var(--work-terminal-surface);
}
.work-terminal__tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: thin;
  overscroll-behavior-x: contain;
}
.terminal-tab {
  display: flex;
  flex: 0 0 168px;
  min-width: 0;
  border-right: 1px solid var(--work-terminal-border);
}
.terminal-tab.active {
  background: var(--work-terminal-surface-active);
  box-shadow: inset 0 -2px var(--work-terminal-accent);
}
.terminal-tab button,
.terminal-controls button,
.terminal-menu summary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 0;
  background: transparent;
  color: var(--work-terminal-muted);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.terminal-tab button[role='tab'] {
  flex: 1;
  overflow: hidden;
}
.terminal-tab__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.terminal-tab button.terminal-tab__close {
  flex: 0 0 26px;
  justify-content: center;
  padding: 0;
  font-size: 16px;
}
.terminal-tab button:hover,
.terminal-controls button:hover,
.terminal-menu summary:hover {
  color: var(--work-terminal-text);
  background: var(--work-terminal-hover);
}
.terminal-tab__close:hover {
  color: var(--work-terminal-danger) !important;
}
.terminal-tab.active button {
  color: var(--work-terminal-text);
}
.terminal-pin {
  color: var(--work-terminal-accent);
  font-size: 8px;
}
.terminal-tab i {
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--work-terminal-accent);
}
.terminal-controls {
  display: flex;
  flex-shrink: 0;
  border-left: 1px solid var(--work-terminal-border);
}
.terminal-controls .terminal-create {
  justify-content: center;
  width: 34px;
  color: var(--work-terminal-accent);
}
.terminal-menu {
  position: relative;
  display: flex;
}
.terminal-menu summary {
  height: 100%;
  list-style: none;
  box-sizing: border-box;
}
.terminal-menu summary::-webkit-details-marker {
  display: none;
}
.terminal-menu__panel {
  position: fixed;
  z-index: 50;
  min-width: 160px;
  max-width: min(360px, 80vw);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--work-terminal-border-strong);
  background: var(--work-terminal-surface);
  box-shadow: 0 8px 24px #0003;
}
.terminal-menu__panel button {
  width: 100%;
  min-height: 30px;
}
.terminal-history {
  width: 300px;
}
.terminal-menu__empty {
  display: block;
  padding: 10px;
  color: var(--work-terminal-muted);
  font-size: 11px;
}
.status {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--work-terminal-muted);
}
.status.running {
  background: var(--work-terminal-success);
}
.status.failed,
.status.killed {
  background: var(--work-terminal-danger);
}
button:focus-visible,
summary:focus-visible {
  outline: 1px solid var(--work-terminal-accent);
  outline-offset: -2px;
}

.terminal-toolbar {
  display: flex;
  min-height: 30px;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-bottom: 1px solid var(--work-terminal-border);
  background: var(--work-terminal-toolbar-bg);
  color: var(--work-terminal-muted);
  font: 9px var(--ui-font-mono);
}
.terminal-toolbar .spacer {
  flex: 1;
}
.terminal-toolbar button {
  min-height: 22px;
  padding: 0 7px;
  border: 1px solid var(--work-terminal-border-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--work-terminal-muted);
  font: 9px var(--ui-font-mono);
  cursor: pointer;
}
.terminal-toolbar button:hover {
  border-color: var(--work-terminal-accent);
  background: var(--work-terminal-hover);
  color: var(--work-terminal-text);
}
.terminal-toolbar button:last-child:hover {
  border-color: var(--work-terminal-danger);
  color: var(--work-terminal-danger);
}

.terminal-output {
  min-height: 0;
  flex: 1;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background:
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 3px,
      color-mix(in srgb, var(--work-terminal-text) 1.2%, transparent) 4px
    ),
    var(--work-terminal-bg);
  color: var(--work-terminal-text);
  font: 11px/1.5 var(--ui-font-mono);
  white-space: pre-wrap;
  /* 覆盖 body 的 user-select:none，允许用户用鼠标选中并复制终端输出。 */
  user-select: text;
  cursor: text;
}

.terminal-input {
  display: flex;
  min-height: 34px;
  flex-shrink: 0;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
  border-top: 1px solid var(--work-terminal-border);
  background: var(--work-terminal-surface);
  color: var(--work-terminal-success);
}
.terminal-input:focus-within {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--work-terminal-success) 20%, transparent);
}
.terminal-input input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--work-terminal-text);
  font: 11px var(--ui-font-mono);
}
.terminal-input input::placeholder {
  color: var(--work-terminal-muted);
}

.terminal-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--work-terminal-muted);
  font-size: 10px;
}
</style>
