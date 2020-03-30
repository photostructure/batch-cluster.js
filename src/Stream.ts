import { Readable, Writable } from "stream"

export function end(endable: Writable, contents?: string): Promise<void> {
  return new Promise<void>((resolve) => endable.end(contents, resolve))
}

export function mapNotDestroyed<T extends Readable | Writable, R>(
  obj: T | undefined | null,
  f: (t: T) => R
): R | undefined {
  return obj != null && !obj.destroyed ? f(obj) : undefined
}
