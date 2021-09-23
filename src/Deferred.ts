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
  readonly [Symbol.toStringTag] = "Deferred"
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

  get settled(): boolean {
    return this.fulfilled || this.rejected
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
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: any) => TResult | PromiseLike<TResult>)
      | undefined
      | null
  ): Promise<T | TResult> {
    return this.promise.catch(onrejected)
  }

  resolve(value: T): boolean {
    if (this.settled) {
      return false
    } else {
      this.state = State.fulfilled
      this._resolve(value)
      return true
    }
  }

  reject(reason?: Error | string): boolean {
    if (this.settled) {
      return false
    } else {
      this.state = State.rejected
      this._reject(reason)
      return true
    }
  }

  observe(p: Promise<T>): this {
    void observe(this, p)
    return this
  }

  observeQuietly(p: Promise<T>): Deferred<T | undefined> {
    void observeQuietly(this, p)
    return this as any
  }
}

async function observe<T>(d: Deferred<T>, p: Promise<T>) {
  try {
    d.resolve(await p)
  } catch (err: any) {
    d.reject(err)
  }
}

async function observeQuietly<T>(d: Deferred<T>, p: Promise<T>) {
  try {
    d.resolve(await p)
  } catch {
    d.resolve(undefined as any)
  }
}
