import { logger } from "./Logger"

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
 */
enum State {
  pending,
  fulfilled,
  rejected
}

/**
 * Enables a Promise to be resolved or rejected at a future time, outside of
 * the context of the Promise construction. Also exposes the `pending`,
 * `fulfilled`, or `rejected` state of the promise.
 */
export class Deferred<T> {
  readonly promise: Promise<T>
  // prettier-ignore
  private _resolve!: (value?: T) => void
  // prettier-ignore
  private _reject!: (reason?: any) => void
  private state: State = State.pending

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
  }

  /**
   * @return `true` iff `resolve` has been invoked.
   */
  get pending(): boolean {
    return this.state === State.pending
  }

  /**
   * @return `true` iff `resolve` has been invoked.
   */
  get fulfilled(): boolean {
    return this.state === State.fulfilled
  }

  /**
   * @return `true` iff `resolve` has been invoked.
   */
  get rejected(): boolean {
    return this.state === State.rejected
  }

  resolve(value?: T): boolean {
    if (!this.pending) {
      logger().warn("Deferred: resolve when not pending", value)
      return false
    } else {
      this.state = State.fulfilled
      this._resolve(value)
      return true
    }
  }

  reject(reason?: any): boolean {
    if (!this.pending) {
      logger().warn("Deferred: reject when not pending", reason)
      return false
    } else {
      this.state = State.rejected
      this._reject(reason)
      return true
    }
  }
}
