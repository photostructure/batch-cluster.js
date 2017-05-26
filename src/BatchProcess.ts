import { BatchProcessOptions } from "./BatchCluster"
import { Deferred } from "./Deferred"
import { delay } from "./Delay"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import { debuglog, inspect, InspectOptions } from "util"

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

export interface BatchProcessObserver {
  onIdle(): void
  onStartError(error: any): void
  retryTask(task: Task<any>, error: any): void
}

export interface InternalBatchProcessOptions extends BatchProcessOptions {
  readonly passRE: RegExp
  readonly failRE: RegExp
}

export class BatchProcess {
  readonly start: number
  private _taskCount = -1 // don't count the warmup command
  /**
   * true if `this.end()` has been called, or this process is no longer in the
   * process table.
   */
  private _ended: boolean = false
  // Support for non-polling notification of process shutdown:
  private _exited = new Deferred<void>()

  private buff = ""
  private _currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined
  private readonly startupTask: Task<any>

  constructor(
    readonly proc: ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    this.start = Date.now()
    // forking issue, not the task's fault:
    this.proc.on("error", err => this.onError("proc", err, true))

    // pipe plumbing issues (like ECONNRESET) are not the task's fault, so retry:
    this.proc.stdin.on("error", err => this.onError("stdin", err, true))
    this.proc.stdout.on("error", err => this.onError("stdout.error", err, true))
    this.proc.stderr.on("error", err => this.onError("stderr", err, true))
    this.proc.stderr.on("data", err => this.onError("stderr.data", err.toString(), true))

    this.proc.stdout.on("data", d => this.onData(d))

    this.startupTask = new Task(opts.versionCommand, ea => ea)

    // This signal is not reliably broadcast on child shutdown, so
    // we rely on the BatchCluster to  regularly call `.exited()` for us.
    this.proc.on("exit", () => this.onExit())
    this.proc.unref() // < don't let node count the child processes as a reason to stay alive
    this.execTask(this.startupTask)
  }

  get idle(): boolean {
    return !this.ended && (this._currentTask == null)
  }

  get busy(): boolean {
    return !this.ended && (this._currentTask != null)
  }

  get starting(): boolean {
    return !this.busy && this._taskCount === 0
  }

  /**
   * True if the child process has exited or `this.end()` has been requested.
   */
  get ended(): boolean {
    return this._ended || this.exited
  }

  /**
   * true only if the child process has exited
   */
  get exited(): boolean {
    if (this._exited.pending) {
      // node bindings for kill are wrong, it takes a number. The "as any as
      // string" works around the bug:
      if (!this.proc.kill(0 as any as string)) {
        // kill(0) returns true iff the process is running.
        this.onExit()
      }
    }
    return !this._exited.pending
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

  get currentTask(): Task<any> | undefined {
    return this._currentTask
  }

  get currentTaskCommand(): string | undefined {
    return (this._currentTask == null) ? undefined : this._currentTask.command
  }

  execTask(task: Task<any>): boolean {
    if (this.ended || this.currentTask != null) {
      this.log({ from: "execTask", error: "This proc is not idle, and cannot exec task", ended: this.ended, currentTask: this.currentTaskCommand })
      return false
    }
    this._taskCount++
    this._currentTask = task
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
      const cmd = this.opts.exitCommand ? ensureSuffix(this.opts.exitCommand, "\n") : undefined
      this.proc.stdin.end(cmd)
      if (gracefully) {
        const closed = [this.exitedPromise]
        if (this.opts.endGracefulWaitTimeMillis != null) {
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
      { colors: true, breakLength: 80 } as InspectOptions
    ))
  }

  private onTimeout(task: Task<any>): void {
    if (task === this._currentTask && task.pending) {
      this.onError("timeout", new Error("timeout"), true, task)
    }
  }

  private onError(source: string, error: any, retryTask: boolean = false, task?: Task<any>) {
    if (task == null) {
      task = this._currentTask
    }
    this.log({ from: "onError(" + source + ")", error, retryTask, task: task ? task.command : "null" })

    const errorMsg = source + ": " + (error.stack || error)

    // clear the task before ending so the onClose doesn't retry the task:
    this.clearCurrentTask()
    this.end()

    if (this._taskCount === 0) {
      this.observer.onStartError(errorMsg)
    } else if (task != null && retryTask) {
      this.observer.retryTask(task, errorMsg)
    }

    this.observer.onIdle()
  }

  private onExit() {
    this.log({ from: "exit()" })
    const task = this._currentTask
    if (task != null && task !== this.startupTask) {
      this.observer.retryTask(task, "proc closed on " + task.command)
    }
    this.clearCurrentTask()
    this._ended = true
    this._exited.resolve()
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    this.log({ from: "onData()", data: data.toString(), buff: this.buff, currentTask: this._currentTask && this._currentTask.command })
    const pass = this.opts.passRE.exec(this.buff)
    if (pass != null) {
      return this.fulfillCurrentTask(pass[1], "onData")
    }
    const fail = this.opts.failRE.exec(this.buff)
    if (fail != null) {
      return this.fulfillCurrentTask(fail[1], "onError")
    }
  }

  private clearCurrentTask() {
    if (this.currentTaskTimeout != null) {
      clearTimeout(this.currentTaskTimeout)
      this.currentTaskTimeout = undefined
    }
    this._currentTask = undefined
  }

  private fulfillCurrentTask(result: string, methodName: "onData" | "onError"): void {
    this.buff = ""
    const task = this._currentTask

    this.clearCurrentTask()

    if (task == null) {
      if (result.length > 0 && !this._ended) {
        console.error("batch-process INTERNAL ERROR: no current task in fulfillCurrentTask(" + methodName + ") result: " + result)
      }
      this.end()
    } else {
      this.log({ from: "fulfillCurrentTask " + methodName, result, task: task.command })

      if (methodName === "onData") {
        task.onData(result)
      } else {
        task.onError(result)
      }

      if (this.taskCount >= this.opts.maxTasksPerProcess) {
        this.end()
      } else {
        this.observer.onIdle()
      }
    }
  }
}
