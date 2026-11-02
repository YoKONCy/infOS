<template>
  <div class="home">
    <!-- 首屏：Pero 打招呼 -->
    <section class="hero">
      <div class="hero-copy">
        <span class="wk-eyebrow">PEROPEROCHAT · 使用文档</span>
        <h1 class="hero-title">
          萌动链接：
          <span class="hero-brand">PeroperoChat！</span>
        </h1>
        <p class="hero-lead">
          一位住在你桌面上的 AI 伙伴：陪你聊天，记住你们一起经历的事，也能在你允许的范围里帮你整理文件、查资料、推进任务。
        </p>
        <div class="hero-actions">
          <a class="wk-btn primary" :href="withBase('/guide/usage')">
            <PixelIcon name="arrow" :size="14" />
            安装与上手
          </a>
          <a class="wk-btn" href="https://store.steampowered.com/app/4457100" target="_blank" rel="noopener noreferrer">
            在 Steam 查看
          </a>
          <a class="wk-btn ghost" href="https://github.com/YoKONCy/infOS/releases/latest" target="_blank" rel="noopener noreferrer">
            下载 Windows 版
          </a>
        </div>
        <p class="hero-meta">
          由开源项目
          <a href="https://github.com/YoKONCy/infOS" target="_blank" rel="noopener noreferrer">infOS</a>
          驱动 · Apache-2.0
        </p>
      </div>

      <div class="hero-stage">
        <div class="wk-bubble tail-down hero-bubble">
          <span class="wk-bubble-name">
            Pero
            <PixelIcon name="heart" :size="9" />
          </span>
          <p :key="bubble">{{ bubble }}</p>
        </div>
        <button type="button" class="hero-pero" :class="{ hop }" aria-label="戳一下 Pero" @click="poke">
          <img
            :src="withBase('/characters/pero-proud.webp')"
            alt=""
            width="300"
            height="463"
            fetchpriority="high"
          />
        </button>
        <span class="float-deco deco-heart" aria-hidden="true"><PixelIcon name="heart" :size="18" /></span>
        <span class="float-deco deco-spark" aria-hidden="true"><PixelIcon name="sparkle" :size="16" /></span>
      </div>
    </section>

    <!-- 分流：你想先做什么 -->
    <section class="block" aria-labelledby="routes-title">
      <header class="block-head">
        <span class="wk-eyebrow">01 · WHERE TO START</span>
        <h2 id="routes-title">你想先做什么？</h2>
      </header>
      <div class="routes">
        <div v-for="r in routes" :key="r.title" class="route-card">
          <span class="route-icon" :class="r.tone"><PixelIcon :name="r.icon" :size="20" /></span>
          <h3>
            <a class="route-link" :href="withBase(r.link)">{{ r.title }}</a>
          </h3>
          <p>{{ r.desc }}</p>
          <ul class="route-subs">
            <li v-for="s in r.subs" :key="s.link">
              <a :href="withBase(s.link)">{{ s.text }}</a>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 实拍：和伙伴的一天 -->
    <section class="block" aria-labelledby="showcase-title">
      <header class="block-head">
        <span class="wk-eyebrow">02 · A DAY WITH PERO</span>
        <h2 id="showcase-title">和伙伴的一天</h2>
      </header>
      <div v-for="(s, i) in showcase" :key="s.img" class="show-row" :class="{ flip: i % 2 === 1 }">
        <figure class="show-shot">
          <img :src="withBase(s.img)" :alt="s.alt" width="1600" height="955" loading="lazy" decoding="async" />
        </figure>
        <div class="show-copy">
          <span class="show-step">{{ s.step }}</span>
          <h3>{{ s.title }}</h3>
          <p>{{ s.desc }}</p>
          <a class="show-more" :href="withBase(s.link)">
            {{ s.linkText }}
            <PixelIcon name="arrow" :size="12" />
          </a>
        </div>
      </div>
    </section>

    <!-- 看板娘 -->
    <section class="block" aria-labelledby="cast-title">
      <header class="block-head">
        <span class="wk-eyebrow">03 · MEET THE COMPANIONS</span>
        <h2 id="cast-title">认识两位看板娘</h2>
      </header>
      <div class="cast">
        <article v-for="c in cast" :key="c.name" class="cast-card" :class="c.tone">
          <img class="cast-art" :src="withBase(c.art)" :alt="c.alt" loading="lazy" decoding="async" />
          <div class="cast-copy">
            <span class="wk-eyebrow">{{ c.role }}</span>
            <h3>{{ c.name }}</h3>
            <p>{{ c.desc }}</p>
            <blockquote>{{ c.quote }}</blockquote>
          </div>
        </article>
      </div>
      <p class="cast-note">
        应用里还有更多内置伙伴，也可以在
        <a :href="withBase('/companion/character')">角色管理</a>
        里创建属于你自己的那一位。
      </p>
    </section>

    <!-- 更多玩法 -->
    <section class="block" aria-labelledby="more-title">
      <header class="block-head">
        <span class="wk-eyebrow">04 · GOING FURTHER</span>
        <h2 id="more-title">更多玩法</h2>
      </header>
      <div class="tiles">
        <a v-for="t in tiles" :key="t.link" class="tile" :href="withBase(t.link)">
          <PixelIcon :name="t.icon" :size="16" />
          <span class="tile-title">{{ t.title }}</span>
          <span class="tile-desc">{{ t.desc }}</span>
        </a>
      </div>
    </section>

    <!-- 收尾 -->
    <section class="outro">
      <img :src="withBase('/characters/pero-cheer.webp')" alt="开心比划的 Pero" width="150" height="232" loading="lazy" />
      <div class="wk-bubble outro-bubble">
        <span class="wk-bubble-name">
          Pero
          <PixelIcon name="heart" :size="9" />
        </span>
        <p>
          文档哪里没看懂，或者发现写错了，都可以到
          <a href="https://github.com/YoKONCy/infOS/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a>
          告诉我们。Pero 会把它记在小本本上的！
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import PixelIcon from './PixelIcon.vue'
import { companions, peroGreeting, pickLine } from '../theme/characters'

