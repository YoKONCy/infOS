<script setup lang="ts">
/**
 * ToolCallCard.vue — v6 轨迹异构节点卡片（哑光微立体外壳 + 双调微刻精工图标系统）
 *
 * 按工具语义分层渲染：
 * 1. NIT 编排主条（左右双舱 + 并发双轨标 + 虚线圆角分叉树 + 独立轻内凹沙箱脚本抽屉）
 * 2. NIT 纯沙箱演算条（双舱演算头 + 返回值胶囊 + 表达式内凹窗）
 * 3. 代码变更双舱条（5 格内凹比例尺 + 实时增删计数 + 差异抽屉）
 * 4. 定时提醒硬卡打孔小票、角色心情叙事胶囊、据点穿梭小键、托盘置物条、取景光圈条
 * 5. 常规高频工具无框静默灵动行（读取、检索、终端、浏览器等）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IMAGE_PREVIEW_TOOLS, imagePreviewsFromToolResult } from '@infos/shared'
import { t as __t } from '../../i18n/index'
import ToolArchetypeSignature from './ToolArchetypeSignature.vue'
import ToolTechnicalDrawer from './ToolTechnicalDrawer.vue'
import TrajectoryIcon, { type TrajectoryIconName } from './TrajectoryIcon.vue'
import {
  resolveToolDisplay,
  toolDisplayColor,
  toolDisplayColorSoft,
  toolDisplayIcon,
  toolDisplayLabel,
} from '../../composables/tools/useToolDisplay'
import type { AgentToolDisplay } from '../../api/modules/agentApi'
import { getToolStyleRenderer } from './toolRenderers'
import { resolveToolSignature, resolveTrajectoryVisual } from './toolSignatures'
import { parseToolSearchResult, toolSearchSummary } from '../../lib/toolSearchResult'
import type { ToolCallView } from './toolCallView'
import { useFileMutationPreview } from '../../composables/tools/useFileMutationPreview'
import ToolCardEdit from './renderers/ToolCardEdit.vue'
import ToolCardImage from './renderers/ToolCardImage.vue'
import { toolTaskTarget } from './toolTaskTarget'
import { requestTaskNavigation } from '../../composables/main/useTaskNavigation'
import './trajectory-tactile.css'

interface Props {
  tool: ToolCallView
  children?: ToolCallView[]
  nested?: boolean
  expanded?: boolean | null
  active?: boolean
  chainStart?: boolean
  chainEnd?: boolean
}

interface NitStepChip {
  key: string
  icon: TrajectoryIconName
  color: string
  label: string
  count: number
}

const props = withDefaults(defineProps<Props>(), {
  expanded: null,
  active: true,
  chainStart: true,
  chainEnd: true,
  children: () => [],
  nested: false,
})

const emit = defineEmits<{ 'update:expanded': [value: boolean] }>()

const taskId = computed(() => toolTaskTarget(props.tool))
async function openTask(event?: Event): Promise<void> {
  event?.preventDefault()
  event?.stopPropagation()
  if (!taskId.value) return
  requestTaskNavigation(taskId.value)
  const { useMainNav } = await import('../../composables/main/useMainNav')
  await useMainNav().setTab('tasks')
}

const imageTool = computed(
  () =>
    IMAGE_PREVIEW_TOOLS.some((name) => name === props.tool.name) &&
    (props.tool.name !== 'automation_execute' ||
      imagePreviewsFromToolResult(props.tool.name, props.tool.result).length > 0),
)

const display = ref<AgentToolDisplay>()
const detailsRef = ref<HTMLDetailsElement>()
const internalExpanded = ref(!props.nested && props.tool.result === undefined)
const drawerOpen = ref(false)
const nitScriptOpen = ref(false)
const userLocked = ref(false)
let collapseTimer: number | undefined

onMounted(syncOpen)
watch(
  () => props.tool.name,
  async (name, _previous, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })
    display.value = undefined
    const metadata = await resolveToolDisplay(name)
    if (active) display.value = metadata
  },
  { immediate: true },
)
onBeforeUnmount(() => window.clearTimeout(collapseTimer))

const state = computed<'running' | 'error' | 'ok'>(() =>
  props.tool.interrupted
    ? 'error'
    : props.tool.result === undefined
      ? 'running'
      : props.tool.isError
        ? 'error'
        : 'ok',
)

const signature = computed(() =>
  resolveToolSignature(props.tool.name, display.value?.signature as never),
)
const archetype = computed(() => signature.value.archetype)
const renderer = computed(() => getToolStyleRenderer(display.value?.style))
const fileMutation = computed(() => ['write_file', 'edit_file'].includes(props.tool.name))
const filePreview = useFileMutationPreview(
  () => ({ ...props.tool, toolName: props.tool.name }),
  () => fileMutation.value && props.active,
)

const fileStatsHint = computed(() => {
  const preview = filePreview.value
  const phase = preview.committed
    ? __t('ui.tools', '已写入')
    : state.value === 'error'
      ? __t('ui.tools', '未写入的预览')
      : __t('ui.tools', '变更预览')
  return __t('ui.tools', '{0} · 新增 {1} 行，删除 {2}', [
    phase,
    preview.insertions,
    preview.baselineUnknown ? __t('ui.tools', '行数待确认') : `${preview.deletions} 行`,
  ])
})

const label = computed(() => toolDisplayLabel(props.tool.name, display.value))
const icon = computed(() => toolDisplayIcon(display.value))

const argsObj = computed<Record<string, unknown>>(() => {
  if (fileMutation.value) return filePreview.value.args
  try {
    return JSON.parse(props.tool.args) as Record<string, unknown>
  } catch {
    return {}
  }
})

const draftSummary = computed(() => {
  if (!props.tool.assembling) return ''
  const safeFields = [
    'file_path',
    'dir_path',
    'path',
    'query',
    'url',
    'command',
    'target',
    'selector',
    'room_name',
  ]
  for (const field of safeFields) {
    const match = props.tool.args.match(new RegExp(`"${field}"\\s*:\\s*"([^"\\n]{1,160})`))
    if (match?.[1]) return `${field.replaceAll('_', ' ')} · ${match[1]}`
  }
  const agentIds = props.tool.args.match(/"agent_ids"\s*:\s*\[([^\]]*)/)
  if (agentIds?.[1]) {
    const ids = [...agentIds[1].matchAll(/"([^"\n]+)"/g)].map((match) => match[1])
    if (ids.length) return __t('ui.tools', '成员 · {0}', [ids.join(' → ')])
  }
  return ''
})

const finishedChildCount = computed(
  () => props.children.filter((tool) => tool.result !== undefined || tool.interrupted).length,
)

const summary = computed(() => {
  if (props.children.length) {
    const names = props.children.map((tool) => toolDisplayLabel(tool.name)).join(' → ')
    return __t('ui.tools', '{0} · {1}/{2} 已结束', [
      names,
      finishedChildCount.value,
      props.children.length,
    ])
  }
  if (
    state.value === 'ok' &&
    ['search_files', 'glob_files', 'code_search'].includes(props.tool.name)
  ) {
    const result = parseToolSearchResult(props.tool.result)
    if (result) return toolSearchSummary(result)
  }
  if (state.value === 'running' && ['write_file', 'edit_file'].includes(props.tool.name)) {
    const path = String(argsObj.value.file_path ?? argsObj.value.path ?? '').trim()
    const action = props.tool.assembling
      ? __t('ui.tools', '正在生成修改')
      : __t('ui.tools', '正在写入')
    return path ? `${action} · ${path}` : action
  }
  for (const field of signature.value.summaryFields) {
    const value = argsObj.value[field]
    if (Array.isArray(value) && value.length) return value.join(' → ')
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  if (state.value === 'running') {
    if (draftSummary.value) return draftSummary.value
    return props.tool.assembling
      ? __t('ui.tools', '正在组装参数 · {0}字符', [props.tool.receivedChars ?? 0])
      : __t('ui.tools', '动作正在进行')
  }
  if (state.value === 'error') return __t('ui.tools', '动作未能完成')
  return __t('ui.tools', '动作已完成')
})

const durationText = computed(() => {
  const ms = props.tool.durationMs
  return ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
})

/** 判定当前卡片所属的 v6 异构视觉家族 */
const variantKind = computed<
  | 'nit-orchestration'
  | 'nit-compute'
  | 'code-strip'
  | 'time-ticket'
  | 'state-ribbon'
  | 'shelf-strip'
  | 'stronghold-scene'
  | 'vision-strip'
  | 'quiet-line'
