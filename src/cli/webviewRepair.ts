import { runWebviewRepair } from '../core/webviewRepair'

const job = process.argv[2]
if (!job) process.exitCode = 1
else void runWebviewRepair(job).catch(() => { process.exitCode = 1 })
