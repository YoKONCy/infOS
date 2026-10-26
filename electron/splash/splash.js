// 连接选择、启动进度与失败恢复共用开屏；凭据只在提交时传给主进程。
const bridge = window.startupSplash
const penora = document.querySelector('#penora-splash')
const rail = penora.querySelector('#progress-rail')
const railLength = rail.getTotalLength()
let stageProgress = 0

// 显示启动阶段的完成比例，不按时间虚增，也不把资源加载量冒充精确进度。
function updateStageProgress(phase) {
  const stages = { opening: 0, connection: 0, backend: 33, launcher: 67, ready: 100 }
  if (Object.hasOwn(stages, phase)) stageProgress = stages[phase]
  const normalized = stageProgress * 10
  for (const item of penora.querySelectorAll('.progress-fill'))
    item.setAttribute('stroke-dasharray', `${normalized} 1000`)
  const tail = penora.querySelector('.progress-tail')
  const length = Math.min(68, normalized)
  tail.setAttribute('stroke-dasharray', `${length} 1000`)
  tail.setAttribute('stroke-dashoffset', String(-(normalized - length)))
  const position = (railLength * stageProgress) / 100
  const point = rail.getPointAtLength(position)
  const before = rail.getPointAtLength(Math.max(0, position - 1))
  const after = rail.getPointAtLength(Math.min(railLength, position + 1))
  const head = penora.querySelector('[data-progress-head]')
  const angle = (Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI
  head.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${angle})`)
  penora.dataset.empty = String(stageProgress === 0)
  penora.querySelector('[data-progress-label]').textContent = String(stageProgress)
  penora
    .querySelector('[data-terminal-light]')
    .setAttribute('opacity', stageProgress === 100 ? '.93' : '.18')
  progress.setAttribute('aria-valuenow', String(stageProgress))
}
let revision = -1
const failure = document.querySelector('#failure')
const progress = document.querySelector('#progress')
const connection = document.querySelector('#connection')
const form = document.querySelector('#connection-form')
const remoteFields = document.querySelector('#remote-fields')
const origin = document.querySelector('#server-origin')
const token = document.querySelector('#server-token')
const capability = document.querySelector('#capability-endpoint')
const reveal = document.querySelector('#reveal-token')
const submit = document.querySelector('#connection-submit')
const cancel = document.querySelector('#connection-cancel')
const connectionError = document.querySelector('#connection-error')
let connectionId = null,
  mode = 'local',
  labels = {},
  busy = false,
  restartRequired = false
let initialOrigin = '',
  initialCapability = '',
  capabilityEdited = false

function revealConnectionError() {
  const area = document.querySelector('.connection-options')
  const visible = area.getBoundingClientRect(),
    error = connectionError.getBoundingClientRect()
  // 只滚动表单内部，不能让错误提示带动整张开屏位移。
  if (error.bottom > visible.bottom) area.scrollTop += error.bottom - visible.bottom + 4
  else if (error.top < visible.top) area.scrollTop -= visible.top - error.top + 4
}

function updateConnectionControls() {
  remoteFields.hidden = mode !== 'remote'
  remoteFields.disabled = busy || mode !== 'remote'
  origin.required = token.required = mode === 'remote'
  connection.setAttribute('aria-busy', String(busy))
  document
    .querySelector('#connection-modes')
    .setAttribute('aria-label', labels['选择运行方式'] || '')
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
    button.disabled = busy
  }
  submit.disabled = busy
  cancel.hidden = !restartRequired
  document.querySelector('.submit-label').textContent =
    labels[
      busy
        ? mode === 'remote'
          ? '正在验证连接…'
          : '正在保存…'
        : restartRequired
          ? '保存并重启'
          : mode === 'local'
            ? '启动本地服务'
            : '验证并连接'
    ]
  document.querySelector('#connection-note').textContent =
    labels[
      restartRequired ? '修改将在客户端重启后生效。' : '连接设置保存在本机，原有存档保持不变。'
    ]
  reveal.setAttribute('aria-label', labels[token.type === 'password' ? '显示令牌' : '隐藏令牌'])
}

function render(state) {
  if (!state || state.revision < revision) return
  const previouslyFailed = document.body.dataset.phase === 'failed'
  revision = state.revision
  document.documentElement.lang = state.language
  document.body.dataset.phase = state.phase
  updateStageProgress(state.phase)
  for (const caption of document.querySelectorAll('.brand-caption'))
    caption.textContent = state.labels.brandCaption
  const wasChoosing = !connection.hidden
  connection.hidden = !state.connection
  if (state.connection) {
    labels = state.connectionLabels
    for (const element of connection.querySelectorAll('[data-label]'))
      element.textContent = labels[element.dataset.label]
    const view = state.connection
    const newError = view.error && (connectionError.textContent !== view.error || busy)
    if (view.id !== connectionId) {
      connectionId = view.id
      mode = view.mode
      origin.value = view.origin
      capability.value = view.capabilityEndpoint
      initialOrigin = view.origin
      initialCapability = view.capabilityEndpoint
      capabilityEdited = false
      token.value = ''
      token.type = 'password'
      reveal.setAttribute('aria-pressed', 'false')
      document.querySelector('#connection-advanced').open = false
    }
    busy = view.busy
    restartRequired = view.restartRequired
    connectionError.textContent = view.error
    connectionError.hidden = !view.error
    updateConnectionControls()
    if (!wasChoosing) document.querySelector('#connection-title').focus({ preventScroll: true })
    if (newError) requestAnimationFrame(revealConnectionError)
  } else if (wasChoosing) {
    form.reset()
    token.type = 'password'
    connectionId = null
    busy = false
  }
  progress.setAttribute('aria-label', state.labels.loading)
  document.querySelector('#close').setAttribute('aria-label', state.labels.close)
  document.querySelector('#failure-title').textContent = state.labels.title
  document.querySelector('#failure-message').textContent = state.labels.message
  for (const action of ['retry', 'logs', 'quit'])
    document.querySelector(`#${action}`).textContent = state.labels[action]
  failure.hidden = state.phase !== 'failed'
  document.querySelector('#status').textContent = state.connection
    ? state.connection.error || labels[busy ? '正在验证连接…' : '选择运行方式']
    : state.phase === 'failed'
      ? state.labels.message
      : state.labels.loading
  if (state.phase === 'failed' && !previouslyFailed) document.querySelector('#retry').focus()
}
bridge.onState(render)
const initialState = bridge.getState().then(render)
for (const action of ['retry', 'logs', 'quit'])
  document.querySelector(`#${action}`).addEventListener('click', () => bridge.action(action))
