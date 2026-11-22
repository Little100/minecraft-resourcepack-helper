import { uiText } from '../i18n/messages'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { pathKey, type ScannedPack } from '../core/packScanner'

type DecoratedPack = Pick<ScannedPack, 'root' | 'kind' | 'packFormat' | 'hasMetadata' | 'metadataIssue'> & Partial<Pick<ScannedPack, 'name'>>

interface PackMark {
  name: string
  packFormat?: number
  metadataIssue?: string
}

export class PackDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this.emitter.event

  private marks = new Map<string, PackMark>()

  static register(context: vscode.ExtensionContext): PackDecorationProvider {
    const provider = new PackDecorationProvider()
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider), provider)
    return provider
  }

  setPacks(packs: DecoratedPack[]): void {
    this.marks = new Map(
      packs
        .filter(p => p.kind === 'resourcepack')
        .map(p => [pathKey(p.root), { name: p.name ?? path.basename(p.root), packFormat: p.packFormat, metadataIssue: p.metadataIssue }])
    )
    this.emitter.fire(undefined)
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined
    const mark = this.marks.get(pathKey(uri.fsPath))
    if (!mark) return undefined
    const format = mark.packFormat !== undefined ? String(mark.packFormat) : uiText("collaboration.openp2p.unknown")
    const status = mark.metadataIssue ? uiText("ui.packDecoration.status", mark.metadataIssue) : undefined
    return {
      badge: uiText("ui.packDecoration.package"),
      color: new vscode.ThemeColor('charts.green'),
      tooltip: [
        uiText("ui.packDecoration.materialPackages", mark.name),
        `pack_format: ${format}`,
        ...(status ? [status] : []),
        uiText("ui.packDecoration.in", path.dirname(uri.fsPath))
      ].join('\n')
    }
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
