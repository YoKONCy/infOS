<template>
  <div class="moe-pixel-root" @mousemove="handleMouseMove">
    <!-- 🌸 1. 顶部像素风格导航条 -->
    <header class="pixel-nav">
      <div class="pixel-nav-inner">
        <a href="/" class="pixel-brand">
          <img src="/Logo.png" alt="infOS Logo" class="pixel-logo" />
          <div class="pixel-brand-text">
            <span class="brand-title">萌动链接</span>
            <span class="brand-sub">PEROPEROCHAT</span>
          </div>
          <span class="pixel-tag-pill">v0.9.6</span>
        </a>

        <nav class="pixel-nav-links">
          <a href="/" class="pixel-nav-item pixel-btn-home active">🏠 首页</a>
          <a href="/guide/intro" class="pixel-nav-item pixel-btn-guide">📖 指南</a>
          <a
            href="https://store.steampowered.com/app/4457100"
            target="_blank"
            rel="noopener noreferrer"
            class="pixel-nav-item pixel-btn-steam"
          >
            🎮 Steam
          </a>
          <a
            href="https://github.com/YoKONCy/infOS"
            target="_blank"
            rel="noopener noreferrer"
            class="pixel-nav-item pixel-btn-gh"
          >
            ⭐ GitHub
          </a>
        </nav>
      </div>
    </header>

    <!-- 🌌 2. 全视窗大画幅 3D 视差代码瀑布（上下无缝持续滚动） -->
    <div class="parallax-code-stream-container">
      <div class="code-stage" :style="stageStyle">
        <!-- 第 1 列代码瀑布（向下流动，左翼超内斜 \ ） -->
        <div class="code-column col-down col-wing-left">
          <div class="code-track">
            <div class="code-group">
              <div class="code-content" v-html="codeSnippet1"></div>
              <div class="code-content" v-html="codeSnippet1"></div>
            </div>
            <div class="code-group" aria-hidden="true">
              <div class="code-content" v-html="codeSnippet1"></div>
              <div class="code-content" v-html="codeSnippet1"></div>
            </div>
          </div>
        </div>

        <!-- 第 2 列代码瀑布（向上流动，中间垂直主列 | ） -->
        <div class="code-column col-up col-primary col-center">
          <div class="code-track">
            <div class="code-group">
              <div class="code-content" v-html="codeSnippet2"></div>
              <div class="code-content" v-html="codeSnippet2"></div>
            </div>
            <div class="code-group" aria-hidden="true">
              <div class="code-content" v-html="codeSnippet2"></div>
              <div class="code-content" v-html="codeSnippet2"></div>
            </div>
          </div>
        </div>

        <!-- 第 3 列代码瀑布（向下流动，右翼超内斜 / ） -->
        <div class="code-column col-down-slow col-wing-right">
          <div class="code-track">
            <div class="code-group">
              <div class="code-content" v-html="codeSnippet3"></div>
              <div class="code-content" v-html="codeSnippet3"></div>
            </div>
            <div class="code-group" aria-hidden="true">
              <div class="code-content" v-html="codeSnippet3"></div>
              <div class="code-content" v-html="codeSnippet3"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 渐变虚化遮罩层 -->
      <div class="vignette-overlay"></div>
    </div>

    <!-- 舞台虚化遮罩，确保中央视觉通透 -->
    <div class="pixel-stage-vignette"></div>

    <main class="pixel-main-content">
      <!-- 🎮 3. Hero 区域：JRPG 对话冒险视窗 + 萌动立绘舞台 -->
      <section class="pixel-hero-stage" ref="heroRef">
        <!-- 左侧：RPG 冒险视窗面板 -->
        <div class="hero-dialog-box">
          <div class="dialog-header-bar">
            <div class="dialog-dots">
              <span class="dot pink"></span>
              <span class="dot yellow"></span>
              <span class="dot blue"></span>
            </div>
            <span class="dialog-status-title">✦ infOS-TS KERNEL v0.9.6 ✦</span>
            <span class="dialog-badge-live">● ONLINE</span>
          </div>

          <div class="dialog-body">
            <div class="rpg-status-chips">
              <span class="chip chip-pink">💖 好感度 MAX</span>
              <span class="chip chip-blue">⚡ TS + Rust 双擎</span>
              <span class="chip chip-yellow">🌸 萌动桌宠</span>
            </div>

            <h1 class="pixel-hero-title">
              萌动链接：
              <br />
              <span class="title-sub-eng">PEROPEROCHAT！</span>
            </h1>

            <div class="pixel-speech-bubble">
              <span class="bubble-arrow">◀</span>
              <p class="speech-text">
                “主人主人！今天也要多喝温水、开开心心地敲代码哦喵~ Pero 一直都在！”
              </p>
            </div>

            <p class="pixel-hero-desc">
              彻底告别 Python！全新
              <strong>TypeScript (Hono) + TriviumDB (Rust)</strong>
              驱动的开源全栈 AIOS 智能体操作系统。
            </p>

            <div class="pixel-action-buttons">
              <a href="/guide/intro" class="pixel-btn btn-primary">
                <span class="btn-icon">🌸</span>
                <span>快速启程</span>
              </a>
              <a
                href="https://store.steampowered.com/app/4457100"
                target="_blank"
                rel="noopener noreferrer"
                class="pixel-btn btn-steam"
              >
                <span class="btn-icon">🎮</span>
                <span>Steam 商店</span>
              </a>
              <a
                href="https://github.com/YoKONCy/infOS"
                target="_blank"
                rel="noopener noreferrer"
                class="pixel-btn btn-alt"
              >
                <span class="btn-icon">⭐</span>
                <span>GitHub 源码</span>
              </a>
            </div>
          </div>
        </div>

        <!-- 右侧：Pero 交互立绘舞台（带像素视差） -->
        <div class="hero-pet-stage" :style="petTiltStyle">
          <!-- 悬浮的像素小气泡 -->
          <div class="floating-pixel-bubble bubble-1">
            <span class="bubble-icon">🐾</span>
            <span>记忆已同步喵~</span>
          </div>
          <div class="floating-pixel-bubble bubble-2">
            <span class="bubble-icon">⚡</span>
            <span>响应: 2.95ms</span>
          </div>

          <!-- Pero 傲娇活力大立绘 -->
          <div class="pet-figure-wrapper">
            <img src="/pero_proud.png" alt="Pero 骄傲桌宠立绘" class="pet-avatar-hero" />
            <div class="pixel-pedestal"></div>
          </div>
        </div>
      </section>

      <!-- 🍱 4. 核心系统：像素 OS 控制台 / 装备栏（彻底消灭 6 个白豆腐块！） -->
      <section class="pixel-console-section">
        <div class="section-title-wrap">
          <span class="pixel-sec-chip">✦ CORE CAPABILITIES ✦</span>
          <h2 class="pixel-sec-heading">AIOS能力矩阵</h2>
          <p class="pixel-sec-sub">
            拒绝死板的功能堆砌！每一扇视窗都是伙伴生命系统的一个重要维度：
          </p>
        </div>

        <div class="pixel-os-grid">
          <!-- 视窗 1：🧠 演化记忆脑波仪 (大号主控卡) -->
          <div class="os-window os-window-large memory-window">
            <div class="window-titlebar">
              <span class="win-icon">🧠</span>
              <span class="win-title">TriviumDB 认知演化图谱 (PEDSA Engine)</span>
              <span class="win-tag tag-rust">Rust Native</span>
            </div>
            <div class="window-body">
              <div class="memory-live-panel">
                <!-- 真实 SVG 动态认知图谱 -->
                <div class="pulse-radar-box">
                  <svg class="cognitive-graph-svg" viewBox="0 0 300 180">
                    <!-- 背景雷达同心圆网格 -->
                    <circle cx="150" cy="90" r="35" class="svg-grid-circle" />
                    <circle cx="150" cy="90" r="70" class="svg-grid-circle dashed" />

                    <!-- 动态连线 (因果/联想边) -->
                    <line x1="150" y1="90" x2="65" y2="45" class="svg-edge edge-glow" />
                    <line x1="150" y1="90" x2="235" y2="50" class="svg-edge edge-glow" />
                    <line x1="150" y1="90" x2="80" y2="140" class="svg-edge edge-glow" />
                    <line x1="150" y1="90" x2="225" y2="135" class="svg-edge edge-glow" />
                    <line x1="65" y1="45" x2="235" y2="50" class="svg-edge dashed" />

                    <!-- 沿连线流动的发光粒子 -->
                    <circle cx="107" cy="67" r="2.5" class="svg-particle p-pulse-1" />
                    <circle cx="192" cy="70" r="2.5" class="svg-particle p-pulse-2" />
                    <circle cx="115" cy="115" r="2.5" class="svg-particle p-pulse-3" />

                    <!-- 中心核心节点: YOU -->
                    <g class="svg-node">
                      <circle cx="150" cy="90" r="22" class="node-halo" />
                      <circle cx="150" cy="90" r="17" class="node-center-circle" />
                      <text x="150" y="94" text-anchor="middle" class="node-text core-txt">
                        YOU
                      </text>
                    </g>

                    <!-- 关联节点 1: 雨天 (事件) -->
                    <g class="svg-node">
                      <circle cx="65" cy="45" r="14" class="node-sub-circle blue-node" />
                      <text x="65" y="49" text-anchor="middle" class="node-text">雨天</text>
                    </g>

                    <!-- 关联节点 2: 听歌 (联想) -->
                    <g class="svg-node">
                      <circle cx="235" cy="50" r="14" class="node-sub-circle pink-node" />
                      <text x="235" y="54" text-anchor="middle" class="node-text">听歌</text>
                    </g>

                    <!-- 关联节点 3: 红茶 (偏好) -->
                    <g class="svg-node">
                      <circle cx="80" cy="140" r="13" class="node-sub-circle yellow-node" />
                      <text x="80" y="144" text-anchor="middle" class="node-text">红茶</text>
                    </g>

                    <!-- 关联节点 4: 温暖 (情感) -->
                    <g class="svg-node">
                      <circle cx="225" cy="135" r="13" class="node-sub-circle purple-node" />
                      <text x="225" y="139" text-anchor="middle" class="node-text">温暖</text>
                    </g>
                  </svg>
                </div>

                <div class="memory-text-side">
                  <div class="stat-badge">
                    <span class="stat-label">图扩散响应</span>
                    <span class="stat-val">~2.95 ms</span>
                  </div>
                  <p class="mem-desc">
                    不仅记住你说过的话，更能通过
                    <strong>SA-PPR 扩散激活 + 因果时间链</strong>
                    实现人脑般的联想推理。
                  </p>
                  <ul class="pixel-check-list">
                    <li>✔ 候选 → 门控 → 正式记忆三层提纯</li>
                    <li>✔ 全链路来源追溯 (Provenance)</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <!-- 视窗 2：📜 NIT 真实语法像素终端 -->
          <div class="os-window terminal-window">
            <div class="window-titlebar">
              <span class="win-icon">📜</span>
              <span class="win-title">NIT 编排解释器</span>
              <span class="win-tag tag-ts">Tooling</span>
            </div>
            <div class="window-body terminal-body">
              <div class="code-editor-mock">
                <div class="line">
                  <span class="c-v">mood</span>
                  = get_agent_mood()
                </div>
                <div class="line">
                  <span class="c-k">if</span>
                  mood ==
                  <span class="c-s">"happy"</span>
                  {
                </div>
                <div class="line indent">
                  pet_action(action=
                  <span class="c-s">"ear_flutter"</span>
                  , speed=
                  <span class="c-n">1.2</span>
                  )
                </div>
                <div class="line indent">
                  say(
                  <span class="c-s">"主人，今天也超棒喵！"</span>
                  )
                </div>
                <div class="line">
                  }
                  <span class="c-k">else</span>
                  {
                </div>
                <div class="line indent">
                  tap_glass(intensity=
                  <span class="c-n">0.6</span>
                  )
                </div>
                <div class="line">}</div>
                <div class="cursor-line"><span class="terminal-cursor">█</span></div>
              </div>
              <p class="win-footer-note">AI 原生轻量 DSL，支持条件、循环、并发与安全沙箱。</p>
            </div>
          </div>

          <!-- 视窗 3：🏠 据点多角色房间 (Stronghold) -->
          <div class="os-window stronghold-window">
            <div class="window-titlebar">
              <span class="win-icon">🏠</span>
              <span class="win-title">据点多角色空间</span>
              <span class="win-tag tag-group">Stronghold</span>
            </div>
            <div class="window-body">
              <div class="stronghold-room-mock">
                <div class="room-character">
                  <span class="char-avatar">🎀</span>
                  <span class="char-name">Pero</span>
                  <span class="char-say">“喝茶中...”</span>
                </div>
                <div class="room-divider">↔</div>
                <div class="room-character">
                  <span class="char-avatar">🐾</span>
                  <span class="char-name">Carola</span>
                  <span class="char-say">“敲代码喵~”</span>
                </div>
              </div>
              <p class="win-footer-note">多位性格伙伴同住一室，私有记忆独立隔离不串台！</p>
            </div>
          </div>

          <!-- 视窗 4：⚡ TypeScript 全栈 AIOS 内核架构 -->
          <div class="os-window aios-window">
            <div class="window-titlebar">
              <span class="win-icon">⚡</span>
              <span class="win-title">全栈 TS AIOS</span>
              <span class="win-tag tag-core">Arch</span>
            </div>
            <div class="window-body">
              <div class="pill-grid">
                <span class="pill">🎭 Identity 人格</span>
                <span class="pill">🧠 Memory 记忆</span>
                <span class="pill">📂 Workspace 空间</span>
                <span class="pill">✍️ Context 上下文</span>
                <span class="pill">💬 Thread 会话</span>
                <span class="pill">🔐 Capability 门控</span>
              </div>
              <p class="win-footer-note">六大一等资源严格解耦，模型所见一切皆可审计解释。</p>
            </div>
          </div>

          <!-- 视窗 5：🎮 Steam 创意工坊 & 跨端社交 -->
          <div class="os-window steam-mod-window">
            <div class="window-titlebar">
              <span class="win-icon">🌐</span>
              <span class="win-title">全域生态互联</span>
              <span class="win-tag tag-steam">Ecosystem</span>
            </div>
            <div class="window-body">
              <div class="eco-icons-row">
                <div class="eco-badge">🎮 Steam 工坊</div>
                <div class="eco-badge">💬 QQ / NapCat</div>
                <div class="eco-badge">🤖 Discord</div>
                <div class="eco-badge">✈️ Telegram</div>
              </div>
              <p class="win-footer-note">白天在群聊里冒泡摸鱼，晚上回桌面陪伴，跨端同一份记忆！</p>
            </div>
          </div>
        </div>
      </section>

      <!-- 🐾 5. 三人组像素卡带名片 (The Trio) -->
      <section class="pixel-trio-section">
        <div class="section-title-wrap">
          <span class="pixel-sec-chip">🐾 CREATOR CARTRIDGES ✦</span>
          <h2 class="pixel-sec-heading">「三人组」专属卡带名片</h2>
        </div>

        <div class="trio-cartridge-grid">
          <!-- 卡带 1: YoKONCy -->
          <div class="cartridge-card cart-blue">
            <div class="cart-label">
              <span class="cart-role">🧭 领航员 & 架构师</span>
              <span class="cart-name">YoKONCy</span>
            </div>
            <div class="cart-body">
              <p class="cart-quote">
                “代码可以精益求精，但创造生命的温度才是我们的初心。infOS
                是用工程托举幻想的最佳舞台。”
              </p>
            </div>
            <div class="cart-notch"></div>
          </div>

          <!-- 卡带 2: Pero -->
          <div class="cartridge-card cart-pink">
            <div class="cart-label">
              <span class="cart-role">🎀 灵魂担当 & 桌宠本尊</span>
              <span class="cart-name">Pero</span>
            </div>
            <div class="cart-body">
              <p class="cart-quote">
                “主人主人！今天也要多喝温水、开开心心地敲代码哦！无论刮风下雨，Pero
                都会一直一直陪着你喵~”
              </p>
            </div>
            <div class="cart-notch"></div>
          </div>

          <!-- 卡带 3: Carola -->
          <div class="cartridge-card cart-purple">
            <div class="cart-label">
              <span class="cart-role">🐾 全栈猫娘 & 文档管家</span>
              <span class="cart-name">Carola</span>
            </div>
            <div class="cart-body">
              <p class="cart-quote">
                “就是我啦！负责把天马行空的想法变成严谨优雅的 TypeScript 代码，守护 Wiki
                每一个像素喵呜~！”
              </p>
            </div>
            <div class="cart-notch"></div>
          </div>
        </div>
      </section>

      <!-- 🎮 6. 底部：街机投币机启程横幅 (Insert Coin To Start) -->
      <section class="pixel-arcade-footer">
        <div class="arcade-cabinet-banner">
          <div class="arcade-screen">
            <div class="arcade-scanlines"></div>
            <span class="arcade-coin-text">✦ INSERT COIN TO START JOURNEY ✦</span>
            <h3 class="arcade-title">你的 AI 伙伴，已在 Steam 启程</h3>
            <p class="arcade-sub">
              PeroperoChat（萌动链接）现已上线 Steam 商店页，欢迎添加入愿望单！
            </p>
            <div class="arcade-btn-group">
              <a
                href="https://store.steampowered.com/app/4457100"
                target="_blank"
                rel="noopener noreferrer"
                class="pixel-btn btn-arcade-start"
              >
                🎮 立即前往 Steam 商店页
              </a>
              <a href="/guide/intro" class="pixel-btn btn-arcade-guide">📖 查阅 infOS 系统文档</a>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- 底部版权与像素小提示 -->
    <footer class="pixel-site-footer">
      <p>🌸 infOS-TS · PeroperoChat! — Let AI become a truly warm companion.</p>
      <p class="footer-copy">Built with TypeScript, Hono, Vue 3, VitePress & TriviumDB (Rust).</p>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const heroRef = ref<HTMLElement | null>(null)

