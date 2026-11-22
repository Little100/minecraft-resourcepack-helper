import { uiText } from '../i18n/messages'
import * as THREE from 'three'
import { configure, createScene, disposeCache, loadModel, prepareAssets, readFile, parseBlockstate, resolveModelData, type PreparedAssets, type ResolvedModel, type VirtualHandler } from 'block-model-renderer'
import type { SceneWorkbenchBlock } from './sceneWorkbench'
import { Buffer } from 'buffer'
import { createMaterialPreviewData, materialPreviewToRgbaTextures, PBR_PREVIEW_LIMITS, type PbrPreviewImageData, type PbrPreviewProfile } from '../core/advanced/pbrPreview'

const { PNG } = require('pngjs/browser') as typeof import('pngjs')

interface ResourceInfo {sessionId:number;layers:string[];version?:string}
type ResourceFilter = {namespace?:RegExp;path?:RegExp}
type ResourceFile = {bytes:Uint8Array;layer:number}
type TextureFrame = {width:number;height:number;index:number}
type CompanionChannel = 'normal'|'roughness'|'metallic'|'emissive'|'ao'
type CompanionTextures = Partial<Record<CompanionChannel,THREE.Texture>>
type SourceMaterial = THREE.Material & {map?:THREE.Texture;uniforms?:Record<string,THREE.IUniform>}
const TINT_VERTEX_MARKER = '#010203'
let assetRequestSequence = 0

type Pending = {resolve(value:Uint8Array|string[]|undefined):void;reject(error:Error):void;timer?:ReturnType<typeof setTimeout>}

