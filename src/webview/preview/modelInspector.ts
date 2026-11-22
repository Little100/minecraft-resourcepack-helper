import { uiText } from '../../i18n/messages'
import { compactGeneratedModelText } from '../../core/generatedModelText'
import * as THREE from 'three'
import { GENERATED_BASE_FIELD, generatedBaseElementCount } from '../../core/generatedItemGeometry'
import { parseTree, type Node as JsonNode } from 'jsonc-parser'
import { loadModel } from 'block-model-renderer'
import type { PreparedAssets, ResolvedModel } from 'block-model-renderer'

interface SourceFile { bytes: Uint8Array; source: string }
interface InspectorOptions { scene: THREE.Scene; camera: THREE.Camera; canvas: HTMLCanvasElement; assets: PreparedAssets; targetId: string; fallback?: Record<string, unknown>; openModel?(path: string): void; applyFamily?(path: string): void; read(path: string): Promise<SourceFile | undefined>; redraw(): void }
interface Binding { mesh: THREE.Mesh; index: number; generated: boolean; faces: ReadonlySet<Face> }
interface Document { path: string; source: string; raw: Record<string, unknown>; bindings: Binding[]; effective: boolean; temporary?: boolean }
export interface ModelInspector { element: HTMLElement; warnings: readonly string[]; generatedTargets: readonly string[]; generatedCompactTargets: readonly string[]; dispose(): void }
const directions = ['east', 'west', 'up', 'down', 'south', 'north'] as const
type Face = typeof directions[number]
interface InspectionTarget { document: number; bindings: readonly Binding[]; element?: number; face?: Face }
interface InspectionContext { document: number; bindings: readonly Binding[] }
interface InspectorState { document: number; context: InspectionContext; selection?: InspectionTarget; preview?: { owner: EventTarget; target: InspectionTarget } }
interface UvTile { face: Face; element: HTMLButtonElement; canvas: HTMLCanvasElement; placeholder: HTMLElement; binding?: Binding; target?: InspectionTarget; unreadable?: boolean }
const uvSize = 192
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function assetPath(id: string): string | undefined {
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(id) || id.split(/[/:]/).some(part => part === '.' || part === '..')) return undefined
  const [ns, value] = id.includes(':') ? id.split(':') : ['minecraft', id]
  return 'assets/' + ns + '/models/' + value + (value!.endsWith('.json') ? '' : '.json')
}
function elementIndex(model: ResolvedModel, element: unknown): number {
  const direct = model.elements?.indexOf(element as Record<string, unknown>) ?? -1
  if (direct >= 0) return direct
  const key = JSON.stringify(element)
  return model.elements?.findIndex(value => JSON.stringify(value) === key) ?? -1
}
function activeFaces(mesh: THREE.Mesh): Face[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const faces = object(mesh.userData.element) && object(mesh.userData.element.faces) ? mesh.userData.element.faces : {}
  return directions.filter(face => faces[face] && mesh.geometry.groups.some(group => group.count > 0 && directions[(group.materialIndex ?? 0) % directions.length] === face && materials[group.materialIndex ?? 0] && materials[group.materialIndex ?? 0]!.visible !== false))
}
function textureOf(material: THREE.Material | undefined): THREE.Texture | undefined {
  if (!material) return undefined
  const value = material as THREE.Material & { map?: THREE.Texture; uniforms?: Record<string, { value: unknown }> }
  const texture = value.map ?? value.uniforms?.map?.value
  return texture instanceof THREE.Texture ? texture : undefined
}

