import { uiHtml, uiText } from '../i18n/messages'
import type { PixelImage } from '../core/advanced/textureBatch'

export function createConnectedPreview(panel: HTMLElement) {
  panel.innerHTML = `<h3>${uiHtml('webview.textureBatch.marginsConnectedWithSquares')}</h3>
    <p id="batch-preview-state" class="muted" role="status">${uiHtml('webview.textureBatch.choosePreviewBlock')}</p>
    <div id="batch-comparison" hidden>
      <figure><figcaption id="batch-isolated-label">${uiHtml('webview.textureBatch.isolatedLabel')}</figcaption><canvas id="batch-isolated-preview" width="288" height="288" role="img" aria-labelledby="batch-isolated-label"></canvas></figure>
      <figure><figcaption id="batch-connected-label">${uiHtml('webview.textureBatch.connectedLabel')}</figcaption><canvas id="batch-connected-preview" width="288" height="288" role="img" aria-labelledby="batch-connected-label"></canvas></figure>
    </div>
    <div id="batch-adjacency" hidden>
      <div id="batch-neighbors" role="group" aria-label="${uiHtml('webview.textureBatch.toggleAdjacentBlocks')}"></div>
      <p class="muted">${uiHtml('webview.textureBatch.clickOnTheKaumonggToSwitchThe')}</p>
    </div>
    <label class="batch-check"><input id="batch-ctm" type="checkbox">${uiHtml('webview.textureBatch.compactCtmConnectionEdge')}</label>
    <label>${uiHtml('webview.textureBatch.levelOfAction')}<select id="batch-faces">
      <option value="all">${uiHtml('webview.textureBatch.allSixSides')}</option><option value="sides">${uiHtml('webview.textureBatch.fourSides')}</option>
      <option value="top">${uiHtml('webview.textureBatch.top')}</option><option value="bottom">${uiHtml('webview.textureBatch.bottom')}</option>
      <option value="north">${uiHtml('webview.textureBatch.north')}</option><option value="south">${uiHtml('webview.textureBatch.south')}</option>
      <option value="east">${uiHtml('webview.textureBatch.east')}</option><option value="west">${uiHtml('webview.textureBatch.west')}</option>
    </select></label>
    <p id="batch-requirements" class="notice" hidden>${uiHtml('webview.textureBatch.optifineConnectionTextureOrSupportForThe')}</p>`

  const before = panel.querySelector<HTMLCanvasElement>('#batch-isolated-preview')!.getContext('2d')!
  const after = panel.querySelector<HTMLCanvasElement>('#batch-connected-preview')!.getContext('2d')!
  const comparison = panel.querySelector<HTMLElement>('#batch-comparison')!
  const adjacency = panel.querySelector<HTMLElement>('#batch-adjacency')!
  const notice = panel.querySelector<HTMLElement>('#batch-preview-state')!
  const grid = panel.querySelector<HTMLElement>('#batch-neighbors')!
  const neighbors = Array<boolean>(9).fill(true)
  const size = after.canvas.width / 3
  let tiles: HTMLCanvasElement[] = []

  function draw(): void {
    before.clearRect(0, 0, before.canvas.width, before.canvas.height)
    after.clearRect(0, 0, after.canvas.width, after.canvas.height)
    if (!tiles.length) return
    const empty = !neighbors.some(Boolean)
    comparison.hidden = empty
    notice.hidden = !empty
    if (empty) { notice.textContent = uiText('webview.textureBatch.choosePreviewNeighbor'); return }
    before.imageSmoothingEnabled = after.imageSmoothingEnabled = false
    const has = (x: number, y: number) => x >= 0 && x < 3 && y >= 0 && y < 3 && neighbors[y * 3 + x]
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      if (!has(x, y)) continue
      before.drawImage(tiles[0], x * size, y * size)
      for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) {
        const dx = qx ? 1 : -1, dy = qy ? 1 : -1
        const horizontal = has(x + dx, y), vertical = has(x, y + dy)
        let tile = 0
        if (horizontal && vertical) tile = has(x + dx, y + dy) ? 1 : 4
        else if (horizontal) tile = 3
        else if (vertical) tile = 2
        const half = size / 2, sx = qx * half, sy = qy * half
        after.drawImage(tiles[tile], sx, sy, half, half, x * size + sx, y * size + sy, half, half)
      }
    }
  }

  neighbors.forEach((_, index) => {
    const button = document.createElement('button')
    button.textContent = uiText(index === 4 ? 'webview.textureBatch.current' : 'webview.textureBatch.neighbor')
    button.setAttribute('aria-label', uiText('batch.block', index + 1))
    button.setAttribute('aria-pressed', 'true')
    button.addEventListener('click', () => {
      neighbors[index] = !neighbors[index]
      button.setAttribute('aria-pressed', String(neighbors[index]))
      draw()
    })
    grid.append(button)
  })

  return {
    unavailable(message: string) {
      tiles = []
      draw()
      comparison.hidden = adjacency.hidden = true
      notice.textContent = message
      notice.hidden = false
    },
    show(images: PixelImage[]) {
      const native = document.createElement('canvas')
      native.width = images[0].width; native.height = images[0].height
      const context = native.getContext('2d')!
      tiles = images.map(image => {
        context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
        const tile = document.createElement('canvas')
        tile.width = tile.height = size
        const reduced = tile.getContext('2d')!
        reduced.imageSmoothingEnabled = false
        reduced.drawImage(native, 0, 0, size, size)
        return tile
      })
      adjacency.hidden = false
      draw()
    }
  }
}
