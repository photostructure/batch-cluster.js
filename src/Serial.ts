/**
 * Return a function that will, at most, run the given function once at a time.
 * Calls that occur during prior calls will no-op.
 */
export function serial<T>(f: () => Promise<T>): (() => Promise<T | undefined>) {
  let running = false
  return async () => {
    if (running) return
    running = true
    try {
      return f()
    } finally {
      running = false
    }
  }
}
