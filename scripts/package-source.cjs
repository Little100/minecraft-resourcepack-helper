const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { zipSync, unzipSync } = require('fflate')
const { readReleaseVersion } = require('./package-vsix.cjs')

const root = path.resolve(__dirname, '..')
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const release = readReleaseVersion()
const prefix = `${metadata.name}-${release.label}-source/`
const output = path.join(root, `${metadata.name}-${release.label}-source.zip`)
const directories = ['resources', 'src', 'scripts', 'docs', 'schemas', 'syntaxes', 'images', 'web', 'locales']
const excluded = new Set(['node_modules', 'vendor', '.cache', '.git', 'tmp', 'out', 'web-dist', 'test', 'tests', 'tools'])
const files = Object.create(null)
const hashes = Object.create(null)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function include(relative) {
  const absolute = path.join(root, relative), stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink()) throw new Error('源码归档不接受符号链接: ' + relative)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) if (!excluded.has(name)) include(relative + '/' + name)
  } else if (stat.isFile()) {
    if (!relative.startsWith('resources/openp2p/') && /\.(?:vsix|jar|exe|dll|sqlite|db|pem|key)$/i.test(relative) || /(?:^|\/)\.env(?:\.|$)/.test(relative)) throw new Error('源码目录包含不应打包的文件: ' + relative)
    const bytes = fs.readFileSync(absolute)
    files[prefix + relative] = bytes; hashes[relative] = digest(bytes)
  } else throw new Error('源码目录包含非普通文件: ' + relative)
}
for (const name of fs.readdirSync(root).sort()) {
  if (directories.includes(name) || ['version', 'package.json', 'package-lock.json', 'package.nls.json', 'package.nls.zh-cn.json', 'build.js', 'README.md', 'README.vsix.md', 'LICENSE', 'CREDITS.md', '.gitignore', 'language-configuration.json'].includes(name) || /^tsconfig(?:\.(?:browser|webview))?\.json$/.test(name)) include(name)
}
for (const required of ['src/extension.ts', 'src/webview/preview.ts', 'src/webview/vanillaPreview.ts', 'scripts/package-source.cjs', 'scripts/package-vsix.cjs', 'scripts/verify-vsix.cjs', 'scripts/build-locales.cjs', 'scripts/client-renderer-capabilities.cjs', 'scripts/copy-openp2p.cjs', 'scripts/reset-generated-directory.cjs', 'package-lock.json', 'LICENSE', 'version']) assert.ok(hashes[required], '缺少构建源码: ' + required)
const artifact = path.join(root, `${metadata.name}-${release.version}.vsix`)
files[prefix + 'SOURCE-MANIFEST.json'] = Buffer.from(JSON.stringify({ version: release.label, createdAt: new Date().toISOString(), artifact: fs.existsSync(artifact) ? { name: path.basename(artifact), sha256: digest(fs.readFileSync(artifact)) } : undefined, sha256: hashes }, null, 2) + '\n')
const packed = zipSync(files, { level: 6 }), archive = unzipSync(packed)
assert.equal(Object.keys(archive).length, Object.keys(files).length)
for (const [relative, hash] of Object.entries(hashes)) assert.equal(digest(archive[prefix + relative]), hash, '源码校验不一致: ' + relative)
assert.ok(!Object.keys(archive).some(name => /\/(?:node_modules|tmp|vendor|\.git|out|web-dist|test|tests|tools)\//.test(name)), '归档包含本地运行文件')
fs.writeFileSync(output, packed)
console.log(`(源码归档已校验: ${path.basename(output)}，${Object.keys(hashes).length} 文件，${packed.length} 字节，SHA256=${digest(packed)})`)
