<template>
  <div class="bedrock-demo-wrapper">
    <!-- 3D 舞台 -->
    <div ref="container" class="bedrock-avatar-container" role="img" aria-label="Bedrock 模型 3D 预览">
      <div ref="canvasContainer" class="canvas-container"></div>
      <div v-if="loading" class="state-overlay">正在加载 3D 模型……</div>
      <div v-if="errorMsg" class="state-overlay is-error">
        {{ errorMsg }}
      </div>
    </div>

    <!-- 控制面板 -->
    <div class="demo-controls">
      <label class="control-group">
        <span class="label">动作</span>
        <select v-model="selectedAnim" @change="playAnimation">
          <option value="">待机</option>
          <option v-for="anim in animList" :key="anim" :value="anim">{{ anim }}</option>
        </select>
      </label>
      <fieldset class="control-group">
        <legend class="label">穿搭</legend>
        <div class="checkbox-group">
          <label>
            <input v-model="clothingState.dress" type="checkbox" @change="updateClothing" />
            裙装
          </label>
          <label>
            <input v-model="clothingState.hat" type="checkbox" @change="updateClothing" />
            帽子
          </label>
          <label>
            <input v-model="clothingState.armour" type="checkbox" @change="updateClothing" />
            护甲
          </label>
        </div>
      </fieldset>
    </div>

    <div class="demo-instructions">
      <p>左键拖拽旋转 · Ctrl + 左键平移 · 滚轮缩放；触屏可单指旋转、双指缩放</p>
      <p class="author-credit">
        模型作者
        <a href="https://space.bilibili.com/5950899" target="_blank" rel="noopener noreferrer">@Dr咕咚</a>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { withBase } from 'vitepress'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// 简化的 BedrockLoader 和 AnimationManager (为了演示目的，我们尽量复用逻辑但简化依赖)
// 在实际项目中，我们应该从 src/components/avatar/lib 导入，但 vitepress 环境可能不同
// 这里我们假设可以直接引用，如果不行则需要调整路径或内联
// 由于 vitepress 构建机制，直接引用 src 下的 ts 文件可能会有问题，最好是构建好的 lib 或者简单的内联
// 为了保证演示的稳定性，我们将使用一个简化的内联加载逻辑，或者尝试直接 import

import { AvatarRenderer } from '../../../frontend/src/components/avatar/lib/AvatarRenderer'
import { AnimationEngine } from '../../../frontend/src/components/avatar/lib/animation/AnimationEngine'
import { AnimationLibrary } from '../../../frontend/src/components/avatar/lib/animation/AnimationLibrary'
import { RetargetingManager } from '../../../frontend/src/components/avatar/lib/retargeting/RetargetingManager'
import { WikiModelProvider } from './WikiModelProvider'
import { StandardBones } from '../../../frontend/src/components/avatar/lib/retargeting/RetargetingConfig'

const container = ref<HTMLElement | null>(null)
const canvasContainer = ref<HTMLElement | null>(null)
const loading = ref(true)
const errorMsg = ref('')
const animList = ref<string[]>([])
const selectedAnim = ref('')

const clothingState = ref({
  dress: true,
  armour: true,
  hat: true,
  underwear: true,
  censored: false,
})

// Three.js 对象
const scene = shallowRef<THREE.Scene | null>(null)
const camera = shallowRef<THREE.PerspectiveCamera | null>(null)
const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
const controls = shallowRef<OrbitControls | null>(null)

// 渲染架构对象
const retargetingManager = new RetargetingManager()
const animationEngine = new AnimationEngine(retargetingManager)
const avatarRenderer = new AvatarRenderer()
const animationLibrary = new AnimationLibrary()

let characterModel: THREE.Group | null = null
let animationFrameId: number
let lastTime = 0

const playAnimation = () => {
  if (selectedAnim.value) {
    const animData = animationLibrary.get(selectedAnim.value)
    if (animData) {
      animationEngine.play(animData, 0.2, true)
    }
  }
}