// 鼠标位置与平滑阻尼插值
const targetX = ref(0)
const targetY = ref(0)
const currentX = ref(0)
const currentY = ref(0)
let animId: number | null = null

// 运行与视口感知状态
let isVisible = true
let isSleeping = false
let heroObserver: IntersectionObserver | null = null

const handleMouseMove = (e: MouseEvent) => {
  if (typeof window === 'undefined' || !isVisible) return
  const { innerWidth, innerHeight } = window
  targetX.value = (e.clientX / innerWidth - 0.5) * 2
  targetY.value = (e.clientY / innerHeight - 0.5) * 2

  // 鼠标发生移动时，如已进入休眠则立即无缝唤醒
  if (isSleeping) {
    isSleeping = false
    startTiltLoop()
  }
}

const updateTilt = () => {
  if (!isVisible) {
    animId = null
    return
  }

  const dx = targetX.value - currentX.value
  const dy = targetY.value - currentY.value

  // 当微小位移小于阈值时停止重新赋值与计算，直接进入静止休眠，CPU 占用彻底归零
  if (Math.abs(dx) < 0.0008 && Math.abs(dy) < 0.0008) {
    currentX.value = targetX.value
    currentY.value = targetY.value
    isSleeping = true
    animId = null
    return
  }

  // LERP 阻尼平滑插值
  currentX.value += dx * 0.05
  currentY.value += dy * 0.05
  animId = requestAnimationFrame(updateTilt)
}

