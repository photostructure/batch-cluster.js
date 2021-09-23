import stream from "stream"

export function end(
  endable: stream.Writable,
  contents?: string
): Promise<void> {
  return new Promise<void>((resolve) => endable.end(contents, resolve))
}

export function mapNotDestroyed<T extends stream.Readable | stream.Writable, R>(
  obj: T | undefined | null,
  f: (t: T) => R
): R | undefined {
  return obj != null && !obj.destroyed ? f(obj) : undefined
}
