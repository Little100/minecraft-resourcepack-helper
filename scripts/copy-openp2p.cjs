const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function copyOpenP2P(destination = path.resolve(__dirname, '../out/data/openp2p')) {
  const source = path.resolve(__dirname, '../resources/openp2p')
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))
  if (manifest.protocol !== 1 || !Array.isArray(manifest.files)) throw Error('OpenP2P manifest invalid')
  const names = ['openp2p-mcrh-windows-amd64.exe', 'openp2p-mcrh-linux-amd64', 'openp2p-mcrh-windows-arm64.exe', 'openp2p-mcrh-linux-arm64']
  for (const name of names) {
    const entry = manifest.files.find(file => file.name === name), file = path.join(source, name), stat = fs.lstatSync(file), bytes = fs.readFileSync(file)
    if (!entry || !stat.isFile() || stat.isSymbolicLink() || bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('OpenP2P bundle checksum mismatch: ' + name)
  }
  fs.cpSync(source, destination, { recursive: true, filter: file => { if (fs.lstatSync(file).isSymbolicLink()) throw Error('OpenP2P bundle rejects links'); return true } })
  const guide = path.resolve(__dirname, '../docs/openp2p.md')
  const readme = path.join(destination, 'README.md')
  if (fs.existsSync(guide) && !fs.existsSync(readme)) fs.copyFileSync(guide, readme)
}
module.exports = { copyOpenP2P }
if (require.main === module) copyOpenP2P()
