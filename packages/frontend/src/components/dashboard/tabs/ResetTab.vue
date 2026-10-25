<script setup lang="ts">
import { t as __t } from '../../../i18n/index'

/**
 * ResetTab — 危险区域 Tab
 *
 * 分级重置选项 + 数据导出。
 * 危险操作已真实接线到后端 /api/reset/*，全部为物理删除且不可撤销。
 *
 * 视觉风格：像素风（对齐项目 moe 像素体系）——
 * - 卡片 / 弹窗 / 按钮均使用 box-shadow 模拟的 2px 像素描边（危险区用红色系）
 * - 深浅色通过 CSS 变量 + [data-theme='dark'] 覆盖适配
 * - 确认弹窗复刻老手游 PeroperoChat 的重置仪式感：
 *   红色像素框 + 抖动 + 告别文案 + 输入确认短语 + 完成后刷新
 *
 * 角色名跟随窗口级活跃 Agent（自定义角色也能正确显示），而非写死 Pero。
 */
import { onMounted, ref, watch } from 'vue'
import { PixelIcon } from '../../pixel'
import { useMainNav } from '../../../composables/main/useMainNav'
import { resetApi, RESET_CONFIRM_PHRASES, type ResetOperation } from '../../../api/modules/resetApi'
import { agentApi } from '../../../api/modules/agentApi'
import { useDashboardContext } from '../../../composables/dashboard'
import { logger } from '../../../lib/logger'
import { useNotificationStore } from '../../../stores'
import PrivacyCleanupPanel from '../PrivacyCleanupPanel.vue'

const ctx = useDashboardContext()
const notif = useNotificationStore()

// ── 危险操作配置 ──
interface DangerAction {
  /** 后端端点标识（clear-logs / memories / factory） */
  action: ResetOperation
  /** 卡片标题 */
  label: string
  /** 卡片描述 */
  description: string
  /** 危险级别（决定卡片边框配色） */
  severity: 'medium' | 'high' | 'critical'
  /** 卡片图标 */
  icon: string
  /** 按钮文案（避免与卡片标题重复） */
  buttonText: string
  /** 确认短语（与后端一致） */
  phrase: string
  /** 告别主文案 */
  mainText: string
  /** 副文案（操作后果说明） */
  subText: string
}

const dangerActions: DangerAction[] = [
  {
    action: 'clear-logs',
    get label() {
      return __t('ui.settings', '清空对话记录')
    },
    get description() {
      return __t('ui.settings', '删除所有对话日志与消息历史。记忆节点和配置不受影响。')
    },
    severity: 'medium',
    icon: 'chat',
    buttonText: '清空',
    phrase: RESET_CONFIRM_PHRASES['clear-logs'],
    mainText: '主人，真的要清空所有对话记录吗？',
    subText: '那些聊过的点点滴滴都会被抹去，再也找不回来了…o(╥﹏╥)o',
  },
  {
    action: 'memories',
    get label() {
      return __t('ui.settings', '重置全部记忆')
    },
    get description() {
      return __t('ui.settings', '删除全部角色记忆、共享事实及关联日记，保留对话和知识文档。')
    },
    severity: 'high',
    icon: 'brain',
    buttonText: '重置',
    phrase: RESET_CONFIRM_PHRASES.memories,
    mainText: '主人，真的要让我忘掉一切吗？',
    subText: '所有关于你的记忆都会被清除，我会变得一片空白…o(╥﹏╥)o',
  },
  {
    action: 'factory',
    get label() {
      return __t('ui.settings', '恢复出厂设置')
    },
    get description() {
      return __t('ui.settings', '删除所有数据：对话、记忆、配置与模型设置。应用将回到初始状态。')
    },
    severity: 'critical',
    icon: 'alert',
    buttonText: '恢复出厂',
    phrase: RESET_CONFIRM_PHRASES.factory,
    mainText: '',
    subText: '',
  },
]

// ── 当前角色名（用于恢复出厂的告别文案） ──
// 跟随前端窗口级活跃 Agent（ctx.activeAgentId），自定义角色也能正确显示；
// 不使用后端 /agents/active（后端无全局活跃概念，避免写死默认 Pero）。
const agentName = ref('Pero')
async function refreshAgentName() {
  try {
    const res = await agentApi.list()
    const target = res.data?.find((item) => item.id === ctx.activeAgentId.value)
    if (target?.name) agentName.value = target.name
  } catch {
    // 静默，保持兜底 'Pero'
  }
}
onMounted(refreshAgentName)
watch(() => ctx.activeAgentId.value, refreshAgentName)

