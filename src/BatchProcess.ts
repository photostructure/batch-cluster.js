import { Deferred } from "./Deferred"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import { debuglog } from "util"

const dbg = debuglog("batch-cluster")

export interface BatchProcessOptions {

  /**
   * Low-overhead command to verify the child batch process has started
   */
  readonly versionCommand: string

  /**
   * Expected text to print if a command passes
   */
  readonly passString: string

  /**
   * Expected text to print if a command fails 
   */
  readonly failString: string

  /**
   * Command to end the child batch process
   */
  readonly exitCommand?: string

  /**
   * Spawning new commands must not take longer than this. Be pessimistic
   * here--windows can regularly take several seconds to spin up a process,
   * thanks to antivirus shenanigans.
   */
  readonly spawnTimeoutMillis: number

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

// this is exported to allow BatchCluster to do this operation once, rather than
// every time there is a new process spawned. It is not for public consumption.
export function verifyOpts(opts: BatchProcessOptions): Partial<BatchProcessOptions> {
  return {
    versionCommand: ensureSuffix(opts.versionCommand, "\n"),
    passString: ensureFix(opts.passString, "\n"),
    failString: ensureFix(opts.failString, "\n"),
    exitCommand: opts.exitCommand ? ensureSuffix(opts.exitCommand, "\n") : undefined
  }
}

export interface BatchProcessObserver {
  onIdle(batchProc: BatchProcess): void
  enqueueTask(task: Task<any>): void
}

function ensureFix(s: string, fix: string): string {
  return ensureSuffix(ensurePrefix(s, fix), fix)
}

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

function ensurePrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s : prefix + s
}

function stripSuffix(s: string, suffix: string): string | undefined {
  suffix = ensureSuffix(suffix, "\n")
  if (s.endsWith(suffix)) {
    return s.slice(0, -suffix.length)
  } else {
    s = s.trim()
    if (s.endsWith(suffix)) {
      return s.slice(0, -suffix.length)
    }
  }
  return
}

const start = Date.now()

export class BatchProcess {
  private _taskCount = -1 // don't count the warmup command
  private _ended: boolean = false
  private _endTime: number
  private _closed = new Deferred<void>()

  private buff = ""
  private _currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined

  constructor(readonly proc: ChildProcess,
    readonly opts: BatchProcessOptions,
    readonly observer: BatchProcessObserver) {
    this.proc.on("error", err => this.onError("proc onError", err, true))

    this.proc.stdin.on("error", err => this.onError("stdin onError", err, true)) // probably ECONNRESET

    this.proc.stderr.on("error", err => this.onError("stderr onError", err, false))
    this.proc.stderr.on("data", err => this.onError("stderr onData", err, false))

    this.proc.stdout.on("error", err => this.onError("stdout onError", err, true))
    this.proc.stdout.on("data", d => this.onData(d))

    this.proc.on("close", () => {
      this._ended = true
      console.log(this.pid + " closed in " + (Date.now() - this._endTime) + " ms")
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
      this.log("execTask", "INTERNAL ERROR: scheduled task for non-idle process, " + this.pid)
      return false
    }
    this._taskCount++
    this._currentTask = task
    const cmd = ensureSuffix(task.command, "\n")
    this.log("execTask", "running " + cmd)
    const timeout = (this._taskCount === 0) ? this.opts.spawnTimeoutMillis : this.opts.taskTimeoutMillis
    if (timeout > 0) {
      this.currentTaskTimeout = setTimeout(() => this.onTimeout(task), timeout)
      this.log("execTask", "set task timeout in " + this.opts.taskTimeoutMillis + " ms")
    }
    this.proc.stdin.write(cmd)
    return true
  }

  kill(signal?: string) {
    return this.proc.kill(signal)
  }

  end(exitCommand?: string): Promise<void> {
    if (this._ended === false) {
      this._ended = true
      this._endTime = Date.now()
      if (this.currentTaskTimeout != null) {
        clearTimeout(this.currentTaskTimeout)
      }
      this.proc.stdin.end(exitCommand)
    }
    return this.closedPromise
  }

  private onTimeout(task: Task<any>): void {
    if (task.pending) {
      this.log("onTimeout", "Caught timeout for task " + task.command)
      this.onError("timeout", "timeout", true, task)
    }
  }

  private onError(source: string, error: any, retryTask: boolean = false, task?: Task<any>) {
    // Recycle on errors, and clear task timeouts:
    this.end()

    error = error.toString()
    this.log("onError", `Handling error from ${source}: ${error}`)
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
        this.log("onError", `Re-enqueuing ${task} with ${task.retriesRemaining} retries remaining`)
        this.observer.enqueueTask(task)
      } else {
        this.log("onError", `No more retries for ${task}, rejecting`)
        task.onError(error)
      }
    }
    this.observer.onIdle(this)
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    const withoutPass = stripSuffix(this.buff, this.opts.passString)
    if (withoutPass != null) {
      this.log("onData", "resolving with " + withoutPass)
      return this.fulfillCurrentTask(withoutPass, t => t.onData.bind(t))
    } else {
      const withoutFail = stripSuffix(this.buff, this.opts.failString)
      if (withoutFail != null) {
        this.log("onData", "rejecting with " + withoutFail)
        return this.fulfillCurrentTask(withoutFail, t => t.onError.bind(t))
      }
    }

    this.log("onData", "unresolved >>>" + this.buff + "<<<")
  }

  private fulfillCurrentTask(result: string, f: (task: Task<any>) => (result: string) => void): void {
    this.buff = ""
    const task = this._currentTask
    this._currentTask = undefined
    if (this.currentTaskTimeout != null) {
      this.log("fulfillCurrentTask", "clearing timeout " + this.currentTaskTimeout)
      clearTimeout(this.currentTaskTimeout)
      this.currentTaskTimeout = undefined
    }

    if (task == null) {
      if (result.length > 0) {
        this.log("fulfillCurrentTask", "INTERNAL ERROR: stdin got data, with no current task")
        this.log("fulfillCurrentTask", "Ignoring output >>>" + result + "<<<")
      }
      this.end()
    } else {
      f(task)(result)
      if (this.taskCount >= this.opts.maxTasksPerProcess) {
        this.log("fulfillCurrentTask", "recycling after " + this.taskCount + " tasks")
        this.end()
      } else {
        this.observer.onIdle(this)
      }
    }
  }

  private log(method: string, msg: string) {
    dbg(Date.now() - start + " " + this.pid + " " + method + "(): " + msg)
  }
}

