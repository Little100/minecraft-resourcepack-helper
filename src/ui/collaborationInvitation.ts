import { uiText } from '../i18n/messages'
import * as vscode from 'vscode'
import { decodeInvitation, encodeInvitation } from '../collaboration/client'
import type { Invitation } from '../collaboration/types'

export async function copyCollaborationInvitation(input: Invitation): Promise<string | undefined> {
  let invitation = input
  if (!invitation.p2p && !invitation.node) {
    const url = await vscode.window.showInputBox({ title: uiText("ui.collaborationInvitation.httpsAddressAccessibleToClient"), value: invitation.url, prompt: uiText("ui.collaborationInvitation.openPortConnectionRequiresAPublicNetwork") })
    if (!url) return undefined
    invitation = decodeInvitation(JSON.stringify({ ...invitation, url }))
  }
  const text = encodeInvitation(invitation)
  await vscode.env.clipboard.writeText(text)
  if (await vscode.env.clipboard.readText() !== text) throw new Error(uiText("ui.collaborationInvitation.connectionInformationCouldNotBeWrittenTo"))
  return invitation.p2p ? uiText("ui.collaborationInvitation.p2pUuidInvitationCopiedToClipboardUuid", invitation.node) : uiText("ui.collaborationInvitation.connectionInformationCopiedToClipboardPleaseShare")
}
