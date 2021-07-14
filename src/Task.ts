import { Deferred } from "./Deferred"
import { Parser } from "./Parser"

let _taskId = 1
/**
 * Tasks embody individual jobs given to the underlying child processes. Each
 * instance has a promise that will be resolved or rejected based on the
 * result of the task.
 */
export class Task<T = any> {
  readonly taskId = _taskId++
  private startedAt?: number
  private settledAt?: number
  private readonly d = new Deferred<T>()
  private _stdout = ""
  private _stderr = ""

  /**
   * @param {string} command is the value written to stdin to perform the given
   * task.
   * @param {Parser<T>} parser is used to parse resulting data from the
   * underlying process to a typed object.
   */
  constructor(readonly command: string, readonly parser: Parser<T>) {}

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

  onStart() {
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

  onStdout(buf: string | Buffer): void {
    this._stdout += buf.toString()
  }

  onStderr(buf: string | Buffer): void {
    this._stderr += buf.toString()
  }

  get stdout(): string {
    return this._stdout
  }

  get stderr(): string {
    return this._stderr
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process is complete for this task's command.
   *
   * We don't use this.stdout or this.stderr because BatchProcess is in charge
   * of stream debouncing, and applying the passRE and failRE patterns to decide
   * if a task passed or failed.
   */
  async resolve(
    stdout: string,
    stderr: string,
    passed: boolean
  ): Promise<void> {
    if (this.d.fulfilled) return // no-op
    try {
      const parseResult = await this.parser(stdout, stderr, passed)
      if (this.d.resolve(parseResult)) {
        this.settledAt = Date.now()
      }
    } catch (error) {
      this.reject(error)
    }
    return
  }

  reject(error: Error): void {
    if (this.d.reject(error)) {
      this.settledAt = Date.now()
    }
  }
}
