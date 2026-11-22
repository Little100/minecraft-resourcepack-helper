import { uiText } from '../../i18n/messages'
import { TOOLS, type ToolId } from '../tools'

export type BindingActionId = `tool:${ToolId}`
  | 'selectAll' | 'invertSelection' | 'clearSelection' | 'removeSelection' | 'cancelPending' | 'applyPending'
  | 'brushSmaller' | 'brushLarger' | 'zoomIn' | 'zoomOut' | 'fitWindow'
  | 'toggleGrid' | 'togglePanels' | 'swapColors' | 'resetColors'

export type BindingPlatform = 'windows' | 'mac' | 'linux'
export type PaintBindings = Record<BindingActionId, string>

export interface BindingAction {
  id: BindingActionId
  label: string
  group: 'tools' | 'selection' | 'canvas' | 'colors'
  defaultBinding: string
  repeatable: boolean
}

// 事件只保留数据字段，也接受持久化捕获数据中的简短修饰键名称
export interface KeyboardBindingEvent {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
  repeat?: boolean
  isComposing?: boolean
}

export type BindingIssueCode = 'invalid-data' | 'unknown-action' | 'invalid-binding' | 'reserved-binding' | 'conflict'

export interface BindingIssue {
  code: BindingIssueCode
  actionId?: string
  binding?: string
  fallback?: string
  conflictsWith?: BindingActionId[]
  message: string
}

export interface BindingValidationResult {
  bindings: PaintBindings
  issues: BindingIssue[]
  valid: boolean
}

type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift'

const MAX_BINDING_LENGTH = 128
const MODIFIER_ORDER: readonly Modifier[] = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  mod: 'Mod', '$mod': 'Mod', ctrl: 'Ctrl', control: 'Ctrl',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift'
}
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', tab: 'Tab',
  space: 'Space', spacebar: 'Space', left: 'ArrowLeft', arrowleft: 'ArrowLeft',
  right: 'ArrowRight', arrowright: 'ArrowRight', up: 'ArrowUp', arrowup: 'ArrowUp',
  down: 'ArrowDown', arrowdown: 'ArrowDown', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  capslock: 'CapsLock', numlock: 'NumLock', scrolllock: 'ScrollLock',
  pause: 'Pause', printscreen: 'PrintScreen', contextmenu: 'ContextMenu',
  altleft: 'AltLeft', altright: 'AltRight', equal: '=', plus: '+', minus: '-',
  bracketleft: '[', bracketright: ']', backslash: '\\', semicolon: ';',
  quote: "'", backquote: '`', comma: ',', period: '.', slash: '/',
  numpadadd: 'NumpadAdd', numpadsubtract: 'NumpadSubtract', numpadmultiply: 'NumpadMultiply',
  numpaddivide: 'NumpadDivide', numpaddecimal: 'NumpadDecimal', numpadequal: 'NumpadEqual',
  numpadenter: 'Enter'
}
const SHIFTED_KEYS: Readonly<Record<string, string>> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/'
}
const HOST_PRIMARY_KEYS: ReadonlySet<string> = new Set(['Z', 'Y', 'S', 'F', 'G', 'H', 'W', 'Q', 'P'])
const MODIFIER_EVENT_KEYS = /^(?:Control|Ctrl|Meta|OS|Command|Alt|AltGraph|Shift)(?:Left|Right)?$/i
const NON_KEY_EVENTS = /^(?:Dead|Process|Unidentified)$/i

const ACTIONS: readonly BindingAction[] = [
  { id: 'selectAll', label: uiText("webview.paint.bindings.allCanvassSelected"), group: 'selection', defaultBinding: 'Mod+A', repeatable: false },
  { id: 'invertSelection', label: uiText("webview.paint.bindings.invert"), group: 'selection', defaultBinding: 'Mod+Shift+I', repeatable: false },
  { id: 'clearSelection', label: uiText("ui.tutorialCards.cancelSelection"), group: 'selection', defaultBinding: 'Mod+D', repeatable: false },
  { id: 'removeSelection', label: uiText("webview.paint.bindings.removeSelectionPixels"), group: 'selection', defaultBinding: 'Delete', repeatable: false },
  { id: 'cancelPending', label: uiText("webview.paint.bindings.undoToApply"), group: 'selection', defaultBinding: 'Escape', repeatable: false },
  { id: 'applyPending', label: uiText("webview.paint.bindings.applyPendingOperations"), group: 'selection', defaultBinding: 'Enter', repeatable: false },
  { id: 'brushSmaller', label: uiText("webview.paint.bindings.decreaseBrush"), group: 'canvas', defaultBinding: '[', repeatable: true },
  { id: 'brushLarger', label: uiText("webview.paint.bindings.increaseBrushes"), group: 'canvas', defaultBinding: ']', repeatable: true },
  { id: 'zoomIn', label: uiText("ui.tutorialCards.zoomIn"), group: 'canvas', defaultBinding: 'Mod+=', repeatable: true },
  { id: 'zoomOut', label: uiText("ui.tutorialCards.zoomOut"), group: 'canvas', defaultBinding: 'Mod+-', repeatable: true },
  { id: 'fitWindow', label: uiText("ui.tutorialCards.fitToWindow"), group: 'canvas', defaultBinding: 'Mod+0', repeatable: false },
  { id: 'toggleGrid', label: uiText("webview.paint.bindings.switchGrid"), group: 'canvas', defaultBinding: "Mod+'", repeatable: false },
  { id: 'togglePanels', label: uiText("webview.paint.bindings.toggleSidebar"), group: 'canvas', defaultBinding: 'Shift+T', repeatable: false },
  { id: 'swapColors', label: uiText("webview.paint.bindings.exchangeForegroundAndBackgroundColours"), group: 'colors', defaultBinding: 'X', repeatable: false },
  { id: 'resetColors', label: uiText("webview.paint.bindings.resetForegroundAndBackgroundColour"), group: 'colors', defaultBinding: 'D', repeatable: false }
]

