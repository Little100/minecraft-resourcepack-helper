const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { createHash } = require('node:crypto')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const { unzipSync, strFromU8 } = require('fflate')
const { requiredResources, verifyPackageContents, verifyRetainedLicenses } = require('./vsix-package-policy.cjs')
const { readReleaseVersion } = require('./package-vsix.cjs')

const root = path.resolve(__dirname, '..')
const buildRoot = path.resolve(process.env.MCRH_VERIFY_BUILD_ROOT || root)
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const release = readReleaseVersion()
const artifact = path.resolve(root, process.argv[2] || manifest.name + '-' + release.version + '.vsix')
const archive = unzipSync(fs.readFileSync(artifact))
verifyPackageContents(archive)
verifyRetainedLicenses(archive, root)
const metadata = JSON.parse(strFromU8(archive['extension/package.json']))
assert.equal(metadata.version, release.version, 'VSIX 版本必须与 version 文件一致')
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
assert.equal(lock.version, manifest.version, '锁文件版本必须与开发清单一致')
assert.equal(lock.packages[''].version, manifest.version, '锁文件根包版本必须与开发清单一致')
const vsixManifest = strFromU8(archive['extension.vsixmanifest'])
assert.ok(vsixManifest.includes('Version="' + release.version + '"'), 'VSIX 安装元数据版本必须与扩展一致')
const isPreRelease = vsixManifest.includes('Id="Microsoft.VisualStudio.Code.PreRelease"')
assert.equal(isPreRelease, release.preRelease, 'VSIX 预发行标记与 version 文件不一致')
assert.equal(metadata.main, './out/extension.js')
assert.equal(metadata.contributes.configuration.properties['mcrh.mcp.enabled'].default, true, 'MCP 新工作区默认开启')
for (const containers of Object.values(metadata.contributes.viewsContainers || {})) for (const container of containers) {
  if (typeof container.icon === 'string' && !container.icon.startsWith('$(')) assert.ok(archive['extension/' + container.icon]?.length, '活动栏引用图标必须打入安装包: ' + container.icon)
}
const expectedView = manifest.contributes.views.mcrh.find(view => view.id === 'mcrh.sidebar')
assert.equal(metadata.contributes.views.mcrh.find(view => view.id === 'mcrh.sidebar')?.name, expectedView.name)
const shippedZh = JSON.parse(strFromU8(archive['extension/locales/zh_cn.json']))
const bundled = strFromU8(archive['extension/out/extension.js'])
for (const feature of ['mcrhPreviewSession', 'registerWebviewPanelSerializer', 'mcrh.createFontTemplate', 'mcrh.createCustomModelData', 'mcrh.insertFontGlyph']) assert.ok(bundled.includes(feature), '安装包缺少预览恢复或模板功能: ' + feature)
for (const type of ['mcrh.preview', 'mcrh.syntaxPreview', 'mcrh.vanillaPreview', 'mcrh.guiPreview']) assert.ok(metadata.activationEvents.includes('onWebviewPanel:' + type), '安装包缺少恢复激活事件: ' + type)
assert.ok(strFromU8(archive['extension/out/webview/vanillaPreview.js']).includes('vp-cmd-value'), '安装包缺少 CMD 预览控件')
assert.ok(strFromU8(archive['extension/out/webview/syntax.js']).includes('mcrh-font-glyph'), '安装包缺少 Unicode 字形渲染')
for (const command of ['mcrh.createVanillaTemplate', 'mcrh.applyJsonFamily']) {
  assert.ok(metadata.contributes.commands.some(value => value.command === command), '安装包缺少原版编写命令: ' + command)
  assert.ok(metadata.activationEvents.includes('onCommand:' + command) && bundled.includes(command), '原版编写命令未接入实际宿主: ' + command)
}
assert.ok(strFromU8(archive['extension/out/webview/syntax.js']).includes('applyJsonFamily'), 'JSON语法预览缺少批量套用按钮')
assert.ok(strFromU8(archive['extension/out/webview/vanillaPreview.js']).includes('vanillaApplyFamily'), '3D模型JSON缺少批量套用按钮')
const authoringStart = bundled.indexOf('// src/ui/vanillaTemplates.ts'), authoringEnd = bundled.indexOf('// src/ui/resourceAuthoringPreview.ts', authoringStart)
assert.ok(authoringStart >= 0 && authoringEnd > authoringStart, '缺少实际原版模板宿主模块')
const authoringSource = ts.createSourceFile('vanillaTemplates.js', bundled.slice(authoringStart, authoringEnd), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), authoringLabels = []
function inspectAuthoringLabel(node) { if (ts.isStringLiteralLike(node)) authoringLabels.push(shippedZh[node.text] ?? node.text); ts.forEachChild(node, inspectAuthoringLabel) }
inspectAuthoringLabel(authoringSource)
assert.ok(authoringLabels.some(value => value.includes('导入 OGG')) && authoringLabels.some(value => value.includes('原版资源模板')), '缺少音效原生模板向导')
const mcpCli = strFromU8(archive['extension/out/mcp-cli.cjs'])
for (const feature of ['paint_texture', 'texture_history']) {
  assert.ok(bundled.includes(feature) && mcpCli.includes(feature), '绘图工具必须同时存在于 MCP CLI 与编辑器宿主: ' + feature)
}
assert.ok(mcpCli.includes('include_pixels'), 'MCP CLI 包含精确像素参数')
const sidebarStart = bundled.indexOf('var SidebarTreeProvider = class')
assert.ok(sidebarStart >= 0, '实际构建缺少侧栏类声明')
const nextModule = bundled.indexOf('\n// src/', sidebarStart)
const sidebarText = bundled.slice(sidebarStart, nextModule < 0 ? undefined : nextModule)
assert.ok(sidebarText.length < 128 * 1024, '侧栏校验范围异常')
const source = ts.createSourceFile('sidebar-bundle.js', sidebarText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
let sidebar
function locate(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'SidebarTreeProvider' && node.initializer && ts.isClassExpression(node.initializer)) sidebar = node.initializer
  ts.forEachChild(node, locate)
}
locate(source)
assert.ok(sidebar, '打包代码缺少实际侧栏 provider')
const children = sidebar.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(source) === 'getChildren')
assert.ok(children?.body)
const returns = children.body.statements.filter(statement => ts.isReturnStatement(statement))
const top = returns.at(-1).expression
assert.ok(ts.isArrayLiteralExpression(top), '实际顶层节点需要显式可核验')
const label = node => {
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'uiText' && ts.isStringLiteral(node.arguments[0])) return shippedZh[node.arguments[0].text]
}
const roots = top.elements.map(node => { assert.ok(ts.isNewExpression(node)); return { type: node.expression.getText(source), args: [...node.arguments] } })
assert.equal(label(roots[0].args[0]), '高级材质工作台')
assert.equal(roots[0].type, 'InfoNode')
const command = roots[0].args[2]
assert.ok(ts.isObjectLiteralExpression(command))
assert.equal(label(command.properties.find(property => property.name?.getText(source) === 'command').initializer), 'mcrh.openAdvancedWorkbench')
assert.equal(label(roots.at(-1).args[1]), 'tutorial')
for (const [entryLabel, commandId] of [['一键诊断资源包', 'mcrh.diagnosePack'], ['版本转换', 'mcrh.convertPackVersion'], ['协作与审查', 'mcrh.openCollaboration']]) {
  const entry = roots.find(value => label(value.args[0]) === entryLabel)
  assert.ok(entry, '实际侧栏缺少直达入口: ' + entryLabel)
  const action = entry.args[2]
  assert.ok(ts.isObjectLiteralExpression(action))
  assert.equal(label(action.properties.find(property => property.name?.getText(source) === 'command').initializer), commandId)
  assert.ok(metadata.contributes.commands.some(value => value.command === commandId), '扩展清单没有声明命令: ' + commandId)
  assert.ok(bundled.includes(commandId), '扩展没有注册实际命令: ' + commandId)
}

