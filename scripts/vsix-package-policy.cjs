const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const packagedProjectLicense = 'LICENSE.txt'

const requiredResources = [
  'locales/zh_cn.json', 'locales/en_us.json', 'package.nls.json', 'package.nls.zh-cn.json',
  'out/mcp-cli.cjs', 'out/webview-repair.cjs',
  'out/data/openp2p/manifest.json', 'out/data/openp2p/openp2p-mcrh-windows-amd64.exe',
  'out/data/openp2p/openp2p-mcrh-linux-amd64', 'out/data/openp2p/openp2p-mcrh-windows-arm64.exe',
  'out/data/openp2p/openp2p-mcrh-linux-arm64',
  'out/extension.js', 'out/collaboration-cli.cjs', 'out/data/clientAssetsWorker.cjs',
  'out/data/packFormats.json', 'out/data/previewRendererCapabilities.json',
  'out/webview/collaboration.js', 'out/webview/collaboration.css',
  'out/webview/advanced.js', 'out/webview/advanced.css',
  'out/webview/paint.js', 'out/webview/paint.css',
  'out/webview/blockly.css', 'out/webview/blockly-media/sprites.svg',
  'out/webview/model-assets.zip', 'out/webview/vanillaPreview.js', 'out/webview/vanillaPreview.css',
  'out/webview/diagnosis.js', 'out/webview/diagnosis.css',
  'out/webview/guiPreview.js', 'out/webview/guiPreview.css',
  'out/webview/preview.js', 'out/webview/preview.css', 'out/webview/syntax.js', 'out/webview/syntax.css',
  'out/webview/tutorial.js', 'out/webview/tutorial.css', 'out/webview/sceneWorkbench.css', 'out/webview/studio.css',
  'out/webview/base.css', 'out/webview/codicon.css', 'out/webview/codicon.ttf', 'out/webview/logo.png',
  'out/webview/gitWorkbench.js', 'out/webview/gitWorkbench.css',
  'out/webview/todos.js', 'out/webview/todos.css', 'out/webview/workspacePanels.css',
  'out/data/conversion/kyanite-rules.json', 'out/data/conversion/compatibility.json',
  'out/data/lib-sources/block-model-renderer/package.json',
  'out/data/lib-sources/block-model-renderer/src/web.js',
  'out/data/lib-sources/block-model-renderer/src/core/data/items.json',
  'out/data/totem/steve.json', 'out/data/totem/alex.json',
  'images/icon.png', 'images/icon.svg', 'images/pack-default.png',
  'syntaxes/optifine.tmLanguage.json', 'schemas/pack.mcmeta.schema.json',
  'language-configuration.json', 'readme.md', packagedProjectLicense, 'package.json'
]
const extensionRoots = new Set(['locales', 'package.nls.json', 'package.nls.zh-cn.json', 'out', 'images', 'schemas', 'syntaxes', 'language-configuration.json', 'readme.md', packagedProjectLicense, 'CREDITS.md', 'package.json'])

function verifyPackageContents(archive) {
  const names = Object.keys(archive)
  for (const name of names) {
    if (!name.startsWith('extension/')) continue
    const relative = name.slice('extension/'.length)
    assert.ok(!relative.includes('\\') && !relative.split('/').some(part => part === '..' || part === '.'), '安装包包含异常路径: ' + relative)
    assert.ok(extensionRoots.has(relative.split('/')[0]), '安装包混入开发资料或非运行文件: ' + relative)
    assert.ok(!/\.map$/i.test(relative), '安装包不应包含调试 sourcemap: ' + relative)
    assert.ok(!/(?:^|\/)(?:node_modules|manual-test-[^/]+|docs|test|tests|tools|scripts|tmp|web-dist|\.mcrh|\.vscode-test)(?:\/|$)/i.test(relative), '安装包混入开发资料或缓存: ' + relative)
  }
  for (const relative of requiredResources) assert.ok(archive['extension/' + relative]?.length, '缺少扩展必需文件: ' + relative)
  const p2pRoot = 'extension/out/data/openp2p/'
  const manifest = JSON.parse(Buffer.from(archive[p2pRoot + 'manifest.json']).toString('utf8'))
  assert.equal(manifest.protocol, 1, 'OpenP2P 协议清单无效')
  for (const entry of manifest.files) {
    assert.ok(/^openp2p-mcrh-(?:windows|linux)-(?:amd64|arm64)(?:\.exe)?$/.test(entry.name), 'OpenP2P 程序路径无效')
    const bytes = archive[p2pRoot + entry.name]
    assert.equal(bytes?.length, entry.bytes, 'OpenP2P 程序大小不匹配')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'OpenP2P 程序校验失败')
  }
  return { files: names.length, extensionFiles: names.filter(name => name.startsWith('extension/')).length }
}

const licenseLocations = [
  ['LICENSE', packagedProjectLicense],
  ['CREDITS.md', 'CREDITS.md'],
  ['src/core/data/licenses', 'out/data/licenses'],
  ['src/core/data/conversion', 'out/data/conversion', /^\/[^/]+-LICENSE$/],
  ['src/core/data/totem/LICENSE.md', 'out/data/totem/LICENSE.md'],
  ['resources/openp2p/LICENSE', 'out/data/openp2p/LICENSE'],
  ['resources/openp2p/OpenP2P-LICENSE', 'out/data/openp2p/OpenP2P-LICENSE'],
  ['resources/openp2p/licenses', 'out/data/openp2p/licenses']
]

function fileSuffixes(file, suffix = '') {
  const info = fs.lstatSync(file, { throwIfNoEntry: false })
  if (!info) return []
  if (info.isFile()) return [suffix]
  assert.ok(info.isDirectory(), `许可来源不是普通文件或目录: ${file}`)
  return fs.readdirSync(file).flatMap(name => fileSuffixes(path.join(file, name), `${suffix}/${name}`))
}

function verifyRetainedLicenses(archive, root) {
  const names = Object.keys(archive)
  for (const [source, target, filter] of licenseLocations) {
    const original = path.join(root, source)
    const prefix = `extension/${target}`
    const expected = fileSuffixes(original).filter(suffix => !filter || filter.test(suffix)).sort()
    const packaged = names
      .filter(name => name === prefix || name.startsWith(`${prefix}/`))
      .map(name => name.slice(prefix.length))
      .filter(suffix => !filter || filter.test(suffix))
      .sort()
    assert.deepEqual(packaged, expected, `安装包许可清单与源码目录不一致: ${target}`)
    for (const suffix of expected) {
      assert.deepEqual(Buffer.from(archive[prefix + suffix]), fs.readFileSync(original + suffix), `安装包许可内容与源码不一致: ${target}${suffix}`)
    }
  }
}

module.exports = { packagedProjectLicense, requiredResources, verifyPackageContents, verifyRetainedLicenses }
