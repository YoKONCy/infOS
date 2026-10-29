<template>
  <div class="pixel-aios-blueprint">
    <!-- 头部街机装饰栏 -->
    <div class="blueprint-header">
      <div class="header-dots">
        <span class="dot dot-pink"></span>
        <span class="dot dot-yellow"></span>
        <span class="dot dot-blue"></span>
      </div>
      <div class="header-title">
        <span class="title-chip">✦ BLUEPRINT ✦</span>
        <span class="title-text">infOS-TS 全栈智能体操作系统架构拓扑</span>
      </div>
      <div class="header-badge">v0.9.9</div>
    </div>

    <!-- 架构主舞台 -->
    <div class="blueprint-body">
      <!-- 1. 桌面宿主层 (Frontend & Host) -->
      <div class="blueprint-layer layer-host">
        <div class="layer-tag tag-host">
          <span class="tag-icon">🖥️</span>
          <span>桌面宿主展现层 (Desktop Host & UI)</span>
        </div>
        <div class="card-grid cols-4">
          <div class="blueprint-card">
            <div class="card-icon">🪟</div>
            <div class="card-name">Electron 33+</div>
            <div class="card-desc">无边框透明置顶 / 穿透 / 悬浮视窗</div>
          </div>
          <div class="blueprint-card">
            <div class="card-icon">⚡</div>
            <div class="card-name">Vue 3 + Pinia</div>
            <div class="card-desc">组合式响应式状态机 / 窗口事件分发</div>
          </div>
          <div class="blueprint-card highlight-card">
            <div class="card-icon">🎮</div>
            <div class="card-name">3D Desktop Engine</div>
            <div class="card-desc">Minecraft-Like 风格骨骼动画 / 物理惯性</div>
          </div>
          <div class="blueprint-card">
            <div class="card-icon">📦</div>
            <div class="card-name">Steam & Desktop</div>
            <div class="card-desc">创意工坊资产订阅 / 本地跨端发行</div>
          </div>
        </div>
      </div>

      <!-- 中间通信总线 -->
      <div class="blueprint-bus">
        <div class="bus-line">
          <span class="bus-arrow">↕</span>
          <span class="bus-text">
            Gateway Hub (WebSocket / Protobuf 二进制流 / HTTP REST 全双工总线)
          </span>
          <span class="bus-arrow">↕</span>
        </div>
      </div>

      <!-- 2. AIOS 智能操作系统内核 (Kernel Core) -->
      <div class="blueprint-layer layer-kernel">
        <div class="layer-tag tag-kernel">
          <span class="tag-icon">🧠</span>
          <span>AIOS 智能操作系统微内核 (Node.js + Hono)</span>
        </div>

        <!-- 调度与管控 -->
        <div class="sub-section">
          <div class="sub-title">核心调度与安全边界 (Kernel Management)</div>
          <div class="card-grid cols-3">
            <div class="blueprint-card mini">
              <div class="card-name">⏰ CompanionScheduler</div>
              <div class="card-desc">4段时段感知 / 自动空闲陪伴开场</div>
            </div>
            <div class="blueprint-card mini highlight-pink">
              <div class="card-name">✍️ Context Compiler</div>
              <div class="card-desc">只读上下文生成 / 审计 Manifest</div>
            </div>
            <div class="blueprint-card mini">
              <div class="card-name">🔐 CapabilityGate</div>
              <div class="card-desc">角色×场景权限矩阵 / 默认防御阻断</div>
            </div>
          </div>
        </div>

        <!-- 六大一等公民资源 -->
        <div class="sub-section">
          <div class="sub-title">六大一等公民资源模型 (First-Class AIOS Resources)</div>
          <div class="card-grid cols-6">
            <div class="resource-card">
              <span class="res-icon">🪪</span>
              <span class="res-name">Identity</span>
              <span class="res-sub">人格与声线</span>
            </div>
            <div class="resource-card">
              <span class="res-icon">🧠</span>
              <span class="res-name">Memory</span>
              <span class="res-sub">事件笔记图谱</span>
            </div>
            <div class="resource-card">
              <span class="res-icon">💻</span>
              <span class="res-name">Workspace</span>
              <span class="res-sub">文件与代码区</span>
            </div>
            <div class="resource-card">
              <span class="res-icon">🔮</span>
              <span class="res-name">Context</span>
              <span class="res-sub">动态Prompt编译</span>
            </div>
            <div class="resource-card">
              <span class="res-icon">🧵</span>
              <span class="res-name">Thread</span>
              <span class="res-sub">多角色会话线索</span>
            </div>
            <div class="resource-card">
              <span class="res-icon">⚡</span>
              <span class="res-name">Capability</span>
              <span class="res-sub">NIT 工具能力</span>
            </div>
          </div>
        </div>

        <!-- 认知与执行引擎 -->
        <div class="sub-section">
          <div class="sub-title">智能体协同与执行引擎 (Engines & Coordination)</div>
          <div class="card-grid cols-4">
            <div class="blueprint-card mini">
              <div class="card-name">📜 NIT Runtime</div>
              <div class="card-desc">智能体专用微型 DSL 脚本解释器</div>
            </div>
            <div class="blueprint-card mini">
              <div class="card-name">📝 EventMemoryService</div>
              <div class="card-desc">EventNote 提炼 / 日记自动汇总</div>
            </div>
            <div class="blueprint-card mini">
              <div class="card-name">🧭 ContextRNN (minGRU)</div>
              <div class="card-desc">256维对话轨迹编码 / 扩散偏置</div>
            </div>
            <div class="blueprint-card mini">
              <div class="card-name">🏰 Stronghold</div>
              <div class="card-desc">多角色据点房间 / 同台意图协同</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底层桥梁 -->
      <div class="blueprint-bus bus-native">
        <div class="bus-line">
          <span class="bus-arrow">↕</span>
          <span class="bus-text">Node-API 原生直连绑定 (Zero-Copy C ABI 内存交互)</span>
          <span class="bus-arrow">↕</span>
        </div>
      </div>

      <!-- 3. TriviumDB 底层算力核 (Rust Native) -->
      <div class="blueprint-layer layer-native">
        <div class="layer-tag tag-native">
          <span class="tag-icon">⚡</span>
          <span>TriviumDB 高性能图谱向量算力核心 (Rust Native)</span>
        </div>
        <div class="card-grid cols-5">
          <div class="blueprint-card native-card">
            <div class="card-icon">🗄️</div>
            <div class="card-name">TriviumDB (.tdb)</div>
            <div class="card-desc">向量 + 图谱融合存储 / WAL持久化</div>
          </div>
          <div class="blueprint-card native-card">
            <div class="card-icon">🌐</div>
            <div class="card-name">SA-PPR 图扩散</div>
            <div class="card-desc">个性化 PageRank 关联漫游</div>
          </div>
          <div class="blueprint-card native-card">
            <div class="card-icon">🎯</div>
            <div class="card-name">FISTA 残差寻隐</div>
            <div class="card-desc">L1 稀疏约束 / 挖掘微弱因果信号</div>
          </div>
          <div class="blueprint-card native-card">
            <div class="card-icon">✨</div>
            <div class="card-name">DPP 多样性采样</div>
            <div class="card-desc">行列式点过程 / 杜绝语义同质化</div>
          </div>
          <div class="blueprint-card native-card">
            <div class="card-icon">🧩</div>
            <div class="card-name">Leiden 社区发现</div>
            <div class="card-desc">图谱社群自动划分 / 质心亲和加权</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pixel-aios-blueprint {
  margin: 28px 0;
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(12px);
  border: 2px solid var(--moe-cocoa-brown, #2d1b1e);
  border-radius: 12px;
  box-shadow: 4px 4px 0 rgba(45, 27, 30, 0.15);
  overflow: hidden;
  font-family: inherit;
}

/* 头部栏 */
.blueprint-header {
  background: linear-gradient(90deg, #f9a8d4 0%, #a7d8f0 100%);
  border-bottom: 2px solid var(--moe-cocoa-brown, #2d1b1e);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-dots {
  display: flex;
  gap: 6px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1.5px solid var(--moe-cocoa-brown, #2d1b1e);
}

.dot-pink {
  background: #f472b6;
}
.dot-yellow {
  background: #fde047;
}
.dot-blue {
  background: #38bdf8;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-chip {
  background: var(--moe-cocoa-brown, #2d1b1e);
  color: #fff;
  font-size: 0.7rem;
  font-weight: 900;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 1px;
}

.title-text {
  font-size: 0.95rem;
  font-weight: 800;
  color: var(--moe-cocoa-brown, #2d1b1e);
}

.header-badge {
  background: #fff;
  border: 1.5px solid var(--moe-cocoa-brown, #2d1b1e);
  font-size: 0.75rem;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 4px;
  box-shadow: 2px 2px 0 rgba(45, 27, 30, 0.1);
}

/* 主体内容 */
.blueprint-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 层级卡片面板 */
.blueprint-layer {
  position: relative;
  border: 2px solid var(--moe-cocoa-brown, #2d1b1e);
  border-radius: 8px;
  padding: 22px 14px 14px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 3px 3px 0 rgba(45, 27, 30, 0.08);
}

.layer-host {
  background: linear-gradient(180deg, #f0f9ff 0%, #ffffff 100%);
  border-color: #0284c7;
}

.layer-kernel {
  background: linear-gradient(180deg, #fdf2f8 0%, #ffffff 100%);
  border-color: #db2777;
}

.layer-native {
  background: linear-gradient(180deg, #fefce8 0%, #ffffff 100%);
  border-color: #d97706;
}

/* 标签 */
.layer-tag {
  position: absolute;
  top: -12px;
  left: 14px;
  padding: 2px 10px;
  border-radius: 4px;
  border: 1.5px solid var(--moe-cocoa-brown, #2d1b1e);
  font-size: 0.8rem;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 6px;
  box-shadow: 2px 2px 0 rgba(45, 27, 30, 0.15);
}

.tag-host {
  background: #38bdf8;
  color: #0c4a6e;
}

.tag-kernel {
  background: #f472b6;
  color: #831843;
}

.tag-native {
  background: #fde047;
  color: #78350f;
}

/* 通信总线 */
.blueprint-bus {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2px 0;
}

.bus-line {
  background: #fff;
  border: 1.5px dashed var(--moe-cocoa-brown, #2d1b1e);
  border-radius: 20px;
  padding: 4px 16px;
  font-size: 0.78rem;
  font-weight: 700;
  color: #4b5563;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 2px 2px 0 rgba(45, 27, 30, 0.08);
}

.bus-native .bus-line {
  border-style: solid;
  border-color: #d97706;
  background: #fffbeb;
  color: #92400e;
}

.bus-arrow {
  font-size: 0.95rem;
  color: #db2777;
  font-weight: 900;
}

.bus-native .bus-arrow {
  color: #d97706;
}

/* 子分区 */
.sub-section {
  margin-top: 8px;
}

.sub-title {
  font-size: 0.75rem;
  font-weight: 800;
  color: #6b7280;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* 卡片网格 */
.card-grid {
  display: grid;
  gap: 8px;
}

.cols-3 {
  grid-template-columns: repeat(3, 1fr);
}
.cols-4 {
  grid-template-columns: repeat(4, 1fr);
}
.cols-5 {
  grid-template-columns: repeat(5, 1fr);
}
.cols-6 {
  grid-template-columns: repeat(6, 1fr);
}

@media (max-width: 768px) {
  .cols-3,
  .cols-4,
  .cols-5,
  .cols-6 {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 标准卡片 */
.blueprint-card {
  background: #ffffff;
  border: 1.5px solid rgba(45, 27, 30, 0.2);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: all 0.15s ease;
  box-shadow: 2px 2px 0 rgba(45, 27, 30, 0.05);
}

.blueprint-card:hover {
  transform: translateY(-2px);
  box-shadow: 3px 3px 0 rgba(45, 27, 30, 0.15);
  border-color: #db2777;
}

.card-icon {
  font-size: 1.2rem;
  margin-bottom: 4px;
}

.card-name {
  font-size: 0.82rem;
  font-weight: 800;
  color: var(--moe-cocoa-brown, #2d1b1e);
  line-height: 1.2;
}

.card-desc {
  font-size: 0.68rem;
  color: #6b7280;
  margin-top: 3px;
  line-height: 1.2;
}

.blueprint-card.mini {
  padding: 6px 8px;
  align-items: flex-start;
  text-align: left;
}

.highlight-card {
  background: #fdf2f8;
  border-color: #f472b6;
}

.highlight-pink {
  background: #fff1f2;
  border-color: #fb7185;
}

.native-card {
  background: #fffbeb;
  border-color: #fde68a;
}

.native-card:hover {
  border-color: #d97706;
}

/* 六大一等公民卡片 */
.resource-card {
  background: #ffffff;
  border: 1.5px solid #f472b6;
  border-radius: 6px;
  padding: 8px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  box-shadow: 2px 2px 0 rgba(244, 114, 182, 0.2);
  transition: transform 0.15s ease;
}

.resource-card:hover {
  transform: translateY(-2px) scale(1.02);
  background: #fff5f8;
}

.res-icon {
  font-size: 1.3rem;
  margin-bottom: 2px;
}

.res-name {
  font-size: 0.8rem;
  font-weight: 900;
  color: #be185d;
}

.res-sub {
  font-size: 0.65rem;
  color: #9d174d;
  margin-top: 1px;
}
</style>
