const fs = require('node:fs')
const path = require('node:path')

function resetGeneratedDirectory(projectRoot, relative) {
  const root = fs.realpathSync(projectRoot)
  const target = path.resolve(root, relative)
  const subpath = path.relative(root, target)
  const segments = subpath.split(path.sep)
  if (!subpath || segments[0] === '..' || path.isAbsolute(subpath)) {
    throw new Error(`Output directory is outside the project: ${target}`)
  }
  let directory = root
  for (const segment of segments) {
    directory = path.join(directory, segment)
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false })
    if (stat && !stat.isDirectory()) throw new Error(`Output path is not a regular directory: ${directory}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
}

module.exports = { resetGeneratedDirectory }
