import { ChildProcess } from "child_process"
import * as _p from "process"
import { clearInterval, setInterval } from "timers"
import { filterInPlace, rrFindResult } from "./Array"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import {
  AllOpts,
  BatchClusterOptions,
  verifyOptions,
} from "./BatchClusterOptions"
import { BatchProcess } from "./BatchProcess"
import { BatchProcessObserver } from "./BatchProcessObserver"
import { BatchProcessOptions } from "./BatchProcessOptions"
import { Deferred } from "./Deferred"
import { Logger } from "./Logger"
import { Mean } from "./Mean"
import { Mutex } from "./Mutex"
import { map } from "./Object"
import { pidExists } from "./Pids"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { BatchClusterOptions } from "./BatchClusterOptions"
export { BatchProcessOptions } from "./BatchProcessOptions"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { Parser, SimpleParser } from "./Parser"
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
  readonly processFactory: () => ChildProcess | Promise<ChildProcess>
}

/**
 * BatchCluster instances manage 0 or more homogeneous child processes, and
 * provide the main interface for enqueuing `Task`s via `enqueueTask`.
 *
 * Given the large number of configuration options, the constructor
 * receives a single options hash. The most important of these are the
 * `ChildProcessFactory`, which specifies the factory that creates
 * ChildProcess instances, and `BatchProcessOptions`, which specifies how
 * child tasks can be verified and shut down.
 */