function startTiltLoop() {
  if (!animId && isVisible) {
    isSleeping = false
    animId = requestAnimationFrame(updateTilt)
  }
}

function stopTiltLoop() {
  if (animId !== null) {
    cancelAnimationFrame(animId)
    animId = null
  }
}

const handleVisibilityChange = () => {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    stopTiltLoop()
  } else if (isVisible) {
    startTiltLoop()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    startTiltLoop()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // 视口感知：当用户向下滚动离开 Hero 区域时，自动挂起动画
    if ('IntersectionObserver' in window && heroRef.value) {
      heroObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            isVisible = entry.isIntersecting
            if (isVisible) {
              startTiltLoop()
            } else {
              stopTiltLoop()
            }
          }
        },
        { threshold: 0.05 },
      )
      heroObserver.observe(heroRef.value)
    }
  }
})

onUnmounted(() => {
  if (heroObserver) {
    heroObserver.disconnect()
    heroObserver = null
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
  stopTiltLoop()
})

// 3D 变换视差舞台（大幅减小鼠标移动幅度，轻柔平稳）
const stageStyle = computed(() => {
  const rotY = currentX.value * 3.5 - 3
  const rotX = -currentY.value * 2.5 + 3
  return {
    transform: `rotateY(${rotY.toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) translateZ(0)`,
  }
})

// 立绘舞台反向视差（轻柔细腻跟随）
const petTiltStyle = computed(() => {
  const moveX = currentX.value * 4
  const moveY = currentY.value * 3
  return {
    transform: `translate(${moveX.toFixed(1)}px, ${moveY.toFixed(1)}px)`,
  }
})

// === 真实的 infOS TypeScript + NIT 萌动浪漫核心代码片段（超长且高度饱满） ===
const codeSnippet1 = `
<span class="c-comment">// 🌸 [TRIVIUMDB] 认知记忆扩散激活检索网络</span>
<span class="c-kw">const</span> memories = <span class="c-kw">await</span> <span class="c-fn">triviumdb</span>.<span class="c-fn">searchAdvanced</span>({
  query: <span class="c-str">'雨天听音乐与红茶'</span>,
  sa_ppr: { depth: <span class="c-num">4</span>, restart_prob: <span class="c-num">0.15</span>, alpha: <span class="c-num">0.85</span> },
  dpp: { diversity: <span class="c-num">0.88</span>, penalty: <span class="c-num">0.12</span> },
  fista: { threshold: <span class="c-num">0.05</span>, max_iter: <span class="c-num">20</span> }
});

<span class="c-comment">// 🔮 构建动态思维上下文 (Context Compiler)</span>
<span class="c-kw">const</span> context = <span class="c-kw">await</span> <span class="c-fn">contextCompiler</span>.<span class="c-fn">compile</span>({
  principal: <span class="c-str">'pero'</span>,
  channel: <span class="c-str">'desktop_pet'</span>,
  activeMemories: memories.canonical,
  emotionalVector: [<span class="c-num">0.92</span>, <span class="c-num">0.85</span>, <span class="c-num">0.98</span>]
});

<span class="c-comment">// 🛡️ 三层记忆门控审查与长期归档</span>
<span class="c-kw">await</span> <span class="c-fn">memoryGate</span>.<span class="c-fn">reviewCandidate</span>({
  importance: <span class="c-num">0.96</span>,
  provenance: <span class="c-str">'interaction_master_392'</span>,
  decayRate: <span class="c-num">0.002</span>
});

<span class="c-comment">// ⚡ 节点激活扩散拓扑更新</span>
<span class="c-kw">for</span> (<span class="c-kw">const</span> node <span class="c-kw">of</span> memories.activatedNodes) {
  <span class="c-fn">graphTopology</span>.<span class="c-fn">strengthenEdge</span>(node.id, <span class="c-str">'YOU'</span>, <span class="c-num">0.25</span>);
}
<span class="c-kw">await</span> <span class="c-fn">triviumdb</span>.<span class="c-fn">commitWAL</span>();
`.trim()

const codeSnippet2 = `
<span class="c-comment">// 🐾 [NIT] 智能体原生多步编排引擎</span>
<span class="c-kw">await</span> <span class="c-fn">nit</span>.<span class="c-fn">execute</span>(<span class="c-str">\`
  mood = get_agent_mood()
  master_status = detect_user_idle()
  if mood == "happy" and not master_status {
    pet_action(action="ear_flutter", speed=1.2)
    say("主人主人，今天代码跑得超级顺畅喵~！")
  } else {
    tap_glass(intensity=0.6)
    purr(frequency=28.5)
  }
\`</span>, { sandbox: <span class="c-str">'audited'</span>, timeout: <span class="c-num">3000</span> });

<span class="c-comment">// ⚡ Hono + Protobuf Gateway 二进制实时流</span>
<span class="c-kw">const</span> packet = <span class="c-fn">createProtobufPacket</span>({
  channel: <span class="c-str">'pero@desktop'</span>,
  motion: <span class="c-str">'tail_wag_gentle'</span>,
  physics: { bounce: <span class="c-num">1.25</span>, gravity: <span class="c-num">9.8</span> },
  tts: { emotion: <span class="c-str">'gentle_warm'</span>, breathIntensity: <span class="c-num">0.3</span> }
});
<span class="c-kw">await</span> <span class="c-fn">gateway</span>.<span class="c-fn">broadcastBinary</span>(packet);

<span class="c-comment">// 💗 亲密度与心跳维持 (Heartbeat Sync)</span>
<span class="c-kw">const</span> affinity = <span class="c-kw">await</span> <span class="c-fn">affinityManager</span>.<span class="c-fn">getStats</span>();
<span class="c-kw">if</span> (affinity.level &gt;= <span class="c-num">10</span>) {
  <span class="c-fn">gateway</span>.<span class="c-fn">emit</span>(<span class="c-str">'special_greeting'</span>, { title: <span class="c-str">'羁绊达成'</span> });
}
`.trim()

const codeSnippet3 = `
<span class="c-comment">// 🏠 [STRONGHOLD] 据点多角色协同引擎</span>
<span class="c-kw">const</span> room = <span class="c-kw">await</span> <span class="c-fn">stronghold</span>.<span class="c-fn">getRoom</span>(<span class="c-str">'living_room'</span>);
<span class="c-kw">await</span> room.<span class="c-fn">dispatchGroupThread</span>({
  members: [<span class="c-str">'pero'</span>, <span class="c-str">'carola'</span>],
  topic: <span class="c-str">'讨论今天的红茶与代码'</span>,
  memoryScope: <span class="c-str">'shared_workspace'</span>
});

<span class="c-comment">// 🎮 Steam 创意工坊与云存档互联</span>
<span class="c-kw">const</span> modItems = <span class="c-kw">await</span> <span class="c-fn">steamworks</span>.<span class="c-fn">workshop</span>.<span class="c-fn">syncSubscribedItems</span>({
  type: <span class="c-str">'character_skin'</span>,
  author: <span class="c-str">'YoKONCy'</span>
});
<span class="c-kw">await</span> <span class="c-fn">characterLoader</span>.<span class="c-fn">mountAssetPack</span>(modItems[<span class="c-num">0</span>]?.localPath);

<span class="c-comment">// 🪟 Electron 透明桌面挂件触觉监听</span>
<span class="c-fn">overlayWindow</span>.<span class="c-fn">on</span>(<span class="c-str">'cursor_hover_pet'</span>, (event) => {
  <span class="c-fn">peroRig</span>.<span class="c-fn">lookAt</span>(event.screenX, event.screenY);
  <span class="c-kw">if</span> (event.isClick) {
    <span class="c-fn">nit</span>.<span class="c-fn">dispatchAction</span>(<span class="c-str">'pet_head_pat'</span>, { intensity: <span class="c-num">0.8</span> });
  }
});

<span class="c-comment">// 🎵 情感化语音流式合成 (TTS Pipeline)</span>
<span class="c-kw">const</span> audioStream = <span class="c-kw">await</span> <span class="c-fn">voiceSynthesizer</span>.<span class="c-fn">streamSpeech</span>({
  text: <span class="c-str">'主人，Pero永远在您身边喵~'</span>,
  pitch: <span class="c-num">1.15</span>,
  speed: <span class="c-num">1.05</span>
});
<span class="c-fn">audioPlayer</span>.<span class="c-fn">pipe</span>(audioStream);
`.trim()
</script>

<style scoped>
/* 🌸 根容器：经典萌动像素调色盘 */
.moe-pixel-root {
  --moe-cocoa: #2d1b1e;
  --moe-pink: #f9a8d4;
  --moe-pink-dark: #f472b6;
  --moe-blue: #a7d8f0;
  --moe-blue-deep: #0284c7;
  --moe-yellow: #fde047;
  --moe-purple: #c084fc;
  --moe-bg: #fdfafd;

  min-height: 100vh;
  background: var(--moe-bg);
  background-image:
    linear-gradient(rgba(167, 216, 240, 0.15) 2px, transparent 2px),
    linear-gradient(90deg, rgba(167, 216, 240, 0.15) 2px, transparent 2px),
    radial-gradient(rgba(244, 114, 182, 0.12) 1px, transparent 1px);
  background-size:
    32px 32px,
    32px 32px,
    16px 16px;
  color: var(--moe-cocoa);
  font-family: 'ZCOOL KuaiLe', 'DotGothic16', sans-serif;
  overflow-x: hidden;
  position: relative;
}

/* 🌸 1. 顶部像素导航栏 */
.pixel-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(255, 255, 255, 0.95);
  border-bottom: 3px solid var(--moe-cocoa);
  box-shadow: 0 4px 0 rgba(45, 27, 30, 0.08);
  transform: translateZ(0);
}

