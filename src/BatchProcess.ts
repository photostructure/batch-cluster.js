import { Deferred } from "./Deferred"
import { Task } from "./Task"
import { ChildProcess } from "child_process"

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

export class BatchProcess {
  private _taskCount = -1 // don't count the warmup command
  private _ended: boolean = false
  private _closed = new Deferred<void>()

  private buff = ""
  private _currentTask: Task<any> | undefined
  private currentTaskTimeout: NodeJS.Timer | undefined

  constructor(readonly proc: ChildProcess,
    readonly opts: BatchProcessOptions,
    readonly observer: BatchProcessObserver) {
    this.proc.on("error", err => this.onError(err, true))

    this.proc.stdin.on("error", err => this.onError( err, true)) // probably ECONNRESET

    this.proc.stderr.on("error", err => this.onError(err, false))
    this.proc.stderr.on("data", err => this.onError(err, false))

    this.proc.stdout.on("error", err => this.onError(err, true))
    this.proc.stdout.on("data", d => this.onData(d))

    this.proc.on("close", () => {
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
    this.proc.stdin.write(cmd)
    return true
  }

  kill(signal?: string) {
    return this.proc.kill(signal)
  }

  end(exitCommand?: string): Promise<void> {
    if (this._ended === false) {
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
      this.onError("timeout", true, task)
    }
  }

  private onError(error: any, retryTask: boolean = false, task?: Task<any>) {
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
    this.observer.onIdle(this)
  }

  private onData(data: string | Buffer) {
    this.buff = this.buff + data.toString()
    const withoutPass = stripSuffix(this.buff, this.opts.passString)
    if (withoutPass != null) {
      return this.fulfillCurrentTask(withoutPass, t => t.onData.bind(t))
    } else {
      const withoutFail = stripSuffix(this.buff, this.opts.failString)
      if (withoutFail != null) {
        return this.fulfillCurrentTask(withoutFail, t => t.onError.bind(t))
      }
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
        console.error("batch-process INTERNAL ERROR: stdin got data, with no current task")
      }
      this.end()
    } else {
      f(task)(result)
      if (this.taskCount >= this.opts.maxTasksPerProcess) {
        this.end()
      } else {
        this.observer.onIdle(this)
      }
    }
  }
}

