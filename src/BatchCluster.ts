import { BatchProcess, BatchProcessObserver, InternalBatchProcessOptions } from "./BatchProcess"
import { delay } from "./Delay"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import * as _p from "process"
import { debuglog, inspect } from "util"

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
   * Expected text to print if a command passes.
   */
  readonly pass: string

  /**
   * Expected text to print if a command fails.
   */
  readonly fail: string

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

function toRe(s: string): RegExp {
  return new RegExp("^([\\s\\S]*?)[\\n\\r]+" + s + "[\\n\\r]*$")
}

/**
 * These parameter values have somewhat sensible defaults, but can be overridden
 * for a given BatchCluster.
 */
export class BatchClusterOptions {
  readonly maxProcs: number = 1
  readonly maxProcAgeMillis: number = 5 * 60 * 1000 // 5 minutes
  readonly onIdleIntervalMillis: number = 2000
  readonly endGracefulWaitTimeMillis: number = 500
}

export class BatchCluster {
  private readonly opts: BatchClusterOptions & InternalBatchProcessOptions & ChildProcessFactory
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private readonly _pendingTasks: Task<any>[] = []
  private readonly beforeExitListener = this.end.bind(this)

  constructor(opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory) {
    this.opts = { ... new BatchClusterOptions(), ...opts, passRE: toRe(opts.pass), failRE: toRe(opts.fail) }
    if (this.opts.onIdleIntervalMillis > 0) {
      setInterval(() => this.onIdle(), this.opts.onIdleIntervalMillis).unref()
    }
    this.observer = {
      onIdle: this.onIdle.bind(this),
      enqueueTask: this.enqueueTask.bind(this)
    }
    _p.on("beforeExit", this.beforeExitListener)
  }

  async end(): Promise<void> {
    _p.removeListener("beforeExit", this.beforeExitListener)
    this._procs.forEach(p => p.end())
    const busyProcs = this._procs.filter(p => p.busy)
    if (busyProcs.length > 0) {
      await Promise.race([
        delay(this.opts.endGracefulWaitTimeMillis),
        Promise.all(busyProcs.map(p => p.closedPromise))
      ])
    } else {
      // We don't need to wait for the procs to close gracefully if all the procs are idle
    }
    this._procs.forEach(p => p.kill())
    return
  }

  enqueueTask<T>(task: Task<T>, append: boolean = true): Promise<T> {
    append ? this._pendingTasks.push(task) : this._pendingTasks.unshift(task)
    this.onIdle()
    return task.promise
  }

  /**
   * Useful for integration tests, but most likely not generally interesting.
   */
  get pids(): number[] {
    return this.procs().map(p => p.pid)
  }

  private dequeueTask(): Task<any> | undefined {
    return this._pendingTasks.shift()
  }

  private procs(): BatchProcess[] {
    const minStart = Date.now() - this.opts.maxProcAgeMillis
    for (let i = this._procs.length - 1; i >= 0; i--) {
      const proc = this._procs[i]
      if (proc.start < minStart) {
        proc.end()
      }
      if (proc.ended) {
        this._procs.splice(i, 1)
      }
    }
    return this._procs
  }

  private log(obj: any): void {
    debuglog("batch-cluster")(inspect({ time: new Date().toISOString(), ...obj }, { colors: true }))
  }

  private onIdle(): void {
    this.log({ from: "onIdle()", pendingTasks: this._pendingTasks.length, idleProcs: this._procs.filter(p => p.idle).length })

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