// ── 危险确认弹窗状态 ──
const pendingAction = ref<DangerAction | null>(null)
const confirmInput = ref('')
const isProcessing = ref(false)
const includeSocial = ref(true)
/** 抖动开关（打开弹窗 / 输入错误时触发） */
const shaking = ref(false)

/** 触发弹窗抖动动画（通过强制移除再挂载动画类实现） */
function triggerShake() {
  shaking.value = false
  requestAnimationFrame(() => {
    shaking.value = true
    setTimeout(() => {
      shaking.value = false
    }, 650)
  })
}

/** 打开危险确认弹窗 */
function openResetDialog(action: DangerAction) {
  // 恢复出厂设置的主文案需要当前角色名（自定义角色已由 refreshAgentName 同步）
  if (action.action === 'factory') {
    action.mainText = `主人，真的要让${agentName.value}忘掉你吗？o(╥﹏╥)o`
    action.subText = '所有数据将被清空。请输入确认短语。'
  }
  pendingAction.value = action
  confirmInput.value = ''
  triggerShake()
}

/** 关闭弹窗 */
function cancelReset() {
  if (isProcessing.value) return
  pendingAction.value = null
}

/** 确认并执行危险操作 */
async function confirmReset() {
  const action = pendingAction.value
  if (!action || isProcessing.value) return

  // 校验确认短语，不匹配则抖动并提示
  if (confirmInput.value.trim() !== action.phrase) {
    notif.toast(__t('ui.settings', '确认短语不匹配，操作已取消'), {
      type: 'error',
      title: action.label,
    })
    triggerShake()
    return
  }

  isProcessing.value = true
  try {
    switch (action.action) {
      case 'clear-logs':
        await resetApi.clearLogs(action.phrase)
        notif.toast(__t('ui.settings', '对话记录已清空'), { type: 'success', title: action.label })
        break
      case 'memories':
        await resetApi.resetMemories(action.phrase, includeSocial.value)
        notif.toast(__t('ui.settings', '记忆已重置'), { type: 'success', title: action.label })
        break
      case 'factory':
        await resetApi.factoryReset(action.phrase)
        notif.toast(__t('ui.settings', '已恢复出厂设置，正在重新加载…'), {
          type: 'success',
          title: action.label,
        })
        break
    }
    pendingAction.value = null

    // 恢复出厂需要整页刷新回到初始状态；其余操作仅刷新面板数据
    if (action.action === 'factory') {
      setTimeout(() => location.reload(), 1200)
    } else {
      await ctx.triggerRefresh()
    }
  } catch (err) {
    logger.error('ResetTab', __t('logs.frontend.settings', '{0} 执行失败', [action.label]), err)
    notif.toast(__t('ui.settings', '操作失败，请稍后重试'), { type: 'error', title: action.label })
  } finally {
    isProcessing.value = false
  }
}

// ── 数据导出（安全操作） ──
const { setTab } = useMainNav()
</script>

