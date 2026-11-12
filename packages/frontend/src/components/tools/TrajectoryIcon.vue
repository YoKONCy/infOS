<script setup lang="ts">
/**
 * TrajectoryIcon.vue — 轨迹专属双调微刻精工图标系统（Duotone Precision Micro-Icons）
 *
 * 采用三层精工矢量构成，零系统 Emoji、零粗糙单线框：
 * 1. 柔透体块层（fill-opacity 0.16–0.28）：赋予微缩图标厚实的版面体积；
 * 2. 锐利几何轮廓层（stroke-width 1.35px）：保证深浅色底板下的高对比清晰度；
 * 3. 实心高光锚点层（100% fill）：凝聚小尺寸下的视觉重心。
 */
import { computed } from 'vue'

export type TrajectoryIconName =
  | 'prism'
  | 'whisper'
  | 'nit'
  | 'parallel'
  | 'compute'
  | 'files'
  | 'radar'
  | 'patch'
  | 'console'
  | 'alarm'
  | 'gem-heart'
  | 'stronghold'
  | 'shelf'
  | 'aperture'
  | 'windows'
  | 'cursor'
  | 'globe'
  | 'social'
  | 'skill'
  | 'pass'
  | 'error'
  | 'module'
  | 'code-tag'
  | 'flow-next'
  | 'chev-down'
  | 'chev-right'
  | 'ext'
  | 'step-trail'
  | 'spark-four'

const props = withDefaults(
  defineProps<{
    name: TrajectoryIconName | string
    size?: 'xs' | 'sm' | 'md' | 'lg'
  }>(),
  {
    size: 'sm',
  },
)

/** 兼容旧版通用图标语义名到轨迹双调精工图标名的映射 */
const ALIAS_MAP: Record<string, TrajectoryIconName> = {
  brain: 'prism',
  thought: 'whisper',
  quote: 'whisper',
  code: 'nit',
  file: 'files',
  folder: 'files',
  search: 'radar',
  edit: 'patch',
  terminal: 'console',
  clock: 'alarm',
  ticket: 'alarm',
  heart: 'gem-heart',
  'door-open': 'stronghold',
  home: 'stronghold',
  image: 'aperture',
  activity: 'cursor',
  'map-pin': 'cursor',
  chat: 'social',
  puzzle: 'skill',
  check: 'pass',
  cpu: 'module',
  tool: 'module',
  'chevron-down': 'chev-down',
  'chevron-right': 'chev-right',
}

const resolved = computed<TrajectoryIconName>(() => {
  const raw = props.name
  if (raw in ALIAS_MAP) return ALIAS_MAP[raw]!
  const known: ReadonlySet<string> = new Set<TrajectoryIconName>([
    'prism',
    'whisper',
    'nit',
    'parallel',
    'compute',
    'files',
    'radar',
    'patch',
    'console',
    'alarm',
    'gem-heart',
    'stronghold',
    'shelf',
    'aperture',
    'windows',
    'cursor',
    'globe',
    'social',
    'skill',
    'pass',
    'error',
    'module',
    'code-tag',
    'flow-next',
    'chev-down',
    'chev-right',
    'ext',
    'step-trail',
    'spark-four',
  ])
  return known.has(raw) ? (raw as TrajectoryIconName) : 'module'
})

const viewBox = computed(() => (resolved.value === 'step-trail' ? '0 0 28 12' : '0 0 16 16'))
</script>

