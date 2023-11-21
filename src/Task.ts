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
  #opts?: TaskOptions
  #startedAt?: number
  #parsing = false
  #settledAt?: number
  readonly #d = new Deferred<T>()
  #stdout = ""
  #stderr = ""

  /**
   * @param {string} command is the value written to stdin to perform the given
   * task.
   * @param {Parser<T>} parser is used to parse resulting data from the
   * underlying process to a typed object.
   */
  constructor(
    readonly command: string,
    readonly parser: Parser<T>,
  ) {
    // We can't use .finally here, because that creates a promise chain that, if
    // rejected, results in an uncaught rejection.
    this.#d.promise.then(
      () => this.#onSettle(),
      () => this.#onSettle(),
    )
  }

  /**
   * @return the resolution or rejection of this task.
   */
  get promise(): Promise<T> {
    return this.#d.promise
  }

  get pending(): boolean {
    return this.#d.pending
  }

  get state(): string {
    return this.#d.pending
      ? "pending"
      : this.#d.rejected
        ? "rejected"
        : "resolved"
  }

  onStart(opts: TaskOptions) {
    this.#opts = opts
    this.#startedAt = Date.now()
  }

  get runtimeMs() {
    return this.#startedAt == null
      ? undefined
      : (this.#settledAt ?? Date.now()) - this.#startedAt
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

  onStdout(buf: string | Buffer): void {
    this.#stdout += buf.toString()
    const passRE = this.#opts?.passRE
    if (passRE != null && passRE.exec(this.#stdout) != null) {
      // remove the pass token from stdout:
      this.#stdout = this.#stdout.replace(passRE, "")
      this.#resolve(true)
    } else {
      const failRE = this.#opts?.failRE
      if (failRE != null && failRE.exec(this.#stdout) != null) {
        // remove the fail token from stdout:
        this.#stdout = this.#stdout.replace(failRE, "")
        this.#resolve(false)
      }
    }
  }

  onStderr(buf: string | Buffer): void {
    this.#stderr += buf.toString()
    const failRE = this.#opts?.failRE
    if (failRE != null && failRE.exec(this.#stderr) != null) {
      // remove the fail token from stderr:
      this.#stderr = this.#stderr.replace(failRE, "")
      this.#resolve(false)
    }
  }

  #onSettle() {
    this.#settledAt ??= Date.now()
  }

  /**
   * @return true if the wrapped promise was rejected
   */
  reject(error: Error): boolean {
    return this.#d.reject(error)
  }

  async #resolve(passed: boolean) {
    // fail always wins.
    passed = !this.#d.rejected && passed

    // wait for stderr and stdout to flush:
    const flushMs = this.#opts?.streamFlushMillis ?? 0
    if (flushMs > 0) {
      await delay(flushMs)
    }

    // we're expecting this method may be called concurrently (if there are both
    // pass and fail tokens found in stderr and stdout), but we only want to run
    // this once, so
    if (!this.pending || this.#parsing) return

    // this.#opts
    // ?.logger()
    // .trace("Task.#resolve()", { command: this.command, state: this.state })

    // Prevent concurrent parsing:
    this.#parsing = true

    try {
      const parseResult = await this.parser(this.#stdout, this.#stderr, passed)
      if (this.#d.resolve(parseResult)) {
      } else {
        this.#opts?.observer.emit(
          "internalError",
          new Error(this.toString() + " ._resolved() more than once"),
        )
      }
    } catch (error: any) {
      this.reject(error)
    }
  }
}