export class BatchCluster extends BatchClusterEmitter {
  private readonly m = new Mutex()
  private readonly _tasksPerProc: Mean = new Mean()
  private readonly logger: () => Logger
  readonly options: AllOpts
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private _lastUsedProcsIdx = 0
  private _lastSpawnedProcTime = 0
  private readonly tasks: Task<any>[] = []
  private onIdleInterval?: NodeJS.Timer
  private readonly startErrorRate = new Rate()
  private _spawnedProcs = 0
  private endPromise?: Deferred<void>
  private _internalErrorCount = 0
  private readonly childEndCounts = new Map<
    "old" | "worn" | "idle" | "broken",
    number
  >()

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory
  ) {
    super()
    this.options = Object.freeze(verifyOptions(opts))
    if (this.options.onIdleIntervalMillis > 0) {
      this.onIdleInterval = setInterval(
        () => this.onIdle(),
        this.options.onIdleIntervalMillis
      )
      this.onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.logger = this.options.logger
    this.observer = {
      onIdle: () => this.onIdle(),
      onStartError: (err) => this.emitStartError(err),
      onTaskData: (data: Buffer | string, task: Task<any> | undefined) =>
        this.emitter.emit("taskData", data, task),
      onTaskError: (err, task) => this.emitter.emit("taskError", err, task),
      onInternalError: (err) => this.emitInternalError(err),
    }
    _p.once("beforeExit", this.beforeExitListener)
    _p.once("exit", this.exitListener)
  }

  private readonly beforeExitListener = () => this.end(true)
  private readonly exitListener = () => this.end(false)

  get ended(): boolean {
    return this.endPromise != null
  }

  /**
   * Shut down this instance, and all child processes.
   * @param gracefully should an attempt be made to finish in-flight tasks, or
   * should we force-kill child PIDs.
   */
  // NOT ASYNC so state transition happens immediately
  end(gracefully = true): Deferred<void> {
    if (this.endPromise == null) {
      this.emitter.emit("beforeEnd")
      map(this.onIdleInterval, clearInterval)
      this.onIdleInterval = undefined
      _p.removeListener("beforeExit", this.beforeExitListener)
      _p.removeListener("exit", this.exitListener)
      this.endPromise = new Deferred<void>().observe(
        this.closeChildProcesses(gracefully)
          .catch((err) => {
            this.emitter.emit("endError", err)
          })
          .then(() => {
            this.emitter.emit("end")
          })
      )
    }

    return this.endPromise
  }

  /**
   * Submits `task` for processing by a `BatchProcess` instance
   *
   * @return a Promise that is resolved or rejected once the task has been
   * attempted on an idle BatchProcess
   */
  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this.ended) {
      task.reject(
        new Error("BatchCluster has ended, cannot enqueue " + task.command)
      )
    }
    this.tasks.push(task)
    setImmediate(() => this.onIdle())
    task.promise
      .then(() => this.onIdle())
      .catch(() => {
        //
      })
    return task.promise
  }

  /**
   * @return true if all previously-enqueued tasks have settled
   */
  get isIdle(): boolean {
    return this.tasks.length === 0 && this._procs.every((ea) => ea.idle)
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

  /**
   * @return the total number of child processes created by this instance
   */
  get spawnedProcs(): number {
    return this._spawnedProcs
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcs(): number {
    return this._procs.filter(
      (ea) => ea.taskCount > 0 && !ea.exited && !ea.idle
    ).length
  }

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this._internalErrorCount
  }

  private emitInternalError(error: Error): void {
    this.emitter.emit("internalError", error)
    this.logger().error("BatchCluster: INTERNAL ERROR: " + error)
    this._internalErrorCount++
  }

  private emitStartError(error: Error): void {
    this.logger().warn("BatchCluster.onStartError(): " + error)
    this.emitter.emit("startError", error)
    this.startErrorRate.onEvent()
    if (
      this.startErrorRate.eventsPerMinute >
      this.options.maxReasonableProcessFailuresPerMinute
    ) {
      this.emitter.emit(
        "endError",
        new Error(
          error +
            "(start errors/min: " +
            this.startErrorRate.eventsPerMinute.toFixed(2) +
            ")"
        )
      )
      this.end()
    }
  }

  /**
   * Exposed only for unit tests
   *
   * @return the spawned PIDs that are still in the process table.
   */
  async pids(): Promise<number[]> {
    const arr: number[] = []
    for (const pid of this._procs.map((p) => p.pid)) {
      if (await pidExists(pid)) arr.push(pid)
    }
    return arr
  }

  /**
   * Get ended process counts (used for tests)
   */
  countEndedChildProcs(why: "old" | "worn" | "idle" | "broken"): number {
    return this.childEndCounts.get(why) ?? 0
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true) {
    const procs = [...this._procs]
    this._procs.length = 0
    for (const proc of procs) {
      await proc.end(gracefully, "BatchCluster.closeChildren()")
    }
  }

  // NOT ASYNC: updates internal state.
  private onIdle() {
    return this.m.runIfIdle(async () => {
      this.vacuumProcs()
      while (this.execNextTask()) {
        //
      }
      // setImmediate because we currently have the mutex
      if (this.tasks.length > 0) setImmediate(() => this.maybeLaunchNewChild())
    })
  }

  // NOT ASYNC: updates internal state.
  private vacuumProcs() {
    filterInPlace(this._procs, (proc) => {
      // Only idle procs are eligible for deletion:
      if (!proc.idle) return true

      const old =
        this.options.maxProcAgeMillis > 0 &&
        proc.start + this.options.maxProcAgeMillis < Date.now()
      const wornOut =
        this.options.maxTasksPerProcess > 0 &&
        proc.taskCount >= this.options.maxTasksPerProcess
      const idle =
        this.options.maxIdleMsPerProcess > 0 &&
        proc.idleMs > this.options.maxIdleMsPerProcess
      const broken = proc.exited
      const reap = old || wornOut || idle || broken // # me
      if (reap) {
        const why = old ? "old" : wornOut ? "worn" : idle ? "idle" : "broken"
        this.childEndCounts.set(why, 1 + this.countEndedChildProcs(why))
        void proc.end(true, why)
      }
      return !reap
    })
  }

  // NOT ASYNC: updates internal state.
  private execNextTask() {
    if (this.tasks.length === 0 || this.ended) return false
    const readyProc = rrFindResult(
      this._procs,
      this._lastUsedProcsIdx + 1,
      (ea) => ea.ready
    )
    if (readyProc == null) return false

    const task = this.tasks.shift()
    if (task == null) {
      this.emitInternalError(new Error("unexpected null task"))
      return false
    }

    this._lastUsedProcsIdx = readyProc.index

    const submitted = readyProc.result.execTask(task)
    if (!submitted) {
      void this.enqueueTask(task)
    }
    return submitted
  }

  private readonly maybeLaunchNewChild = () =>
    this.m.runIfIdle(async () => {
      // Minimize start time system load. Only launch one new proc at a time
      if (
        this.ended ||
        this.tasks.length === 0 ||
        this._procs.length >= this.options.maxProcs ||
        this._lastSpawnedProcTime >
          Date.now() - this.options.minDelayBetweenSpawnMillis
      ) {
        return
      }

      try {
        this._lastSpawnedProcTime = Date.now()
        const child = await this.options.processFactory()
        const proc = new BatchProcess(child, this.options, this.observer)
        if (this.ended) {
          // This should only happen in tests.
          void proc.end(false, "ended")
        } else {
          this._procs.push(proc)
          this.emitter.emit("childStart", child)
          void proc.exitedPromise.then(() => {
            this._tasksPerProc.push(proc.taskCount)
            this.emitter.emit("childExit", child)
          })
        }
        this._spawnedProcs++
        return proc
      } catch (err) {
        this.emitter.emit("startError", err)
        return
      }
    })
}
