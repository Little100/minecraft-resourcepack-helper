import { uiText } from '../i18n/messages'
import { CollaborationPanel } from './collaborationPanel'
import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PixelEditorProvider, loadPixelDocument, type PixelDocumentModel } from './pixelEditor'
import { operationSchemas } from '../mcp/toolSchemas'
import { resourcePath, type McpOperation, type McpProject } from '../mcp/contracts'
import { resolveResource, enumerateResources, readResourceBytes } from '../mcp/resourceAccess'
import { previewTexture, textureInfo, textureRevision } from '../mcp/imagePreview'
import { recolorLayerComposite } from '../core/layerEdgeRecolor'
import { assertEditSize } from '../core/pixelGeometry'
import { diagnoseResourcePack, type DiagnosticFile } from '../core/advanced/packDiagnostics'
import { extensionLog } from './extensionLog'
import { prepareTexturePainting } from '../mcp/texturePainting'
import { PixelDocument } from '../core/document'
import { invokeTextureWorkflow, textureWorkflowOperations } from './mcpTextureOperations'
import { assertMcpRevision } from '../mcp/errors'

const textRevision = (text:string):string => createHash('sha256').update(text).digest('hex')
const checkRevision = assertMcpRevision
function bounds(x:number,y:number,w:number,h:number,width:number,height:number):void { if(x+w>width||y+h>height)throw new Error(uiText("ui.mcpOperations.pixelsBeyondCanvas")) }
async function imageModel(root:string,relative:string):Promise<PixelDocumentModel> {
  if(!relative.toLowerCase().endsWith('.png'))throw new Error(uiText("ui.mcpOperations.thisToolIsOnlyUsedForPng"))
  const uri=vscode.Uri.file(await resolveResource(root,relative))
  if(!PixelEditorProvider.findOpenModel(uri))await vscode.commands.executeCommand('vscode.openWith',uri,PixelEditorProvider.viewType)
  const model=PixelEditorProvider.findOpenModel(uri)
  if(!model)throw new Error(uiText("ui.mcpOperations.thePixelEditorIsNotReadyPlease"))
  if(model.hasLivePreview)throw new Error(uiText("ui.mcpOperations.usersAreDrawingAPenPleaseRe"))
  assertEditSize(model.document.width,model.document.height,model.document.layers.length)
  return model
}
async function imageDocument(root: string, relative: string): Promise<PixelDocument> {
  if (!/\.png$/i.test(relative)) throw new Error(uiText("ui.mcpOperations.thisToolIsOnlyUsedForPng"))
  const uri = vscode.Uri.file(await resolveResource(root, relative)), model = PixelEditorProvider.findOpenModel(uri)
  if (model) { if (model.hasLivePreview) throw new Error(uiText("ui.mcpOperations.usersAreDrawingAPenPleaseRe")); return model.document }
  const bytes = await readResourceBytes(root, relative, 16 * 1024 * 1024)
  return loadPixelDocument(uri, { bytes, silent: true })
}
async function resourceDocument(root:string,relative:string):Promise<vscode.TextDocument> {
  if(!/\.(?:json|mcmeta|lang|properties)$/i.test(relative))throw new Error(uiText("ui.mcpOperations.thisToolReadsResourceTextOnlyPlease"))
  const uri=vscode.Uri.file(await resolveResource(root,relative))
  const current=vscode.workspace.textDocuments.find(document=>document.uri.toString()===uri.toString())
  if(!current)await readResourceBytes(root,relative,1024*1024)
  const document=current??await vscode.workspace.openTextDocument(uri)
  if(Buffer.byteLength(document.getText(),'utf8')>1024*1024)throw new Error(uiText("ui.mcpOperations.resourceTextExceedingMib"))
  return document
}
export async function invokeMcpOperation(project:McpProject,operation:McpOperation,raw:Record<string,unknown>, isEnabled:()=>boolean, context?:vscode.ExtensionContext):Promise<unknown> {
  if(operation==='describe')throw new Error(uiText("ui.mcpOperations.describeToBeHandledByBridge"))
  const authorize=():void=>{
    if(!vscode.workspace.isTrusted || !isEnabled())throw new Error(uiText("ui.collaborationPanel.projectMcpClosedOrUntrusted"))
  }
  authorize()
  const args=operationSchemas[operation].parse(raw)
  extensionLog('info','(MCP '+project.name+' '+operation+')')
  if (textureWorkflowOperations.has(operation)) return invokeTextureWorkflow(project, operation, raw, { read: imageDocument, edit: imageModel, authorize }, context)
  if(operation==='collaboration_status'||operation==='collaboration_submit') return CollaborationPanel.invokeMcp(project.root,operation,args,()=>vscode.workspace.isTrusted&&isEnabled())
  if(operation==='list_resources') {
    const value=operationSchemas.list_resources.parse(args)
    if(value.prefix)resourcePath.parse(value.prefix.replace(/\/$/,''))
    const result=await enumerateResources(project.root), keywords=value.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [], matches=result.paths.filter(item=>item.startsWith(value.prefix)&&(!keywords.length||keywords.some(keyword=>item.toLowerCase().includes(keyword))))
    return {files:matches.slice(value.offset,value.offset+value.limit),total_count:matches.length,truncated:result.truncated,next_offset:value.offset+value.limit<matches.length?value.offset+value.limit:null}
  }
  if(operation==='read_text') {const value=operationSchemas.read_text.parse(args),document=await resourceDocument(project.root,value.path),text=document.getText();return {path:value.path,revision:textRevision(text),dirty:document.isDirty,text:text.slice(value.offset,value.offset+value.limit),total_chars:text.length,next_offset:value.offset+value.limit<text.length?value.offset+value.limit:null,truncated:value.offset>0||value.offset+value.limit<text.length,untrusted_content:true}}
  if(operation==='open_editor') {const value=operationSchemas.open_editor.parse(args);if(/\.png$/i.test(value.path))return textureInfo((await imageModel(project.root,value.path)).document);const document=await resourceDocument(project.root,value.path);await vscode.window.showTextDocument(document);return {opened:value.path,revision:textRevision(document.getText())}}
  if(operation==='get_texture') {const value=operationSchemas.get_texture.parse(args), document=await imageDocument(project.root,value.path);authorize();return {...previewTexture(document,value),source:PixelEditorProvider.findOpenModel(vscode.Uri.file(await resolveResource(project.root,value.path)))?'current_editor_document':'disk'}}
  if(operation==='texture_history') {
    const value=operationSchemas.texture_history.parse(args), model=await imageModel(project.root,value.path)
    authorize()
    if(value.action==='list') return {path:value.path,revision:textureRevision(model.document),current_entry_id:model.timeline.entries[model.timeline.current]?.id??null,entries:model.timeline.entries.map(({id,label,at})=>({id,label,at})),untrusted_content:true}
    if(value.entry_id===undefined||!value.expected_revision) throw new Error(uiText("ui.mcpOperations.restoringNeedsAnentryIdWithTheLatest"))
    checkRevision(textureRevision(model.document),value.expected_revision)
    const snapshot=model.timeline.read(value.entry_id)
    const restored=PixelDocument.fromLayers(snapshot.width,snapshot.height,snapshot.layers,snapshot.activeLayerId)
    restored.frameHeight=snapshot.frameHeight
    const preview=previewTexture(restored,operationSchemas.get_texture.parse({path:value.path}))
    authorize()
    checkRevision(textureRevision(model.document),value.expected_revision)
    model.changeDocument(uiText("ui.mcpOperations.mcpRestorationOfPaintHistory"),()=>model.document.restore(snapshot))
    return {...preview,path:value.path,saved:false,restored_entry_id:value.entry_id,note:uiText("ui.mcpOperations.restoredToANewEditorForCtrl")}
  }
  if(operation==='write_json') {
    const value=operationSchemas.write_json.parse(args)
    if(!/\.(?:json|mcmeta)$/i.test(value.path))throw new Error(uiText("ui.mcpOperations.writeJsonAllowsOnlyJsonOrMcmeta"))
    const json:unknown=JSON.parse(value.text);if(!json||typeof json!=='object'||Array.isArray(json))throw new Error(uiText("ui.mcpOperations.resourceJsonRootMustBeAnObject"))
    if(value.expected_revision==='missing') {
      const uri=vscode.Uri.file(await resolveResource(project.root,value.path,true))
      try {await vscode.workspace.fs.stat(uri);throw new Error(uiText("ui.mcpOperations.aFileAlreadyExistsPleaseReadIts"))}catch(error){if(!(error instanceof vscode.FileSystemError)||error.code!=='FileNotFound')throw error}
      authorize()
      const change=new vscode.WorkspaceEdit();change.createFile(uri,{overwrite:false,ignoreIfExists:false});change.insert(uri,new vscode.Position(0,0),value.text)
      if(!await vscode.workspace.applyEdit(change))throw new Error(uiText("ui.mcpOperations.failedToCreateJson"))
      const document=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(document);return {revision:textRevision(document.getText()),dirty:document.isDirty,created:true}
    }
    const document=await resourceDocument(project.root,value.path),editor=await vscode.window.showTextDocument(document)
    authorize()
    checkRevision(textRevision(document.getText()),value.expected_revision)
    if(!await editor.edit(builder=>builder.replace(new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),value.text)))throw new Error(uiText("ui.mcpOperations.documentChangesAtTheSameTimeRead"))
    return {revision:textRevision(document.getText()),dirty:document.isDirty}
  }
  if(operation==='save_resource') {
    const value=operationSchemas.save_resource.parse(args),uri=vscode.Uri.file(await resolveResource(project.root,value.path))
    if(/\.png$/i.test(value.path))checkRevision(textureRevision((await imageModel(project.root,value.path)).document),value.expected_revision)
    else checkRevision(textRevision((await resourceDocument(project.root,value.path)).getText()),value.expected_revision)
    authorize()
    const saved=await vscode.workspace.save(uri);if(!saved)throw new Error(uiText("ui.mcpOperations.theEditorIsNotSavedPleaseCheck"));return {saved:true,path:value.path}
  }
  if(operation==='diagnose') {
    const value=operationSchemas.diagnose.parse(args),prefix=value.pack_root?resourcePath.parse(value.pack_root).replace(/\/$/,'')+'/':''
    const result=await enumerateResources(project.root,4000), files:DiagnosticFile[]=[];let bytes=0,skipped=0
    for(const relative of result.paths.filter(item=>item.startsWith(prefix))) {
      if(files.length>=2000){skipped++;continue}
      try {const content=await readResourceBytes(project.root,relative,4*1024*1024);bytes+=content.length;if(bytes>32*1024*1024){skipped+=result.paths.filter(item=>item.startsWith(prefix)).length-files.length;break}files.push({path:relative.slice(prefix.length),content})}catch{skipped++}
    }
    return {...await diagnoseResourcePack(files,{maxIssues:value.max_issues,targetVersion:value.target_version}),scope:prefix||'.',partial:result.truncated||skipped>0,skipped,note:uiText("ui.mcpOperations.unmountedOriginalClientInheritanceResourcesUnsavedEditors")}
  }
  if(operation==='git_status') {
    const result=await promisify(execFile)('git',['-c','core.fsmonitor=false','--no-optional-locks','-C',project.root,'status','--short','--untracked-files=normal'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,windowsHide:true})
    return {status:result.stdout.slice(0,24000),total_chars:result.stdout.length,truncated:result.stdout.length>24000,untrusted_content:true,note:uiText("ui.mcpOperations.readOnlyStatusSavingDoesNotAutomatically")}
  }
  const value=operationSchemas[operation].parse(raw) as {path:string;expected_revision:string},model=await imageModel(project.root,value.path),document=model.document
  authorize()
  checkRevision(textureRevision(document),value.expected_revision)
  if(operation==='paint_texture') {
    const input=operationSchemas.paint_texture.parse(args), prepared=prepareTexturePainting(document,input)
    const preview=previewTexture(prepared.document,operationSchemas.get_texture.parse({path:input.path}))
    authorize()
    checkRevision(textureRevision(document),input.expected_revision)
    model.changeDocument(uiText("ui.mcpOperations.mcpBatchDrawing"),()=>document.restore(prepared.document.snapshot()))
    return {...preview,path:input.path,layer_id:prepared.layerId,saved:false,note:uiText("ui.mcpOperations.drawingsAreShownInRealTimeAnd")}
  }
  if(operation==='edit_pixels') {
    const input=operationSchemas.edit_pixels.parse(args),layer=document.findLayer(input.layer_id);if(!layer)throw new Error(uiText("ui.mcpOperations.layerDoesNotExist"))
    for(const pixel of input.pixels)bounds(pixel.x,pixel.y,1,1,document.width,document.height)
    let area=input.pixels.length;for(const fill of input.fills){bounds(fill.x,fill.y,fill.width,fill.height,document.width,document.height);area+=fill.width*fill.height}if(area>1048576)throw new Error(uiText("ui.mcpOperations.singlePixelEditsMoreThanMPixel"))
    model.changeDocument(uiText("ui.mcpOperations.mcpPixelEditor"),()=>{for(const pixel of input.pixels)layer.pixels.set(pixel.rgba,(pixel.y*document.width+pixel.x)*4);for(const fill of input.fills)for(let y=fill.y;y<fill.y+fill.height;y++)for(let x=fill.x;x<fill.x+fill.width;x++)layer.pixels.set(fill.rgba,(y*document.width+x)*4)})
  } else if(operation==='edit_layers') {
    const input=operationSchemas.edit_layers.parse(args),id=input.layer_id
    if(input.action!=='add'&&(!id||!document.findLayer(id)))throw new Error(uiText("ui.mcpOperations.pleaseProvideAnEffectiveApplication"))
    model.changeDocument(uiText("ui.mcpOperations.mcpLayerEditor"),()=>{switch(input.action){
      case 'add':assertEditSize(document.width,document.height,document.layers.length+1);if(document.layers.length>=128)throw new Error(uiText("ui.mcpOperations.layerUpToMcpBudget"));document.insertLayer(input.index??0,input.name??uiText("ui.mcpOperations.mcpLayer"));break
      case 'delete':document.removeLayer(id!);break
      case 'rename':if(!input.name)throw new Error(uiText("ui.mcpOperations.needsName"));document.renameLayer(id!,input.name);break
      case 'visibility':if(input.visible===undefined)throw new Error(uiText("ui.mcpOperations.needVisible"));document.setVisible(id!,input.visible);break
      case 'opacity':if(input.opacity===undefined)throw new Error(uiText("ui.mcpOperations.require"));document.setOpacity(id!,input.opacity);break
      case 'move':if(input.index===undefined)throw new Error(uiText("ui.mcpOperations.needsIndex"));document.moveLayer(id!,input.index);break
    }})
  } else if(operation==='transform_layers') {
    const input=operationSchemas.transform_layers.parse(args);if(input.layer_ids.some(id=>!document.findLayer(id)))throw new Error(uiText("ui.mcpOperations.layerDoesNotExist"));model.transformLayers(input.layer_ids,input.x,input.y,input.width,input.height,input.rotation)
  } else if(operation==='recolor_edges') {
    const input=operationSchemas.recolor_edges.parse(args),ids=new Set(input.layer_ids),layers=document.layers.filter(layer=>ids.has(layer.id));if(layers.length!==ids.size)throw new Error(uiText("ui.mcpOperations.layerDoesNotExist"))
    let mask:Uint8Array|undefined
    if(input.selection){const rect=input.selection;bounds(rect.x,rect.y,rect.width,rect.height,document.width,document.height);mask=new Uint8Array(document.width*document.height);for(let y=rect.y;y<rect.y+rect.height;y++)mask.fill(1,y*document.width+rect.x,y*document.width+rect.x+rect.width)}
    const pixels=recolorLayerComposite(layers,document.width,document.height,{mode:input.mode,radius:input.radius,strength:input.strength,selectionExpansion:input.selection_expansion,sampleOutside:input.sample_outside,sampleMargin:input.sample_margin,frameWidth:document.width,frameHeight:document.frameHeight??document.height/document.frameCount},mask)
    model.changeDocument(uiText("ui.mcpOperations.mcpSyntheticHeavyColor"),()=>layers.forEach((layer,index)=>{layer.pixels=pixels[index]}))
  }
  return {...textureInfo(document),saved:false,note:uiText("ui.mcpOperations.changesAreShownInTheEditorAnd")}
}
