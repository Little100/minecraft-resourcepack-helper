const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const component = '(?:0|[1-9][0-9]*)'
const releasePattern = new RegExp(`^(?<version>${component}\\.${component}\\.${component})(?:-(?<channel>preview|beta))?$`)

function readReleaseVersion() {
  const label = fs.readFileSync(path.join(root, 'version'), 'utf8').trim()
  const match = releasePattern.exec(label)
  if (!match || match.groups.version.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error('version 文件应填写 X.Y.Z、X.Y.Z-preview 或 X.Y.Z-beta')
  }
  const { version, channel } = match.groups
  return { label, version, preRelease: channel !== undefined }
}

function packageVsix(args) {
  const { version, preRelease } = readReleaseVersion()
  if (!process.env.npm_execpath) throw new Error('请使用 npm run package 打包扩展')
  if (!preRelease && args.includes('--pre-release')) throw new Error('请用 version 文件的 -preview 或 -beta 后缀启用预发行')

  const vsce = process.env.VSCE_VERSION ? `@vscode/vsce@${process.env.VSCE_VERSION}` : '@vscode/vsce'
  const result = spawnSync(process.execPath, [
    process.env.npm_execpath, 'exec', '--ignore-scripts', '--package', vsce, '--', 'vsce',
    'package', version, '--no-update-package-json', '--no-dependencies', '--no-rewrite-relative-links',
    '--allow-missing-repository', '--readme-path', 'README.vsix.md', ...args,
    ...(preRelease ? ['--pre-release'] : [])
  ], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

if (require.main === module) {
  try {
    process.exitCode = packageVsix(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { readReleaseVersion }
