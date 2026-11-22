import { uiText } from '../i18n/messages'
import { enhanceNativeSelects } from './selectControls'
import { mountReferenceWorkspace } from './referenceWorkspace'
import { HostReferenceSource } from './referenceImages'
import { mountShortcutDialog } from './paint/shortcuts'
import { validateBindings } from './paint/bindings'
import { mountPaintDock } from './paint/dock'
import { createHost } from './paint/host'
import { rememberColor, createScheduler, type App, type Hover, type Modifiers } from './paint/app'
import { el } from './paint/dom'
import { attachKeys } from './paint/keys'
import { mountLayers } from './paint/layers'
import { mountConfirm } from './paint/confirm'
import { mountOptions } from './paint/options'
import { attachPointer } from './paint/pointer'
import { createState } from './paint/state'
import { mountStage } from './paint/stage'
import { mountStatusBar } from './paint/statusbar'
import { mountToolbar } from './paint/toolbar'
import { mountImageEditing } from './paint/editing'
import { mountEdgeRecolor } from './paint/edgeRecolor'
import { mountPaintHistory } from './paint/history'
import { mountGitView } from './gitView'
import { mountTodoView } from './todoView'

enhanceNativeSelects()

mountPage()

function mountPage(): void {
  const root = el('div', 'mp-app')
  const top = el('header', 'mp-top')
  const main = el('div', 'mp-main')
  const center = el('div', 'mp-center')
  root.append(top, main)
  document.body.append(root)

  const state = createState()
  const hover: Hover = {}
  const modifiers: Modifiers = { space: false }
  let chromeDirty = false
  const scheduleFrame = createScheduler(renderFrame)
  const requestRender = (): void => scheduleFrame()
  const requestChrome = (): void => {
    chromeDirty = true
    scheduleFrame()
  }

  const host = createHost(state, {
    onSnapshot: sizeChanged => {
      if (sizeChanged) stage.fitWindow()
      requestChrome()
    },
    onLayers: () => requestChrome(),
    onSettings: () => requestChrome(),
    onPatch: () => requestRender(),
    onNotice: notice => statusBar.notify(notice.text, notice.level)
  })
  state.recentColors = host.loadRecentColors()
  state.keybindings = validateBindings(host.loadPreferences?.().keybindings ?? {}).bindings

  const stage = mountStage(center, state, hover, requestChrome)
  const app: App = {
    state,
    host,
    scroller: stage.scroller,
    hover,
    modifiers,
    requestRender,
    requestChrome,
    notify: (text, level) => statusBar.notify(text, level),
    zoomTo: (zoom, anchor) => stage.zoomTo(zoom, anchor),
    fitWindow: () => stage.fitWindow()
  }

  const toolbar = mountToolbar(main, app)
  main.append(center)
  const dock = mountPaintDock(main, app, stage.sourceCanvas)
  const references = mountReferenceWorkspace(center, new HostReferenceSource(message => host.post(message)), rgba => { state.color = rgba; rememberColor(app, rgba); app.requestChrome(); app.requestRender(); app.notify(uiText("webview.paint.colourTakenFromReferenceDiagrams"), 'info') })
  window.addEventListener('pagehide', () => references.dispose(), { once: true })
  const imageGroup = document.createElement('details'); imageGroup.className = 'mp-dock-section mp-image-section'
  const imageSummary = document.createElement('summary'); imageSummary.textContent = uiText("webview.paint.editing.imageSizeAndAnimation"); imageGroup.append(imageSummary)
  dock.element.insertBefore(imageGroup, dock.layerSlot)
  mountImageEditing(imageGroup, app, stage)
  app.openImageEditing = () => { imageGroup.open = true; imageGroup.scrollIntoView({ block: 'nearest' }); imageGroup.querySelector<HTMLInputElement>('[data-size=width]')?.focus() }
  mountEdgeRecolor(root, app)
  for (const [title, mount] of [
    [uiText("webview.paint.history.paintHistory"), (element: HTMLElement) => mountPaintHistory(element, app)],
    [uiText("webview.gitView.gitHistoryAndChange"), (element: HTMLElement) => mountGitView(element, message => host.post(message), true)],
    ['TODO', (element: HTMLElement) => mountTodoView(element, message => host.post(message), true)]
  ] as const) {
    const group = document.createElement('details'); group.className = 'mp-dock-section'
    const summary = document.createElement('summary'); summary.textContent = title; group.append(summary)
    dock.element.append(group); mount(group)
  }
  const layers = mountLayers(dock.layerSlot, app)
  const options = mountOptions(top, app)
  const preview3d = document.createElement('button'); preview3d.type = 'button'; preview3d.className = 'mcrh-btn mp-preview-3d'; preview3d.textContent = uiText("webview.paint.dPreview"); preview3d.title = uiText("webview.paint.openAThreeDimensionalPreviewOfThis"); preview3d.addEventListener('click', () => host.post({ command: 'open3dPreview' })); options.actions.append(preview3d)
  const previewGui = document.createElement('button'); previewGui.type = 'button'; previewGui.className = 'mcrh-btn mp-preview-gui'; previewGui.textContent = uiText("ui.sidebarTree.guiHudPreview"); previewGui.title = uiText("webview.paint.combineAPreviewOfTheCurrentPackage"); previewGui.addEventListener('click', () => host.post({ command: 'openGuiPreview' })); options.actions.append(previewGui)
  const blockbench = document.createElement('button'); blockbench.type = 'button'; blockbench.className = 'mcrh-btn mp-open-blockbench'; blockbench.textContent = uiText("ui.blockbenchCommand.openInBlockbench"); blockbench.title = uiText("webview.paint.findsAModelOfTheCurrentPaste"); blockbench.addEventListener('click', () => host.post({ command: 'openTextureInBlockbench' })); options.actions.append(blockbench)
  const togglePanels = document.createElement('button'); togglePanels.type = 'button'; togglePanels.className = 'mcrh-icon-btn'; togglePanels.title = uiText("webview.paint.bindings.toggleSidebar"); togglePanels.setAttribute('aria-label', togglePanels.title); togglePanels.setAttribute('aria-pressed', 'false')
  const layoutIcon = document.createElement('span'); layoutIcon.className = 'codicon codicon-layout-sidebar-right'; layoutIcon.setAttribute('aria-hidden', 'true'); togglePanels.append(layoutIcon); options.actions.append(togglePanels)
  const colorControls = top.querySelector<HTMLElement>('.mp-options-color')
  if (colorControls) dock.setColorControls(colorControls)
  app.togglePanels = () => {
    const hidden = root.classList.toggle('panels-hidden')
    togglePanels.setAttribute('aria-pressed', String(hidden))
    if (hidden) references.suspend(); else references.resume()
    app.requestChrome()
  }
  togglePanels.addEventListener('click', app.togglePanels)
  stage.scroller.tabIndex = 0
  stage.scroller.setAttribute('aria-label', uiText("webview.paint.pixelCanvas"))
  stage.scroller.addEventListener('pointerdown', () => stage.scroller.focus({ preventScroll: true }))
  const confirm = mountConfirm(center, app)
  const statusBar = mountStatusBar(root, app)
  app.openShortcuts = mountShortcutDialog(root, app)
  attachPointer(app, stage)
  attachKeys(app)

  function renderFrame(): void {
    if (chromeDirty) {
      chromeDirty = false
      toolbar.sync()
      options.sync()
      layers.sync()
      confirm.sync()
      dock.sync()
    }
    layers.drawThumbs()
    stage.render()
    dock.draw(stage.sourceRevision)
    statusBar.update()
  }

  requestChrome()
  host.post({ command: 'ready' })
}
