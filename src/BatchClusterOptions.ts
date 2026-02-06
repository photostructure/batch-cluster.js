import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { logger, Logger } from "./Logger";
import { isMac, isWin } from "./Platform";

export const secondMs = 1000;
export const minuteMs = 60 * secondMs;

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
  maxProcs = 1;

  /**
   * Child processes will be recycled when they reach this age.
   *
   * If non-zero, this value must not be less than `spawnTimeoutMillis` or
   * `taskTimeoutMillis`.
   *
   * Defaults to 5 minutes. Set to 0 to disable.
   */
  maxProcAgeMillis = 5 * minuteMs;

  /**
   * This is the minimum interval between calls to BatchCluster's #onIdle
   * method, which runs general janitorial processes like child process
   * management and task queue validation.
   *
   * Must be &gt; 0. Defaults to 10 seconds.
   */
  onIdleIntervalMillis = 10 * secondMs;

  /**
   * Spawning new child processes and servicing a "version" task must not take
   * longer than `spawnTimeoutMillis` before the process is considered failed,
   * and need to be restarted. Be pessimistic here--windows can regularly take
   * several seconds to spin up a process, thanks to antivirus shenanigans.
   *
   * Defaults to 15 seconds. Set to 0 to disable.
   */
  spawnTimeoutMillis = 15 * secondMs;

  /**
   * If maxProcs &gt; 1, spawning new child processes to process tasks can slow
   * down initial processing, and create unnecessary processes.
   *
   * Must be &gt;= 0ms. Defaults to 1.5 seconds.
   */
  minDelayBetweenSpawnMillis = 1.5 * secondMs;

  /**
   * If commands take longer than this, presume the underlying process is dead
   * and we should fail the task.
   *
   * This should be set to something on the order of seconds to a minute, but at
   * least 2-10 times longer than the expected task duration under typical load.
   *
   * You don't want this set too low, or tasks may be marked as failed
   * unnecessarily!
   *
   * Defaults to 0 (disabled).
   */
  taskTimeoutMillis = 0;

  /**
   * Processes will be recycled after processing `maxTasksPerProcess` tasks.
   * Depending on the commands and platform, batch mode commands shouldn't
   * exhibit unduly memory leaks for at least tens if not hundreds of tasks.
   * Setting this to a low number (like less than 10) will impact performance
   * markedly, due to OS process start/stop maintenance. Setting this to a very
   * high number (> 1000) may result in more memory being consumed than
   * necessary.
   *
   * Must be &gt;= 0. Defaults to 500
   */
  maxTasksPerProcess = 500;

  /**
   * When `this.end()` is called, or Node broadcasts the `beforeExit` event,
   * this is the milliseconds spent waiting for currently running tasks to
   * finish before sending kill signals to child processes.
   *
   * Setting this value to 0 means child processes will immediately receive a
   * kill signal to shut down. Any pending requests may be interrupted. Must be
   * &gt;= 0. Defaults to 500ms.
   */
  endGracefulWaitTimeMillis = 500;

  /**
   * When a task's pass/fail token is detected on stderr, this is how long to
   * wait for stdout to flush before running the parser. Also used as the
   * fallback when {@link waitForStderrMillis} is not set.
   *
   * Since stdout is typically line-buffered, it may arrive after stderr, so
   * this value needs to be large enough for the OS to flush stdout.
   *
   * Note that this puts a hard lower limit on task latency for tasks whose
   * token is found on stderr. If you set this too low, tasks may be
   * erroneously resolved or rejected, and you'll see `noTaskData` events.
   *
   * Setting this to 0 will most likely result in internal errors (due to
   * stream buffers not being associated to tasks that were just settled).
   *
   * @see {@link waitForStderrMillis} for the stdout-to-stderr direction
   */
  // These values were found by trial and error using GitHub CI boxes, which
  // should be the bottom of the barrel, performance-wise, of any computer.
  streamFlushMillis = isMac ? 100 : isWin ? 200 : 30;

  /**
   * When a task's pass/fail token is detected on stdout, this is how long to
   * wait for stderr to flush before running the parser.
   *
   * Since stderr is typically unbuffered by the OS, it usually arrives before
   * or concurrently with stdout, so this can be much smaller than
   * {@link streamFlushMillis}.
   *
   * Defaults to {@link streamFlushMillis} for backward compatibility. Try
   * setting this to 5-10ms for a substantial latency improvement on passing
   * tasks.
   */
  waitForStderrMillis?: number;

  /**
   * Should batch-cluster try to clean up after spawned processes that don't
   * shut down?
   *
   * Only disable this if you have another means of PID cleanup.
   *
   * Defaults to `true`.
   */
  cleanupChildProcs = true;

  /**
   * If a child process is idle for more than this value (in milliseconds), shut
   * it down to reduce system resource consumption.
   *
   * A value of ~10 seconds to a couple minutes would be reasonable. Set this to
   * 0 to disable this feature.
   */
  maxIdleMsPerProcess = 0;

  /**
   * How many failed tasks should a process be allowed to process before it is
   * recycled?
   *
   * Set this to 0 to disable this feature.
   */
  maxFailedTasksPerProcess = 2;

  /**
   * If `healthCheckCommand` is set, how frequently should we check for
   * unhealthy child processes?
   *
   * Set this to 0 to disable this feature.
   */
  healthCheckIntervalMillis = 0;

  /**
   * Verify child processes are still running by checking the OS process table.
   *
   * Set this to 0 to disable this feature.
   */
  pidCheckIntervalMillis = 2 * minuteMs;

  /**
   * When true, child process streams (stdin, stdout, stderr) are unreferenced
   * so they don't prevent the parent Node.js process from exiting naturally.
   *
   * This allows scripts to exit without explicitly calling `.end()` on the
   * BatchCluster instance. The child processes will be cleaned up automatically
   * when the parent process exits.
   *
   * Set to `false` if you need the parent process to stay alive as long as
   * child processes are running (legacy behavior prior to v17).
   *
   * Defaults to `true`.
   *
   * @since 17.0.0
   */
  unrefStreams = true;

  /**
   * A BatchCluster instance and associated BatchProcess instances will share
   * this `Logger`. Defaults to the `Logger` instance provided to `setLogger()`.
   */
  logger: () => Logger = logger;

  /**
   * When true, BatchCluster registers `process.on("beforeExit")` and
   * `process.on("exit")` handlers to clean up child processes when the Node.js
   * process exits.
   *
   * The `beforeExit` handler calls `end(true)` for graceful shutdown.
   * The `exit` handler synchronously kills any remaining child processes.
   *
   * Set to `false` if you want to manage process cleanup yourself, or if you're
   * experiencing issues with these handlers interfering with your application's
   * exit behavior.
   *
   * Defaults to `true`.
   *
   * @since 17.1.0
   */
  cleanupChildProcsOnExit = true;
}

export interface WithObserver {
  observer: BatchClusterEmitter;
}
