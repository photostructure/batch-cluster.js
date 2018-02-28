import { Deferred } from "./Deferred"
import { logger } from "./Logger"

export type Parser<T> = (data: string) => T

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
      logger().debug("Task.onData(): resolved", { result, command: this.command, data })
      this.d.resolve(result)
    } catch (error) {
      logger().warn("Task.onData(): parser raised " + error, { command: this.command, data })
      this.d.reject(error)
    }
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process has errored after N retries
   */
  onError(error: any): void {
    logger().warn("Task.onError(): Failed to run " + this.command, error)
    this.d.reject(error)
  }
}
