export interface TimerApi {
  setTimeout(task: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Debounced {
  trigger(): void
  dispose(): void
}

const GLOBAL_TIMERS: TimerApi = {
  setTimeout: (task, delayMs) => setTimeout(task, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function createDebounced(task: () => void, delayMs: number, timers: TimerApi = GLOBAL_TIMERS): Debounced {
  let handle: unknown
  let armed = false

  const cancel = (): void => {
    if (!armed) return
    timers.clearTimeout(handle)
    armed = false
  }

  return {
    trigger(): void {
      cancel()
      armed = true
      handle = timers.setTimeout(() => {
        armed = false
        task()
      }, delayMs)
    },
    dispose: cancel
  }
}
