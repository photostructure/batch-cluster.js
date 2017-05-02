import { Deferred } from "./Deferred"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import { debuglog } from "util"

const dbg = debuglog("batch-cluster:BatchProcess")

export interface BatchProcessOptions {

  /** Low-overhead command to verify the child batch process has started */
  readonly versionCommand: string

  /** Expected text to print if a command passes */
  readonly passString: string

  /** Expected text to print if a command fails */
  readonly failString: string

  /** Command to end the child batch process */
  readonly exitCommand?: string

  /**
   * If commands take longer than this, presume the underlying process is dead
   * and we should restart the task.
   */
  readonly taskTimeoutMillis: number

  /**
   * Must be >= 0. Processes will be recycled after processing `maxTasksPerProcess` tasks.
   */
  readonly maxTasksPerProcess: number

  /**
   * Must be >= 0. Tasks that result in errors will be retried at most
   * `maxTaskRetries` times.
   */
  readonly taskRetries: number
}

export interface BatchProcessObserver {
  onIdle(batchProc: BatchProcess): void
  enqueueTask(task: Task<any>): void
}

export class BatchProcess {
  private _taskCount = 0
  private _ended: boolean = false
  private _closed = new Deferred<void>()

  private buff = ""
  private _currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined

  constructor(
    readonly proc: ChildProcess,
    readonly opts: BatchProcessOptions,
    readonly observer: BatchProcessObserver
  ) {
    this.proc.on("error", err => this.onError("proc onError", err, true))

    this.proc.stdin.on("error", err => this.onError("stdin onError", err, true)) // probably ECONNRESET

    this.proc.stderr.on("error", err => this.onError("stderr onError", err, false))
    this.proc.stderr.on("data", err => this.onError("stderr onData", err, false))

    this.proc.stdout.on("error", err => this.onError("stdout onError", err, true))
    this.proc.stdout.on("data", d => this.onData(d))

    this.proc.on("close", () => {
      this._ended = true
      this._closed.resolve()
    })
    this.proc.unref() // < don't let node count the child processes as a reason to stay alive
    this.execTask(new Task(opts.versionCommand, ea => ea))
  }

  kill(signal?: string) {
    return this.proc.kill(signal)
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
      dbg("Internal error: scheduled task for non-idle process, " + this.pid)
      return false
    }
    this._taskCount++
    this._currentTask = task
    const cmd = task.command.endsWith("\n") ? task.command : task.command + "\n"
    dbg("Running " + cmd)
    if (this.opts.taskTimeoutMillis > 0) {
      this.currentTaskTimeout = setTimeout(() => this.onTimeout(task), this.opts.taskTimeoutMillis)
    }
    this.proc.stdin.write(cmd)
    return true
  }

  end(exitCommand?: string): Promise<void> {
    if (this._ended == false) {
      this._ended = true
      if (this.currentTaskTimeout != null) {
        clearTimeout(this.currentTaskTimeout)
      }
      this.proc.stdin.end(exitCommand)
    }
    return this.closedPromise
  }

  private onTimeout(task: Task<any>): void {
    if (task.pending) {
      this.onError("timeout", "timeout", true, task)
    }
  }

  private onError(source: string, error: any, retryTask: boolean = false, task?: Task<any>) {
    // Recycle on errors, and clear task timeouts:
    this.end()

    const err = Buffer.isBuffer(error) ? error.toString() : error
    dbg(`Handling error from ${source}: ${err}`)
    if (task == null) {
      task = this._currentTask
      this._currentTask = undefined
    }
    if (task) {
      if (task.retriesRemaining == null) {
        task.retriesRemaining = this.opts.taskRetries
      }
      if (task.retriesRemaining > 0 && retryTask) {
        dbg(`Re-enqueuing ${task}...`)
        task.retriesRemaining--
        this.observer.enqueueTask(task)
      } else {
        task.onError(error)
      }
    } else {
      dbg(`Error from command: ${err}`)
    }
    this.observer.onIdle(this)
  }

  private onData(data: string | Buffer) {
    this.buff = (this.buff + data.toString())

    if (this.buff.endsWith(this.opts.passString)) {
      this.fulfillCurrentTask(this.buff.slice(0, -this.opts.passString.length), t => t.onData)
    } else if (this.buff.endsWith(this.opts.failString)) {
      this.fulfillCurrentTask(this.buff.slice(0, -this.opts.failString.length), t => t.onError)
    }
  }

  private fulfillCurrentTask(result: string, f: (task: Task<any>) => (result: string) => void): void {
    this.buff = ""
    const task = this._currentTask
    this._currentTask = undefined
    if (this.currentTaskTimeout != null) {
      clearTimeout(this.currentTaskTimeout)
      this.currentTaskTimeout = undefined
    }

    if (task == null) {
      if (result.length > 0) {
        dbg("INTERNAL ERROR: stdin got data, with no current task")
        dbg(`Ignoring output >>>${result}<<<`)
      }
      this.end()
    } else {
      f(task)(result)
      if (this._taskCount >= this.opts.maxTasksPerProcess) {
        this.end()
      } else {
        this.observer.onIdle(this)
      }
    }
  }
}