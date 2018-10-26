/**
 * Parser implementations convert stdout and stderr from the underlying child
 * process to a more useable format. This can be a no-op passthrough if no
 * parsing is necessary.
 */
export interface Parser<T> {
  /**
   * Invoked once per task.
   *
   * @param stdin the concatenated stream from `stdin`, stripped of the "PASS" or
   * "FAIL" tokens.
   * @param stderr if defined, includes all text emitted to stderr.
   *
   * @throws an error if the Parser implementation wants to reject the task. It is
   * valid to raise Errors if stderr is undefined.
   */
  (stdin: string, stderr: string | undefined): T
}
