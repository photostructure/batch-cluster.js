import events from "node:events";
import process from "node:process";
import timers from "node:timers";
import { BatchClusterEmitter, ChildEndReason } from "./BatchClusterEmitter";
import { BatchClusterEventCoordinator } from "./BatchClusterEventCoordinator";
import type { BatchClusterOptions } from "./BatchClusterOptions";
import { secondMs } from "./BatchClusterOptions";
import type { BatchClusterStats } from "./BatchClusterStats";
import type { BatchProcessOptions } from "./BatchProcessOptions";
import type { ChildProcessFactory } from "./ChildProcessFactory";
import type { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { Deferred } from "./Deferred";
import { Logger } from "./Logger";
import { verifyOptions } from "./OptionsVerifier";
import { killerFor } from "./Pids";
import { ProcessPoolManager } from "./ProcessPoolManager";
import { Task } from "./Task";
import { TaskQueueManager } from "./TaskQueueManager";

export { BatchClusterOptions } from "./BatchClusterOptions";
export { BatchProcess } from "./BatchProcess";
export { Deferred } from "./Deferred";
export { findStreamFlushMillis } from "./FindFlushThresholds";
export * from "./Logger";
export { SimpleParser } from "./Parser";
export { kill, killGroup, pidExists } from "./Pids";
export { Task } from "./Task";
// Type exports organized by source module
export type { Args } from "./Args";
export type {
  BatchClusterEmitter,
  BatchClusterEvents,
  ChildEndReason,
  TypedEventEmitter,
} from "./BatchClusterEmitter";
export type { WithObserver } from "./BatchClusterOptions";
export type { BatchClusterStats } from "./BatchClusterStats";
export type { BatchProcessOptions } from "./BatchProcessOptions";
export type { ChildProcessFactory } from "./ChildProcessFactory";
export type { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
export type { FindFlushMillisOptions } from "./FindFlushThresholds";
export type { HealthCheckStrategy } from "./HealthCheckStrategy";
export type { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
export type { LoggerFunction } from "./Logger";
export type { Parser } from "./Parser";
export type { KillFn } from "./Pids";
export type {
  HealthCheckable,
  ProcessHealthMonitor,
} from "./ProcessHealthMonitor";
export type { TaskOptions } from "./Task";
export { ExpectedTerminationReasons } from "./WhyNotHealthy";
export type { WhyNotHealthy, WhyNotReady } from "./WhyNotHealthy";

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
  readonly #logger: () => Logger;
  readonly options: CombinedBatchProcessOptions;
  readonly #processPool: ProcessPoolManager;
  readonly #taskQueue: TaskQueueManager;
  readonly #eventCoordinator: BatchClusterEventCoordinator;
  #onIdleRequested = false;
  #onIdleInterval: NodeJS.Timeout | undefined;
  #keepAlive: NodeJS.Timeout | undefined;
  #endPromise?: Deferred<void>;
  readonly emitter = new events.EventEmitter() as BatchClusterEmitter;

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory,
  ) {
    this.options = verifyOptions({ ...opts, observer: this.emitter });
    this.#logger = this.options.logger;

    // Initialize the managers
    this.#processPool = new ProcessPoolManager(this.options, this.emitter, () =>
      this.#onIdleLater(),
    );
    this.#taskQueue = new TaskQueueManager(this.#logger, this.emitter);

    // Initialize event coordinator to handle all event processing
    this.#eventCoordinator = new BatchClusterEventCoordinator(
      this.emitter,
      {
        streamFlushMillis: this.options.streamFlushMillis,
        logger: this.#logger,
      },
      () => this.#onIdleLater(),
    );

    if (this.options.onIdleIntervalMillis > 0) {
      this.#onIdleInterval = timers.setInterval(
        () => this.#onIdleLater(),
        this.options.onIdleIntervalMillis,
      );
      this.#onIdleInterval.unref(); // < don't prevent node from exiting
    }

    if (this.options.cleanupChildProcsOnExit) {
      process.once("beforeExit", this.#beforeExitListener);
      process.once("exit", this.#exitListener);
    }
  }

  /**
   * @see BatchClusterEvents
   */
  readonly on = this.emitter.on.bind(this.emitter);

  /**
   * @see BatchClusterEvents
   * @since v9.0.0
   */
  readonly off = this.emitter.off.bind(this.emitter);

  // void (not return) because event listeners ignore returned promises.
  // Automatic cleanup is bounded so a processFactory that never settles
  // cannot hold Node in beforeExit forever.
  readonly #beforeExitListener = () => {
    void this.#end(true, this.options.spawnTimeoutMillis);
  };

  /**
   * Synchronously kill all child processes on exit.
   *
   * The `exit` event only allows synchronous operations - the event loop is
   * about to terminate, so any async work (like `this.end()`) would be
   * discarded and never execute. We must force-kill immediately.
   *
   * This reads `unexitedPids()` rather than `pids()` because a child leaves the
   * pool as soon as we decide to recycle it, which can be seconds before it
   * actually dies -- and `pids()` would also poll `running()`, which schedules
   * async work that an `exit` handler can never run.
   */
  readonly #exitListener = () => {
    const killFn = killerFor(this.options);
    for (const pid of this.#processPool.unexitedPids()) {
      killFn(pid, true);
    }
  };

  get ended(): boolean {
    return this.#endPromise != null;
  }

  /**
   * Shut down this instance, and all child processes.
   *
   * This is a true barrier for in-flight process factories. If a factory never
   * settles, `end()` cannot know whether it owns an unreported child and
   * therefore remains pending. Automatic `beforeExit` cleanup uses a bounded
   * best-effort variant instead.
   *
   * @param gracefully should an attempt be made to finish in-flight tasks, or
   * should we force-kill child PIDs.
   */
  // NOT ASYNC so state transition happens immediately
  end(gracefully = true): Deferred<void> {
    return this.#end(gracefully);
  }

  /**
   * Shared implementation for explicit shutdown and automatic beforeExit
   * cleanup. Explicit callers omit `maxWaitMillis` and receive a true barrier;
   * beforeExit supplies a bound because an opaque processFactory may never
   * settle.
   */
  #end(gracefully: boolean, maxWaitMillis?: number): Deferred<void> {
    this.#logger().info("BatchCluster.end()", { gracefully });

    if (this.#endPromise == null) {
      this.emitter.emit("beforeEnd");
      if (this.#onIdleInterval != null)
        timers.clearInterval(this.#onIdleInterval);
      this.#onIdleInterval = undefined;

      // Queued tasks have no owning process, so nothing downstream will ever
      // settle them -- ProcessTerminator only rejects the task a process was
      // actually running. Reject them here rather than abandoning the caller's
      // promise.
      this.#taskQueue.rejectPendingTasks(
        "BatchCluster.end() was called before this task could be assigned",
      );
      this.#clearKeepAlive();

      // Remove only beforeExit, to prevent re-calling end(). #exitListener
      // stays registered until every child is confirmed dead: it reads the
      // pool's unexited-child ledger, which remains accurate throughout
      // shutdown (and empties as each child exits).
      process.removeListener("beforeExit", this.#beforeExitListener);

      this.#endPromise = new Deferred<void>().observe(
        this.#processPool.end(gracefully, maxWaitMillis).then(() => {
          // Explicit end() is a true barrier. Automatic beforeExit cleanup may
          // instead exhaust its bound while an opaque factory is still
          // pending; if the host remains alive, the late result is terminated.
          process.removeListener("exit", this.#exitListener);
          this.emitter.emit("end");
        }),
      );
    }

    return this.#endPromise;
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
      );
      return task.promise;
    }
    this.#taskQueue.enqueue(task);
    // Immediately, not via #onIdleLater: the caller may hand control straight
    // back to the event loop, and this task must already be holding it open.
    this.#updateKeepAlive();

    // Run #onIdle now (not later), to make sure the task gets enqueued asap if
    // possible
    this.#onIdleLater();

    // (BatchProcess will call our #onIdleLater when tasks settle or when they
    // exit)

    return task.promise;
  }

  /**
   * @return true if all previously-enqueued tasks have settled
   */
  get isIdle(): boolean {
    return this.pendingTaskCount === 0 && this.busyProcCount === 0;
  }

  /**
   * Hold the event loop open while any task is outstanding.
   *
   * Everything else this library owns is deliberately unref'd -- child
   * processes, their streams, the idle interval, the respawn timer -- so that
   * an *idle* cluster never stops a script from exiting (see `unrefStreams`).
   * But without this, unsettled work has nothing holding the loop open either:
   * node drains, `beforeExit` fires, and `end()` tears down a task the caller
   * is still awaiting. The only thing that used to prevent that was the
   * per-task timeout timer, which doesn't exist at the default
   * `taskTimeoutMillis` of 0.
   *
   * The interval is long because it never needs to *do* anything; it only
   * needs to exist.
   */
  #updateKeepAlive(): void {
    if (this.ended || this.isIdle) {
      this.#clearKeepAlive();
    } else {
      this.#keepAlive ??= timers.setInterval(() => {
        // no-op: this timer exists only to keep the event loop alive
      }, secondMs);
    }
  }

  #clearKeepAlive(): void {
    if (this.#keepAlive != null) {
      timers.clearInterval(this.#keepAlive);
      this.#keepAlive = undefined;
    }
  }

  /**
   * @return the number of pending tasks
   */
  get pendingTaskCount(): number {
    return this.#taskQueue.pendingTaskCount;
  }

  /**
   * @returns {number} the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    return this.#eventCoordinator.meanTasksPerProc;
  }

  /**
   * @return the total number of child processes created by this instance
   */
  get spawnedProcCount(): number {
    return this.#processPool.spawnedProcCount;
  }

  /**
   * @return the current number of spawned child processes. Some (or all) may be idle.
   */
  get procCount(): number {
    return this.#processPool.processCount;
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return this.#processPool.busyProcCount;
  }

  get startingProcCount(): number {
    return this.#processPool.startingProcCount;
  }

  /**
   * @return the current pending Tasks (mostly for testing)
   */
  get pendingTasks(): readonly Task[] {
    return this.#taskQueue.pendingTasks;
  }

  /**
   * @return the current running Tasks (mostly for testing)
   */
  get currentTasks(): Task[] {
    return this.#processPool.currentTasks();
  }

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this.#eventCoordinator.internalErrorCount;
  }

  /**
   * Verify that each BatchProcess PID is actually alive.
   *
   * @return the spawned PIDs that are still in the process table.
   */
  pids(): number[] {
    return this.#processPool.pids();
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
      msBeforeNextSpawn: this.#processPool.msBeforeNextSpawn,
      spawnedProcCount: this.spawnedProcCount,
      childEndCounts: this.childEndCounts,
      ending: this.#endPromise != null,
      ended: false === this.#endPromise?.pending,
    };
  }

  /**
   * Get ended process counts (used for tests)
   */
  countEndedChildProcs(why: ChildEndReason): number {
    return this.#eventCoordinator.countEndedChildProcs(why);
  }

  get childEndCounts(): Record<NonNullable<ChildEndReason>, number> {
    return this.#eventCoordinator.childEndCounts;
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true): Promise<void> {
    return this.#processPool.closeChildProcesses(gracefully);
  }

  /**
   * Reset the maximum number of active child processes to `maxProcs`. Note that
   * this is handled gracefully: child processes are only reduced as tasks are
   * completed.
   */
  setMaxProcs(maxProcs: number) {
    this.#processPool.setMaxProcs(maxProcs);
    // we may now be able to handle an enqueued task. Vacuum pids and see:
    this.#onIdleLater();
  }

  readonly #onIdleLater = () => {
    if (!this.#onIdleRequested) {
      this.#onIdleRequested = true;
      timers.setTimeout(() => this.#onIdle(), 1);
    }
  };

  // NOT ASYNC: updates internal state:
  #onIdle() {
    this.#onIdleRequested = false;
    void this.vacuumProcs();
    while (this.#execNextTask()) {
      //
    }
    void this.#maybeSpawnProcs();
    // Every transition that can make us idle (or busy) routes through here:
    this.#updateKeepAlive();
  }

  /**
   * Run maintenance on currently spawned child processes. This method is
   * normally invoked automatically as tasks are enqueued and processed.
   *
   * Only public for tests.
   */
  // NOT ASYNC: updates internal state. only exported for tests.
  vacuumProcs() {
    return this.#processPool.vacuumProcs();
  }

  /**
   * NOT ASYNC: updates internal state.
   * @return true iff a task was submitted to a child process
   */
  #execNextTask(): boolean {
    if (this.ended) return false;
    const readyProc = this.#processPool.findReadyProcess();
    return this.#taskQueue.tryAssignNextTask(readyProc);
  }

  async #maybeSpawnProcs() {
    return this.#processPool.maybeSpawnProcs(this.#taskQueue.pendingTaskCount);
  }
}
