/** An executing task exhausted its fixed deadline or progress window. */
export class TaskTimeoutError extends Error {
  override readonly name = "TaskTimeoutError";

  constructor(readonly timeoutMillis: number) {
    super("timeout: waited " + timeoutMillis + "ms");
  }
}
