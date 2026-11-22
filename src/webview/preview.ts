import { uiText } from '../i18n/messages'
import { createBus, onHostMessage } from './bus'
import { texturePreviewModes } from '../core/previewContexts'
import type { NoticeMessage, PreviewCommand, PreviewClearMessage, PreviewErrorMessage, PreviewFollowMessage, PreviewMessage, PreviewMode } from './messages'
import { findEntry, advanceTime, stepTime, wrapTicks } from './preview/frames'
import { attachGpu, sizeCanvas, uploadTextures, type Gpu } from './preview/gpu'
import { keyAction, type KeyAction } from './preview/keys'
import { EMPTY_TEXT, frameTagText, infoText, modelOf, type PreviewModel } from './preview/model'
import { BACKGROUNDS, type Background } from './preview/modes'
import { drawScene } from './preview/scene'
import { buildShell } from './preview/shell'
import { DEFAULT_VIEW, rotateView, zoomView, type ViewState } from './preview/view'

const DRAG_RADIANS_PER_PIXEL = 0.01
const WHEEL_IN = 1.08
const WHEEL_OUT = 0.92

const bus = createBus()
const root = document.createElement('div')
root.className = 'preview-root'
document.body.appendChild(root)
const shell = buildShell(root)

let gpu: Gpu | undefined = attachGpu(shell)
let current: PreviewModel | undefined
let mode: PreviewMode = 'flat'
let sourceUri: string | undefined
let following = true
let view: ViewState = DEFAULT_VIEW
let dragging: { x: number; y: number } | undefined
let playing = false
let playhead = 0
let lastStamp = 0
let framePending = false

const followButton = document.createElement('button')
followButton.type = 'button'
followButton.className = 'mcrh-btn'
followButton.dataset.action = 'preview-follow'
shell.resetButton.parentElement?.appendChild(followButton)
const blockbenchButton = document.createElement('button')
blockbenchButton.type = 'button'; blockbenchButton.className = 'mcrh-btn'; blockbenchButton.textContent = uiText("ui.blockbenchCommand.openInBlockbench")
blockbenchButton.dataset.action = 'open-blockbench'; blockbenchButton.title = uiText("webview.paint.findsAModelOfTheCurrentPaste")
blockbenchButton.addEventListener('click', () => bus.post({ command: 'openTextureInBlockbench' }))
shell.resetButton.parentElement?.appendChild(blockbenchButton)
function syncFollow(): void {
  followButton.textContent = following ? uiText("webview.preview.followingEdit") : uiText("webview.preview.fixedCurrent")
  followButton.title = following ? uiText("webview.preview.currentPreviewFollowsResourceEditorClickTo") : uiText("webview.preview.currentPreviewIsFixedClickToResume")
  followButton.setAttribute('aria-pressed', String(following))
}
followButton.addEventListener('click', () => {
  following = !following
  syncFollow()
  bus.post({ command: 'setPreviewFollow', following })
})
syncFollow()

bindControls()
bindCanvas()
setMode(mode)
setBackground('checker')
syncControls()
syncPlayIcon()
requestFrame()
bus.post({ command: 'previewReady' } satisfies PreviewCommand)

onHostMessage(message => {
  const command = (message as { command?: unknown } | null | undefined)?.command
  if (command === 'preview') handlePreview(message as PreviewMessage)
  else if (command === 'previewClear') {
    const cleared = message as PreviewClearMessage
    sourceUri = cleared.sourceUri; current = undefined; playing = false; playhead = 0
    showNotice({ command: 'notice', level: 'info', text: cleared.notice })
    updateText(); syncControls(); syncPlayIcon(); requestFrame()
  }
  else if (command === 'previewError') {
    const failure = message as PreviewErrorMessage
    sourceUri = failure.sourceUri; current = undefined; playing = false; playhead = 0
    showNotice({ command: 'notice', level: 'error', text: failure.error })
    updateText(); syncControls(); syncPlayIcon(); requestFrame()
  }
  else if (command === 'previewFollow') { following = (message as PreviewFollowMessage).following === true; syncFollow() }
  else if (command === 'notice') showNotice(message as NoticeMessage)
})

function bindControls(): void {
  for (const [id, button] of shell.modeButtons) button.addEventListener('click', () => setMode(id))
  for (const [id, button] of shell.backgroundButtons) button.addEventListener('click', () => setBackground(id))
  shell.playButton.addEventListener('click', togglePlay)
  shell.prevButton.addEventListener('click', () => stepBy(-1))
  shell.nextButton.addEventListener('click', () => stepBy(1))
  shell.resetButton.addEventListener('click', resetView)
  window.addEventListener('keydown', handleKey)
  window.addEventListener('resize', requestFrame)
  new ResizeObserver(() => requestFrame()).observe(shell.stage)
}

