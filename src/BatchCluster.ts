import child_process from "child_process"
import process from "process"
import timers from "timers"
import { filterInPlace } from "./Array"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import {
  AllOpts,
  BatchClusterOptions,
  verifyOptions,
} from "./BatchClusterOptions"
import { BatchProcess, WhyNotReady } from "./BatchProcess"
import { BatchProcessObserver } from "./BatchProcessObserver"
import { BatchProcessOptions } from "./BatchProcessOptions"
import { Deferred } from "./Deferred"
import { Logger } from "./Logger"
import { Mean } from "./Mean"
import { fromEntries, map } from "./Object"
import { Parser } from "./Parser"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { BatchClusterOptions } from "./BatchClusterOptions"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { SimpleParser } from "./Parser"
export { kill, pidExists, pids } from "./Pids"
export { Task } from "./Task"
export type { BatchProcessOptions, Parser }

/**
 * These are required parameters for a given BatchCluster.
 */
export interface ChildProcessFactory {
  /**
   * Expected to be a simple call to execFile. Platform-specific code is the
   * responsibility of this thunk. Error handlers will be registered as
   * appropriate.
   */
  readonly processFactory: () =>
    | child_process.ChildProcess
    | Promise<child_process.ChildProcess>
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
  private readonly _tasksPerProc: Mean = new Mean()
  private readonly logger: () => Logger
  readonly options: AllOpts
  private readonly _procs: BatchProcess[] = []
  private _lastSpawnedProcTime = 0
  private _lastPidsCheckTime = Date.now()
  private readonly tasks: Task[] = []
  private onIdleInterval: NodeJS.Timer | undefined
  private readonly startErrorRate = new Rate()
  private _spawnedProcs = 0
  private endPromise?: Deferred<void>
  private _internalErrorCount = 0
  private readonly _childEndCounts = new Map<WhyNotReady, number>()

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory
  ) {
    super()
    const observer: BatchProcessObserver = {
      onIdle: () => {
        this.onIdle()
      },
      onStartError: (err) => {
        this.emitStartError(err)
      },
      onTaskData: (data, task) => {
        this.emitter.emit("taskData", data, task)
      },
      onTaskResolved: (task, proc) => {
        this.emitter.emit("taskResolved", task, proc)
      },
      onTaskError: (err, task, proc) => {
        this.emitter.emit("taskError", err, task, proc)
      },
      onHealthCheckError: (err, proc) => {
        this.emitter.emit("healthCheckError", err, proc)
      },
      onInternalError: (err) => {
        this.emitInternalError(err)
      },
    }
    this.options = Object.freeze(verifyOptions({ ...opts, observer }))
    if (this.options.onIdleIntervalMillis > 0) {
      this.onIdleInterval = timers.setInterval(
        () => this.onIdle(),
        this.options.onIdleIntervalMillis
      )
      this.onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.logger = this.options.logger

    process.once("beforeExit", this.beforeExitListener)
    process.once("exit", this.exitListener)
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
      map(this.onIdleInterval, timers.clearInterval)
      this.onIdleInterval = undefined
      process.removeListener("beforeExit", this.beforeExitListener)
      process.removeListener("exit", this.exitListener)
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
    task.promise.then(
      () => this.onIdle(),
      () => null // < ignore errors in this promise chain.
    )
    return task.promise
  }

  /**
   * @return true if all previously-enqueued tasks have settled
   */
  get isIdle(): boolean {
    return this.pendingTaskCount === 0 && this.busyProcCount === 0
  }

  /**
   * @return the number of pending tasks
   */
  get pendingTaskCount(): number {
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
  get spawnedProcCount(): number {
    return this._spawnedProcs
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return this._procs.filter(
      // don't count procs that are starting up as "busy":
      (ea) => ea.taskCount > 0 && !ea.exited && !ea.idle
    ).length
  }

  /**
   * @return the current pending Tasks (mostly for testing)
   */
  get pendingTasks() {
    return this.tasks
  }

  /**
   * @return the current running Tasks (mostly for testing)
   */
  get currentTasks(): Task[] {
    return this._procs
      .map((ea) => ea.currentTask)
      .filter((ea) => ea != null) as Task[]
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
   * Verify that each BatchProcess PID is actually alive.
   *
   * @return the spawned PIDs that are still in the process table.
   */
  async pids(): Promise<number[]> {
    const arr: number[] = []
    for (const proc of [...this._procs]) {
      if (proc != null && !proc.exited && (await proc.running())) {
        arr.push(proc.pid)
      }
    }
    return arr
  }

  /**
   * Get ended process counts (used for tests)
   */
  countEndedChildProcs(why: WhyNotReady): number {
    return this._childEndCounts.get(why) ?? 0
  }

  get childEndCounts(): { [key in NonNullable<WhyNotReady>]: number } {
    return fromEntries([...this._childEndCounts.entries()])
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true) {
    const procs = [...this._procs]
    this._procs.length = 0
    for (const proc of procs) {
      try {
        await proc.end(gracefully, "BatchCluster.closeChildProcesses()")
      } catch {
        // ignore: make sure all procs are ended
      }
    }
  }

  // NOT ASYNC: updates internal state:
  private onIdle() {
    this.vacuumProcs()
    while (this.execNextTask()) {
      //
    }
    if (this.tasks.length > 0) {
      void this.maybeLaunchNewChild()
    }
  }

  private maybeCheckPids() {
    if (
      this.options.pidCheckIntervalMillis > 0 &&
      this._lastPidsCheckTime + this.options.pidCheckIntervalMillis < Date.now()
    ) {
      this._lastPidsCheckTime = Date.now()
      void this.pids()
    }
  }

  // NOT ASYNC: updates internal state.
  private vacuumProcs() {
    this.maybeCheckPids()
    filterInPlace(this._procs, (proc) => {
      // Don't bother running procs:
      if (!proc.ending && !proc.idle) return true

      const why = proc.whyNotHealthy // NOT whyNotReady: we don't care about busy procs
      if (why != null) {
        this._childEndCounts.set(why, 1 + this.countEndedChildProcs(why))
        void proc.end(true, why)
      }
      return why == null
    })
  }

  // NOT ASYNC: updates internal state.
  private execNextTask(): boolean {
    if (this.tasks.length === 0 || this.ended) return false
    const readyProc = this._procs.find((ea) => ea.ready)
    // no procs are idle and healthy :(
    if (readyProc == null) {
      return false
    }

    const task = this.tasks.shift()
    if (task == null) {
      this.emitInternalError(new Error("unexpected null task"))
      return false
    }

    const submitted = readyProc.execTask(task)
    if (!submitted) {
      // This isn't an internal error: the proc may have needed to run a health
      // check. Let's reschedule the task and try again:
      this.tasks.push(task)
      // We don't want to return false here (it'll stop the onIdle loop) unless
      // we actually can't submit the task:
      return this.execNextTask()
    }
    return submitted
  }

  private cannotLaunchNewChild(): boolean {
    return (
      this.ended ||
      this.tasks.length === 0 ||
      this._procs.length >= this.options.maxProcs ||
      this._lastSpawnedProcTime >
        Date.now() - this.options.minDelayBetweenSpawnMillis
    )
  }

  // NOT ASYNC: updates internal state.
  private maybeLaunchNewChild() {
    if (this.cannotLaunchNewChild()) return

    // prevent other runs:
    this._lastSpawnedProcTime = Date.now()

    void this._maybeLaunchNewChild()
  }

  private async _maybeLaunchNewChild() {
    // don't check cannotLaunchNewChild() again here: it'll be true because we
    // just set _lastSpawnedProcTime.

    if (this.ended || this._procs.length >= this.options.maxProcs) return

    try {
      const child = await this.options.processFactory()
      const pid = child.pid
      if (pid == null) {
        this.emitter.emit("childExit", child)
        return
      }
      const proc = new BatchProcess(child, this.options)

      if (this.ended) {
        void proc.end(false, "ended")
        return
      }

      // Bookkeeping (even if we need to shut down `proc`):
      this._spawnedProcs++
      this.emitter.emit("childStart", child)
      void proc.exitPromise.then(() => {
        this._tasksPerProc.push(proc.taskCount)
        this.emitter.emit("childExit", child)
      })

      // Did we call _mayLaunchNewChild() a couple times in parallel?
      if (this._procs.length >= this.options.maxProcs) {
        // only vacuum if we're at the limit
        this.vacuumProcs()
      }
      if (this._procs.length >= this.options.maxProcs) {
        void proc.end(false, "maxProcs")
        return
      } else {
        this._procs.push(proc)
        return proc
      }
    } catch (err) {
      this.emitter.emit("startError", err)
      return
    }
  }
}
