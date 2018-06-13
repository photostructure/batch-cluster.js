import * as _cp from "child_process"
import * as _os from "os"
import * as _p from "process"
import { Writable } from "stream"

import {
  BatchClusterOptions,
  BatchProcessOptions,
  logger
} from "./BatchCluster"
import { Deferred } from "./Deferred"
import { until } from "./Delay"
import { Task } from "./Task"

/**
 * This interface decouples BatchProcess from BatchCluster.
 */
export interface BatchProcessObserver {
  onIdle(): void
  onStartError(error: Error): void
  retryTask(task: Task<any>, error: Error): void
}

export interface InternalBatchProcessOptions
  extends BatchProcessOptions,
    BatchClusterOptions {
  readonly passRE: RegExp
  readonly failRE: RegExp
}

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
  readonly start = Date.now()
  private _taskCount = -1 // don't count the startupTask
  /**
   * true if `this.end()` has been called, or this process is no longer in the
   * process table.
   */
  private _ended: boolean = false
  /**
   * Supports non-polling notification of process shutdown
   */
  private _exited = new Deferred<void>()
  /**
   * Data from stdout, to be given to _currentTask
   */
  private buff = ""
  /**
   * Should be undefined if this instance is not currently processing a task.
   */
  private currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined
  private readonly startupTask: Task<any>

  constructor(
    readonly proc: _cp.ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref()

    // forking or plumbing issues are not the task's fault, so retry:
    this.proc.on("error", err => this.onError("proc", err))
    this.proc.on("close", () => this.onExit())
    this.proc.on("exit", () => this.onExit())
    this.proc.on("disconnect", () => this.onExit())

    this.proc.stdin.on("error", err => this.onError("stdin", err))

    this.proc.stdout.on("error", err => this.onError("stdout.error", err))
    this.proc.stdout.on("data", d => this.onData(d))

    this.proc.stderr.on("error", err => this.onError("stderr", err))
    this.proc.stderr.on("data", err =>
      this.onError("stderr.data", new Error(String(err).trim()))
    )

    this.startupTask = new Task(opts.versionCommand, ea => ea)

    // Prevent unhandled startup task rejections from killing node:
    this.startupTask.promise.catch(() => {
      //
    })

    this.execTask(this.startupTask)
  }

  get pid(): number {
    return this.proc.pid
  }

  get taskCount(): number {
    return this._taskCount
  }

  get exitedPromise(): Promise<void> {
    return this._exited.promise
  }

  get idle(): boolean {
    return !this.ended && this.currentTask == null
  }

  get busy(): boolean {
    return !this.ended && this.currentTask != null
  }

  /**
   * @return true if the child process is in the process table
   */
  get running(): boolean {
    return running(this.pid)
  }

  /**
   * @return {boolean} true if `this.end()` has been requested or the child
   * process has exited.
   */
  get ended(): boolean {
    return this._ended || !this.running
  }

  execTask(task: Task<any>): boolean {
    if (!this.idle) {
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
      logger().trace("BatchProcess.execTask(): scheduling timeout", {
        command: task.command,
        timeoutMs,
        pid: this.pid
      })
      this.currentTaskTimeout = setTimeout(
        () => this.onTimeout(task, timeoutMs),
        timeoutMs
      )
    }
    logger().trace("BatchProcess.execTask(): starting", {
      cmd,
      retries: task.retries
    })
    this.proc.stdin.write(cmd)
    return true
  }

  async end(gracefully: boolean = true): Promise<void> {
    if (!this._ended) {
      this._ended = true
      const cmd = this.opts.exitCommand
        ? ensureSuffix(this.opts.exitCommand, "\n")
        : undefined
      await end(this.proc.stdin, cmd)
    }

    if (this.currentTask != null && this.currentTask !== this.startupTask) {
      this.observer.retryTask(this.currentTask, new Error("process ended"))
    }
    this.clearCurrentTask()

    tryEach([
      () => this.proc.stdin.end(),
      () => this.proc.stdout.destroy(),
      () => this.proc.stderr.destroy(),
      () => this.proc.disconnect()
    ])

    if (this.running && gracefully && this.opts.endGracefulWaitTimeMillis > 0) {
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
      if (this.running) kill(this.proc.pid, false)
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
    }

    if (this.running) {
      logger().info("BatchProcess.end(): killing PID " + this.pid)
      kill(this.proc.pid, true)
    }

    // The OS is srsly f@rked if `kill` doesn't respond within a couple ms. 5s
    // should be 100x longer than necessary.
    if (!(await this.awaitNotRunning(5000))) {
      logger().error(
        "BatchProcess.end(): PID " + this.pid + " did not respond to kill."
      )
    }

    return this.exitedPromise
  }

  private awaitNotRunning(timeout: number) {
    return until(() => !this.running, timeout)
  }

  private onTimeout(task: Task<any>, timeoutMs: number): void {
    if (task === this.currentTask && task.pending) {
      this.onError(
        "timeout",
        new Error("waited " + timeoutMs + "ms"),
        this.opts.retryTasksAfterTimeout,
        task
      )
      logger().warn(
        "BatchProcess.onTimeout(): ending to prevent result pollution with other tasks.",
        { pid: this.pid, task: task.command }
      )
      this.end()
    }
  }

  private async onError(
    source: string,
    _error: Error,
    retryTask: boolean = true,
    task?: Task<any>
  ) {
    if (task == null) {
      task = this.currentTask
    }
    // make a new Error rather than pollute the arg:
    const error = new Error(source + ": " + _error.message)
    error.stack = _error.stack

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.clearCurrentTask()
    this.end(false) // no need for grace, just clean up.
    if (task === this.startupTask) {
      logger().warn("BatchProcess.onError(): startup task failed: " + error)
      this.observer.onStartError(error)
    }

    if (task != null) {
      if (retryTask && task !== this.startupTask) {
        logger().debug("BatchProcess.onError(): task error, retrying", {
          command: task.command,
          pid: this.pid,
          taskCount: this.taskCount
        })
        this.observer.retryTask(task, error)
      } else {
        logger().debug("BatchProcess.onError(): task failed", {
          command: task.command,
          pid: this.pid,
          taskCount: this.taskCount
        })
        task.onError(error)
      }
    }
  }

  private onExit() {
    if (this.running) {
      throw new Error("BatchProcess.onExit() called on a running process")
    }
    this._ended = true
    const task = this.currentTask
    if (task != null && task !== this.startupTask) {
      this.observer.retryTask(task, new Error("child process exited"))
    }
    this.clearCurrentTask()
    this._exited.resolve()
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    const pass = this.opts.passRE.exec(this.buff)
    if (pass != null) {
      this.resolveCurrentTask(pass[1].trim())
      this.observer.onIdle()
    } else {
      const fail = this.opts.failRE.exec(this.buff)
      if (fail != null) {
        const err = new Error(fail[1].trim() || "command error")
        this.onError("onData", err, true, this.currentTask)
      }
    }
  }

  private clearCurrentTask() {
    if (this.currentTaskTimeout != null) {
      clearTimeout(this.currentTaskTimeout)
      this.currentTaskTimeout = undefined
    }
    this.currentTask = undefined
  }

  private resolveCurrentTask(result: string): void {
    this.buff = ""
    const task = this.currentTask
    this.clearCurrentTask()
    if (task == null) {
      if (result.length > 0 && !this._ended) {
        logger().error(
          "BatchProcess.resolveCurrentTask(): INTERNAL ERROR: no current task in resolveCurrentTask()",
          { result, pid: this.pid }
        )
      }
      this.end()
    } else {
      task.onData(result)
      this.observer.onIdle()
    }
  }
}

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

