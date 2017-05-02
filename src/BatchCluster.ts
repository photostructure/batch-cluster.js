import { BatchProcess, BatchProcessObserver, BatchProcessOptions, verifyOpts } from "./BatchProcess"
import { delay } from "./Delay"
import { Task } from "./Task"
import { ChildProcess } from "child_process"
import * as _p from "process"

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

export { BatchProcessOptions } from "./BatchProcess"
export { Deferred } from "./Deferred"
export { Task, Parser } from "./Task"
export { delay } from "./Delay"

/**
 * These parameter values have somewhat sensible defaults, and can be overridden
 * for a given BatchCluster.
 */
export class BatchClusterOptions {
  readonly maxProcs: number = 1
  readonly onIdleIntervalMillis: number = 2000
  readonly endGracefulWaitTimeMillis: number = 500
}

export class BatchCluster {
  private readonly opts: BatchClusterOptions & BatchProcessOptions & ChildProcessFactory
  private readonly observer: BatchProcessObserver
  private readonly _procs: BatchProcess[] = []
  private readonly _pendingTasks: Task<any>[] = []

  constructor(opts: Partial<BatchClusterOptions> & BatchProcessOptions & ChildProcessFactory) {
    this.opts = { ... new BatchClusterOptions(), ...opts, ...verifyOpts(opts) }
    if (this.opts.onIdleIntervalMillis > 0) {
      setInterval(() => this.onIdle(), this.opts.onIdleIntervalMillis).unref()
    }
    this.observer = {
      onIdle: this.onIdle.bind(this),
      enqueueTask: this.enqueueTask.bind(this)
    }
    _p.on("beforeExit", () => this.end())
  }

  async end(): Promise<void> {
    this._procs.forEach(p => p.end(this.opts.exitCommand))
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
    for (let i = this._procs.length - 1; i >= 0; i--) {
      if (this._procs[i].ended) {
        this._procs.splice(i, 1)
      }
    }
    return this._procs
  }

  private onIdle(): void {
    if (this._pendingTasks.length > 0) {
      const idleProc = this._procs.find(p => p.idle)
      if (idleProc) {
        idleProc.execTask(this.dequeueTask()!)
      } else if (this.procs().length < this.opts.maxProcs) {
        this._procs.push(new BatchProcess(this.opts.processFactory(), this.opts, this.observer))
        // this new proc will send an onIdle() when it's ready.
      }
    }
  }
}
