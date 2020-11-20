/**
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise
 */
enum State {
  pending,
  fulfilled,
  rejected,
}

/**
 * Enables a Promise to be resolved or rejected at a future time, outside of
 * the context of the Promise construction. Also exposes the `pending`,
 * `fulfilled`, or `rejected` state of the promise.
 */
export class Deferred<T> implements PromiseLike<T> {
  readonly promise: Promise<T>
  private _resolve!: (value: T | PromiseLike<T>) => void
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

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | undefined
      | null,
    onrejected?:
      | ((reason: any) => TResult2 | PromiseLike<TResult2>)
      | undefined
      | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  resolve(value: T): boolean {
    if (!this.pending) {
      return false
    } else {
      this.state = State.fulfilled
      this._resolve(value)
      return true
    }
  }

  reject(reason?: Error | string): boolean {
    if (!this.pending) {
      return false
    } else {
      this.state = State.rejected
      this._reject(reason)
      return true
    }
  }

  observe(p: Promise<T>): this {
    p.then((resolution) => {
      this.resolve(resolution)
    }).catch((err) => {
      this.reject(err)
    })
    return this
  }

  observeQuietly(p: Promise<T>): Deferred<T | undefined> {
    p.then((ea) => this.resolve(ea)).catch(() => this.resolve(undefined as any))
    return this as any
  }
}
