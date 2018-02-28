export function delay(millis: number): Promise<void> {
  return new Promise<void>(resolve =>
    global.setTimeout(() => resolve(), millis).unref()
  )
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
    const result = await f()
    if (result === true) {
      return true
    } else {
      await delay(50)
    }
  }
  return false
}
