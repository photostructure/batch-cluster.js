/**
 * `BatchProcessOptions` have no reasonable defaults, as they are specific to
 * the API of the command that BatchCluster is spawning.
 *
 * All fields must be set.
 */
export interface BatchProcessOptions {
  /**
   * Low-overhead command to verify the child batch process has started
   * correctly. This "startup command" is invoked immediately after spawn, and
   * must complete successfully before any user tasks are assigned to the
   * process.
   *
   * Typically this runs a version check (like `-ver` for ExifTool), hence the
   * name. The command should be fast and reliable.
   *
   * If this command fails or times out (per {@link BatchClusterOptions.spawnTimeoutMillis}),
   * the process is considered broken and will be terminated.
   */
  versionCommand: string;

  /**
   * Called for each complete line written to stderr. Return `true` to discard
   * that line before it is logged, associated with a task, or treated as
   * taskless process output. The line ending is not included.
   *
   * Lines are assembled independently of stream chunk boundaries. An
   * unterminated fragment is evaluated before its task is parsed, when no more
   * stderr arrives for `streamFlushMillis`, or when the stream ends. The worker
   * is not assigned another task while a fragment is pending.
   *
   * Lines longer than 64 KiB bypass this callback and retain the normal stderr
   * behavior. If this callback throws, its line is retained and the worker is
   * ended with a `stderr.error`.
   *
   * Use this only for exact, known advisory lines. Every line for which this
   * returns `false` retains the normal, potentially fatal stderr behavior.
   * Defaults to `undefined`, which preserves the existing immediate handling
   * of every stderr chunk without line buffering.
   */
  shouldIgnoreStderrLine?: ((line: string) => boolean) | undefined;

  /**
   * If provided, and healthCheckIntervalMillis is greater than 0, or the
   * previous task failed, this command will be sent to child processes.
   *
   * If the command outputs to stderr or returns a fail string, the process will
   * be considered unhealthy and recycled. Lines discarded by
   * `shouldIgnoreStderrLine` do not count as stderr output.
   */
  healthCheckCommand?: string | undefined;

  /**
   * Expected text to print if a command passes. Cannot be blank. Strings will
   * be interpreted as a regular expression fragment.
   */
  pass: string | RegExp;

  /**
   * Expected text to print if a command fails. Cannot be blank. Strings will
   * be interpreted as a regular expression fragment.
   */
  fail: string | RegExp;

  /**
   * Command to end the child batch process. If not provided (or undefined),
   * stdin will be closed to signal to the child process that it may terminate,
   * and if it does not shut down within `endGracefulWaitTimeMillis`, it will be
   * SIGHUP'ed.
   */
  exitCommand?: string | undefined;
}
