import { ChildProcess } from "child_process"
import * as _p from "process"

import {
  BatchProcess,
  BatchProcessObserver,
  InternalBatchProcessOptions
} from "./BatchProcess"
import { Mean } from "./Mean"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { kill, running } from "./BatchProcess"
export { Deferred } from "./Deferred"
export { delay } from "./Delay"
export { Logger, setLogger, logger } from "./Logger"
export { Task, Parser } from "./Task"

/**
 * These are required parameters for a given BatchCluster.
 */
export interface ChildProcessFactory {
  /**
   * Expected to be a simple call to execFile. Platform-specific code is the
   * responsibility of this thunk. Error handlers will be registered as
   * appropriate.
   */
  readonly processFactory: () => ChildProcess
}

/**
 * `BatchProcessOptions` have no reasonable defaults, as they are specific
 * to the API of the command that BatchCluster is spawning.
 *
 * All fields must be set.
 */
export interface BatchProcessOptions {
  /**
   * Low-overhead command to verify the child batch process has started.
   * Will be invoked immediately after spawn. This command must return
   * before any tasks will be given to a given process.
   */
  readonly versionCommand: string

  /**
   * Expected text to print if a command passes. Cannot be blank. Will be
   * interpreted as a regular expression fragment.
   */
  readonly pass: string

  /**
   * Expected text to print if a command fails. Cannot be blank. Will be
   * interpreted as a regular expression fragment.
   */
  readonly fail: string

  /**
   * Command to end the child batch process. If not provided, stdin will be
   * closed to signal to the child process that it may terminate, and if it
   * does not shut down within `endGracefulWaitTimeMillis`, it will be
   * SIGHUP'ed.
   */
  readonly exitCommand?: string
}

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
   * Must be &gt; 0. Defaults to 1 second.
   */
  readonly onIdleIntervalMillis: number = 1000

  /**
   * Tasks that result in errors will be retried at most `taskRetries`
   * times.
   *
   * Must be &gt;= 0. Defaults to 0.
   */
  readonly taskRetries: number = 0

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
   * If commands take longer than this, presume the underlying process is
   * dead and we should fail or retry the task.
   *
   * This should be set to something on the order of seconds.
   *
   * Must be &gt;= 10ms. Defaults to 10 seconds.
   */
  readonly taskTimeoutMillis: number = 10000

  /**
   * When tasks don't complete in `taskTimeoutMillis`, should they be
   * retried (a maximum of `taskRetries`)? If taskRetries is set to 0, this
   * value is meaningless.
   *
   * Defaults to false.
   */
  readonly retryTasksAfterTimeout: boolean = false

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

