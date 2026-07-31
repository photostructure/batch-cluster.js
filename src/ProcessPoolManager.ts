import child_process from "node:child_process";
import timers from "node:timers";
import { count, filterInPlace } from "./Array";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { asError } from "./Error";
import { Logger } from "./Logger";
import { killerFor } from "./Pids";
import { ProcessHealthMonitor } from "./ProcessHealthMonitor";
import { Task } from "./Task";
import { Timeout, thenOrTimeout } from "./Timeout";
import { WhyNotHealthy } from "./WhyNotHealthy";

/**
 * Manages the lifecycle of a pool of BatchProcess instances.
 * Handles spawning, health monitoring, and cleanup of child processes.
 */
export class ProcessPoolManager {
  readonly #procs: BatchProcess[] = [];

  /**
   * Every child this pool has spawned whose "exit" event we haven't seen yet.
   *
   * This is deliberately separate from {@link ProcessPoolManager.processes}:
   * `#procs` answers "who can run a task?", and a process leaves it the moment
   * we decide to recycle it — well before it actually dies. This answers "who
   * must I kill?", which is only true once the OS says the child is gone.
   */
  readonly #unexitedProcs = new Set<child_process.ChildProcess>();

  /**
   * Spawns whose `processFactory()` hasn't resolved yet. A factory may already
   * have spawned its child before it starts validating it, so these represent
   * children that may exist but that we can't see yet.
   */
  readonly #spawning = new Set<Promise<unknown>>();

  /**
   * Terminations we've started but not finished. A recycled process leaves
   * `#procs` immediately and can spend seconds in its graceful-shutdown window,
   * so this is the only record that it's still being dealt with.
   */
  readonly #terminating = new Map<Promise<unknown>, BatchProcess>();
  readonly #logger: () => Logger;
  readonly #healthMonitor: ProcessHealthMonitor;
  #nextSpawnTime = 0;
  #lastPidsCheckTime = 0;
  #spawnedProcs = 0;
  #ended = false;

  constructor(
    private readonly options: CombinedBatchProcessOptions,
    private readonly emitter: BatchClusterEmitter,
    private readonly onIdle: () => void,
  ) {
    this.#logger = options.logger;
    this.#healthMonitor = new ProcessHealthMonitor(options, emitter);
  }

  /**
   * Get all current processes
   */
  get processes(): readonly BatchProcess[] {
    return this.#procs;
  }

  /**
   * Get the current number of spawned child processes
   */
  get procCount(): number {
    return this.#procs.length;
  }

  /**
   * Alias for procCount to match BatchCluster interface
   */
  get processCount(): number {
    return this.procCount;
  }

  /**
   * Get the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return count(
      this.#procs,
      // don't count procs that are starting up as "busy":
      (ea) => !ea.starting && !ea.ending && !ea.idle,
    );
  }

  /**
   * Get the current number of starting processes
   */
  get startingProcCount(): number {
    return count(
      this.#procs,
      // don't count procs that are starting up as "busy":
      (ea) => ea.starting && !ea.ending,
    );
  }