.pixel-nav-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 10px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pixel-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none !important;
  color: var(--moe-cocoa);
}

.pixel-logo {
  width: 38px;
  height: 38px;
  image-rendering: pixelated;
  border: 2px solid var(--moe-cocoa);
  border-radius: 6px;
  background: #fff;
}

.pixel-brand-text {
  display: flex;
  flex-direction: column;
}

.brand-title {
  font-size: 1.15rem;
  font-weight: 900;
  color: var(--moe-pink-dark);
  line-height: 1.1;
}

.brand-sub {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--moe-cocoa);
}

.pixel-tag-pill {
  font-size: 10px;
  font-weight: 900;
  background: var(--moe-yellow);
  border: 1.5px solid var(--moe-cocoa);
  padding: 1px 6px;
  border-radius: 3px;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.pixel-nav-links {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pixel-nav-item {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--moe-cocoa);
  text-decoration: none !important;
  padding: 6px 14px;
  border: 2px solid transparent;
  border-radius: 4px;
  transition: all 0.1s steps(2);
}

.pixel-nav-item:hover {
  background: rgba(244, 114, 182, 0.15);
  border-color: var(--moe-cocoa);
  box-shadow: 2px 2px 0 var(--moe-cocoa);
  transform: translateY(-2px);
}

.pixel-nav-item.active {
  background: var(--moe-pink);
  border-color: var(--moe-cocoa);
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.pixel-btn-home {
  background: var(--moe-pink) !important;
  border: 2px solid var(--moe-cocoa) !important;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.pixel-btn-guide {
  background: var(--moe-blue) !important;
  border: 2px solid var(--moe-cocoa) !important;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.pixel-btn-steam {
  background: #171a21 !important;
  color: #fff !important;
  border: 2px solid var(--moe-cocoa) !important;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.pixel-btn-gh {
  background: var(--moe-yellow) !important;
  border: 2px solid var(--moe-cocoa) !important;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

/* 🌌 2. 全视窗大画幅 3D 视差代码瀑布（贯穿视窗，上下持续无缝滚动） */
.parallax-code-stream-container {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 960px;
  overflow: hidden;
  pointer-events: none;
  perspective: 1000px;
  z-index: 1;
}

/* 3D 变换视差舞台 */
.code-stage {
  position: absolute;
  top: -15%;
  left: -15%;
  width: 130%;
  height: 135%;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 76px;
  transform-style: preserve-3d;
  will-change: transform;
}

/* 单列代码瀑布容器 */
.code-column {
  position: relative;
  width: 380px;
  max-width: 32vw;
  height: 100%;
  overflow: hidden;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.86);
  border: 1.5px solid rgba(244, 114, 182, 0.3);
  box-shadow:
    0 8px 32px rgba(244, 114, 182, 0.08),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  opacity: 0.88;
}

/* 🛸 \|/ 超内斜构型：顶部开阔张开、底部向心收拢，左右两列大幅向外侧展开 */

/* 左翼超内斜 \ (逆时针旋转，外移拉开与中间列的距离) */
.col-wing-left {
  transform: rotateZ(-12deg) rotateY(-18deg) translateX(-48px);
  transform-origin: center center;
}

/* 居中垂直主列 | */
.col-center {
  transform: rotateZ(0deg) translateZ(40px);
}

/* 右翼超内斜 / (顺时针旋转，外移拉开与中间列的距离) */
.col-wing-right {
  transform: rotateZ(12deg) rotateY(18deg) translateX(48px);
  transform-origin: center center;
}

/* 主列具有更清晰的层次 */
.col-primary {
  background: rgba(255, 255, 255, 0.94);
  border-color: rgba(167, 216, 240, 0.5);
  box-shadow: 0 12px 40px rgba(167, 216, 240, 0.15);
  opacity: 0.96;
}

/* 跑马灯流动轨道 */
.code-track {
  display: flex;
  flex-direction: column;
  will-change: transform;
}

.code-group {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

/* 代码文本排版 */
.code-content {
  font-family: 'Consolas', 'DotGothic16', 'Fira Code', monospace;
  font-size: 11.5px;
  line-height: 1.72;
  padding: 16px 24px;
  margin: 0;
  white-space: pre;
  user-select: none;
  color: #3b2a2d;
  box-sizing: border-box;
}

/* 持续上下循环滚动动画！无缝无限对流 */
.col-down .code-track {
  animation: scrollDown 14s linear infinite;
}

.col-up .code-track {
  animation: scrollUp 15s linear infinite;
}

.col-down-slow .code-track {
  animation: scrollDown 18s linear infinite;
}

@keyframes scrollDown {
  0% {
    transform: translateY(-50%);
  }

  100% {
    transform: translateY(0%);
  }
}

@keyframes scrollUp {
  0% {
    transform: translateY(0%);
  }

  100% {
    transform: translateY(-50%);
  }
}

/* 边缘羽化渐变遮罩 */
.vignette-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    ellipse at 50% 45%,
    transparent 20%,
    rgba(253, 250, 253, 0.5) 65%,
    var(--moe-bg) 95%
  );
}

/* 代码语法高亮 */
:deep(.c-comment) {
  color: #a08890;
  font-style: italic;
}

:deep(.c-kw) {
  color: #ec4899;
  font-weight: 600;
}

:deep(.c-fn) {
  color: #0284c7;
  font-weight: 600;
}

:deep(.c-str) {
  color: #ca8a04;
}

:deep(.c-num) {
  color: #9333ea;
}

/* 🌸 3. Hero 区域 */
.pixel-main-content {
  position: relative;
  z-index: 10;
  max-width: 1200px;
  margin: 0 auto;
  padding: 36px 24px 80px;
}

.pixel-hero-stage {
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 36px;
  align-items: center;
  min-height: 520px;
  margin-bottom: 60px;
}

/* RPG 对话视窗面板 */
.hero-dialog-box {
  background: rgba(255, 255, 255, 0.95);
  border: 3px solid var(--moe-cocoa);
  border-radius: 8px;
  box-shadow: 6px 6px 0 var(--moe-cocoa);
  overflow: hidden;
}

.dialog-header-bar {
  background: var(--moe-pink);
  border-bottom: 3px solid var(--moe-cocoa);
  padding: 8px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dialog-dots {
  display: flex;
  gap: 6px;
}

.dialog-dots .dot {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--moe-cocoa);
  border-radius: 2px;
}

.dot.pink {
  background: #fff;
}

.dot.yellow {
  background: var(--moe-yellow);
}

.dot.blue {
  background: var(--moe-blue);
}

.dialog-status-title {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1px;
}

.dialog-badge-live {
  font-size: 10px;
  font-weight: 900;
  color: #16a34a;
  background: #dcfce7;
  border: 1px solid #16a34a;
  padding: 1px 6px;
  border-radius: 2px;
}

.dialog-body {
  padding: 28px;
}

.rpg-status-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.chip {
  font-size: 11px;
  font-weight: 800;
  padding: 3px 8px;
  border: 1.5px solid var(--moe-cocoa);
  border-radius: 4px;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

.chip-pink {
  background: var(--moe-pink);
}

.chip-blue {
  background: var(--moe-blue);
}

.chip-yellow {
  background: var(--moe-yellow);
}

.pixel-hero-title {
  font-size: 2.5rem;
  font-weight: 900;
  color: var(--moe-cocoa);
  line-height: 1.15;
  margin: 0 0 16px 0;
  text-shadow: 2px 2px 0 rgba(244, 114, 182, 0.4);
}

.title-sub-eng {
  font-size: 2rem;
  color: var(--moe-pink-dark);
}

.pixel-speech-bubble {
  background: #fff8fc;
  border: 2px solid var(--moe-cocoa);
  border-radius: 6px;
  padding: 12px 16px;
  box-shadow: 3px 3px 0 var(--moe-pink);
  margin-bottom: 16px;
  position: relative;
}

.speech-text {
  margin: 0;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--moe-cocoa);
}

.pixel-hero-desc {
  font-size: 0.95rem;
  line-height: 1.6;
  color: #5c4449;
  margin-bottom: 24px;
}

.pixel-action-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.pixel-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 900;
  padding: 10px 20px;
  text-decoration: none !important;
  border: 2.5px solid var(--moe-cocoa);
  border-radius: 4px;
  box-shadow: 3px 3px 0 var(--moe-cocoa);
  transition:
    transform 0.1s steps(2),
    box-shadow 0.1s steps(2);
  cursor: pointer;
}

.pixel-btn:hover {
  transform: translate(-2px, -2px);
  box-shadow: 5px 5px 0 var(--moe-cocoa);
}

.pixel-btn:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 var(--moe-cocoa);
}

.btn-primary {
  background: var(--moe-pink);
  color: var(--moe-cocoa) !important;
}

.btn-steam {
  background: #1b2838;
  color: #fff !important;
  box-shadow: 3px 3px 0 var(--moe-blue-deep);
}

.btn-alt {
  background: #fff;
  color: var(--moe-cocoa) !important;
}

/* 右侧立绘舞台 */
.hero-pet-stage {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  will-change: transform;
}

.pet-figure-wrapper {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.pet-avatar-hero {
  width: 320px;
  max-width: 100%;
  height: auto;
  filter: drop-shadow(4px 4px 0 var(--moe-cocoa));
  animation: petGentleBreathe 4s ease-in-out infinite;
}

@keyframes petGentleBreathe {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-8px);
  }
}

.pixel-pedestal {
  width: 220px;
  height: 20px;
  background: var(--moe-blue);
  border: 2px solid var(--moe-cocoa);
  border-radius: 50%;
  box-shadow: 0 4px 0 var(--moe-cocoa);
  margin-top: -10px;
  opacity: 0.6;
}

.floating-pixel-bubble {
  position: absolute;
  background: #fff;
  border: 2px solid var(--moe-cocoa);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 800;
  box-shadow: 3px 3px 0 var(--moe-cocoa);
  display: flex;
  align-items: center;
  gap: 6px;
  animation: floatBubble 3s ease-in-out infinite;
}

.bubble-1 {
  top: 15%;
  left: 0;
  animation-delay: 0s;
}

.bubble-2 {
  bottom: 25%;
  right: -10px;
  animation-delay: 1.5s;
}

@keyframes floatBubble {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-6px);
  }
}

