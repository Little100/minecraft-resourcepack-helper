let installed = false

export function enhanceNativeSelects(): void {
  if (installed || !CSS.supports('appearance', 'base-select')) return
  installed = true
  const managed = new WeakMap<HTMLSelectElement, HTMLButtonElement>()
  const update = (select: HTMLSelectElement): void => {
    const current = managed.get(select)
    if (select.multiple || select.size > 1) {
      const button = current ?? select.querySelector(':scope > button.mcrh-select-content')
      button?.remove(); managed.delete(select)
      return
    }
    let button = current?.parentElement === select ? current : undefined
    if (!button) {
      if (select.querySelector(':scope > button')) return
      button = document.createElement('button'); button.type = 'button'; button.className = 'mcrh-select-content'
      button.append(document.createElement('selectedcontent'))
      managed.set(select, button); select.prepend(button)
    }
    const content = button.querySelector('selectedcontent')!, option = select.selectedOptions[0]
    const label = option?.label ?? ''
    if (content.textContent !== label) content.textContent = label
    button.title = label
  }
  const scan = (node: Node, pending: Set<HTMLSelectElement>): void => {
    const element = node instanceof Element ? node : node.parentElement
    if (!element) return
    const select = element.closest('select')
    if (select) pending.add(select)
    for (const child of element.querySelectorAll('select')) pending.add(child)
  }
  const observer = new MutationObserver(records => {
    const pending = new Set<HTMLSelectElement>()
    for (const record of records) { scan(record.target, pending); for (const node of record.addedNodes) scan(node, pending) }
    for (const select of pending) if (select.isConnected) update(select)
  })
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['multiple', 'size', 'selected', 'label', 'value'] })
  for (const event of ['input', 'change', 'focusin']) document.addEventListener(event, event => { if (event.target instanceof HTMLSelectElement) update(event.target) })
  document.addEventListener('reset', event => { const form = event.target; if (form instanceof HTMLFormElement) queueMicrotask(() => { for (const select of form.querySelectorAll('select')) update(select) }) })
  for (const select of document.querySelectorAll('select')) update(select)
}