>(() => {
  if (props.nested) return 'quiet-line'
  if (props.children.length > 0) return 'nit-orchestration'
  if (props.tool.name === 'run_script' || archetype.value === 'script-circuit') return 'nit-compute'
  if (fileMutation.value) return 'code-strip'
  if (archetype.value === 'time-ticket') return 'time-ticket'
  if (archetype.value === 'state-ribbon') return 'state-ribbon'
  if (props.tool.name === 'home_shelf' || props.tool.name === 'send_file') return 'shelf-strip'
  if (archetype.value === 'stronghold-scene') return 'stronghold-scene'
  if (archetype.value === 'vision-frame' || imageTool.value) return 'vision-strip'
  return 'quiet-line'
})

/** NIT 脚本源码与并发连携识别 */
const nitScriptSource = computed(() => {
  const raw = argsObj.value.code ?? argsObj.value.script ?? argsObj.value.expression
  return typeof raw === 'string' ? raw.trim() : ''
})

const isNitParallel = computed(() => /\bparallel\b/.test(nitScriptSource.value))

/** 将 NIT 子调用按连续同名折叠为精工微标链（最多展示 3 枚主微标） */
const nitStepChips = computed<NitStepChip[]>(() => {
  const merged: NitStepChip[] = []
  for (const child of props.children) {
    const visual = resolveTrajectoryVisual(child.name)
    const childLabel = toolDisplayLabel(child.name)
    const prev = merged[merged.length - 1]
    if (prev && prev.label === childLabel && prev.icon === visual.icon) {
      prev.count++
    } else {
      merged.push({
        key: `${merged.length}-${child.name}`,
        icon: visual.icon,
        color: child.isError || child.interrupted ? 'var(--ui-danger)' : visual.color,
        label: childLabel,
        count: 1,
      })
    }
  }
  return merged
})

const visibleNitChips = computed(() => nitStepChips.value.slice(0, 3))
const hiddenNitChipCount = computed(() => Math.max(0, nitStepChips.value.length - 3))

/** 纯沙箱演算标题与返回值紧凑胶囊 */
const nitComputeTitle = computed(() => {
  const desc = argsObj.value.summary ?? argsObj.value.description ?? argsObj.value.title
  if (typeof desc === 'string' && desc.trim()) return desc.trim()
  if (nitScriptSource.value) {
    const firstLine = nitScriptSource.value.split(/\r?\n/)[0]?.trim() ?? ''
    return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine
  }
  return summary.value
})

const nitComputeResultChip = computed(() => {
  if (!props.tool.result) return ''
  const clean = props.tool.result.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean
})

/** 文件编辑与读取紧凑路径展示（保留短相对路径以满足精确上下文识别） */
const fileDisplayPath = computed(() =>
  String(argsObj.value.file_path ?? argsObj.value.path ?? argsObj.value.dir_path ?? '').trim(),
)

const fileCompactPath = computed(() => {
  const raw = fileDisplayPath.value.replaceAll('\\', '/')
  if (!raw) return ''
  if (raw.length <= 38) return raw
  const parts = raw.split('/').filter(Boolean)
  if (parts.length <= 2) return raw
  return `…/${parts.slice(-2).join('/')}`
})

/** 5 格内凹增删比例尺 */
const diffBarCells = computed<Array<'add' | 'remove' | 'empty'>>(() => {
  if (!fileMutation.value || !filePreview.value.available) return []
  const ins = Math.max(0, filePreview.value.insertions)
  const del = filePreview.value.baselineUnknown ? 0 : Math.max(0, filePreview.value.deletions)
  const total = ins + del
  if (total === 0) return ['empty', 'empty', 'empty', 'empty', 'empty']
  let addCount = Math.round((ins / total) * 5)
  if (ins > 0 && addCount === 0) addCount = 1
  if (del > 0 && addCount === 5) addCount = 4
  const remCount = Math.min(5 - addCount, del > 0 ? Math.max(1, 5 - addCount) : 0)
  const cells: Array<'add' | 'remove' | 'empty'> = []
  for (let i = 0; i < addCount; i++) cells.push('add')
  for (let i = 0; i < remCount; i++) cells.push('remove')
  while (cells.length < 5) cells.push('empty')
  return cells
})

