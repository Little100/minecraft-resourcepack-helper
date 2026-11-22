import { uiText } from '../i18n/messages'
import { PNG } from 'pngjs'
import { createHash } from 'node:crypto'
import type { PixelDocument } from '../core/document'
import type { z } from 'zod'
import type { operationSchemas } from './toolSchemas'
import { encodePixelMatrix } from './texturePainting'

export const MCP_PREVIEW_PNG_BYTES = 2 * 1024 * 1024
export function textureRevision(document: PixelDocument): string {
  const hash = createHash('sha256').update(JSON.stringify([document.width, document.height, document.frameHeight, document.activeLayerId]))
  for (const layer of document.layers) { hash.update(JSON.stringify([layer.id,layer.name,layer.visible,layer.opacity,layer.randomVariant])); hash.update(layer.pixels) }
  return hash.digest('hex')
}
export function textureInfo(document: PixelDocument) {
  return { revision: textureRevision(document), width: document.width, height: document.height, frame_height: document.frameHeight ?? document.height / document.frameCount, frame_count: document.frameCount, layers: document.layers.map(layer => ({ id:layer.id, name:layer.name, visible:layer.visible, opacity:layer.opacity, random_variant:layer.randomVariant ?? null })), layer_order:'top_to_bottom' }
}
// 预览使用最近邻采样，附带的坐标始终指向原始画布
export function previewTexture(document: PixelDocument, args: z.infer<typeof operationSchemas.get_texture>) {
  if (document.width * document.height > 16777216) throw new Error(uiText("mcp.imagePreview.photosExceedingMcpPreviewPixelBudget"))
  const layer = args.layer_id ? document.findLayer(args.layer_id) : undefined
  if (args.layer_id && !layer) throw new Error(uiText("mcp.imagePreview.stageDoesNotExistPleaseRereadPhoto"))
  const pixels = layer ? layer.pixels : document.flatten()
  const frameHeight = document.frameHeight ?? document.height / document.frameCount
  if (args.frame !== undefined && args.frame >= document.frameCount) throw new Error(uiText("mcp.imagePreview.animationFrameIndexCrossed"))
  const baseY = args.frame === undefined ? 0 : args.frame * frameHeight
  const availableHeight = args.frame === undefined ? document.height : frameHeight
  const crop = args.crop ?? { x:0, y:0, width:document.width, height:availableHeight }
  if (crop.x + crop.width > document.width || crop.y + crop.height > availableHeight) throw new Error(uiText("mcp.imagePreview.cropAreaBeyondPictureOrFrame"))
  let ratio = Math.min(args.scale, args.max_size / Math.max(crop.width,crop.height)), png:Buffer, width:number, height:number
  do {
    width=Math.max(1,Math.round(crop.width*ratio));height=Math.max(1,Math.round(crop.height*ratio))
    const output=Buffer.alloc(width*height*4)
    for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
      const source=((baseY+crop.y+Math.min(crop.height-1,Math.floor(y*crop.height/height)))*document.width+crop.x+Math.min(crop.width-1,Math.floor(x*crop.width/width)))*4
      output.set(pixels.subarray(source,source+4),(y*width+x)*4)
    }
    const image=new PNG({width,height});image.data=output;png=PNG.sync.write(image)
    if(png.length>MCP_PREVIEW_PNG_BYTES)ratio*=Math.min(.9,Math.sqrt(MCP_PREVIEW_PNG_BYTES/png.length)*.95)
  }while(png.length>MCP_PREVIEW_PNG_BYTES)
  return { ...textureInfo(document), ...(args.include_pixels ? { pixel_matrix: encodePixelMatrix(pixels, document.width, crop.x, crop.y + baseY, crop.width, crop.height) } : {}), source:'current_editor_document', view:args.layer_id?'raw_layer':args.view, crop:{...crop,y:crop.y+baseY}, preview_width:width, preview_height:height, preview_downscaled:width<crop.width||height<crop.height, encoded_bytes:png.length, png_base64:png.toString('base64'), note:uiText("mcp.imagePreview.previewOfTheLongestEdgeAndPng") }
}
