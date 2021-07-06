import { ChildProcessFactory } from "./BatchCluster"
import { BatchProcessOptions } from "./BatchProcessOptions"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { blank, toS } from "./String"
import { logger, Logger } from "./Logger"

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
  maxProcs = 1

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
  maxProcAgeMillis = 5 * 60 * 1000

  /**
   * This is the minimum interval between calls to `this.onIdle`, which
   * runs pending tasks and shuts down old child processes.
   *
   * Must be &gt; 0. Defaults to 5 seconds.
   */
  onIdleIntervalMillis = 5000

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
  maxReasonableProcessFailuresPerMinute = 10

  /**
   * Spawning new child processes and servicing a "version" task must not take
   * longer than `spawnTimeoutMillis` before the process is considered failed,
   * and need to be restarted. Be pessimistic here--windows can regularly take
   * several seconds to spin up a process, thanks to antivirus shenanigans.
   *
   * Must be &gt;= 100ms. Defaults to 15 seconds.
   */
  spawnTimeoutMillis = 15000

  /**
   * If maxProcs &gt; 1, spawning new child processes to process tasks can slow
   * down initial processing, and create unnecessary processes.
   *
   * Must be &gt;= 0ms. Defaults to 1.5 seconds.
   */
  minDelayBetweenSpawnMillis = 1500

  /**
   * If commands take longer than this, presume the underlying process is dead
   * and we should fail the task.
   *
   * This should be set to something on the order of seconds.
   *
   * Must be &gt;= 10ms. Defaults to 10 seconds.
   */
  taskTimeoutMillis = 10000

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
  maxTasksPerProcess = 500

  /**
   * When `this.end()` is called, or Node broadcasts the `beforeExit` event,
   * this is the milliseconds spent waiting for currently running tasks to
   * finish before sending kill signals to child processes.
   *
   * Setting this value to 0 means child processes will immediately receive a
   * kill signal to shut down. Any pending requests may be interrupted. Must be
   * &gt;= 0. Defaults to 500ms.
   */
  endGracefulWaitTimeMillis = 500

  /**
   * When a task sees a "pass" or "fail" from either stdout or stderr, it needs
   * to wait for the other stream to finish flushing to ensure the task's Parser
   * sees the entire relevant stream contents. A larger number may be required
   * for slower computers to prevent internal errors due to lack of stream
   * coercion.
   *
   * Note that this puts a hard lower limit on task latency. You don't want to
   * set this to a large number.
   *
   * Defaults to 10ms.
   */
  streamFlushMillis = 10

  /**
   * Should batch-cluster try to clean up after spawned processes that don't
   * shut down?
   *
   * Only disable this if you have another means of PID cleanup.
   *
   * Defaults to `true`.
   */
  cleanupChildProcs = true

  /**
   * If a child process is idle for more than this value (in milliseconds), shut
   * it down to reduce system resource consumption.
   *
   * A value of ~10 seconds to a couple minutes would be reasonable. Set this to
   * 0 to disable this feature.
   */
  maxIdleMsPerProcess = 0

  /**
   * How many failed tasks should a process be allowed to process before it is
   * recycled?
   *
   * Set this to 0 to disable this feature.
   */
  maxFailedTasksPerProcess = 2

  /**
   * If `healthCheckCommand` is set, how frequently should we check for
   * unhealthy child processes?
   *
   * Set this to 0 to disable this feature.
   */
  healthCheckIntervalMillis = 0

  /**
   * A BatchCluster instance and associated BatchProcess instances will share
   * this `Logger`. Defaults to the `Logger` instance provided to `setLogger()`.
   */
  logger: () => Logger = logger
}

export type AllOpts = BatchClusterOptions &
  InternalBatchProcessOptions &
  ChildProcessFactory

function toRe(s: string | RegExp) {
  return s instanceof RegExp
    ? s
    : new RegExp("^(?:([\\s\\S]*?)(?:\\r?\\n))?" + s + "(?:\\r?\\n)?$")
}

export function verifyOptions(
  opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory
): AllOpts {
  const result = {
    ...new BatchClusterOptions(),
    ...opts,
    passRE: toRe(opts.pass),
    failRE: toRe(opts.fail),
  }

  const errors: string[] = []
  function notBlank(fieldName: keyof AllOpts) {
    const v = toS(result[fieldName])
    if (blank(v)) {
      errors.push(fieldName + " must not be blank")
    }
  }
  function gte(fieldName: keyof AllOpts, value: number) {
    const v = result[fieldName] as number
    if (v < value) {
      errors.push(fieldName + " must be greater than or equal to " + value)
    }
  }
  notBlank("versionCommand")
  notBlank("pass")
  notBlank("fail")

  gte("spawnTimeoutMillis", 100)
  gte("taskTimeoutMillis", 10)
  gte("maxTasksPerProcess", 1)

  gte("maxProcs", 1)
  if (opts.maxProcAgeMillis !== 0) {
    gte(
      "maxProcAgeMillis",
      Math.max(result.spawnTimeoutMillis, result.taskTimeoutMillis)
    )
  }
  gte("minDelayBetweenSpawnMillis", 1)
  gte("onIdleIntervalMillis", 0)
  gte("endGracefulWaitTimeMillis", 0)
  gte("maxReasonableProcessFailuresPerMinute", 0)
  gte("streamFlushMillis", 0)

  if (errors.length > 0) {
    throw new Error(
      "BatchCluster was given invalid options: " + errors.join(", ")
    )
  }

  return result
}