/** 定时提醒小票存根时间提取 */
const ticketTimeChip = computed(() => {
  if (archetype.value !== 'time-ticket') return ''
  const raw = argsObj.value
  if (typeof raw.time === 'string' && raw.time.trim()) return raw.time.trim()
  if (typeof raw.TriggerTime === 'string' && raw.TriggerTime.trim()) return raw.TriggerTime.trim()
  if (typeof raw.delay_minutes === 'number') return `+${raw.delay_minutes}m`
  if (typeof raw.delay_minutes === 'string' && raw.delay_minutes.trim())
    return `+${raw.delay_minutes.trim()}m`
  if (typeof raw.reminder_id === 'string' && raw.reminder_id.trim())
    return `#${raw.reminder_id.trim().slice(0, 8)}`
  return ''
})

/** 角色心情胶囊与伴随叙事文本 */
const moodPrimaryLabel = computed(() => {
  const raw = argsObj.value
  const primary = raw.mood ?? raw.vibe ?? raw.status ?? raw.activity
  if (typeof primary === 'string' && primary.trim()) {
    const t = primary.trim()
    return t.length > 18 ? `${t.slice(0, 18)}…` : t
  }
  return label.value
})

const moodSecondaryText = computed(() => {
  const raw = argsObj.value
  const candidates = [raw.mind, raw.thought, raw.vibe, raw.current_goal, raw.goal, raw.summary]
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim() && item.trim() !== moodPrimaryLabel.value) {
      const t = item.trim()
      return t.length > 48 ? `${t.slice(0, 48)}…` : t
    }
  }
  return summary.value
})

/** 据点房间穿梭起止点提取 */
const strongholdFromLabel = computed(() => {
  const from = argsObj.value.from_room ?? argsObj.value.source_room
  return typeof from === 'string' && from.trim() ? from.trim() : ''
})

const strongholdTargetLabel = computed(() => {
  const raw = argsObj.value
  const target = raw.room_name ?? raw.place ?? raw.title ?? raw.action
  if (typeof target === 'string' && target.trim()) {
    const t = target.trim()
    return t.length > 24 ? `${t.slice(0, 24)}…` : t
  }
  return summary.value
})

/** 网页微型域名微标 */
const webHostPill = computed(() => {
  if (archetype.value !== 'browser-space' && archetype.value !== 'web-sheet') return ''
  const rawUrl = String(argsObj.value.url ?? argsObj.value.target ?? '').trim()
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return ''
  try {
    const parsed = new URL(rawUrl)
    const shortPath =
      parsed.pathname && parsed.pathname !== '/'
        ? parsed.pathname.length > 16
          ? `${parsed.pathname.slice(0, 16)}…`
          : parsed.pathname
        : ''
    return `${parsed.hostname}${shortPath}`
  } catch {
    return ''
  }
})

/** 常规静默行的单行紧凑摘要 */
const routineSummary = computed(() => {
  if (archetype.value === 'file-paper' && fileCompactPath.value) return fileCompactPath.value
  if (archetype.value === 'terminal-tape') {
    const cmd = argsObj.value.command
    if (typeof cmd === 'string' && cmd.trim()) {
      const oneLine = cmd.trim().replace(/\s+/g, ' ')
      return oneLine.length > 52 ? `${oneLine.slice(0, 52)}…` : oneLine
    }
  }
  return summary.value
})

const accentVars = computed(() => ({
  '--ta-accent': toolDisplayColor(display.value),
  '--ta-accent-soft': toolDisplayColorSoft(display.value),
}))

const open = computed(() =>
  typeof props.expanded === 'boolean' ? props.expanded : internalExpanded.value,
)

function syncOpen(): void {
  if (detailsRef.value && detailsRef.value.open !== open.value) detailsRef.value.open = open.value
}
function setOpen(value: boolean, user = false): void {
  internalExpanded.value = value
  if (user) userLocked.value = value
  emit('update:expanded', value)
  nextTick(syncOpen)
}
function handleSummaryClick(): void {
  if (taskId.value) {
    void openTask()
    return
  }
  window.clearTimeout(collapseTimer)
  setOpen(!open.value, true)
}
function toggleNitScript(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  const next = !nitScriptOpen.value
  nitScriptOpen.value = next
  if (next && !open.value) {
    window.clearTimeout(collapseTimer)
    setOpen(true, true)
  }
}
function keepImageOpen(): void {
  window.clearTimeout(collapseTimer)
  setOpen(true, true)
}
function openDrawer(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  drawerOpen.value = true
  setOpen(true, true)
}

watch(() => props.expanded, syncOpen)
watch(
  () => props.tool.result,
  (result, previous) => {
    window.clearTimeout(collapseTimer)
    if (result === undefined) {
      userLocked.value = false
      setOpen(!props.nested)
      return
    }
    if (previous === undefined && !userLocked.value && !drawerOpen.value) {
      collapseTimer = window.setTimeout(() => setOpen(false), signature.value.collapseDelayMs)
    }
  },
)
watch(drawerOpen, (value) => {
  if (!value && props.tool.result !== undefined) {
    userLocked.value = false
    collapseTimer = window.setTimeout(() => setOpen(false), 180)
  }
})
</script>

