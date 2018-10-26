
/**
 * These parameter values have somewhat sensible defaults, but can be
 * overridden for a given BatchCluster.
 */
export class BatchClusterOptions {
  /**
   * No more than `maxProcs` child processes will be run at a given time
   * to serve pending tasks.
   *
   * Defaults to 1.
   */
  readonly maxProcs: number = 1

  /**
   * Child processes will be recycled when they reach this age.
   *
   * If this value is set to 0, child processes will not "age out".
   *
   * This value must not be less than `spawnTimeoutMillis` or
   * `taskTimeoutMillis`.
   *
   * Defaults to 5 minutes.
   */
  readonly maxProcAgeMillis: number = 5 * 60 * 1000

  /**
   * This is the minimum interval between calls to `this.onIdle`, which
   * runs pending tasks and shuts down old child processes.
   *
   * Must be &gt; 0. Defaults to 5 seconds.
   */
  readonly onIdleIntervalMillis: number = 5000

  /**
   * If the initial `versionCommand` fails for new spawned processes more
   * than this rate, end this BatchCluster and throw an error, because
   * something is terribly wrong.
   *
   * If this backstop didn't exist, new (failing) child processes would be
   * created indefinitely.
   *
   * Must be &gt;= 0. Defaults to 10.
   */
  readonly maxReasonableProcessFailuresPerMinute: number = 10

  /**
   * Spawning new child processes and servicing a "version" task must not
   * take longer than `spawnTimeoutMillis` before the process is considered
   * failed, and need to be restarted. Be pessimistic here--windows can
   * regularly take several seconds to spin up a process, thanks to
   * antivirus shenanigans.
   *
   * Must be &gt;= 100ms. Defaults to 15 seconds.
   */
  readonly spawnTimeoutMillis: number = 15000

  /**
   * If commands take longer than this, presume the underlying process is dead
   * and we should fail the task.
   *
   * This should be set to something on the order of seconds.
   *
   * Must be &gt;= 10ms. Defaults to 10 seconds.
   */
  readonly taskTimeoutMillis: number = 10000

  /**
   * Processes will be recycled after processing `maxTasksPerProcess`
   * tasks. Depending on the commands and platform, batch mode commands
   * shouldn't exhibit unduly memory leaks for at least tens if not
   * hundreds of tasks. Setting this to a low number (like less than 10)
   * will impact performance markedly, due to OS process start/stop
   * maintenance. Setting this to a very high number (> 1000) may result in
   * more memory being consumed than necessary.
   *
   * Must be &gt;= 0. Defaults to 500
   */
  readonly maxTasksPerProcess: number = 500

  /**
   * When `this.end()` is called, or Node broadcasts the `beforeExit`
   * event, this is the milliseconds spent waiting for currently running
   * tasks to finish before sending kill signals to child processes.
   *
   * Setting this value to 0 means child processes will immediately receive
   * a kill signal to shut down. Any pending requests may be interrupted.
   * Must be &gt;= 0. Defaults to 500ms.
   */
  readonly endGracefulWaitTimeMillis: number = 500
}