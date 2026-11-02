<template>
  <canvas ref="canvas" class="particle-field" aria-hidden="true"></canvas>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { Particle } from '../characters'

/**
 * 全屏粒子层：飘落的角色专属粒子 + 鼠标拖尾 + 点击爆开。
 * 页面不可见或开启减少动态效果时停止绘制。
 */
const props = defineProps<{ kind: Particle; color: string; reduced: boolean }>()

const canvas = ref<HTMLCanvasElement | null>(null)

interface Dot {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  rot: number
  vr: number
  life: number
  max: number
  kind: Particle | 'spark'
  ambient: boolean
}

let ctx: CanvasRenderingContext2D | null = null
let dots: Dot[] = []
let raf = 0
let w = 0
let h = 0
let dpr = 1
let lastTrail = 0

function ambientCount() {
  // 粒子密度随屏幕面积变化，手机上更少
  return Math.round(Math.min(46, Math.max(14, (w * h) / 42000)))
}

function spawnAmbient(top = false): Dot {
  return {
    x: Math.random() * w,
    y: top ? -20 : Math.random() * h,
    vx: (Math.random() - 0.5) * 0.35,
    vy: 0.25 + Math.random() * 0.55,
    r: 6 + Math.random() * 9,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.02,
    life: 0,
    max: Infinity,
    kind: props.kind,
    ambient: true,
  }
}

function resize() {
  const el = canvas.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  w = window.innerWidth
  h = window.innerHeight
  el.width = w * dpr
  el.height = h * dpr
  ctx = el.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  const need = ambientCount()
  const ambient = dots.filter((d) => d.ambient)
  if (ambient.length < need) for (let i = ambient.length; i < need; i++) dots.push(spawnAmbient())
}

function drawShape(c: CanvasRenderingContext2D, d: Dot) {
  const r = d.r
  switch (d.kind) {
    case 'heart': {
      c.beginPath()
      c.moveTo(0, r * 0.35)
      c.bezierCurveTo(-r, -r * 0.4, -r * 0.45, -r * 1.05, 0, -r * 0.45)
      c.bezierCurveTo(r * 0.45, -r * 1.05, r, -r * 0.4, 0, r * 0.35)
      c.fill()
      break
    }
    case 'petal': {
      c.beginPath()
      c.ellipse(0, 0, r * 0.55, r, 0, 0, Math.PI * 2)
      c.fill()
      c.globalAlpha *= 0.5
      c.beginPath()
      c.ellipse(0, -r * 0.2, r * 0.18, r * 0.6, 0, 0, Math.PI * 2)
      c.fillStyle = '#ffffff'
      c.fill()
      break
    }
    case 'star':
    case 'spark': {
      const n = d.kind === 'spark' ? 4 : 5
      const inner = d.kind === 'spark' ? 0.28 : 0.45
      c.beginPath()
      for (let i = 0; i < n * 2; i++) {
        const a = (i * Math.PI) / n - Math.PI / 2
        const rr = i % 2 ? r * inner : r
        c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr)
      }
      c.closePath()
      c.fill()
      break
    }
    case 'paw': {
      c.beginPath()
      c.ellipse(0, r * 0.25, r * 0.55, r * 0.45, 0, 0, Math.PI * 2)
      c.fill()
      for (const [x, y] of [
        [-0.62, -0.32],
        [-0.22, -0.72],
        [0.22, -0.72],
        [0.62, -0.32],
      ] as const) {
        c.beginPath()
        c.ellipse(x * r, y * r, r * 0.2, r * 0.25, 0, 0, Math.PI * 2)
        c.fill()
      }
      break
    }
  }
}

function frame(t: number) {
  raf = requestAnimationFrame(frame)
  const c = ctx
  if (!c) return
  c.clearRect(0, 0, w, h)
  const next: Dot[] = []
  for (const d of dots) {
    d.life++
    d.x += d.vx + (d.ambient ? Math.sin(t / 1600 + d.r) * 0.25 : 0)
    d.y += d.vy
    d.rot += d.vr
    if (!d.ambient) d.vy += 0.06
    const fade = d.ambient ? 1 : 1 - d.life / d.max
    if (d.ambient && d.y > h + 30) {
      next.push(spawnAmbient(true))
      continue
    }
    if (!d.ambient && fade <= 0) continue
    c.save()
    c.translate(d.x, d.y)
    c.rotate(d.rot)
    // 飘落粒子用主色低透明度，浅色和深色区块上都看得见
    c.globalAlpha = (d.ambient ? 0.32 : 0.95) * fade
    c.fillStyle = d.kind === 'spark' ? '#fff6c8' : props.color
    if (!d.ambient) {
      c.shadowColor = props.color
      c.shadowBlur = 8
    }
    drawShape(c, d)
    c.restore()
    next.push(d)
  }
  dots = next
}

function burst(x: number, y: number, n = 14) {
  if (props.reduced) return
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4
    const s = 2.5 + Math.random() * 3.5
    dots.push({
      x,
      y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s - 2,
      r: 5 + Math.random() * 7,
      rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.3,
      life: 0,
      max: 46 + Math.random() * 20,
      kind: i % 3 === 0 ? 'spark' : props.kind,
      ambient: false,
    })
  }
}

function onMove(e: PointerEvent) {
  if (props.reduced || e.pointerType !== 'mouse') return
  const now = performance.now()
  if (now - lastTrail < 38) return
  lastTrail = now
  dots.push({
    x: e.clientX,
    y: e.clientY,
    vx: (Math.random() - 0.5) * 1.2,
    vy: -0.4 - Math.random() * 0.6,
    r: 3 + Math.random() * 4,
    rot: 0,
    vr: 0.05,
    life: 0,
    max: 34,
    kind: 'spark',
    ambient: false,
  })
}

function onDown(e: PointerEvent) {
  burst(e.clientX, e.clientY)
}

function onVisibility() {
  if (document.hidden) stop()
  else start()
}

function start() {
  if (raf || props.reduced) return
  raf = requestAnimationFrame(frame)
}

function stop() {
  cancelAnimationFrame(raf)
  raf = 0
  ctx?.clearRect(0, 0, w, h)
}

watch(
  () => props.kind,
  (k) => dots.forEach((d) => d.ambient && (d.kind = k)),
)
watch(
  () => props.reduced,
  (r) => (r ? stop() : start()),
)

defineExpose({ burst })

onMounted(() => {
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('pointerdown', onDown, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)
  start()
})

onUnmounted(() => {
  stop()
  window.removeEventListener('resize', resize)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerdown', onDown)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped>
.particle-field {
  position: fixed;
  inset: 0;
  z-index: 40;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