<template>
  <details
    ref="detailsRef"
    class="ta-node"
    :class="[
      `ta-${signature.archetype}`,
      `ta-${signature.variant}`,
      `ta-state-${state}`,
      `ta-v6-${variantKind}`,
      { 'is-open': open, 'is-nested': nested, 'chain-start': chainStart, 'chain-end': chainEnd },
    ]"
    :open="open"
    :data-chain="signature.chain"
    :style="accentVars"
  >
    <summary
      class="ta-summary"
      :class="{ 'has-task': taskId }"
      :aria-label="taskId ? __t('ui.tools', '在任务中心查看任务') : undefined"
      @click.prevent="handleSummaryClick"
    >
      <!-- 左侧纵向压痕主轴 20×20 双调微刻铭牌（嵌套子调用自动转为轻量无框微标） -->
      <ToolArchetypeSignature
        :signature="signature"
        :icon="icon"
        :label="label"
        :summary="summary"
        :state="state"
        :tool-name="tool.name"
        :has-children="children.length > 0"
        :nested="nested"
      />

      <!-- ==================== 1. NIT 编排主条（含子工具） ==================== -->
      <span
        v-if="variantKind === 'nit-orchestration'"
        class="v6-nit-bar traj-shell traj-shell--interactive"
      >
        <span class="v6-nit-head">
          <TrajectoryIcon name="nit" size="sm" />
          <span class="ta-nit-badge">NIT · {{ children.length }}</span>
        </span>
        <span class="v6-nit-body">
          <span v-if="isNitParallel" class="v6-nit-mode">
            <TrajectoryIcon name="parallel" size="xs" />
            <span>{{ __t('ui.tools', '并发连携') }}</span>
          </span>
          <span class="ta-copy ta-copy--nit">
            <small class="ta-nit-flow" :title="summary">
              <template v-for="(chip, idx) in visibleNitChips" :key="chip.key">
                <TrajectoryIcon
                  v-if="idx > 0"
                  name="flow-next"
                  size="xs"
                  class="v6-flow-arrow"
                />
                <span class="v6-nit-chip">
                  <TrajectoryIcon
                    :name="chip.icon"
                    size="sm"
                    :style="{ color: chip.color }"
                  />
                  <span>{{ chip.label }}</span>
                  <b v-if="chip.count > 1" class="traj-mono">×{{ chip.count }}</b>
                </span>
              </template>
              <span v-if="hiddenNitChipCount > 0" class="v6-nit-more traj-mono">
                +{{ hiddenNitChipCount }}
              </span>
              <span class="v6-nit-count traj-mono">
                {{ finishedChildCount }}/{{ children.length }}
              </span>
            </small>
          </span>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <button
            v-if="nitScriptSource"
            type="button"
            class="v6-nit-code-btn"
            :class="{ 'is-active': nitScriptOpen }"
            :title="__t('ui.tools', '查看 NIT 沙箱脚本')"
            @click="toggleNitScript"
          >
            <TrajectoryIcon name="code-tag" size="xs" />
            <span>{{ __t('ui.tools', '脚本') }}</span>
          </button>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 2. NIT 纯沙箱演算条（无子工具） ==================== -->
      <span
        v-else-if="variantKind === 'nit-compute'"
        class="v6-nit-bar traj-shell traj-shell--interactive"
      >
        <span class="v6-nit-head">
          <TrajectoryIcon name="compute" size="sm" />
          <span>{{ __t('ui.tools', 'NIT 演算') }}</span>
        </span>
        <span class="v6-nit-body">
          <span class="ta-copy ta-copy--inline">
            <small :title="summary">{{ nitComputeTitle }}</small>
          </span>
          <template v-if="nitComputeResultChip">
            <TrajectoryIcon name="flow-next" size="xs" class="v6-flow-arrow" />
            <span
              class="v6-nit-chip traj-mono"
              :class="{ 'is-ok': state === 'ok', 'is-err': state === 'error' }"
            >
              {{ nitComputeResultChip }}
            </span>
          </template>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <span class="v6-nit-code-btn" :class="{ 'is-active': open }">
            <TrajectoryIcon name="code-tag" size="xs" />
            <span>{{ __t('ui.tools', '表达式') }}</span>
          </span>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 3. 代码变更双舱条（edit_file / write_file） ==================== -->
      <span
        v-else-if="variantKind === 'code-strip'"
        class="v6-code-strip traj-shell traj-shell--interactive"
      >
        <span class="v6-code-strip__file traj-mono" :title="fileDisplayPath || label">
          <TrajectoryIcon name="files" size="sm" class="v6-sky-ico" />
          <span>{{ fileCompactPath || label }}</span>
        </span>
        <span class="v6-code-strip__stats">
          <span
            v-if="fileMutation && filePreview.available"
            class="ta-diff-stats"
            :class="{ 'is-preview': !filePreview.committed }"
            :title="fileStatsHint"
            :aria-label="fileStatsHint"
          >
            <span v-if="diffBarCells.length" class="v6-diff-meter ta-diff-bar" aria-hidden="true">
              <i v-for="(cell, idx) in diffBarCells" :key="idx" :class="`is-cell-${cell}`" />
            </span>
            <span class="is-add">+{{ filePreview.insertions }}</span>
            <span class="is-remove">
              −{{ filePreview.baselineUnknown ? '?' : filePreview.deletions }}
            </span>
          </span>
          <span class="ta-copy ta-copy--inline">
            <small :title="summary">
              {{
                state === 'running'
                  ? summary
                  : state === 'error'
                    ? __t('ui.tools', '未写入')
                    : __t('ui.tools', '改动预览')
              }}
            </small>
          </span>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 4. 定时提醒硬卡打孔小票 ==================== -->
      <span v-else-if="variantKind === 'time-ticket'" class="v6-ticket">
        <span class="v6-ticket__stub">
          <TrajectoryIcon name="alarm" size="sm" />
          <span>{{ ticketTimeChip || label }}</span>
        </span>
        <span class="v6-ticket__body">
          <span class="ta-copy ta-copy--inline">
            <small :title="summary">{{ summary }}</small>
          </span>
          <span class="v6-ticket__status">
            {{
              state === 'running'
                ? __t('ui.tools', '进行中')
                : state === 'error'
                  ? __t('ui.tools', '未完成')
                  : __t('ui.tools', '已设好')
            }}
          </span>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 5. 角色心情与心流叙事胶囊 ==================== -->
      <span v-else-if="variantKind === 'state-ribbon'" class="v6-narrative-row">
        <span class="v6-mood-pill">
          <TrajectoryIcon name="gem-heart" size="sm" class="v6-pink-ico" />
          <strong>{{ moodPrimaryLabel }}</strong>
        </span>
        <span class="ta-copy ta-copy--inline">
          <small :title="summary">{{ moodSecondaryText }}</small>
        </span>
        <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
        <TrajectoryIcon
          name="chev-right"
          size="xs"
          class="v6-caret v6-caret--subtle"
          :class="{ 'is-open': open }"
        />
      </span>

      <!-- ==================== 6. 托盘置物架 / 发送文件条 ==================== -->
      <span
        v-else-if="variantKind === 'shelf-strip'"
        class="v6-code-strip traj-shell traj-shell--interactive"
      >
        <span class="v6-code-strip__file v6-sky-ico">
          <TrajectoryIcon name="shelf" size="sm" />
          <span>{{ label }}</span>
        </span>
        <span class="v6-code-strip__stats">
          <span class="ta-copy ta-copy--inline">
            <small class="v6-primary-small" :title="summary">
              {{ fileCompactPath || summary }}
            </small>
          </span>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 7. 据点空间穿梭小键 ==================== -->
      <span v-else-if="variantKind === 'stronghold-scene'" class="v6-narrative-row">
        <span class="v6-room-cap v6-room-cap--origin">
          <span>{{ strongholdFromLabel || label }}</span>
        </span>
        <TrajectoryIcon name="step-trail" class="v6-step-trail" />
        <span class="v6-room-cap v6-room-cap--dest">
          <TrajectoryIcon name="stronghold" size="sm" class="v6-purple-ico" />
          <span class="ta-copy ta-copy--inline">
            <small :title="summary">{{ strongholdTargetLabel }}</small>
          </span>
        </span>
        <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
        <TrajectoryIcon
          name="chev-right"
          size="xs"
          class="v6-caret v6-caret--subtle"
          :class="{ 'is-open': open }"
        />
      </span>

      <!-- ==================== 8. 画面捕获 / 图片读取光圈条 ==================== -->
      <span
        v-else-if="variantKind === 'vision-strip'"
        class="v6-code-strip traj-shell traj-shell--interactive"
      >
        <span class="v6-code-strip__file v6-sky-ico">
          <TrajectoryIcon name="aperture" size="sm" />
          <span>{{ label }}</span>
        </span>
        <span class="v6-code-strip__stats">
          <span class="ta-copy ta-copy--inline">
            <small :title="summary">{{ summary }}</small>
          </span>
          <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
          <TrajectoryIcon
            name="chev-right"
            size="xs"
            class="v6-caret"
            :class="{ 'is-open': open }"
          />
        </span>
      </span>

      <!-- ==================== 9. 常规高频工具无框静默灵动行（及 NIT 分支子行） ==================== -->
      <span v-else class="v6-quiet-line" :class="{ 'v6-nit-child-row': nested }">
        <strong class="ta-label-text">{{ label }}</strong>
        <span class="ta-copy ta-copy--inline">
          <small
            :class="{ 'traj-mono': archetype === 'terminal-tape' || archetype === 'file-paper' }"
            :title="summary"
          >
            {{ routineSummary }}
          </small>
        </span>
        <span v-if="webHostPill" class="v6-inline-badge traj-mono v6-sky-ico">
          {{ webHostPill }}
        </span>
        <span
          v-else-if="archetype === 'terminal-tape' && state === 'ok'"
          class="v6-inline-badge v6-pass-ico"
        >
          <TrajectoryIcon name="pass" size="xs" />
          <span>{{ __t('ui.tools', '输出正常') }}</span>
        </span>
        <span v-else-if="state === 'error'" class="v6-inline-badge v6-err-ico">
          <TrajectoryIcon name="error" size="xs" />
          <span>{{ __t('ui.tools', '未完成') }}</span>
        </span>
        <time v-if="durationText" class="traj-mono v6-muted-time">{{ durationText }}</time>
        <TrajectoryIcon
          name="chev-right"
          size="xs"
          class="v6-caret v6-caret--subtle"
          :class="{ 'is-open': open }"
        />
      </span>

      <!-- 右侧统一附加元信息：任务跳转按钮 & 悬停技术详情端口 -->
      <span class="ta-meta">
        <button v-if="taskId" class="ta-task-link" type="button" @click="openTask">
          <span>{{ __t('ui.tools', '查看任务') }}</span>
          <TrajectoryIcon name="ext" size="xs" />
        </button>
        <button
          class="ta-data-port"
          type="button"
          :title="__t('ui.tools', '查看技术详情')"
          @click="openDrawer"
        >
          {{ __t('ui.tools', '详情') }}
        </button>
      </span>
    </summary>

    <!-- ==================== 展开详情舞台 ==================== -->
    <div
      class="ta-result-stage"
      :class="{
        'ta-result-stage--nit': children.length > 0,
        'traj-recess-pane': children.length === 0,
      }"
    >
      <p
        v-if="tool.automaticApproval"
        class="ta-approval-note"
        :title="tool.automaticApproval.modelId"
      >
        {{ __t('ui.tools', '自动审批员 ·') }}
        {{
          tool.automaticApproval.decision === 'allow'
            ? __t('ui.tools', '通过')
            : __t('ui.tools', '拒绝')
        }}{{ tool.automaticApproval.errorCode ? __t('ui.tools', '（审批异常）') : '' }}
        <span>{{ tool.automaticApproval.reason }}</span>
      </p>

      <!-- NIT 子工具分叉树 + 可选沙箱脚本抽屉 -->
      <template v-if="children.length">
        <div
          class="ta-nested-tools v6-nit-tree"
          :aria-label="__t('ui.tools', 'NIT 内部工具调用')"
        >
          <ToolCallCard
            v-for="(child, index) in children"
            :key="child.callId ?? index"
            :tool="child"
            :active="open && active"
            :chain-start="index === 0"
            :chain-end="index === children.length - 1"
            nested
          />
          <pre v-if="tool.isError && tool.result" class="ta-nit-error">{{ tool.result }}</pre>
        </div>

        <div v-if="nitScriptOpen && nitScriptSource" class="v6-nit-dsl traj-recess-pane">
          <header class="v6-nit-dsl__head">
            <span>
              <TrajectoryIcon name="nit" size="xs" class="v6-purple-ico" />
              <span>{{ __t('ui.tools', 'NIT 沙箱脚本') }} · {{ tool.name }}</span>
            </span>
            <span :class="state === 'error' ? 'v6-err-ico' : 'v6-pass-ico'">
              <TrajectoryIcon :name="state === 'error' ? 'error' : 'pass'" size="xs" />
              <span>{{ state === 'error' ? __t('ui.tools', '失败') : __t('ui.tools', '完成') }}</span>
            </span>
          </header>
          <pre class="v6-nit-dsl__code">{{ nitScriptSource }}</pre>
        </div>
      </template>

      <!-- 纯沙箱演算展开视图 -->
      <div v-else-if="variantKind === 'nit-compute'" class="v6-nit-dsl">
        <header class="v6-nit-dsl__head">
          <span>
            <TrajectoryIcon name="compute" size="xs" class="v6-purple-ico" />
            <span>{{ __t('ui.tools', 'NIT 演算式') }} · {{ tool.name }}</span>
          </span>
          <span v-if="tool.result !== undefined" :class="state === 'error' ? 'v6-err-ico' : 'v6-pass-ico'">
            <TrajectoryIcon :name="state === 'error' ? 'error' : 'pass'" size="xs" />
            <span>{{ state === 'error' ? __t('ui.tools', '失败') : __t('ui.tools', '完成') }}</span>
          </span>
        </header>
        <pre v-if="nitScriptSource" class="v6-nit-dsl__code">{{ nitScriptSource }}</pre>
        <pre
          v-if="tool.result"
          class="v6-nit-dsl__result"
          :class="{ 'is-error': tool.isError }"
        >{{ tool.result }}</pre>
      </div>

      <!-- 文件编辑差异视图 -->
      <template v-else-if="fileMutation">
        <ToolCardEdit
          v-if="open"
          :args="tool.args"
          :result="tool.result"
          :is-error="tool.isError"
          :assembling="tool.assembling"
          :interrupted="tool.interrupted"
          :file-baseline="tool.fileBaseline"
          :preview-truncated="tool.previewTruncated"
          :active="open && active"
          :tool-name="tool.name"
          :preview="filePreview"
        />
      </template>

      <!-- 视觉图片两阶段预览 -->
      <ToolCardImage
        v-else-if="imageTool"
        :tool-name="tool.name"
        :result="tool.result"
        :is-error="tool.isError"
        :active="open && active !== false"
        @interact="keepImageOpen"
      />

      <!-- 专用检查器（Read / Search / Terminal / Web / Generic） -->
      <component
        :is="renderer"
        v-else
        :args="tool.args"
        :result="tool.result"
        :is-error="tool.isError"
      />
    </div>

    <Teleport to="body">
      <Transition name="motion-drawer">
        <ToolTechnicalDrawer
          v-if="drawerOpen"
          :name="tool.name"
          :args="tool.args"
          :result="tool.result"
          :is-error="tool.isError"
          :duration-ms="tool.durationMs"
          @close="drawerOpen = false"
        />
      </Transition>
    </Teleport>
  </details>
