import events from "node:events"
import process from "node:process"
import timers from "node:timers"
import type { Args } from "./Args"
import {
  BatchClusterEmitter,
  BatchClusterEvents,
  ChildEndReason,
  TypedEventEmitter,
} from "./BatchClusterEmitter"
import { BatchClusterEventCoordinator } from "./BatchClusterEventCoordinator"
import type { BatchClusterOptions, WithObserver } from "./BatchClusterOptions"
import type { BatchClusterStats } from "./BatchClusterStats"
import type { BatchProcessOptions } from "./BatchProcessOptions"
import type { ChildProcessFactory } from "./ChildProcessFactory"
import type { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions"
import { Deferred } from "./Deferred"
import { HealthCheckStrategy } from "./HealthCheckStrategy"
import type { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { Logger, LoggerFunction } from "./Logger"
import { verifyOptions } from "./OptionsVerifier"
import { Parser } from "./Parser"
import { HealthCheckable, ProcessHealthMonitor } from "./ProcessHealthMonitor"
import { ProcessPoolManager } from "./ProcessPoolManager"
import { validateProcpsAvailable } from "./ProcpsChecker"
import { Task, TaskOptions } from "./Task"
import { TaskQueueManager } from "./TaskQueueManager"
import { WhyNotHealthy, WhyNotReady } from "./WhyNotHealthy"

export { BatchClusterOptions } from "./BatchClusterOptions"
export { BatchProcess } from "./BatchProcess"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { SimpleParser } from "./Parser"
export { kill, pidExists, pids } from "./Pids"
export { ProcpsMissingError } from "./ProcpsChecker"
export { Rate } from "./Rate"
export { Task } from "./Task"
export type {
  Args,
  BatchClusterEmitter,
  BatchClusterEvents,
  BatchClusterStats,
  BatchProcessOptions,
  ChildEndReason,
  ChildProcessFactory,
  CombinedBatchProcessOptions,
  HealthCheckable,
  HealthCheckStrategy,
  InternalBatchProcessOptions,
  LoggerFunction,
  Parser,
  ProcessHealthMonitor,
  TaskOptions,
  TypedEventEmitter,
  WhyNotHealthy,
  WhyNotReady,
  WithObserver,
}

export const a: HealthCheckable = {} as any

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
  readonly #logger: () => Logger
  readonly options: CombinedBatchProcessOptions
  readonly #processPool: ProcessPoolManager
  readonly #taskQueue: TaskQueueManager
  readonly #eventCoordinator: BatchClusterEventCoordinator
  #onIdleRequested = false
  #onIdleInterval: NodeJS.Timeout | undefined
  #endPromise?: Deferred<void>
  readonly emitter = new events.EventEmitter() as BatchClusterEmitter

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory,
  ) {
    // Validate that required process listing commands are available
    validateProcpsAvailable()

    this.options = verifyOptions({ ...opts, observer: this.emitter })
    this.#logger = this.options.logger

    // Initialize the managers
    this.#processPool = new ProcessPoolManager(this.options, this.emitter, () =>
      this.#onIdleLater(),
    )
    this.#taskQueue = new TaskQueueManager(this.#logger, this.emitter)

    // Initialize event coordinator to handle all event processing
    this.#eventCoordinator = new BatchClusterEventCoordinator(
      this.emitter,
      {
        streamFlushMillis: this.options.streamFlushMillis,
        maxReasonableProcessFailuresPerMinute:
          this.options.maxReasonableProcessFailuresPerMinute,
        logger: this.#logger,
      },
      () => this.#onIdleLater(),
      () => void this.end(),
    )

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
    this.#taskQueue.enqueue(task as Task<unknown>)

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
    return this.#taskQueue.pendingTaskCount
  }

  /**
   * @returns {number} the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    return this.#eventCoordinator.meanTasksPerProc
  }

  /**
   * @return the total number of child processes created by this instance
   */
  get spawnedProcCount(): number {
    return this.#processPool.spawnedProcCount
  }

  /**
   * @return the current number of spawned child processes. Some (or all) may be idle.
   */
  get procCount(): number {
    return this.#processPool.processCount
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return this.#processPool.busyProcCount
  }

  get startingProcCount(): number {
    return this.#processPool.startingProcCount
  }

  /**
   * @return the current pending Tasks (mostly for testing)
   */
  get pendingTasks() {
    return this.#taskQueue.pendingTasks
  }

  /**
   * @return the current running Tasks (mostly for testing)
   */
  get currentTasks(): Task[] {
    return this.#processPool.currentTasks()
  }

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this.#eventCoordinator.internalErrorCount
  }

  /**
   * Verify that each BatchProcess PID is actually alive.
   *
   * @return the spawned PIDs that are still in the process table.
   */
  pids(): number[] {
    return this.#processPool.pids()
  }

  /**
   * For diagnostics. Contents may change.
   */
  stats(): BatchClusterStats {
    return {
      pendingTaskCount: this.pendingTaskCount,
      currentProcCount: this.procCount,
      readyProcCount: this.#processPool.readyProcCount,
      maxProcCount: this.options.maxProcs,
      internalErrorCount: this.#eventCoordinator.internalErrorCount,
      startErrorRatePerMinute: this.#eventCoordinator.startErrorRatePerMinute,
      msBeforeNextSpawn: this.#processPool.msBeforeNextSpawn,
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
    return this.#eventCoordinator.countEndedChildProcs(why)
  }

  get childEndCounts(): Record<NonNullable<ChildEndReason>, number> {
    return this.#eventCoordinator.childEndCounts
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true): Promise<void> {
    return this.#processPool.closeChildProcesses(gracefully)
  }

  /**
   * Reset the maximum number of active child processes to `maxProcs`. Note that
   * this is handled gracefully: child processes are only reduced as tasks are
   * completed.
   */
  setMaxProcs(maxProcs: number) {
    this.#processPool.setMaxProcs(maxProcs)
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

  /**
   * Run maintenance on currently spawned child processes. This method is
   * normally invoked automatically as tasks are enqueued and processed.
   *
   * Only public for tests.
   */
  // NOT ASYNC: updates internal state. only exported for tests.
  vacuumProcs() {
    return this.#processPool.vacuumProcs()
  }

  /**
   * NOT ASYNC: updates internal state.
   * @return true iff a task was submitted to a child process
   */
  #execNextTask(retries = 1): boolean {
    if (this.ended) return false
    const readyProc = this.#processPool.findReadyProcess()
    return this.#taskQueue.tryAssignNextTask(readyProc, retries)
  }

  async #maybeSpawnProcs() {
    return this.#processPool.maybeSpawnProcs(
      this.#taskQueue.pendingTaskCount,
      this.ended,
    )
  }
}
