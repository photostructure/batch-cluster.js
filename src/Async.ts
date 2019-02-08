import { setTimeout } from "timers"

export function delay(millis: number, unref = false): Promise<void> {
  return new Promise<void>(resolve => {
    const t = setTimeout(() => resolve(), millis)
    if (unref) t.unref()
  })
}

/**
 * Run the given thunk until the promise is resolved to true, or the timeout
 * passes.
 */
export async function until(
  f: () => boolean | Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs
  while (Date.now() < timeoutAt) {
    if (await f()) {
      return true
    } else {
      await delay(50)
    }
  }
  return false
}

/**
 * Return a function that will, at most, run the given function once at a time.
 * Calls that occur during prior calls will no-op.
 */
export function serial<T>(f: () => Promise<T>): () => Promise<T | undefined> {
  let running = false
  return async () => {
    if (running) return
    running = true
    try {
      return await f()
    } finally {
      running = false
    }
  }
}

/**
 * Return a thunk that will call the underlying thunk at most every `minDelayMs`
 * milliseconds. The thunk will accept a boolean, that, when set, will force the
 * underlying thunk to be called (mostly useful for tests)
 */
export function ratelimit<T>(f: () => T, minDelayMs: number) {
  let next = 0
  return (force?: boolean) => {
    if (Date.now() > next || force) {
      next = Date.now() + minDelayMs
      return f()
    } else {
      return
    }
  }
}