</template>

<style scoped>
.ta-node {
  position: relative;
  min-width: 0;
  max-width: min(100%, 56rem);
  margin: 1.5px 0;
  color: var(--ui-text-primary);
  font-size: 13px;
}
.ta-node[open] {
  max-width: 100%;
}
.ta-node.is-nested {
  max-width: 100%;
}

/* ── Summary 容器基座 ── */
.ta-summary {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 100%;
  padding: 0;
  cursor: pointer;
  list-style: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.ta-summary::-webkit-details-marker {
  display: none;
}
.ta-summary::marker {
  content: '';
}
.ta-summary:focus-visible {
  outline: 2px solid var(--ta-accent, var(--ui-accent-purple));
  outline-offset: 2px;
  border-radius: 5px;
}

/* 位于纵向双线微刻主轴内时，顶层 23×23 双调铭牌精准骑跨在主轴中心线上 */
.surface-execution__body > .ta-node > .ta-summary > :deep(.tas:not(.tas--nested)) {
  position: absolute;
  left: -36px;
  top: 4px;
}
@media (hover: hover) {
  .ta-node:not(.is-nested):hover > .ta-summary > :deep(.tas:not(.tas--nested)) {
    transform: translate(-0.5px, -0.5px) scale(1.08);
    border-color: color-mix(
      in srgb,
      var(--ng-c, var(--ta-accent, var(--ui-accent-purple))) 65%,
      var(--traj-border)
    );
  }
}
@media (max-width: 480px) {
  .surface-execution__body > .ta-node > .ta-summary > :deep(.tas:not(.tas--nested)) {
    left: -32px;
  }
}

/* ── 共用内联文本与图标着色辅助 ── */
.ta-copy {
  min-width: 0;
}
.ta-copy--inline {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 50ch;
}
.ta-copy--inline > small {
  overflow: hidden;
  color: var(--ui-text-tertiary);
  font-size: 12.5px;
  line-height: 1.42;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ta-copy--inline > small.v6-primary-small {
  color: var(--ui-text-primary);
  font-weight: 560;
}
.v6-sky-ico {
  color: var(--ui-accent-sky);
}
.v6-purple-ico {
  color: var(--ui-accent-purple);
}
.v6-pink-ico {
  color: var(--ui-accent-primary);
}
.v6-pass-ico {
  color: var(--ui-success);
}
.v6-err-ico {
  color: var(--ui-danger);
}
.v6-muted-time {
  color: var(--ui-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}
.v6-caret {
  flex: 0 0 auto;
  color: var(--ui-text-tertiary);
  transition: transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.v6-caret--subtle {
  opacity: 0.65;
}
.v6-caret.is-open {
  transform: rotate(90deg);
  opacity: 1;
}

/* ── 1 & 2. NIT 协议左右双舱主条与沙箱脚本窗 ── */
.v6-nit-bar {
  --shell-accent: var(--ui-accent-purple);
  display: inline-flex;
  align-items: stretch;
  flex-wrap: wrap;
  min-height: 35px;
  max-width: 100%;
  border-radius: 7px;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--ui-accent-purple) 32%, var(--traj-border));
}
.ta-state-error > .ta-summary > .v6-nit-bar {
  --shell-accent: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--traj-border));
}
.v6-nit-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  background: color-mix(in srgb, var(--ui-accent-purple) 14%, var(--traj-compartment));
  border-right: 1px solid color-mix(in srgb, var(--ui-accent-purple) 24%, var(--ui-border-subtle));
  color: var(--ui-accent-purple);
  font-family: var(--ui-font-mono);
  font-size: 12.5px;
  font-weight: 650;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.v6-nit-body {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 4px 10px 4px 11px;
  min-width: 0;
}
.v6-nit-mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1.5px 7.5px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky) 28%, transparent);
  background: color-mix(in srgb, var(--ui-accent-sky) 12%, transparent);
  color: var(--ui-accent-sky);
  font-size: 12px;
  white-space: nowrap;
}
.ta-copy--nit {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.ta-nit-flow {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ui-text-secondary);
}
.v6-flow-arrow {
  color: var(--ui-text-tertiary);
}
.v6-nit-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8.5px;
  border-radius: 5px;
  border: 1px solid var(--ui-border-default);
  background: color-mix(in srgb, var(--ui-bg-surface) 72%, transparent);
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 1px 0 var(--traj-lip);
  color: var(--ui-text-primary);
  font-size: 12px;
  white-space: nowrap;
}
.v6-nit-chip > b {
  color: var(--ui-text-tertiary);
  font-size: 11.5px;
  font-weight: 600;
}
.v6-nit-chip.is-ok {
  color: var(--ui-success);
}
.v6-nit-chip.is-err {
  color: var(--ui-danger);
}
.v6-nit-more,
.v6-nit-count {
  color: var(--ui-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}
.v6-nit-code-btn {
  display: inline-flex;
  align-items: center;
  gap: 4.5px;
  padding: 2px 8.5px;
  border-radius: 5px;
  border: 1px solid var(--ui-border-default);
  background: var(--traj-compartment);
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 1px 0 var(--traj-lip);
  color: var(--ui-text-secondary);
  font-family: var(--ui-font-mono);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 130ms ease,
    background-color 130ms ease,
    color 130ms ease;
}
.v6-nit-code-btn:hover,
.v6-nit-code-btn.is-active {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 52%, var(--ui-border-default));
  background: color-mix(in srgb, var(--ui-accent-purple) 18%, var(--traj-compartment));
  color: var(--ui-accent-purple);
}

