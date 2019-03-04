import { Writable } from "stream"

export function end(endable: Writable, contents?: string): Promise<void> {
  return new Promise<void>(resolve => endable.end(contents, resolve))
}