<template>
  <div class="reset-tab-root p-8 h-full overflow-y-auto overflow-x-hidden">
    <div class="reset-tab-content">
      <PrivacyCleanupPanel />
      <!-- 顶部标题（红色像素风） -->
      <div class="mb-6 relative group/header">
        <!-- 背景氛围光晕 (红色警告感) -->
        <div
          class="absolute -right-20 -top-10 w-40 h-40 bg-rose-400/10 blur-[60px] rounded-full pointer-events-none group-hover/header:bg-rose-400/20 transition-all duration-1000"
        />
        <h2 class="flex items-center gap-3 text-2xl font-black text-[var(--rz-face)] font-pixel">
          <span
            class="group-hover/header:scale-110 group-hover/header:rotate-6 transition-transform duration-500"
          >
            <PixelIcon name="alert" size="md" />
          </span>
          <span>{{ __t('ui.settings', '危险区域') }}</span>
        </h2>
        <p
          class="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--rz-sub)] mt-1 ml-9 font-pixel"
        >
          DANGER ZONE
        </p>
      </div>

      <!-- 数据导出 (安全操作)：使用本页像素卡片，避免 PCard 内层 body 干扰横向布局 -->
      <div class="rz-export-card mb-6">
        <div class="rz-export-info">
          <div class="rz-export-icon">
            <PixelIcon name="download" size="sm" />
          </div>
          <div class="min-w-0">
            <h3 class="text-sm font-black text-[var(--rz-text)] font-pixel">
              {{ __t('ui.backup', '数据与备份') }}
            </h3>
            <p class="text-[11px] text-[var(--rz-sub)] mt-0.5">
              {{ __t('ui.backup', '按范围导出数据，管理备份与恢复') }}
            </p>
          </div>
        </div>
        <button class="rz-btn rz-btn-sky" @click="setTab('backups')">
          <PixelIcon name="database" size="xs" />
          {{ __t('ui.backup', '打开数据与备份') }}
        </button>
      </div>

      <!-- 危险操作列表 -->
      <div class="flex flex-col gap-3">
        <div
          v-for="action in dangerActions"
          :key="action.action"
          class="rz-card"
          :class="`rz-card--${action.severity}`"
        >
          <div class="flex items-center gap-4 min-w-0">
            <div class="rz-card-icon shrink-0">
              <PixelIcon :name="action.icon" size="sm" />
            </div>
            <div class="min-w-0">
              <h4 class="rz-card-title font-pixel">{{ action.label }}</h4>
              <p class="rz-card-desc">{{ action.description }}</p>
              <!-- 确认短语提示，降低误触概率 -->
              <p class="rz-card-phrase font-pixel">
                {{ __t('ui.settings', '需输入「') }}{{ action.phrase
                }}{{ __t('ui.settings', '」确认') }}
              </p>
            </div>
          </div>
          <button
            class="rz-btn rz-btn-danger shrink-0"
            :disabled="isProcessing"
            @click="openResetDialog(action)"
          >
            {{ action.buttonText }}
          </button>
        </div>
      </div>
    </div>

    <!-- 危险确认弹窗（像素风，复刻老手游 PeroperoChat 重置 UX） -->
    <Teleport to="body">
      <Transition name="reset-fade">
        <div v-if="pendingAction" class="rz-overlay" @click.self="cancelReset">
          <div class="rz-dialog rz-pixel-border" :class="{ 'rz-dialog--shake': shaking }">
            <!-- 标题 -->
            <div class="rz-dialog-header">
              <div class="rz-dialog-icon rz-pixel-border">
                <PixelIcon name="alert" size="sm" animation="pulse" />
              </div>
              <div>
                <h3 class="rz-dialog-title font-pixel">{{ __t('ui.settings', '危险操作确认') }}</h3>
                <p class="rz-dialog-subtitle">
                  {{ __t('ui.settings', '此操作不可撤销，请仔细核对确认短语') }}
                </p>
              </div>
            </div>

            <!-- 内容 -->
            <div class="rz-dialog-body">
              <div class="rz-main-text">{{ pendingAction.mainText }}</div>
              <div class="rz-sub-text">{{ pendingAction.subText }}</div>
              <input
                v-model="confirmInput"
                class="rz-input rz-pixel-border"
                :placeholder="__t('ui.settings', '请输入「{0}」以继续', [pendingAction.phrase])"
                :disabled="isProcessing"
                @keydown.enter="confirmReset"
              />
            </div>

            <!-- 操作按钮 -->
            <label
              v-if="pendingAction.action === 'memories'"
              class="flex items-center gap-2 text-ui-text-secondary"
            >
              <input v-model="includeSocial" type="checkbox" :disabled="isProcessing" />
              {{ __t('ui.settings', '同时遗忘社交长记忆并取消社交任务') }}
            </label>
            <div class="rz-dialog-footer">
              <button
                class="rz-btn rz-btn-ghost rz-pixel-border"
                :disabled="isProcessing"
                @click="cancelReset"
              >
                {{ __t('ui.settings', '取消') }}
              </button>
              <button
                class="rz-btn rz-btn-danger rz-pixel-border"
                :disabled="isProcessing"
                @click="confirmReset"
              >
                {{ isProcessing ? __t('ui.settings', '处理中…') : __t('ui.settings', '继续') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   危险区域像素风配色变量（浅色）
   注意：变量需定义在全局 :root 上，Teleport 到 body 的弹窗才能继承。
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
:global(:root) {
  /* 红色系（危险） */
  --rz-face: #ef4444; /* 主红（标题/图标） */
  --rz-outline: #7f1d1d; /* 像素描边（深红棕，浅色下醒目） */
  --rz-shadow: rgba(220, 38, 38, 0.25); /* 偏移投影 */
  --rz-soft: rgba(254, 226, 226, 0.6); /* 红淡底 */
  /* 琥珀色系（中危） */
  --rz-amber-outline: #92400e;
  --rz-amber-face: #d97706;
  --rz-amber-soft: rgba(254, 243, 199, 0.6);
  /* 天蓝色系（安全操作：导出） */
  --rz-sky-face: #0284c7;
  --rz-sky-soft: rgba(224, 242, 254, 0.7);
  --rz-sky-border: #7dd3fc;
  /* 中性 */
  --rz-text: #2d1b1e; /* cocoa 深棕主文字 */
  --rz-sub: rgba(45, 27, 30, 0.6); /* 次级文字 */
  --rz-card-bg: rgba(255, 252, 250, 0.94); /* 卡片米白底 */
  --rz-input-bg: rgba(255, 255, 255, 0.88);
  --rz-panel-border: #64748b;
  --rz-panel-shadow: rgba(71, 85, 105, 0.2);
  --rz-panel-hover: #ffffff;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   危险区域像素风配色变量（暗色）
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
:global([data-theme='dark']) {
  --rz-face: #f87171; /* 亮红 */
  --rz-outline: #f87171; /* 亮红描边，暗色下更醒目 */
  --rz-shadow: rgba(244, 63, 94, 0.32);
  --rz-soft: rgba(248, 113, 113, 0.16);
  --rz-amber-outline: #fbbf24;
  --rz-amber-face: #fbbf24;
  --rz-amber-soft: rgba(251, 191, 36, 0.16);
  --rz-sky-face: #38bdf8;
  --rz-sky-soft: rgba(56, 189, 248, 0.16);
  --rz-sky-border: #0ea5e9;
  --rz-text: #ffeef1;
  --rz-sub: rgba(254, 202, 202, 0.72);
  --rz-card-bg: #171b24;
  --rz-input-bg: #211b20;
  --rz-panel-border: #3c4351;
  --rz-panel-shadow: rgba(0, 0, 0, 0.42);
  --rz-panel-hover: #1c202b;
}

/* ── 像素描边工具（box-shadow 模拟 2px 描边 + 右下偏移投影） ── */
.rz-pixel-border {
  box-shadow:
    -2px 0 0 0 var(--rz-outline),
    2px 0 0 0 var(--rz-outline),
    0 -2px 0 0 var(--rz-outline),
    0 2px 0 0 var(--rz-outline),
    6px 6px 0 var(--rz-shadow),
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.14),
    inset 2px 2px 0 0 rgba(255, 255, 255, 0.22);
  border: none;
  position: relative;
}

/* ── Tab 内容边界：禁止像素投影或长文案撑出横向滚动条 ── */
.reset-tab-root {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow-x: hidden !important;
  overscroll-behavior-x: none;
}
.reset-tab-content {
  width: 100%;
  min-width: 0;
  padding: 2px 8px 10px 2px;
}

/* ── 导出卡片：本页直接控制横向布局，不经过 PCard 内层 body ── */
.rz-export-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  width: 100%;
  min-width: 0;
  padding: 16px;
  color: var(--rz-text);
  background: var(--rz-card-bg);
  border: 2px solid var(--rz-panel-border);
  box-shadow: 4px 4px 0 var(--rz-panel-shadow);
}
.rz-export-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  color: var(--rz-sub);
}
.rz-export-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  color: var(--rz-sky-face);
  background: var(--rz-sky-soft);
  border: 2px solid var(--rz-sky-border);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--rz-sky-face) 30%, transparent);
}

