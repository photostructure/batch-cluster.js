import * as _cp from "child_process"
import { delay, until } from "./Async"
import { Deferred } from "./Deferred"
import { cleanError, tryEach } from "./Error"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { Logger } from "./Logger"
import { map } from "./Object"
import { SimpleParser } from "./Parser"
import { kill, pidExists } from "./Pids"
import { mapNotDestroyed } from "./Stream"
import { blank, ensureSuffix, toS } from "./String"
import { Task } from "./Task"

export type WhyNotHealthy =
  | "broken"
  | "closed"
  | "ending"
  | "ended"
  | "idle"
  | "old"
  | "proc.close"
  | "proc.disconnect"
  | "proc.error"
  | "proc.exit"
  | "stderr.error"
  | "stderr"
  | "stdin.error"
  | "stdout.error"
  | "timeout"
  | "tooMany" // < only sent by BatchCluster when maxProcs is reduced
  | "unhealthy"
  | "worn"

export type WhyNotReady = WhyNotHealthy | "busy"

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
  readonly name: string
  readonly pid: number
  readonly start = Date.now()
  #lastHealthCheck = Date.now()
  #healthCheckFailures = 0

  readonly #startupTask: Task
  readonly #logger: () => Logger
  #lastJobFinshedAt = Date.now()

  // Only set to true when `proc.pid` is no longer in the process table.
  #ended = false
  #ending = false

  #whyNotHealthy?: WhyNotHealthy

  failedTaskCount = 0

  #taskCount = -1 // don't count the startupTask

  /**
   * Supports non-polling notification of process exit
   */
  readonly #resolvedOnExit = new Deferred<void>()
  /**
   * Should be undefined if this instance is not currently processing a task.
   */
  #currentTask: Task | undefined
  #currentTaskTimeout: NodeJS.Timer | undefined

  constructor(
    readonly proc: _cp.ChildProcess,
    readonly opts: InternalBatchProcessOptions
  ) {
    this.name = "BatchProcess(" + proc.pid + ")"
    this.#logger = opts.logger
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref()

    if (proc.pid == null) {
      throw new Error("BatchProcess.constructor: child process pid is null")
    }

    this.pid = proc.pid

    this.proc.on("error", (err) => this.#onError("proc.error", err))
    this.proc.on("close", () => this.#onExit("proc.close"))
    this.proc.on("exit", () => this.#onExit("proc.exit"))
    this.proc.on("disconnect", () => this.#onExit("proc.disconnect"))

    const stdin = this.proc.stdin
    if (stdin == null) throw new Error("Given proc had no stdin")
    stdin.on("error", (err) => this.#onError("stdin.error", err))

    const stdout = this.proc.stdout
    if (stdout == null) throw new Error("Given proc had no stdout")
    stdout.on("error", (err) => this.#onError("stdout.error", err))
    stdout.on("data", (d) => this.#onStdout(d))

    map(this.proc.stderr, (stderr) => {
      stderr.on("error", (err) => this.#onError("stderr.error", err))
      stderr.on("data", (err) => this.#onStderr(err))
    })

    this.#startupTask = new Task(opts.versionCommand, SimpleParser)

    if (!this.execTask(this.#startupTask)) {
      this.opts.observer.emit(
        "internalError",
        new Error(this.name + " startup task was not submitted")
      )
    }
    // this needs to be at the end of the constructor, to ensure everything is
    // set up on `this`
    this.opts.observer.emit("childStart", this)
  }

  get startupPromise(): Promise<void> {
    return this.#startupTask.promise
  }

  get currentTask(): Task | undefined {
    return this.#currentTask
  }
  get taskCount(): number {
    return this.#taskCount
  }

  /**
   * @return true if `this.end()` has been requested or the child process has
   * exited.
   */
  get ending(): boolean {
    return this.#ending
  }
  /**
   * @return true if the child process has exited and is no longer in the
   * process table.
   */
  get exited(): boolean {
    return this.#resolvedOnExit.settled
  }
  get exitPromise(): Promise<void> {
    return this.#resolvedOnExit.promise
  }

  /**
   * @return a string describing why this process should be recycled, or null if
   * the process passes all health checks. Note that this doesn't include if
   * we're already busy: see {@link BatchProcess.whyNotReady} if you need to
   * know if a process can handle a new task.
   */
  get whyNotHealthy(): WhyNotHealthy | null {
    if (this.#whyNotHealthy != null) return this.#whyNotHealthy
    if (this.exited) {
      return "ended"
    } else if (this.#ending) {
      return "ending"
    } else if (this.#healthCheckFailures > 0) {
      return "unhealthy"
    } else if (this.proc.stdin == null || this.proc.stdin.destroyed) {
      return "closed"
    } else if (
      this.opts.maxTasksPerProcess > 0 &&
      this.taskCount >= this.opts.maxTasksPerProcess
    ) {
      return "worn"
    } else if (
      this.opts.maxIdleMsPerProcess > 0 &&
      this.idleMs > this.opts.maxIdleMsPerProcess
    ) {
      return "idle"
    } else if (
      this.opts.maxFailedTasksPerProcess > 0 &&
      this.failedTaskCount >= this.opts.maxFailedTasksPerProcess
    ) {
      return "broken"
    } else if (
      this.opts.maxProcAgeMillis > 0 &&
      this.start + this.opts.maxProcAgeMillis < Date.now()
    ) {
      return "old"
    } else if (
      (this.opts.taskTimeoutMillis > 0 && this.#currentTask?.runtimeMs) ??
      0 > this.opts.taskTimeoutMillis
    ) {
      return "timeout"
    } else {
      return null
    }
  }

  /**
   * @return true if the process doesn't need to be recycled.
   */
  get healthy(): boolean {
    return this.whyNotHealthy == null
  }

  /**
   * @return true iff no current task. Does not take into consideration if the
   * process has ended or should be recycled: see {@link BatchProcess.ready}.
   */
  get idle(): boolean {
    return this.#currentTask == null
  }

  /**
   * @return a string describing why this process cannot currently handle a new
   * task, or `undefined` if this process is idle and healthy.
   */
  get whyNotReady(): WhyNotReady | null {
    return !this.idle ? "busy" : this.whyNotHealthy
  }

  /**
   * @return true iff this process is  both healthy and idle, and ready for a
   * new task.
   */
  get ready(): boolean {
    return this.whyNotReady == null
  }

  get idleMs(): number {
    return this.idle ? Date.now() - this.#lastJobFinshedAt : -1
  }

  /**
   * @return true if the child process is in the process table
   */
  async running(): Promise<boolean> {
    if (this.#ended) {
      // this.dead is only set if the process table has said we're dead.
      return false
    } else {
      const alive = await pidExists(this.pid)
      if (!alive) {
        // once a PID leaves the process table, it's gone for good:
        this.#ended = true
        this.#ending = true
        this.#resolvedOnExit.resolve()
      }
      return alive
    }
  }

  notRunning(): Promise<boolean> {
    return this.running().then((ea) => !ea)
  }

  /**
   * @return {boolean} true if `this.end()` has been requested or the child
   * process has exited.
   */
  async ended(): Promise<boolean> {
    return this.#ended || (await this.notRunning())
  }

  async notEnded(): Promise<boolean> {
    return this.ended().then((ea) => !ea)
  }

  maybeRunHealthcheck(): Task | undefined {
    if (
      this.ready &&
      this.opts.healthCheckCommand != null &&
      this.opts.healthCheckIntervalMillis > 0 &&
      Date.now() - this.#lastHealthCheck > this.opts.healthCheckIntervalMillis
    ) {
      this.#lastHealthCheck = Date.now()
      const t = new Task(this.opts.healthCheckCommand, SimpleParser)
      t.promise
        .catch((err) => {
          this.opts.observer.emit("healthCheckError", err, this)
          this.#healthCheckFailures++
          // BatchCluster will see we're unhealthy and reap us later
        })
        .finally(() => {
          this.#lastHealthCheck = Date.now()
        })
      this.#execTask(t)
      return t
    }
    return
  }

  // This must not be async, or new instances aren't started as busy (until the
  // startup task is complete)
  execTask(task: Task): boolean {
    return this.ready ? this.#execTask(task) : false
  }

  #execTask(task: Task): boolean {
    if (this.#ending) return false

    this.#taskCount++
    this.#currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const isStartupTask = task.taskId === this.#startupTask.taskId
    const timeoutMs = isStartupTask
      ? this.opts.spawnTimeoutMillis
      : this.opts.taskTimeoutMillis
    if (timeoutMs > 0) {
      this.#currentTaskTimeout = setTimeout(
        () => this.#onTimeout(task, timeoutMs),
        timeoutMs
      )
    }
    // CAREFUL! If you add a .catch or .finally, the pipeline can emit unhandled
    // rejections:
    void task.promise.then(
      () => {
        this.#clearCurrentTask(task)

        if (!isStartupTask) {
          this.opts.observer.emit("taskResolved", task, this)
        }
      },
      (err) => {
        this.#clearCurrentTask(task)

        if (isStartupTask) {
          this.opts.observer.emit("startError", err)
        } else {
          this.opts.observer.emit("taskError", err, task, this)
        }
      }
    )

    try {
      task.onStart(this.opts)
      const stdin = this.proc?.stdin
      if (stdin == null || stdin.destroyed) {
        task.reject(new Error("proc.stdin unexpectedly closed"))
        return false
      } else {
        stdin.write(cmd, (err) => {
          if (err != null) {
            task.reject(err)
          }
        })
        return true
      }
    } catch (err) {
      // child process went away. We should too.
      this.end(false, "stdin.error")
      return false
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
  end(gracefully = true, reason: WhyNotHealthy): Promise<void> | undefined {
    this.#whyNotHealthy ??= reason

    if (this.#ending) {
      return undefined
    } else {
      this.#ending = true
      this.opts.observer.emit("childEnd", this, reason)
      return this.#end(gracefully)
    }
  }

  // NOTE: Must only be invoked by this.end(), and only expected to be invoked
  // once per instance.
  async #end(gracefully = true): Promise<void> {
    const lastTask = this.#currentTask
    this.#clearCurrentTask()

    // NOTE: We wait on all tasks (even startup tasks) so we can assert that
    // BatchCluster is idle (and this proc is idle) when the end promise is
    // resolved.

    // NOTE: holy crap there are a lot of notes here.

    if (lastTask != null) {
      try {
        // Let's wait for streams to flush, as that may actually allow the task
        // to complete successfully. Let's not wait forever, though.
        await Promise.race([lastTask.promise, delay(gracefully ? 2000 : 250)])
      } catch {
        //
      }
      if (lastTask.pending) {
        lastTask.reject(
          new Error(
            `end() called before task completed (${JSON.stringify({
              gracefully,
              lastTask,
            })})`
          )
        )
      }
    }

    const cmd = map(this.opts.exitCommand, (ea) => ensureSuffix(ea, "\n"))

    // proc cleanup:
    tryEach([
      () => mapNotDestroyed(this.proc.stdin, (ea) => ea.end(cmd)),
      () => mapNotDestroyed(this.proc.stdout, (ea) => ea.destroy()),
      () => mapNotDestroyed(this.proc.stderr, (ea) => ea.destroy()),
      () => this.proc.disconnect(),
    ])

    if (
      this.opts.cleanupChildProcs &&
      gracefully &&
      this.opts.endGracefulWaitTimeMillis > 0 &&
      (await this.running())
    ) {
      // Wait for the end command to take effect:
      await this.#awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
      // If it's still running, send the pid a signal:
      if ((await this.running()) && this.proc.pid != null)
        await kill(this.proc.pid)
      // Wait for the signal handler to work:
      await this.#awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
    }

    if (
      this.opts.cleanupChildProcs &&
      this.proc.pid != null &&
      (await this.running())
    ) {
      this.#logger().warn(
        this.name + ".end(): force-killing still-running child."
      )
      await kill(this.proc.pid, true)
    }
    return this.#resolvedOnExit
  }

  #awaitNotRunning(timeout: number) {
    return until(() => this.notRunning(), timeout)
  }

  #onTimeout(task: Task, timeoutMs: number): void {
    if (task.pending) {
      this.opts.observer.emit("taskTimeout", timeoutMs, task, this)
      this.#onError("timeout", new Error("waited " + timeoutMs + "ms"), task)
    }
  }

  #onError(reason: WhyNotHealthy, error: Error, task?: Task) {
    if (this.#ending) {
      // We're ending already, so don't propagate the error.
      // This is expected due to race conditions stdin EPIPE and process shutdown.
      this.#logger().debug(
        this.name + ".onError() post-end (expected and not propagated)",
        {
          reason,
          error,
          task,
        }
      )
      return
    }
    if (task == null) {
      task = this.#currentTask
    }
    const cleanedError = new Error(reason + ": " + cleanError(error.message))
    this.#logger().warn(this.name + ".onError()", {
      reason,
      task: map(task, (t) => t.command),
      error: cleanedError,
    })

    if (error.stack != null) {
      // Error stacks, if set, will not be redefined from a rethrow:
      cleanedError.stack = cleanError(error.stack)
    }

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.#clearCurrentTask()
    void this.end(false, reason)

    if (task != null && this.taskCount === 1) {
      this.#logger().warn(
        this.name + ".onError(): startup task failed: " + cleanedError
      )
      this.opts.observer.emit("startError", cleanedError)
    }

    if (task != null) {
      if (task.pending) {
        task.reject(cleanedError)
      } else {
        this.opts.observer.emit(
          "internalError",
          new Error(
            `${this.name}.onError(${cleanedError}) cannot reject already-fulfilled task.`
          )
        )
      }
    }
  }

  #onExit(reason: WhyNotHealthy) {
    this.#resolvedOnExit.resolve()
    // no need to be graceful, it's just for bookkeeping:
    return this.end(false, reason)
  }

  #onStderr(data: string | Buffer) {
    if (blank(data)) return
    this.#logger().warn(this.name + ".onStderr():" + data)
    const task = this.#currentTask
    if (task != null && task.pending) {
      task.onStderr(data)
    } else if (!this.#ending) {
      // If we're ending and there isn't a task, don't worry about it.
      this.end(false, "stderr")
      this.opts.observer.emit(
        "internalError",
        new Error(
          "onStderr(" +
            String(data).trim() +
            ") no pending currentTask (task: " +
            task +
            ")"
        )
      )
    }
  }

  #onStdout(data: string | Buffer) {
    if (data == null) return
    const task = this.#currentTask
    if (task != null && task.pending) {
      this.opts.observer.emit("taskData", data, task, this)
      task.onStdout(data)
    } else if (this.#ending) {
      // don't care if we're already being shut down.
    } else if (!blank(data)) {
      this.#logger().warn(
        this.name + ".onStdout(): no current task to handle " + toS(data)
      )
      this.end(false, "stdout.error")
      // If we're ending and there isn't a task, don't worry about it.
      // Otherwise:
      this.opts.observer.emit(
        "internalError",
        new Error(
          "onStdout(" + data + ") no pending currentTask (task: " + task + ")"
        )
      )
    }
  }

  #clearCurrentTask(task?: Task) {
    setImmediate(() => this.opts.observer.emit("idle"))
    if (task != null && task.taskId !== this.#currentTask?.taskId) return
    map(this.#currentTaskTimeout, (ea) => clearTimeout(ea))
    this.#currentTaskTimeout = undefined
    this.#currentTask = undefined
    this.#lastJobFinshedAt = Date.now()
  }
}
