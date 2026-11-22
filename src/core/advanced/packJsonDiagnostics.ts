import { uiText } from '../../i18n/messages'
import { createScanner, parseTree, ParseErrorCode, SyntaxKind, type Node, type ParseError } from 'jsonc-parser'

export interface JsonIssueLocation { line: number; column: number; excerpt: string }
export interface JsonInspectionIssue extends JsonIssueLocation { severity: 'error' | 'warning'; code: string; message: string; suggestion: string }
const messages: Partial<Record<ParseErrorCode, string>> = {
  [ParseErrorCode.InvalidSymbol]: uiText("core.advanced.packJsonDiagnostics.syntax"),
  [ParseErrorCode.InvalidNumberFormat]: uiText("core.advanced.packJsonDiagnostics.numericalFormatInvalid"),
  [ParseErrorCode.PropertyNameExpected]: uiText("core.advanced.packJsonDiagnostics.thisShouldBeTheFieldNameSurrounded"),
  [ParseErrorCode.ValueExpected]: uiText("core.advanced.packJsonDiagnostics.aValidJsonValueIsMissingHere"),
  [ParseErrorCode.ColonExpected]: uiText("core.advanced.packJsonDiagnostics.missingColonAfterFieldName"),
  [ParseErrorCode.CommaExpected]: uiText("core.advanced.packJsonDiagnostics.missingCommasBetweenAdjacentFieldsOrArrays"),
  [ParseErrorCode.CloseBraceExpected]: uiText("core.advanced.packJsonDiagnostics.missingClosedParenthesis"),
  [ParseErrorCode.CloseBracketExpected]: uiText("core.advanced.packJsonDiagnostics.missingClosedParenthesis_bbe972"),
  [ParseErrorCode.EndOfFileExpected]: uiText("core.advanced.packJsonDiagnostics.thereSMoreAfterTheRoot"),
  [ParseErrorCode.InvalidCommentToken]: uiText("core.advanced.packJsonDiagnostics.jsonDoesNotAllowComments"),
  [ParseErrorCode.UnexpectedEndOfComment]: uiText("core.advanced.packJsonDiagnostics.commentIsNotClosedAndJsonDoes"),
  [ParseErrorCode.UnexpectedEndOfString]: uiText("core.advanced.packJsonDiagnostics.stringMissingClosedDoubleQuotes"),
  [ParseErrorCode.UnexpectedEndOfNumber]: uiText("core.advanced.packJsonDiagnostics.numberContentIncomplete"),
  [ParseErrorCode.InvalidUnicode]: uiText("core.advanced.packJsonDiagnostics.unicodeIsIllegal"),
  [ParseErrorCode.InvalidEscapeCharacter]: uiText("core.advanced.packJsonDiagnostics.stringContainsInvalidTransposition"),
  [ParseErrorCode.InvalidCharacter]: uiText("core.advanced.packJsonDiagnostics.stringContainsInvalidCharacters")
}

export function inspectPackJson(text: string): JsonInspectionIssue[] {
  const errors: ParseError[] = [], issues: JsonInspectionIssue[] = []
  const lines = text.split(/\r\n|\r|\n/), starts = [0]
  const newline = /\r\n|\r|\n/g
  let match: RegExpExecArray | null
  while ((match = newline.exec(text))) starts.push(match.index + match[0].length)
  const location = (offset: number): JsonIssueLocation => {
    let low = 0, high = starts.length - 1
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (starts[middle]! <= offset) low = middle; else high = middle - 1 }
    const column = offset - starts[low]! + 1, line = lines[low] ?? '', left = Math.max(0, column - 121)
    return { line: low + 1, column, excerpt: (left ? '…' : '') + line.slice(left, left + 240) + (line.length > left + 240 ? '…' : '') }
  }
  const scanner = createScanner(text, true)
  let depth = 0, tokens = 0
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) depth++
    else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) depth--
    if (depth > 128 || ++tokens > 200000) return [{ severity: 'warning', code: 'json-budget', message: uiText("core.advanced.packJsonDiagnostics.jsonStructuresAboveFieldCheckBudget"), suggestion: uiText("core.advanced.packJsonDiagnostics.stillCheckTheBasicJsonSyntaxDuplicate"), ...location(scanner.getTokenOffset()) }]
  }
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false })
  const positions = new Set<number>()
  for (const error of errors.slice(0, 1000)) {
    if (positions.has(error.offset)) continue
    positions.add(error.offset)
    issues.push({ severity: 'error', code: 'json', message: messages[error.error] ?? uiText("core.advanced.packJsonDiagnostics.jsonSyntax"), suggestion: uiText("core.advanced.packJsonDiagnostics.recheckAfterAmendingTheSyntaxJsonUses"), ...location(error.offset) })
  }
  if (errors.length) {
    if (errors.length > 1000) issues.push({ severity: 'warning', code: 'json-budget', message: uiText("core.advanced.packJsonDiagnostics.thisDocumentHasTooManyGrammaticalProblems"), suggestion: uiText("core.advanced.packJsonDiagnostics.recheckTheDisplayedSyntaxAfterRepairingIt"), ...location(errors[1000]!.offset) })
    return issues
  }
  const visit = (node: Node, depth: number): void => {
    if (depth > 128 || issues.length >= 1000) return
    if (node.type === 'object') {
      const keys = new Map<string, number>()
      for (const property of node.children ?? []) {
        if (issues.length >= 1000) break
        const key = property.children?.[0]
        if (!key) continue
        const name = String(key.value), earlier = keys.get(name)
        if (earlier !== undefined) issues.push({ severity: 'warning', code: 'json-duplicate-key', message: uiText("core.advanced.packJsonDiagnostics.fieldRepeatTheDefinitionInTheSame", name), suggestion: uiText("core.advanced.packJsonDiagnostics.mergeOrRemoveDuplicateFieldsAnotherPlace", location(earlier).line), ...location(key.offset) })
        else keys.set(name, key.offset)
      }
    }
    for (const child of node.children ?? []) visit(child, depth + (child.type === 'object' || child.type === 'array' ? 1 : 0))
  }
  if (tree) visit(tree, 0)
  if (issues.length >= 1000) issues.push({ severity: 'warning', code: 'json-budget', message: uiText("core.advanced.packJsonDiagnostics.thereAreTooManyDuplicateFieldsIn"), suggestion: uiText("core.advanced.packJsonDiagnostics.recheckTheDisplayedDuplicateFieldAfterRepairing"), ...location(0) })
  return issues
}
