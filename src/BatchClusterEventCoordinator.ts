import { BatchClusterEmitter, ChildEndReason } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { Logger } from "./Logger";
import { Mean } from "./Mean";
import { toS } from "./String";

/**
 * Configuration for event handling behavior
 */
export interface EventCoordinatorOptions {
  readonly streamFlushMillis: number;
  readonly logger: () => Logger;
}

/**
 * Centralized coordinator for BatchCluster events.
 * Handles event processing, statistics tracking, and automated responses to events.
 */
export class BatchClusterEventCoordinator {
  readonly #logger: () => Logger;
  #tasksPerProc = new Mean();
  readonly #childEndCounts = new Map<ChildEndReason, number>();
  #internalErrorCount = 0;

  constructor(
    private readonly emitter: BatchClusterEmitter,
    private readonly options: EventCoordinatorOptions,
    private readonly onIdleLater: () => void,
  ) {
    this.#logger = options.logger;
    this.#setupEventHandlers();
  }

  /**
   * Set up all event handlers for the BatchCluster
   */
  #setupEventHandlers(): void {
    this.emitter.on("childEnd", (bp, why) => this.#handleChildEnd(bp, why));
    this.emitter.on("internalError", (error) =>
      this.#handleInternalError(error),
    );
    this.emitter.on("noTaskData", (stdout, stderr, proc) =>
      this.#handleNoTaskData(stdout, stderr, proc),
    );
    this.emitter.on("startError", (error) => this.#handleStartError(error));
  }

  /**
   * Handle child process end events
   */
  #handleChildEnd(process: BatchProcess, reason: ChildEndReason): void {
    this.#tasksPerProc.push(process.taskCount);
    this.#childEndCounts.set(
      reason,
      (this.#childEndCounts.get(reason) ?? 0) + 1,
    );
    this.onIdleLater();
  }

  /**
   * Handle internal error events
   */
  #handleInternalError(error: Error): void {
    this.#logger().error("BatchCluster: INTERNAL ERROR: " + String(error));
    this.#internalErrorCount++;
  }

  /**
   * Handle no task data events (data received without current task)
   */
  #handleNoTaskData(
    stdout: string | Buffer | null,
    stderr: string | Buffer | null,
    proc: BatchProcess,
  ): void {
    this.#logger().warn(
      "BatchCluster: child process emitted data with no current task. Consider setting streamFlushMillis to a higher value.",
      {
        streamFlushMillis: this.options.streamFlushMillis,
        stdout: toS(stdout),
        stderr: toS(stderr),
        proc_pid: proc?.pid,
      },
    );
    this.#internalErrorCount++;
  }

  /**
   * Handle start error events.
   * Logs a warning and triggers idle processing to spawn replacement processes.
   * Note: We intentionally do NOT shut down the cluster on spawn failures.
   * The minDelayBetweenSpawnMillis setting already prevents fork bombs.
   */
  #handleStartError(error: Error): void {
    this.#logger().warn("BatchCluster.onStartError(): " + String(error));
    this.onIdleLater();
  }

  /**
   * Get the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    const mean = this.#tasksPerProc.mean;
    return isNaN(mean) ? 0 : mean;
  }

  /**
   * Get internal error count
   */
  get internalErrorCount(): number {
    return this.#internalErrorCount;
  }

  /**
   * Get count of ended child processes by reason
   */
  countEndedChildProcs(reason: ChildEndReason): number {
    return this.#childEndCounts.get(reason) ?? 0;
  }

  /**
   * Get all child end counts
   */
  get childEndCounts(): Record<NonNullable<ChildEndReason>, number> {
    return Object.fromEntries([...this.#childEndCounts.entries()]) as Record<
      NonNullable<ChildEndReason>,
      number
    >;
  }

  /**
   * Get event statistics for monitoring
   */
  getEventStats() {
    return {
      meanTasksPerProc: this.meanTasksPerProc,
      internalErrorCount: this.internalErrorCount,
      totalChildEndEvents: [...this.#childEndCounts.values()].reduce(
        (sum, count) => sum + count,
        0,
      ),
      childEndReasons: Object.keys(this.childEndCounts),
    };
  }

  /**
   * Reset event statistics (useful for testing)
   */
  resetStats(): void {
    this.#tasksPerProc = new Mean();
    this.#childEndCounts.clear();
    this.#internalErrorCount = 0;
  }

  /**
   * Get the underlying emitter for direct event access
   */
  get events(): BatchClusterEmitter {
    return this.emitter;
  }
}
