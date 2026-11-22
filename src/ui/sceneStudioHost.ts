import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { findPreviewClientAssets } from './previewClientAssets'
import { ModelPreviewAssets } from '../core/modelPreviewAssets'
import { previewPathKey, texturePreviewState } from '../core/texturePreviewState'
import { compileMaterialGraph } from '../core/advanced/materialGraph'
import { generateOldPbrFiles, generatePbrFiles } from '../core/advanced/pbr'
import { generatePbrgenFiles } from '../core/advanced/pbrgenCompat'
import { deserializeSceneWorkbenchProject, serializeSceneWorkbenchProject } from '../core/sceneWorkbench'

const STUDIO_MAX_PIXELS = 1024 * 1024
const studioMaterialId = z.string().min(1).max(256).regex(/^[a-z0-9_.-]+:[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/).refine(value => value.split(/[:/]/).every(part => part !== '.' && part !== '..'))
const studioAlbedo = z.strictObject({
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  data: z.custom<number[]>(Array.isArray)
}).refine(image => {
  if(image.width * image.height > STUDIO_MAX_PIXELS || image.data.length !== image.width * image.height * 4) return false
  for(const value of image.data) if(!Number.isInteger(value) || value < 0 || value > 255) return false
  return true
})

type SelectedTexture = { file: string }

const studioRequest = z.discriminatedUnion('command', [
  z.strictObject({command:z.literal('studioTexture'),role:z.enum(['albedo','normal','specular']),materialId:studioMaterialId.optional(),createMaterial:z.boolean().optional()}).refine(request => request.role==='albedo' || request.createMaterial===undefined),
  z.strictObject({command:z.literal('studioResources'),automatic:z.boolean().optional(),targetVersion:z.string().max(64).regex(/^[a-zA-Z0-9_.-]+$/).optional()}),
  z.strictObject({command:z.literal('studioGeneratePbr'),profile:z.enum(['labPBR', 'oldPBR', 'pbrgen-mer']).default('labPBR'),strength:z.number().finite().min(0).max(16),roughness:z.number().finite().min(0).max(1),metallic:z.number().finite().min(0).max(1),emission:z.number().finite().min(0).max(1),materialId:studioMaterialId.optional(),albedo:studioAlbedo.optional()}),
  z.strictObject({command:z.literal('studioSave'),project:z.string().max(4*1024*1024),saveId:z.uuid().optional()}),
  z.strictObject({command:z.literal('studioLoad')}),
  z.strictObject({command:z.literal('studioAsset'),sessionId:z.number().int().positive(),requestId:z.number().int().positive(),layer:z.number().int().min(0).max(15),operation:z.enum(['read','list']),path:z.string().min(1).max(2048)})
])

// 消息只读取明确选择的资源，不能携带任意本机路径
export class SceneStudioHost implements vscode.Disposable {
  private assets?: ModelPreviewAssets
  private sessionId = 0
  private loading = false
  private closed = false
  private pending = 0
  private sentBytes = 0
  private readonly selected = new Map<string | undefined, Map<string, SelectedTexture>>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly webview:vscode.Webview,private readonly context?:vscode.ExtensionContext) {
    this.disposables.push(texturePreviewState.subscribe(event => {
      if(event.type !== 'texture') return
      const key = previewPathKey(event.uri)
      if(![...this.selected.values()].some(roles => [...roles.values()].some(source => previewPathKey(source.file) === key))) return
      clearTimeout(this.refreshTimers.get(key))
      this.refreshTimers.set(key,setTimeout(() => {
        this.refreshTimers.delete(key)
        void this.refreshImages(key)
      },100))
    }))
  }
  private async refreshImages(key:string):Promise<void> {
    for(const [materialId,roles] of this.selected) for(const [role,source] of roles) {
      if(previewPathKey(source.file) !== key) continue
      try{const bytes=await this.imageBytes(source.file);if(this.selected.get(materialId)?.get(role)===source)this.postImage(role,bytes,path.basename(source.file),materialId,false)}
      catch(error){this.post({type:'studioError',error:String(error)})}
    }
  }
  private post(value:object):void {if(!this.closed) void this.webview.postMessage(value)}
  async handle(raw:unknown):Promise<boolean> {
    if(!raw || typeof raw !== 'object' || !String((raw as {command?:unknown}).command ?? '').startsWith('studio')) return false
    const parsed=studioRequest.safeParse(raw)
    if(!parsed.success){this.post({type:'studioError',error:uiText("ui.sceneStudioHost.theSceneDeskMessageIsInvalid")});return true}
    const request=parsed.data
    if(request.command==='studioAsset'){await this.asset(request);return true}
    if(this.loading){if(request.command==='studioResources')this.post({type:'studioError',error:uiText("ui.sceneStudioHost.resourcesAreInTheProcessOfBeing")});return true}
    this.loading=true
    try {
      if(request.command==='studioTexture') {
        const result=await vscode.window.showOpenDialog({canSelectMany:false,filters:{PNG:['png']},title:uiText("ui.sceneStudioHost.selectPreviewMaterialsMapWithoutModifyingSource")})
        if(result?.[0]) {
          if(result[0].scheme!=='file')throw new Error(uiText("ui.sceneStudioHost.onlyLocalPngIsSupported"))
          await this.sendImage(request.role,result[0].fsPath,request.materialId,request.createMaterial)
          const roles=this.selected.get(request.materialId) ?? new Map<string,SelectedTexture>()
          roles.set(request.role,{file:result[0].fsPath})
          this.selected.set(request.materialId,roles)
        }
      } else if(request.command==='studioResources') {
        const config=vscode.workspace.getConfiguration('mcrh'),base=config.get<string>('previewBaseAssetsPath','').trim()
        const result=request.automatic?undefined:await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,title:uiText("ui.sceneStudioHost.selectTheMaterialPackageDirectoryIncludingAssets")})
        if(!request.automatic&&!result?.[0]){this.post({type:'studioResourcesCanceled'});return true}
        if(result?.[0]&&result[0].scheme!=='file')throw new Error(uiText("ui.sceneStudioHost.onlySupportLocalResourcePacks"))
        const roots=result?.[0]?[result[0].fsPath]:(vscode.workspace.workspaceFolders??[]).filter(folder=>folder.uri.scheme==='file').map(folder=>folder.uri.fsPath)
        const version=request.targetVersion||config.get<string>('previewMinecraftVersion','')||undefined
        const cached=this.context&&version?await findPreviewClientAssets(this.context,version,roots):undefined
        if(base)roots.push(base)
        if(cached)roots.push(cached)
        if(!roots.length)throw new Error(uiText("ui.sceneStudioHost.readTheMaterialPackageDirectoryOrDownload"))
        const assets=new ModelPreviewAssets([...new Set(roots)])
        const paths=await assets.list()
        const blocks=paths.filter(file=>/^assets\/[^/]+\/blockstates\/.+\.json$/.test(file)).map(file=>file.replace(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/,'$1:$2'))
        if(!blocks.length)throw new Error(uiText("ui.sceneStudioHost.noBlockstatesPleaseReadTheOriginalResource"))
        this.assets=assets;this.sessionId++;this.sentBytes=0
        this.post({type:'studioResources',sessionId:this.sessionId,layers:assets.roots.map(value=>path.basename(value)),blocks,version})
      } else if(request.command==='studioGeneratePbr') {
        let albedoPng:Buffer
        if(request.albedo) {
          const image=new PNG({width:request.albedo.width,height:request.albedo.height})
          image.data.set(request.albedo.data)
          albedoPng=PNG.sync.write(image)
        } else {
          const file=this.selected.get(request.materialId)?.get('albedo')?.file
          if(!file)throw new Error(uiText("ui.sceneStudioHost.pleaseSelectTheBaseColourProfileFirst"))
          albedoPng=await this.imageBytes(file)
        }
        const options={texturePath:'assets/minecraft/textures/block/preview.png',albedoPng}
        const generated=request.profile==='pbrgen-mer'?generatePbrgenFiles(options):(request.profile==='oldPBR'?generateOldPbrFiles:generatePbrFiles)({...options,normalStrength:request.strength,roughness:request.roughness,metalness:request.metallic,emission:request.emission})
        for(const output of generated.files){if(typeof output.content==='string')continue;this.postImage(output.path.endsWith('_n.png')?'normal':output.path.endsWith('_s.png')?'specular':'albedo',output.content,path.basename(output.path),request.materialId,false)}
        this.post({type:'studioPbrGenerated',profile:request.profile,warnings:generated.warnings,...(request.materialId===undefined?{}:{materialId:request.materialId})})
      } else if(request.command==='studioLoad') {
        const picked=await vscode.window.showOpenDialog({canSelectMany:false,filters:{[uiText("ui.sceneStudioHost.workbenchEngineering")]:['json']}})
        if(picked?.[0]){if(picked[0].scheme!=='file')throw new Error(uiText("ui.sceneStudioHost.onlyLocalProjectsAreSupported"));const project=deserializeSceneWorkbenchProject((await this.fileBytes(picked[0].fsPath,4*1024*1024)).toString('utf8'));if(project.materialGraph)compileMaterialGraph(project.materialGraph);this.post({type:'studioProject',project:serializeSceneWorkbenchProject(project),name:path.basename(picked[0].fsPath)})}
      } else if(request.command==='studioSave') {
        const project=deserializeSceneWorkbenchProject(request.project)
        if(project.materialGraph)compileMaterialGraph(project.materialGraph)
        const destination=await vscode.window.showSaveDialog({filters:{[uiText("ui.sceneStudioHost.workbenchEngineering")]:['json']},defaultUri:vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', 'material-scene.mcrh.json'))})
        if(destination){
          if(destination.scheme!=='file')throw new Error(uiText("ui.sceneStudioHost.onlyLocalProjectsAreSupported"))
          await vscode.workspace.fs.writeFile(destination,Buffer.from(serializeSceneWorkbenchProject(project)))
          this.post({type:'studioSaved',name:path.basename(destination.fsPath),...(request.saveId===undefined?{}:{saveId:request.saveId})})
        }
      }
    } catch(error){this.post({type:'studioError',error:error instanceof Error?error.message:String(error)})}
    finally{this.loading=false}
    return true
  }
  private async fileBytes(file:string,limit=32*1024*1024):Promise<Buffer>{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error(uiText("ui.sceneStudioHost.fileIsInvalidLinkedOrAboveLimit"));const bytes=await fs.readFile(file);if(bytes.length>limit)throw new Error(uiText("ui.sceneStudioHost.fileInExcessOfLimit"));return bytes}
  private async imageBytes(file:string):Promise<Buffer>{const memory=texturePreviewState.read(file);if(memory){const png=new PNG({width:memory.width,height:memory.height});png.data.set(memory.pixels);return PNG.sync.write(png)}return this.fileBytes(file)}
  private async sendImage(role:string,file:string,materialId?:string,createMaterial?:boolean):Promise<void>{this.postImage(role,await this.imageBytes(file),path.basename(file),materialId,createMaterial)}
  private postImage(role:string,bytes:Uint8Array,name:string,materialId?:string,createMaterial?:boolean):void {
    const buffer=Buffer.from(bytes)
    if(buffer.length<33||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||buffer.readUInt32BE(16)>2048||buffer.readUInt32BE(20)>2048||buffer.readUInt32BE(16)*buffer.readUInt32BE(20)>STUDIO_MAX_PIXELS)throw new Error(uiText("ui.sceneStudioHost.realTimeScenePngTotalPixelsCeiling"))
    const image=PNG.sync.read(buffer,{checkCRC:true})
    this.post({type:'studioTexture',role,name,width:image.width,height:image.height,data:Array.from(image.data),...(materialId===undefined?{}:{materialId}),...(createMaterial===undefined?{}:{createMaterial})})
  }
  private async asset(request:Extract<z.infer<typeof studioRequest>,{command:'studioAsset'}>):Promise<void>{
    const response:Record<string,unknown>={type:'studioAsset',sessionId:request.sessionId,requestId:request.requestId}
    if(!this.assets||request.sessionId!==this.sessionId)return
    if(this.pending>=24){this.post({...response,error:uiText("ui.sceneStudioHost.resourceComplementingRequestExcess")});return}
    const assets=this.assets;this.pending++
    try{if(request.operation==='list')response.entries=await assets.listEntries(request.path,request.layer);else{const bytes=await assets.read(request.path,request.layer);if(bytes){this.sentBytes+=bytes.length;if(this.sentBytes>256*1024*1024)throw new Error(uiText("ui.sceneStudioHost.theCumulativeTransferOfSceneResourcesExceeded"));response.data=Array.from(bytes)}else response.missing=true}}
    catch(error){response.error=error instanceof Error?error.message:String(error)}
    finally{this.pending--;if(this.sessionId===request.sessionId)this.post(response)}
  }
  dispose():void{this.closed=true;for(const timer of this.refreshTimers.values())clearTimeout(timer);this.refreshTimers.clear();this.selected.clear();for(const disposable of this.disposables)disposable.dispose();this.disposables.length=0}
}
