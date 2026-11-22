import { uiText } from '../i18n/messages'
import type { FontGlyph } from '../core/fontGlyphs'
import { createBus, onHostMessage } from './bus'
import type { SyntaxCommand, SyntaxPreviewMessage, SyntaxTextRun, SyntaxPackEntry } from './messages'
import { fitWithin } from './syntaxLayout'

const bus = createBus()

let glyphs = new Map<string, FontGlyph>()

const root = document.createElement('div')
root.className = 'mcrh-syntax'
document.body.append(root)

function render(model: SyntaxPreviewMessage): void {
  root.innerHTML = ''
  glyphs = new Map((model.glyphs ?? []).map(glyph => [glyph.font + ':' + glyph.char, glyph]))

  const header = document.createElement('header')
  header.className = 'mcrh-head'
  const titleBox = document.createElement('div')
  titleBox.className = 'mcrh-head-main'
  const file = model.fileName ? `<span class="mcrh-file">${escape(model.fileName)}</span>` : ''
  titleBox.innerHTML = `<h1>${escape(model.title)}</h1>${file}`
  header.append(titleBox)
  if (model.kind === 'model') header.append(blockbenchButton())
  if (model.kind === 'pack.mcmeta' || model.kind === 'font') {
    for (const [label, command] of [[uiText("webview.syntax.selectAPasteCharacter"), 'pickFontGlyph'], [uiText("webview.syntax.createFontTemplate"), 'createFontTemplate']] as const) {
      const action = document.createElement('button'); action.type = 'button'; action.className = 'mcrh-btn mcrh-btn--secondary'; action.textContent = label
      action.addEventListener('click', () => bus.post({ command })); header.append(action)
    }
  }
  if (model.canApplyFamily) {
    const action = document.createElement('button'); action.type = 'button'; action.className = 'mcrh-btn mcrh-btn--secondary'; action.textContent = uiText("webview.preview.modelInspector.batchMatchingApply")
    action.title = uiText("webview.syntax.applyCurrentJsonToMatchingSimilarResources")
    action.addEventListener('click', () => bus.post({ command: 'applyJsonFamily' })); header.append(action)
  }
  root.append(header)

  if (model.packEntry) root.append(packEntry(model.packEntry))
  if (model.glyphs?.length) {
    const palette = document.createElement('section'); palette.className = 'mcrh-glyph-palette'; palette.setAttribute('aria-label', uiText("ui.tutorialCards.unicodePasteCharacter"))
    for (const glyph of model.glyphs) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'mcrh-glyph-card'
      const preview = span({ text: glyph.char, font: glyph.font }); preview.className = 'mcrh-glyph-card-preview'
      const label = document.createElement('code'); label.textContent = 'U+' + glyph.char.codePointAt(0)!.toString(16).toUpperCase()
      button.title = uiText("webview.syntax.copyUnicodeConversion", glyph.font, (glyph.texture ?? glyph.source))
      button.append(preview, label)
      button.addEventListener('click', () => { bus.post({ command: 'copyFontGlyph', char: glyph.char, font: glyph.font }); button.title = uiText("webview.syntax.copyedUnicodeConversion") })
      palette.append(button)
    }
    root.append(palette)
  }

  if (model.effectLines.length || model.images.length || (model.text && model.text.length)) {
    const effect = document.createElement('section')
    effect.className = 'mcrh-effect'
    if (model.effectTitle) effect.innerHTML = `<h2>${escape(model.effectTitle)}</h2>`
    for (const line of model.effectLines) {
      const p = document.createElement('p')
      p.textContent = line
      effect.append(p)
    }
    for (const block of model.text ?? []) effect.append(textBlock(block))
    if (model.images.length) {
      const grid = document.createElement('div')
      grid.className = 'mcrh-thumbs'
      for (const image of model.images) grid.append(thumb(image))
      effect.append(grid)
    }
    root.append(effect)
  }

  if (model.fields.length) {
    const ref = document.createElement('section')
    ref.className = 'mcrh-fields'
    ref.innerHTML = `<h2>${escape(model.fieldsTitle || uiText("webview.syntax.useability"))}</h2>`
    const table = document.createElement('table')
    for (const field of model.fields) {
      const row = document.createElement('tr')
      row.innerHTML = `<td class="mcrh-key">${escape(field.name)}</td><td class="mcrh-desc">${escape(field.detail)}</td>`
      table.append(row)
    }
    ref.append(table)
    root.append(ref)
  }

  for (const note of model.notes) {
    const n = document.createElement('p')
    n.className = 'mcrh-note'
    n.textContent = note
    root.append(n)
  }
}

function blockbenchButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'mcrh-btn mcrh-btn--secondary mcrh-head-action'
  button.title = uiText("webview.syntax.opensTheCurrentModelInBlockbench")
  const icon = document.createElement('span')
  icon.className = 'codicon codicon-edit'
  icon.setAttribute('aria-hidden', 'true')
  button.append(icon, uiText("ui.blockbenchCommand.openInBlockbench"))
  button.addEventListener('click', () => bus.post({ command: 'openInBlockbench' }))
  return button
}

