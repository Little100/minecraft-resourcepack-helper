import penNibSource from './icons/pen-nib.svg'
import infoSource from '../../node_modules/@vscode/codicons/src/icons/info.svg'
import closeSource from '../../node_modules/@vscode/codicons/src/icons/close.svg'
import zoomInSource from '../../node_modules/@vscode/codicons/src/icons/zoom-in.svg'
import zoomOutSource from '../../node_modules/@vscode/codicons/src/icons/zoom-out.svg'

const sources = { info: infoSource, close: closeSource, 'zoom-in': zoomInSource, 'zoom-out': zoomOutSource, 'pen-nib': penNibSource }

export function hasSvgIcon(name: string): name is keyof typeof sources { return Object.hasOwn(sources, name) }

export function svgIcon(name: keyof typeof sources): SVGSVGElement {
  const template = document.createElement('template')
  template.innerHTML = sources[name]
  const icon = template.content.firstElementChild as SVGSVGElement
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')
  icon.classList.add('mcrh-svg-icon')
  return icon
}
