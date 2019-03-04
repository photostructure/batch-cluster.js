import { setTimeout } from "timers"

import { filterInPlace } from "./Array"
import { Deferred } from "./Deferred"
import { map } from "./Object"

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
export function atMostOne<T>(
  f: () => Promise<T>
): () => Promise<T | undefined> {
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
 * Return a function that will only invoke the given thunk after all prior given
 * promises have resolved or rejected.
 */
export function serial<T>(): (f: () => Promise<T>) => Promise<T> {
  const priors: Deferred<T>[] = []
  return (f: () => Promise<T>) => {
    filterInPlace(priors, ea => ea.pending)
    const d = new Deferred<T>()
    // tslint:disable-next-line: no-floating-promises
    Promise.all(priors.map(ea => ea.promise))
      .then(() => f())
      .then(ea => d.resolve(ea))
    priors.push(d)
    return d.promise
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
    if (Date.now() > next || force === true) {
      next = Date.now() + minDelayMs
      return f()
    } else {
      return
    }
  }
}

/**
 * @returns a function that accepts a thunk. The thunk will be debounced.
 */
export function debounce(timeoutMs: number): (f: () => any) => void {
  let lastTimeout: NodeJS.Timer | undefined
  return (f: () => any) => {
    map(lastTimeout, clearTimeout)
    lastTimeout = setTimeout(f, timeoutMs)
  }
}
