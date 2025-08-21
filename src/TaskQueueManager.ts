import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { Logger } from "./Logger";
import { Task } from "./Task";

/**
 * Manages task queuing, scheduling, and assignment to ready processes.
 * Handles the task lifecycle from enqueue to assignment.
 */
export class TaskQueueManager {
  readonly #tasks: Task[] = [];
  readonly #logger: () => Logger;

  constructor(
    logger: () => Logger,
    private readonly emitter?: BatchClusterEmitter,
  ) {
    this.#logger = logger;
  }

  /**
   * Add a task to the queue for processing
   */
  enqueueTask<T>(task: Task<T>, ended: boolean): Promise<T> {
    if (ended) {
      task.reject(
        new Error("BatchCluster has ended, cannot enqueue " + task.command),
      );
    } else {
      this.#tasks.push(task as Task<unknown>);
    }
    return task.promise;
  }

  /**
   * Simple enqueue method (alias for enqueueTask without ended check)
   */
  enqueue(task: Task<unknown>): void {
    this.#tasks.push(task);
  }

  /**
   * Get the number of pending tasks in the queue
   */
  get pendingTaskCount(): number {
    return this.#tasks.length;
  }

  /**
   * Get all pending tasks (mostly for testing)
   */
  get pendingTasks(): readonly Task[] {
    return this.#tasks;
  }

  /**
   * Check if the queue is empty
   */
  get isEmpty(): boolean {
    return this.#tasks.length === 0;
  }

  /**
   * Attempt to assign the next task to a ready process.
   * Returns true if a task was successfully assigned.
   */
  tryAssignNextTask(
    readyProcess: BatchProcess | undefined,
    retries = 1,
  ): boolean {
    if (this.#tasks.length === 0 || retries < 0) {
      return false;
    }

    // no procs are idle and healthy :(
    if (readyProcess == null) {
      return false;
    }

    const task = this.#tasks.shift();
    if (task == null) {
      this.emitter?.emit("internalError", new Error("unexpected null task"));
      return false;
    }

    const submitted = readyProcess.execTask(task);
    if (!submitted) {
      // This isn't an internal error: the proc may have needed to run a health
      // check. Let's reschedule the task and try again:
      this.#tasks.push(task);
      // We don't want to return false here (it'll stop the assignment loop) unless
      // we actually can't submit the task:
      return this.tryAssignNextTask(readyProcess, retries - 1);
    }

    this.#logger().trace(
      "TaskQueueManager.tryAssignNextTask(): submitted task",
      {
        child_pid: readyProcess.pid,
        task,
      },
    );

    return submitted;
  }

  /**
   * Process all pending tasks by assigning them to ready processes.
   * Returns the number of tasks successfully assigned.
   */
  processQueue(findReadyProcess: () => BatchProcess | undefined): number {
    let assignedCount = 0;

    while (this.#tasks.length > 0) {
      const readyProcess = findReadyProcess();
      if (!this.tryAssignNextTask(readyProcess)) {
        break;
      }
      assignedCount++;
    }

    return assignedCount;
  }

  /**
   * Clear all pending tasks (used during shutdown)
   */
  clearAllTasks(): void {
    this.#tasks.length = 0;
  }

  /**
   * Get statistics about task assignment and queue state
   */
  getQueueStats() {
    return {
      pendingTaskCount: this.#tasks.length,
      isEmpty: this.isEmpty,
    };
  }
}
