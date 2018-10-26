import { ChildProcess } from "child_process"
import * as _p from "process"
import { clearInterval, setInterval } from "timers"

import { filterInPlace } from "./Array"
import { serial } from "./Async"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import {
  AllOpts,
  BatchClusterOptions,
  verifyOptions
} from "./BatchClusterOptions"
import { BatchProcess } from "./BatchProcess"
import { BatchProcessObserver } from "./BatchProcessObserver"
import { BatchProcessOptions } from "./BatchProcessOptions"
import { logger } from "./Logger"
import { Mean } from "./Mean"
import { pidExists } from "./Pids"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { BatchProcessOptions } from "./BatchProcessOptions"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { Parser } from "./Parser"
export { kill, pidExists, pids } from "./Pids"
export { Task } from "./Task"

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
 * BatchCluster instances manage 0 or more homogenious child processes, and
 * provide the main interface for enqueing `Task`s via `enqueueTask`.
 *
 * Given the large number of configuration options, the constructor
 * receives a single options hash. The most important of these are the
 * `ChildProcessFactory`, which specifies the factory that creates
 * ChildProcess instances, and `BatchProcessOptions`, which specifies how
 * child tasks can be verified and shut down.
 */
export class BatchCluster extends BatchClusterEmitter {
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
    super()
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
      onTaskData: (data: Buffer | string, task: Task<any> | undefined) =>
        this.emitter.emit("taskData", data, task),
      onTaskError: (err, task) => this.emitter.emit("taskError", err, task),
      onInternalError: err => this.onInternalError(err)
    }
    _p.once("beforeExit", this.beforeExitListener)
    _p.once("exit", this.exitListener)
  }

  private readonly beforeExitListener = () => this.end(true)
  private readonly exitListener = () => this.end(false)

  get ended(): boolean {
    return this._ended
  }

  /**
   * Shut down this instance, and all child processes.
   * @param gracefully should an attempt be made to finish in-flight tasks, or
   * should we force-kill child PIDs.
   */
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

  /**
   * Submits `task` for processing by a `BatchProcess` instance
   *
   * @return a Promise that is resolved or rejected once the task has been
   * attemped on an idle BatchProcess
   */
  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this._ended) {
      task.reject(new Error("BatchCluster has ended"))
      throw new Error("Cannot enqueue task " + task.command)
    }
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
    const execNextTask = () => {
      const idleProc = readyProcs.shift()
      if (idleProc == null) return

      const task = this.tasks.shift()
      if (task == null) return

      if (!idleProc.execTask(task)) {
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
    return
  })
}
