import { uiHtml, uiText } from '../i18n/messages'
import { extractTextureWatermark, TEXTURE_WATERMARK_DEFAULTS, type WatermarkCorners, type WatermarkImage, type WatermarkPoint } from '../core/textureWatermark'
import { parseTextureWatermarkSettings, type TextureWatermarkSettings } from '../core/textureWatermarkSettings'

export function readTextureWatermarkSettings(container: ParentNode = document): TextureWatermarkSettings {
  const enabled = container.querySelector<HTMLInputElement>('[data-watermark=enabled]')?.checked === true
  if (!enabled) return { enabled: false }
  const settings = { enabled, id: container.querySelector<HTMLInputElement>('[data-watermark=id]')?.value.trim(), keyHex: container.querySelector<HTMLInputElement>('[data-watermark=key]')?.value.trim() }
  parseTextureWatermarkSettings(settings)
  return settings
}

export function createTextureWatermarkTools(container: HTMLElement): { dispose(): void } {
  container.classList.add('watermark-tools')
  container.innerHTML = `<label><input type="checkbox" data-watermark="enabled" data-private>${uiHtml("webview.watermarkTools.addInvisibleWatermarksToExport")}</label><p class="muted">${uiHtml("webview.watermarkTools.supportOnlyNonTransparentAtLeastPixels")}</p><label>${uiHtml("webview.watermarkTools.identification")}<input data-watermark="id" maxlength="8" placeholder="${uiHtml("webview.watermarkTools.eightHexadecimal")}" data-private></label><label>${uiHtml("webview.watermarkTools.key")}<input data-watermark="key" type="password" maxlength="128" autocomplete="off" placeholder="${uiHtml("webview.watermarkTools.atLeastHexadecimalCharacters")}" data-private></label><div class="watermark-actions"><button type="button" data-watermark-action="generate">${uiHtml("webview.watermarkTools.generateIdsAndKeys")}</button><button type="button" data-watermark-action="reveal">${uiHtml("webview.watermarkTools.showKey")}</button><button type="button" data-watermark-action="verify">${uiHtml("webview.watermarkTools.ripperValidation")}</button></div><p class="muted">${uiHtml("webview.watermarkTools.keyIsOnlyInTheCurrentPage")}</p><p class="watermark-status" role="status"></p>`
  const id = container.querySelector<HTMLInputElement>('[data-watermark=id]')!
  const key = container.querySelector<HTMLInputElement>('[data-watermark=key]')!
  const status = container.querySelector<HTMLElement>('.watermark-status')!
  const dialog = document.createElement('dialog')
  dialog.className = 'watermark-dialog'
  dialog.setAttribute('aria-label', uiText("webview.watermarkTools.getTheInvisibleWatermarks"))
  dialog.innerHTML = `<header><h2>${uiHtml("webview.watermarkTools.getTheInvisibleWatermarks")}</h2><button type="button" data-close>${uiHtml("browser.resources.close")}</button></header><p>${uiHtml("webview.watermarkTools.selectAPngWithWatermarksOrThe")}</p><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="${uiHtml("webview.watermarkTools.imagesOfWatermarkToBeValidated")}"><canvas aria-label="${uiHtml("webview.watermarkTools.watermarkPicturesAndFourPointSelection")}"></canvas><div class="watermark-actions"><button type="button" data-reset>${uiHtml("webview.watermarkTools.clearQuarters")}</button><button type="button" data-extract>${uiHtml("webview.watermarkTools.ripperValidation")}</button></div><p role="status"></p>`
  document.body.append(dialog)
  const canvas = dialog.querySelector('canvas')!
  const output = dialog.querySelector<HTMLElement>('[role=status]')!
  let image: WatermarkImage | undefined, points: WatermarkPoint[] = [], closed = false
  const draw = () => {
    if (!image) return
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')!
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
    context.strokeStyle = getComputedStyle(container).getPropertyValue('--mcrh-accent').trim() || '#007fd4'
    context.fillStyle = context.strokeStyle
    context.lineWidth = Math.max(2, image.width / 300)
    for (const point of points) { context.beginPath(); context.arc(point.x, point.y, Math.max(4, image.width / 100), 0, Math.PI * 2); context.stroke() }
    if (points.length) { context.beginPath(); context.moveTo(points[0].x, points[0].y); for (const point of points.slice(1)) context.lineTo(point.x, point.y); if (points.length === 4) context.closePath(); context.stroke() }
  }
  const click = (event: Event) => {
    const action = (event.target as Element).closest<HTMLElement>('[data-watermark-action]')?.dataset.watermarkAction
    if (!action) return
    try {
      if (action === 'generate') { const hex = (length: number) => Array.from(crypto.getRandomValues(new Uint8Array(length)), value => value.toString(16).padStart(2, '0')).join(''); id.value = hex(4); key.value = hex(32); status.textContent = uiText("webview.watermarkTools.generatedSaveYourOwnKeysDoNot") }
      if (action === 'reveal') key.type = key.type === 'password' ? 'text' : 'password'
      if (action === 'verify') { output.textContent = ''; dialog.showModal() }
    } catch (error) { status.textContent = ((error instanceof Error ? error.message : String(error))) }
  }
  container.addEventListener('click', click)
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close())
  dialog.querySelector('[data-reset]')!.addEventListener('click', () => { points = []; draw(); output.textContent = uiText("webview.watermarkTools.quarterCleared") })
  dialog.querySelector('input')!.addEventListener('change', async event => {
    try {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      if (file.size > 32 * 1024 * 1024) throw new Error(uiText("webview.watermarkTools.verifyPicturesExceedingMib"))
      const bitmap = await createImageBitmap(file)
      try {
        if (bitmap.width * bitmap.height > TEXTURE_WATERMARK_DEFAULTS.maximumPixels) throw new Error(uiText("webview.watermarkTools.authenticationOfTotalPixelsLimit"))
        canvas.width = bitmap.width; canvas.height = bitmap.height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(bitmap, 0, 0)
        image = { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data }
        points = []; draw(); output.textContent = uiText("webview.watermarkTools.pictureLoadedCanBeVerifiedOrSelected")
      } finally { bitmap.close() }
    } catch (error) { image = undefined; output.textContent = ((error instanceof Error ? error.message : String(error))) }
  })
  canvas.addEventListener('click', event => { if (!image || points.length >= 4) return; const box = canvas.getBoundingClientRect(); points.push({ x: Math.max(0, Math.min(image.width - 1, (event.clientX - box.left) / box.width * image.width)), y: Math.max(0, Math.min(image.height - 1, (event.clientY - box.top) / box.height * image.height)) }); draw(); output.textContent = uiText("webview.watermarkTools.selectedALittleAngle", points.length) })
  dialog.querySelector('[data-extract]')!.addEventListener('click', async () => {
    try {
      if (!image) throw new Error(uiText("webview.watermarkTools.pleaseSelectAPictureFirst"))
      if (points.length !== 0 && points.length !== 4) throw new Error(uiText("webview.watermarkTools.pleaseSelectFourAnglesOrRemoveThe"))
      const options = parseTextureWatermarkSettings({ enabled: true, id: id.value.trim() || '00000000', keyHex: key.value.trim() })!
      output.textContent = uiText("webview.watermarkTools.extractingAllCalculationsAreDoneInThis")
      const result = await extractTextureWatermark(image, { key: options.key, corners: points.length === 4 ? points as unknown as WatermarkCorners : undefined })
      if (closed) return
      output.textContent = result.authenticated ? uiText("webview.watermarkTools.certificationPassIdentificationConfidence", result.id, result.confidence.toFixed(3)) : uiText("webview.watermarkTools.noWatermarksCertifiedByKeyWereDetected")
    } catch (error) { output.textContent = ((error instanceof Error ? error.message : String(error))) }
  })
  return { dispose() { closed = true; key.value = ''; id.value = ''; container.removeEventListener('click', click); dialog.remove() } }
}
