import child_process from "node:child_process";
import { until } from "./Async";
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
import { Logger } from "./Logger";
import { killerFor, killGroupOnly } from "./Pids";
import { destroy } from "./Stream";
import { ensureSuffix } from "./String";
import { Task } from "./Task";
import { thenOrTimeout } from "./Timeout";

/**
 * Utility class for managing process termination lifecycle
 */
export class ProcessTerminator {
  readonly #logger: () => Logger;
  readonly #kill: (pid: number | undefined, force?: boolean) => boolean;
  readonly #killGroupOnly: (
    pid: number | undefined,
    force?: boolean,
  ) => boolean;

  /**
   * @param killFn sends a signal to the given pid. Defaults to the kill
   * function implied by `killProcessGroup`. Only expected to be provided by
   * tests, which must not signal pids they don't own.
   * @param killGroupOnlyFn signals a detached POSIX process group without
   * falling back to the leader pid after that leader has exited.
   */
  constructor(
    private readonly opts: InternalBatchProcessOptions,
    killFn?: (pid: number | undefined, force?: boolean) => boolean,
    killGroupOnlyFn?: (pid: number | undefined, force?: boolean) => boolean,
  ) {
    this.#logger = opts.logger;
    this.#kill = killFn ?? killerFor(opts);
    this.#killGroupOnly = killGroupOnlyFn ?? killGroupOnly;
  }

  /**
   * Terminates a child process gracefully or forcefully
   *
   * @param proc The child process to terminate
   * @param processName Name for logging purposes
   * @param pid Process ID
   * @param lastTask Current task being processed
   * @param startupTaskId ID of the startup task
   * @param gracefully Whether to wait for current task completion
   * @param reason Reason for termination
   * @param isExited Whether the process has already exited
   * @param isRunning Function to check if process is still running
   * @returns Promise that resolves when termination is complete
   */
  async terminate(
    proc: child_process.ChildProcess,
    processName: string,
    lastTask: Task<unknown> | undefined,
    startupTaskId: number,
    gracefully: boolean,
    isExited: boolean,
    isRunning: () => boolean,
  ): Promise<void> {
    // Wait for current task to complete if graceful termination requested
    await this.#waitForTaskCompletion(lastTask, startupTaskId, gracefully);

    // Remove error listeners to prevent EPIPE errors during termination
    this.#removeErrorListeners(proc);

    // Send exit command to process
    this.#sendExitCommand(proc);

    // Destroy streams
    this.#destroyStreams(proc);

    // Handle graceful shutdown with timeouts
    await this.#handleGracefulShutdown(proc, gracefully, isExited, isRunning);

    // Force kill if still running
    this.#forceKillIfRunning(proc, processName, isRunning);

    // Final cleanup
    try {
      proc.disconnect?.();
    } catch {
      // Ignore disconnect errors
    }
    // Note: Caller should emit childEnd event with proper BatchProcess instance
  }

  async #waitForTaskCompletion(
    lastTask: Task<unknown> | undefined,
    startupTaskId: number,
    gracefully: boolean,
  ): Promise<void> {
    // Don't wait for startup tasks or if no task is running
    if (lastTask == null || lastTask.taskId === startupTaskId) {
      return;
    }

    try {
      // Wait for the process to complete and streams to flush
      await thenOrTimeout(lastTask.promise, gracefully ? 2000 : 250);
    } catch {
      // Ignore errors during task completion wait
    }

    // Reject task if still pending
    if (lastTask.pending) {
      lastTask.reject(
        new Error(
          `Process terminated before task completed (${JSON.stringify({
            gracefully,
            lastTask,
          })})`,
        ),
      );
    }
  }

  #removeErrorListeners(proc: child_process.ChildProcess): void {
    // Remove error listeners to prevent EPIPE errors during termination
    // See https://github.com/nodejs/node/issues/26828
    for (const stream of [proc, proc.stdin, proc.stdout, proc.stderr]) {
      stream?.removeAllListeners("error");
    }
  }

  #sendExitCommand(proc: child_process.ChildProcess): void {
    if (proc.stdin?.writable !== true) {
      return;
    }

    const exitCmd =
      this.opts.exitCommand == null
        ? null
        : ensureSuffix(this.opts.exitCommand, "\n");

    try {
      proc.stdin.end(exitCmd);
    } catch {
      // Ignore errors when sending exit command
    }
  }

  #destroyStreams(proc: child_process.ChildProcess): void {
    // Destroy all streams to ensure cleanup
    destroy(proc.stdin);
    destroy(proc.stdout);
    destroy(proc.stderr);
  }

  async #handleGracefulShutdown(
    proc: child_process.ChildProcess,
    gracefully: boolean,
    isExited: boolean,
    isRunning: () => boolean,
  ): Promise<void> {
    if (
      !this.opts.cleanupChildProcs ||
      !gracefully ||
      this.opts.endGracefulWaitTimeMillis <= 0 ||
      isExited
    ) {
      return;
    }

    // Wait for the exit command to take effect
    await this.#awaitNotRunning(
      this.opts.endGracefulWaitTimeMillis / 2,
      isRunning,
    );

    // If still running, send kill signal
    if (isRunning() && proc.pid != null) {
      if (this.opts.killProcessGroup) {
        this.#kill(proc.pid);
      } else {
        proc.kill();
      }
    }

    // Wait for the signal handler to work
    await this.#awaitNotRunning(
      this.opts.endGracefulWaitTimeMillis / 2,
      isRunning,
    );
  }

  #forceKillIfRunning(
    proc: child_process.ChildProcess,
    processName: string,
    isRunning: () => boolean,
  ): void {
    if (!this.opts.cleanupChildProcs || proc.pid == null) return;

    const directChildRunning = isRunning();
    // A detached process group can outlive its leader. Signal the group even
    // after the direct child exits, and do not fall back to that dead pid.
    const groupKilled =
      this.opts.killProcessGroup && this.#killGroupOnly(proc.pid, true);
    const killed = groupKilled
      ? true
      : directChildRunning
        ? this.#kill(proc.pid, true)
        : false;

    if (directChildRunning && killed) {
      // Kill first, then log: `logger` is consumer-supplied, and one that
      // throws must not be able to skip the kill and strand the child.
      this.#logger().warn(
        `${processName}.terminate(): force-killed still-running child.`,
      );
    }
  }

  async #awaitNotRunning(
    timeout: number,
    isRunning: () => boolean,
  ): Promise<void> {
    await until(() => !isRunning(), timeout);
  }
}
