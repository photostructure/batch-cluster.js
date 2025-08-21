import timers from "node:timers";
import { count, filterInPlace } from "./Array";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { asError } from "./Error";
import { Logger } from "./Logger";
import { ProcessHealthMonitor } from "./ProcessHealthMonitor";
import { Task } from "./Task";
import { Timeout, thenOrTimeout } from "./Timeout";

/**
 * Manages the lifecycle of a pool of BatchProcess instances.
 * Handles spawning, health monitoring, and cleanup of child processes.
 */
export class ProcessPoolManager {
  readonly #procs: BatchProcess[] = [];
  readonly #logger: () => Logger;
  readonly #healthMonitor: ProcessHealthMonitor;
  #nextSpawnTime = 0;
  #lastPidsCheckTime = 0;
  #spawnedProcs = 0;

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
   * Shut down any currently-running child processes.
   */
  async closeChildProcesses(gracefully = true): Promise<void> {
    const procs = [...this.#procs];
    this.#procs.length = 0;
    await Promise.all(
      procs.map((proc) =>
        proc
          .end(gracefully, "ending")
          .catch((err) => this.emitter.emit("endError", asError(err), proc)),
      ),
    );
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
          endPromises.push(proc.end(true, why));
          return false;
        }
        proc.maybeRunHealthcheck();
      }
      return true;
    });

    return Promise.all(endPromises);
  }

  /**
   * Spawn new processes if needed based on pending task count and capacity
   */
  async maybeSpawnProcs(
    pendingTaskCount: number,
    ended: boolean,
  ): Promise<void> {
    let procsToSpawn = this.#procsToSpawn(pendingTaskCount);

    if (ended || this.#nextSpawnTime > Date.now() || procsToSpawn === 0) {
      return;
    }

    // prevent concurrent runs:
    this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay();

    for (let i = 0; i < procsToSpawn; i++) {
      if (ended) {
        break;
      }

      // Kick the lock down the road:
      this.#nextSpawnTime = Date.now() + this.#maxSpawnDelay();
      this.#spawnedProcs++;

      try {
        const proc = this.#spawnNewProc();
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

  // must only be called by this.maybeSpawnProcs()
  async #spawnNewProc(): Promise<BatchProcess> {
    // no matter how long it takes to spawn, always push the result into #procs
    // so we don't leak child processes:
    const procOrPromise = this.options.processFactory();
    const proc = await procOrPromise;
    const result = new BatchProcess(
      proc,
      this.options,
      this.onIdle,
      this.#healthMonitor,
    );
    this.#procs.push(result);
    return result;
  }
}