function packEntry(entry: SyntaxPackEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'mcrh-pack'
  const icon = document.createElement('canvas')
  icon.className = 'mcrh-pack-icon'
  if (entry.icon) {
    icon.width = entry.icon.width
    icon.height = entry.icon.height
    icon.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(entry.icon.data), entry.icon.width, entry.icon.height), 0, 0)
  } else {
    icon.width = 16
    icon.height = 16
  }
  const info = document.createElement('div')
  info.className = 'mcrh-pack-info'
  const title = document.createElement('div')
  title.className = 'mcrh-pack-title'
  title.textContent = entry.title
  const desc = document.createElement('div')
  desc.className = 'mcrh-pack-desc'
  for (const line of entry.description) {
    const l = document.createElement('div')
    l.className = 'mcrh-pack-line'
    for (const run of line) l.append(span(run))
    if (line.length === 0) l.innerHTML = '&nbsp;'
    desc.append(l)
  }
  info.append(title, desc)
  row.append(icon, info)
  return row
}

function textBlock(block: { label: string; lines: SyntaxTextRun[][]; pixelSize: number }): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'mcrh-text'
  const label = document.createElement('div')
  label.className = 'mcrh-text-label'
  label.textContent = block.label
  const body = document.createElement('div')
  body.className = 'mcrh-text-body'
  for (const line of block.lines) {
    const row = document.createElement('div')
    row.className = 'mcrh-text-line'
    for (const run of line) row.append(span(run))
    if (line.length === 0) row.innerHTML = '&nbsp;'
    body.append(row)
  }
  wrap.append(label, body)
  return wrap
}

function span(run: SyntaxTextRun): HTMLElement {
  const el = document.createElement('span')
  el.textContent = run.text
  if (run.color) el.style.color = run.color
  if (run.bold) el.style.fontWeight = '700'
  if (run.italic) el.style.fontStyle = 'italic'
  const decorations: string[] = []
  if (run.underline) decorations.push('underline')
  if (run.strikethrough) decorations.push('line-through')
  if (decorations.length) el.style.textDecoration = decorations.join(' ')
  if (run.obfuscated) el.textContent = run.text.replace(/\S/g, () => '▓')
  else renderGlyphRun(el, run)
  return el
}

const THUMB_EDGE = 64

function thumb(image: { label: string; width: number; height: number; data: ArrayBuffer }): HTMLElement {
  const wrap = document.createElement('figure')
  wrap.className = 'mcrh-thumb'
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')!
  const data = new Uint8ClampedArray(image.data)
  ctx.putImageData(new ImageData(data, image.width, image.height), 0, 0)
  const size = fitWithin(image.width, image.height, THUMB_EDGE)
  canvas.style.width = `${size.width}px`
  canvas.style.height = `${size.height}px`
  canvas.style.imageRendering = 'pixelated'
  const caption = document.createElement('figcaption')
  caption.textContent = image.label
  wrap.append(canvas, caption)
  return wrap
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}

onHostMessage(message => {
  const msg = message as SyntaxPreviewMessage | undefined
  if (msg?.command === 'syntax') render(msg)
})

bus.post({ command: 'syntaxReady' } as SyntaxCommand)

function renderGlyphRun(element: HTMLElement, run: SyntaxTextRun): void {
  const entries = Array.from(run.text).map(char => ({ char, glyph: glyphs.get((run.font ?? 'minecraft:default') + ':' + char) }))
  if (!entries.some(entry => entry.glyph)) return
  element.replaceChildren()
  for (const { char, glyph } of entries) {
    if (!glyph) { element.append(document.createTextNode(char)); continue }
    const holder = document.createElement('span'); holder.className = 'mcrh-font-glyph'; holder.title = 'U+' + char.codePointAt(0)!.toString(16).toUpperCase() + ' · ' + glyph.source
    holder.setAttribute('aria-label', char)
    holder.style.display = 'inline-block'; holder.style.position = 'relative'
    holder.style.width = Math.max(0, glyph.advance / 8) + 'em'
    if (glyph.advance < 0) holder.style.marginLeft = glyph.advance / 8 + 'em'
    if (glyph.pixels && glyph.pixelWidth && glyph.pixelHeight) {
      const canvas = document.createElement('canvas'); canvas.width = glyph.pixelWidth; canvas.height = glyph.pixelHeight
      const context = canvas.getContext('2d')!
      context.putImageData(new ImageData(new Uint8ClampedArray(glyph.pixels), glyph.pixelWidth, glyph.pixelHeight), 0, 0)
      if (run.color) { context.globalCompositeOperation = 'multiply'; context.fillStyle = run.color; context.fillRect(0, 0, canvas.width, canvas.height); context.globalCompositeOperation = 'destination-in'; const mask = document.createElement('canvas'); mask.width = canvas.width; mask.height = canvas.height; mask.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(glyph.pixels), canvas.width, canvas.height), 0, 0); context.drawImage(mask, 0, 0) }
      canvas.style.width = glyph.width / 8 + 'em'; canvas.style.height = glyph.height / 8 + 'em'
      canvas.style.imageRendering = 'pixelated'; canvas.style.position = 'absolute'; canvas.style.left = '0'; canvas.style.bottom = (glyph.ascent - glyph.height) / 8 + 'em'
      holder.append(canvas)
    }
    element.append(holder)
  }
}