  /**
   * Get the current number of ready processes
   */
  get readyProcCount(): number {
    return count(this.#procs, (ea) => ea.ready);
  }

  /**
   * Get the total number of child processes created by this instance
   */
  get spawnedProcCount(): number {
    return this.#spawnedProcs;
  }

  /**
   * Get the milliseconds until the next spawn is allowed
   */
  get msBeforeNextSpawn(): number {
    return Math.max(0, this.#nextSpawnTime - Date.now());
  }

  /**
   * Get all currently running tasks from all processes
   */
  currentTasks(): Task<unknown>[] {
    const tasks: Task<unknown>[] = [];
    for (const proc of this.#procs) {
      if (proc.currentTask != null) {
        tasks.push(proc.currentTask);
      }
    }
    return tasks;
  }

  /**
   * Find the first ready process that can handle a new task
   */
  findReadyProcess(): BatchProcess | undefined {
    return this.#procs.find((ea) => ea.ready);
  }

  /**
   * @return the PIDs of every child this pool spawned whose "exit" event we
   * haven't seen yet, **including** children that have already left the pool
   * (because they're being recycled) and children that never made it into the
   * pool (because adoption failed).
   *
   * Contrast with {@link ProcessPoolManager.pids}, which reports only the
   * still-running members of the schedulable pool. This is what must be killed
   * if the host process exits mid-shutdown.
   */
  unexitedPids(): number[] {
    const arr: number[] = [];
    for (const proc of this.#unexitedProcs) {
      if (proc.pid != null) arr.push(proc.pid);
    }
    return arr;
  }

  /**
   * Verify that each BatchProcess PID is actually alive.
   * @return the spawned PIDs that are still in the process table.
   */
  pids(): number[] {
    const arr: number[] = [];
    for (const proc of [...this.#procs]) {
      if (proc != null && proc.running()) {
        arr.push(proc.pid);
      }
    }
    return arr;
  }

  /**
   * @return true if {@link ProcessPoolManager.end} has been called.
   */
  get ended(): boolean {
    return this.#ended;
  }

  /**
   * Permanently shut this pool down: no further child processes will be
   * spawned, and wait for every child this pool created to be terminated.
   *
   * By default this is a true barrier, so `await end(); process.exit(0)` cannot
   * orphan a child hidden inside an async `processFactory()`. The automatic
   * `beforeExit` path supplies `maxWaitMillis`, because Node cannot wait
   * forever for an opaque factory during process exit. If that bound expires,
   * shutdown force-kills everything currently visible and any factory result
   * that arrives while the host remains alive is still terminated.
   *
   * Draining `#procs` is not enough on its own: a `processFactory()` still in
   * flight can hand us a live child afterwards, and a process that
   * `vacuumProcs()` already removed from `#procs` can still be in its
   * graceful-shutdown window.
   *
   * Contrast with {@link ProcessPoolManager.closeChildProcesses}, which only
   * recycles the current children and leaves the pool able to spawn more.
   *
   * @param maxWaitMillis optional bound used only by automatic process-exit
   * cleanup. Omit it for the public `BatchCluster.end()` barrier.
   */
  async end(gracefully = true, maxWaitMillis?: number): Promise<void> {
    this.#ended = true;
    // The automatic beforeExit cleanup is bounded because an opaque
    // processFactory may never settle. Explicit end() deliberately has no
    // deadline: there is no way to promise that a factory-owned child is gone
    // until the factory either returns it or rejects.
    const deadline =
      maxWaitMillis == null ? undefined : Date.now() + maxWaitMillis;
    // Clears #procs synchronously, before any await, so callers still see the
    // pool empty immediately after calling end(). Deliberately not awaited
    // here: each termination it starts is tracked in #terminating, and the
    // bounded loop below is what waits for them.
    void this.closeChildProcesses(gracefully).catch(() => {
      // per-process failures are already reported as endError
    });
    // Each pass can reveal more work: an awaited spawn can start a tracked
    // termination. The loop ends because #ended stops maybeSpawnProcs from
    // starting anything new.
    while (
      this.#spawning.size > 0 ||
      this.#terminating.size > 0 ||
      this.#procs.length > 0
    ) {
      const remainingMs = deadline == null ? undefined : deadline - Date.now();
      // thenOrTimeout treats <= 1 as "disabled", which would turn automatic
      // cleanup into an unbounded wait at the deadline.
      if (remainingMs != null && remainingMs <= 1) {
        // We've spent the whole budget. Two things must still be true before
        // we resolve, because BatchCluster drops the synchronous exit backstop
        // the moment we do, and callers `process.exit()` right after:
        //
        // 1. nothing we know about is still running, and
        // 2. no task the caller is awaiting is left dangling.
        //
        // Both happen before the log: a consumer-supplied logger that throws
        // must not be able to skip either.
        const abandoned = this.#forceKillAll();
        const strandedTasks = [...this.#terminating.values()].filter((proc) =>
          proc.abandonTerminatingTask(
            "BatchCluster.end() timed out while this task's process was terminating",
          ),
        ).length;
        this.#logger().warn(
          "ProcessPoolManager.end(): timed out waiting for child lifecycle work",
          {
            spawning: this.#spawning.size,
            terminating: this.#terminating.size,
            killed: abandoned,
            strandedTasks,
            cleanupChildProcs: this.options.cleanupChildProcs,
          },
        );
        return;
      }
      const pending = Promise.allSettled([
        ...this.#spawning,
        ...this.#terminating.keys(),
      ]);
      if (remainingMs == null) {
        await pending;
      } else {
        await thenOrTimeout(pending, remainingMs);
      }
      await this.closeChildProcesses(gracefully);
    }
  }

  /**
   * Shut down any currently-running child processes.
   */
  async closeChildProcesses(gracefully = true): Promise<void> {
    const procs = [...this.#procs];
    this.#procs.length = 0;
    await Promise.all(procs.map((proc) => this.#endProc(proc, gracefully)));
  }

  /**
   * Terminate `proc`, remembering the attempt until it settles so {@link
   * ProcessPoolManager.end} can wait for it.
   *
   * Rejections become `endError` rather than escaping: every caller is either
   * fire-and-forget (`void vacuumProcs()`) or fans out over several processes,
   * where one rejection would strand the rest.
   */
  #endProc(
    proc: BatchProcess,
    gracefully: boolean,
    reason: WhyNotHealthy = "ending",
  ): Promise<void> {
    const ending = proc.end(gracefully, reason).catch((err) => {
      // Termination can reject *before* the child was signalled. Reporting a
      // clean finish here would let end() resolve, and BatchCluster drop the
      // exit backstop, with the child still running -- so make sure it's dead
      // before we call this attempt complete. Kill before emitting: a throwing
      // endError listener must not skip it either.
      this.#forceKill(proc.pid);
      this.emitter.emit("endError", asError(err), proc);
    });
    this.#terminating.set(ending, proc);
    void ending.then(
      () => this.#terminating.delete(ending),
      () => this.#terminating.delete(ending),
    );
    return ending;
  }

  /**
   * Run maintenance on currently spawned child processes.
   * Removes unhealthy processes and enforces maxProcs limit.
   */
  vacuumProcs(): Promise<void[]> {
    this.#maybeCheckPids();
    const endPromises: Promise<void>[] = [];
    let pidsToReap = Math.max(0, this.#procs.length - this.options.maxProcs);

    filterInPlace(this.#procs, (proc) => {
      // Only check `.idle` (not `.ready`) procs. We don't want to reap busy
      // procs unless we're ending, and unhealthy procs (that we want to reap)
      // won't be `.ready`.
      if (proc.idle) {
        // don't reap more than pidsToReap pids. We can't use #procs.length
        // within filterInPlace because #procs.length only changes at iteration
        // completion: the prior impl resulted in all idle pids getting reaped
        // when maxProcs was reduced.
        const why =
          proc.whyNotHealthy ?? (--pidsToReap >= 0 ? "tooMany" : null);
        if (why != null) {
          endPromises.push(this.#endProc(proc, true, why));
          return false;
        }
        proc.maybeRunHealthCheck();
      }
      return true;
    });

    return Promise.all(endPromises);
  }

  /**
   * Spawn new processes if needed based on pending task count and capacity
   */
  async maybeSpawnProcs(pendingTaskCount: number): Promise<void> {
    let procsToSpawn = this.#procsToSpawn(pendingTaskCount);

    if (this.#ended || this.#nextSpawnTime > Date.now() || procsToSpawn === 0) {
      return;
    }

    // prevent concurrent runs:
    this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay();

    for (let i = 0; i < procsToSpawn; i++) {
      // Re-read #ended every iteration: end() may have landed while we awaited
      // the prior spawn.
      if (this.#ended) {
        break;
      }

      // Kick the lock down the road:
      this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay();
      this.#spawnedProcs++;

      try {
        // Registered before the first await, so end() can never miss it:
        const proc = this.#trackSpawn(this.#spawnNewProc());
        const result = await thenOrTimeout(
          proc,
          this.options.spawnTimeoutMillis,
        );
        if (result === Timeout) {
          void proc
            .then((bp) => {
              void bp.end(false, "startError");
              this.emitter.emit(
                "startError",
                asError(
                  "Failed to spawn process in " +
                    this.options.spawnTimeoutMillis +
                    "ms",
                ),
                bp,
              );
            })
            .catch((err) => {
              // this should only happen if the processFactory throws a
              // rejection:
              this.emitter.emit("startError", asError(err));
            });
        } else {
          this.#logger().debug(
            "ProcessPoolManager.maybeSpawnProcs() started healthy child process",
            { pid: result.pid },
          );
        }

        // tasks may have been popped off or setMaxProcs may have reduced
        // maxProcs. Do this at the end so the for loop ends properly.
        procsToSpawn = Math.min(
          this.#procsToSpawn(pendingTaskCount),
          procsToSpawn,
        );
      } catch (err) {
        this.emitter.emit("startError", asError(err));
      }
    }

    // YAY WE MADE IT.
    // Only let more children get spawned after minDelay:
    const delay = Math.max(100, this.options.minDelayBetweenSpawnMillis);
    this.#nextSpawnTime = Date.now() + delay;

    // And schedule #onIdle for that time:
    timers.setTimeout(this.onIdle, delay).unref();
  }

  /**
   * Update the maximum number of processes allowed
   */
  setMaxProcs(maxProcs: number): void {
    this.options.maxProcs = maxProcs;
  }

  #maybeCheckPids(): void {
    if (
      this.options.cleanupChildProcs &&
      this.options.pidCheckIntervalMillis > 0 &&
      this.#lastPidsCheckTime + this.options.pidCheckIntervalMillis < Date.now()
    ) {
      this.#lastPidsCheckTime = Date.now();
      void this.pids();
    }
  }

  #maxSpawnDelay(): number {
    // 10s delay is certainly long enough for .spawn() to return, even on a
    // loaded windows machine.
    return Math.max(10_000, this.options.spawnTimeoutMillis);
  }

  #procsToSpawn(pendingTaskCount: number): number {
    const remainingCapacity = this.options.maxProcs - this.#procs.length;

    // take into account starting procs, so one task doesn't result in multiple
    // processes being spawned:
    const requestedCapacity = pendingTaskCount - this.startingProcCount;

    const atLeast0 = Math.max(
      0,
      Math.min(remainingCapacity, requestedCapacity),
    );

    return this.options.minDelayBetweenSpawnMillis === 0
      ? // we can spin up multiple processes in parallel.
        atLeast0
      : // Don't spin up more than 1:
        Math.min(1, atLeast0);
  }

  /**
   * Take ownership of a freshly-spawned child, so we can still kill it if the
   * host process exits before the child does.
   */
  #adoptChild(proc: child_process.ChildProcess): void {
    // An async processFactory can outlive its own child, so don't subscribe to
    // an "exit" that already fired -- that would strand a dead pid in the set.
    if (proc.pid == null || proc.exitCode != null || proc.signalCode != null) {
      return;
    }
    this.#unexitedProcs.add(proc);
    proc.once("exit", () => this.#unexitedProcs.delete(proc));
  }

  /**
   * Last-resort kill for a child that our normal termination path failed to
   * stop.
   *
   * Honors `cleanupChildProcs`: a caller who disabled it told us they have
   * another means of PID cleanup, so we must not signal on their behalf --
   * even when we'd rather.
   *
   * @return true if the signal was sent.
   */
  #forceKill(pid: number | undefined): boolean {
    if (!this.options.cleanupChildProcs) return false;
    return killerFor(this.options)(pid, true);
  }