function verifyOptions(
  opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory
): AllOpts {
  function toRe(s: string) {
    return new RegExp("^([\\s\\S]*?)[\\n\\r]+" + s + "[\\n\\r]*$")
  }

  const result = {
    ...new BatchClusterOptions(),
    ...opts,
    passRE: toRe(opts.pass),
    failRE: toRe(opts.fail)
  }

  const errors: string[] = []
  function notBlank(fieldName: keyof AllOpts) {
    const v = result[fieldName] as string
    if (v.trim().length === 0) {
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
  gte(
    "maxProcAgeMillis",
    Math.max(result.spawnTimeoutMillis, result.taskTimeoutMillis)
  )
  gte("onIdleIntervalMillis", 0)
  gte("endGracefulWaitTimeMillis", 0)
  gte("taskRetries", 0)
  gte("maxReasonableProcessFailuresPerMinute", 0)

  if (errors.length > 0) {
    throw new Error(
      "BatchCluster was given invalid options: " + errors.join(", ")
    )
  }

  return result
}

type AllOpts = BatchClusterOptions &
  InternalBatchProcessOptions &
  ChildProcessFactory

function map<T, R>(obj: T | undefined, f: (t: T) => R): R | undefined {
  return obj != null ? f(obj) : undefined
}

/**
 * BatchCluster instances manage 0 or more homogenious child processes, and
 * provide the main interface for enqueing `Task`s via `enqueueTask`.
 *
 * Given the large number of configuration options, the constructor
 * receives a single options hash. The most important of these are the
 * `ChildProcessFactory`, which specifies the factory that creates
 * ChildProcess instances, and `BatchProcessOptions`, which specifies how
 * child tasks can be verified and shut down.
 */
export class BatchCluster {
  private readonly _tasksPerProc: Mean = new Mean()
  private readonly opts: AllOpts
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private readonly _pendingTasks: Array<Task<any>> = []
  private readonly onIdleInterval?: NodeJS.Timer
  private readonly startErrorRate = new Rate()
  private _spawnedProcs = 0
  private _ended = false

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory
  ) {
    this.opts = verifyOptions(opts)
    if (this.opts.onIdleIntervalMillis > 0) {
      this.onIdleInterval = global.setInterval(
        () => this.onIdle(),
        this.opts.onIdleIntervalMillis
      )
      this.onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.observer = {
      onIdle: this.onIdle.bind(this),
      onStartError: this.onStartError.bind(this),
      retryTask: this.retryTask.bind(this)
    }
    _p.once("beforeExit", this.beforeExitListener)
    _p.once("exit", this.exitListener)
  }

  get ended(): boolean {
    return this._ended
  }

  // not async so it doesn't relinquish control flow
  end(gracefully: boolean = true): Promise<void> {
    if (!this._ended) {
      this._ended = true
      if (this.onIdleInterval) clearInterval(this.onIdleInterval)
      _p.removeListener("beforeExit", this.beforeExitListener)
      _p.removeListener("exit", this.exitListener)
      this._procs.forEach(p => p.end(gracefully))
    }
    return this.endPromise
  }

  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this._ended) {
      task.onError("BatchCluster has ended")
      throw new Error("Cannot enqueue task " + task.command)
    }
    this._pendingTasks.push(task)
    this.onIdle()
    return task.promise
  }

  /**
   * @return the current, non-ended child process PIDs. Useful for integration
   * tests, but most likely not generally interesting.
   */
  get pids(): number[] {
    return this.procs().map(p => p.pid)
  }

  /**
   * @return the number of pending tasks
   */
  get pendingTasks(): number {
    return this._pendingTasks.length
  }

  /**
   * @returns {number} the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    return this._tasksPerProc.mean
  }

  get spawnedProcs(): number {
    return this._spawnedProcs
  }

  get pendingMaintenance(): Promise<void> {
    return Promise.all(this._procs.filter(p => p.ended).map(p => p.end())).then(
      () => undefined
    )
  }

  private readonly beforeExitListener = () => this.end(true)
  private readonly exitListener = () => this.end(false)

  private get endPromise(): Promise<void> {
    return Promise.all(this._procs.map(p => p.exitedPromise)).then(
      () => undefined
    )
  }

  private retryTask(task: Task<any>, error: any) {
    if (task) {
      if (task.retries < this.opts.taskRetries) {
        task.retries++
        // fix for rapid-retry failure from mktags:
        setTimeout(() => this.enqueueTask(task), 20)
      } else {
        task.onError(error)
      }
    }
  }

  private onStartError(error: any): void {
    this.startErrorRate.onEvent()
    if (
      this.startErrorRate.eventsPerMinute >
      this.opts.maxReasonableProcessFailuresPerMinute
    ) {
      this.end()
      throw new Error(
        error +
          "(start errors/min: " +
          this.startErrorRate.eventsPerMinute.toFixed(2) +
          ")"
      )
    }
  }

  private procs(): BatchProcess[] {
    const minStart = Date.now() - this.opts.maxProcAgeMillis
    // Iterate the array backwards, as we'll be removing _procs as we go:
    for (let i = this._procs.length - 1; i >= 0; i--) {
      const proc = this._procs[i]
      // Don't end procs that are currently servicing requests:
      if (
        proc.idle &&
        (proc.start < minStart ||
          proc.taskCount >= this.opts.maxTasksPerProcess)
      ) {
        // No need to be graceful, just shut down.
        const gracefully = false
        proc.end(gracefully)
      }
      // Only remove exited processes from _procs:
      if (!proc.running) {
        proc.end() // make sure any pending task is re-enqueued
        this._tasksPerProc.push(proc.taskCount)
        this._procs.splice(i, 1)
      }
    }
    return this._procs
  }

  private onIdle(): void {
    if (this._ended) {
      return
    }

    const procs = this.procs()
    const idleProcs = procs.filter(proc => proc.idle)

    const execNextTask = () =>
      map(idleProcs.shift(), idleProc =>
        map(this._pendingTasks.shift(), task => {
          if (!idleProc.execTask(task)) {
            this.enqueueTask(task)
          }
          return true
        })
      )

    while (!this._ended && execNextTask()) {}

    if (this._pendingTasks.length > 0 && procs.length < this.opts.maxProcs) {
      const bp = new BatchProcess(
        this.opts.processFactory(),
        this.opts,
        this.observer
      )
      this._procs.push(bp)
      this._spawnedProcs++
      // onIdle() will be called by the new proc when its startup task completes.
    }
  }
}
