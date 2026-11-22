const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const output = path.join(ROOT, 'src/core/data/previewRendererCapabilities.json')
function readCapabilities() {
  const directory = path.join(ROOT, 'node_modules/block-model-renderer')
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const source = ts.createSourceFile('models.js', fs.readFileSync(path.join(directory, 'src/core/models.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const resolver = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveSpecialModel')
  assert.ok(resolver?.body, '渲染库缺少可核验的特殊模型解析器')
  const names = new Set(fs.readdirSync(path.join(directory, 'assets/additional/assets/block-model-renderer/models/item')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)))
  function visit(node) {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === 'originalType') {
      for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) names.add(clause.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(resolver.body)
  function literal(node, bindings = {}) {
    if (ts.isStringLiteral(node)) return node.text
    if (ts.isIdentifier(node) && Object.hasOwn(bindings, node.text)) return bindings[node.text]
    if (ts.isParenthesizedExpression(node)) return literal(node.expression, bindings)
    if (ts.isArrowFunction(node)) return literal(node.body, bindings)
    if (ts.isConditionalExpression(node)) return literal(node.whenFalse, bindings)
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text, literal(property.name, bindings)]
      assert.ok(ts.isPropertyAssignment(property), '特殊模型元数据必须是静态属性')
      return [property.name.text, literal(property.initializer, bindings)]
    }))
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => literal(span.expression, bindings) + span.literal.text).join('')
    throw new Error('不支持的渲染器元数据表达式: ' + node.getText(source))
  }
  const legacyDeclaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations).find(declaration => declaration.name.getText(source) === 'LEGACY_SPECIAL_ITEMS')
  assert.ok(legacyDeclaration?.initializer, '渲染库缺少 legacy special 声明')
  const legacySpecialItems = literal(legacyDeclaration.initializer)
  for (const statement of source.statements) {
    if (!ts.isForOfStatement(statement) || !ts.isArrayLiteralExpression(statement.expression) || !statement.statement.getText(source).includes('LEGACY_SPECIAL_ITEMS')) continue
    const variable = statement.initializer.declarations?.[0]?.name.getText(source)
    assert.ok(variable && ts.isBlock(statement.statement), 'legacy special 颜色扩展结构已改变')
    for (const color of statement.expression.elements.map(value => literal(value))) for (const entry of statement.statement.statements) {
      const assignment = entry.expression
      assert.ok(assignment && ts.isBinaryExpression(assignment) && ts.isElementAccessExpression(assignment.left), 'legacy special 赋值结构已改变')
      legacySpecialItems[literal(assignment.left.argumentExpression, { [variable]: color })] = literal(assignment.right, { [variable]: color })
    }
  }
  const modelsRoot = path.join(directory, 'assets/additional/assets/block-model-renderer/models')
  function textures(id, seen = new Set()) {
    if (seen.has(id)) return {}
    seen.add(id)
    const file = path.join(modelsRoot, id + '.json')
    if (!fs.existsSync(file)) return {}
    const model = JSON.parse(fs.readFileSync(file, 'utf8')), prefix = 'block-model-renderer:'
    return { ...(typeof model.parent === 'string' && model.parent.startsWith(prefix) ? textures(model.parent.slice(prefix.length), seen) : {}), ...model.textures }
  }
  const specialTypes = [...names].sort()
  const specialTextures = Object.fromEntries(specialTypes.map(type => [type, [...new Set(Object.values(textures('item/' + type)).filter(value => typeof value === 'string' && !value.startsWith('#')))]]))
  return { package: metadata.name, version: metadata.version, source: 'src/core/models.js:resolveSpecialModel + LEGACY_SPECIAL_ITEMS + assets/additional model textures', specialTypes, legacySpecialItems, specialTextures }
}
function verifyRendererCapabilities() { assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), readCapabilities(), '渲染能力清单与安装依赖不一致，请运行 node scripts/client-renderer-capabilities.cjs --write 后核对变更') }
if (require.main === module) {
  if (process.argv.includes('--write')) fs.writeFileSync(output, JSON.stringify(readCapabilities(), null, 2) + '\n')
  else verifyRendererCapabilities()
}
module.exports = { verifyRendererCapabilities }
