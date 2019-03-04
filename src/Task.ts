import { Deferred } from "./Deferred"
import { logger } from "./Logger"
import { Parser } from "./Parser"

/**
 * Tasks embody individual jobs given to the underlying child processes. Each
 * instance has a promise that will be resolved or rejected based on the
 * result of the task.
 */
export class Task<T> {
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

  toString() {
    return this.constructor.name + "(" + this.command + ")"
  }

  onStdout(buf: string | Buffer) {
    this._stdout += buf.toString()
  }

  onStderr(buf: string | Buffer) {
    this._stderr += buf.toString()
  }

  get stdout() {
    return this._stdout
  }

  get stderr() {
    return this._stderr
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process is complete for this task's command
   */
  async resolve(stdout: string, stderr: string, passed: boolean) {
    try {
      const parseResult = await this.parser(stdout, stderr, passed)
      logger().trace("Task.onData(): resolved", {
        command: this.command,
        parseResult
      })
      this.d.resolve(parseResult)
    } catch (error) {
      this.reject(error, "Task.onData(): rejected")
    }
    return
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process has errored after N retries
   */
  reject(error: Error, source = "Task.reject()"): void {
    logger().warn(source, {
      cmd: this.command,
      error
    })
    this.d.reject(error)
  }
}
