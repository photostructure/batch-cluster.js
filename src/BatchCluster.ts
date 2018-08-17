import { ChildProcess } from "child_process"
import { EventEmitter } from "events"
import * as _p from "process"
import { clearInterval, setInterval } from "timers"

import { filterInPlace } from "./Array"
import { serial } from "./Async"
import {
  BatchProcess,
  BatchProcessObserver,
  InternalBatchProcessOptions
} from "./BatchProcess"
import { logger } from "./Logger"
import { Mean } from "./Mean"
import { pidExists } from "./Pids"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { kill, pidExists, pids } from "./Pids"
export { Deferred } from "./Deferred"
export * from "./Logger"
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
  versionCommand: string

  /**
   * Expected text to print if a command passes. Cannot be blank. Strings will
   * be interpreted as a regular expression fragment.
   */
  pass: string | RegExp

  /**
   * Expected text to print if a command fails. Cannot be blank. Strings will be
   * interpreted as a regular expression fragment.
   */
  fail: string | RegExp

  /**
   * Command to end the child batch process. If not provided, stdin will be
   * closed to signal to the child process that it may terminate, and if it
   * does not shut down within `endGracefulWaitTimeMillis`, it will be
   * SIGHUP'ed.
   */
  exitCommand?: string
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

  /**
   * Some tools emit non-fatal warnings to stderr. If this predicate returns
   * false, the task will not be rejected.
   *
   * This defaults to a function that always returns true, which makes all
   * stderr writes reject tasks.
   */
  readonly rejectTaskOnStderr: (
    task: Task<any>,
    error: string | Error
  ) => boolean = () => true
}

