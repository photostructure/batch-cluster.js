import { Rate } from "./Rate"
import { BatchProcess, BatchProcessObserver, InternalBatchProcessOptions } from "./BatchProcess"
import { delay } from "./Delay"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import * as _p from "process"
import { debuglog, inspect, InspectOptions } from "util"

/**
 * These are required parameters for a given BatchCluster.
 */
export interface ChildProcessFactory {
  /**
   * Expected to be a simple call to execFile. Platform-specific code is the
   * responsibility of this thunk. Error handlers will be registered as
   * appropriate.
   */
  readonly processFactory: () => ChildProcess
}

export { Deferred } from "./Deferred"
export { Task, Parser } from "./Task"
export { delay } from "./Delay"

export interface BatchProcessOptions {

  /**
   * Low-overhead command to verify the child batch process has started
   */
  readonly versionCommand: string

  /**
   * Expected text to print if a command passes. Cannot be blank.
   */
  readonly pass: string

  /**
   * Expected text to print if a command fails. Cannot be blank.
   */
  readonly fail: string

  /**
   * Command to end the child batch process. If not provided, stdin will be
   * closed to signal to the child process that it may terminate, and if it does
   * not shut down within `endGracefulWaitTimeMillis`, it will be SIGHUP'ed.
   */
  readonly exitCommand?: string

  /**
   * Spawning new commands must not take longer than this. Be pessimistic
   * here--windows can regularly take several seconds to spin up a process,
   * thanks to antivirus shenanigans.
   *
   * This can't be set to a value less than 100ms.
   */
  readonly spawnTimeoutMillis: number

  /**
   * If commands take longer than this, presume the underlying process is dead
   * and we should restart the task.
   *
   * This can't be set to a value less than 10ms, and really should be set to
   * something like several seconds.
   */
  readonly taskTimeoutMillis: number

  /**
   * Must be >= 0. Processes will be recycled after processing
   * `maxTasksPerProcess` tasks. Depending on the commands and platform, batch
   * mode commands shouldn't exhibit unduly memory leaks for at least tens if
   * not thousands of tasks. Setting this to a low number (like less than 10)
   * will impact performance markedly.
   */
  readonly maxTasksPerProcess: number
}

/**
 * These parameter values have somewhat sensible defaults, but can be overridden
 * for a given BatchCluster.
 */
export class BatchClusterOptions {
  /**
   * No more than `maxProcs` child processes will be run at a given time
   * to serve pending tasks.
   */
  readonly maxProcs: number = 1

  /**
   * Child processes will be recycled when they reach this age.
   *
   * If this value is set to 0, child processes will not "age out".
   *
   * This value should not be less than `spawnTimeoutMillis` or
   * `taskTimeoutMillis`.
   */
  readonly maxProcAgeMillis: number = 5 * 60 * 1000 // 5 minutes

  /**
   * This is the minimum interval between calls to `this.onIdle`, which runs
   * pending tasks and shuts down old child processes.
   */
  readonly onIdleIntervalMillis: number = 1000

  /**
   * When `this.end()` is called, or Node broadcasts the `beforeExit` event,
   * this is the milliseconds spent waiting for currently running tasks to
   * finish before sending kill signals to child processes.
   *
   * Setting this value to 0 will not wait for processes to shut down before
   * sending them a kill signal.
   */
  readonly endGracefulWaitTimeMillis: number = 500

  /**
   * Must be >= 0. Tasks that result in errors will be retried at most
   * `taskRetries` times.
   */
  readonly taskRetries: number = 0

  /**
   * If the initial `versionCommand` fails for new spawned processes more than
   * this rate, end this BatchCluster and throw an error, because something is
   * terribly wrong.
   *
   * If this backstop didn't exist, new (failing) child processes would be
   * created indefinitely.
   */
  readonly maxReasonableProcessFailuresPerMinute: number = 10
}

function verifyOptions(
  opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory
): AllOpts {
  const toRe = (s: string) =>
    new RegExp("^([\\s\\S]*?)[\\n\\r]+" + s + "[\\n\\r]*$")

  const result = {
    ... new BatchClusterOptions(),
    ...opts,
    passRE: toRe(opts.pass),
    failRE: toRe(opts.fail)
  }

  const errors: string[] = []
  const notBlank = (fieldName: keyof AllOpts) => {
    const v = result[fieldName] as string
    if (v.trim().length === 0) {
      errors.push(fieldName + " must not be blank")
    }
  }
  const gte = (fieldName: keyof AllOpts, value: number) => {
    const v = result[fieldName] as number
    if (v < value) {
      errors.push(fieldName + " must be greater than or equal to " + value)
    }
  }
  notBlank("versionCommand")
  notBlank("pass")
  notBlank("fail")

  gte("spawnTimeoutMillis", 100)
  gte("taskTimeoutMillis", 10)
  gte("maxTasksPerProcess", 1)

  gte("maxProcs", 1)
  gte("maxProcAgeMillis", 0)
  gte("onIdleIntervalMillis", 0)
  gte("endGracefulWaitTimeMillis", 0)
  gte("taskRetries", 0)
  gte("maxReasonableProcessFailuresPerMinute", 0)

  if (errors.length > 0) {
    throw new Error("BatchCluster was given invalid options: " + errors.join(", "))
  }

  return result
}