const updateClothing = () => {
  if (!characterModel) return
  const isShy = !clothingState.value.dress || !clothingState.value.underwear

  characterModel.traverse((child: any) => {
    const name = child.name
    if (!name) return

    if (name.includes('Dress') || name.includes('BreastDress')) {
      child.visible = clothingState.value.dress
    } else if (name.includes('Armour')) {
      child.visible = clothingState.value.armour
    } else if (name.includes('Hat')) {
      child.visible = clothingState.value.hat
    } else if (name.toLowerCase().includes('underwear')) {
      child.visible = clothingState.value.underwear
    } else if (name.includes('Censored')) {
      child.visible = clothingState.value.censored
    } else if (name.includes('embarrassed')) {
      child.visible = isShy
      if (child.position.z > -3.0) child.position.z -= 1.2
    }
  })
}

let isVisible = true
let observer: IntersectionObserver | null = null

function startRenderLoop() {
  if (!animationFrameId && isVisible) {
    lastTime = performance.now()
    animationFrameId = requestAnimationFrame(animate)
  }
}

function stopRenderLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = 0
  }
}

const handleVisibilityChange = () => {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    stopRenderLoop()
  } else if (isVisible) {
    startRenderLoop()
  }
}

onMounted(async () => {
  if (typeof window === 'undefined') return // SSR check

  initThree()
  await loadModel()
  startRenderLoop()

  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  // 视口感知：3D 画布滚出屏幕时彻底停止 WebGL 渲染，释放 GPU 负载
  if ('IntersectionObserver' in window && container.value) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          isVisible = entry.isIntersecting
          if (isVisible) {
            startRenderLoop()
          } else {
            stopRenderLoop()
          }
        }
      },
      { threshold: 0.05 }
    )
    observer.observe(container.value)
  }
})

onUnmounted(() => {
  if (typeof window === 'undefined') return

  stopRenderLoop()
  if (observer) {
    observer.disconnect()
    observer = null
  }
  window.removeEventListener('resize', onResize)
  document.removeEventListener('visibilitychange', handleVisibilityChange)

  if (renderer.value) {
    renderer.value.dispose()
  }
  animationEngine.stop()
})

function initThree() {
  if (!container.value || !canvasContainer.value) return

  const s = new THREE.Scene()
  // s.background = new THREE.Color(0xf0f4f8); // Removed for transparent background
  scene.value = s

  const c = new THREE.PerspectiveCamera(
    40,
    container.value.clientWidth / container.value.clientHeight,
    0.1,
    1000,
  )
  c.position.set(0, 20, 90)
  camera.value = c

  const r = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  r.setClearColor(0x000000, 0) // Ensure fully transparent
  r.setSize(container.value.clientWidth, container.value.clientHeight)
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  r.shadowMap.enabled = true
  canvasContainer.value.appendChild(r.domElement)
  renderer.value = r

  const ctrl = new OrbitControls(c, r.domElement)
  ctrl.target.set(0, 21, 0)
  ctrl.enableDamping = true

  // 交互配置：左键旋转，Ctrl+左键平移
  ctrl.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN, // 虽然保留右键平移，但由于浏览器手势冲突，我们将主推 Ctrl+左键
  }
  // 启用按键修改器：允许通过 Ctrl 键将左键行为临时改为平移
  ctrl.enablePan = true
  ctrl.keyPanSpeed = 7.0

  controls.value = ctrl

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  s.add(ambient)
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
  dirLight.position.set(20, 50, 30)
  dirLight.castShadow = true
  s.add(dirLight)
  const fillLight = new THREE.DirectionalLight(0xffeedd, 0.5)
  fillLight.position.set(-20, 20, 20)
  s.add(fillLight)

  // Ground
  const groundGeo = new THREE.PlaneGeometry(100, 100)
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.1 })
  const ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  s.add(ground)
}

