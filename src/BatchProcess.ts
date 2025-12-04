import child_process from "node:child_process";
import timers from "node:timers";
import { Deferred } from "./Deferred";
import { cleanError } from "./Error";
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
import { Logger } from "./Logger";
import { map } from "./Object";
import { SimpleParser } from "./Parser";
import { pidExists } from "./Pids";
import { ProcessHealthMonitor } from "./ProcessHealthMonitor";
import { ProcessTerminator } from "./ProcessTerminator";
import { StreamContext, StreamHandler } from "./StreamHandler";
import { ensureSuffix } from "./String";
import { Task } from "./Task";
import { WhyNotHealthy, WhyNotReady } from "./WhyNotHealthy";

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
  readonly name: string;
  readonly pid: number;
  readonly start = Date.now();

  readonly startupTaskId: number;
  readonly #logger: () => Logger;
  readonly #terminator: ProcessTerminator;
  readonly #healthMonitor: ProcessHealthMonitor;
  readonly #streamHandler: StreamHandler;
  #lastJobFinishedAt = Date.now();

  // Only set to true when `proc.pid` is no longer in the process table.
  #starting = true;

  // Deferred that resolves when the process exits (via OS events)
  #processExitDeferred = new Deferred<void>();

  // override for .whyNotHealthy()
  #whyNotHealthy?: WhyNotHealthy;

  failedTaskCount = 0;

  /**
   * Number of user tasks (not including the startup/version task) that have
   * been started on this process. Used for maxTasksPerProcess recycling.
   */
  #taskCount = 0;

  /**
   * Should be undefined if this instance is not currently processing a task.
   */
  #currentTask: Task<unknown> | undefined;

  /**
   * Getter for current task (required by StreamContext interface)
   */
  get currentTask(): Task<unknown> | undefined {
    return this.#currentTask;
  }

  /**
   * Create a StreamContext adapter for this BatchProcess
   */
  #createStreamContext = (): StreamContext => {
    return {
      name: this.name,
      isEnding: () => this.ending,
      getCurrentTask: () => this.#currentTask,
      onError: (reason: string, error: Error) =>
        this.#onError(reason as WhyNotHealthy, error),
      end: (gracefully: boolean, reason: string) =>
        void this.end(gracefully, reason as WhyNotHealthy),
    };
  };
  #currentTaskTimeout: NodeJS.Timeout | undefined;

  #endPromise: undefined | Deferred<void>;

  /**
   * @param onIdle to be called when internal state changes (like the current
   * task is resolved, or the process exits)
   */
  constructor(
    readonly proc: child_process.ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    private readonly onIdle: () => void,
    healthMonitor?: ProcessHealthMonitor,
  ) {
    this.name = "BatchProcess(" + proc.pid + ")";
    this.#logger = opts.logger;
    this.#terminator = new ProcessTerminator(opts);
    this.#healthMonitor =
      healthMonitor ?? new ProcessHealthMonitor(opts, opts.observer);
    this.#streamHandler = new StreamHandler(
      { logger: this.#logger },
      opts.observer,
    );
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref();

    if (proc.pid == null) {
      throw new Error("BatchProcess.constructor: child process pid is null");
    }

    this.pid = proc.pid;

    this.proc.on("error", (err) => this.#onError("proc.error", err));
    this.proc.on("close", () => {
      this.#processExitDeferred.resolve();
      void this.end(false, "proc.close");
    });
    this.proc.on("exit", () => {
      this.#processExitDeferred.resolve();
      void this.end(false, "proc.exit");
    });
    this.proc.on("disconnect", () => {
      this.#processExitDeferred.resolve();
      void this.end(false, "proc.disconnect");
    });

    // Set up stream handlers using StreamHandler
    this.#streamHandler.setupStreamListeners(
      this.proc,
      this.#createStreamContext(),
    );

    const startupTask = new Task(opts.versionCommand, SimpleParser);
    this.startupTaskId = startupTask.taskId;

    if (!this.execTask(startupTask)) {
      this.opts.observer.emit(
        "internalError",
        new Error(this.name + " startup task was not submitted"),
      );
    }

    // Initialize health monitoring for this process
    this.#healthMonitor.initializeProcess(this.pid);

    // this needs to be at the end of the constructor, to ensure everything is
    // set up on `this`
    this.opts.observer.emit("childStart", this);
  }

  get taskCount(): number {
    return this.#taskCount;
  }

  get starting(): boolean {
    return this.#starting;
  }

  /**
   * @return true if `this.end()` has been requested (which may be due to the
   * child process exiting)
   */
  get ending(): boolean {
    return this.#endPromise != null;
  }

  /**
   * @return true if `this.end()` has completed running, which includes child
   * process cleanup. Note that this may return `true` and the process table may
   * still include the child pid. Call {@link BatchProcess#running()} for an authoritative
   * (but expensive!) answer.
   */
  get ended(): boolean {
    return true === this.#endPromise?.settled;
  }

  /**
   * @return true if the child process has exited (based on OS events).
   * This is now authoritative and inexpensive since it's driven by OS events
   * rather than polling.
   */
  get exited(): boolean {
    return this.#processExitDeferred.settled;
  }

  /**
   * @return a string describing why this process should be recycled, or null if
   * the process passes all health checks. Note that this doesn't include if
   * we're already busy: see {@link BatchProcess.whyNotReady} if you need to
   * know if a process can handle a new task.
   */
  get whyNotHealthy(): WhyNotHealthy | null {
    return this.#healthMonitor.assessHealth(this, this.#whyNotHealthy);
  }

  /**
   * @return true if the process doesn't need to be recycled.
   */
  get healthy(): boolean {
    return this.whyNotHealthy == null;
  }

  /**
   * @return true iff no current task. Does not take into consideration if the
   * process has ended or should be recycled: see {@link BatchProcess.ready}.
   */
  get idle(): boolean {
    return this.#currentTask == null;
  }

  /**
   * @return a string describing why this process cannot currently handle a new
   * task, or `undefined` if this process is idle and healthy.
   */
  get whyNotReady(): WhyNotReady | null {
    return !this.idle ? "busy" : this.whyNotHealthy;
  }

  /**
   * @return true iff this process is  both healthy and idle, and ready for a
   * new task.
   */
  get ready(): boolean {
    return this.whyNotReady == null;
  }

  get idleMs(): number {
    return this.idle ? Date.now() - this.#lastJobFinishedAt : -1;
  }

  /**
   * @return true if the child process is running.
   * Now event-driven first with polling fallback.
   */
  running(): boolean {
    // If we've been notified via OS events that process exited, trust that immediately
    if (this.exited) return false;

    // Only poll as fallback if we haven't been notified yet
    // This handles edge cases where events might not fire reliably
    const alive = pidExists(this.pid);
    if (!alive) {
      this.#processExitDeferred.resolve();
      // once a PID leaves the process table, it's gone for good.
      void this.end(false, "proc.exit");
    }
    return alive;
  }

  notRunning(): boolean {
    return !this.running();
  }

  maybeRunHealthCheck(): Task<unknown> | undefined {
    return this.#healthMonitor.maybeRunHealthCheck(this);
  }

  // This must not be async, or new instances aren't started as busy (until the
  // startup task is complete)
  execTask<T>(task: Task<T>): boolean {
    return this.ready ? this.#execTask(task) : false;
  }

  #execTask<T>(task: Task<T>): boolean {
    if (this.ending) return false;

    this.#currentTask = task as Task<unknown>;
    const cmd = ensureSuffix(task.command, "\n");
    const isStartupTask = task.taskId === this.startupTaskId;

    // Only count user tasks, not the startup task (for maxTasksPerProcess)
    if (!isStartupTask) {
      this.#taskCount++;
    }
    const taskTimeoutMs = isStartupTask
      ? this.opts.spawnTimeoutMillis
      : this.opts.taskTimeoutMillis;
    if (taskTimeoutMs > 0) {
      // add the stream flush millis to the taskTimeoutMs, because that time
      // should not be counted against the task.
      this.#currentTaskTimeout = timers.setTimeout(
        () => this.#onTimeout(task as Task<unknown>, taskTimeoutMs),
        taskTimeoutMs + this.opts.streamFlushMillis,
      );
    }
    // CAREFUL! If you add a .catch or .finally, the pipeline can emit unhandled
    // rejections:
    void task.promise.then(
      () => {
        this.#clearCurrentTask(task as Task<unknown>);
        // this.#logger().trace("task completed", { task })

        if (isStartupTask) {
          // no need to emit taskResolved for startup tasks.
          this.#starting = false;
        } else {
          this.opts.observer.emit("taskResolved", task as Task<unknown>, this);
        }
        // Call _after_ we've cleared the current task:
        this.onIdle();
      },
      (error) => {
        this.#clearCurrentTask(task as Task<unknown>);
        // this.#logger().trace("task failed", { task, err: error })

        if (isStartupTask) {
          this.opts.observer.emit(
            "startError",
            error instanceof Error ? error : new Error(String(error)),
          );
          void this.end(false, "startError");
        } else {
          this.opts.observer.emit(
            "taskError",
            error instanceof Error ? error : new Error(String(error)),
            task as Task<unknown>,
            this,
          );
        }

        // Call _after_ we've cleared the current task:
        this.onIdle();
      },
    );

    try {
      task.onStart(this.opts);
      const stdin = this.proc?.stdin;
      if (stdin == null || stdin.destroyed) {
        task.reject(new Error("proc.stdin unexpectedly closed"));
        return false;
      } else {
        stdin.write(cmd, (err) => {
          if (err != null) {
            task.reject(err);
            void this.end(false, "stdin.error");
          }
        });
        return true;
      }
    } catch {
      // child process went away. We should too.
      void this.end(false, "stdin.error");
      return false;
    }
  }

  /**
   * End this child process.
   *
   * @param gracefully Wait for any current task to be resolved or rejected
   * before shutting down the child process.
   * @param reason who called end() (used for logging)
   * @return Promise that will be resolved when the process has completed.
   * Subsequent calls to end() will ignore the parameters and return the first
   * endPromise.
   */
  // NOT ASYNC! needs to change state immediately.
  end(gracefully = true, reason: WhyNotHealthy): Promise<void> {
    return (this.#endPromise ??= new Deferred<void>().observe(
      this.#end(gracefully, (this.#whyNotHealthy ??= reason)),
    )).promise;
  }

  // NOTE: Must only be invoked by this.end(), and only expected to be invoked
  // once per instance.
  async #end(gracefully: boolean, reason: WhyNotHealthy) {
    const lastTask = this.#currentTask;
    this.#clearCurrentTask();

    await this.#terminator.terminate(
      this.proc,
      this.name,
      lastTask,
      this.startupTaskId,
      gracefully,
      this.exited,
      () => this.running(),
    );

    // Clean up health monitoring for this process
    this.#healthMonitor.cleanupProcess(this.pid);

    this.opts.observer.emit("childEnd", this, reason);
  }

  #onTimeout(task: Task<unknown>, timeoutMs: number): void {
    if (task.pending) {
      this.opts.observer.emit("taskTimeout", timeoutMs, task, this);
      this.#onError("timeout", new Error("waited " + timeoutMs + "ms"), task);
    }
  }

  #onError(reason: WhyNotHealthy, error: Error, task?: Task<unknown>) {
    if (task == null) {
      task = this.#currentTask;
    }
    const cleanedError = new Error(reason + ": " + cleanError(error.message));
    if (error.stack != null) {
      // Error stacks, if set, will not be redefined from a rethrow:
      cleanedError.stack = cleanError(error.stack);
    }
    this.#logger().warn(this.name + ".onError()", {
      reason,
      task: map(task, (t) => t.command),
      error: cleanedError,
    });

    if (this.ending) {
      // .#end is already disconnecting the error listeners, but in any event,
      // we don't really care about errors after we've been told to shut down.
      return;
    }

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.#clearCurrentTask();
    void this.end(false, reason);

    // Only emit startError for actual startup task (version command) failures,
    // not for regular task failures.
    // See: https://github.com/photostructure/exiftool-vendored.js/issues/312
    if (task != null && task.taskId === this.startupTaskId) {
      this.#logger().warn(
        this.name + ".onError(): startup task failed: " + String(cleanedError),
      );
      this.opts.observer.emit("startError", cleanedError);
    }

    if (task != null) {
      if (task.pending) {
        task.reject(cleanedError);
      } else {
        this.opts.observer.emit(
          "internalError",
          new Error(
            `${this.name}.onError(${cleanedError}) cannot reject already-fulfilled task.`,
          ),
        );
      }
    }
  }

  #clearCurrentTask(task?: Task<unknown>) {
    const taskFailed = task?.state === "rejected";
    if (taskFailed) {
      this.#healthMonitor.recordJobFailure(this.pid);
    } else if (task != null) {
      this.#healthMonitor.recordJobSuccess(this.pid);
    }

    if (task != null && task.taskId !== this.#currentTask?.taskId) return;
    map(this.#currentTaskTimeout, (ea) => clearTimeout(ea));
    this.#currentTaskTimeout = undefined;
    this.#currentTask = undefined;
    this.#lastJobFinishedAt = Date.now();
  }
}
