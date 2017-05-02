import { Deferred } from "./Deferred"

export interface Parser<T> {
  /**
   * @throw "Error" on invalid input
   */
  (data: string): T
}

export class Task<T> {
  retriesRemaining: number | undefined
  private readonly d = new Deferred<T>()
  /**
   * @param {string} command is the value written to stdin to perform the given
   * task.
   * @param {Parser<T>} parser is used to parse resulting data from the
   * underlying process to a typed object.
   */
  constructor(
    readonly command: string,
    readonly parser: Parser<T>
  ) {
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

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process is complete for this task's command
   */
  onData(data: string): void {
    try {
      this.d.resolve(this.parser(data))
    } catch (error) {
      this.d.reject(error)
    }
  }

  /**
   * This is for use by `BatchProcess` only, and will only be called when the
   * process has errored after N retries
   */
  onError(error: any): void {
    this.d.reject(error)
  }
}
