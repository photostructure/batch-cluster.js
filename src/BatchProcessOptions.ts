/**
 * `BatchProcessOptions` have no reasonable defaults, as they are specific to
 * the API of the command that BatchCluster is spawning.
 *
 * All fields must be set.
 */
export interface BatchProcessOptions {
  /**
   * Low-overhead command to verify the child batch process has started. Will
   * be invoked immediately after spawn. This command must return before any
   * tasks will be given to a given process.
   */
  versionCommand: string

  /**
   * If provided, and healthCheckIntervalMillis is greater than 0, or the
   * previous task failed, this command will be sent to child processes.
   *
   * If the command outputs to stderr or returns a fail string, the process will
   * be considered unhealthy and recycled.
   */
  healthCheckCommand?: string | undefined

  /**
   * Expected text to print if a command passes. Cannot be blank. Strings will
   * be interpreted as a regular expression fragment.
   */
  pass: string | RegExp

  /**
   * Expected text to print if a command fails. Cannot be blank. Strings will
   * be interpreted as a regular expression fragment.
   */
  fail: string | RegExp

  /**
   * Command to end the child batch process. If not provided (or undefined),
   * stdin will be closed to signal to the child process that it may terminate,
   * and if it does not shut down within `endGracefulWaitTimeMillis`, it will be
   * SIGHUP'ed.
   */
  exitCommand?: string | undefined
}
