import { hasSvgIcon, svgIcon } from '../svgIcons'

// 直接创建元素，避免拼接 HTML
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

// 图标按注册名称加载 SVG 或 Codicons, 装饰节点对读屏隐藏
export function icon(name: string): HTMLSpanElement {
  const svg = hasSvgIcon(name) ? svgIcon(name) : undefined
  const node = el('span', svg ? 'mcrh-icon' : `codicon codicon-${name}`)
  node.dataset.icon = name
  node.setAttribute('aria-hidden', 'true')
  if (svg) node.append(svg)
  return node
}

export function iconButton(name: string, label: string, className = 'mcrh-icon-btn'): HTMLButtonElement {
  const button = el('button', className)
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(icon(name))
  return button
}

export function setIcon(button: HTMLElement, name: string): void {
  const current = button.querySelector<HTMLElement>('[data-icon]')
  if (current?.dataset.icon === name) return
  const next = icon(name)
  if (current) current.replaceWith(next)
  else button.append(next)
}

export function setPressed(button: HTMLElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed))
}
