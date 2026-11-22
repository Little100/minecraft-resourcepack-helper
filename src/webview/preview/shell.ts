import { uiHtml, uiText } from '../../i18n/messages'
import type { PreviewMode } from '../messages'
import { BACKGROUNDS, MODES, type Background } from './modes'

export interface PreviewShell {
  canvas: HTMLCanvasElement
  stage: HTMLElement
  fallback: HTMLElement
  status: HTMLElement
  notice: HTMLElement
  modeButtons: Map<PreviewMode, HTMLButtonElement>
  backgroundButtons: Map<Background, HTMLButtonElement>
  playButton: HTMLButtonElement
  prevButton: HTMLButtonElement
  nextButton: HTMLButtonElement
  frameTag: HTMLElement
  resetButton: HTMLButtonElement
}

function icon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`
}

export function buildShell(root: HTMLElement): PreviewShell {
  const modeButtons = MODES.map((mode, index) =>
    `<button type="button" class="mcrh-btn" data-mode="${mode.id}" aria-pressed="false" title="${mode.hint} (${index + 1})">${icon(mode.icon)}<span>${mode.label}</span></button>`
  ).join('')
  const backgroundButtons = BACKGROUNDS.map(background =>
    `<button type="button" class="mcrh-icon-btn" data-background="${background.id}" aria-pressed="false" aria-label="${uiHtml("webview.preview.shell.background", background.label)}" title="${uiHtml("webview.preview.shell.background", background.label)}">${icon(background.icon)}</button>`
  ).join('')
  root.innerHTML = `
<header class="preview-bar">
  <div class="preview-group" role="group" aria-label="${uiHtml("webview.preview.shell.previewMode")}">${modeButtons}</div>
  <span class="mcrh-sep" aria-hidden="true"></span>
  <div class="preview-group" role="group" aria-label="${uiHtml("webview.preview.shell.animationControl")}">
    <button type="button" class="mcrh-icon-btn" id="mcrh-play" aria-label="${uiHtml("webview.preview.shell.playOrPause")}" title="${uiHtml("webview.preview.shell.playOrPauseSpace")}">${icon('play')}</button>
    <button type="button" class="mcrh-icon-btn" id="mcrh-prev" aria-label="${uiHtml("webview.preview.shell.previousFrame")}" title="${uiHtml("webview.preview.shell.previousFrame")}">${icon('chevron-left')}</button>
    <button type="button" class="mcrh-icon-btn" id="mcrh-next" aria-label="${uiHtml("webview.preview.shell.nextFrame")}" title="${uiHtml("webview.preview.shell.nextFrame")}">${icon('chevron-right')}</button>
    <span class="mcrh-tag" id="mcrh-frame">${uiHtml("webview.preview.model.static")}</span>
  </div>
  <span class="mcrh-sep" aria-hidden="true"></span>
  <div class="preview-group" role="group" aria-label="${uiHtml("core.document.background")}">${backgroundButtons}</div>
  <button type="button" class="mcrh-btn" id="mcrh-reset" title="${uiHtml("webview.preview.shell.resetPerspective")}">${icon('refresh')}<span>${uiHtml("webview.preview.shell.resetPerspective_d26785")}</span></button>
</header>
<main class="preview-stage preview-stage--checker" id="mcrh-stage">
  <canvas id="mcrh-canvas" aria-label="${uiHtml("webview.preview.shell.pasteCanvas")}"></canvas>
  <p class="preview-fallback" id="mcrh-fallback" hidden></p>
</main>
<footer class="preview-info">
  <p class="preview-status" id="mcrh-status"></p>
  <p class="preview-notice" id="mcrh-notice" role="status" hidden></p>
</footer>`

  const modeMap = new Map<PreviewMode, HTMLButtonElement>()
  for (const mode of MODES) modeMap.set(mode.id, byQuery<HTMLButtonElement>(root, `[data-mode="${mode.id}"]`))
  const backgroundMap = new Map<Background, HTMLButtonElement>()
  for (const background of BACKGROUNDS) {
    backgroundMap.set(background.id, byQuery<HTMLButtonElement>(root, `[data-background="${background.id}"]`))
  }
  return {
    canvas: byId<HTMLCanvasElement>('mcrh-canvas'),
    stage: byId('mcrh-stage'),
    fallback: byId('mcrh-fallback'),
    status: byId('mcrh-status'),
    notice: byId('mcrh-notice'),
    modeButtons: modeMap,
    backgroundButtons: backgroundMap,
    playButton: byId<HTMLButtonElement>('mcrh-play'),
    prevButton: byId<HTMLButtonElement>('mcrh-prev'),
    nextButton: byId<HTMLButtonElement>('mcrh-next'),
    frameTag: byId('mcrh-frame'),
    resetButton: byId<HTMLButtonElement>('mcrh-reset')
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(uiText("webview.preview.shell.thePreviewPageIsMissingElements", id))
  return element as T
}

function byQuery<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(uiText("webview.preview.shell.thePreviewPageIsMissingElements", selector))
  return element
}
