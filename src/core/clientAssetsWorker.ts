import './clientWorkerLanguage'
import { uiText } from '../i18n/messages'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import * as path from 'node:path'
import { planClientRelease, writeClientRelease } from './clientAssets'
import type { ClientAssetsWorkerMessage, ClientAssetsWorkerTask } from './clientAssetsWorkerProtocol'

// 后台使用相同的解包和检查规则
async function run(): Promise<void> {
  if (isMainThread || !parentPort) throw new Error(uiText("core.clientAssetsWorker.clientResourceWorkkerCanOnlyBeRun"))
  const port = parentPort, task = workerData as ClientAssetsWorkerTask
  const send = (message: ClientAssetsWorkerMessage, buffers: ArrayBuffer[] = []): void => port.postMessage(message, buffers)
  try {
    if (task.operation !== 'plan' && task.operation !== 'extract') throw new Error(uiText("core.clientAssetsWorker.invalidClientResourceBackOfficeJobType"))
    const plan = planClientRelease(task.jarFile, task.targetDir, task.version, progress => send({ type: 'progress', progress }), task.sourceManifest, task.operation === 'plan' ? task.options : undefined)
    if (task.operation === 'plan') {
      const buffers = plan.files.map(file => {
        const data = Uint8Array.from(file.data)
        file.data = data
        return data.buffer
      })
      send({ type: 'result', operation: 'plan', result: plan }, buffers)
    } else {
      if (plan.failedCount || !plan.versionConfirmed || !plan.files.some(file => path.relative(plan.root, file.target.fsPath).startsWith(`assets${path.sep}`))) throw new Error(uiText("core.clientAssetsWorker.clientResourceResolutionIncompletePreviewCacheNot"))
      const result = await writeClientRelease(plan, 'all', progress => send({ type: 'progress', progress }))
      send({ type: 'result', operation: 'extract', result })
    }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException
    send({ type: 'error', error: { name: failure?.name ?? 'Error', message: failure?.message ?? String(error), code: failure?.code, stack: failure?.stack } })
  } finally { port.close() }
}

void run()