function verifyOptions(
  opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory
): AllOpts {
  function toRe(s: string | RegExp) {
    return s instanceof RegExp
      ? s
      : new RegExp("^((?:[\\s\\S]*[\\n\\r]+)?)" + s + "[\\n\\r]*$")
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
  private readonly emitter = new EventEmitter()
  private readonly _tasksPerProc: Mean = new Mean()
  private readonly opts: AllOpts
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private readonly tasks: Task<any>[] = []
  private readonly onIdleInterval?: NodeJS.Timer
  private readonly startErrorRate = new Rate()
  private _spawnedProcs = 0
  private _ended = false
  private _internalErrorCount = 0

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory
  ) {
    this.opts = verifyOptions(opts)
    if (this.opts.onIdleIntervalMillis > 0) {
      this.onIdleInterval = setInterval(
        () => this.onIdle(),
        this.opts.onIdleIntervalMillis
      )
      this.onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.observer = {
      onIdle: () => this.onIdle(),
      onStartError: err => this.onStartError(err),
      onTaskError: (err, task) => this.emitter.emit("taskError", err, task),
      onInternalError: err => this.onInternalError(err),
      rejectTaskOnStderr: this.opts.rejectTaskOnStderr
    }
    _p.once("beforeExit", this.beforeExitListener)
    _p.once("exit", this.exitListener)
  }

  private readonly beforeExitListener = () => this.end(true)
  private readonly exitListener = () => this.end(false)

  /**
   * Emitted when a child process has an error when spawning
   */
  on(event: "startError", listener: (err: Error) => void): void
  /**
   * Emitted when a task has an error
   */
  on(event: "taskError", listener: (err: Error, task: Task<any>) => void): void
  /**
   * Emitted when a child process has an error during shutdown
   */
  on(event: "endError", listener: (err: Error) => void): void
  /**
   * Emitted when this instance is in the process of ending.
   */
  on(event: "beforeEnd", listener: () => void): void
  /**
   * Emitted when this instance has ended. No child processes should remain at
   * this point.
   */
  on(event: "end", listener: () => void): void
  on(event: string, listener: (...args: any[]) => void) {
    this.emitter.on(event, listener)
  }

  get ended(): boolean {
    return this._ended
  }

  async end(gracefully: boolean = true): Promise<void> {
    const alreadyEnded = this._ended
    this._ended = true

    if (!alreadyEnded) {
      this.emitter.emit("beforeEnd")
      if (this.onIdleInterval) clearInterval(this.onIdleInterval)
      _p.removeListener("beforeExit", this.beforeExitListener)
      _p.removeListener("exit", this.exitListener)
    }

    if (!gracefully || !alreadyEnded) {
      await Promise.all(
        this._procs.map(p =>
          p
            .end(gracefully, "BatchCluster.end()")
            .catch(err => this.emitter.emit("endError", err))
        )
      )
      this._procs.length = 0
    }

    return this.endPromise().then(() => {
      if (!alreadyEnded) this.emitter.emit("end")
    })
  }

  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this._ended) {
      task.reject(new Error("BatchCluster has ended"))
      throw new Error("Cannot enqueue task " + task.command)
    }
    logger().trace("BatchCluster.enqueueTask(" + task.command + ")")
    this.tasks.push(task)
    setTimeout(() => this.onIdle(), 1)
    return task.promise
  }

  /**
   * @return the number of pending tasks
   */
  get pendingTasks(): number {
    return this.tasks.length
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

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this._internalErrorCount
  }

  private endPromise(): Promise<void> {
    return Promise.all(this._procs.map(p => p.exitedPromise))
      .then(() => {})
      .catch(err => {
        this.emitter.emit("endError", err)
      })
  }

  private onInternalError(error: Error): void {
    logger().error("BatchCluster: INTERNAL ERROR: " + error)
    this._internalErrorCount++
  }

  private onStartError(error: Error): void {
    logger().warn("BatchCluster.onStartError(): " + error)
    this.emitter.emit("startError", error)
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

  /**
   * Exposed only for unit tests
   *
   * @return the spawned PIDs that are still in the process table.
   */
  async pids(): Promise<number[]> {
    const arr: number[] = []
    for (const pid of this._procs.map(p => p.pid)) {
      if (await pidExists(pid)) arr.push(pid)
    }
    return arr
  }

  private readonly onIdle = serial(async () => {
    if (this._ended) return
    const beforeProcLen = this._procs.length

    const minStart = Date.now() - this.opts.maxProcAgeMillis
    filterInPlace(this._procs, proc => {
      const old = proc.start < minStart && this.opts.maxProcAgeMillis > 0
      const worn = proc.taskCount >= this.opts.maxTasksPerProcess
      const broken = proc.exited
      if (proc.idle && (old || worn || broken)) {
        proc.end(true, old ? "old" : worn ? "worn" : "broken")
        return false
      } else {
        return true
      }
    })
    const readyProcs = this._procs.filter(proc => proc.ready)
    logger().trace("BatchCluster.onIdle()", {
      beforeProcLen,
      readyProcs: readyProcs.map(ea => ea.pid),
      pendingTasks: this.tasks.slice(0, 3).map(ea => ea.command),
      pendingTaskCount: this.tasks.length
    })

    const execNextTask = () => {
      const idleProc = readyProcs.shift()
      if (idleProc == null) return

      const task = this.tasks.shift()
      if (task == null) return

      if (idleProc.execTask(task)) {
        logger().trace(
          "BatchCluster.onIdle(): submitted " +
            task.command +
            " to child pid " +
            idleProc.pid
        )
      } else {
        logger().warn(
          "BatchCluster.onIdle(): execTask for " +
            task.command +
            " to pid " +
            idleProc.pid +
            " returned false, re-enqueing."
        )
        this.enqueueTask(task)
      }
      return true
    }

    while (!this._ended && execNextTask()) {}

    if (
      !this._ended &&
      this.tasks.length > 0 &&
      this._procs.length < this.opts.maxProcs
    ) {
      const proc = new BatchProcess(
        this.opts.processFactory(),
        this.opts,
        this.observer
      )
      proc.exitedPromise.then(() => this._tasksPerProc.push(proc.taskCount))
      this._procs.push(proc)
      this._spawnedProcs++
    }

    logger().trace("BatchCluster.onIdle() finished")
    return
  })
}
