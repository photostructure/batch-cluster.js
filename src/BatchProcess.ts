import { BatchClusterOptions, BatchProcessOptions } from "./BatchCluster"
import { Deferred } from "./Deferred"
import { delay } from "./Delay"
import { Task } from "./Task"
import { kill } from "process"
import { ChildProcess } from "child_process"
import { debuglog, inspect, InspectOptions } from "util"

export interface BatchProcessObserver {
  onIdle(): void
  onStartError(error: any): void
  retryTask(task: Task<any>, error: any): void
}

export interface InternalBatchProcessOptions extends BatchProcessOptions, BatchClusterOptions {
  readonly passRE: RegExp
  readonly failRE: RegExp
}

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
  readonly start = Date.now()
  private _taskCount = -1 // don't count the warmup command
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

  constructor(readonly proc: ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref()

    // This signal is not reliably broadcast by node on child shutdown, so we
    // rely on the BatchCluster to regularly call `.exited()` for us.
    this.proc.on("exit", () => this.onExit())

    // forking or plumbing issues are not the task's fault, so retry:
    this.proc.on("error", err => this.onError("proc", err))
    this.proc.stdin.on("error", err => this.onError("stdin", err))
    this.proc.stdout.on("error", err => this.onError("stdout.error", err))
    this.proc.stderr.on("error", err => this.onError("stderr", err))
    this.proc.stderr.on("data", err => this.onError("stderr.data", err.toString()))

    this.proc.stdout.on("data", d => this.onData(d))

    this.startupTask = new Task(opts.versionCommand, ea => ea)

    // Prevent unhandled rejection showing on console:
    this.startupTask.promise.catch(err => this.log({ where: "startupTask", err }))

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
    return !this.ended && (this.currentTask == null)
  }

  get busy(): boolean {
    return !this.ended && (this.currentTask != null)
  }

  get starting(): boolean {
    return !this.busy && this._taskCount === 0
  }

  /**
   * @return true if the child process is in the process table
   */
  get alive(): boolean {
    try {
      // child_process.kill(0) returns a boolean on windows and linux
      const result = this.proc.kill(0 as any as string)
      return (typeof result === "boolean") ? result : alive(this.pid)
    } catch (err) {
      return false
    }
  }

  /**
   * @return {boolean} true if `this.end()` has been requested or the child
   * process has exited.
   */
  get ended(): boolean {
    return this._ended || this.exited
  }

  /**
   * true only if the child process has exited
   */
  get exited(): boolean {
    if (this._exited.pending) {
      if (!this.alive) {
        this.onExit()
      }
    }
    return !this._exited.pending
  }

  execTask(task: Task<any>): boolean {
    if (this.ended || this.currentTask != null) {
      console.error("INTERNAL ERROR: BatchProcess.execTask() called when not idle", {
        from: "execTask()",
        error: "This proc is not idle, and cannot exec task",
        ended: this.ended,
        currentTask: this.currentTask ? this.currentTask.command : "null"
      })
      return false
    }
    this._taskCount++
    this.currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const timeout = this.starting ? this.opts.spawnTimeoutMillis : this.opts.taskTimeoutMillis
    if (timeout > 0) {
      this.currentTaskTimeout = setTimeout(() => this.onTimeout(task), timeout)
    }
    this.log({ from: "execTask", timeout, task: cmd })
    this.proc.stdin.write(cmd)
    return true
  }

  async end(gracefully: boolean = true): Promise<void> {
    if (this._ended === false) {
      this._ended = true
      this.log({ from: "end()", exitCommand: this.opts.exitCommand })
      if (this.currentTask != null && this.currentTask !== this.startupTask) {
        this.observer.retryTask(this.currentTask, "process end")
      }
      this.clearCurrentTask()
      const cmd = this.opts.exitCommand ? ensureSuffix(this.opts.exitCommand, "\n") : undefined
      this.proc.stdin.end(cmd)
      if (gracefully) {
        const closed = [this.exitedPromise]
        if (this.opts.endGracefulWaitTimeMillis > 0) {
          closed.push(delay(this.opts.endGracefulWaitTimeMillis))
        }
        await Promise.race(closed)
      }
      if (!this.exited) {
        this.proc.kill(this.opts.shutdownSignal)
      }
    }
    return this.exitedPromise
  }

  private log(obj: any): void {
    debuglog("batch-cluster:process")(inspect(
      { time: new Date().toISOString(), pid: this.pid, ...obj, from: "BatchProcess." + obj.from },
      { colors: true, breakLength: 80 } as InspectOptions))
  }

  private onTimeout(task: Task<any>): void {
    if (task === this.currentTask && task.pending) {
      this.onError("timeout", new Error("timeout"), this.opts.retryTasksAfterTimeout, task)
    }
  }

  private onError(source: string, error: any, retryTask: boolean = true, task?: Task<any>) {
    if (task == null) {
      task = this.currentTask
    }
    this.log({ from: "onError()", source, error, retryTask, taskRetries: task ? task.retries : "null" })

    const errorMsg = source + ": " + (error.stack || error)

    // clear the task before ending so the onClose from end() doesn't retry the task:
    this.clearCurrentTask()
    this.end()

    if (this._taskCount === 0) {
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
    this.log({ from: "exit()" })
    const task = this.currentTask
    if (task != null && task !== this.startupTask) {
      this.observer.retryTask(task, "proc closed on " + task.command)
    }
    this.clearCurrentTask()
    this._ended = true
    this._exited.resolve()
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    this.log({
      from: "onData()",
      data: data.toString(),
      buff: this.buff,
      currentTask: this.currentTask && this.currentTask.command
    })
    const pass = this.opts.passRE.exec(this.buff)
    if (pass != null) {
      this.resolveCurrentTask(pass[1].trim())
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
        console.error("batch-process INTERNAL ERROR: no current task in resolveCurrentTask() result: " + result)
      }
      this.end()
    } else {
      this.log({ from: "resolveCurrentTask", result, task: task.command })
      task.onData(result)
      if (this.taskCount >= this.opts.maxTasksPerProcess) {
        this.end()
      } else {
        this.observer.onIdle()
      }
    }
  }
}

// private utility functions

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

function alive(pid: number): boolean {
  try {
    const result = kill(pid, 0)
    return (typeof result === "boolean") ? result : true
  } catch (err) {
    return false
  }
}
