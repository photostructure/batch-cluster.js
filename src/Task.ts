import { Deferred } from "./Deferred"
import { logger } from "./Logger"

/**
 * Parser implementations convert stdout from the underlying child process to
 * a more useable format. This can be a no-op passthrough if no parsing is
 * necessary.
 */
export type Parser<T> = (data: string) => T

/**
 * Tasks embody individual jobs given to the underlying child processes. Each
 * instance has a promise that will be resolved or rejected based on the
 * result of the task.
 */
export class Task<T> {
  retries = 0
  private readonly d = new Deferred<T>()
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

  toString() {
    return this.constructor.name + "(" + this.command + ")"
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process is complete for this task's command
   */
  onData(data: string): void {
    try {
      const result = this.parser(data)
      logger().trace("Task.onData(): resolved", {
        command: this.command,
        result
      })
      this.d.resolve(result)
    } catch (error) {
      logger().warn("Task.onData(): rejected", { command: this.command, error })
      this.d.reject(error)
    }
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process has errored after N retries
   */
  onError(error: any): void {
    logger().warn("Task.onError(): rejected", { command: this.command, error })
    this.d.reject(error)
  }
}