// JSON 与渲染后的逐面索引关联，继承元素只映射到实际生效的父文件
export async function createModelInspector(options: InspectorOptions): Promise<ModelInspector> {
  const panel = document.createElement('section'); panel.className = 'vp-model-inspector'; panel.setAttribute('aria-label', uiText("webview.preview.modelInspector.associationModelJsonAndUv"))
  const familyButton = document.createElement('button'); familyButton.type = 'button'; familyButton.className = 'vp-button vp-inspector-family'; familyButton.textContent = uiText("webview.preview.modelInspector.batchMatchingApply"); familyButton.hidden = true
  const titlebar = document.createElement('div'), heading = document.createElement('h2'), openButton = document.createElement('button'), select = document.createElement('select'), provenance = document.createElement('p'), note = document.createElement('p')
  titlebar.className = 'vp-inspector-heading'; openButton.type = 'button'; openButton.className = 'vp-inspector-open'; openButton.textContent = uiText("webview.preview.modelInspector.openModelFile"); openButton.setAttribute('aria-label', uiText("webview.preview.modelInspector.openAssociationModelJson")); openButton.hidden = true; titlebar.append(heading, openButton, familyButton)
  heading.textContent = uiText("webview.preview.modelInspector.associationModelJson"); heading.className = 'vp-inspector-title'; select.className = 'vp-select'; select.setAttribute('aria-label', uiText("webview.preview.modelInspector.modelsAndParentModelsJson"))
  provenance.className = 'vp-inspector-source'; note.className = 'vp-inspector-note vp-muted'
  note.textContent = uiText("webview.preview.modelInspector.sixSidedUvPermanentClickingOnExisting")
  const body = document.createElement('div'), code = document.createElement('pre'), uv = document.createElement('div')
  body.className = 'vp-inspector-body'; code.className = 'vp-model-code'; uv.className = 'vp-inspector-uv'; uv.setAttribute('role', 'group'); uv.setAttribute('aria-label', uiText("webview.preview.modelInspector.elementSixFiveUv"))
  body.append(code, uv); panel.append(titlebar, select, provenance, note, body)
  const docs: Document[] = [], ghostGroups: THREE.Group[] = [], hiddenMaterials: THREE.Material[] = [], allBindings: Binding[] = []
  const geometryWarnings = new Set<string>(), generatedTargets = new Set<string>(), generatedCompactTargets = new Set<string>()
  const roots: THREE.Object3D[] = []
  options.scene.traverse(value => { if (value.userData.model && object(value.userData.model)) roots.push(value) })
  const documents = new Map<string, { raw: Record<string, unknown>; source: string; text: string } | undefined>()
  const read = async (path: string): Promise<{ raw: Record<string, unknown>; source: string; text: string } | undefined> => {
    if (documents.has(path)) return documents.get(path)
    const file = await options.read(path)
    if (!file || file.bytes.length > 4 * 1024 * 1024) { documents.set(path, undefined); return undefined }
    let raw: unknown, text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); raw = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { documents.set(path, undefined); return undefined }
    const result = object(raw) ? { raw, source: file.source, text } : undefined
    documents.set(path, result); return result
  }
  const disposeGhosts = (): void => {
    for (const ghost of ghostGroups.splice(0)) { ghost.removeFromParent(); ghost.traverse(child => { if (child instanceof THREE.Mesh) child.geometry.dispose() }) }
    for (const material of hiddenMaterials.splice(0)) material.dispose()
  }
  try {
  for (const root of roots.slice(0, 64)) {
    const model = root.userData.model as ResolvedModel
    const meshes: THREE.Mesh[] = []
    root.traverse(child => { if (child instanceof THREE.Mesh && child.userData.element) meshes.push(child) })
    if (!meshes.length && model.elements?.length && root.parent) {
      const ghost = await loadModel(null, options.assets, model, { display: {}, lighting: 'item', animate: false, mergeElements: false })
      ghost.position.copy(root.position); ghost.quaternion.copy(root.quaternion); ghost.scale.copy(root.scale)
      root.parent.add(ghost); ghostGroups.push(ghost)
      ghost.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return
        child.userData.__mcrhActiveFaces = activeFaces(child)
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        const clones = materials.map(material => { const copy = material.clone(); copy.visible = false; hiddenMaterials.push(copy); return copy })
        child.material = Array.isArray(child.material) ? clones : clones[0]!
        if (child.userData.element) meshes.push(child)
      })
    }
    const bindings = meshes.map(mesh => ({ mesh, index: elementIndex(model, mesh.userData.element), generated: Boolean(model.generated), faces: new Set<Face>(mesh.userData.__mcrhActiveFaces ?? activeFaces(mesh)) }))
    allBindings.push(...bindings)
    const source = model.__mcrhSource
    const ref = typeof source === 'string' ? source : typeof model.model === 'string' ? model.model : object(model.model) && typeof model.model.parent === 'string' ? model.model.parent : options.targetId
    const rootPath = assetPath(ref)
    let path = rootPath, effectivePath: string | undefined, elementsPath: string | undefined, generatedParent = false, basePresent = false
    const chain = new Set<string>()
    if (options.fallback) {
      const fallbackPath = uiText("webview.preview.modelInspector.temporaryPreviewModel", options.targetId)
      docs.push({ path: fallbackPath, source: uiText("webview.preview.modelInspector.lackOfOriginalBaseResourcesForAd"), raw: options.fallback, bindings, effective: true, temporary: true })
      continue
    }
    for (let depth = 0; path && depth < 64 && !chain.has(path); depth++) {
      chain.add(path)
      const file = await read(path)
      if (!file) break
      if (!elementsPath && Array.isArray(file.raw.elements)) { elementsPath = path; basePresent ||= Object.prototype.hasOwnProperty.call(file.raw, GENERATED_BASE_FIELD) }
      if (path === rootPath && Object.prototype.hasOwnProperty.call(file.raw, GENERATED_BASE_FIELD)) {
        basePresent = true
        const marker = file.raw[GENERATED_BASE_FIELD]
        if (object(marker) && (marker.version === 1 && marker.storage === 'reference' || generatedBaseElementCount(file.raw) && compactGeneratedModelText(file.text) !== file.text)) generatedCompactTargets.add(path)
      }
      if (!effectivePath && (Array.isArray(file.raw.elements) || model.generated && object(file.raw.textures))) effectivePath = path
      const previous = docs.find(value => value.path === path)
      const effective = path === effectivePath
      if (previous) { if (effective) { previous.bindings.push(...bindings); previous.effective = true } }
      else docs.push({ path, ...file, bindings: effective ? [...bindings] : [], effective })
      const parent: unknown = file.raw.parent
      if (typeof parent !== 'string') break
      if (/^(?:minecraft:)?builtin\//.test(parent)) { generatedParent = /^(?:minecraft:)?builtin\/generated$/.test(parent); break }
      path = assetPath(parent)
    }
    if (elementsPath && generatedParent && !basePresent) {
      if (rootPath) generatedTargets.add(rootPath)
      geometryWarnings.add(elementsPath + uiText("webview.preview.modelInspector.modelsAlsoInheritedAndDefinedElementesGames"))
    }
  }
  } catch (error) { disposeGhosts(); throw error }
  const defaultContext = (documentIndex: number): InspectionContext => {
    const bindings = docs[documentIndex]?.bindings ?? (docs.length ? [] : allBindings), first = bindings[0]
    return { document: documentIndex, bindings: first ? bindings.filter(binding => first.generated ? binding.generated : binding.index === first.index) : [] }
  }
  const effectiveDocument = docs.findIndex(doc => doc.effective && doc.bindings.length), initialDocument = effectiveDocument < 0 ? (docs.length ? 0 : -1) : effectiveDocument
  const state: InspectorState = { document: initialDocument, context: defaultContext(initialDocument) }
  let disposed = false, applied = false, appliedTarget: InspectionTarget | undefined
  const overlays: THREE.Mesh[] = [], cleanups: Array<() => void> = [], documentCleanups: Array<() => void> = []
  const lineEntries: Array<{ element: HTMLElement; target: InspectionTarget; generated?: boolean }> = []
  const overlayMaterial = new THREE.MeshBasicMaterial({ color: 0x70d6ff, transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
  const disposeOverlays = (): void => {
    for (const overlay of overlays.splice(0)) { overlay.removeFromParent(); overlay.geometry.dispose() }
  }
  const sameTarget = (left: InspectionTarget | undefined, right: InspectionTarget | undefined): boolean => left === right || Boolean(left && right && left.document === right.document && left.element === right.element && left.face === right.face && left.bindings.length === right.bindings.length && left.bindings.every((binding, index) => binding === right.bindings[index]))
  const targetFor = (documentIndex: number, element?: number, face?: Face, source: readonly Binding[] = docs[documentIndex]?.bindings ?? []): InspectionTarget | undefined => {
    const bindings = source.filter(binding => binding.faces.size && (element === undefined || binding.index === element) && (!face || binding.faces.has(face)))
    return bindings.length ? { document: documentIndex, bindings, element, face } : undefined
  }
  const contextFor = (target: InspectionTarget): InspectionContext => {
    const bindings = docs[target.document]?.bindings ?? target.bindings, first = target.bindings[0]!
    return { document: target.document, bindings: bindings.filter(binding => first.generated ? binding.generated : binding.index === first.index) }
  }
  const drawUv = (tile: UvTile, binding: Binding | undefined): void => {
    tile.binding = binding; tile.unreadable = false
    tile.canvas.hidden = !binding; tile.placeholder.hidden = Boolean(binding)
    const ctx = tile.canvas.getContext('2d')!
    ctx.clearRect(0, 0, uvSize, uvSize); ctx.imageSmoothingEnabled = false
    if (!binding) return
    const mesh = binding.mesh, faceIndex = directions.indexOf(tile.face), groups = mesh.geometry.groups.filter(group => (group.materialIndex ?? 0) % directions.length === faceIndex)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material], texture = textureOf(materials[groups[0]?.materialIndex ?? 0]), image = texture?.image
    try {
      if (image && object(image) && image.data instanceof Uint8Array && typeof image.width === 'number' && typeof image.height === 'number') {
        const staging = document.createElement('canvas'); staging.width = image.width; staging.height = image.height
        staging.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
        ctx.drawImage(staging, 0, 0, uvSize, uvSize)
      } else if (image) ctx.drawImage(image as CanvasImageSource, 0, 0, uvSize, uvSize)
    } catch { tile.unreadable = true }
    const coords = mesh.geometry.getAttribute('uv'), index = mesh.geometry.index
    if (!coords) return
    ctx.fillStyle = 'rgba(112,214,255,.35)'; ctx.strokeStyle = '#70d6ff'; ctx.lineWidth = 2
    for (const group of groups.slice(0, 1)) {
      const points = new Map<string, [number, number]>()
      for (let offset = group.start; offset < group.start + group.count; offset++) {
        const vertex = index ? index.getX(offset) : offset, u = coords.getX(vertex), v = coords.getY(vertex)
        points.set(u + ':' + v, [u * uvSize, (1 - v) * uvSize])
      }
      const vertices = [...points.values()]
      if (!vertices.length) continue
      const center = vertices.reduce((sum, point) => [sum[0]! + point[0], sum[1]! + point[1]], [0, 0]).map(value => value / vertices.length)
      vertices.sort((a, b) => Math.atan2(a[1] - center[1]!, a[0] - center[0]!) - Math.atan2(b[1] - center[1]!, b[0] - center[0]!))
      ctx.beginPath(); vertices.forEach((point, index) => index ? ctx.lineTo(...point) : ctx.moveTo(...point)); ctx.closePath(); ctx.fill(); ctx.stroke()
    }
  }
  // 固定选择与临时预览独立，六面节点只初始化一次
  const tiles: UvTile[] = directions.map(face => {
    const element = document.createElement('button'), preview = document.createElement('span'), canvas = document.createElement('canvas'), placeholder = document.createElement('span'), caption = document.createElement('span')
    element.type = 'button'; element.className = 'vp-uv-tile'; element.dataset.face = face; element.disabled = true
    element.setAttribute('aria-label', face + uiText("webview.preview.modelInspector.pastaUv")); element.setAttribute('aria-pressed', 'false'); element.setAttribute('aria-disabled', 'true')
    preview.className = 'vp-uv-preview'; canvas.width = canvas.height = uvSize; canvas.hidden = true; canvas.setAttribute('aria-hidden', 'true')
    placeholder.className = 'vp-uv-placeholder'; placeholder.textContent = uiText("webview.preview.modelInspector.none"); caption.className = 'vp-uv-caption'; caption.textContent = face
    preview.append(canvas, placeholder); element.append(preview, caption); uv.append(element)
    return { face, element, canvas, placeholder }
  })
  const updateUv = (target: InspectionTarget | undefined): void => {
    for (const tile of tiles) {
      const bindings = state.context.bindings.filter(binding => binding.faces.has(tile.face))
      const binding = target?.bindings.find(binding => bindings.includes(binding)) ?? bindings[0]
      if (tile.binding !== binding) drawUv(tile, binding)
      tile.target = targetFor(state.context.document, binding?.generated ? undefined : binding?.index, tile.face, bindings)
      const matches = (value: InspectionTarget | undefined): boolean => Boolean(value && value.document === state.context.document && (!value.face || value.face === tile.face) && value.bindings.some(binding => bindings.includes(binding)))
      const selected = matches(state.selection), active = matches(target)
      tile.element.disabled = !tile.target; tile.element.dataset.available = String(Boolean(tile.target))
      tile.element.setAttribute('aria-disabled', String(!tile.target)); tile.element.setAttribute('aria-pressed', String(selected))
      tile.element.classList.toggle('is-empty', !tile.target); tile.element.classList.toggle('is-active', active); tile.element.classList.toggle('is-selected', selected)
      tile.element.title = tile.face + (binding ? uiText("webview.preview.modelInspector.clickOnFixedSelectionQualifier", (tile.unreadable ? uiText("webview.preview.modelInspector.textureImageNotReadable") : '')) : uiText("webview.preview.modelInspector.thisElementIsNotHereQualifier"))
    }
  }
  const setPreview = (owner: EventTarget, target: InspectionTarget | undefined, reveal: boolean): void => {
    if (disposed || !target) return
    state.preview = { owner, target }; applyState(reveal)
  }
  const releasePreview = (owner: EventTarget, reveal: boolean): void => {
    if (disposed || state.preview?.owner !== owner) return
    state.preview = undefined; applyState(reveal)
  }
  const selectTarget = (owner: EventTarget, target: InspectionTarget | undefined, reveal: boolean): void => {
    if (disposed || !target) return
    state.selection = target; state.preview = { owner, target }; applyState(reveal)
  }
  const bindInspection = (element: HTMLElement, getTarget: () => InspectionTarget | undefined, reveal = false): (() => void) => {
    const show = (): void => setPreview(element, getTarget(), reveal)
    const leave = (): void => releasePreview(element, reveal)
    const select = (): void => selectTarget(element, getTarget(), reveal)
    const key = (event: KeyboardEvent): void => {
      if (element instanceof HTMLButtonElement || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault(); select()
    }
    element.addEventListener('pointerenter', show); element.addEventListener('focus', show); element.addEventListener('click', select)
    element.addEventListener('pointerleave', leave); element.addEventListener('blur', leave); element.addEventListener('keydown', key)
    return () => {
      element.removeEventListener('pointerenter', show); element.removeEventListener('focus', show); element.removeEventListener('click', select)
      element.removeEventListener('pointerleave', leave); element.removeEventListener('blur', leave); element.removeEventListener('keydown', key)
    }
  }
  const renderDocument = (): void => {
    for (const cleanup of documentCleanups.splice(0)) cleanup()
    lineEntries.length = 0; code.replaceChildren()
    const doc = docs[state.document]
    familyButton.hidden = !options.applyFamily || !doc || Boolean(doc.temporary)
    select.value = String(state.document); openButton.hidden = !options.openModel || !doc || Boolean(doc.temporary)
    note.textContent = uiText("webview.preview.modelInspector.sixSidedUvPermanentClickingOnExisting")
    if (!doc) { provenance.textContent = uiText("webview.preview.modelInspector.thereIsNoReadableModelInThe"); return }
    const defaultUv = Array.isArray(doc.raw.elements) && doc.raw.elements.some(element => object(element) && object(element.faces) && Object.values(element.faces).some(face => object(face) && typeof face.texture === 'string' && face.uv === undefined))
    if (defaultUv) note.textContent += uiText("webview.preview.modelInspector.theUnfilledUvFaceByElementFrom")
    provenance.textContent = doc.source + ' · ' + doc.path
    const text = JSON.stringify(doc.raw, null, 2), tree = parseTree(text), lines = text.split('\n'), offsets: number[] = []
    let offset = 0; for (const line of lines) { offsets.push(offset); offset += line.length + 1 }
    const spans: Array<{ start: number; end: number; element: number; face?: Face }> = []
    const property = (entry: JsonNode | undefined, key: string): JsonNode | undefined => entry?.children?.find(child => child.children?.[0]?.value === key)?.children?.[1]
    for (const [element, entry] of (property(tree, 'elements')?.children ?? []).entries()) {
      spans.push({ start: entry.offset, end: entry.offset + entry.length, element })
      for (const faceEntry of (property(entry, 'faces')?.children ?? [])) {
        const face = directions.find(face => face === faceEntry.children?.[0]?.value)
        if (face) spans.push({ start: faceEntry.offset, end: faceEntry.offset + faceEntry.length, element, face })
      }
    }
    if (doc.bindings.some(binding => binding.generated)) {
      const control = document.createElement('button'), target = targetFor(state.document, undefined, undefined, doc.bindings.filter(binding => binding.generated))
      control.type = 'button'; control.className = 'vp-generated-highlight'; control.textContent = uiText("webview.preview.modelInspector.viewAutoGeneratedPixelSidesAndThickness"); control.disabled = !target
      if (target) { lineEntries.push({ element: control, target, generated: true }); documentCleanups.push(bindInspection(control, () => target)) }
      code.append(control)
    }
    const targets = new Map<string, InspectionTarget | undefined>()
    for (let lineIndex = 0; lineIndex < Math.min(lines.length, 5000); lineIndex++) {
      const line = document.createElement('span'), start = offsets[lineIndex]!, end = start + lines[lineIndex]!.length
      line.className = 'vp-json-line'; line.textContent = lines[lineIndex] || ' '; line.dataset.line = String(lineIndex + 1)
      const span = spans.filter(value => value.start <= end && value.end >= start).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      if (span && doc.effective) {
        line.dataset.element = String(span.element); if (span.face) line.dataset.face = span.face
        line.setAttribute('aria-label', uiText("webview.preview.modelInspector.elements", span.element, (span.face ? ' · ' + span.face : '')))
        const key = span.element + ':' + (span.face ?? '')
        if (!targets.has(key)) targets.set(key, targetFor(state.document, span.element, span.face))
        const target = targets.get(key)
        line.dataset.inspectable = String(Boolean(target))
        if (target) {
          line.tabIndex = 0; line.setAttribute('role', 'button'); lineEntries.push({ element: line, target })
          documentCleanups.push(bindInspection(line, () => target))
        } else line.setAttribute('aria-disabled', 'true')
      }
      code.append(line)
    }
    if (lines.length > 5000) code.append(uiText("webview.preview.modelInspector.jsonExceededTheDisplayedBudgetByShowing"))
  }
  const syncJson = (target: InspectionTarget | undefined, className: string): void => {
    const matches = target ? lineEntries.filter(entry => entry.target.document === target.document && entry.target.bindings.some(binding => target.bindings.includes(binding))) : []
    let active = matches.filter(entry => entry.generated || !target?.face || entry.target.face === target.face)
    if (!active.length && target?.face) active = matches.filter(entry => !entry.target.face)
    const elements = new Set(active.map(entry => entry.element))
    for (const entry of lineEntries) {
      const active = elements.has(entry.element)
      entry.element.classList.toggle(className, active)
      if (className === 'is-selected') entry.element.setAttribute('aria-pressed', String(active))
    }
  }
  const revealJson = (): void => {
    const line = code.querySelector<HTMLElement>('.is-active')
    if (!line) return
    const lineRect = line.getBoundingClientRect(), codeRect = code.getBoundingClientRect()
    if (lineRect.top < codeRect.top) code.scrollTop += lineRect.top - codeRect.top
    else if (lineRect.bottom > codeRect.bottom) code.scrollTop += lineRect.bottom - codeRect.bottom
  }
  function applyState(reveal = false): void {
    if (disposed) return
    const target = state.preview?.target ?? state.selection, changed = !applied || !sameTarget(target, appliedTarget)
    const documentChanged = Boolean(target && state.document !== target.document)
    if (target && documentChanged) { state.document = target.document; renderDocument() }
    if (target && (changed || documentChanged)) state.context = contextFor(target)
    else if (state.context.document !== state.document) state.context = defaultContext(state.document)
    updateUv(target); syncJson(target, 'is-active'); syncJson(state.selection, 'is-selected')
    panel.dataset.activeFace = target?.face ?? ''; panel.dataset.activeElement = target?.element === undefined ? '' : String(target.element)
    panel.dataset.selectedFace = state.selection?.face ?? ''; panel.dataset.selectedElement = state.selection?.element === undefined ? '' : String(state.selection.element)
    if (reveal) revealJson()
    if (!changed && !documentChanged) return
    disposeOverlays()
    for (const binding of target?.bindings.slice(0, 2048) ?? []) {
      const original = binding.mesh.geometry, index = original.index, indices: number[] = []
      for (const group of original.groups) {
        const face = directions[(group.materialIndex ?? 0) % directions.length]
        if (!face || !binding.faces.has(face) || target?.face && target.face !== face) continue
        for (let offset = group.start; offset < group.start + group.count; offset++) indices.push(index ? index.getX(offset) : offset)
      }
      if (!indices.length) continue
      const geometry = original.clone(); geometry.clearGroups(); geometry.setIndex(indices)
      const overlay = new THREE.Mesh(geometry, overlayMaterial); overlay.renderOrder = 1000; overlay.userData.inspectorOverlay = true
      binding.mesh.add(overlay); overlays.push(overlay)
    }
    panel.dataset.highlighted = String(overlays.length > 0); panel.dataset.highlightCount = String(overlays.length)
    applied = true; appliedTarget = target; options.redraw()
  }
  for (const tile of tiles) cleanups.push(bindInspection(tile.element, () => tile.target, true))
  docs.forEach((doc, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = doc.path + ' (' + doc.source + ')'; select.append(option) })
  select.hidden = docs.length < 2
  const changeDocument = (): void => {
    state.document = Number(select.value); state.selection = undefined; state.preview = undefined; state.context = defaultContext(state.document)
    renderDocument(); applied = false; applyState()
  }
  select.addEventListener('change', changeDocument); cleanups.push(() => select.removeEventListener('change', changeDocument))
  const openDocument = (): void => { const doc = docs[state.document]; if (!disposed && doc && !doc.temporary) options.openModel?.(doc.path) }
  const applyDocument = (): void => { const doc = docs[state.document]; if (!disposed && doc && !doc.temporary) options.applyFamily?.(doc.path) }
  familyButton.addEventListener('click', applyDocument); cleanups.push(() => familyButton.removeEventListener('click', applyDocument))
  openButton.addEventListener('click', openDocument); cleanups.push(() => openButton.removeEventListener('click', openDocument))
  const raycaster = new THREE.Raycaster(), cursor = new THREE.Vector2(), bindingsByMesh = new Map(allBindings.map(binding => [binding.mesh, binding])), documentsByBinding = new Map<Binding, number>()
  docs.forEach((doc, index) => doc.bindings.forEach(binding => documentsByBinding.set(binding, index)))
  const pickTarget = (event: MouseEvent): InspectionTarget | undefined => {
    const rect = options.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return undefined
    cursor.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    options.scene.updateMatrixWorld(true); raycaster.setFromCamera(cursor, options.camera)
    const hit = raycaster.intersectObjects([...bindingsByMesh.keys()], false).find(hit => {
      const binding = bindingsByMesh.get(hit.object as THREE.Mesh), face = hit.face && directions[hit.face.materialIndex % directions.length]
      return face && binding?.faces.has(face)
    })
    const binding = hit && bindingsByMesh.get(hit.object as THREE.Mesh), face = hit?.face && directions[hit.face.materialIndex % directions.length]
    return binding && face ? targetFor(documentsByBinding.get(binding) ?? -1, binding.index, face, [binding]) : undefined
  }
  let press: { x: number; y: number; dragged: boolean } | undefined
  const down = (event: PointerEvent): void => { if (event.button === 0) { press = { x: event.clientX, y: event.clientY, dragged: false }; releasePreview(options.canvas, false) } }
  const pick = (event: PointerEvent): void => {
    if (disposed) return
    if (event.buttons) { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) press.dragged = true; return }
    const target = pickTarget(event)
    if (target) setPreview(options.canvas, target, true)
    else releasePreview(options.canvas, true)
  }
  const click = (event: MouseEvent): void => {
    const dragged = press && (press.dragged || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4)
    press = undefined
    if (!disposed && event.button === 0 && !dragged) selectTarget(options.canvas, pickTarget(event), true)
  }
  const leave = (): void => { if (press) press.dragged = true; releasePreview(options.canvas, true) }
  const cancel = (): void => { press = undefined; releasePreview(options.canvas, true) }
  options.canvas.addEventListener('pointerdown', down); options.canvas.addEventListener('pointermove', pick); options.canvas.addEventListener('click', click)
  options.canvas.addEventListener('pointerleave', leave); options.canvas.addEventListener('pointercancel', cancel)
  cleanups.push(() => {
    options.canvas.removeEventListener('pointerdown', down); options.canvas.removeEventListener('pointermove', pick); options.canvas.removeEventListener('click', click)
    options.canvas.removeEventListener('pointerleave', leave); options.canvas.removeEventListener('pointercancel', cancel)
  })
  renderDocument(); applyState()
  return { element: panel, warnings: [...geometryWarnings], generatedTargets: [...generatedTargets], generatedCompactTargets: [...generatedCompactTargets], dispose(): void {
    if (disposed) return
    disposed = true
    for (const cleanup of [...documentCleanups.splice(0), ...cleanups.splice(0)]) cleanup()
    disposeOverlays(); disposeGhosts(); overlayMaterial.dispose(); panel.remove()
    state.selection = undefined; state.preview = undefined; state.context = { document: -1, bindings: [] }; appliedTarget = undefined
    lineEntries.length = 0; bindingsByMesh.clear(); documentsByBinding.clear()
    for (const tile of tiles) { tile.target = undefined; tile.binding = undefined; tile.canvas.width = tile.canvas.height = 0 }
    options.redraw()
  } }
}