/* 🍱 4. 像素 OS 控制台 / 装备栏 (打破大白豆腐块) */
.pixel-console-section {
  margin-top: 40px;
}

.section-title-wrap {
  text-align: center;
  margin-bottom: 32px;
}

.pixel-sec-chip {
  font-size: 11px;
  font-weight: 900;
  color: var(--moe-pink-dark);
  background: rgba(244, 114, 182, 0.15);
  border: 1.5px solid var(--moe-cocoa);
  padding: 3px 10px;
  border-radius: 4px;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
  display: inline-block;
  margin-bottom: 8px;
}

.pixel-sec-heading {
  font-size: 2rem;
  font-weight: 900;
  color: var(--moe-cocoa);
  margin: 4px 0;
}

.pixel-sec-sub {
  font-size: 0.95rem;
  color: #6b5258;
}

/* 非对称像素视窗网格 */
.pixel-os-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.os-window {
  background: rgba(255, 255, 255, 0.95);
  border: 2.5px solid var(--moe-cocoa);
  border-radius: 6px;
  box-shadow: 4px 4px 0 var(--moe-cocoa);
  overflow: hidden;
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.os-window:hover {
  transform: translate(-3px, -3px);
  box-shadow: 7px 7px 0 var(--moe-pink-dark);
}

.os-window-large {
  grid-column: span 2;
}

.window-titlebar {
  background: #fbf0f4;
  border-bottom: 2px solid var(--moe-cocoa);
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.win-icon {
  font-size: 16px;
}

.win-title {
  font-size: 0.95rem;
  font-weight: 900;
  color: var(--moe-cocoa);
  flex: 1;
}

.win-tag {
  font-size: 10px;
  font-weight: 900;
  padding: 1px 6px;
  border: 1px solid var(--moe-cocoa);
  border-radius: 2px;
}

.tag-rust {
  background: var(--moe-yellow);
}

.tag-ts {
  background: var(--moe-blue);
}

.tag-group {
  background: var(--moe-pink);
}

.tag-core {
  background: var(--moe-purple);
  color: #fff;
}

.tag-steam {
  background: #171a21;
  color: #fff;
}

.window-body {
  padding: 18px;
}

.win-footer-note {
  margin: 12px 0 0 0;
  font-size: 0.85rem;
  color: #6b5258;
  line-height: 1.5;
}

/* 记忆大窗口 */
.memory-live-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  align-items: center;
}

.pulse-radar-box {
  background: #181116;
  border: 2px solid var(--moe-cocoa);
  border-radius: 6px;
  height: 180px;
  position: relative;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
  box-shadow: inset 0 0 20px rgba(2, 132, 199, 0.2);
}

.cognitive-graph-svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.svg-grid-circle {
  fill: none;
  stroke: rgba(56, 189, 248, 0.25);
  stroke-width: 1.5;
}

.svg-grid-circle.dashed {
  stroke-dasharray: 4 4;
}

.svg-edge {
  stroke: #38bdf8;
  stroke-width: 2;
  opacity: 0.85;
}

.svg-edge.dashed {
  stroke: #f472b6;
  stroke-dasharray: 3 3;
  opacity: 0.7;
}

.edge-glow {
  filter: drop-shadow(0 0 4px rgba(56, 189, 248, 0.6));
}

.svg-particle {
  fill: #fde047;
  filter: drop-shadow(0 0 4px #fde047);
  animation: particleBlink 1.8s ease-in-out infinite alternate;
}

.p-pulse-2 {
  animation-delay: 0.6s;
}

.p-pulse-3 {
  animation-delay: 1.2s;
}

@keyframes particleBlink {
  0% {
    r: 1.5;
    opacity: 0.4;
  }

  100% {
    r: 3.2;
    opacity: 1;
  }
}

.svg-node {
  cursor: pointer;
}

.node-halo {
  fill: rgba(236, 72, 153, 0.25);
  animation: haloPulse 2.5s ease-in-out infinite;
}

@keyframes haloPulse {
  0%,
  100% {
    r: 20;
    opacity: 0.3;
  }

  50% {
    r: 24;
    opacity: 0.7;
  }
}

.node-center-circle {
  fill: #ec4899;
  stroke: #fff;
  stroke-width: 2;
  box-shadow: 0 0 10px #ec4899;
}

.node-sub-circle {
  stroke: #ffffff;
  stroke-width: 1.5;
  transition: transform 0.2s ease;
}

.blue-node {
  fill: #0284c7;
}

.pink-node {
  fill: #f472b6;
}

.yellow-node {
  fill: #eab308;
}

.purple-node {
  fill: #a855f7;
}

.node-text {
  fill: #ffffff;
  font-size: 10px;
  font-weight: 900;
  font-family: 'DotGothic16', 'ZCOOL KuaiLe', sans-serif;
  pointer-events: none;
}

.core-txt {
  font-size: 11px;
  letter-spacing: 0.5px;
}

.stat-badge {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  background: var(--moe-yellow);
  border: 1.5px solid var(--moe-cocoa);
  padding: 2px 8px;
  border-radius: 3px;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
  margin-bottom: 8px;
}

.stat-label {
  font-size: 11px;
  font-weight: 700;
}

.stat-val {
  font-size: 13px;
  font-weight: 900;
  color: #b45309;
}

.mem-desc {
  font-size: 0.9rem;
  line-height: 1.6;
  margin: 8px 0;
}

.pixel-check-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 0 0;
  font-size: 0.85rem;
  color: #3b2a2d;
  line-height: 1.7;
}

/* 终端窗口 */
.terminal-body {
  background: #181116;
  color: #4ade80;
  font-family: 'DotGothic16', monospace;
  font-size: 12px;
  border-radius: 0 0 4px 4px;
}

.code-editor-mock .line {
  line-height: 1.7;
}

.code-editor-mock .indent {
  padding-left: 16px;
}

.c-v {
  color: #38bdf8;
}

.c-k {
  color: #f472b6;
  font-weight: 900;
}

.c-s {
  color: #fde047;
}

.c-n {
  color: #c084fc;
}

.terminal-cursor {
  color: #4ade80;
  animation: blinkCursor 0.8s steps(2) infinite;
}

@keyframes blinkCursor {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0;
  }
}