// 原版几何通过受限资源消息读取，不访问外部网站
export class SceneStudioAssets {
  private readonly cache=new Map<string,Promise<Uint8Array|string[]|undefined>>()
  private readonly pending=new Map<number,Pending>()
  private activeRequests=0
  private readonly queue:Array<()=>void>=[]
  private assets?:Promise<PreparedAssets>
  private closed=false
  private filters:ResourceFilter[][]=[]
  private integrityQueue:Promise<void>=Promise.resolve()
  constructor(private readonly info:ResourceInfo,private readonly post:(value:object)=>void) {
    const globals=globalThis as typeof globalThis & {__MCRH__?:{modelAssets?:string}}
    configure({THREE,assetsUrl:globals.__MCRH__?.modelAssets||false})
  }
  accept(raw:Record<string,unknown>):void{
    if(raw.type!=='studioAsset'||raw.sessionId!==this.info.sessionId||typeof raw.requestId!=='number')return
    const pending=this.pending.get(raw.requestId)
    if(!pending)return
    this.pending.delete(raw.requestId);clearTimeout(pending.timer)
    this.activeRequests--;this.drain()
    if(typeof raw.error==='string')pending.reject(new Error(raw.error))
    else if(Array.isArray(raw.entries)&&raw.entries.every(value=>typeof value==='string'))pending.resolve(raw.entries)
    else if(Array.isArray(raw.data)&&raw.data.length<=32*1024*1024&&raw.data.every(value=>Number.isInteger(value)&&value>=0&&value<=255))pending.resolve(Uint8Array.from(raw.data))
    else if(raw.missing===true)pending.resolve(undefined)
    else pending.reject(new Error(uiText("webview.sceneStudioAssets.theSceneResourceResponseIsNotWorking")))
  }
  private request(layer:number,operation:'read'|'list',path:string):Promise<Uint8Array|string[]|undefined>{
    if(this.closed)return Promise.reject(new Error(uiText("webview.sceneStudioAssets.resourceSessionClosed")))
    const key=layer+':'+operation+':'+path
    const cached=this.cache.get(key)
    if(cached)return cached
    const requestId=++assetRequestSequence
    const promise=new Promise<Uint8Array|string[]|undefined>((resolve,reject)=>{
      this.pending.set(requestId,{resolve,reject})
      this.queue.push(()=>{
        if(this.closed)return
        this.activeRequests++
        const pending=this.pending.get(requestId)!
        pending.timer=setTimeout(()=>{this.pending.delete(requestId);this.activeRequests--;this.drain();reject(new Error(uiText("webview.sceneStudioAssets.readTheSceneResourceTimedOut", path)))},20000)
        this.post({command:'studioAsset',sessionId:this.info.sessionId,requestId,layer,operation,path})
      })
      this.drain()
    })
    this.cache.set(key,promise);void promise.catch(()=>{if(this.cache.get(key)===promise)this.cache.delete(key)});return promise
  }
  private drain():void {while(!this.closed&&this.activeRequests<8&&this.queue.length)this.queue.shift()!()}
  private prepared():Promise<PreparedAssets>{
    return this.assets??=(async()=>{
      const filters=await Promise.all(this.info.layers.map(async(_,layer)=>{
        const bytes=await this.request(layer,'read','pack.mcmeta')
        if(!(bytes instanceof Uint8Array))return []
        const metadata=JSON.parse(new TextDecoder().decode(bytes)) as {filter?:{block?:{namespace?:string;path?:string}[]}}
        return (metadata.filter?.block??[]).map(rule=>({namespace:rule.namespace===undefined?undefined:new RegExp('^(?:'+rule.namespace+')$'),path:rule.path===undefined?undefined:new RegExp('^(?:'+rule.path+')$')}))
      }))
      this.filters=filters
      const handlers:VirtualHandler[]=this.info.layers.map((_,layer)=>({
        filter:path=>{const parts=path.split('/');return parts[0]==='assets'&&filters[layer].some(rule=>(!rule.namespace||rule.namespace.test(parts[1]))&&(!rule.path||rule.path.test(parts.slice(2).join('/'))))},
        read:async path=>{if(/^assets\/block-model-renderer\/(?:models\/missing\.json|textures\/missing\.png)$/.test(path)) throw new Error(uiText("webview.sceneStudioAssets.modelOrTextureIncompleteMissingPlaceholderResources"));const bytes=await this.request(layer,'read',path);return bytes instanceof Uint8Array?bytes:undefined},
        list:async path=>{const entries=await this.request(layer,'list',path);return Array.isArray(entries)?entries:[]}
      }))
      return prepareAssets(handlers,{cache:true,defaults:'game',version:this.info.version})
    })()
  }
  block(block:SceneWorkbenchBlock,profile:PbrPreviewProfile='labPBR',tint?:{allFaces:boolean}):Promise<THREE.Object3D>{
    const next=this.integrityQueue.then(()=>this.buildBlock(block,profile,tint))
    this.integrityQueue=next.then(()=>undefined,()=>undefined)
    return next
  }
  private async buildBlock(block:SceneWorkbenchBlock,profile:PbrPreviewProfile,tint?:{allFaces:boolean}):Promise<THREE.Object3D>{
    const assets=await this.prepared(),id=block.resource
    if(!id)throw new Error(uiText("webview.sceneStudioAssets.theRealModelHasNoResourceId"))
    const [namespace,name]=id.includes(':')?id.split(':'):['minecraft',id]
    if(!await readFile('assets/'+namespace+'/blockstates/'+name+'.json',assets))throw new Error(uiText("webview.sceneStudioAssets.missingBlockstate", id))
    const references=await parseBlockstate(assets,id,{data:block.properties??{},pos:[0,0,0],defaults:'game',version:this.info.version})
    if(!references.length)throw new Error(uiText("webview.sceneStudioAssets.thereIsNoModelAvailableForThe", id))
    const resolved:ResolvedModel[]=[]
    for(const reference of references){
      const model=await resolveModelData(assets,reference)
      if(String(model.model??'').startsWith('block-model-renderer:missing'))throw new Error(uiText("webview.sceneStudioAssets.lackOfModelOrParentModel", id))
      resolved.push(model)
      const required=new Set<string>()
      for(const element of model.elements??[])for(const face of Object.values(element.faces??{}) as Array<{texture?:unknown}>){
        if(typeof face.texture!=='string')throw new Error(uiText("webview.sceneStudioAssets.modelTextureInvalid", id))
        let texture:string|undefined=face.texture
        const visited=new Set<string>()
        while(texture?.startsWith('#')){if(visited.has(texture))throw new Error(uiText("webview.sceneStudioAssets.modelTextureVariableCycle", face.texture));visited.add(texture);texture=model.textures?.[texture.slice(1)]}
        if(typeof texture!=='string')throw new Error(uiText("webview.sceneStudioAssets.lackOfModelTextureVariables", face.texture))
        const [namespace,name]=texture.includes(':')?texture.split(':'):['minecraft',texture]
        required.add('assets/'+namespace+'/textures/'+name+'.png')
      }
      for(const path of required){
        if(!await readFile(path,assets))throw new Error(uiText("webview.sceneStudioAssets.lackOfModelTexture", path))
      }
    }
    if(tint){
      const group=new THREE.Group(),geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>()
      const release=()=>{for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();group.clear()}
      try{
        for(const source of resolved){
          const model={...source,tints:Array.from({length:256},()=>TINT_VERTEX_MARKER),elements:source.elements?.map(element=>({...element,faces:Object.fromEntries(Object.entries(element.faces??{}).map(([side,face])=>[side,{...(face as Record<string,unknown>),...(tint.allFaces?{tintindex:0}:{})}]))}))}
          const loaded=await loadModel(null,assets,model,{lighting:'off',animate:false,version:this.info.version})
          loaded.traverse(node=>{
            const mesh=node as THREE.Mesh
            if(!mesh.isMesh)return
            mesh.geometry=mesh.geometry.clone();geometries.add(mesh.geometry)
            const color=mesh.geometry.getAttribute('color')
            if(color){
              // 浮点颜色保留暗部精度，掩码区分原模型的染色面
              const mask=new Uint8Array(color.count),linear=new Float32Array(color.count*3)
              for(let index=0;index<color.count;index++){
                const r=color.getX(index),g=color.getY(index),b=color.getZ(index)
                if(Math.round(r*255)===1&&Math.round(g*255)===2&&Math.round(b*255)===3)mask[index]=1
                linear.set([r,g,b],index*3)
              }
              mesh.geometry.setAttribute('color',new THREE.BufferAttribute(linear,3));mesh.userData.tintMask=mask
            }
            const clone=(material:THREE.Material)=>{const next=material.clone();materials.add(next);return next}
            mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material)
          })
          group.add(loaded)
        }
        if(new THREE.Box3().setFromObject(group).isEmpty())throw new Error(uiText("webview.sceneStudioAssets.theSquareHasNoGeometryToShow", id))
        if(this.closed)throw new Error(uiText("webview.sceneStudioAssets.resourceSessionClosed"))
        group.scale.setScalar(1/16)
        group.userData.studioDispose=release
        return group
      }catch(error){release();throw error}
    }
    const handle=await createScene(assets,[{id,properties:block.properties??{},pos:[0,0,0]}],{lighting:'off',defaults:'game',version:this.info.version,optimize:false,animate:false})
    if(!handle||handle.bounds.isEmpty()){handle?.dispose();throw new Error(uiText("webview.sceneStudioAssets.modelOrTextureIncomplete", id))}
    let placeholder=false
    handle.group.traverse(node=>{
      const mesh=node as THREE.Mesh
      if(!mesh.isMesh)return
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
        const source=material as SourceMaterial
        const texture=source.map??source.uniforms?.map?.value as THREE.Texture|undefined
        if(texture&&!texture.userData.srcHash&&!texture.userData.frames)placeholder=true
      }
    })
    if(placeholder){handle.dispose();throw new Error(uiText("webview.sceneStudioAssets.modelTexturesAreNotUsedToFocus", id))}
    const textures=new Set<THREE.Texture>()
    let released=false
    const release=()=>{
      if(released)return
      released=true
      for(const texture of textures)texture.dispose()
      textures.clear()
      handle.dispose()
    }
    try{
      await this.attachCompanions(handle.group,assets,profile,textures)
      if(this.closed)throw new Error(uiText("webview.sceneStudioAssets.resourceSessionClosed"))
    }catch(error){release();throw error}
    handle.group.scale.setScalar(1/16)
    handle.group.position.set(-0.5,-0.5,-0.5)
    const result=new THREE.Group();result.add(handle.group)
    result.userData.studioDispose=release
    return result
  }
  private async readCompanionFile(path:string,layer?:number):Promise<ResourceFile|undefined>{
    const parts=path.split('/')
    const filtered=(index:number)=>this.filters[index]?.some(rule=>(!rule.namespace||rule.namespace.test(parts[1]))&&(!rule.path||rule.path.test(parts.slice(2).join('/'))))
    for(let index=0;index<this.info.layers.length;index++){
      if(layer===undefined||index===layer){
        const bytes=await this.request(index,'read',path)
        if(bytes instanceof Uint8Array)return {bytes,layer:index}
        if(layer!==undefined)return undefined
      }
      if(filtered(index))return undefined
    }
    return undefined
  }
  private decodePng(file:ResourceFile,path:string):PbrPreviewImageData{
    const bytes=file.bytes
    if(bytes.length<33||!Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error(uiText("webview.sceneStudioAssets.pngFileHeaderInvalid", path))
    const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=header.getUint32(16),height=header.getUint32(20)
    if(!width||!height||width>PBR_PREVIEW_LIMITS.maxDimension||height>PBR_PREVIEW_LIMITS.maxDimension||width*height>PBR_PREVIEW_LIMITS.maxPixels)throw new Error(uiText("webview.sceneStudioAssets.thePbrStickerSizeExceededTheLimit", path))
    const image=PNG.sync.read(Buffer.from(bytes),{checkCRC:true})
    return {width:image.width,height:image.height,data:Uint8Array.from(image.data)}
  }
  private async textureFrame(file:ResourceFile,path:string,image:PbrPreviewImageData,inherited?:TextureFrame):Promise<TextureFrame>{
    const metadata=await this.readCompanionFile(path+'.mcmeta',file.layer)
    if(!metadata)return inherited??{width:image.width,height:image.height,index:0}
    const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(metadata.bytes))
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(uiText("webview.sceneStudioAssets.theMapMetadataMustBeUsedFor", path))
    const animation=(value as Record<string,unknown>).animation
    if(animation===undefined)return inherited??{width:image.width,height:image.height,index:0}
    if(!animation||typeof animation!=='object'||Array.isArray(animation))throw new Error(uiText("webview.sceneStudioAssets.theAnimatedMetadataOfThePasteIs", path))
    const meta=animation as Record<string,unknown>,size=Math.min(image.width,image.height)
    const width=meta.width??size,height=meta.height??size
    const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>0
    if(!positive(width)||!positive(height)||image.width%width||image.height%height||!positive(meta.frametime??1)||(meta.interpolate!==undefined&&typeof meta.interpolate!=='boolean'))throw new Error(uiText("webview.sceneStudioAssets.animationSizeOrTimeSeriesIsInvalid", path))
    const count=(image.width/width)*(image.height/height)
    let index=0
    if(meta.frames!==undefined){
      if(!Array.isArray(meta.frames)||!meta.frames.length)throw new Error(uiText("webview.sceneStudioAssets.invalidListOfDrawingAnimationFramesMcmeta", path))
      for(const [position,entry] of meta.frames.entries()){
        const frame=typeof entry==='number'?{index:entry}:entry
        if(!frame||typeof frame!=='object'||Array.isArray(frame)||!Number.isInteger(frame.index)||frame.index<0||frame.index>=count||!positive(frame.time??meta.frametime??1))throw new Error(uiText("webview.sceneStudioAssets.animationFrameInvalidMcmeta", path))
        if(position===0)index=frame.index
      }
    }
    return {width,height,index}
  }
  private cropImage(image:PbrPreviewImageData,frame:TextureFrame):PbrPreviewImageData{
    if(frame.width===image.width&&frame.height===image.height&&frame.index===0)return image
    const data=new Uint8Array(frame.width*frame.height*4),x=(frame.index%(image.width/frame.width))*frame.width,y=Math.floor(frame.index/(image.width/frame.width))*frame.height
    for(let row=0;row<frame.height;row++){
      const start=((y+row)*image.width+x)*4
      data.set(image.data.subarray(start,start+frame.width*4),row*frame.width*4)
    }
    return {width:frame.width,height:frame.height,data}
  }
  private async companionTextures(path:string,source:THREE.Texture,profile:PbrPreviewProfile,owned:Set<THREE.Texture>):Promise<CompanionTextures>{
    try{
      const stem=path.slice(0,-4),normalPath=stem+'_n.png',specularPath=stem+'_s.png'
      const [normalFile,specularFile]=await Promise.all([this.readCompanionFile(normalPath),this.readCompanionFile(specularPath)])
      if(!normalFile&&!specularFile)return {}
      const albedoFile=await this.readCompanionFile(path)
      if(!albedoFile)throw new Error(uiText("webview.sceneStudioAssets.missingPbrSourceMap", path))
      const fullAlbedo=this.decodePng(albedoFile,path),frame=await this.textureFrame(albedoFile,path,fullAlbedo)
      const sourceImage:unknown=source.image
      if(!sourceImage||typeof sourceImage!=='object'||!('width' in sourceImage)||!('height' in sourceImage)
        ||typeof sourceImage.width!=='number'||typeof sourceImage.height!=='number'
        ||frame.width!==sourceImage.width||frame.height!==sourceImage.height)throw new Error(uiText("webview.sceneStudioAssets.thePbrBaseMapDoesNotMatch", path))
      const decode=async(file:ResourceFile|undefined,companionPath:string)=>{
        if(!file)return undefined
        const image=this.decodePng(file,companionPath)
        if(image.width!==fullAlbedo.width||image.height!==fullAlbedo.height)throw new Error(uiText("webview.sceneStudioAssets.thePbrAccompanyingStickersMustBeOf", companionPath))
        const companionFrame=await this.textureFrame(file,companionPath,image,frame)
        if(companionFrame.width!==frame.width||companionFrame.height!==frame.height||companionFrame.index!==frame.index)throw new Error(uiText("webview.sceneStudioAssets.pbrSAnimationDoesNotMatchThe", companionPath))
        return this.cropImage(image,companionFrame)
      }
      const normal=await decode(normalFile,normalPath),mer=await decode(specularFile,specularPath)
      const channels=materialPreviewToRgbaTextures(createMaterialPreviewData({albedo:this.cropImage(fullAlbedo,frame),normal,mer,profile}))
      const textures:CompanionTextures={}
      for(const channel of ['normal','roughness','metallic','emissive','ao'] as const){
        if((channel==='normal'||channel==='ao')?!normal:!mer)continue
        const texture=new THREE.DataTexture(channels[channel],channels.width,channels.height,THREE.RGBAFormat,THREE.UnsignedByteType)
        owned.add(texture)
        texture.colorSpace=THREE.NoColorSpace
        texture.minFilter=source.minFilter;texture.magFilter=source.magFilter
        texture.wrapS=source.wrapS;texture.wrapT=source.wrapT;texture.flipY=source.flipY
        texture.generateMipmaps=source.generateMipmaps;texture.anisotropy=source.anisotropy
        texture.channel=source.channel;texture.mapping=source.mapping
        texture.offset.copy(source.offset);texture.repeat.copy(source.repeat);texture.center.copy(source.center)
        texture.rotation=source.rotation;texture.matrixAutoUpdate=source.matrixAutoUpdate;texture.matrix.copy(source.matrix)
        texture.needsUpdate=true
        textures[channel]=texture
      }
      return textures
    }catch(error){throw new Error(uiText("webview.sceneStudioAssets.readingPbrAccompaniedStickersFailed", path, (error instanceof Error?error.message:String(error))))}
  }
  private async attachCompanions(group:THREE.Object3D,assets:PreparedAssets,profile:PbrPreviewProfile,owned:Set<THREE.Texture>):Promise<void>{
    const meshes:THREE.Mesh[]=[],sources=new Set<SourceMaterial>()
    group.traverse(node=>{
      const mesh=node as THREE.Mesh
      if(!mesh.isMesh)return
      meshes.push(mesh)
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])sources.add(material as SourceMaterial)
    })
    const paths=new Map<THREE.Texture,string>()
    // 库缓存键保存原始资源ID，按贴图对象身份关联实际模型面
    const cache=assets.cache as {textures?:Map<string,THREE.Texture>}|undefined
    for(const [key,texture] of cache?.textures??[]){
      const id=key.split('\0',1)[0]
      if(!id)continue
      const [namespace,name]=id.includes(':')?id.split(':'):['minecraft',id]
      paths.set(texture,'assets/'+namespace+'/textures/'+name+'.png')
    }
    const mapped=new Map<THREE.Texture,CompanionTextures>()
    for(const source of sources){
      const texture=source.map??source.uniforms?.map?.value as THREE.Texture|undefined
      if(!texture||mapped.has(texture))continue
      const path=paths.get(texture)
      if(path)mapped.set(texture,await this.companionTextures(path,texture,profile,owned))
    }
    for(const mesh of meshes){
      const clone=(material:THREE.Material)=>{
        const source=material as SourceMaterial,texture=source.map??source.uniforms?.map?.value as THREE.Texture|undefined
        const textures=texture?mapped.get(texture):undefined
        if(!textures||!Object.keys(textures).length)return material
        const instance=material.clone()
        instance.userData={...material.userData,sceneWorkbenchTextures:{...textures}}
        return instance
      }
      mesh.material=Array.isArray(mesh.material)?mesh.material.map(clone):clone(mesh.material)
    }
  }
  dispose():void{this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error(uiText("webview.sceneStudioAssets.resourceSessionReplaced")))}this.pending.clear();this.queue.length=0;this.cache.clear();if(this.assets)void this.assets.then(assets=>disposeCache(assets)).catch(()=>{})}
}
