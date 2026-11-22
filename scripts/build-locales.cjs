const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const catalog = locale => JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'))
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function nativeMessages() {
  const keys = [...new Set(Array.from(JSON.stringify(manifest()).matchAll(/"%([\w.-]+)%"/g), match => match[1]))].sort()
  for (const [locale, file] of [['en_us', 'package.nls.json'], ['zh_cn', 'package.nls.zh-cn.json']]) {
    const words = catalog(locale)
    const entries = keys.map(key => { if (!words[key]) throw Error('Missing manifest message: ' + key); return [key, words[key]] })
    fs.writeFileSync(path.join(root, file), JSON.stringify(Object.fromEntries(entries), null, 2) + '\n')
  }
}

function webMessages(directory) {
  const words = { ...catalog('zh_cn'), lang: 'zh-CN' }
  fs.cpSync(path.join(root, 'locales'), path.join(directory, 'locales'), { recursive: true })
  const template = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8')
  const html = template.replace(/\{\{([\w.]+)\}\}/g, (_, key) => {
    if (!words[key]) throw Error('Missing HTML message: ' + key)
    return words[key].replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  })
  fs.writeFileSync(path.join(directory, 'index.html'), html)
}

module.exports = { nativeMessages, webMessages }
