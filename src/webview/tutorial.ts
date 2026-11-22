import { uiHtml } from '../i18n/messages'
import { createBus, webviewAssets } from './bus'
import { TOOLS } from './tools'
import { TUTORIAL_GROUPS, buildShortcutGroups, type ShortcutGroup, type ShortcutItem, type TutorialCard, type TutorialGroup } from '../ui/tutorialCards'

const bus = createBus()

const root = document.createElement('main')
root.className = 'mcrh-wrap'
root.innerHTML = [
  renderHero(webviewAssets().logo),
  renderGroups(TUTORIAL_GROUPS),
  renderShortcuts(buildShortcutGroups(TOOLS)),
  renderActions()
].join('')
document.body.append(root)

root.addEventListener('click', event => {
  const target = event.target as Element
  const command = target.closest<HTMLElement>('[data-command]')?.dataset.command
  if (command) {
    bus.post({ command: 'run', id: command })
    return
  }
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'dismissForever') bus.post({ command: 'dismissForever' })
  if (action === 'close') bus.post({ command: 'close' })
})

root.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const command = (event.target as Element).closest<HTMLElement>('[data-command]')?.dataset.command
  if (!command) return
  event.preventDefault()
  bus.post({ command: 'run', id: command })
})

// 页面内容全部由教程数据生成, 文本统一转义后拼接, 避免数据中的符号被当作标记解析
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string))
}

function renderHero(logo: string): string {
  const image = logo ? `<img class="mcrh-hero-logo" src="${escapeHtml(logo)}" alt="" aria-hidden="true">` : ''
  return `
<header class="mcrh-hero">
  ${image}
  <div class="mcrh-hero-text">
    <h1>${uiHtml("webview.tutorial.weLlStartMakingYourMaterialBag")}</h1>
    <p class="mcrh-sub">${uiHtml("webview.tutorial.theCoreOfTheMaterialPackageIs")}</p>
  </div>
</header>`
}

function renderGroups(groups: TutorialGroup[]): string {
  return groups.map(group => `
<section class="mcrh-group">
  <h2 class="mcrh-section-title">${escapeHtml(group.title)}</h2>
  <div class="mcrh-cards">${group.cards.map(renderCard).join('')}</div>
</section>`).join('')
}

function renderCard(card: TutorialCard): string {
  const command = card.command
  const attrs = command ? ` data-command="${escapeHtml(command)}" tabindex="0" role="button"` : ''
  const hint = card.hint ? `<span class="mcrh-tag">${escapeHtml(card.hint)}</span>` : ''
  const run = command ? `<span class="mcrh-run">${uiHtml("webview.tutorial.immediateImplementation")}</span>` : ''
  return `
  <article class="mcrh-card"${attrs}>
    <header class="mcrh-card-head">
      <span class="codicon codicon-${escapeHtml(card.icon)} mcrh-card-icon" aria-hidden="true"></span>
      <h3>${escapeHtml(card.title)}</h3>
    </header>
    <p>${escapeHtml(card.body)}</p>
    <footer class="mcrh-card-foot">${hint}${run}</footer>
  </article>`
}

function renderShortcuts(groups: ShortcutGroup[]): string {
  const lists = groups.map(group => `
      <div class="mcrh-shortcut-group">
        <h4 class="mcrh-section-title">${escapeHtml(group.title)}</h4>
        <dl class="mcrh-shortcut-list">${group.items.map(renderShortcut).join('')}</dl>
      </div>`).join('')
  return `
<section class="mcrh-group">
  <h2 class="mcrh-section-title">${uiHtml("webview.tutorial.shortcuts")}</h2>
  <article class="mcrh-card">
    <header class="mcrh-card-head">
      <span class="codicon codicon-key mcrh-card-icon" aria-hidden="true"></span>
      <h3>${uiHtml("webview.tutorial.pixelBrushShortcut")}</h3>
    </header>
    <p>${uiHtml("webview.tutorial.doubleClickPngToOpenAPixel")}</p>
    <div class="mcrh-shortcut-groups">${lists}</div>
  </article>
</section>`
}

function renderShortcut(item: ShortcutItem): string {
  return `<div class="mcrh-shortcut"><dt>${escapeHtml(item.label)}</dt><dd class="mcrh-keys">${keyChips(item.keys)}</dd></div>`
}

function keyChips(keys: string): string {
  const combo = keys.includes('+')
  const parts = keys.split(combo ? '+' : /\s+/).filter(part => part.length > 0)
  const chips = parts.map(part => `<kbd class="mcrh-kbd">${escapeHtml(part)}</kbd>`)
  return combo ? chips.join('<span class="mcrh-joint">+</span>') : chips.join('')
}

function renderActions(): string {
  return `
<footer class="mcrh-actions">
  <button class="mcrh-btn" type="button" data-action="dismissForever"><span class="codicon codicon-bell-slash" aria-hidden="true"></span>${uiHtml("webview.tutorial.doNotAutomaticallyHint")}</button>
  <button class="mcrh-btn" type="button" data-action="close"><span class="codicon codicon-close" aria-hidden="true"></span>${uiHtml("webview.tutorial.closeThisPage")}</button>
</footer>`
}