/**
 * 文档站首页。首屏只有一个角色场景，下面按读者意图分流，再用实拍截图说明功能。
 */
const bubble = ref('锵锵！超级女仆 Pero 登场！今天想先了解什么呢？')
const hop = ref(false)
let hopTimer: ReturnType<typeof setTimeout> | undefined

function poke() {
  bubble.value = pickLine(companions.pero.pokes, bubble.value)
  hop.value = true
  clearTimeout(hopTimer)
  hopTimer = setTimeout(() => (hop.value = false), 360)
}

onMounted(() => {
  // 服务端渲染固定开场白，进入浏览器后再按本地时间换成时段问候
  bubble.value = peroGreeting(new Date().getHours())
})
onUnmounted(() => clearTimeout(hopTimer))

const routes = [
  {
    icon: 'home',
    tone: 'sky',
    title: '把 Pero 带回家',
    desc: '下载安装、连接 AI 模型、告诉她你是谁，然后打个招呼。',
    link: '/guide/usage',
    subs: [
      { text: '项目简介', link: '/guide/intro' },
      { text: '主界面导览', link: '/guide/dashboard' },
    ],
  },
  {
    icon: 'heart',
    tone: 'pink',
    title: '和伙伴日常相处',
    desc: '聊天、桌宠互动、调整她的人设，看看她怎样记住你们的经历。',
    link: '/companion/chat',
    subs: [
      { text: '桌宠与 3D 造型', link: '/companion/desktop-pet' },
      { text: '记忆与知识', link: '/companion/memory' },
    ],
  },
  {
    icon: 'sparkle',
    tone: 'violet',
    title: '请伙伴帮忙做事',
    desc: '让她读写文件、操作网页、执行后台任务，并由你决定权限范围。',
    link: '/work/tools',
    subs: [
      { text: '工作区与任务', link: '/work/tasks' },
      { text: '插件与子应用', link: '/work/extensions' },
    ],
  },
]

const showcase = [
  {
    step: '早上',
    img: '/screenshots/launcher.webp',
    alt: '启动器：选择伙伴，并检查后台服务、数据存储和 AI 模型的状态',
    title: '选好今天的伙伴',
    desc: '启动器会先检查后台服务、数据存储、AI 模型和记忆系统，再让你选择今天陪你的伙伴和启动方式。',
    link: '/guide/usage',
    linkText: '安装与上手',
  },
  {
    step: '工作时',
    img: '/screenshots/dashboard-pet.webp',
    alt: '主界面总览页，3D 桌宠站在窗口上方说话',
    title: '她就在窗口边上',
    desc: '主界面汇总天气、用量和伙伴的当前状态；3D 桌宠浮在桌面上，点一点会有回应，也能直接在她身边聊天。',
    link: '/companion/desktop-pet',
    linkText: '桌宠与 3D 造型',
  },
  {
    step: '闲下来',
    img: '/screenshots/stronghold-pet.webp',
    alt: '深色主题的据点页面，多位伙伴在客厅里群聊',
    title: '大家聚在据点里',
    desc: '几位伙伴可以住进同一个据点房间一起聊天。想让谁接话就 @ 她，房间和成员也可以交给管家安排。',
    link: '/companion/stronghold',
    linkText: '据点（群聊）模式',
  },
]

