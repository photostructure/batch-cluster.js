import { Readable, Writable } from "node:stream";

export function destroy(stream: Readable | Writable | null) {
  try {
    // .end() may result in an EPIPE when the child process exits. We don't
    // care. We just want to make sure the stream is closed.
    stream?.removeAllListeners("error");
    // It's fine to call .destroy() on a stream that's already destroyed.
    stream?.destroy?.();
  } catch {
    // don't care
  }
}
