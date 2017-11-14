import { BatchClusterOptions, BatchProcessOptions } from "./BatchCluster"
import { Deferred } from "./Deferred"
import { delay } from "./Delay"
import { Task } from "./Task"
import * as _cp from "child_process"
import * as _os from "os"
import * as _p from "process"

export interface BatchProcessObserver {
  onIdle(): void
  onStartError(error: any): void
  retryTask(task: Task<any>, error: any): void
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
      this.onError("stderr.data", err.toString())
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
      console.error(
        "batch-process INTERNAL ERROR: BatchProcess.execTask() called when not idle",
        {
          from: "execTask()",
          error: "This proc is not idle, and cannot exec task",
          ended: this.ended,
          currentTask: this.currentTask ? this.currentTask.command : "null"
        }
      )
      return false
    }
    this._taskCount++
    this.currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const timeout =
      task === this.startupTask
        ? this.opts.spawnTimeoutMillis
        : this.opts.taskTimeoutMillis
    if (timeout > 0) {
      this.currentTaskTimeout = setTimeout(() => this.onTimeout(task), timeout)
    }
    this.proc.stdin.write(cmd)
    return true
  }

  async end(gracefully: boolean = true): Promise<void> {
    const tasks = [this.exitedPromise]

    if (!this._ended) {
      this._ended = true
      const cmd = this.opts.exitCommand
        ? ensureSuffix(this.opts.exitCommand, "\n")
        : undefined
      this.proc.stdin.end(cmd)
      if (gracefully) {
        if (this.opts.endGracefulWaitTimeMillis > 0) {
          tasks.push(delay(this.opts.endGracefulWaitTimeMillis))
        }
      }
    }

    if (this.currentTask != null && this.currentTask !== this.startupTask) {
      this.observer.retryTask(this.currentTask, "process end")
    }
    this.clearCurrentTask()

    try {
      this.proc.stdin.end()
      this.proc.stdout.destroy()
      this.proc.stderr.destroy()
      this.proc.disconnect()
    } catch (_) {
      // don't care
    }

    if (this.running) {
      await Promise.race(tasks)
    }
    if (this.running) {
      kill(this.proc.pid, !gracefully)
    }
    return this.exitedPromise
  }

  private onTimeout(task: Task<any>): void {
    if (task === this.currentTask && task.pending) {
      this.onError(
        "timeout",
        new Error("timeout"),
        this.opts.retryTasksAfterTimeout,
        task
      )
    }
  }

  private async onError(
    source: string,
    error: any,
    retryTask: boolean = true,
    task?: Task<any>
  ) {
    if (task == null) {
      task = this.currentTask
    }
    const errorMsg = source + ": " + (error.stack || error)

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.clearCurrentTask()
    if (!this._ended) await this.end()

    if (task === this.startupTask) {
      this.observer.onStartError(errorMsg)
    }

    if (task != null) {
      if (retryTask && task !== this.startupTask) {
        this.observer.retryTask(task, errorMsg)
      } else {
        task.onError(errorMsg)
      }
    }
  }

  private onExit() {
    if (this.running) {
      throw new Error("onExit() called on a running process")
    }
    this._ended = true
    const task = this.currentTask
    if (task != null && task !== this.startupTask) {
      this.observer.retryTask(task, "child proc closed")
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
        const err = fail[1].trim() || new Error("command error")
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
        console.error(
          "batch-process INTERNAL ERROR: no current task in resolveCurrentTask() result: " +
            result
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

export function kill(pid: number, force: boolean = false): void {
  if (isWin) {
    const args = ["/pid", pid.toString(), "/T"]
    if (force) {
      args.push("/F")
    }
    _cp.execFile("taskkill", args)
  } else {
    _p.kill(pid, force ? "SIGKILL" : "SIGTERM")
  }
}
