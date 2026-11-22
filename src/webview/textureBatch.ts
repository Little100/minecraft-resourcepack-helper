import { uiHtml, uiText } from '../i18n/messages'
import { Zip, ZipDeflate } from 'fflate'
import { ringMask, themeColor, connectedBlockPath, decodePixelImage, encodePixelImage, applyPixelPreset, animationFrameSize, connectedBorderTiles, generateConnectedBorder, type TextureBatchOptions, type PixelImage } from '../core/advanced/textureBatch'
import { createConnectedPreview } from './connectedPreview'
import { createPackMcmeta } from '../core/advanced/versionCapabilities'
import { withPackRequirements } from '../core/advanced/packRequirements'
import { PackToolsResponseSchema, decodePackToolsFiles, encodePackToolsBytes, validatePackToolsFiles, type PackToolsFile, type PackToolsResponse } from '../core/advanced/packToolsProtocol'
import type { GeneratedFile } from '../core/advanced/safeExport'

interface Options { post(message: object): void; version(): string }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const effects = { 'theme-dark': ['darken', 'theme'], 'theme-light': ['lighten', 'theme'], 'pixel-dark': ['darken', 'pixel'], 'pixel-light': ['lighten', 'pixel'], bevel: ['bevel', 'pixel'], 'edge-bevel': ['bevel', 'pixel'], 'edge-dark': ['darken', 'pixel'], 'edge-light': ['lighten', 'pixel'], 'edge-transition': ['transition', 'pixel'] } as const
export function createTextureBatch(container: HTMLElement, options: Options): { hasSession(): boolean; receive(message: unknown): void; dispose(): void } {
  container.className = 'texture-batch'
  container.innerHTML = `<div class="batch-heading"><div><h2>${uiHtml("webview.textureBatch.pixelBatchProcessingAndConnectionEdges")}</h2><p class="muted">${uiHtml("webview.textureBatch.handleTheMultiSpectrumBasechartIndependentStatistically")}</p></div><div class="batch-actions"><button data-batch="project">${uiHtml("webview.textureBatch.readResourcePackItems")}</button><button data-batch="images">${uiHtml("webview.textureBatch.selectPngAnimatedMetadata")}</button></div></div><div class="batch-layout"><aside class="card batch-sources"><div class="batch-actions"><button data-batch="all">${uiHtml("webview.textureBatch.selectAllPictures")}</button><button data-batch="none">${uiHtml("webview.textureBatch.none")}</button><button data-batch="flip">${uiHtml("webview.textureBatch.invertPicture")}</button></div><label>${uiHtml("webview.textureBatch.filterPictures")}<input id="batch-search" type="search" placeholder="${uiHtml("webview.textureBatch.filterByResourcePath")}"></label><label class="batch-check"><input id="batch-data-images" type="checkbox">${uiHtml("webview.textureBatch.listPbrDataChartsAndSpecialAtlases")}</label><p id="batch-count" class="muted"></p><div id="batch-files" role="group" aria-label="${uiHtml("webview.textureBatch.batchProcessPictures")}"></div><div class="batch-actions"><button data-batch="previous">${uiHtml("browser.resources.previousPage")}</button><span id="batch-page" class="muted"></span><button data-batch="next">${uiHtml("browser.resources.nextPage")}</button></div></aside><article class="card batch-editor"><h3>${uiHtml("webview.textureBatch.selectCorrespondingPixels")}</h3><div class="batch-actions"><button data-batch="ring">${uiHtml("webview.textureBatch.outermostSquare")}</button><button data-batch="mask-all">${uiHtml("webview.textureBatch.selectAllSquares")}</button><button data-batch="mask-none">${uiHtml("webview.textureBatch.clearSquare")}</button><button data-batch="mask-invert">${uiHtml("webview.textureBatch.inverseSquare")}</button></div><div class="batch-controls"><label>${uiHtml("webview.textureBatch.referenceGrid")}<select id="batch-size"><option value="8">8 × 8</option><option value="16" selected>16 × 16</option><option value="32">32 × 32</option><option value="64">64 × 64</option></select></label><label>${uiHtml("webview.textureBatch.outerCircleWidthGate")}<input id="batch-width" type="number" min="1" max="7" value="1"></label><label>${uiHtml("webview.textureBatch.effectsPreset")}<select id="batch-effect"><option value="theme-dark">${uiHtml("webview.textureBatch.themeColourDeepEdge")}</option><option value="theme-light">${uiHtml("webview.textureBatch.themeColourHighlightEdges")}</option><option value="pixel-dark">${uiHtml("webview.textureBatch.originalPixelsDeepening")}</option><option value="pixel-light">${uiHtml("webview.textureBatch.pixelsHighlight")}</option><option value="bevel">${uiHtml("webview.textureBatch.embossEdgeDownAndDarkAbove")}</option><option value="edge-bevel">${uiHtml("webview.textureBatch.autoContourLevelAndTone")}</option><option value="edge-dark">${uiHtml("webview.textureBatch.automaticallyApproachTheEdgesToDeepen")}</option><option value="edge-light">${uiHtml("webview.textureBatch.autoNearEdgeHighlight")}</option><option value="edge-transition">${uiHtml("webview.paint.edgeRecolor.midChooseTransitionToAdjacentColorBlock")}</option></select></label><label>${uiHtml("webview.textureBatch.automaticContourWidthPixels")}<input id="batch-edge-radius" type="number" min="1" max="32" value="2"></label><label>${uiHtml("webview.textureBatch.autoEdgeToneOffset")}<input id="batch-edge-hue" type="number" min="-60" max="60" value="6"></label><label data-batch-transition hidden>${uiHtml("webview.textureBatch.transitionLocation")}<select id="batch-transition-side"><option value="lighter">${uiHtml("webview.textureBatch.lightSideDarkProfileRetained")}</option><option value="darker">${uiHtml("webview.textureBatch.darkSide")}</option><option value="both">${uiHtml("webview.textureBatch.bothSides")}</option></select></label><label data-batch-transition hidden>${uiHtml("webview.paint.edgeRecolor.transitionalColourSource")}<select id="batch-transition-source"><option value="nearby">${uiHtml("webview.paint.edgeRecolor.thereSAMiddleColorInThe")}</option><option value="mix">${uiHtml("webview.textureBatch.combiningTheNextTwoColors")}</option></select></label><label data-batch-transition hidden>${uiHtml("webview.paint.edgeRecolor.distanceColourScales")}<input id="batch-transition-steps" type="number" min="1" max="8" value="2"></label><label data-batch-transition hidden>${uiHtml("webview.paint.edgeRecolor.colorBlockBorderDifference")}<input id="batch-edge-tolerance" type="number" min="0" max="255" value="48"></label><label>${uiHtml("webview.textureBatch.effectIntensityTransformationTargetMedium")}<input id="batch-strength" type="range" min="0" max="1" step="0.05" value="0.25"><output id="batch-strength-value">25%</output></label></div><div class="batch-previews"><div><strong>${uiHtml("webview.textureBatch.originalSelection")}</strong><canvas id="batch-mask" width="320" height="320" tabindex="0" aria-label="${uiHtml("webview.textureBatch.clickToSwitchPixelSquaresMoveThe")}"></canvas></div><div><strong>${uiHtml("webview.textureBatch.processResults")}</strong><canvas id="batch-result" width="320" height="320" aria-label="${uiHtml("webview.textureBatch.batchpreview")}"></canvas></div></div><p class="muted">${uiHtml("webview.textureBatch.gridMapByFrameScaleGridsWith")}</p></article><article class="card batch-connected"></article></div><div class="batch-footer"><button class="primary" data-batch="generate">${uiHtml("webview.textureBatch.generateResultsAndCheckThem")}</button><button data-batch="save" disabled>${uiHtml("webview.textureBatch.exportPatchZip")}</button><button data-batch="cancel" hidden>${uiHtml("browser.shell.cancel")}</button><span id="batch-status" role="status" aria-live="polite">${uiHtml("webview.textureBatch.startAfterReadingItemsOrSelectingPng")}</span></div><details id="batch-output" hidden><summary>${uiHtml("webview.textureBatch.exportingFilesAndRunningDependencies")}</summary><pre></pre></details>`
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!
  let files: PackToolsFile[] = [], selected = new Set<string>(), active = '', mask = ringMask(16), result: GeneratedFile[] | undefined, resultVersion = '', busy = false, generation = 0, disposed = false, serial = 0, previewQueued = false, page = 0, cursor = 0
  const pageSize = 100
  const pending = new Map<string, { resolve(value: PackToolsResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const comparison = createConnectedPreview(get('.batch-connected'))
  const encoder = new TextEncoder()
  const status = (text: string, error = false) => { get('#batch-status').textContent = (text); get('#batch-status').setAttribute('role', error ? 'alert' : 'status') }
  const rpc = (command: string, payload = {}): Promise<PackToolsResponse> => new Promise((resolve, reject) => {
    const requestId = 'batch_' + Date.now().toString(36) + '_' + serial++, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(uiText("webview.textureBatch.fileRequestsTimeoutPleaseTryAgain"))) }, 180000)
    pending.set(requestId, { resolve, reject, timer }); options.post({ command, requestId, ...payload })
  })
  const matching = () => files.filter(file => /^assets\/[^/]+\/textures\/.+\.png$/i.test(file.path) && (get<HTMLInputElement>('#batch-data-images').checked || !/_(?:n|s|e|normal|height|roughness|metallic|ao)\.png$/i.test(file.path) && !/\/textures\/(?:colormap|font|gui|entity)\//i.test(file.path)))
  const visible = () => matching().filter(file => file.path.toLowerCase().includes(get<HTMLInputElement>('#batch-search').value.toLowerCase()))
  const invalidate = () => { result = undefined; get<HTMLButtonElement>('[data-batch=save]').disabled = true; get('#batch-output').hidden = true }
  function followSelection(): void {
    if (!selected.has(active)) active = selected.values().next().value ?? ''
  }
  const sync = () => {
    const list = get('#batch-files'); list.replaceChildren()
    const available = visible()
    page = Math.max(0, Math.min(page, Math.ceil(available.length / pageSize) - 1))
    get('#batch-page').textContent = (page + 1) + ' / ' + Math.max(1, Math.ceil(available.length / pageSize))
    for (const file of available.slice(page * pageSize, (page + 1) * pageSize)) {
      const row = document.createElement('div'); row.className = 'batch-file'
      const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = busy; check.checked = selected.has(file.path); check.setAttribute('aria-label', uiText("webview.collaboration.selection", file.path)); check.dataset.path = file.path
      check.addEventListener('change', () => {
        if (check.checked) { selected.add(file.path); active = file.path }
        else { selected.delete(file.path); followSelection() }
        for (const item of list.querySelectorAll<HTMLButtonElement>('button[data-path]')) item.setAttribute('aria-pressed', String(item.dataset.path === active))
        invalidate(); updateCount(); queuePreview()
      })
      const view = document.createElement('button'); view.disabled = busy; view.textContent = file.path.replace(/^assets\//, ''); view.title = file.path; view.dataset.path = file.path; view.setAttribute('aria-pressed', String(active === file.path)); view.addEventListener('click', () => { active = file.path; sync(); queuePreview() })
      row.append(check, view); list.append(row)
    }
    get<HTMLButtonElement>('[data-batch=previous]').disabled = busy || page === 0
    get<HTMLButtonElement>('[data-batch=next]').disabled = busy || (page + 1) * pageSize >= available.length
    updateCount()
  }
  const updateCount = () => { get('#batch-count').textContent = uiText("webview.textureBatch.selectedChangAvailableChangAllSelectedAfter", selected.size, matching().length) }
  function settings(connected = false): TextureBatchOptions {
    const size = Number(get<HTMLSelectElement>('#batch-size').value), width = Number(get<HTMLInputElement>('#batch-width').value), preset = get<HTMLSelectElement>('#batch-effect').value as keyof typeof effects
    if (!effects[preset]) throw new Error(uiText("webview.textureBatch.effectPresetInvalid"))
    const automaticEdges = preset.startsWith('edge-')
    if (connected && automaticEdges) throw new Error(uiText("webview.textureBatch.automaticContourPresetsOnlyForGeneralBatch"))
    const ring = ringMask(size, width)
    if (mask.size !== size) throw new Error(uiText("webview.textureBatch.theReferenceGridIsNotAlignedWith"))
    return { automaticEdges, transitionSide: get<HTMLSelectElement>('#batch-transition-side').value as TextureBatchOptions['transitionSide'], transitionSource: get<HTMLSelectElement>('#batch-transition-source').value as TextureBatchOptions['transitionSource'], transitionSteps: Number(get<HTMLInputElement>('#batch-transition-steps').value), edgeTolerance: Number(get<HTMLInputElement>('#batch-edge-tolerance').value), edgeRadius: Number(get<HTMLInputElement>('#batch-edge-radius').value), hueShift: Number(get<HTMLInputElement>('#batch-edge-hue').value), effect: effects[preset][0], colorSource: effects[preset][1], strength: Number(get<HTMLInputElement>('#batch-strength').value), mask: connected ? ring : mask }
  }
  const paint = (canvas: HTMLCanvasElement, image: PixelImage, frameWidth: number, frameHeight: number) => {
    const context = canvas.getContext('2d')!, tile = document.createElement('canvas'); tile.width = image.width; tile.height = image.height
    tile.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height); context.imageSmoothingEnabled = false; context.drawImage(tile, 0, 0, frameWidth, frameHeight, 0, 0, canvas.width, canvas.height)
  }
  let cachedFrame: { file: PackToolsFile; image: PixelImage; palette: ReturnType<typeof themeColor> } | undefined
  function previewFrame(file: PackToolsFile) {
    if (cachedFrame?.file === file) return cachedFrame
    const source = decodePixelImage(file.content)
    const metadata = files.find(entry => entry.path === file.path + '.mcmeta')?.content
    const { frameWidth: width, frameHeight: height } = animationFrameSize(source, metadata)
    let image = source
    if (width !== source.width || height !== source.height) {
      image = { width, height, data: new Uint8Array(width * height * 4) }
      for (let y = 0; y < height; y++) {
        const start = y * source.width * 4
        image.data.set(source.data.subarray(start, start + width * 4), y * width * 4)
      }
    }
    cachedFrame = { file, image, palette: themeColor(source) }
    return cachedFrame
  }
  function clearEditorPreview(): void {
    for (const id of ['#batch-mask', '#batch-result']) {
      const canvas = get<HTMLCanvasElement>(id)
      canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
  function preview(): void {
    const file = files.find(entry => entry.path === active)
    if (!file) {
      cachedFrame = undefined
      clearEditorPreview()
      comparison.unavailable(uiText('webview.textureBatch.choosePreviewBlock'))
      return
    }
    const { image, palette } = previewFrame(file)
    const normal = settings()
    const ring = ringMask(normal.mask.size, Number(get<HTMLInputElement>('#batch-width').value))
    const config = get<HTMLInputElement>('#batch-ctm').checked && !normal.automaticEdges ? { ...normal, mask: ring } : normal
    paint(get('#batch-mask'), image, image.width, image.height)
    paint(get('#batch-result'), applyPixelPreset(image, config, palette), image.width, image.height)
    const canvas = get<HTMLCanvasElement>('#batch-mask'), context = canvas.getContext('2d')!, scale = canvas.width / mask.size
    context.fillStyle = 'rgba(22,130,245,0.25)'; for (const cell of config.mask.cells) context.fillRect(cell % mask.size * scale, Math.floor(cell / mask.size) * scale, scale, scale)
    context.strokeStyle = 'rgba(128,128,128,0.35)'; context.lineWidth = 0.5
    for (let index = 0; index <= mask.size; index++) { context.beginPath(); context.moveTo(index * scale, 0); context.lineTo(index * scale, canvas.height); context.moveTo(0, index * scale); context.lineTo(canvas.width, index * scale); context.stroke() }
    if (document.activeElement === canvas) { context.strokeStyle = '#fff'; context.lineWidth = 2; context.strokeRect(cursor % mask.size * scale + 1, Math.floor(cursor / mask.size) * scale + 1, scale - 2, scale - 2) }
    if (!connectedBlockPath.test(file.path)) { comparison.unavailable(uiText('core.advanced.textureBatch.onlySquareBottomsBelowTexturesBlockAccept')); return }
    if (image.width !== image.height || image.width % 2) { comparison.unavailable(uiText('webview.textureBatch.connectionPreviewRequiresEvenNumberedSquareFrames')); return }
    if (normal.automaticEdges) { comparison.unavailable(uiText('webview.textureBatch.automaticContourPresetsOnlyForGeneralBatch')); return }
    try { comparison.show(connectedBorderTiles(image, { ...normal, mask: ring }, palette)) }
    catch (error) { comparison.unavailable(error instanceof Error ? error.message : String(error)) }
  }
  function queuePreview(): void {
    if (previewQueued) return
    previewQueued = true
    requestAnimationFrame(() => {
      previewQueued = false
      if (disposed) return
      try { preview() } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        clearEditorPreview()
        comparison.unavailable(message)
        status(message, true)
      }
    })
  }
  function syncEffectControls(): void {
    const preset = get<HTMLSelectElement>('#batch-effect').value, transition = preset === 'edge-transition', automatic = preset.startsWith('edge-')
    container.querySelectorAll<HTMLElement>('[data-batch-transition]').forEach(element => { element.hidden = !transition })
    get<HTMLInputElement>('#batch-edge-hue').disabled = busy || !automatic || transition
    get<HTMLInputElement>('#batch-edge-radius').disabled = busy || !automatic
  }
  function syncMaskControls(): void {
    syncEffectControls()
    const connected = get<HTMLInputElement>('#batch-ctm').checked
    for (const action of ['mask-all', 'mask-none', 'mask-invert']) get<HTMLButtonElement>('[data-batch=' + action + ']').disabled = busy || connected
    get('#batch-mask').setAttribute('aria-disabled', String(busy || connected))
  }
  function setBusy(value: boolean): void { busy = value; for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) control.disabled = value; get<HTMLButtonElement>('[data-batch=save]').disabled = value || !result; get<HTMLButtonElement>('[data-batch=cancel]').hidden = !value; get<HTMLButtonElement>('[data-batch=cancel]').disabled = false; if (!value) sync(); syncMaskControls() }
  async function run(action: () => Promise<void> | void): Promise<void> { if (busy) return; setBusy(true); try { await action() } catch (error) { status(error instanceof Error ? error.message : String(error), true) } finally { if (!disposed) setBusy(false) } }
  async function load(command: string): Promise<void> {
    const token = generation, response = await rpc(command)
    if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    if (response.canceled) { status(uiText("webview.textureBatch.cancelledSelectionCurrentPictureRetained")); return }
    const incoming = decodePackToolsFiles(response.files ?? [])
    if (incoming.length > 20000) throw new Error(uiText("webview.textureBatch.tooManyProjectFiles"))
    files = incoming; selected = new Set(matching().map(file => file.path)); active = matching()[0]?.path ?? ''; page = 0; invalidate(); sync(); queuePreview(); status(uiText("webview.textureBatch.readAnImageToProcessSelectSquares", matching().length))
  }
  async function generate(): Promise<void> {
    invalidate()
    if (!selected.size) throw new Error(uiText("webview.textureBatch.pleaseSelectAtLeastOnePicture"))
    const token = ++generation, connected = get<HTMLInputElement>('#batch-ctm').checked, config = settings(connected), output: GeneratedFile[] = [], paths = new Set<string>(); let total = 0
    const push = (file: GeneratedFile) => { if (paths.has(file.path)) throw new Error(uiText("webview.textureBatch.generatePathConflict", file.path)); const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content; total += content.length; if (total > 128 * 1024 * 1024 || output.length >= 24000) throw new Error(uiText("webview.textureBatch.outputExceedingMibOrFileNumberBudget")); paths.add(file.path); output.push({ path: file.path, content }) }
    if (!config.mask.cells.length) throw new Error(uiText("webview.textureBatch.pleaseSelectAtLeastOnePixelSquare"))
    const byPath = new Map(files.map(file => [file.path, file]))
    let processed = 0
    for (const path of selected) {
      if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
      const file = byPath.get(path); if (!file) throw new Error(uiText("webview.textureBatch.theSelectedResourceIsInvalid"))
      const metadata = byPath.get(path + '.mcmeta')?.content
      if (connected) {
        for (const generated of generateConnectedBorder(path, file.content, config, metadata, get<HTMLSelectElement>('#batch-faces').value)) push(generated)
        push(file); if (metadata) push({ path: path + '.mcmeta', content: metadata })
      } else { const image = decodePixelImage(file.content); push({ path, content: encodePixelImage(applyPixelPreset(image, { ...config, ...animationFrameSize(image, metadata) })) }); if (metadata) push({ path: path + '.mcmeta', content: metadata }) }
      status(uiText("webview.textureBatch.processedChang", ++processed, selected.size)); await tick()
    }
    const metadata = byPath.get('pack.mcmeta')
    push(metadata ?? { path: 'pack.mcmeta', content: JSON.stringify(createPackMcmeta(options.version(), 'resource', uiText("webview.textureBatch.mcrhBatchProcessingPatch")), null, 2) + '\n' })
    const required = withPackRequirements(output)
    if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
    resultVersion = options.version(); result = required.files; get('#batch-output').hidden = false; get('#batch-output pre').textContent = result.map(file => file.path).join('\n') + (required.warnings.length ? '\n\n' + required.warnings.join('\n') : '')
    get<HTMLDetailsElement>('#batch-output').open = true; status(uiText("webview.textureBatch.generatedAPatchForAPictureAll", processed, result.length, (required.warnings.length ? uiText("webview.textureBatch.includingInstructionsForOperationalDependency") : '')))
  }
  container.addEventListener('click', event => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-batch]')?.dataset.batch
    if (!action) return
    if (action === 'cancel') { generation++; options.post({ command: 'packToolsCancel', requestId: 'batch_cancel_' + serial++ }); status(uiText("webview.textureBatch.canceling")); return }
    void run(async () => {
      if (action === 'project' || action === 'images') { await load(action === 'project' ? 'packToolsProject' : 'packToolsImages'); return }
      if (action === 'previous' || action === 'next') { page += action === 'next' ? 1 : -1; sync(); return }
      if (action === 'generate') { await generate(); return }
      if (action === 'save') {
        if (!result) throw new Error(uiText("webview.textureBatch.pleaseMakeSureTheResultsCanBe"))
        if (resultVersion !== options.version()) { invalidate(); throw new Error(uiText("webview.textureBatch.targetVersionChangedPleaseRegenerateResults")) }
        const data = result.map(file => ({ path: file.path, content: typeof file.content === 'string' ? encoder.encode(file.content) : file.content, origin: 'modified' as const })); validatePackToolsFiles(data)
        const token = generation, chunks: Uint8Array[] = []; let length = 0, zipError: Error | undefined, finished = false
        const archive = new Zip((error, chunk, final) => {
          if (error) { zipError = error; return }
          length += chunk.length
          if (length > 128 * 1024 * 1024) { zipError = new Error(uiText("webview.textureBatch.zipOverMib")); return }
          chunks.push(chunk); if (final) finished = true
        })
        try {
          for (const file of data) {
            if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
            const entry = new ZipDeflate(file.path, { level: 6 }); archive.add(entry)
            if (!file.content.length) entry.push(new Uint8Array(), true)
            for (let offset = 0; offset < file.content.length; offset += 128 * 1024) {
              entry.push(file.content.subarray(offset, offset + 128 * 1024), offset + 128 * 1024 >= file.content.length)
              if (zipError) throw zipError
              await tick()
              if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
            }
          }
          archive.end(); if (zipError) throw zipError
          if (!finished) throw new Error(uiText("webview.packTools.zipCompressionIncompleteEnd"))
        } finally { archive.terminate() }
        const bytes = new Uint8Array(length); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        if (token !== generation || disposed) throw new Error(uiText("browser.packToolsBridge.operationCanceled"))
        const response = await rpc('packToolsSave', { name: 'mcrh-texture-preset.zip', base64: encodePackToolsBytes(bytes) })
        status(response.canceled ? uiText("webview.textureBatch.savedUnsavedGeneratedResultsRetain") : uiText("webview.textureBatch.patchZipSavedOrSentToBrowser")); return
      }
      if (action === 'all') for (const file of visible()) selected.add(file.path)
      if (action === 'none') for (const file of visible()) selected.delete(file.path)
      if (action === 'flip') for (const file of visible()) { if (selected.has(file.path)) selected.delete(file.path); else selected.add(file.path) }
      if (action === 'all' || action === 'none' || action === 'flip') followSelection()
      if (action === 'ring') mask = ringMask(Number(get<HTMLSelectElement>('#batch-size').value), Number(get<HTMLInputElement>('#batch-width').value))
      if (action === 'mask-all') mask = { size: mask.size, cells: Array.from({ length: mask.size ** 2 }, (_, index) => index) }
      if (action === 'mask-none') mask = { size: mask.size, cells: [] }
      if (action === 'mask-invert') { const cells = new Set(mask.cells); mask = { size: mask.size, cells: Array.from({ length: mask.size ** 2 }, (_, index) => index).filter(index => !cells.has(index)) } }
      invalidate(); sync(); queuePreview()
    })
  })
  get<HTMLCanvasElement>('#batch-mask').addEventListener('click', event => { if (busy || get<HTMLInputElement>('#batch-ctm').checked) return; const canvas = event.currentTarget as HTMLCanvasElement, rect = canvas.getBoundingClientRect(), x = Math.floor((event.clientX - rect.left) / rect.width * mask.size), y = Math.floor((event.clientY - rect.top) / rect.height * mask.size); if (x < 0 || y < 0 || x >= mask.size || y >= mask.size) return; cursor = y * mask.size + x; const cell = cursor, cells = new Set(mask.cells); if (cells.has(cell)) cells.delete(cell); else cells.add(cell); mask = { size: mask.size, cells: [...cells] }; invalidate(); queuePreview() })
  get<HTMLCanvasElement>('#batch-mask').addEventListener('keydown', event => {
    if (busy || get<HTMLInputElement>('#batch-ctm').checked) return
    const movements: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -mask.size, ArrowDown: mask.size }
    if (event.key in movements) { event.preventDefault(); cursor = Math.max(0, Math.min(mask.size ** 2 - 1, cursor + movements[event.key])); queuePreview() }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); const cells = new Set(mask.cells); if (cells.has(cursor)) cells.delete(cursor); else cells.add(cursor); mask = { size: mask.size, cells: [...cells] }; invalidate(); queuePreview() }
  })
  get('#batch-mask').addEventListener('focus', queuePreview)
  get('#batch-mask').addEventListener('blur', queuePreview)
  container.addEventListener('input', event => { const target = event.target as HTMLInputElement; if (!target.id.startsWith('batch-')) return; if (target.id === 'batch-search') { page = 0; sync(); return }; invalidate(); if (target.id === 'batch-data-images') { const available = new Set(matching().map(file => file.path)); selected = new Set([...selected].filter(path => available.has(path))); if (!available.has(active)) followSelection(); page = 0; sync() }; if (target.id === 'batch-size' || target.id === 'batch-width') { const size = Number(get<HTMLSelectElement>('#batch-size').value); get<HTMLInputElement>('#batch-width').max = String(size / 2 - 1); cursor = Math.min(cursor, size ** 2 - 1); try { mask = ringMask(size, Number(get<HTMLInputElement>('#batch-width').value)) } catch (error) { status(String(error), true); queuePreview(); return } }; get('#batch-strength-value').textContent = Math.round(Number(get<HTMLInputElement>('#batch-strength').value) * 100) + '%'; get('#batch-requirements').hidden = !get<HTMLInputElement>('#batch-ctm').checked; invalidate(); syncMaskControls(); queuePreview() })
  syncMaskControls()
  return {
    hasSession: () => busy || files.length > 0,
    receive(message) { const parsed = PackToolsResponseSchema.safeParse(message); if (!parsed.success) return; const item = pending.get(parsed.data.requestId); if (!item) return; clearTimeout(item.timer); pending.delete(parsed.data.requestId); if (parsed.data.ok) item.resolve(parsed.data); else item.reject(new Error(parsed.data.error ?? uiText("webview.packTools.fileOperationFailed"))) },
    dispose() { disposed = true; generation++; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(uiText("ui.modTexturesHost.pageClosed"))) }; pending.clear() }
  }
}
