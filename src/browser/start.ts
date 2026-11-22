import { loadInterfaceLanguage } from './language'

void loadInterfaceLanguage().then(() => import('./index'))
