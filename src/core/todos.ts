import { uiText } from '../i18n/messages'
import { z } from 'zod'
export const TODO_RESOURCE = '.mcrh/todos.json'
export const TODO_MAX_BYTES = 1024 * 1024
export function isTodoResource(value: string): boolean {
  return /^assets\/[a-z0-9_.-]+\/.+/.test(value) && value.length <= 1024 && value.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && !/[\\\x00-\x1f<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^\.(?:git|mcrh)(?:$|[-.])/i.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))
}
export const TodoItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(4000).default(''),
  done: z.boolean(),
  resource: z.string().optional().refine(value => value === undefined || isTodoResource(value), uiText("core.todos.invalidMissionResourcePath")),
  updatedAt: z.string().datetime()
}).strict()
export const TodoRecordSchema = z.object({ version: z.literal(1), items: z.array(TodoItemSchema).max(5000) }).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, uiText("core.todos.repetitionOfTaskNumbers"))
export type TodoItem = z.infer<typeof TodoItemSchema>
export function parseTodos(text: string): z.infer<typeof TodoRecordSchema> {
  if (Buffer.byteLength(text, 'utf8') > TODO_MAX_BYTES) throw new Error(uiText("core.todos.todoFileExceedingMib"))
  return TodoRecordSchema.parse(JSON.parse(text))
}
export function parseTodoBytes(bytes: Uint8Array): z.infer<typeof TodoRecordSchema> {
  if (bytes.byteLength > TODO_MAX_BYTES) throw new Error(uiText("core.todos.todoFileExceedingMib"))
  return parseTodos(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}