/* ── 危险操作卡片：中性底板 + 左侧风险色条，避免整块红色轰炸 ── */
.rz-card {
  --rz-card-accent: var(--rz-face);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-width: 0;
  padding: 17px 20px 17px 22px;
  overflow: hidden;
  color: var(--rz-text);
  background: var(--rz-card-bg);
  border: 2px solid var(--rz-panel-border);
  box-shadow: 4px 4px 0 var(--rz-panel-shadow);
  transition:
    transform 0.14s steps(3),
    border-color 0.14s steps(3),
    background 0.14s steps(3),
    box-shadow 0.14s steps(3);
}
.rz-card::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 5px;
  background: var(--rz-card-accent);
  box-shadow: 2px 0 0 color-mix(in srgb, var(--rz-card-accent) 24%, transparent);
}
.rz-card:hover {
  transform: translate(-1px, -1px);
  border-color: color-mix(in srgb, var(--rz-card-accent) 72%, var(--rz-panel-border));
  background: var(--rz-panel-hover);
  box-shadow: 5px 5px 0 var(--rz-panel-shadow);
}

/* 各级风险只改变小面积强调色，主体保持中性 */
.rz-card--medium {
  --rz-card-accent: var(--rz-amber-face);
}
.rz-card--high {
  --rz-card-accent: #e8798f;
}
.rz-card--critical {
  --rz-card-accent: var(--rz-face);
}

