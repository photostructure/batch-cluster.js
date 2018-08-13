import * as _cp from "child_process"
import { Writable } from "stream"

import { until } from "./Async"
import {
  BatchClusterOptions,
  BatchProcessOptions,
  logger
} from "./BatchCluster"
import { Deferred } from "./Deferred"
import { map } from "./Object"
import { kill, running } from "./Procs"
import { Task } from "./Task"

/**
 * This interface decouples BatchProcess from BatchCluster.
 */
export interface BatchProcessObserver {
  onIdle(): void
  onTaskError(error: Error, task: Task<any>): void
  onStartError(error: Error): void
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
  readonly name: string
  readonly start = Date.now()
  private dead = false
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
    this.name = "BatchProcess(" + proc.pid + ")"
    // don't let node count the child processes as a reason to stay alive
    this.proc.unref()

    this.proc.on("error", err => this.onError("proc.error", err))
    this.proc.on("close", () => this.onExit("close"))
    this.proc.on("exit", () => this.onExit("exit"))
    this.proc.on("disconnect", () => this.onExit("disconnect"))

    this.proc.stdin.on("error", err => this.onError("stdin.error", err))

    this.proc.stdout.on("error", err => this.onError("stdout.error", err))
    this.proc.stdout.on("data", d => this.onData(d))

    this.proc.stderr.on("error", err => this.onError("stderr.error", err))
    this.proc.stderr.on("data", err =>
      this.onError("stderr.data", new Error(cleanError(err)))
    )

    this.startupTask = new Task(opts.versionCommand, ea => ea)

    this.startupTask.promise
      .then(() => logger().trace(this.name + " is ready"))
      // Prevent unhandled startup task rejections from killing node:
      .catch(err => {
        logger().warn(this.name + " startup task was rejected: " + err)
      })

    if (!this.execTask(this.startupTask)) {
      logger().error(
        this.name + " INTERNAL ERROR startup task was not submitted"
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
    return this.currentTask == null && !this._ended && !this.startupTask.pending
  }

  async busy(): Promise<boolean> {
    return this.currentTask != null && this.notEnded()
  }

  /**
   * @return true if the child process is in the process table
   */
  async running(): Promise<boolean> {
    if (this.dead) return false
    else return running(this.pid).then(alive => {
      if (!alive) {
        // once a PID leaves the process table, it's gone for good:
        this.dead = true
        this._ended = true
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
    return this._ended || this.notRunning()
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
    if (this._ended || this.currentTask != null) {
      logger().warn(
        this.name +
          ".execTask(" +
          task.command +
          "): INTERNAL ERROR, already working on " +
          this.currentTask
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
    logger().trace(this.name + ".execTask(): starting", { cmd })
    this.proc.stdin.write(cmd)
    return true
  }

  end(gracefully: boolean = true, source: string): Promise<void> {
    const firstEnd = !this._ended
    this._ended = true
    return this._end(gracefully, source, firstEnd)
  }

  private async _end(
    gracefully: boolean = true,
    source: string,
    firstEnd: boolean
  ): Promise<void> {
    logger().debug(this.name + ".end()", { gracefully, source })
    this._ended = true

    if (firstEnd) {
      const cmd = map(this.opts.exitCommand, ea => ensureSuffix(ea, "\n"))
      if (this.proc.stdin.writable) {
        await end(this.proc.stdin, cmd)
      }
    }
    if (this.currentTask != null) {
      logger().warn(this.name + ".end(): called while not idle", {
        source,
        gracefully,
        cmd: this.currentTask.command
      })
      const err = new Error("end() called when not idle")
      this.observer.onTaskError(err, this.currentTask)
      this.currentTask.reject(err)
    }
    this.clearCurrentTask()

    tryEach([
      () => this.proc.stdin.end(),
      () => this.proc.stdout.destroy(),
      () => this.proc.stderr.destroy(),
      () => this.proc.disconnect()
    ])

    if (await this.running() && gracefully && this.opts.endGracefulWaitTimeMillis > 0) {
      // Wait for the end command to take effect:
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
      // If it's still running, send the pid a signal:
      if (await this.running()) await kill(this.proc.pid)
      // Wait for the signal handler to work:
      await this.awaitNotRunning(this.opts.endGracefulWaitTimeMillis / 2)
    }

    if (await this.running()) {
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
      this.onError("timeout", new Error("waited " + timeoutMs + "ms"), task)
    }
  }

  private async onError(source: string, _error: Error, task?: Task<any>) {
    if (task == null) {
      task = this.currentTask
    }
    const error = new Error(source + ": " + cleanError(_error.message))
    logger().warn(this.name + ".onError()", {
      source,
      task: map(task, t => t.command),
      error
    })

    if (_error.stack) {
      // Error stacks, if set, will not be redefined from a rethrow:
      error.stack = cleanError(_error.stack)
    }

    // clear the task before ending so the onExit from end() doesn't retry the task:
    this.clearCurrentTask()
    this.end(false, "onError(" + source + ")") // no need for grace (there isn't a pending job)
    if (task === this.startupTask) {
      logger().warn(this.name + ".onError(): startup task failed: " + error)
      this.observer.onStartError(error)
    }

    if (task != null) {
      logger().debug(this.name + ".onError(): task failed", {
        command: task.command,
        pid: this.pid,
        taskCount: this.taskCount
      })
      this.observer.onTaskError(error, task)
      task.reject(error)
    }
  }

  private onExit(source: string) {
    this.end(false, "onExit(" + source + ")") // no need to be graceful, just do the bookkeeping.
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
        const err = new Error(cleanError(fail[1]) || "command error")
        this.onError("onData", err)
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
          this.name + ".resolveCurrentTask(): INTERNAL ERROR: no current task",
          { result, pid: this.pid }
        )
      }
      this.end(false, "resolveCurrentTask(no current task)")
    } else {
      logger().trace(this.name + ".resolveCurrentTask()", {
        task: task.command,
        result
      })
      task.resolve(result)
      this.observer.onIdle()
    }
  }
}

/**
 * When we wrap errors, an Error always prefixes the toString() and stack with
 * "Error: ", so we can remove that prefix.
 */
function cleanError(s: any): string {
  return String(s)
    .trim()
    .replace(/^error: /gi, "")
}

function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

function end(endable: Writable, contents?: string): Promise<void> {
  return new Promise<void>(resolve => {
    contents == null ? endable.end(resolve) : endable.end(contents, resolve)
  })
}

function tryEach(arr: (() => void)[]) {
  for (const f of arr) {
    try {
      f()
    } catch (_) {}
  }
}