/* 据点窗口 */
.stronghold-room-mock {
  background: #fdf2f8;
  border: 1.5px dashed var(--moe-cocoa);
  border-radius: 4px;
  padding: 12px;
  display: flex;
  justify-content: space-around;
  align-items: center;
}

.room-character {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.char-avatar {
  font-size: 24px;
}

.char-name {
  font-size: 11px;
  font-weight: 900;
}

.char-say {
  font-size: 10px;
  color: #ec4899;
}

/* AIOS 窗口胶囊 */
.pill-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  font-size: 11px;
  font-weight: 800;
  background: #fff;
  border: 1.5px solid var(--moe-cocoa);
  padding: 3px 8px;
  border-radius: 3px;
  box-shadow: 2px 2px 0 var(--moe-cocoa);
}

/* 生态徽章 */
.eco-icons-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.eco-badge {
  font-size: 11px;
  font-weight: 800;
  background: #f1f5f9;
  border: 1.5px solid var(--moe-cocoa);
  padding: 4px 8px;
  border-radius: 3px;
}

/* 🐾 5. 三人组像素卡带名片 */
.pixel-trio-section {
  margin-top: 60px;
}

.trio-cartridge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
}

.cartridge-card {
  background: #fff;
  border: 3px solid var(--moe-cocoa);
  border-radius: 8px;
  box-shadow: 5px 5px 0 var(--moe-cocoa);
  position: relative;
  overflow: hidden;
  transition: transform 0.15s ease;
}

