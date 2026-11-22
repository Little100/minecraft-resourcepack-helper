import { uiText } from '../i18n/messages'

export interface McRun {
  text: string
  font?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

// 原版 16 个颜色码到十六进制, 与 formatting 代码一一对应
export const COLOR_CODE_HEX: Record<string, string> = {
  '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa',
  '4': '#aa0000', '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa',
  '8': '#555555', '9': '#5555ff', 'a': '#55ff55', 'b': '#55ffff',
  'c': '#ff5555', 'd': '#ff55ff', 'e': '#ffff55', 'f': '#ffffff'
}

export const COLOR_CODE_NAME: Record<string, string> = {
  '0': uiText("core.mcText.black"), '1': uiText("core.mcText.deepBlue"), '2': uiText("core.mcText.darkGreen"), '3': uiText("core.mcText.lakeBlue"), '4': uiText("core.mcText.darkRed"), '5': uiText("core.mcText.purple"),
  '6': uiText("core.mcText.gold"), '7': uiText("core.mcText.gray"), '8': uiText("core.mcText.darkGrey"), '9': uiText("core.mcText.blue"), 'a': uiText("core.mcText.green"), 'b': uiText("core.mcText.skyblue"),
  'c': uiText("core.mcText.red"), 'd': uiText("core.mcText.pink"), 'e': uiText("core.mcText.yellow"), 'f': uiText("core.mcText.white")
}

export const FORMAT_CODE_NAME: Record<string, string> = {
  'l': uiText("core.mcText.bold"), 'o': uiText("core.mcText.italic"), 'n': uiText("core.mcText.underline"), 'm': uiText("core.mcText.strikeout"), 'k': uiText("core.mcText.confusion"), 'r': uiText("core.mcText.reset")
}

const COLOR_CODES = COLOR_CODE_HEX

const NAMED_COLORS: Record<string, string> = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa',
  dark_red: '#aa0000', dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa',
  dark_gray: '#555555', blue: '#5555ff', green: '#55ff55', aqua: '#55ffff',
  red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff'
}

interface Style {
  font?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

function parseLegacy(input: string, base: Style): McRun[] {
  const runs: McRun[] = []
  let style: Style = { ...base }
  let buffer = ''
  const flush = () => {
    if (buffer.length === 0) return
    runs.push({ text: buffer, ...style })
    buffer = ''
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if ((ch === '§' || ch === '&') && i + 1 < input.length) {
      const code = input[i + 1].toLowerCase()
      i++
      if (COLOR_CODES[code]) {
        flush()
        style = { font: style.font, color: COLOR_CODES[code] }
      } else if (code === 'l') { flush(); style.bold = true }
      else if (code === 'o') { flush(); style.italic = true }
      else if (code === 'n') { flush(); style.underline = true }
      else if (code === 'm') { flush(); style.strikethrough = true }
      else if (code === 'k') { flush(); style.obfuscated = true }
      else if (code === 'r') { flush(); style = { ...base } }
      else buffer += ch + input[i]
      continue
    }
    buffer += ch
  }
  flush()
  return runs
}

// 解析 JSON 文本组件, 继承父级样式并递归 extra, 同时兼容内嵌的旧式格式码
function parseComponent(value: unknown, base: Style): McRun[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return parseLegacy(value, base)
  if (typeof value === 'number' || typeof value === 'boolean') return parseLegacy(String(value), base)
  if (Array.isArray(value)) {
    const runs: McRun[] = []
    let inherited = base
    for (const item of value) {
      runs.push(...parseComponent(item, inherited))
      if (typeof item === 'object' && item && !Array.isArray(item)) inherited = mergeStyle(inherited, item as Record<string, unknown>)
    }
    return runs
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const style = mergeStyle(base, obj)
    const runs: McRun[] = []
    if (typeof obj.text === 'string') runs.push(...parseLegacy(obj.text, style))
    if (Array.isArray(obj.extra)) {
      for (const child of obj.extra) runs.push(...parseComponent(child, style))
    }
    return runs
  }
  return []
}

function mergeStyle(base: Style, obj: Record<string, unknown>): Style {
  const next: Style = { ...base }
  if (typeof obj.font === 'string') next.font = obj.font
  if (typeof obj.color === 'string') {
    next.color = NAMED_COLORS[obj.color] ?? (obj.color.startsWith('#') ? obj.color : base.color)
  }
  if (typeof obj.bold === 'boolean') next.bold = obj.bold
  if (typeof obj.italic === 'boolean') next.italic = obj.italic
  if (typeof obj.underlined === 'boolean') next.underline = obj.underlined
  if (typeof obj.strikethrough === 'boolean') next.strikethrough = obj.strikethrough
  if (typeof obj.obfuscated === 'boolean') next.obfuscated = obj.obfuscated
  return next
}

// 把描述解析为多行, 每行是一串带样式的文本片段, 换行按原版拆分
export function parseMinecraftText(value: unknown): McRun[][] {
  const runs = parseComponent(value, {})
  const lines: McRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part.length > 0) lines[lines.length - 1].push({ ...run, text: part })
    })
  }
  return lines
}

export function plainText(lines: McRun[][]): string {
  return lines.map(line => line.map(run => run.text).join('')).join('\n')
}

export interface ColorRun {
  start: number
  end: number
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  obfuscated?: boolean
}

export function scanColorRuns(text: string): ColorRun[] {
  const runs: ColorRun[] = []
  const stringRe = /"(?:[^"\\]|\\.)*"/g
  let match: RegExpExecArray | null
  while ((match = stringRe.exec(text)) !== null) {
    const content = match[0]
    const base = match.index
    let style: Omit<ColorRun, 'start' | 'end'> = {}
    let runStart = base + 1
    const flush = (absEnd: number) => {
      if (absEnd > runStart && (style.color || style.bold || style.italic || style.underline || style.strikethrough || style.obfuscated)) {
        runs.push({ start: runStart, end: absEnd, ...style })
      }
      runStart = absEnd
    }
    let i = 1
    while (i < content.length - 1) {
      const ch = content[i]
      const next = content[i + 1]
      if ((ch === '§' || ch === '&') && next && /[0-9a-fk-or]/i.test(next)) {
        const code = next.toLowerCase()
        flush(base + i)
        if (COLOR_CODE_HEX[code]) style = { color: COLOR_CODE_HEX[code] }
        else if (code === 'l') style = { ...style, bold: true }
        else if (code === 'o') style = { ...style, italic: true }
        else if (code === 'n') style = { ...style, underline: true }
        else if (code === 'm') style = { ...style, strikethrough: true }
        else if (code === 'k') style = { ...style, obfuscated: true }
        else if (code === 'r') style = {}
        i += 2
        continue
      }
      i++
    }
    flush(base + content.length - 1)
  }
  return runs
}
