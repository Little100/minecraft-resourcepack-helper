import { uiText } from '../i18n/messages'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import lockfile from 'proper-lockfile'
import { TODO_RESOURCE, TODO_MAX_BYTES, parseTodoBytes, type TodoItem } from './todos'
import { safeTarget, atomic } from '../collaboration/files'

export interface TodoState { items: TodoItem[]; revision: string }

export class TodoStore {
  constructor(readonly root: string) {}

  async read(): Promise<TodoState> {
    const target = await safeTarget(this.root, TODO_RESOURCE, true)
    try {
      const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.size > TODO_MAX_BYTES) throw new Error(uiText("core.todoStore.todoDocumentsExceedBudgetOrAreNot"))
      const bytes = await fs.readFile(target)
      return { items: parseTodoBytes(bytes).items, revision: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { items: [], revision: 'missing' }
    }
  }

  async update(revision: string, mutate: (items: TodoItem[]) => TodoItem[]): Promise<TodoState> {
    const target = await safeTarget(this.root, TODO_RESOURCE, true)
    await fs.mkdir(path.dirname(target), { recursive: true })
    let compromised = false
    const release = await lockfile.lock(path.dirname(target), { realpath: false, retries: { retries: 8, minTimeout: 30, maxTimeout: 250 }, onCompromised: () => { compromised = true } })
    try {
      const state = await this.read()
      if (state.revision !== revision) throw new Error(uiText("core.todoStore.todoHasBeenModifiedByOtherMembers"))
      const text = JSON.stringify({ version: 1, items: mutate(state.items) }, null, 2) + '\n'
      parseTodoBytes(Buffer.from(text))
      if (compromised || (await this.read()).revision !== revision) throw new Error(uiText("core.todoStore.todoChangedDuringEditingNoChangesBy"))
      await atomic(await safeTarget(this.root, TODO_RESOURCE, true), text)
      return await this.read()
    } finally { await release() }
  }
}