async function loadModel() {
  try {
    const config = {
      name: 'Rossi',
      model: withBase('/assets/3d/Rossi/models/main.json'),
      texture: withBase('/assets/3d/Rossi/textures/texture.png'),
      animation: [
        withBase('/assets/3d/Rossi/animations/main.animation.json'),
        withBase('/assets/3d/Rossi/animations/tac.animation.json'),
        withBase('/assets/3d/Rossi/animations/carryon.animation.json'),
        withBase('/assets/3d/Rossi/animations/extra.animation.json'),
        withBase('/assets/3d/Rossi/animations/tlm.animation.json'),
      ],
    }

    const provider = new WikiModelProvider(config, [
      'GUI',
      'HUD',
      'PANEL',
      'BUTTON',
      'TEXT',
      'START',
      'END',
      'BACKGROUND',
      'MOLANG',
    ])
    const rootGroup = await avatarRenderer.build(provider)
    characterModel = rootGroup
    scene.value?.add(rootGroup)

    // 加载动画
    const animations = await provider.getAnimations()
    animations.forEach((clip, name) => {
      animationLibrary.add(name, clip)
    })
    animList.value = animationLibrary.getNames().sort()

    // 绑定重定向
    retargetingManager.init(rootGroup, { mapping: {} })

    // 自动播放 idle
    const idleAnim =
      animList.value.find((n) => n === 'idle') || animList.value.find((n) => n === 'tac:idle')
    if (idleAnim) {
      const animData = animationLibrary.get(idleAnim)
      if (animData) {
        animationEngine.play(animData)
        selectedAnim.value = idleAnim
      }
    }

    updateClothing()
    loading.value = false
    lastTime = performance.now()
  } catch (e: any) {
    console.error(e)
    errorMsg.value = '模型没能加载出来，请刷新页面再试一次。'
    loading.value = false
  }
}

function animate() {
  if (!isVisible) {
    animationFrameId = 0
    return
  }
  animationFrameId = requestAnimationFrame(animate)
  if (controls.value) controls.value.update()

  const now = performance.now()
  const dt = (now - lastTime) / 1000
  lastTime = now

  animationEngine.update(dt)

  if (renderer.value && scene.value && camera.value) {
    renderer.value.render(scene.value, camera.value)
  }
}

function onResize() {
  if (!container.value || !camera.value || !renderer.value) return
  camera.value.aspect = container.value.clientWidth / container.value.clientHeight
  camera.value.updateProjectionMatrix()
  renderer.value.setSize(container.value.clientWidth, container.value.clientHeight)
}
</script>

<style scoped>
.bedrock-demo-wrapper {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-lg);
  overflow: hidden;
  background:
    radial-gradient(60% 70% at 50% 35%, var(--wk-sky-soft), transparent 70%),
    radial-gradient(50% 50% at 80% 90%, var(--wk-pink-soft), transparent 70%),
    var(--vp-c-bg-elv);
}

.bedrock-avatar-container {
  position: relative;
  width: 100%;
  height: 460px;
}

.canvas-container {
  width: 100%;
  height: 100%;
}

.state-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 10;
  transform: translate(-50%, -50%);
  padding: 12px 18px;
  font-size: 14px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-md);
}

.state-overlay.is-error {
  color: var(--vp-c-danger-1);
}

.demo-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 28px;
  padding: 14px 18px;
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.control-group {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
}

.label {
  float: left;
  padding: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--wk-pink-text);
}

select {
  height: 32px;
  padding: 0 10px;
  font-size: 14px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-border);
  border-radius: var(--wk-radius-sm);
}

select:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--vp-c-text-1);
  cursor: pointer;
}

.checkbox-group input {
  accent-color: var(--wk-pink-strong);
}

.demo-instructions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 18px 12px;
  border-top: 1px dashed var(--vp-c-divider);
  font-size: 13px;
  text-align: center;
  color: var(--vp-c-text-2);
}

.demo-instructions p {
  margin: 0;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .bedrock-avatar-container {
    height: 360px;
  }
}

.author-credit {
  margin: 0;
  font-size: 0.9em;
  color: var(--vp-c-text-3);
}

.author-credit a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
  font-weight: 600;
  transition: color 0.2s;
}

.author-credit a:hover {
  color: var(--vp-c-brand-2);
  text-decoration: underline;
}
</style>
