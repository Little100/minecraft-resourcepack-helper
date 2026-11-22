import { uiText } from '../../i18n/messages'
export function readFileSync(): never { throw new Error(uiText("browser.shims.fs.couldNotCloseTemporaryFolderS")) }
export function statSync(): never { throw new Error(uiText("browser.shims.fs.couldNotCloseTemporaryFolderS")) }