type AllOpts = BatchClusterOptions & InternalBatchProcessOptions & ChildProcessFactory

export class BatchCluster {
  private readonly opts: AllOpts
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private readonly _pendingTasks: Task<any>[] = []
  private readonly onIdleInterval: NodeJS.Timer
  private readonly beforeExitListener = this.end.bind(this)
  private readonly startErrorRate = new Rate()
  private _ended = false

  constructor(opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory) {
    this.opts = verifyOptions(opts)
    if (this.opts.onIdleIntervalMillis > 0) {
      this.onIdleInterval = setInterval(() => this.onIdle(), this.opts.onIdleIntervalMillis)
      this.onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.observer = {
      onIdle: this.onIdle.bind(this),
      onStartError: this.onStartError.bind(this),
      retryTask: this.retryTask.bind(this)
    }
    _p.on("beforeExit", this.beforeExitListener)
  }

  get ended(): boolean {
    return this._ended
  }

  // not async so it doesn't relinquish control flow
  end(): Promise<void> {
    if (!this._ended) {
      this._ended = true
      clearInterval(this.onIdleInterval)
      _p.removeListener("beforeExit", this.beforeExitListener)
      this.procs().forEach(p => p.end())
      const busyProcs = this._procs.filter(p => p.busy)
      this.log({ from: "end()", busyProcs: busyProcs.map(p => p.pid) })
      return Promise.race([
        delay(this.opts.endGracefulWaitTimeMillis),
        Promise.all(busyProcs.map(p => p.closedPromise))
      ]).then(() => {
        this._procs.forEach(p => p.kill())
      }).then(() => this.endPromise)
    } else {
      return this.endPromise
    }
  }

  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this._ended) {
      task.onError("BatchCluster has ended")
      throw new Error("Cannot enqueue task " + task.command)
    }
    this._pendingTasks.push(task)
    this.onIdle()
    return task.promise
  }

  /**
   * @return the current, non-ended child process PIDs. Useful for integration
   * tests, but most likely not generally interesting.
   */
  get pids(): number[] {
    return this.procs().map(p => p.pid)
  }

  private get endPromise(): Promise<void> {
    return Promise.all(this.procs().map(p => p.closedPromise)) as Promise<void>
  }

  private retryTask(task: Task<any>, error: any) {
    if (task) {
      if (task.retries < this.opts.taskRetries) {
        task.retries++
        this.enqueueTask(task)
      } else {
        task.onError(error)
      }
    }
  }

  private onStartError(error: any): void {
    this.startErrorRate.onEvent()
    this.log({ from: "onStartError()", error, startErrorRate: this.startErrorRate.eventsPerSecond })
    if (this.startErrorRate.eventsPerMinute > this.opts.maxReasonableProcessFailuresPerMinute) {
      this.end()
      throw new Error(error + "(start errors/min: " + this.startErrorRate.eventsPerMinute + ")")
    }
  }

  private dequeueTask(): Task<any> | undefined {
    return this._pendingTasks.shift()
  }

  private procs(): BatchProcess[] {
    const minStart = Date.now() - this.opts.maxProcAgeMillis
    for (let i = this._procs.length - 1; i >= 0; i--) {
      const proc = this._procs[i]
      if (proc.start < minStart) {
        // This will only be in the case of an aggressive maxProcAgeMillis
        proc.end()
      }
      if (proc.closed) {
        this._procs.splice(i, 1)
      }
    }
    return this._procs
  }

  private log(obj: any): void {
    debuglog("batch-cluster")(inspect(
      { time: new Date().toISOString(), ...obj, from: "BatchCluster." + obj.from },
      { colors: true, breakLength: 80 } as InspectOptions
    ))
  }

  private onIdle(): void {
    this.log({ from: "onIdle()", pendingTasks: this._pendingTasks.length, idleProcs: this._procs.filter(p => p.idle).length })

    if (this._ended) {
      // TODO: the clearInterval is right after setting _ended, so why does it
      // sometimes slip through?
      return
    }

    if (this._pendingTasks.length > 0) {
      const idleProc = this.procs().find(p => p.idle)
      if (idleProc) {
        const task = this.dequeueTask()
        if (task && !idleProc.execTask(task)) {
          // re-enqueue, task wasn't exec'ed.
          this.enqueueTask(task)
        }
      } else if (this.procs().length < this.opts.maxProcs) {
        this._procs.push(new BatchProcess(this.opts.processFactory(), this.opts, this.observer))
        // this new proc will send an onIdle() when it's ready.
      }
    }
  }
}
