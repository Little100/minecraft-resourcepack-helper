import { workerData } from 'node:worker_threads'
import { languageGlobals, type UiLanguage } from '../i18n/locale'

const task = workerData as { interfaceLanguage?: UiLanguage } | null
if (task?.interfaceLanguage) languageGlobals.__MCRH_LANGUAGE__ = task.interfaceLanguage