  /**
   * @return the pids of every child we force-killed. Empty when
   * `cleanupChildProcs` is disabled.
   */
  #forceKillAll(): number[] {
    if (!this.options.cleanupChildProcs) return [];
    const pids = this.unexitedPids();
    const killFn = killerFor(this.options);
    for (const pid of pids) killFn(pid, true);
    return pids;
  }

  #trackSpawn(spawning: Promise<BatchProcess>): Promise<BatchProcess> {
    this.#spawning.add(spawning);
    // Both handlers, so this never adds an unhandled rejection of its own: the
    // caller has its own error handling.
    void spawning.then(
      () => this.#spawning.delete(spawning),
      () => this.#spawning.delete(spawning),
    );
    return spawning;
  }

  // must only be called by this.maybeSpawnProcs()
  async #spawnNewProc(): Promise<BatchProcess> {
    const proc = await this.options.processFactory();
    this.#adoptChild(proc);
    let result: BatchProcess;
    try {
      result = new BatchProcess(
        proc,
        this.options,
        this.onIdle,
        this.#healthMonitor,
      );
    } catch (err) {
      // The factory handed us a live child, and construction rejected it (no
      // stdin or stdout, or a childStart listener threw). We own that child
      // until a BatchProcess does, so kill it instead of leaking it -- unless
      // the caller has taken PID cleanup on themselves.
      if (!this.options.cleanupChildProcs) {
        this.#logger().warn(
          "ProcessPoolManager: could not adopt a spawned child, and cleanupChildProcs is disabled; it is yours to clean up",
          { pid: proc.pid },
        );
      } else if (!this.#forceKill(proc.pid)) {
        this.#logger().warn(
          "ProcessPoolManager: could not confirm that an unadoptable child was force-killed; it may already have exited or the signal could not be delivered",
          { pid: proc.pid },
        );
      }
      throw err;
    }
    if (this.#ended) {
      // end() normally sees this through #spawning and waits for the tracked
      // termination. If its bounded wait has already expired, #endProc still
      // prevents a late factory result from becoming a live member of an ended
      // pool. Its catch also prevents a throwing childEnd listener from
      // becoming an unhandled rejection.
      void this.#endProc(result, false);
    } else {
      this.#procs.push(result);
    }
    return result;
  }
}
