import { Writable } from "stream"

export function end(endable: Writable, contents?: string): Promise<void> {
  return new Promise<void>(resolve => {
    contents == null ? endable.end(resolve) : endable.end(contents, resolve)
  })
}