/* NIT 虚线圆角树状分叉子轨 */
.v6-nit-tree {
  container-type: inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4.5px;
  margin: 6px 0 3px 15px;
  padding: 0 0 0 18px;
  min-width: 0;
}
.v6-nit-tree::before {
  content: '';
  position: absolute;
  left: 0;
  top: -4px;
  bottom: 13px;
  width: 1px;
  border-left: 1px dashed color-mix(in srgb, var(--ui-accent-purple) 38%, var(--ui-border-default));
  pointer-events: none;
}
.v6-nit-tree > .ta-node {
  position: relative;
}
.v6-nit-tree > .ta-node::before {
  content: '';
  position: absolute;
  left: -18px;
  top: 0;
  width: 14px;
  height: 15px;
  border-left: 1px dashed color-mix(in srgb, var(--ui-accent-purple) 38%, var(--ui-border-default));
  border-bottom: 1px dashed
    color-mix(in srgb, var(--ui-accent-purple) 38%, var(--ui-border-default));
  border-bottom-left-radius: 6px;
  pointer-events: none;
}
.ta-nit-error {
  max-width: 100%;
  margin: 4px 0 0;
  padding: 7px 11px;
  border-radius: 5px;
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  font: 12px/1.55 var(--ui-font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.v6-nit-dsl {
  max-width: min(100%, 48rem);
  font-family: var(--ui-font-mono);
  font-size: 12px;
  line-height: 1.62;
}
.ta-result-stage--nit > .v6-nit-dsl {
  margin: 7px 0 3px 15px;
}
.v6-nit-dsl__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-tertiary);
  font-size: 11.5px;
}
.v6-nit-dsl__head > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.v6-nit-dsl__code,
.v6-nit-dsl__result {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 10px 13px;
  color: var(--ui-text-secondary);
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.v6-nit-dsl__result {
  border-top: 1px dashed var(--ui-border-subtle);
  color: var(--ui-text-primary);
}
.v6-nit-dsl__result.is-error {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}

/* ── 3 & 6 & 8. 双舱工程条（代码变更 / 托盘置物 / 画面捕获） ── */
.v6-code-strip {
  --shell-accent: var(--ui-accent-sky);
  display: inline-flex;
  align-items: stretch;
  flex-wrap: wrap;
  min-height: 34px;
  max-width: 100%;
  border-radius: 7px;
  overflow: hidden;
}
.ta-state-error > .ta-summary > .v6-code-strip {
  --shell-accent: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--traj-border));
}
.v6-code-strip__file {
  display: inline-flex;
  align-items: center;
  gap: 6.5px;
  max-width: 300px;
  padding: 4px 11px;
  background: var(--traj-compartment);
  border-right: 1px solid var(--ui-border-subtle);
  color: var(--ui-text-primary);
  font-weight: 560;
}
.v6-code-strip__file > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.v6-code-strip__stats {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 11px;
  min-width: 0;
}
.ta-diff-stats {
  display: inline-flex;
  align-items: center;
  gap: 6.5px;
  font-family: var(--ui-font-mono);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ta-diff-stats .is-add {
  color: var(--ui-success);
}
.ta-diff-stats .is-remove {
  color: var(--ui-danger);
}
.ta-diff-stats.is-preview {
  opacity: 0.88;
}
.v6-diff-meter {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2.5px 3.5px;
  border-radius: 3px;
  background: var(--traj-recess-bg);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.22);
}
.v6-diff-meter > i {
  display: block;
  width: 4.5px;
  height: 6px;
  border-radius: 1px;
  background: var(--ui-border-default);
}
.v6-diff-meter > i.is-cell-add {
  background: var(--ui-success);
}
.v6-diff-meter > i.is-cell-remove {
  background: var(--ui-danger);
}

