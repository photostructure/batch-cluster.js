import { BatchProcessOptions } from "./BatchCluster"
import { Deferred } from "./Deferred"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import { debuglog, inspect } from "util"

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

export interface BatchProcessObserver {
  onIdle(): void
  enqueueTask(task: Task<any>): void
}

export interface InternalBatchProcessOptions extends BatchProcessOptions {
  readonly passRE: RegExp
  readonly failRE: RegExp
}

export class BatchProcess {
  readonly start: number
  private _taskCount = -1 // don't count the warmup command
  private _ended: boolean = false
  private _closed = new Deferred<void>()

  private buff = ""
  private _currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined

  constructor(
    readonly proc: ChildProcess,
    readonly opts: InternalBatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    this.start = Date.now()
    this.proc.on("error", err => this.onError("proc", err, true))

    this.proc.stdin.on("error", err => this.onError("stdin", err, true)) // probably ECONNRESET

    this.proc.stderr.on("error", err => this.onError("stderr", err, false))
    this.proc.stderr.on("data", err => this.onError("stderr.data", err.toString(), false))

    this.proc.stdout.on("error", err => this.onError("stdout.error", err, true))
    this.proc.stdout.on("data", d => this.onData(d))
    this.proc.on("close", () => {
      this.log({ from: "close()" })
      this._ended = true
      this._closed.resolve()
    })
    this.proc.unref() // < don't let node count the child processes as a reason to stay alive
    this.execTask(new Task(opts.versionCommand, ea => ea))
  }

  get idle(): boolean {
    return !this._ended && (this._currentTask == null)
  }

  get busy(): boolean {
    return !this._ended && (this._currentTask != null)
  }

  get ended(): boolean {
    return this._ended
  }

  get pid(): number {
    return this.proc.pid
  }

  get taskCount(): number {
    return this._taskCount
  }

  get closedPromise(): Promise<void> {
    return this._closed.promise
  }

  get currentTask(): Task<any> | undefined {
    return this._currentTask
  }

  execTask(task: Task<any>): boolean {
    if (task.retriesRemaining == null) {
      task.retriesRemaining = this.opts.taskRetries
    }
    if (this.ended || this.currentTask != null) {
      return false
    }
    this._taskCount++
    this._currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    const timeout = (this._taskCount === 0) ? this.opts.spawnTimeoutMillis : this.opts.taskTimeoutMillis
    if (timeout > 0) {
      this.currentTaskTimeout = setTimeout(() => this.onTimeout(task), timeout)
    }
    this.log({ from: "execTask", timeout, task: cmd })
    this.proc.stdin.write(cmd)
    return true
  }

  kill(signal?: string) {
    return this.proc.kill(signal)
  }

  end(): Promise<void> {
    if (this._ended === false) {
      this._ended = true
      if (this.currentTaskTimeout != null) {
        clearTimeout(this.currentTaskTimeout)
      }
      this.log({ from: "end()", exitCommand: this.opts.exitCommand })
      const cmd = this.opts.exitCommand ? ensureSuffix(this.opts.exitCommand, "\n") : undefined
      this.proc.stdin.end(cmd)
    }
    return this.closedPromise
  }

  private log(obj: any): void {
    debuglog("batch-cluster")(inspect({ time: new Date().toISOString(), pid: this.pid, ...obj }, { colors: true }))
  }

  private onTimeout(task: Task<any>): void {
    if (task.pending) {
      this.onError("timeout", new Error("timeout"), true, task)
    }
  }

  private onError(source: string, error: any, retryTask: boolean = false, task?: Task<any>) {
    this.log({ from: "onError(" + source + ")", error, retryTask, task: task ? task.command : "null" })

    // Recycle on errors, and clear task timeouts:
    this.end()

    error = error.toString()
    if (task == null) {
      task = this._currentTask
    }
    this._currentTask = undefined

    if (task) {
      if (task.retriesRemaining == null) {
        task.retriesRemaining = this.opts.taskRetries
      }
      if (task.retriesRemaining > 0 && retryTask) {
        task.retriesRemaining--
        this.observer.enqueueTask(task)
      } else {
        task.onError(error)
      }
    }
    this.observer.onIdle()
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    this.log({ from: "BatchProcess.onData()", data: data.toString(), buff: this.buff, currentTask: this._currentTask && this._currentTask.command })
    const pass = this.opts.passRE.exec(this.buff)
    if (pass != null) {
      return this.fulfillCurrentTask(pass[1], "onData")
    }
    const fail = this.opts.failRE.exec(this.buff)
    if (fail != null) {
      return this.fulfillCurrentTask(fail[1], "onError")
    }
  }

  private fulfillCurrentTask(result: string, methodName: "onData" | "onError"): void {
    this.buff = ""
    const task = this._currentTask
    this._currentTask = undefined
    if (this.currentTaskTimeout != null) {
      clearTimeout(this.currentTaskTimeout)
      this.currentTaskTimeout = undefined
    }

    if (task == null) {
      if (result.length > 0) {
        console.error("batch-process INTERNAL ERROR: stdin got data, with no current task")
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
