import events from "node:events"
import process from "node:process"
import timers from "node:timers"
import { count, filterInPlace } from "./Array"
import {
  BatchClusterEmitter,
  BatchClusterEvents,
  ChildEndReason,
  TypedEventEmitter,
} from "./BatchClusterEmitter"
import { BatchClusterOptions } from "./BatchClusterOptions"
import type { BatchClusterStats } from "./BatchClusterStats"
import { BatchProcess } from "./BatchProcess"
import { WhyNotHealthy, WhyNotReady } from "./WhyNotHealthy"
import { BatchProcessOptions } from "./BatchProcessOptions"
import type { ChildProcessFactory } from "./ChildProcessFactory"
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions"
import { Deferred } from "./Deferred"
import { asError } from "./Error"
import { Logger } from "./Logger"
import { Mean } from "./Mean"
import { verifyOptions } from "./OptionsVerifier"
import { Parser } from "./Parser"
import { Rate } from "./Rate"
import { toS } from "./String"
import { Task } from "./Task"
import { Timeout, thenOrTimeout } from "./Timeout"

export { BatchClusterOptions } from "./BatchClusterOptions"
export { BatchProcess } from "./BatchProcess"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { SimpleParser } from "./Parser"
export { kill, pidExists, pids } from "./Pids"
export { Rate } from "./Rate"
export { Task } from "./Task"
export type {
  BatchClusterEmitter,
  BatchClusterEvents,
  BatchClusterStats,
  BatchProcessOptions,
  ChildEndReason as ChildExitReason,
  ChildProcessFactory,
  Parser,
  TypedEventEmitter,
  WhyNotHealthy,
  WhyNotReady,
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
export class BatchCluster {
  readonly #tasksPerProc = new Mean()
  readonly #logger: () => Logger
  readonly options: CombinedBatchProcessOptions
  readonly #procs: BatchProcess[] = []
  #onIdleRequested = false
  #nextSpawnTime = 0
  #lastPidsCheckTime = 0
  readonly #tasks: Task[] = []
  #onIdleInterval: NodeJS.Timeout | undefined
  readonly #startErrorRate = new Rate()
  #spawnedProcs = 0
  #endPromise?: Deferred<void>
  #internalErrorCount = 0
  readonly #childEndCounts = new Map<ChildEndReason, number>()
  readonly emitter = new events.EventEmitter() as BatchClusterEmitter

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory,
  ) {
    this.options = verifyOptions({ ...opts, observer: this.emitter })

    this.on("childEnd", (bp, why) => {
      this.#tasksPerProc.push(bp.taskCount)
      this.#childEndCounts.set(why, (this.#childEndCounts.get(why) ?? 0) + 1)
      this.#onIdleLater()
    })

    this.on("internalError", (error) => {
      this.#logger().error("BatchCluster: INTERNAL ERROR: " + String(error))
      this.#internalErrorCount++
    })

    this.on("noTaskData", (stdout, stderr, proc) => {
      this.#logger().warn(
        "BatchCluster: child process emitted data with no current task. Consider setting streamFlushMillis to a higher value.",
        {
          streamFlushMillis: this.options.streamFlushMillis,
          stdout: toS(stdout),
          stderr: toS(stderr),
          proc_pid: proc?.pid,
        },
      )
      this.#internalErrorCount++
    })

    this.on("startError", (error) => {
      this.#logger().warn("BatchCluster.onStartError(): " + String(error))
      this.#startErrorRate.onEvent()
      if (
        this.options.maxReasonableProcessFailuresPerMinute > 0 &&
        this.#startErrorRate.eventsPerMinute >
          this.options.maxReasonableProcessFailuresPerMinute
      ) {
        this.emitter.emit(
          "fatalError",
          new Error(
            String(error) +
              "(start errors/min: " +
              this.#startErrorRate.eventsPerMinute.toFixed(2) +
              ")",
          ),
        )
        this.end()
      } else {
        this.#onIdleLater()
      }
    })

    if (this.options.onIdleIntervalMillis > 0) {
      this.#onIdleInterval = timers.setInterval(
        () => this.#onIdleLater(),
        this.options.onIdleIntervalMillis,
      )
      this.#onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.#logger = this.options.logger

    process.once("beforeExit", this.#beforeExitListener)
    process.once("exit", this.#exitListener)
  }

  /**
   * @see BatchClusterEvents
   */
  readonly on = this.emitter.on.bind(this.emitter)

  /**
   * @see BatchClusterEvents
   * @since v9.0.0
   */
  readonly off = this.emitter.off.bind(this.emitter)

  readonly #beforeExitListener = () => {
    void this.end(true)
  }
  readonly #exitListener = () => {
    void this.end(false)
  }

  get ended(): boolean {
    return this.#endPromise != null
  }

  /**
   * Shut down this instance, and all child processes.
   * @param gracefully should an attempt be made to finish in-flight tasks, or
   * should we force-kill child PIDs.
   */
  // NOT ASYNC so state transition happens immediately
  end(gracefully = true): Deferred<void> {
    this.#logger().info("BatchCluster.end()", { gracefully })

    if (this.#endPromise == null) {
      this.emitter.emit("beforeEnd")
      if (this.#onIdleInterval != null)
        timers.clearInterval(this.#onIdleInterval)
      this.#onIdleInterval = undefined
      process.removeListener("beforeExit", this.#beforeExitListener)
      process.removeListener("exit", this.#exitListener)
      this.#endPromise = new Deferred<void>().observe(
        this.closeChildProcesses(gracefully).then(() => {
          this.emitter.emit("end")
        }),
      )
    }

    return this.#endPromise
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
        new Error("BatchCluster has ended, cannot enqueue " + task.command),
      )
    }
    this.#tasks.push(task as Task<unknown>)

    // Run #onIdle now (not later), to make sure the task gets enqueued asap if
    // possible
    this.#onIdleLater()

    // (BatchProcess will call our #onIdleLater when tasks settle or when they
    // exit)

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
    return this.#tasks.length
  }

  /**
   * @returns {number} the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    return this.#tasksPerProc.mean
  }

  /**
   * @return the total number of child processes created by this instance
   */
  get spawnedProcCount(): number {
    return this.#spawnedProcs
  }

  /**
   * @return the current number of spawned child processes. Some (or all) may be idle.
   */
  get procCount(): number {
    return this.#procs.length
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return count(
      this.#procs,
      // don't count procs that are starting up as "busy":
      (ea) => !ea.starting && !ea.ending && !ea.idle,
    )
  }

  get startingProcCount(): number {
    return count(
      this.#procs,
      // don't count procs that are starting up as "busy":
      (ea) => ea.starting && !ea.ending,
    )
  }

  /**
   * @return the current pending Tasks (mostly for testing)
   */
  get pendingTasks() {
    return this.#tasks
  }

  /**
   * @return the current running Tasks (mostly for testing)
   */
  get currentTasks(): Task[] {
    return this.#procs
      .map((ea) => ea.currentTask)
      .filter((ea): ea is Task => ea != null)
  }

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this.#internalErrorCount
  }

  /**
   * Verify that each BatchProcess PID is actually alive.
   *
   * @return the spawned PIDs that are still in the process table.
   */
  pids(): number[] {
    const arr: number[] = []
    for (const proc of [...this.#procs]) {
      if (proc != null && proc.running()) {
        arr.push(proc.pid)
      }
    }
    return arr
  }

  /**
   * For diagnostics. Contents may change.
   */
  stats(): BatchClusterStats {
    const readyProcCount = count(this.#procs, (ea) => ea.ready)
    return {
      pendingTaskCount: this.#tasks.length,
      currentProcCount: this.#procs.length,
      readyProcCount,
      maxProcCount: this.options.maxProcs,
      internalErrorCount: this.#internalErrorCount,
      startErrorRatePerMinute: this.#startErrorRate.eventsPerMinute,
      msBeforeNextSpawn: Math.max(0, this.#nextSpawnTime - Date.now()),
      spawnedProcCount: this.spawnedProcCount,
      childEndCounts: this.childEndCounts,
      ending: this.#endPromise != null,
      ended: false === this.#endPromise?.pending,
    }
  }

  /**
   * Get ended process counts (used for tests)
   */
  countEndedChildProcs(why: ChildEndReason): number {
    return this.#childEndCounts.get(why) ?? 0
  }

  get childEndCounts(): Record<NonNullable<ChildEndReason>, number> {
    return Object.fromEntries([...this.#childEndCounts.entries()]) as Record<
      NonNullable<ChildEndReason>,
      number
    >
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true): Promise<void> {
    const procs = [...this.#procs]
    this.#procs.length = 0
    await Promise.all(
      procs.map((proc) =>
        proc
          .end(gracefully, "ending")
          .catch((err) => this.emitter.emit("endError", asError(err), proc)),
      ),
    )
  }

  /**
   * Reset the maximum number of active child processes to `maxProcs`. Note that
   * this is handled gracefully: child processes are only reduced as tasks are
   * completed.
   */
  setMaxProcs(maxProcs: number) {
    this.options.maxProcs = maxProcs
    // we may now be able to handle an enqueued task. Vacuum pids and see:
    this.#onIdleLater()
  }

  readonly #onIdleLater = () => {
    if (!this.#onIdleRequested) {
      this.#onIdleRequested = true
      timers.setTimeout(() => this.#onIdle(), 1)
    }
  }

  // NOT ASYNC: updates internal state:
  #onIdle() {
    this.#onIdleRequested = false
    void this.vacuumProcs()
    while (this.#execNextTask()) {
      //
    }
    void this.#maybeSpawnProcs()
  }

  #maybeCheckPids() {
    if (
      this.options.cleanupChildProcs &&
      this.options.pidCheckIntervalMillis > 0 &&
      this.#lastPidsCheckTime + this.options.pidCheckIntervalMillis < Date.now()
    ) {
      this.#lastPidsCheckTime = Date.now()
      void this.pids()
    }
  }

  /**
   * Run maintenance on currently spawned child processes. This method is
   * normally invoked automatically as tasks are enqueued and processed.
   *
   * Only public for tests.
   */
  // NOT ASYNC: updates internal state. only exported for tests.
  vacuumProcs() {
    this.#maybeCheckPids()
    const endPromises: Promise<void>[] = []
    let pidsToReap = Math.max(0, this.#procs.length - this.options.maxProcs)
    filterInPlace(this.#procs, (proc) => {
      // Only check `.idle` (not `.ready`) procs. We don't want to reap busy
      // procs unless we're ending, and unhealthy procs (that we want to reap)
      // won't be `.ready`.
      if (proc.idle) {
        // don't reap more than pidsToReap pids. We can't use #procs.length
        // within filterInPlace because #procs.length only changes at iteration
        // completion: the prior impl resulted in all idle pids getting reaped
        // when maxProcs was reduced.
        const why = proc.whyNotHealthy ?? (--pidsToReap >= 0 ? "tooMany" : null)
        if (why != null) {
          endPromises.push(proc.end(true, why))
          return false
        }
        proc.maybeRunHealthcheck()
      }
      return true
    })
    return Promise.all(endPromises)
  }

  /**
   * NOT ASYNC: updates internal state.
   * @return true iff a task was submitted to a child process
   */
  #execNextTask(retries = 1): boolean {
    if (this.#tasks.length === 0 || this.ended || retries < 0) return false
    const readyProc = this.#procs.find((ea) => ea.ready)
    // no procs are idle and healthy :(
    if (readyProc == null) {
      return false
    }

    const task = this.#tasks.shift()
    if (task == null) {
      this.emitter.emit("internalError", new Error("unexpected null task"))
      return false
    }

    const submitted = readyProc.execTask(task)
    if (!submitted) {
      // This isn't an internal error: the proc may have needed to run a health
      // check. Let's reschedule the task and try again:
      this.#tasks.push(task)
      // We don't want to return false here (it'll stop the onIdle loop) unless
      // we actually can't submit the task:
      return this.#execNextTask(retries--)
    }
    this.#logger().trace("BatchCluster.#execNextTask(): submitted task", {
      child_pid: readyProc.pid,
      task,
    })

    return submitted
  }

  #maxSpawnDelay() {
    // 10s delay is certainly long enough for .spawn() to return, even on a
    // loaded windows machine.
    return Math.max(10_000, this.options.spawnTimeoutMillis)
  }

  #procsToSpawn() {
    const remainingCapacity = this.options.maxProcs - this.#procs.length

    // take into account starting procs, so one task doesn't result in multiple
    // processes being spawned:
    const requestedCapacity = this.#tasks.length - this.startingProcCount

    const atLeast0 = Math.max(0, Math.min(remainingCapacity, requestedCapacity))

    return this.options.minDelayBetweenSpawnMillis === 0
      ? // we can spin up multiple processes in parallel.
        atLeast0
      : // Don't spin up more than 1:
        Math.min(1, atLeast0)
  }

  async #maybeSpawnProcs() {
    let procsToSpawn = this.#procsToSpawn()

    if (this.ended || this.#nextSpawnTime > Date.now() || procsToSpawn === 0) {
      return
    }

    // prevent concurrent runs:
    this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay()

    for (let i = 0; i < procsToSpawn; i++) {
      if (this.ended) {
        break
      }

      // Kick the lock down the road:
      this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay()
      this.#spawnedProcs++

      try {
        const proc = this.#spawnNewProc()
        const result = await thenOrTimeout(
          proc,
          this.options.spawnTimeoutMillis,
        )
        if (result === Timeout) {
          void proc
            .then((bp) => {
              void bp.end(false, "startError")
              this.emitter.emit(
                "startError",
                asError(
                  "Failed to spawn process in " +
                    this.options.spawnTimeoutMillis +
                    "ms",
                ),
                bp,
              )
            })
            .catch((err) => {
              // this should only happen if the processFactory throws a
              // rejection:
              this.emitter.emit("startError", asError(err))
            })
        } else {
          this.#logger().debug(
            "BatchCluster.#maybeSpawnProcs() started healthy child process",
            { pid: result.pid },
          )
        }

        // tasks may have been popped off or setMaxProcs may have reduced
        // maxProcs. Do this at the end so the for loop ends properly.
        procsToSpawn = Math.min(this.#procsToSpawn(), procsToSpawn)
      } catch (err) {
        this.emitter.emit("startError", asError(err))
      }
    }

    // YAY WE MADE IT.
    // Only let more children get spawned after minDelay:
    const delay = Math.max(100, this.options.minDelayBetweenSpawnMillis)
    this.#nextSpawnTime = Date.now() + delay

    // And schedule #onIdle for that time:
    timers.setTimeout(this.#onIdleLater, delay).unref()
  }

  // must only be called by this.#maybeSpawnProcs()
  async #spawnNewProc() {
    // no matter how long it takes to spawn, always push the result into #procs
    // so we don't leak child processes:
    const proc = await this.options.processFactory()
    const result = new BatchProcess(proc, this.options, this.#onIdleLater)
    this.#procs.push(result)
    return result
  }
}
