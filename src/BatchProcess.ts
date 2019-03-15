import * as _cp from "child_process"

import { debounce, until } from "./Async"
import { logger } from "./BatchCluster"
import { BatchProcessObserver } from "./BatchProcessObserver"
import { Deferred } from "./Deferred"
import { cleanError, tryEach } from "./Error"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { map } from "./Object"
import { SimpleParser } from "./Parser"
import { kill, pidExists } from "./Pids"
import { ensureSuffix, toS } from "./String"
import { Task } from "./Task"

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
  readonly name: string
  readonly start = Date.now()
  private dead = false
  private _taskCount = -1 // don't count the startupTask
  /**
   * not null if `this.end()` has been called, or this process is no longer in the
   * process table.
   */
  private _endPromise: Promise<void> | undefined

  /**
   * Supports non-polling notification of process shutdown
   */
  private readonly _exited = new Deferred<void>()
  /**
   * Should be undefined if this instance is not currently processing a task.
   */
  private currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined
  private readonly streamDebouncer: (f: () => any) => void
  private readonly startupTask: Task<any>

  constructor(
    readonly proc: _cp.ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    this.name = "BatchProcess(" + proc.pid + ")"
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref()

    this.proc.on("error", err => this.onError("proc.error", err))
    this.proc.on("close", () => this.onExit("close"))
    this.proc.on("exit", () => this.onExit("exit"))
    this.proc.on("disconnect", () => this.onExit("disconnect"))

    const stdin = this.proc.stdin
    if (stdin == null) throw new Error("Given proc had no stdin")
    stdin.on("error", err => this.onError("stdin.error", err))

    const stdout = this.proc.stdout
    if (stdout == null) throw new Error("Given proc had no stdout")
    stdout.on("error", err => this.onError("stdout.error", err))
    stdout.on("data", d => this.onStdout(d))

    map(this.proc.stderr, stderr => {
      stderr.on("error", err => this.onError("stderr.error", err))
      stderr.on("data", err => this.onStderr(err))
    })

    this.streamDebouncer = debounce(opts.streamFlushMillis)

    this.startupTask = new Task(opts.versionCommand, SimpleParser)
    this.startupTask.promise
      // Prevent unhandled startup task rejections from killing node:
      .catch(err => {
        logger().warn(this.name + " startup task was rejected: " + err)
      })

    if (!this.execTask(this.startupTask)) {
      // This could also be considered a "start error", but if it's just an
      // internal bug and the process starts, don't veto because there's a bug:
      this.observer.onInternalError(
        new Error(this.name + " startup task was not submitted")
      )
    }
  }

  get pid(): number {
    return this.proc.pid
  }
  get taskCount(): number {
    return this._taskCount
  }
  get exited(): boolean {
    return !this._exited.pending
  }
  get exitedPromise(): Promise<void> {
    return this._exited.promise
  }
  get ready(): boolean {
    return (
      this.currentTask == null &&
      !this.startupTask.pending &&
      this._endPromise == null
    )
  }
  get idle(): boolean {
    return this.currentTask == null
  }

  /**
   * @return true if the child process is in the process table
   */
  async running(): Promise<boolean> {
    if (this.dead) return false
    else
      return pidExists(this.pid).then(alive => {
        if (!alive) {
          // once a PID leaves the process table, it's gone for good:
          this.dead = true
          this._endPromise = Promise.resolve()
        }
        return alive
      })
  }

  notRunning(): Promise<boolean> {
    return this.running().then(ea => !ea)
  }

  /**
   * @return {boolean} true if `this.end()` has been requested or the child
   * process has exited.
   */
  async ended(): Promise<boolean> {
    return this._endPromise != null || (await this.notRunning())
  }

  async notEnded(): Promise<boolean> {
    return this.ended().then(ea => !ea)
  }

  // This must not be async, or new instances aren't started as busy (until the
  // startup task is complete)
  execTask(task: Task<any>): boolean {
    // We're not going to run this.running() here, because BatchCluster will
    // already have pruned the processes that have exitted unexpectedly just
    // milliseconds ago.
    if (this.currentTask != null) {
      this.observer.onInternalError(
        new Error(
          `${this.name}.execTask(${task.command}): already working on ${
            this.currentTask
          }`
        )
      )
      return false
    }
    if (this._endPromise != null) {
      this.observer.onInternalError(
        new Error(
          `${this.name}.execTask(${task.command}): this process is ending/ended`
        )
      )
      return false
    }
    this._taskCount++
    this.currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const timeoutMs =
      task === this.startupTask
        ? this.opts.spawnTimeoutMillis
        : this.opts.taskTimeoutMillis
    if (timeoutMs > 0) {
      logger().trace(this.name + ".execTask(): scheduling timeout", {
        command: task.command,
        timeoutMs,
        pid: this.pid
      })
      this.currentTaskTimeout = setTimeout(
        () => this.onTimeout(task, timeoutMs),
        timeoutMs
      )
    }
    logger().debug(this.name + ".execTask(): starting", { cmd })
    // tslint:disable-next-line: no-floating-promises
    task.promise
      .catch(() => {})
      .then(() => {
        if (this.currentTask === task) {
          logger().debug(
            this.name + ".task resolved, but currentTask wasn't cleared",
            { task }
          )
          this.clearCurrentTask()
        }
      })
    this.proc.stdin!.write(cmd)
    return true
  }

  /**
   * End this child process.
   *
   * @param gracefully Wait for any current task to be resolved or rejected before shutting down the child process.
   * @param source who called end() (used for logging)
   * @return Promise that will be resolved when the process has completed. Subsequent calls to end() will ignore the parameters and return the first endPromise.
   */
  // NOT ASYNC! needs to change state immediately.
  end(gracefully: boolean = true, source: string): Promise<void> {
    logger().debug(this.name + ".end()", { gracefully, source })
    if (this._endPromise == null) {
      this._endPromise = this._end(gracefully, source)
    }
    return this._endPromise
  }

  // Must only be invoked by this.end(), and only expected to be invoked once
  // per instance.
  private async _end(
    gracefully: boolean = true,
    source: string
  ): Promise<void> {
    const lastTask = this.currentTask
    this.currentTask = undefined

    // NOTE: We *don't* want to clearCurrentTask here, because we want the
    // timeout to run if necessary.

    // If the task is just the startup task, assume we don't need to wait for
    // it to finish, even if we're gracefully shutting down.

    if (lastTask != null && lastTask !== this.startupTask) {
      if (gracefully) {
        logger().debug(this.name + ".end(): waiting for " + lastTask.command)
        try {
          await lastTask.promise
        } catch (err) {
          this.observer.onTaskError(err, lastTask)
        }
      } else {
        // This isn't an internal error, as this state would be expected if
        // the user calls .end(false) when there are pending tasks.
        logger().warn(this.name + ".end(): called while not idle", {
          source,
          gracefully,
          cmd: lastTask.command
        })
        // We're ending, so there's no point in asking if this error is fatal. It is.
        const err = new Error("end() called when not idle")
        this.observer.onTaskError(err, lastTask)
        lastTask.reject(err)
      }
    }

    const cmd = map(this.opts.exitCommand, ea => ensureSuffix(ea, "\n"))
    if (this.proc.stdin != null && this.proc.stdin.writable) {
      this.proc.stdin.end(cmd)
    }

    // proc cleanup:
    tryEach([
      () => map(this.proc.stdout, ea => ea.destroy()),
      () => map(this.proc.stderr, ea => ea.destroy()),
      () => this.proc.disconnect()
    ])

    if (
      this.opts.cleanupChildProcs &&
      gracefully &&
      this.opts.endGracefulWaitTimeMillis > 0 &&
      (await this.running())
    ) {
      // Wait for the end command to take effect:
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
      // If it's still running, send the pid a signal:
      if (await this.running()) await kill(this.proc.pid)
      // Wait for the signal handler to work:
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
    }

    if (this.opts.cleanupChildProcs && (await this.running())) {
      logger().warn(this.name + ".end(): force-killing still-running child.")
      await kill(this.proc.pid, true)
    }
    return this.exitedPromise
  }

  private awaitNotRunning(timeout: number) {
    return until(() => this.notRunning(), timeout)
  }

  private onTimeout(task: Task<any>, timeoutMs: number): void {
    if (task.pending) {
      // tslint:disable-next-line: no-floating-promises
      this.onError("timeout", new Error("waited " + timeoutMs + "ms"), task)
    }
  }

  private onError(source: string, _error: Error, task?: Task<any>) {
    if (task == null) {
      task = this.currentTask
    }
    const error = new Error(source + ": " + cleanError(_error.message))
    logger().warn(this.name + ".onError()", {
      source,
      task: map(task, t => t.command),
      error
    })

    if (_error.stack != null) {
      // Error stacks, if set, will not be redefined from a rethrow:
      error.stack = cleanError(_error.stack)
    }

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.clearCurrentTask()
    // tslint:disable-next-line: no-floating-promises
    this.end(false, "onError(" + source + ")")

    if (task === this.startupTask) {
      logger().warn(this.name + ".onError(): startup task failed: " + error)
      this.observer.onStartError(error)
    }

    if (task != null) {
      this.observer.onTaskError(error, task)
      if (task.pending) {
        task.reject(error)
      } else {
        this.observer.onInternalError(
          new Error(
            `${
              this.name
            }.onError(${error}) cannot reject already-fulfilled task.`
          )
        )
      }
    }
  }

  private onExit(source: string) {
    this._exited.resolve()
    // no need to be graceful, it's just for bookkeeping:
    return this.end(false, "onExit(" + source + ")")
  }

  private onStderr(data: string | Buffer) {
    logger().debug("onStderr(" + this.pid + "):" + data)
    if (data == null) return
    const task = this.currentTask
    if (task != null && task.pending) {
      task.onStderr(data)
      this.onData(task)
    } else {
      this.observer.onInternalError(
        new Error(
          "onStderr(" + data + ") no pending currentTask (task: " + task + ")"
        )
      )
    }
  }

  private onStdout(data: string | Buffer) {
    logger().debug("onStdout(" + this.pid + "):" + data)
    if (data == null) return
    const task = this.currentTask
    if (task != null && task.pending) {
      this.observer.onTaskData(data, task)
      task.onStdout(data)
      this.onData(task)
    } else {
      this.observer.onInternalError(
        new Error(
          "onStdout(" + data + ") no pending currentTask (task: " + task + ")"
        )
      )
    }
  }

  private onData(task: Task<any>) {
    // We might not have the final flushed contents of the streams (if we got stderr and stdout simultaneously.)
    const ctx = {
      stdout: task.stdout,
      stderr: task.stderr
    }
    const pass = this.opts.passRE.exec(task.stdout)
    if (pass != null) {
      logger().debug("onData(" + this.pid + ") PASS", { pass, ...ctx })
      return this.resolveCurrentTask(
        task,
        toS(pass[1]).trim(),
        task.stderr,
        true
      )
    }
    const failout = this.opts.failRE.exec(task.stdout)
    if (failout != null) {
      logger().debug("onData(" + this.pid + ") FAILOUT", { failout, ...ctx })
      return this.resolveCurrentTask(
        task,
        toS(failout[1]).trim(),
        task.stderr,
        false
      )
    }
    const failerr = this.opts.failRE.exec(task.stderr)
    if (failerr != null) {
      logger().debug("onData(" + this.pid + ") FAILERR", { failerr, ...ctx })
      return this.resolveCurrentTask(task, task.stdout, failerr[1], false)
    }
    logger().debug("onData(" + this.pid + ") not finished", ctx)
    return
  }

  private clearCurrentTask() {
    map(this.currentTaskTimeout, ea => clearTimeout(ea))
    this.currentTaskTimeout = undefined
    this.currentTask = undefined
  }

  private resolveCurrentTask(
    task: Task<any>,
    stdout: string,
    stderr: string,
    passed: boolean
  ) {
    this.streamDebouncer(async () => {
      logger().debug("resolveCurrentTask()", {
        task: String(task),
        stdout,
        stderr,
        passed
      })
      this.clearCurrentTask()
      // the task may have already timed out.
      if (task.pending) {
        await task.resolve(stdout, stderr, passed)
      }
      this.observer.onIdle()
    })
  }
}