/* 卡片图标：小面积染色，不使用厚重外投影 */
.rz-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--rz-card-accent);
  background: color-mix(in srgb, var(--rz-card-accent) 11%, var(--rz-card-bg));
  border: 2px solid color-mix(in srgb, var(--rz-card-accent) 70%, var(--rz-panel-border));
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--rz-card-accent) 20%, transparent);
}

.rz-card-title {
  font-size: 14px;
  font-weight: 900;
  color: var(--rz-text);
}

.rz-card-desc {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--rz-sub);
  max-width: 420px;
}

.rz-card-phrase {
  margin-top: 6px;
  font-size: 10px;
  font-weight: 700;
  color: var(--rz-card-accent);
  letter-spacing: 0.04em;
}

/* ── 像素按钮 ── */
.rz-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 18px;
  cursor: pointer;
  font-family: var(--font-pixel), monospace;
  font-size: 13px;
  font-weight: 900;
  transition:
    transform 0.12s steps(3),
    box-shadow 0.12s steps(3),
    background 0.12s steps(3);
}
.rz-btn:active:not(:disabled) {
  transform: translate(2px, 2px);
}
.rz-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* 危险红色像素按钮（对齐 .pixel-btn-red 风格） */
.rz-btn-danger {
  color: #fff;
  background-color: var(--color-red-face);
  box-shadow:
    -2px 0 0 0 var(--color-red-outline),
    2px 0 0 0 var(--color-red-outline),
    0 -2px 0 0 var(--color-red-outline),
    0 2px 0 0 var(--color-red-outline),
    4px 4px 0 rgba(127, 29, 29, 0.35),
    inset -3px -3px 0 0 var(--color-red-shadow),
    inset 3px 3px 0 0 var(--color-red-light);
}
.rz-btn-danger:hover:not(:disabled) {
  background-color: #dc2626;
  transform: translateY(-2px);
}

/* 天蓝像素按钮（导出）：紧凑且不参与内容挤压 */
.rz-btn-sky {
  flex-shrink: 0;
  white-space: nowrap;
  color: #fff;
  background-color: #0ea5e9;
  box-shadow:
    -2px 0 0 0 #075985,
    2px 0 0 0 #075985,
    0 -2px 0 0 #075985,
    0 2px 0 0 #075985,
    2px 2px 0 rgba(2, 132, 199, 0.25),
    inset -2px -2px 0 0 #0284c7,
    inset 2px 2px 0 0 #7dd3fc;
}
.rz-btn-sky:hover:not(:disabled) {
  background-color: #38bdf8;
  transform: translateY(-1px);
}

/* 幽灵像素按钮（取消） */
.rz-btn-ghost {
  color: var(--rz-sub);
  background: rgba(255, 255, 255, 0.45);
  box-shadow:
    -2px 0 0 0 var(--rz-outline),
    2px 0 0 0 var(--rz-outline),
    0 -2px 0 0 var(--rz-outline),
    0 2px 0 0 var(--rz-outline),
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.08),
    inset 2px 2px 0 0 rgba(255, 255, 255, 0.3);
}
.rz-btn-ghost:hover:not(:disabled) {
  color: var(--rz-text);
  background: rgba(255, 255, 255, 0.7);
}

/* ── 危险确认弹窗（像素风 + 红色主题） ── */
.rz-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(20, 8, 12, 0.5);
  backdrop-filter: blur(6px);
}