export function listBindingActions(): readonly BindingAction[] {
  return [
    ...TOOLS.map(tool => ({
      id: `tool:${tool.id}` as BindingActionId,
      label: tool.label,
      group: 'tools' as const,
      defaultBinding: normalizeBinding(tool.key) ?? '',
      repeatable: false
    })),
    ...ACTIONS.map(action => ({ ...action }))
  ]
}

export function defaultBindings(): PaintBindings {
  return Object.fromEntries(listBindingActions().map(action => [action.id, action.defaultBinding])) as PaintBindings
}

function normalizedKey(input: string): { key: string; shift: boolean } | undefined {
  const lower = input.toLowerCase()
  const alias = Object.hasOwn(KEY_ALIASES, lower) ? KEY_ALIASES[lower] : input
  const shifted = Object.hasOwn(SHIFTED_KEYS, alias) ? SHIFTED_KEYS[alias] : undefined
  if (shifted !== undefined) return { key: shifted, shift: true }
  if (Object.hasOwn(KEY_ALIASES, lower)) return { key: alias, shift: false }
  if (/^Key[A-Z]$/i.test(input)) return { key: input.slice(3).toUpperCase(), shift: false }
  if (/^Digit\d$/i.test(input)) return { key: input.slice(5), shift: false }
  if (/^Numpad\d$/i.test(input)) return { key: `Numpad${input.slice(-1)}`, shift: false }
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(input)) return { key: input.toUpperCase(), shift: false }
  if (input.length === 1 && input.charCodeAt(0) >= 33 && input.charCodeAt(0) <= 126) {
    return { key: input.toUpperCase(), shift: false }
  }
  return undefined
}

function comboFor(key: string, modifiers: ReadonlySet<Modifier>): string {
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join('+')
}

// 存储格式固定修饰键顺序，空字符串表示显式禁用
export function normalizeBinding(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > MAX_BINDING_LENGTH || /[\u0000-\u001f\u007f]/.test(input)) return undefined
  const value = input.trim()
  if (!value) return ''
  const parts = value.split(/\s*\+\s*/)
  if (parts.length >= 2 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '+')
  const keyInput = parts.pop()
  if (!keyInput) return undefined
  const key = normalizedKey(keyInput)
  if (!key) return undefined
  const modifiers = new Set<Modifier>()
  for (const part of parts) {
    const lower = part.toLowerCase()
    const modifier = Object.hasOwn(MODIFIER_ALIASES, lower) ? MODIFIER_ALIASES[lower] : undefined
    if (!modifier || modifiers.has(modifier)) return undefined
    modifiers.add(modifier)
  }
  if (modifiers.has('Mod') && (modifiers.has('Ctrl') || modifiers.has('Meta'))) return undefined
  if (key.shift) modifiers.add('Shift')
  return comboFor(key.key, modifiers)
}

export function isReservedBinding(input: unknown): boolean {
  if (typeof input === 'string' && /^alt(?:left|right)?$/i.test(input.trim())) return true
  const combo = normalizeBinding(input)
  if (!combo) return false
  const parts = combo.split('+')
  const key = parts.pop()!
  if (key === 'Tab' && parts.every(part => part === 'Shift')) return true
  if (key === 'Space' || key === 'AltLeft' || key === 'AltRight' || key === 'F3') return true
  const primary = parts.some(part => part === 'Mod' || part === 'Ctrl' || part === 'Meta')
  return (primary && HOST_PRIMARY_KEYS.has(key)) || (key === 'F4' && (primary || parts.includes('Alt')))
}

function resolveMod(combo: string, platform: BindingPlatform): string {
  return combo.replace(/^Mod\+/, platform === 'mac' ? 'Meta+' : 'Ctrl+')
}

function bindingsOverlap(left: string, right: string): boolean {
  return ['windows', 'mac'].some(platform =>
    resolveMod(left, platform as BindingPlatform) === resolveMod(right, platform as BindingPlatform))
}

