import timers from "timers"

export function delay(millis: number, unref = false): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = timers.setTimeout(() => resolve(), millis)
    if (unref) t.unref()
  })
}

/**
 * Run the given thunk until the promise is resolved to true, or the timeout
 * passes.
 */
export async function until(
  f: (count: number) => boolean | Promise<boolean>,
  timeoutMs: number,
  delayMs = 50,
): Promise<boolean> {
  const timeoutAt = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < timeoutAt) {
    if (await f(count)) {
      return true
    } else {
      count++
      await delay(delayMs)
    }
  }
  return false
}

/**
 * @return a thunk that will call the underlying thunk at most every `minDelayMs`
 * milliseconds. The thunk will accept a boolean, that, when set, will force the
 * underlying thunk to be called (mostly useful for tests)
 */
export function ratelimit<T>(
  f: () => T,
  minDelayMs: number,
): () => T | undefined {
  let next = 0
  return (force?: boolean) => {
    if (Date.now() > next || force === true) {
      next = Date.now() + minDelayMs
      return f()
    } else {
      return
    }
  }
}