document.querySelector('#close').addEventListener('click', () => bridge.action('quit'))
cancel.addEventListener('click', () => bridge.action('cancel-connection'))
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    if (busy) return
    mode = button.dataset.mode
    connectionError.hidden = true
    updateConnectionControls()
    if (mode === 'remote') origin.focus()
  })
  button.addEventListener('keydown', (event) => {
    if (!busy && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      mode =
        event.key === 'Home'
          ? 'local'
          : event.key === 'End'
            ? 'remote'
            : mode === 'local'
              ? 'remote'
              : 'local'
      connectionError.hidden = true
      updateConnectionControls()
      document.querySelector(`#mode-${mode}`).focus()
    }
  })
}
reveal.addEventListener('click', () => {
  token.type = token.type === 'password' ? 'text' : 'password'
  reveal.setAttribute('aria-pressed', String(token.type === 'text'))
  updateConnectionControls()
})
capability.addEventListener('input', () => {
  capabilityEdited = true
})
origin.addEventListener('input', () => {
  // 切换服务器时，未手动修改的能力地址跟随新服务器默认值，避免连回旧节点。
  if (capabilityEdited) return
  try {
    capability.value =
      new URL(origin.value).origin === new URL(initialOrigin).origin ? initialCapability : ''
  } catch {
    capability.value = ''
  }
})
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Enter' &&
    event.target.id === 'connection-title' &&
    !busy &&
    !connection.hidden
  ) {
    event.preventDefault()
    form.requestSubmit()
  }
  if (event.key === 'Escape' && !connection.hidden && restartRequired)
    bridge.action('cancel-connection')
})
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy || connection.hidden) return
  busy = true
  connectionError.hidden = true
  updateConnectionControls()
  try {
    await bridge.saveConnection({
      mode,
      origin: origin.value,
      token: token.value,
      capabilityEndpoint: capability.value,
    })
  } catch {
    connectionError.textContent = labels['连接失败，请检查地址、令牌和网络。']
    connectionError.hidden = false
    revealConnectionError()
  } finally {
    busy = false
    if (!connection.hidden) updateConnectionControls()
  }
})
// 两套本地插画、字体和初始状态均准备好，再通知主进程显示，避免切到配置时出现空白。
Promise.all([
  initialState,
  document.querySelector('#artwork').decode(),
  ...Array.from(penora.querySelectorAll('image'), (element) => {
    const image = new Image()
    image.src = element.getAttribute('href')
    return image.decode()
  }),
  document.fonts.ready,
])
  .then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => bridge.painted()))
  })
  .catch(() => bridge.failed())
