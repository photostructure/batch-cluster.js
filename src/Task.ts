import { delay } from "./Async"
import { Deferred } from "./Deferred"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { Parser } from "./Parser"

type TaskOptions = Pick<
  InternalBatchProcessOptions,
  "streamFlushMillis" | "observer" | "passRE" | "failRE" | "logger"
>

let _taskId = 1

/**
 * Tasks embody individual jobs given to the underlying child processes. Each
 * instance has a promise that will be resolved or rejected based on the
 * result of the task.
 */
export class Task<T = any> {
  readonly taskId = _taskId++
  private opts?: TaskOptions
  private startedAt?: number
  private settledAt?: number
  private _passed?: boolean
  private _pending = true
  private readonly d = new Deferred<T>()
  private _stdout = ""
  private _stderr = ""

  /**
   * @param {string} command is the value written to stdin to perform the given
   * task.
   * @param {Parser<T>} parser is used to parse resulting data from the
   * underlying process to a typed object.
   */
  constructor(readonly command: string, readonly parser: Parser<T>) {
    this.d.promise.then(
      () => this.onSettle(),
      () => this.onSettle()
    )
  }

  private onSettle() {
    this._pending = false
    this.settledAt ??= Date.now()
  }

  /**
   * @return the resolution or rejection of this task.
   */
  get promise(): Promise<T> {
    return this.d.promise
  }

  get pending(): boolean {
    return this.d.pending
  }

  get state(): string {
    return this.d.pending
      ? "pending"
      : this.d.fulfilled
      ? "resolved"
      : "rejected"
  }

  onStart(opts: TaskOptions) {
    this.opts = opts
    this.startedAt = Date.now()
  }

  get runtimeMs() {
    return this.startedAt == null
      ? undefined
      : (this.settledAt ?? Date.now()) - this.startedAt
  }

  toString(): string {
    return (
      this.constructor.name +
      "(" +
      this.command.replace(/\s+/gm, " ").slice(0, 80).trim() +
      ")#" +
      this.taskId
    )
  }

  // private trace({
  //   meth,
  //   desc,
  //   meta,
  // }: {
  //   meth: string
  //   desc?: string
  //   meta?: any
  // }) {
  //   this.opts
  //     ?.logger()
  //     .trace("Task#" + this.taskId + "." + meth + "() " + toS(desc), meta)
  // }

  onStdout(buf: string | Buffer): void {
    // this.trace({ meth: "onStdout", meta: { buf: buf.toString() } })
    this._stdout += buf.toString()
    const m = this.opts?.passRE.exec(this._stdout)
    if (null != m) {
      // this.trace({ meth: "onStdout", desc: "found pass!", meta: { m } })
      // remove the pass token from stdout:
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._stdout = this._stdout.replace(this.opts!.passRE, "")
      this.resolve(true)
    } else {
      const m2 = this.opts?.failRE.exec(this._stdout)
      if (null != m2) {
        // this.trace({ meth: "onStdout", desc: "found fail!", meta: { m2 } })
        // remove the fail token from stdout:
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._stdout = this._stdout.replace(this.opts!.failRE, "")
        this.resolve(false)
      }
    }
  }

  onStderr(buf: string | Buffer): void {
    // this.trace({ meth: "onStderr", meta: { buf: buf.toString() } })
    this._stderr += buf.toString()
    const m = this.opts?.failRE.exec(this._stderr)
    if (null != m) {
      // this.trace({ meth: "onStderr", desc: "found fail!", meta: { m } })
      // remove the fail token from stderr:
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._stderr = this._stderr.replace(this.opts!.failRE, "")
      this.resolve(false)
    }
  }

  private async resolve(passed: boolean) {
    // fail always wins.
    this._passed = (this._passed ?? true) && passed

    // this.trace({
    //   meth: "resolve",
    //   meta: { passed, this_passed: this._passed },
    // })

    // wait for stderr and stdout to flush:
    await delay(this.opts?.streamFlushMillis ?? 10, true)

    // we're expecting this method may be called concurrently (if there are both
    // pass and fail tokens found in stderr and stdout), but we only want to run
    // this once, so
    if (!this.d.pending || !this._pending) return

    this._pending = false

    try {
      const parseResult = await this.parser(
        this._stdout,
        this._stderr,
        this._passed
      )
      if (this.d.resolve(parseResult)) {
      } else {
        this.opts?.observer.onInternalError(
          new Error(this.toString() + " ._resolved() more than once")
        )
      }
    } catch (error: any) {
      this.reject(error)
    }
  }

  reject(error: Error): void {
    if (this.d.reject(error)) {
    }
  }
}