/* ── 4. 定时提醒硬卡打孔小票 ── */
.v6-ticket {
  display: inline-flex;
  align-items: stretch;
  flex-wrap: wrap;
  min-height: 34px;
  max-width: 100%;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 36%, var(--traj-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--ui-warning-soft) 14%, var(--traj-face));
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 2px 0 color-mix(in srgb, var(--ui-warning) 20%, var(--traj-lip));
  color: var(--ui-text-primary);
  overflow: hidden;
  transition: transform 150ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
@media (hover: hover) {
  .v6-ticket:hover {
    transform: translateY(-1px);
  }
}
.v6-ticket__stub {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  background: color-mix(in srgb, var(--ui-warning) 10%, var(--traj-compartment));
  border-right: 1px dashed color-mix(in srgb, var(--ui-warning) 42%, var(--ui-border-default));
  color: var(--ui-warning);
  font-family: var(--ui-font-mono);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.v6-ticket__body {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 11px;
  min-width: 0;
}
.v6-ticket__body .ta-copy--inline > small {
  color: var(--ui-text-primary);
}
.v6-ticket__status {
  color: var(--ui-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

/* ── 5 & 7. 生活叙事胶囊与据点穿梭行 ── */
.v6-narrative-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  min-height: 29px;
  max-width: 100%;
  color: var(--ui-text-secondary);
}
.v6-mood-pill {
  display: inline-flex;
  align-items: center;
  gap: 5.5px;
  padding: 2.5px 11px 2.5px 8.5px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-primary) 34%, var(--traj-border));
  background: color-mix(in srgb, var(--ui-accent-primary-soft) 16%, var(--traj-face));
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 1.5px 0 var(--traj-lip);
  color: var(--ui-text-primary);
  white-space: nowrap;
}
.v6-mood-pill > strong {
  font-weight: 580;
}
.v6-room-cap {
  display: inline-flex;
  align-items: center;
  gap: 5.5px;
  padding: 2.5px 10px;
  border-radius: 6px;
  border: 1px solid var(--traj-border);
  background: var(--traj-face);
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 1.5px 0 var(--traj-lip);
  white-space: nowrap;
}
.v6-room-cap--origin {
  color: var(--ui-text-secondary);
}
.v6-room-cap--dest {
  border-color: color-mix(in srgb, var(--ui-accent-purple) 38%, var(--traj-border));
  color: var(--ui-text-primary);
}
.v6-room-cap--dest .ta-copy--inline > small {
  color: var(--ui-text-primary);
  font-weight: 560;
}
.v6-step-trail {
  color: var(--ui-accent-purple);
}