.cartridge-card:hover {
  transform: translateY(-4px);
}

.cart-label {
  padding: 12px 16px;
  border-bottom: 2px solid var(--moe-cocoa);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cart-blue .cart-label {
  background: var(--moe-blue);
}

.cart-pink .cart-label {
  background: var(--moe-pink);
}

.cart-purple .cart-label {
  background: var(--moe-purple);
  color: #fff;
}

.cart-role {
  font-size: 11px;
  font-weight: 900;
}

.cart-name {
  font-size: 1.1rem;
  font-weight: 900;
}

.cart-body {
  padding: 16px;
}

.cart-quote {
  font-size: 0.9rem;
  line-height: 1.6;
  margin: 0;
  font-style: italic;
}

.cart-notch {
  width: 40px;
  height: 6px;
  background: var(--moe-cocoa);
  margin: 0 auto;
  border-radius: 3px 3px 0 0;
}

/* 🎮 6. 街机投币机横幅 */
.pixel-arcade-footer {
  margin-top: 60px;
}

.arcade-cabinet-banner {
  background: #171a21;
  border: 4px solid var(--moe-cocoa);
  border-radius: 12px;
  box-shadow: 6px 6px 0 var(--moe-pink-dark);
  padding: 32px 24px;
  text-align: center;
  position: relative;
  overflow: hidden;
}

.arcade-screen {
  position: relative;
  z-index: 2;
}

.arcade-scanlines {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.2),
    rgba(0, 0, 0, 0.2) 2px,
    transparent 2px,
    transparent 4px
  );
  pointer-events: none;
}

