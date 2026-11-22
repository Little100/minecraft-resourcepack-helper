import { uiHtml, uiText } from '../i18n/messages'
import { createTintBlockPreview, type TintBlockPreview } from './tintBlockPreview'
import { TINT_PRESETS, generateTintPreset } from '../core/advanced/tintPresets'
import { decodePixelImage } from '../core/advanced/textureBatch'

export function createTintPresets(container: HTMLElement, version: () => string, post: (value:object)=>void): { refresh(): void; activate(active:boolean):void; receive(message:Record<string,unknown>):void; dispose():void } {
  container.classList.add('card', 'tint-presets')
  container.innerHTML = `<div class="tint-heading"><h2>${uiHtml("webview.tintPresets.shortcutBlockDye")}</h2><p class="muted">${uiHtml("webview.tintPresets.adjustsTheColourToSeeEffectsOn")}</p></div><div class="tint-layout"><div class="tint-editor"><form data-kind="tintPreset" class="form-grid"><label class="field">${uiHtml("webview.tintPresets.colouredObjects")}<select name="preset"></select></label><label class="field">${uiHtml("webview.tintPresets.colourScheme")}<select name="mode"><option value="flat">${uiHtml("webview.tintPresets.unifiedColours")}</option><option value="gradient">${uiHtml("webview.tintPresets.climateStateGradient")}</option></select></label><label class="field" data-tint-flat>${uiHtml("webview.tintPresets.colourColour")}<input name="color" type="color" value="#76b852"></label><label class="field" data-tint-gradient>${uiHtml("webview.tintPresets.coldLow")}<input name="cold" type="color" value="#8fabc1"></label><label class="field" data-tint-gradient>${uiHtml("webview.tintPresets.dryHeatMidstate")}<input name="dry" type="color" value="#c4b66d"></label><label class="field" data-tint-gradient>${uiHtml("webview.tintPresets.wetFeverHighState")}<input name="wet" type="color" value="#33834c"></label><label class="field" data-tint-custom>${uiHtml("webview.tintPresets.ruleName")}<input name="ruleName" value="custom_tint" pattern="[a-z0-9_-]+"></label><label class="field tint-wide" data-tint-custom>${uiHtml("webview.tintPresets.blockIds")}<input name="blocks" value="minecraft:stone minecraft:cobblestone"></label><button class="primary" type="submit" data-kind="tintPreset">${uiHtml("webview.tintPresets.generateDyeFiles")}</button></form><p id="tint-preset-note" class="muted"></p><p id="tint-preset-runtime" class="notice" hidden></p><details class="tint-output-details"><summary>${uiHtml("webview.tintPresets.correspondingBlocksAndOutputPath")}</summary><div id="tint-preset-blocks" class="tint-blocks"></div><p id="tint-preset-path" class="muted"></p></details><p id="tint-preset-error" role="status"></p></div><div class="tint-visual"><div id="tint-block-preview"></div><div class="tint-map-row"><canvas id="tint-preset-preview" width="256" height="256" aria-label="${uiHtml("webview.tintPresets.colourPreColorSchemeColourMap")}"></canvas><div><strong>${uiHtml("core.advanced.colormap.colourChart")}</strong><p class="muted">${uiHtml("webview.tintPresets.pasteRgbMultiplicationOfSampleValuesWith")}</p><label class="field" data-tint-sample>${uiHtml("webview.tintPresets.previewSamples")}<input id="tint-preview-sample" type="range" min="0" max="100" value="50"></label><output id="tint-preview-color"></output></div></div></div></div>`
  const blockPreview:TintBlockPreview=createTintBlockPreview(container.querySelector('#tint-block-preview')!,post,version)

  const form = container.querySelector<HTMLFormElement>('form')!, select = form.querySelector<HTMLSelectElement>('[name=preset]')!, get = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement
  for (const preset of TINT_PRESETS) select.append(new Option(preset.label, preset.id))
  function refresh(): void {
    const preset = TINT_PRESETS.find(entry => entry.id === select.value) ?? TINT_PRESETS[0], custom = preset.id === 'custom', gradient = get('mode').value === 'gradient'
    for (const field of container.querySelectorAll<HTMLElement>('[data-tint-custom]')) field.hidden = !custom
    for (const field of container.querySelectorAll<HTMLElement>('[data-tint-gradient], [data-tint-sample]')) field.hidden = !gradient
    container.querySelector<HTMLElement>('[data-tint-flat]')!.hidden=gradient
    container.querySelector('#tint-preset-note')!.textContent = preset.note
    const runtime = container.querySelector<HTMLElement>('#tint-preset-runtime')!, modded = preset.path.startsWith('optifine/')
    runtime.hidden = !modded; runtime.textContent = modded ? uiText("webview.tintPresets.optifineCustomColorsIsRequiredOrCompatible") : ''
    const blocks = container.querySelector('#tint-preset-blocks')!; blocks.replaceChildren()
    const ids = custom ? get('blocks').value.trim().split(/\s+/) : preset.blocks.map(id => 'minecraft:' + id)
    for (const id of ids.slice(0, 256)) { const code = document.createElement('code'); code.textContent = id; blocks.append(code) }
    const error = container.querySelector('#tint-preset-error')!, canvas = container.querySelector<HTMLCanvasElement>('#tint-preset-preview')!, ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height)
    try {
      const files = generateTintPreset({ ...Object.fromEntries(new FormData(form)), targetVersion: version() }), image = decodePixelImage(files.find(file => file.path.endsWith('.png'))!.content as Uint8Array)
      const source = document.createElement('canvas'); source.width = image.width; source.height = image.height; source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
      ctx.imageSmoothingEnabled = false; ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
      const sample=Number(container.querySelector<HTMLInputElement>('#tint-preview-sample')!.value)/100,temperature=Math.min(1,sample*2),downfall=Math.max(0,sample*2-1),x=image.height===1?Math.round(sample*(image.width-1)):Math.round((1-temperature)*(image.width-1)),y=image.height===1?0:Math.round((1-temperature*downfall)*(image.height-1)),offset=(y*image.width+x)*4,color='#'+Array.from(image.data.slice(offset,offset+3),value=>value.toString(16).padStart(2,'0')).join('')
      container.querySelector('#tint-preview-color')!.textContent=color
      const properties:Record<string,string>|undefined=preset.id==='redstone'?{power:String(Math.round(sample*15))}:preset.id==='pumpkinstem'||preset.id==='melonstem'?{age:String(Math.round(sample*7))}:undefined
      blockPreview.update({ids:ids.filter(id=>/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id)),color,allFaces:custom,properties})
      container.querySelector('#tint-preset-path')!.textContent = files.map(file => file.path).join(' ; '); error.textContent = ''
    } catch (cause) { blockPreview.update({ids:[],color:'#ffffff',allFaces:false}); error.textContent = ((cause instanceof Error ? cause.message : String(cause))); container.querySelector('#tint-preset-path')!.textContent = '' }
  }
  select.addEventListener('change', () => { const preset = TINT_PRESETS.find(entry => entry.id === select.value); if (preset) get('color').value = preset.color })
  container.addEventListener('input', refresh); container.addEventListener('change', refresh)
  document.querySelector('#target-version')?.addEventListener('change', refresh)
  requestAnimationFrame(refresh)
  return { refresh,activate:active=>blockPreview.activate(active),receive:message=>blockPreview.receive(message),dispose:()=>blockPreview.dispose() }
}
