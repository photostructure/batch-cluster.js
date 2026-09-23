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
  enqueue<T>(task: Task<T>): void {
    this.#tasks.push(task as Task<unknown>);
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
  tryAssignNextTask(readyProcess: BatchProcess | undefined): boolean {
    if (this.#tasks.length === 0 || readyProcess == null) {
      return false;
    }

    const task = this.#tasks.shift();
    if (task == null) {
      this.emitter?.emit("internalError", new Error("unexpected null task"));
      return false;
    }

    if (!task.pending) {
      // Its caller rejected it while it was queued: never execute it.
      return this.tryAssignNextTask(readyProcess);
    }

    if (readyProcess.execTask(task)) {
      this.#logger().trace("tryAssignNextTask(): task submitted", {
        pid: readyProcess.pid,
        taskId: task.taskId,
      });
      return true;
    }

    // Process became unavailable (ending or busy). Requeue for next onIdle.
    if (task.pending) this.#tasks.push(task);
    this.#logger().debug(
      "tryAssignNextTask(): process unavailable, task requeued",
      {
        pid: readyProcess.pid,
        taskId: task.taskId,
      },
    );
    return false;
  }

  /**
   * Remove `task` if it is still waiting for a process.
   * @return true if the task was removed
   */
  remove<T>(task: Task<T>): boolean {
    const i = this.#tasks.indexOf(task as Task<unknown>);
    if (i < 0) return false;
    this.#tasks.splice(i, 1);
    return true;
  }

  /**
   * Reject and discard every queued task.
   *
   * A queued task has no owning child process, so nothing else will ever
   * settle it: `ProcessTerminator` only rejects the task a process was
   * actually running. Leaving them unsettled is the worst outcome for the
   * caller -- their `await` never returns, and because this library holds no
   * ref'd handles of its own, node can exit 0 with no error at all.
   *
   * @param reason prefixed to each task's command in the rejection message.
   */
  rejectPendingTasks(reason: string): void {
    const pending = this.#tasks.splice(0, this.#tasks.length);
    for (const task of pending) {
      task.reject(new Error(reason + ": " + task.command));
    }
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