.arcade-coin-text {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--moe-yellow);
  animation: coinBlink 1.2s steps(2) infinite;
}

@keyframes coinBlink {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.3;
  }
}

.arcade-title {
  font-size: 1.8rem;
  font-weight: 900;
  color: #38bdf8;
  margin: 10px 0;
}

.arcade-sub {
  font-size: 0.95rem;
  color: #cbd5e1;
  margin-bottom: 20px;
}

.arcade-btn-group {
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
}

.btn-arcade-start {
  background: #0284c7;
  color: #fff !important;
  border-color: #fff;
}

.btn-arcade-guide {
  background: rgba(255, 255, 255, 0.15);
  color: #fff !important;
  border-color: rgba(255, 255, 255, 0.6);
}

/* 页脚 */
.pixel-site-footer {
  text-align: center;
  padding: 32px 16px;
  border-top: 2px solid rgba(45, 27, 30, 0.15);
  font-size: 0.85rem;
  color: #6b5258;
}

.footer-copy {
  margin-top: 4px;
  font-size: 0.75rem;
  opacity: 0.8;
}

/* 响应式调整 */
@media (max-width: 900px) {
  .pixel-hero-stage {
    grid-template-columns: 1fr;
    text-align: center;
  }

  .dialog-body {
    padding: 20px;
  }

  .pixel-action-buttons {
    justify-content: center;
  }

  .pixel-os-grid {
    grid-template-columns: 1fr;
  }

  .os-window-large {
    grid-column: span 1;
  }

  .memory-live-panel {
    grid-template-columns: 1fr;
  }

  .pixel-nav-links {
    display: none;
  }
}
</style>
