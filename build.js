const { build, context } = require('esbuild')
const { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } = require('node:fs')
const { resetGeneratedDirectory } = require('./scripts/reset-generated-directory.cjs')
const { join } = require('node:path')

const isWatch = process.argv.includes('--watch')
const outdir = 'out'

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const to = join(dest, entry)
    if (statSync(from).isDirectory()) copyTree(from, to)
    else copyFileSync(from, to)
  }
}

const clientAssetsWorkerPath = 'data/clientAssetsWorker.cjs'
const clientAssetsWorkerBuild = {
  entryPoints: ['src/core/clientAssetsWorker.ts'],
  bundle: true,
  outfile: `${outdir}/${clientAssetsWorkerPath}`,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  logLevel: 'info'
}

const extensionBuild = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: `${outdir}/extension.js`,
  platform: 'node',
    mainFields: ['module', 'main'],
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  external: ['vscode'],
  define: { __MCRH_CLIENT_ASSETS_WORKER_PATH__: JSON.stringify(clientAssetsWorkerPath) },
  logLevel: 'info'
}

const webviewBuilds = [
  { entry: 'src/webview/paint.ts', out: 'paint' },
  { entry: 'src/webview/tutorial.ts', out: 'tutorial' },
  { entry: 'src/webview/preview.ts', out: 'preview' },
  { entry: 'src/webview/syntax.ts', out: 'syntax' },
  { entry: 'src/webview/advanced.ts', out: 'advanced' },
  { entry: 'src/webview/vanillaPreview.ts', out: 'vanillaPreview' },
  { entry: 'src/webview/diagnosis.ts', out: 'diagnosis' },
  { entry: 'src/webview/guiPreview.ts', out: 'guiPreview' },
  { entry: 'src/webview/collaboration.ts', out: 'collaboration' },
  { entry: 'src/webview/gitWorkbench.ts', out: 'gitWorkbench' },
  { entry: 'src/webview/todos.ts', out: 'todos' }
].map(target => ({
  entryPoints: [target.entry],
  bundle: true,
  outfile: `${outdir}/webview/${target.out}.js`,
  platform: 'browser',
  loader: { '.svg': 'text' },
  inject: target.out === 'advanced' ? [require.resolve('./src/browser/shims/buffer.ts')] : [],
  alias: { 'node:zlib': require.resolve('./src/browser/shims/zlib.ts'), 'pngjs/browser': require.resolve('pngjs/browser'), pngjs: require.resolve('pngjs/browser') },
  target: 'chrome110',
  format: 'iife',
  sourcemap: false,
  minify: !isWatch,
  logLevel: 'info'
}))

function copyBlocklyAssets() {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<html><head></head><body><div id="workspace"></div></body></html>', { pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'ShadowRoot', 'DOMParser', 'XMLSerializer', 'Element', 'HTMLElement', 'SVGElement']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
  }
  const Blockly = require('blockly')
  const workspace = Blockly.inject(document.getElementById('workspace'), { renderer: 'geras', media: './blockly-media', sounds: false })
  const css = [...document.querySelectorAll('style')].map(style => style.textContent).join('\n').replace(/\.geras-renderer/g, '.mcrh_static-renderer').replace(/\.classic-theme/g, '.mcrh-theme')
  require('node:fs').writeFileSync(join(outdir, 'webview', 'blockly.css'), css)
  workspace.dispose()
  dom.window.close()
  copyTree('node_modules/blockly/media', join(outdir, 'webview', 'blockly-media'))
}

function copyAssets() {
  const codicons = join("node_modules", "@vscode", "codicons", "dist")
  mkdirSync(join(outdir, "webview"), { recursive: true })
  copyFileSync(join(codicons, "codicon.css"), join(outdir, "webview", "codicon.css"))
  copyFileSync(join(codicons, "codicon.ttf"), join(outdir, "webview", "codicon.ttf"))
  rmSync(join(outdir, "webview", "logo.svg"), { force: true })
  copyFileSync("images/icon.png", join(outdir, "webview", "logo.png"))
}

const webviewRepairBuild = { entryPoints: ['src/cli/webviewRepair.ts'], bundle: true, outfile: `${outdir}/webview-repair.cjs`, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'info' }

async function buildAll() {
  const root = realpathSync(__dirname)
  if (realpathSync(process.cwd()) !== root) throw new Error('Run the build from the project root')
  require('./scripts/build-locales.cjs').nativeMessages()
  require('./scripts/client-renderer-capabilities.cjs').verifyRendererCapabilities()
  resetGeneratedDirectory(root, join(outdir, 'data'))
  mkdirSync(`${outdir}/webview`, { recursive: true })
  await build(clientAssetsWorkerBuild)
  await build(extensionBuild)
  await build(webviewRepairBuild)
  await build({ entryPoints: ['src/cli/collaboration.ts'], bundle: true, outfile: `${outdir}/collaboration-cli.cjs`, platform: 'node', mainFields: ['module', 'main'], target: 'node22', format: 'cjs', external: ['vscode'], logLevel: 'info' })
  await build({ entryPoints: ['src/cli/mcp.ts'], bundle: true, outfile: `${outdir}/mcp-cli.cjs`, platform: 'node', target: 'node20', format: 'cjs', logLevel: 'info' })
  for (const webview of webviewBuilds) await build(webview)
  copyTree('src/webview/media', `${outdir}/webview`)
  require('node:fs').appendFileSync(`${outdir}/webview/advanced.css`, '\n' + require('node:fs').readFileSync('src/webview/media/studio.css', 'utf8'))
  require('node:fs').appendFileSync(`${outdir}/webview/advanced.css`, '\n' + require('node:fs').readFileSync('src/webview/media/diagnosis.css', 'utf8'))
  copyAssets()
  copyBlocklyAssets()
  copyFileSync('node_modules/block-model-renderer/assets.zip', `${outdir}/webview/model-assets.zip`)
  copyTree('node_modules/block-model-renderer/src', `${outdir}/data/lib-sources/block-model-renderer/src`)
  copyFileSync('node_modules/block-model-renderer/package.json', `${outdir}/data/lib-sources/block-model-renderer/package.json`)
  copyTree('src/core/data', `${outdir}/data`)
  require('./scripts/copy-openp2p.cjs').copyOpenP2P()
}

module.exports = { extensionBuild, clientAssetsWorkerBuild }

async function main() {
  await buildAll()
  if (isWatch) {
    const workerCtx = await context(clientAssetsWorkerBuild)
    await workerCtx.watch()
    const repairCtx = await context(webviewRepairBuild)
    await repairCtx.watch()
    const ctx = await context(extensionBuild)
    await ctx.watch()
    for (const webview of webviewBuilds) {
      const watchCtx = await context(webview)
      await watchCtx.watch()
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