const cast = [
  {
    name: 'Pero',
    role: '看板娘 · 万能小女仆',
    tone: 'sky',
    art: '/characters/pero-standing.png',
    alt: '穿着女仆装挥手的 Pero',
    desc: 'infOS 的看板娘。蓝发猫耳，元气满满，擅长接梗，一聊起来就特别投入。',
    quote: '“锵锵！超级女仆 Pero 登场！请问需要什么帮助吗？”',
  },
  {
    name: '佩诺菈',
    role: '看板娘二号 · Pero 的平行个体',
    tone: 'pink',
    art: '/characters/penora-standing.webp',
    alt: '戴贝雷帽、蓝粉渐变双马尾的佩诺菈',
    desc: '同样元气可爱，更细腻一些。喜欢把漂亮的颜色、可爱的小物和路上的发现分享给熟悉的人。',
    quote: '“发现一件可爱的小东西时，第一个就想分享给你。”',
  },
]

const tiles = [
  { icon: 'cloud', title: 'Docker 部署', desc: '在服务器上常驻运行', link: '/deployment/docker' },
  { icon: 'chat', title: '多设备与分布式', desc: '手机和其他电脑接入同一份数据', link: '/deployment/distributed' },
  { icon: 'book', title: '提示词框架', desc: '调整发给模型的内容和顺序', link: '/advanced/prompts' },
  { icon: 'code', title: 'AIOS 架构', desc: '给想了解实现的开发者', link: '/advanced/aios' },
]
</script>

<style scoped>
.home {
  margin: 0 auto;
  padding: 0 24px;
  max-width: 1152px;
}

/* 首屏 */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  align-items: center;
  gap: 32px;
  padding: 56px 0 40px;
  min-height: min(640px, calc(100vh - var(--vp-nav-height)));
}

.hero-title {
  margin: 14px 0 18px;
  font-size: clamp(34px, 5vw, 52px);
  font-weight: 800;
  line-height: 1.18;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.hero-brand {
  display: block;
  background: linear-gradient(100deg, var(--wk-sky-strong) 10%, var(--wk-pink-strong) 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero-lead {
  margin: 0 0 28px;
  max-width: 34em;
  font-size: 17px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.hero-meta {
  margin-top: 20px;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

.hero-meta a {
  color: var(--vp-c-text-2);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.hero-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.hero-stage::before {
  content: '';
  position: absolute;
  inset: 18% 6% 2%;
  z-index: -1;
  border-radius: 42% 58% 50% 50%;
  background:
    radial-gradient(circle at 30% 30%, var(--wk-sky-soft), transparent 62%),
    radial-gradient(circle at 70% 70%, var(--wk-pink-soft), transparent 62%);
  filter: blur(6px);
}

.hero-bubble {
  /* 固定宽度，尾巴落在中线上对准 Pero */
  --wk-tail-x: 144px;
  width: 300px;
  max-width: 100%;
  margin-bottom: 12px;
}

.hero-bubble p {
  margin: 0;
  font-size: 15px;
  line-height: 1.75;
  animation: wk-pop 0.24s steps(3, end);
}

.hero-pero {
  border-radius: 12px;
  cursor: pointer;
}

.hero-pero img {
  width: min(300px, 70vw);
  height: auto;
  filter: drop-shadow(0 18px 24px rgba(52, 76, 120, 0.16));
  animation: wk-breathe 4.8s ease-in-out infinite;
}

.hero-pero.hop img {
  animation: wk-hop 0.36s steps(4, end);
}

.float-deco {
  position: absolute;
  animation: wk-bob 3.6s steps(6, end) infinite;
}

.deco-heart {
  top: 38%;
  right: 8%;
  color: var(--wk-pink);
}

.deco-spark {
  top: 58%;
  left: 10%;
  color: var(--wk-sky);
  animation-delay: -1.8s;
}

/* 区块 */
.block {
  padding: 56px 0 8px;
}

.block-head {
  margin-bottom: 28px;
}

.block-head h2 {
  margin: 10px 0 0;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--vp-c-text-1);
}

/* 分流卡片 */
.routes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}

.route-card {
  position: relative;
  padding: 24px;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-lg);
  background: var(--vp-c-bg-elv);
  transition:
    border-color 0.2s,
    transform 0.2s steps(3, end),
    box-shadow 0.2s;
}

.route-card:hover {
  border-color: var(--wk-sky);
  transform: translateY(-3px);
  box-shadow: var(--wk-shadow-pixel);
}

.route-icon {
  display: inline-grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
}

.route-icon.sky {
  color: var(--wk-sky-strong);
  background: var(--wk-sky-soft);
}

.route-icon.pink {
  color: var(--wk-pink-strong);
  background: var(--wk-pink-soft);
}

.route-icon.violet {
  color: var(--wk-violet-strong);
  background: var(--wk-violet-soft);
}

.route-card h3 {
  margin: 16px 0 8px;
  font-size: 18px;
  font-weight: 700;
}

.route-link {
  color: var(--vp-c-text-1);
}

/* 整张卡片可点，子链接仍可单独点击 */
.route-link::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--wk-radius-lg);
}

/* 焦点框画在覆盖整张卡片的伪元素上 */
.route-link:focus-visible {
  outline: none;
}

.route-link:focus-visible::after {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.route-card p {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

.route-subs {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin: 16px 0 0;
  padding: 14px 0 0;
  list-style: none;
  border-top: 1px dashed var(--vp-c-divider);
}

.route-subs a {
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
}

.route-subs a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 实拍 */
.show-row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
  align-items: center;
  gap: 40px;
  margin-bottom: 48px;
}

.show-row.flip .show-shot {
  order: 2;
}

.show-shot {
  position: relative;
  margin: 0;
}

.show-shot::before {
  content: '';
  position: absolute;
  inset: 14px -14px -14px 14px;
  z-index: -1;
  border-radius: var(--wk-radius-lg);
  background: linear-gradient(135deg, var(--wk-sky-soft), var(--wk-pink-soft));
}

.show-row.flip .show-shot::before {
  inset: 14px 14px -14px -14px;
}

.show-shot img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-lg);
  box-shadow: var(--wk-shadow-md);
}