/* ── 9. 常规高频工具无框静默灵动行（及 NIT 分支子行） ── */
.v6-quiet-line {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  min-height: 28px;
  max-width: 100%;
  padding: 2px 8px 2px 4px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--ui-text-secondary);
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
@media (hover: hover) {
  .v6-quiet-line:hover {
    background: var(--ui-bg-hover);
    color: var(--ui-text-primary);
  }
  .v6-nit-child-row:hover {
    border-color: var(--ui-border-subtle);
    background: var(--traj-compartment);
  }
}
.v6-quiet-line > .ta-label-text {
  font-weight: 580;
  color: var(--ui-text-primary);
  white-space: nowrap;
}
.v6-nit-child-row {
  min-height: 27px;
  padding: 1.5px 8px 1.5px 5px;
}
.v6-nit-child-row > .ta-label-text {
  font-weight: 520;
  color: var(--ui-text-secondary);
}
.ta-state-error > .ta-summary .ta-label-text {
  color: var(--ui-danger);
}
.v6-inline-badge {
  display: inline-flex;
  align-items: center;
  gap: 4.5px;
  max-width: 240px;
  overflow: hidden;
  padding: 1.5px 7.5px;
  border-radius: 4px;
  border: 1px solid var(--ui-border-subtle);
  background: var(--traj-compartment);
  box-shadow: inset 0 1px 0 var(--traj-top-edge);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 右侧任务跳转与技术详情微凸小键 ── */
.ta-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ta-task-link {
  display: inline-flex;
  align-items: center;
  gap: 4.5px;
  height: 24px;
  padding: 0 8.5px;
  border: 1px solid color-mix(in srgb, var(--ui-accent-sky) 34%, var(--ui-border-subtle));
  border-radius: 4px;
  background: var(--ui-accent-sky-soft);
  color: var(--ui-accent-sky);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ta-task-link:hover {
  background: color-mix(in srgb, var(--ui-accent-sky) 22%, transparent);
}
.ta-task-link:focus-visible {
  outline: 2px solid var(--ui-accent-sky);
  outline-offset: 2px;
}

.ta-data-port {
  height: 23px;
  padding: 0 8px;
  border: 1px solid var(--ui-border-subtle);
  border-radius: 4px;
  background: var(--traj-compartment);
  box-shadow:
    inset 0 1px 0 var(--traj-top-edge),
    0 1px 0 var(--traj-lip);
  color: var(--ui-text-tertiary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.ta-summary:hover .ta-data-port,
.ta-summary:focus-within .ta-data-port,
.ta-node[open] > .ta-summary .ta-data-port {
  opacity: 1;
}
.ta-data-port:hover,
.ta-data-port:focus-visible {
  opacity: 1;
  border-color: color-mix(in srgb, var(--ta-accent, var(--ui-accent-purple)) 45%, var(--ui-border-default));
  color: var(--ta-accent, var(--ui-accent-purple));
  outline: none;
}
@media (hover: none) {
  .ta-data-port {
    opacity: 0.85;
  }
}

/* ── 展开态舞台 ── */
.ta-result-stage {
  margin: 6px 0 4px;
  max-width: min(100%, 50rem);
}
.ta-result-stage--nit {
  margin: 0;
  max-width: 100%;
}
.ta-node:not(:is(.surface-execution__body > *)):not(.is-nested) > .ta-result-stage:not(.ta-result-stage--nit) {
  margin-left: 31px;
}
.ta-node.is-nested > .ta-result-stage {
  margin-left: 20px;
}
.ta-node:not([open]) > .ta-result-stage {
  display: none;
}
.ta-state-error > .ta-result-stage.traj-recess-pane {
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border-default));
}

.ta-approval-note {
  margin: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ui-border-subtle);
  border-left: 2px solid var(--ui-accent-sky);
  color: var(--ui-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  background: var(--traj-compartment);
}
.ta-approval-note span {
  margin-left: 8px;
  color: var(--ui-text-tertiary);
}

[data-motion='off'] .ta-node,
[data-motion='off'] .ta-node :deep(*),
[data-motion='reduced'] .ta-node,
[data-motion='reduced'] .ta-node :deep(*) {
  animation: none !important;
  transition: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .ta-node *,
  .ta-node *::before,
  .ta-node *::after {
    animation: none !important;
    transition: none !important;
  }
}
</style>