let tutorialVerified = false
function inspect(node) {
  if (ts.isIfStatement(node) && /element\.section\s*===\s*["']tutorial["']/.test(node.expression.getText(source))) {
    const block = node.thenStatement
    const statement = block.statements.find(item => ts.isReturnStatement(item))
    assert.ok(statement && ts.isArrayLiteralExpression(statement.expression))
    for (const item of statement.expression.elements) assert.notEqual(label(item.arguments[0]), '高级材质工作台', '教程内不能保留工作台入口')
    tutorialVerified = true
  }
  ts.forEachChild(node, inspect)
}
inspect(children)
assert.ok(tutorialVerified)
for (const relative of requiredResources) {
  const packaged = archive['extension/' + relative]
  assert.ok(packaged, '缺少运行资源: ' + relative)
  const builtPath = path.join(buildRoot, relative === 'readme.md' ? 'README.vsix.md' : relative)
  if (!fs.existsSync(builtPath)) continue
  const built = fs.readFileSync(builtPath)
  if (relative === 'package.json') {
    assert.deepEqual(metadata, { ...JSON.parse(built), version: release.version }, 'VSIX 清单必须匹配开发清单和 version 文件')
  } else {
    assert.equal(digest(packaged), digest(built), 'VSIX 不是当前构建内容: ' + relative)
  }
}
for (const command of ['vanillaSelectTarget', 'vanillaTargets', 'vanillaRepairClient', 'packToolsImport', 'packToolsImages', 'packToolsSave', 'modTexturesImport', 'referenceImages']) {
  assert.ok(bundled.includes(command), '实际扩展缺少功能通信: ' + command)
}
const paint = strFromU8(archive['extension/out/webview/paint.js'])
for (const feature of ['data-paint-import', 'mp-effect-entry', 'choose-files', 'resourceurls', 'codefiles']) assert.ok(paint.includes(feature), '画布产物缺少本轮导入、参考图或固定工具入口: ' + feature)
assert.ok(paint.includes('referenceImages') && paint.includes('reference-panel'), '画布缺少参考图面板和读取通道')
assert.ok(paint.includes('mp-effect-dialog') && paint.includes('data-resolution-warning') && paint.includes('data-transform-apply'), '画布产物缺少边缘重着色、单帧尺寸提示或图层变换入口')
for (const feature of ['data-edge-transition', 'transitionSource', 'transitionSide', 'transitionSteps', 'data-edge=compare']) assert.ok(paint.includes(feature), '画布产物缺少中间色过渡或原图对比: ' + feature)
assert.ok(bundled.includes('clientAssetsWorker.cjs'), '扩展产物未引用客户端资源解包 worker')
assert.ok(paint.includes('pen-nib') && paint.includes('m14 4 6 6-4 8-12 2L6 8Z'), '实际画布必须打入钢笔笔尖 SVG')
assert.ok(!paint.includes('debug-line-by-line'), '钢笔不能仍映射调试图标')
const paintSource = ts.createSourceFile('paint.js', paint, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const paintStrings = []
function inspectPaintLabel(node) {
  if (ts.isStringLiteralLike(node)) paintStrings.push(node.text)
  ts.forEachChild(node, inspectPaintLabel)
}
inspectPaintLabel(paintSource)
assert.ok(paintStrings.includes('画笔不透明度') && paint.includes('mp-brush-opacity'), '画笔产物缺少独立不透明度控件')
const diagnosis = strFromU8(archive['extension/out/webview/diagnosis.js'])
for (const feature of ['diagnosisReport', 'diagnosisRerun', 'diagnosisOpenIssue', 'diagnosis-file-list']) assert.ok(diagnosis.includes(feature), '问题页面缺少运行内容: ' + feature)
assert.ok(bundled.includes('mcrh.packDiagnosis'), '桌面诊断没有使用独立问题页面')
for (const command of ['mcrh.showLogs', 'mcrh.showWebviewDiagnostics', 'mcrh.exportWebviewDiagnostics', 'mcrh.webviewReloadAdvice', 'mcrh.recoverWebviews']) {
  assert.ok(metadata.contributes.commands.some(value => value.command === command), '清单缺少排障命令: ' + command)
  assert.ok(metadata.activationEvents.includes('onCommand:' + command), '缺少排障命令激活项: ' + command)
  assert.ok(bundled.includes(command), '扩展产物缺少排障命令: ' + command)
}
for (const feature of ['__mcrhWebviewDiagnostic', 'editRandomVariant', 'includeMcrhEditorData', 'generateRandomBlockPatch', 'mcrh.addRandomTextures']) assert.ok(bundled.includes(feature), '扩展产物缺少随机/日志/导出功能: ' + feature)
for (const feature of ['添加随机贴图', 'randomVariants', 'editRandomVariant', 'includeMcrh', 'randomVariant']) assert.ok(paint.includes(feature) || paintStrings.some(value => value.includes(feature)), '像素编辑器缺少随机图层功能: ' + feature)
if (process.env.MCRH_VERIFY_P2P === '1') {
  const collaboration = strFromU8(archive['extension/out/webview/collaboration.js'])
  for (const feature of ['mcrh://p2p/', 'MCRH_P2P_ALLOWED_PORT', 'mcrh-capabilities', 'textureResolution', 'ensureCachedClientJar', 'client-cache']) assert.ok(bundled.includes(feature), '扩展产物缺少 UUID/端口保护/分辨率功能: ' + feature)
  assert.ok(collaboration.includes('p2pUuid'), '协作页面缺少 UUID 状态显示')
  assert.ok(strFromU8(archive['extension/out/data/clientAssetsWorker.cjs']).includes('resizeClientReleaseTextures'), '资源提取 worker 缺少分辨率处理')
  assert.ok(!Object.keys(archive).some(name => /openp2p.*(?:\.exe|amd64)$/.test(name)), '可选 P2P 程序不能内置到 VSIX')
}
assert.ok(!Object.keys(archive).some(name => /modelEditor(?:Uv|Display)?\.css$/.test(name)), '不应打包已移除的模型编辑器样式')
const gui = strFromU8(archive['extension/out/webview/guiPreview.js'])
for (const feature of ['guiReady', 'guiData', 'guiScene', 'guiOpenTexture', 'guiPrepareVanilla', 'guiSelectScene']) assert.ok(gui.includes(feature), 'GUI / HUD 页面缺少运行协议: ' + feature)
assert.ok(metadata.contributes.commands.some(command => command.command === 'mcrh.previewGui'), 'GUI / HUD 命令必须在安装包中注册')
assert.ok(bundled.includes('mcrh.guiPreview') && bundled.includes('stretch_inner'), '扩展必须包含 GUI 宿主与原版缩放解析')
const preview = strFromU8(archive['extension/out/webview/vanillaPreview.js'])
for (const feature of ['presentation-gui-hotbar', 'presentation-fixed-wall', 'presentation-fixed-backing']) assert.ok(preview.includes(feature), '预览产物缺少独立场景几何: ' + feature)
for (const command of ['vanillaSelectTarget', 'vanillaTargets', 'vanillaLoading', 'vanillaRepairClient', 'vp-model-inspector', 'vp-inspector-uv', '__mcrhSource']) assert.ok(preview.includes(command), '实际预览缺少协议: ' + command)
assert.ok(bundled.includes('all-safe-assets') && bundled.includes('preview-assets'), '实际扩展必须包含完整客户端资源提取和独立预览缓存')
const advanced = strFromU8(archive['extension/out/webview/advanced.js'])
for (const command of ['packToolsImport', 'packToolsSave', 'packToolsBaseline', 'packToolsProject', 'data-diagnosis-report']) assert.ok(advanced.includes(command), '实际工作台缺少材质包管理通信: ' + command)
for (const feature of ['oldPBR', 'uEnvironmentIntensity', 'studio-light-', 'materialProfiles', 'fresnel']) assert.ok(advanced.includes(feature), '实际工作台缺少 PBR/材质积木功能: ' + feature)
for (const feature of ['batch-mask', 'batch-ctm', 'edge-transition', 'batch-transition-source', 'tintPreset', 'tint-preset-preview', 'tint-block-viewport', 'tint-block-neutral', 'export-options-panel', 'MCRH-REQUIREMENTS.txt']) assert.ok(advanced.includes(feature), '实际工作台缺少批处理与染色功能: ' + feature)
for (const feature of ['subtract', 'intersect', 'xor', 'invertSelection', 'selectAll']) assert.ok(paint.includes(feature), '实际画布缺少选区功能: ' + feature)
assert.ok(preview.includes('dropped'), '实际预览缺少独立掉落物场景')
for (const feature of ['vscode-userdata', 'mcrh.previewClientAssets']) assert.ok(bundled.includes(feature), '实际扩展缺少本地缓存兼容: ' + feature)
assert.ok(!Object.keys(archive).some(name => /^extension\/(?:tmp|test|web-dist|node_modules|\.vscode-test)\//.test(name)))
console.log('(VSIX 实际代码校验通过: ' + path.basename(artifact) + '；工作台独立位于顶部，教程无嵌套入口，预览与材质包管理已打入，脚本和样式匹配当前构建，许可匹配源码留存文件)')