.show-step {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--wk-pink-text);
}

.show-copy h3 {
  margin: 8px 0 12px;
  font-size: 22px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.show-copy p {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.85;
  color: var(--vp-c-text-2);
}

.show-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.show-more:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 看板娘 */
.cast {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.cast-card {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  padding: 24px 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-lg);
  overflow: hidden;
}

.cast-card.sky {
  background: linear-gradient(160deg, var(--wk-sky-soft), transparent 70%), var(--vp-c-bg-elv);
}

.cast-card.pink {
  background: linear-gradient(160deg, var(--wk-pink-soft), transparent 70%), var(--vp-c-bg-elv);
}

.cast-art {
  flex-shrink: 0;
  width: 150px;
  height: 230px;
  object-fit: contain;
  object-position: bottom;
}

.cast-copy {
  padding-bottom: 24px;
}

.cast-copy h3 {
  margin: 8px 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.cast-copy p {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--vp-c-text-2);
}

.cast-copy blockquote {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}

.cast-note {
  margin-top: 16px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.cast-note a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

/* 更多玩法 */
.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.tile {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 4px 10px;
  padding: 16px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--wk-radius-md);
  color: var(--wk-sky-strong);
  background: var(--vp-c-bg-elv);
  transition:
    border-color 0.2s,
    transform 0.2s steps(3, end);
}

.tile:hover {
  border-color: var(--wk-pink);
  transform: translateY(-2px);
}

.tile-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.tile-desc {
  grid-column: 2;
  font-size: 13px;
  color: var(--vp-c-text-2);
}

/* 收尾 */
.outro {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 8px;
  padding: 64px 0 24px;
}

.outro img {
  width: 130px;
  height: auto;
}

.outro-bubble {
  max-width: 420px;
  margin-bottom: 72px;
}

.outro-bubble p {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
}

.outro-bubble a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 960px) {
  .hero {
    grid-template-columns: 1fr;
    padding-top: 32px;
    min-height: 0;
  }

  .hero-stage {
    order: -1;
  }

  .hero-pero img {
    width: min(220px, 56vw);
  }

  .routes,
  .cast {
    grid-template-columns: 1fr;
  }

  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .show-row,
  .show-row.flip {
    grid-template-columns: 1fr;
    gap: 24px;
  }

  .show-row.flip .show-shot {
    order: 0;
  }
}

@media (max-width: 560px) {
  .tiles {
    grid-template-columns: 1fr;
  }

  .cast-card {
    flex-direction: column;
    align-items: flex-start;
  }

  .cast-art {
    order: 2;
    align-self: center;
  }

  .outro {
    flex-direction: column-reverse;
    align-items: center;
  }

  .outro-bubble {
    margin-bottom: 0;
  }
}
</style>