function bindCanvas(): void {
  const canvas = shell.canvas
  canvas.addEventListener('pointerdown', event => {
    dragging = { x: event.clientX, y: event.clientY }
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return
    const deltaYaw = (event.clientX - dragging.x) * DRAG_RADIANS_PER_PIXEL
    const deltaPitch = (event.clientY - dragging.y) * DRAG_RADIANS_PER_PIXEL
    dragging = { x: event.clientX, y: event.clientY }
    view = rotateView(view, deltaYaw, deltaPitch)
    requestFrame()
  })
  const endDrag = (): void => {
    dragging = undefined
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    view = zoomView(view, event.deltaY > 0 ? WHEEL_OUT : WHEEL_IN)
    requestFrame()
  }, { passive: false })
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault()
    gpu = undefined
    showNotice({ command: 'notice', level: 'warn', text: uiText("webview.preview.webglContextLostAwaitingRecovery") })
  })
  canvas.addEventListener('webglcontextrestored', () => {
    gpu = attachGpu(shell)
    showNotice(undefined)
    bus.post({ command: 'previewReady' })
  })
}

// 焦点在按钮上时空格由按钮自身的点击处理, 避免与播放切换重复触发
function handleKey(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const action = keyAction(event.key)
  if (!action) return
  if (action.type === 'togglePlay' && event.target instanceof HTMLButtonElement) return
  event.preventDefault()
  perform(action)
}

function perform(action: KeyAction): void {
  switch (action.type) {
    case 'rotate':
      view = rotateView(view, action.deltaYaw, action.deltaPitch)
      break
    case 'zoom':
      view = zoomView(view, action.factor)
      break
    case 'mode':
      setMode(action.mode)
      return
    case 'togglePlay':
      togglePlay()
      return
    case 'reset':
      resetView()
      return
  }
  requestFrame()
}

function setMode(next: PreviewMode): void {
  if (!texturePreviewModes(sourceUri ?? '').includes(next)) return
  mode = next
  for (const [id, button] of shell.modeButtons) button.setAttribute('aria-pressed', String(id === mode))
  requestFrame()
}

function setBackground(next: Background): void {
  for (const item of BACKGROUNDS) {
    shell.stage.classList.toggle(`preview-stage--${item.id}`, item.id === next)
    shell.backgroundButtons.get(item.id)?.setAttribute('aria-pressed', String(item.id === next))
  }
}

function togglePlay(): void {
  if (!current?.animated) return
  playing = !playing
  if (playing) lastStamp = performance.now()
  syncPlayIcon()
  requestFrame()
}

function stepBy(direction: 1 | -1): void {
  if (!current?.animated) return
  playing = false
  syncPlayIcon()
  playhead = stepTime(current.schedule, playhead, direction)
  requestFrame()
}

function resetView(): void {
  view = DEFAULT_VIEW
  requestFrame()
}

function handlePreview(message: PreviewMessage): void {
  const target = message.sourceUri ?? message.name
  const changedTarget = sourceUri !== target
  sourceUri = target
  for (const [id, button] of shell.modeButtons) {
    button.hidden = !texturePreviewModes(target).includes(id)
    button.disabled = button.hidden
  }
  if (changedTarget || !texturePreviewModes(target).includes(mode)) setMode('flat')
  const notices: string[] = []
  const hasTexture = gpu !== undefined && uploadTextures(gpu, message, notices)
  if (hasTexture) {
    const result = modelOf(message)
    current = result.model
    if (result.notice) notices.push(result.notice)
  } else {
    current = undefined
  }
  if (changedTarget) playhead = 0
  playing = playing && current?.animated === true
  showNotice(notices.length > 0 ? { command: 'notice', level: 'warn', text: notices.join(' ') } : undefined)
  syncPlayIcon()
  syncControls()
  requestFrame()
}

function showNotice(message: NoticeMessage | undefined): void {
  shell.notice.hidden = !message
  shell.notice.textContent = message?.text ?? ''
  shell.notice.className = message ? `preview-notice preview-notice--${message.level}` : 'preview-notice'
}

function syncControls(): void {
  const animated = current?.animated === true
  shell.playButton.disabled = !animated
  shell.prevButton.disabled = !animated
  shell.nextButton.disabled = !animated
}

function syncPlayIcon(): void {
  const icon = shell.playButton.firstElementChild as HTMLElement | null
  if (icon) icon.className = `codicon codicon-${playing ? 'debug-pause' : 'play'}`
}

function requestFrame(): void {
  if (framePending) return
  framePending = true
  requestAnimationFrame(now => {
    framePending = false
    tick(now)
  })
}

// 只有播放中才会连续请求帧, 其余时间按需绘制, 避免空转占用 GPU
function tick(now: number): void {
  if (playing && current?.animated) {
    const elapsedSeconds = (now - lastStamp) / 1000
    playhead = wrapTicks(advanceTime(playhead, elapsedSeconds), current.schedule.totalTicks)
  }
  lastStamp = now
  draw()
  if (playing) requestFrame()
}

function draw(): void {
  const { width, height } = sizeCanvas(shell.canvas)
  updateText()
  if (!gpu) return
  gpu.renderer.begin(width, height)
  if (current) drawScene(gpu.renderer, current, { mode, view, playhead }, width, height)
}

function updateText(): void {
  if (!current) {
    shell.frameTag.textContent = uiText("webview.preview.model.static")
    shell.status.textContent = EMPTY_TEXT
    return
  }
  shell.frameTag.textContent = frameTagText(current, findEntry(current.schedule, playhead))
  shell.status.textContent = infoText(current, mode)
}
