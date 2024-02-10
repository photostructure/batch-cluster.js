import child_process from "node:child_process"
import timers from "node:timers"
import { until } from "./Async"
import { Deferred } from "./Deferred"
import { cleanError } from "./Error"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { Logger } from "./Logger"
import { map } from "./Object"
import { SimpleParser } from "./Parser"
import { kill, pidExists } from "./Pids"
import { destroy } from "./Stream"
import { blank, ensureSuffix } from "./String"
import { Task } from "./Task"
import { thenOrTimeout } from "./Timeout"

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
  | "startError"
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

  readonly startupTaskId: number
  readonly #logger: () => Logger
  #lastJobFinshedAt = Date.now()
  #lastJobFailed = false

  // Only set to true when `proc.pid` is no longer in the process table.
  #starting = true

  #exited = false

  // override for .whyNotHealthy()
  #whyNotHealthy?: WhyNotHealthy

  failedTaskCount = 0

  #taskCount = -1 // don't count the startupTask

  /**
   * Should be undefined if this instance is not currently processing a task.
   */
  #currentTask: Task | undefined
  #currentTaskTimeout: NodeJS.Timeout | undefined

  #endPromise: undefined | Deferred<void>

  /**
   * @param onIdle to be called when internal state changes (like the current
   * task is resolved, or the process exits)
   */
  constructor(
    readonly proc: child_process.ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    private readonly onIdle: () => void,
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
    this.proc.on("close", () => this.end(false, "proc.close"))
    this.proc.on("exit", () => this.end(false, "proc.exit"))
    this.proc.on("disconnect", () => this.end(false, "proc.disconnect"))

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

    const startupTask = new Task(opts.versionCommand, SimpleParser)
    this.startupTaskId = startupTask.taskId

    if (!this.execTask(startupTask)) {
      this.opts.observer.emit(
        "internalError",
        new Error(this.name + " startup task was not submitted"),
      )
    }
    // this needs to be at the end of the constructor, to ensure everything is
    // set up on `this`
    this.opts.observer.emit("childStart", this)
  }

  get currentTask(): Task | undefined {
    return this.#currentTask
  }

  get taskCount(): number {
    return this.#taskCount
  }

  get starting(): boolean {
    return this.#starting
  }

  /**
   * @return true if `this.end()` has been requested (which may be due to the
   * child process exiting)
   */
  get ending(): boolean {
    return this.#endPromise != null
  }

  /**
   * @return true if `this.end()` has completed running, which includes child
   * process cleanup. Note that this may return `true` and the process table may
   * still include the child pid. Call {@link BatchProcess#running()} for an authoritative
   * (but expensive!) answer.
   */
  get ended(): boolean {
    return true === this.#endPromise?.settled
  }

  /**
   * @return true if the child process has exited and is no longer in the
   * process table. Note that this may be erroneously false if the process table
   * hasn't been checked. Call {@link BatchProcess#running()} for an authoritative (but
   * expensive!) answer.
   */
  get exited(): boolean {
    return this.#exited
  }

  /**
   * @return a string describing why this process should be recycled, or null if
   * the process passes all health checks. Note that this doesn't include if
   * we're already busy: see {@link BatchProcess.whyNotReady} if you need to
   * know if a process can handle a new task.
   */
  get whyNotHealthy(): WhyNotHealthy | null {
    if (this.#whyNotHealthy != null) return this.#whyNotHealthy
    if (this.ended) {
      return "ended"
    } else if (this.ending) {
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
  running(): boolean {
    if (this.#exited) return false

    const alive = pidExists(this.pid)
    if (!alive) {
      this.#exited = true
      // once a PID leaves the process table, it's gone for good.
      this.end(false, "proc.exit")
    }
    return alive
  }

  notRunning(): boolean {
    return !this.running()
  }

  maybeRunHealthcheck(): Task | undefined {
    const hcc = this.opts.healthCheckCommand
    // if there's no health check command, no-op.
    if (hcc == null || blank(hcc)) return

    // if the prior health check failed, .ready will be false
    if (!this.ready) return

    if (
      this.#lastJobFailed ||
      (this.opts.healthCheckIntervalMillis > 0 &&
        Date.now() - this.#lastHealthCheck >
          this.opts.healthCheckIntervalMillis)
    ) {
      this.#lastHealthCheck = Date.now()
      const t = new Task(hcc, SimpleParser)
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
    if (this.ending) return false

    this.#taskCount++
    this.#currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const isStartupTask = task.taskId === this.startupTaskId
    const taskTimeoutMs = isStartupTask
      ? this.opts.spawnTimeoutMillis
      : this.opts.taskTimeoutMillis
    if (taskTimeoutMs > 0) {
      // add the stream flush millis to the taskTimeoutMs, because that time
      // should not be counted against the task.
      this.#currentTaskTimeout = timers.setTimeout(
        () => this.#onTimeout(task, taskTimeoutMs),
        taskTimeoutMs + this.opts.streamFlushMillis,
      )
    }
    // CAREFUL! If you add a .catch or .finally, the pipeline can emit unhandled
    // rejections:
    void task.promise.then(
      () => {
        this.#clearCurrentTask(task)
        // this.#logger().trace("task completed", { task })

        if (isStartupTask) {
          // no need to emit taskResolved for startup tasks.
          this.#starting = false
        } else {
          this.opts.observer.emit("taskResolved", task, this)
        }
        // Call _after_ we've cleared the current task:
        this.onIdle()
      },
      (error) => {
        this.#clearCurrentTask(task)
        // this.#logger().trace("task failed", { task, err: error })

        if (isStartupTask) {
          this.opts.observer.emit("startError", error)
          this.end(false, "startError")
        } else {
          this.opts.observer.emit("taskError", error, task, this)
        }

        // Call _after_ we've cleared the current task:
        this.onIdle()
      },
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
  end(gracefully = true, reason: WhyNotHealthy): Promise<void> {
    return (this.#endPromise ??= new Deferred<void>().observe(
      this.#end(gracefully, (this.#whyNotHealthy ??= reason)),
    )).promise
  }

  // NOTE: Must only be invoked by this.end(), and only expected to be invoked
  // once per instance.
  async #end(gracefully: boolean, reason: WhyNotHealthy) {
    const lastTask = this.#currentTask
    this.#clearCurrentTask()

    // NOTE: We wait on all tasks (even startup tasks) so we can assert that
    // BatchCluster is idle (and this proc is idle) when the end promise is
    // resolved.

    // NOTE: holy crap there are a lot of notes here.

    // We don't need to wait for the startup task to complete, and we certainly
    // don't need to fuss about ending when we're just getting started.
    if (lastTask != null && lastTask.taskId !== this.startupTaskId) {
      try {
        // Let's wait for the process to complete and the streams to flush, as
        // that may actually allow the task to complete successfully. Let's not
        // wait forever, though.
        await thenOrTimeout(lastTask.promise, gracefully ? 2000 : 250)
      } catch {
        //
      }
      if (lastTask.pending) {
        lastTask.reject(
          new Error(
            `end() called before task completed (${JSON.stringify({
              gracefully,
              lastTask,
            })})`,
          ),
        )
      }
    }

    // Ignore EPIPE on .end(): if the process immediately ends after the exit
    // command, we'll get an EPIPE, so, shush error events *before* we tell the
    // child process to exit. See https://github.com/nodejs/node/issues/26828
    for (const ea of [
      this.proc,
      this.proc.stdin,
      this.proc.stdout,
      this.proc.stderr,
    ]) {
      ea?.removeAllListeners("error")
    }

    if (true === this.proc.stdin?.writable) {
      const exitCmd =
        this.opts.exitCommand == null
          ? null
          : ensureSuffix(this.opts.exitCommand, "\n")
      try {
        this.proc.stdin?.end(exitCmd)
      } catch {
        // don't care
      }
    }

    // None of this *should* be necessary, but we're trying to be as hygienic as
    // we can to avoid process zombification.
    destroy(this.proc.stdin)
    destroy(this.proc.stdout)
    destroy(this.proc.stderr)

    if (
      this.opts.cleanupChildProcs &&
      gracefully &&
      this.opts.endGracefulWaitTimeMillis > 0 &&
      !this.#exited
    ) {
      // Wait for the exit command to take effect:
      await this.#awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
      // If it's still running, send the pid a signal:
      if (this.running() && this.proc.pid != null) this.proc.kill()
      // Wait for the signal handler to work:
      await this.#awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
    }

    if (
      this.opts.cleanupChildProcs &&
      this.proc.pid != null &&
      this.running()
    ) {
      this.#logger().warn(
        this.name + ".end(): force-killing still-running child.",
      )
      kill(this.proc.pid, true)
    }
    // disconnect may not be a function on proc!
    this.proc.disconnect?.()
    this.opts.observer.emit("childEnd", this, reason)
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
    if (task == null) {
      task = this.#currentTask
    }
    const cleanedError = new Error(reason + ": " + cleanError(error.message))
    if (error.stack != null) {
      // Error stacks, if set, will not be redefined from a rethrow:
      cleanedError.stack = cleanError(error.stack)
    }
    this.#logger().warn(this.name + ".onError()", {
      reason,
      task: map(task, (t) => t.command),
      error: cleanedError,
    })

    if (this.ending) {
      // .#end is already disconnecting the error listeners, but in any event,
      // we don't really care about errors after we've been told to shut down.
      return
    }

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.#clearCurrentTask()
    void this.end(false, reason)

    if (task != null && this.taskCount === 1) {
      this.#logger().warn(
        this.name + ".onError(): startup task failed: " + cleanedError,
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
            `${this.name}.onError(${cleanedError}) cannot reject already-fulfilled task.`,
          ),
        )
      }
    }
  }

  #onStderr(data: string | Buffer) {
    if (blank(data)) return
    this.#logger().warn(this.name + ".onStderr(): " + data)
    const task = this.#currentTask
    if (task != null && task.pending) {
      task.onStderr(data)
    } else if (!this.ending) {
      // If we're ending and there isn't a task, don't worry about it.
      this.opts.observer.emit("noTaskData", null, data, this)
      void this.end(false, "stderr")
    }
  }

  #onStdout(data: string | Buffer) {
    if (data == null) return
    const task = this.#currentTask
    if (task != null && task.pending) {
      this.opts.observer.emit("taskData", data, task, this)
      task.onStdout(data)
    } else if (this.ending) {
      // don't care if we're already being shut down.
    } else if (!blank(data)) {
      this.opts.observer.emit("noTaskData", data, null, this)
      void this.end(false, "stdout.error")
    }
  }

  #clearCurrentTask(task?: Task) {
    this.#lastJobFailed = task?.state === "rejected"
    if (task != null && task.taskId !== this.#currentTask?.taskId) return
    map(this.#currentTaskTimeout, (ea) => clearTimeout(ea))
    this.#currentTaskTimeout = undefined
    this.#currentTask = undefined
    this.#lastJobFinshedAt = Date.now()
  }
}