function conflictsOf(bindings: PaintBindings, actions: readonly BindingAction[]): Map<BindingActionId, Set<BindingActionId>> {
  const conflicts = new Map<BindingActionId, Set<BindingActionId>>()
  for (const [index, left] of actions.entries()) {
    if (!bindings[left.id]) continue
    for (const right of actions.slice(index + 1)) {
      if (!bindings[right.id] || !bindingsOverlap(bindings[left.id], bindings[right.id])) continue
      for (const [id, other] of [[left.id, right.id], [right.id, left.id]] as const) {
        if (!conflicts.has(id)) conflicts.set(id, new Set())
        conflicts.get(id)!.add(other)
      }
    }
  }
  return conflicts
}

// 校验始终返回完整可用的映射，不修改调用方保存的数据
export function validateBindings(input: unknown): BindingValidationResult {
  const actions = listBindingActions()
  const defaults = defaultBindings()
  const bindings = { ...defaults }
  const issues: BindingIssue[] = []
  const custom = new Set<BindingActionId>()
  if (input === undefined) return { bindings, issues, valid: true }
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    return { bindings, issues: [{ code: 'invalid-data', message: uiText("webview.paint.bindings.shortcutSettingsMustBeAMapTo") }], valid: false }
  }
  const record = input as Record<string, unknown>
  const ids = new Set<string>(actions.map(action => action.id))
  for (const id of Object.keys(record)) {
    if (!ids.has(id)) issues.push({ code: 'unknown-action', actionId: id, message: uiText("webview.paint.bindings.unknownOperationIgnored") })
  }
  for (const action of actions) {
    const descriptor = Object.getOwnPropertyDescriptor(record, action.id)
    if (!descriptor) continue
    const value: unknown = descriptor.value
    const combo = normalizeBinding(value)
    const reserved = isReservedBinding(value)
    if (combo === undefined || reserved) {
      issues.push({
        code: reserved ? 'reserved-binding' : 'invalid-binding', actionId: action.id,
        ...(typeof value === 'string' ? { binding: value } : {}), fallback: defaults[action.id],
        message: reserved ? uiText("webview.paint.bindings.theSystemOrHostKeepsShortcutsUndistributable") : uiText("webview.paint.bindings.shortcutFormatInvalidDefaultRestored")
      })
      continue
    }
    bindings[action.id] = combo
    if (combo !== defaults[action.id]) custom.add(action.id)
  }
  let conflicts = conflictsOf(bindings, actions)
  while (conflicts.size > 0) {
    let rejected = actions.filter(action => custom.has(action.id) && conflicts.has(action.id))
    if (rejected.length === 0) rejected = actions.filter(action => conflicts.has(action.id)).slice(-1)
    for (const action of rejected) {
      const fallback = custom.has(action.id) ? defaults[action.id] : ''
      issues.push({
        code: 'conflict', actionId: action.id, binding: bindings[action.id], fallback,
        conflictsWith: [...conflicts.get(action.id)!], message: uiText("webview.paint.bindings.shortcutConflictsWithOtherOperationsBackTo")
      })
      bindings[action.id] = fallback
      custom.delete(action.id)
    }
    conflicts = conflictsOf(bindings, actions)
  }
  return { bindings, issues, valid: issues.length === 0 }
}

// 捕获保留键供设置界面提示，但组合输入和修饰键本身不产生绑定
export function bindingForEvent(event: KeyboardBindingEvent): string | undefined {
  if (event.isComposing || NON_KEY_EVENTS.test(event.key ?? '')
    || MODIFIER_EVENT_KEYS.test(event.key ?? '') || MODIFIER_EVENT_KEYS.test(event.code ?? '')) return undefined
  const modifiers = new Set<Modifier>()
  if (event.ctrlKey ?? event.ctrl) modifiers.add('Ctrl')
  if (event.metaKey ?? event.meta) modifiers.add('Meta')
  if (event.altKey ?? event.alt) modifiers.add('Alt')
  if (event.shiftKey ?? event.shift) modifiers.add('Shift')
  let key = event.key === ' ' ? normalizedKey('Space') : normalizedKey(event.key ?? '')
  if (/^Numpad/i.test(event.code ?? '')) key = normalizedKey(event.code!) ?? key
  if (!key && (!event.key || modifiers.has('Alt'))) key = normalizedKey(event.code ?? '')
  if (!key) return undefined
  if (key.shift) modifiers.add('Shift')
  return comboFor(key.key, modifiers)
}

export function actionForKeyboardEvent(
  bindings: Readonly<PaintBindings>,
  event: KeyboardBindingEvent,
  platform: BindingPlatform = 'windows'
): BindingActionId | undefined {
  const combo = bindingForEvent(event)
  if (!combo || isReservedBinding(combo)) return undefined
  let matched: BindingAction | undefined
  for (const action of listBindingActions()) {
    if (!Object.hasOwn(bindings, action.id)) continue
    const binding = normalizeBinding(bindings[action.id])
    if (!binding || isReservedBinding(binding) || resolveMod(binding, platform) !== combo) continue
    if (matched) return undefined
    matched = action
  }
  return matched && (!event.repeat || matched.repeatable) ? matched.id : undefined
}
