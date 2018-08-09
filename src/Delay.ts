import { setTimeout } from "timers"
import { logger } from "./Logger"

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
  logger().info("until(): timeout in " + timeoutMs)
  while (Date.now() < timeoutAt) {
    const result = await f()
    if (result === true) {
      logger().info("until(): returning true")
      return true
    } else {
      logger().info("until(): waiting...")
      await delay(50)
      logger().info("until(): done waiting...")
    }
  }
  logger().info("until(): returning false")
  return false
}