.rz-dialog {
  width: 100%;
  max-width: 440px;
  overflow: hidden;
  background: var(--rz-card-bg);
  color: var(--rz-text);
  box-shadow:
    -2px 0 0 0 var(--rz-outline),
    2px 0 0 0 var(--rz-outline),
    0 -2px 0 0 var(--rz-outline),
    0 2px 0 0 var(--rz-outline),
    10px 10px 0 var(--rz-shadow),
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.14),
    inset 2px 2px 0 0 rgba(255, 255, 255, 0.22);
}

/* 抖动动画（打开弹窗与输入错误时触发） */
.rz-dialog--shake {
  animation: rz-shake 0.55s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}
@keyframes rz-shake {
  0%,
  100% {
    transform: translate3d(0, 0, 0);
  }
  20% {
    transform: translate3d(-4px, 0, 0);
  }
  40% {
    transform: translate3d(4px, 0, 0);
  }
  60% {
    transform: translate3d(-3px, 0, 0);
  }
  80% {
    transform: translate3d(3px, 0, 0);
  }
}

.rz-dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: var(--rz-soft);
  border-bottom: 2px solid var(--rz-outline);
}

.rz-dialog-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 8px;
  color: var(--rz-face);
  background: var(--rz-card-bg);
}

.rz-dialog-title {
  font-size: 14px;
  font-weight: 900;
  color: var(--rz-face);
  letter-spacing: 0.05em;
}

.rz-dialog-subtitle {
  margin-top: 3px;
  font-size: 11px;
  font-weight: 700;
  color: var(--rz-sub);
}

.rz-dialog-body {
  padding: 22px 20px 6px;
}

.rz-main-text {
  font-size: 15px;
  font-weight: 900;
  line-height: 1.6;
  color: var(--rz-text);
}

.rz-sub-text {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rz-sub);
}

.rz-input {
  width: 100%;
  margin-top: 16px;
  margin-bottom: 14px;
  padding: 9px 12px;
  font-family: var(--font-pixel), monospace;
  font-size: 13px;
  font-weight: 700;
  color: var(--rz-text);
  background: var(--rz-input-bg);
  outline: none;
  box-shadow:
    -2px 0 0 0 var(--rz-outline),
    2px 0 0 0 var(--rz-outline),
    0 -2px 0 0 var(--rz-outline),
    0 2px 0 0 var(--rz-outline),
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.08),
    inset 2px 2px 0 0 rgba(255, 255, 255, 0.25);
}
.rz-input:focus {
  box-shadow:
    -2px 0 0 0 var(--rz-face),
    2px 0 0 0 var(--rz-face),
    0 -2px 0 0 var(--rz-face),
    0 2px 0 0 var(--rz-face),
    inset -2px -2px 0 0 rgba(0, 0, 0, 0.08),
    inset 2px 2px 0 0 rgba(255, 255, 255, 0.25);
}
.rz-input::placeholder {
  color: var(--rz-sub);
  opacity: 0.7;
}

.rz-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 14px 20px;
  border-top: 2px solid var(--rz-outline);
  background: var(--rz-soft);
}

/* ── 暗色细节：主体保持冷灰黑，仅强调色保留暖色 ── */
:global([data-theme='dark']) .rz-card {
  background: #171b24;
  border-color: #343b48;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.46);
}
:global([data-theme='dark']) .rz-card:hover {
  background: #1d222d;
  border-color: color-mix(in srgb, var(--rz-card-accent) 58%, #343b48);
}
:global([data-theme='dark']) .rz-card-icon {
  background: color-mix(in srgb, var(--rz-card-accent) 9%, #171b24);
}
:global([data-theme='dark']) .rz-btn-ghost {
  background: #20252f;
}
:global([data-theme='dark']) .rz-btn-ghost:hover:not(:disabled) {
  background: #292f3b;
}

/* ── 窄窗口：导出按钮和危险操作自动换行，不挤压文案 ── */
@media (max-width: 760px) {
  .rz-export-card,
  .rz-card {
    align-items: stretch;
    flex-direction: column;
  }
  .rz-export-card .rz-btn,
  .rz-card > .rz-btn {
    width: 100%;
  }
  .reset-tab-content {
    padding-right: 5px;
  }
}

/* 弹窗过渡动画 */
.reset-fade-enter-active {
  transition: opacity 0.2s ease-out;
}
.reset-fade-leave-active {
  transition: opacity 0.15s ease-in;
}
.reset-fade-enter-from,
.reset-fade-leave-to {
  opacity: 0;
}
</style>