/**
 * @export
 * @param {number} pid process id. Required.
 * @returns {boolean} true if the given process id is in the local process
 * table.
 */
export function running(pid: number): boolean {
  const r = (() => {
    try {
      const result = process.kill(pid, 0) as any // node 7 and 8 return a boolean, but types are borked
      return typeof result === "boolean" ? result : true
    } catch (e) {
      return e.code === "EPERM" || e.errno === "EPERM"
    }
  })()
  return r
}

const isWin = _os.platform().startsWith("win")

/**
 * Send a signal to the given process id.
 *
 * @export
 * @param {number} pid the process id. Required.
 * @param {boolean} [force=false] if true, and the current user has
 * permissions to send the signal, the pid will be forced to shut down.
 */
export function kill(pid: number, force: boolean = false): void {
  if (isWin) {
    const args = ["/PID", pid.toString(), "/T"]
    if (force) {
      args.push("/F")
    }
    _cp.execFile("taskkill", args)
  } else {
    _p.kill(pid, force ? "SIGKILL" : "SIGTERM")
  }
}

function end(endable: Writable, contents?: string): Promise<void> {
  return new Promise<void>(resolve => {
    endable.end(contents, resolve)
  })
}

function tryEach(arr: (() => void)[]) {
  for (const f of arr) {
    try {
      f()
    } catch (_) {}
  }
}
