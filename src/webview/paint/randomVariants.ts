import { uiText } from '../../i18n/messages'
import type { App } from './app'
import { el } from './dom'
import { activeLayer } from './state'
import { defaultVariantId, MAX_VARIANT_WEIGHT, type VariantEdit } from '../../core/randomVariants'

export function mountRandomVariants(parent: HTMLElement, app: App): () => void {
  const section = el('section', 'mp-variants'), head = el('div', 'mp-variants-head')
  const title = el('strong'); title.textContent = uiText("webview.advanced.randomBlocks")
  const count = el('span', 'mp-variant-summary'); head.append(title, count)
  const actions = el('div', 'mp-variant-actions')
  const add = button(uiText("webview.paint.randomVariants.addRandomPaste"))
  add.onclick = () => { if (app.hasPendingTransform?.()) { app.notify(uiText("webview.paint.randomVariants.pleaseApplyOrCancelTheLayerTransformation"), 'warn'); return }; app.host.post({ command: 'randomVariants', action: 'addImages' }) }
  const make = button(uiText("webview.paint.randomVariants.makeCandidates")), duplicate = button(uiText("webview.paint.randomVariants.copyAsVariable")), common = button(uiText("webview.paint.randomVariants.changeToCommonLayer"))
  actions.append(add, make, duplicate, common)
  const properties = el('div', 'mp-variant-properties')
  const label = el('label'); label.textContent = uiText("core.advanced.textures.weight")
  const weight = el('input', 'mcrh-input'); weight.type = 'number'; weight.min = '0'; weight.max = String(MAX_VARIANT_WEIGHT); weight.step = '1'; weight.setAttribute('aria-label', uiText("webview.paint.randomVariants.randomCandidateWeight")); label.append(weight)
  const probability = el('output'), base = button(uiText("webview.paint.randomVariants.setDefaultPng")); properties.append(label, probability, base)
  const note = el('p', 'mp-variant-note'); note.textContent = uiText("webview.paint.randomVariants.clickOnTheCandidateLayerToSwitch")
  const exportArea = el('div', 'mp-variant-export')
  const mode = el('select', 'mcrh-select'); mode.setAttribute('aria-label', uiText("webview.paint.randomVariants.randomBlockGeneration"))
  for (const [value, text] of [['vanilla', uiText("webview.paint.randomVariants.originalWeightedModel")], ['optifine', uiText("webview.paint.randomVariants.optifineCtmRandomTexture")]]) { const option = el('option'); option.value = value; option.textContent = text; mode.append(option) }
  const block = el('input', 'mcrh-input'); block.placeholder = 'minecraft:stone'; block.setAttribute('aria-label', uiText("webview.paint.randomVariants.randomBlockResourceId"))
  const symmetry = el('select', 'mcrh-select'); symmetry.setAttribute('aria-label', uiText("webview.paint.randomVariants.randomTextureSync"))
  for (const [value, text] of [['all', uiText("webview.paint.randomVariants.useTheSameVariantForTheWhole")], ['opposite', uiText("webview.paint.randomVariants.synchronizeOpposite")], ['none', uiText("webview.paint.randomVariants.allSidesStandAlone")]]) { const option = el('option'); option.value = value; option.textContent = text; symmetry.append(option) }
  const linkedLabel = el('label', 'mp-variant-linked'), linked = el('input'); linked.type = 'checkbox'; linkedLabel.append(linked, document.createTextNode(uiText("webview.paint.randomVariants.associationOfUpperAndLowerBlocksDoor")))
  const generate = button(uiText("webview.paint.randomVariants.generateRandomResourcePatches")); generate.classList.add('mp-variant-generate')
  const includeLabel = el('label', 'mp-variant-linked'), includeMcrh = el('input'); includeMcrh.type = 'checkbox'; includeLabel.append(includeMcrh, document.createTextNode(uiText("ui.exportPackCommand.includeMcrhEditData")))
  exportArea.append(mode, block, symmetry, linkedLabel, includeLabel, generate)
  section.append(head, actions, properties, note, exportArea); parent.append(section)
  function button(text: string): HTMLButtonElement { const result = el('button', 'mcrh-btn'); result.type = 'button'; result.textContent = text; return result }
  function edit(action: VariantEdit['action'], value?: number): void {
    if (app.hasPendingTransform?.()) { app.notify(uiText("webview.paint.randomVariants.pleaseApplyOrCancelTheLayerTransformation"), 'warn'); return }
    const layer = activeLayer(app.state)
    if (layer) app.host.post({ command: 'editRandomVariant', layerId: layer.id, action, weight: value })
  }
  make.onclick = () => edit('enable'); duplicate.onclick = () => edit('duplicate'); common.onclick = () => edit('disable'); base.onclick = () => edit('default')
  weight.onchange = () => {
    const value = Number(weight.value)
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VARIANT_WEIGHT) { app.notify(uiText("webview.paint.randomVariants.weightMustBeToMillionIntegers"), 'warn'); sync(); return }
    edit('weight', value)
  }
  mode.onchange = () => { symmetry.hidden = linkedLabel.hidden = mode.value !== 'optifine' }
  generate.onclick = () => {
    if (app.hasPendingTransform?.()) { app.notify(uiText("webview.paint.randomVariants.pleaseApplyOrCancelTheLayerTransformation"), 'warn'); return }
    app.host.post({ command: 'randomVariants', action: 'export', includeMcrh: includeMcrh.checked, mode: mode.value as 'vanilla' | 'optifine', block: block.value.trim(), symmetry: symmetry.value as 'all' | 'opposite' | 'none', linked: linked.checked })
  }
  function sync(): void {
    const layers = app.state.layers, candidates = layers.filter(layer => layer.randomVariant), layer = activeLayer(app.state)
    const total = candidates.reduce((sum, item) => sum + item.randomVariant!.weight, 0)
    const isVariant = !!layer?.randomVariant
    count.textContent = candidates.length ? candidates.length + uiText("webview.paint.randomVariants.candidates") : uiText("webview.paint.randomVariants.notSet")
    make.hidden = isVariant; make.disabled = !layer; duplicate.disabled = !layer; common.hidden = !isVariant; properties.hidden = !isVariant
    if (isVariant) {
      if (document.activeElement !== weight) weight.value = String(layer!.randomVariant!.weight)
      probability.textContent = total ? (layer!.randomVariant!.weight / total * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + '%' : uiText("webview.paint.randomVariants.disabled")
      base.disabled = defaultVariantId(layers) === layer!.id; base.textContent = base.disabled ? uiText("webview.paint.randomVariants.defaultPng") : uiText("webview.paint.randomVariants.setDefaultPng")
    }
    generate.disabled = candidates.filter(item => item.randomVariant!.weight > 0).length < 2
    generate.title = generate.disabled ? uiText("webview.paint.randomVariants.weNeedAtLeastTwoPowerBased") : uiText("webview.paint.randomVariants.generateZipPatchesLoadOrMergeBack")
    exportArea.hidden = candidates.length === 0
    symmetry.hidden = linkedLabel.hidden = mode.value !== 'optifine'
  }
  sync(); return sync
}