<template>
  <svg
    class="traj-ico"
    :class="[`traj-ico--${size}`, { 'traj-ico--wide': resolved === 'step-trail' }]"
    :viewBox="viewBox"
    fill="none"
    aria-hidden="true"
  >
    <!-- 1. 思考星轨棱镜 (prism) -->
    <template v-if="resolved === 'prism'">
      <polygon points="8,2.2 13.8,8 8,13.8 2.2,8" fill="currentColor" fill-opacity="0.18" />
      <polygon
        points="8,2.2 13.8,8 8,13.8 2.2,8"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <polygon points="8,5.2 10.8,8 8,10.8 5.2,8" fill="currentColor" />
      <circle cx="8" cy="1.8" r="1.05" fill="currentColor" />
      <circle cx="14.2" cy="8" r="1.05" fill="currentColor" fill-opacity="0.7" />
      <circle cx="1.8" cy="8" r="1.05" fill="currentColor" fill-opacity="0.7" />
    </template>

    <!-- 2. 角色轻语星芒云 (whisper) -->
    <template v-else-if="resolved === 'whisper'">
      <path
        d="M2.2 4.5a2 2 0 0 1 2-2h6.3a2 2 0 0 1 2 2v4.8a2 2 0 0 1-2 2H6.2l-2.6 2.1v-2.1H4.2a2 2 0 0 1-2-2V4.5Z"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <circle cx="5.7" cy="7" r="0.95" fill="currentColor" />
      <circle cx="8.7" cy="7" r="0.95" fill="currentColor" fill-opacity="0.65" />
      <path
        d="M13.3 1.2c.2 1.1.5 1.4 1.6 1.6-1.1.2-1.4.5-1.6 1.6-.2-1.1-.5-1.4-1.6-1.6 1.1-.2 1.4-.5 1.6-1.6Z"
        fill="currentColor"
      />
    </template>

    <!-- 3. NIT 编排双轨电路铭牌 (nit) -->
    <template v-else-if="resolved === 'nit'">
      <rect
        x="1.5"
        y="5.8"
        width="4.2"
        height="4.4"
        rx="1.1"
        fill="currentColor"
        fill-opacity="0.24"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path
        d="M5.8 8h2.1m0 0V4.2c0-.6.4-1 1-1h2.4M7.9 8v3.8c0 .6.4 1 1 1h2.4"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
      />
      <polygon points="13,1.8 14.8,3.2 13,4.6 11.2,3.2" fill="currentColor" />
      <polygon points="13,10.4 14.8,11.8 13,13.2 11.2,11.8" fill="currentColor" fill-opacity="0.78" />
    </template>

    <!-- 4. 并发双流车道 (parallel) -->
    <template v-else-if="resolved === 'parallel'">
      <rect x="1.5" y="2.8" width="13" height="10.4" rx="2" fill="currentColor" fill-opacity="0.14" />
      <path
        d="M3.2 5.8h7.6m-1.8-1.8 2 1.8-2 1.8"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M3.2 10.4h7.6m-1.8-1.8 2 1.8-2 1.8"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.72"
      />
    </template>

    <!-- 5. NIT 沙箱演算矩阵 (compute) -->
    <template v-else-if="resolved === 'compute'">
      <rect
        x="2"
        y="2"
        width="12"
        height="12"
        rx="2.5"
        fill="currentColor"
        fill-opacity="0.18"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path
        d="M9.6 4.6c-1.1 0-1.5.6-1.7 1.8l-.6 3.5c-.2 1-.6 1.5-1.5 1.5M5.8 7.5h3.5"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
      <circle cx="11.4" cy="11.2" r="1" fill="currentColor" />
    </template>

    <!-- 6. 折角双层源码页 (files) -->
    <template v-else-if="resolved === 'files'">
      <path
        d="M5.2 2.2h5.3l3 3v7.3a1.3 1.3 0 0 1-1.3 1.3H5.2a1.3 1.3 0 0 1-1.3-1.3V3.5a1.3 1.3 0 0 1 1.3-1.3Z"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        d="M2.4 4.8v8.2a1.4 1.4 0 0 0 1.4 1.4h6.4"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
        opacity="0.52"
      />
      <path
        d="M10.2 2.3v3.1h3.1"
        fill="currentColor"
        fill-opacity="0.45"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
      <path
        d="M6.2 8.2h4.6M6.2 10.6h3.1"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
      />
    </template>

    <!-- 7. 十字准星光学检索镜 (radar) -->
    <template v-else-if="resolved === 'radar'">
      <circle
        cx="7.2"
        cy="7.2"
        r="4.7"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <circle cx="7.2" cy="7.2" r="1.25" fill="currentColor" />
      <path
        d="M7.2 4.1v1.1M7.2 9.2v1.1M4.1 7.2h1.1M9.2 7.2h1.1"
        stroke="currentColor"
        stroke-width="1.15"
        stroke-linecap="round"
        opacity="0.7"
      />
      <path d="M10.7 10.7 14 14" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" />
    </template>

    <!-- 8. 斜切笔尖代码补丁 (patch) -->
    <template v-else-if="resolved === 'patch'">
      <rect
        x="2"
        y="2.5"
        width="9.5"
        height="11"
        rx="1.8"
        fill="currentColor"
        fill-opacity="0.18"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path
        d="M4.3 6.2h3.5M4.3 8.8h2.2"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
        opacity="0.7"
      />
      <path
        d="M12.4 3.2 14.3 5.1 9.4 10l-2.3.5.5-2.3 4.8-5Z"
        fill="currentColor"
        fill-opacity="0.35"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </template>

    <!-- 9. 顶栏终端控制台 (console) -->
    <template v-else-if="resolved === 'console'">
      <rect
        x="1.8"
        y="2.5"
        width="12.4"
        height="11"
        rx="2"
        fill="currentColor"
        fill-opacity="0.16"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path d="M1.8 5.4h12.4" stroke="currentColor" stroke-width="1.15" opacity="0.55" />
      <path
        d="M4.5 8l2.1 1.7-2.1 1.7"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <rect x="7.8" y="10.2" width="3.2" height="1.4" rx="0.4" fill="currentColor" />
    </template>

    <!-- 10. 双耳机械提醒钟 (alarm) -->
    <template v-else-if="resolved === 'alarm'">
      <circle
        cx="8"
        cy="8.7"
        r="5.1"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path
        d="M2.6 4.2 4.8 2.4M13.4 4.2 11.2 2.4"
        stroke="currentColor"
        stroke-width="1.45"
        stroke-linecap="round"
      />
      <path
        d="M8 6v2.8l2 1.2"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="8" cy="8.7" r="0.9" fill="currentColor" />
    </template>

    <!-- 11. 切面心晶徽标 (gem-heart) -->
    <template v-else-if="resolved === 'gem-heart'">
      <path
        d="M8 13.6s-5.4-3.3-5.4-7.1a3.1 3.1 0 0 1 5.4-2 3.1 3.1 0 0 1 5.4 2c0 3.8-5.4 7.1-5.4 7.1Z"
        fill="currentColor"
        fill-opacity="0.26"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        d="M4.6 6.2a1.5 1.5 0 0 1 1.5-1.4"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
      />
    </template>

    <!-- 12. 拱门据点小屋 (stronghold) -->
    <template v-else-if="resolved === 'stronghold'">
      <path
        d="M2.6 7.2 8 2.6l5.4 4.6v5.7a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V7.2Z"
        fill="currentColor"
        fill-opacity="0.18"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        d="M6.5 13.9v-3.4a1.5 1.5 0 0 1 3 0v3.4"
        fill="currentColor"
        fill-opacity="0.55"
        stroke="currentColor"
        stroke-width="1.2"
      />
    </template>

    <!-- 13. 透视托盘置物架 (shelf) -->
    <template v-else-if="resolved === 'shelf'">
      <path
        d="M2.2 9.5 4 4.2h8l1.8 5.3v3.2a1.1 1.1 0 0 1-1.1 1.1H3.3a1.1 1.1 0 0 1-1.1-1.1V9.5Z"
        fill="currentColor"
        fill-opacity="0.18"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path
        d="M2.3 9.6h3.4l1 1.4h2.6l1-1.4h3.4"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linejoin="round"
      />
      <path
        d="M8 2v4.6M6.3 3.7 8 2l1.7 1.7"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 14. 四角取景光圈窗 (aperture) -->
    <template v-else-if="resolved === 'aperture'">
      <rect x="3.2" y="4" width="9.6" height="8" rx="1.5" fill="currentColor" fill-opacity="0.18" />
      <path
        d="M2 5.2V3.3c0-.5.4-.9.9-.9h2M11.1 2.4h2c.5 0 .9.4.9.9v1.9M14 10.8v1.9c0 .5-.4.9-.9.9h-2M4.9 13.6h-2a.9.9 0 0 1-.9-.9v-1.9"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
      <circle
        cx="8"
        cy="8"
        r="2.1"
        fill="currentColor"
        fill-opacity="0.4"
        stroke="currentColor"
        stroke-width="1.25"
      />
    </template>

    <!-- 15. 桌面窗口层叠 (windows) -->
    <template v-else-if="resolved === 'windows'">
      <rect
        x="4.2"
        y="2.2"
        width="9.6"
        height="7.8"
        rx="1.4"
        fill="currentColor"
        fill-opacity="0.14"
        stroke="currentColor"
        stroke-width="1.25"
        opacity="0.65"
      />
      <rect
        x="2.2"
        y="5.4"
        width="9.6"
        height="8.2"
        rx="1.4"
        fill="currentColor"
        fill-opacity="0.24"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path d="M2.2 7.8h9.6" stroke="currentColor" stroke-width="1.15" opacity="0.6" />
    </template>

    <!-- 16. 精准光标点击 (cursor) -->
    <template v-else-if="resolved === 'cursor'">
      <path
        d="M4.2 2.8 12.6 7l-3.6 1.2-1.4 3.8-3.4-9.2Z"
        fill="currentColor"
        fill-opacity="0.28"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path d="M9.4 9.4 13 13" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
      <path
        d="M2.6 5.8A3.2 3.2 0 0 1 5.8 2.6"
        stroke="currentColor"
        stroke-width="1.15"
        stroke-linecap="round"
        opacity="0.65"
      />
    </template>

    <!-- 17. 经纬浏览器球 (globe) -->
    <template v-else-if="resolved === 'globe'">
      <circle
        cx="8"
        cy="8"
        r="5.6"
        fill="currentColor"
        fill-opacity="0.18"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <ellipse cx="8" cy="8" rx="2.5" ry="5.5" stroke="currentColor" stroke-width="1.2" opacity="0.8" />
      <path d="M2.6 8h10.8" stroke="currentColor" stroke-width="1.2" opacity="0.8" />
      <circle cx="11.8" cy="4.2" r="1.05" fill="currentColor" />
    </template>

    <!-- 18. 社交信号对话铭牌 (social) -->
    <template v-else-if="resolved === 'social'">
      <path
        d="M2.4 4.2a1.8 1.8 0 0 1 1.8-1.8h7.6a1.8 1.8 0 0 1 1.8 1.8v5.2a1.8 1.8 0 0 1-1.8 1.8H6.8l-2.8 2.3v-2.3H4.2a1.8 1.8 0 0 1-1.8-1.8V4.2Z"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <path d="M5.4 6.8h5.2M5.4 9h3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </template>

    <!-- 19. 技能扩展拼图铭牌 (skill) -->
    <template v-else-if="resolved === 'skill'">
      <path
        d="M6.3 3.4a1.7 1.7 0 1 1 3.4 0h2.1a1 1 0 0 1 1 1v2.1a1.6 1.6 0 1 0 0 3.2v2.1a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1h2.1Z"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
      />
      <circle cx="7.4" cy="8.1" r="1.1" fill="currentColor" />
    </template>

    <!-- 20. 双调认证通过圆章 (pass) -->
    <template v-else-if="resolved === 'pass'">
      <circle
        cx="8"
        cy="8"
        r="5.8"
        fill="currentColor"
        fill-opacity="0.22"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path
        d="M5.4 8.2 7.2 10l3.5-3.8"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 21. 双调异常警示圆章 (error) -->
    <template v-else-if="resolved === 'error'">
      <circle
        cx="8"
        cy="8"
        r="5.8"
        fill="currentColor"
        fill-opacity="0.22"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <path d="M8 5v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="8" cy="10.9" r="0.95" fill="currentColor" />
    </template>

    <!-- 22. 代码尖括号 (code-tag) -->
    <template v-else-if="resolved === 'code-tag'">
      <path
        d="M5.2 4.8 2.2 8l3 3.2M10.8 4.8l3 3.2-3 3.2M9 3.6 7 12.4"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 23. 流向连接箭头 (flow-next) -->
    <template v-else-if="resolved === 'flow-next'">
      <path
        d="M3 8h9.5m-3-3 3.2 3-3.2 3"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 24. 下折角 (chev-down) -->
    <template v-else-if="resolved === 'chev-down'">
      <path
        d="M4.2 6.2 8 10l3.8-3.8"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 25. 右折角 (chev-right) -->
    <template v-else-if="resolved === 'chev-right'">
      <path
        d="M6.2 4.2 10 8l-3.8 3.8"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 26. 外链跳转 (ext) -->
    <template v-else-if="resolved === 'ext'">
      <path
        d="M9.5 3.5h3v3M12.2 3.8 7.2 8.8M12.5 9v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 27. 空间穿梭步进轨 (step-trail) -->
    <template v-else-if="resolved === 'step-trail'">
      <circle cx="3" cy="6" r="1.4" fill="currentColor" fill-opacity="0.45" />
      <circle cx="9.5" cy="6" r="1.4" fill="currentColor" fill-opacity="0.7" />
      <path
        d="M14.5 6h9m-2.8-2.8L23.8 6l-3.1 2.8"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>

    <!-- 28. 四角轻语星芒 (spark-four) -->
    <template v-else-if="resolved === 'spark-four'">
      <path
        d="M8 1.5c.5 3.6 1.4 4.5 5 5-3.6.5-4.5 1.4-5 5-.5-3.6-1.4-4.5-5-5 3.6-.5 4.5-1.4 5-5Z"
        fill="currentColor"
        fill-opacity="0.32"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linejoin="round"
      />
    </template>

    <!-- 29. 默认精密核心模块 (module) -->
    <template v-else>
      <rect
        x="3.2"
        y="3.2"
        width="9.6"
        height="9.6"
        rx="2"
        fill="currentColor"
        fill-opacity="0.2"
        stroke="currentColor"
        stroke-width="1.35"
      />
      <rect x="6.2" y="6.2" width="3.6" height="3.6" rx="0.8" fill="currentColor" />
      <path
        d="M6 1.6v1.6M10 1.6v1.6M6 12.8v1.6M10 12.8v1.6M1.6 6h1.6M1.6 10h1.6M12.8 6h1.6M12.8 10h1.6"
        stroke="currentColor"
        stroke-width="1.25"
        stroke-linecap="round"
      />
    </template>
  </svg>
</template>

<style scoped>
.traj-ico {
  display: inline-block;
  flex-shrink: 0;
  overflow: visible;
  vertical-align: -2px;
}
.traj-ico--xs {
  width: 13.5px;
  height: 13.5px;
  vertical-align: -2px;
}
.traj-ico--sm {
  width: 15px;
  height: 15px;
  vertical-align: -2.5px;
}
.traj-ico--md {
  width: 17px;
  height: 17px;
  vertical-align: -3px;
}
.traj-ico--lg {
  width: 20px;
  height: 20px;
}
.traj-ico--wide {
  width: 32px;
  height: 14px;
  vertical-align: -2px;
}
</style>
