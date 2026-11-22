import { uiHtml, uiText } from '../i18n/messages'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { SceneStudioAssets } from './sceneStudioAssets'

interface TintBlockInput { ids: string[]; color: string; allFaces: boolean; properties?: Record<string,string> }
export interface TintBlockPreview { update(input: TintBlockInput): void; activate(active: boolean): void; receive(message: Record<string,unknown>): void; dispose(): void }

export function createTintBlockPreview(container: HTMLElement, post: (value:object)=>void, version: ()=>string): TintBlockPreview {
  container.innerHTML=`<div class="tint-preview-heading"><strong>${uiHtml("webview.tintBlockPreview.blockPreview")}</strong><button type="button" id="tint-load-resources">${uiHtml("webview.tintBlockPreview.readMaterialPackages")}</button></div><div class="tint-preview-controls"><label class="field">${uiHtml("tint.previewBlock")}<select id="tint-block-id"></select></label><label class="tint-compare"><input type="checkbox" id="tint-block-neutral">${uiHtml("tint.showUntinted")}</label></div><div id="tint-block-viewport" data-empty-label="${uiHtml('tint.waitForModel')}" data-loading-label="${uiHtml('tint.loadingModel')}" tabindex="0" aria-label="${uiHtml("webview.tintBlockPreview.dragAndRolledBlockPreview")}"></div><p id="tint-block-status" role="status" class="muted">${uiHtml("webview.tintBlockPreview.showActualSquaresAfterReadingTheCurrent")}</p>`
  const viewport=container.querySelector<HTMLElement>('#tint-block-viewport')!,status=container.querySelector<HTMLElement>('#tint-block-status')!,select=container.querySelector<HTMLSelectElement>('#tint-block-id')!,neutral=container.querySelector<HTMLInputElement>('#tint-block-neutral')!
  let input:TintBlockInput={ids:[],color:'#ffffff',allFaces:false},resources:SceneStudioAssets|undefined,renderer:THREE.WebGLRenderer|undefined,controls:OrbitControls|undefined,scene:THREE.Scene|undefined,camera:THREE.PerspectiveCamera|undefined,object:THREE.Object3D|undefined,active=false,closed=false,waiting=false,attemptedVersion='',sourceVersion='',revision=0,builtKey=''
  const disposeObject=(value:THREE.Object3D|undefined)=>{if(value){value.removeFromParent();(value.userData.studioDispose as (()=>void)|undefined)?.()}}
  function notify(text:string,state:string):void {status.textContent=text;viewport.dataset.state=state}
  function resize():void {if(!renderer||!camera)return;const width=Math.max(1,viewport.clientWidth),height=Math.max(1,viewport.clientHeight);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();draw()}
  function draw():void {if(active&&renderer&&scene&&camera)renderer.render(scene,camera)}
  function init():void {
    if(renderer||closed)return
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace
    viewport.append(renderer.domElement);scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(32,1,0.01,100);camera.position.set(2.6,1.9,2.6)
    scene.add(new THREE.AmbientLight(0xffffff,2.2));controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,0);controls.minDistance=1.5;controls.maxDistance=7;controls.enablePan=false;controls.addEventListener('change',draw);controls.update();resize()
  }
  function recolor():void {
    if(!object)return
    // Three 顶点颜色使用线性工作空间
    const color=neutral.checked?'#ffffff':input.color,tint=new THREE.Color(color)
    object.traverse(node=>{const mesh=node as THREE.Mesh,mask=mesh.userData.tintMask as Uint8Array|undefined;if(!mask||!mesh.isMesh)return;const colors=mesh.geometry.getAttribute('color');for(let index=0;index<mask.length;index++)if(mask[index])colors.setXYZ(index,tint.r,tint.g,tint.b);colors.needsUpdate=true})
    viewport.dataset.tint=color;draw()
  }
  async function build():Promise<void> {
    if(!active||!resources||!input.ids.length||closed)return
    const id=select.value,key=id+':'+input.allFaces+':'+JSON.stringify(input.properties??{})
    if(key===builtKey&&object){recolor();return}
    builtKey=key;const token=++revision,source=resources
    disposeObject(object);object=undefined;draw();notify(uiText("webview.tintBlockPreview.readingModelsAndTextures"),'loading')
    try{
      init()
      const next=await source.block({id:'tint-preview',resource:id,position:[0,0,0],properties:input.properties},'labPBR',{allFaces:input.allFaces})
      if(closed||token!==revision||resources!==source){disposeObject(next);return}
      object=next;scene!.add(next)
      const box=new THREE.Box3().setFromObject(next),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());next.position.sub(center)
      const distance=Math.max(size.x,size.y,size.z,0.3)*3.5;camera!.position.set(distance*.72,distance*.55,distance*.72);controls!.target.set(0,0,0);controls!.update()
      recolor();notify(id+' · '+(sourceVersion||uiText("ui.todoHost.currentResources"))+uiText("webview.tintBlockPreview.dragAndRotateRollerAndScaling")+(id.endsWith(':water')?uiText("webview.tintBlockPreview.staticSurfaceNoSimulationOfLightAndQualifier"):''),'ready')
    }catch(error){if(token!==revision||closed)return;builtKey='';notify(uiText("webview.tintBlockPreview.readableMaterialPackagesWithCompleteModelsAnd", String(error instanceof Error?error.message:error)),'error')}
  }
  function load(automatic:boolean):void {if(waiting||closed)return;waiting=true;attemptedVersion=version();notify(uiText("webview.tintBlockPreview.lookingForDiamondsResource"),'loading');post({command:'studioResources',automatic,targetVersion:version()})}
  function ensure():void {if(active&&attemptedVersion!==version())load(true);else void build()}
  container.querySelector('#tint-load-resources')!.addEventListener('click',()=>load(false));select.addEventListener('change',()=>void build());neutral.addEventListener('change',recolor)
  const observer=new ResizeObserver(resize);observer.observe(viewport)
  return {
    update(next){const previous=select.value;input=next;const ids=Array.from(select.options,option=>option.value);if(ids.join(' ')!==next.ids.join(' ')){select.replaceChildren(...next.ids.map(id=>new Option(id.replace(/^minecraft:/,''),id)));if(next.ids.includes(previous))select.value=previous}if(!next.ids.length){revision++;builtKey='';disposeObject(object);object=undefined;draw();notify(uiText("webview.tintBlockPreview.pleaseFillInAValidDyeingParameter"),'empty');return}recolor();ensure()},
    activate(value){active=value;if(active){resize();ensure()}},
    receive(message){
      if(message.type==='studioAsset'){resources?.accept(message);return}
      if(message.type==='studioResourcesCanceled'){if(waiting){waiting=false;notify(uiText("webview.tintBlockPreview.unreadSelectMaterialPackageAgain"),object?'ready':'empty')}return}
      if(message.type==='studioError'){if(waiting){waiting=false;notify((String(message.error)),'error');if(attemptedVersion!==version())ensure()}return}
      if(message.type!=='studioResources'||!Number.isSafeInteger(message.sessionId)||!Array.isArray(message.layers)||!Array.isArray(message.blocks))return
      const requestedVersion=waiting?attemptedVersion:version()
      waiting=false;revision++;builtKey='';disposeObject(object);object=undefined;resources?.dispose();resources=undefined;draw()
      if(!message.blocks.length){attemptedVersion='';notify(uiText("webview.tintBlockPreview.reloadBlockResources"),'empty');return}
      sourceVersion=typeof message.version==='string'?message.version:'';attemptedVersion=requestedVersion;resources=new SceneStudioAssets({sessionId:Number(message.sessionId),layers:message.layers as string[],version:sourceVersion||undefined},post);ensure()
    },
    dispose(){closed=true;revision++;observer.disconnect();disposeObject(object);resources?.dispose();controls?.dispose();renderer?.dispose();renderer?.forceContextLoss();viewport.replaceChildren()}
  }
}
