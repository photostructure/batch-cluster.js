import timers from "node:timers"
export const Timeout = Symbol("timeout")

export async function thenOrTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof Timeout> {
  // TODO: if timeoutMs is [1, 1000], it's probably a mistake. Should we do
  // something else in that case?
  return timeoutMs <= 1
    ? p
    : new Promise<T | typeof Timeout>(async (resolve, reject) => {
        let pending = true
        try {
          const t = timers.setTimeout(() => {
            if (pending) {
              pending = false
              resolve(Timeout)
            }
          }, timeoutMs)
          const result = await p
          if (pending) {
            pending = false
            clearTimeout(t)
            resolve(result)
          }
        } catch (err) {
          if (pending) {
            pending = false
            reject(err)
          }
        }
      })
}
