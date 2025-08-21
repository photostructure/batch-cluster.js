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
  readonly [Symbol.toStringTag] = "Deferred";
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;
  #state: State = State.pending;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /**
   * @return `true` iff neither `resolve` nor `rejected` have been invoked
   */
  get pending(): boolean {
    return this.#state === State.pending;
  }

  /**
   * @return `true` iff `resolve` has been invoked
   */
  get fulfilled(): boolean {
    return this.#state === State.fulfilled;
  }

  /**
   * @return `true` iff `rejected` has been invoked
   */
  get rejected(): boolean {
    return this.#state === State.rejected;
  }

  /**
   * @return `true` iff `resolve` or `rejected` have been invoked
   */
  get settled(): boolean {
    return this.#state !== State.pending;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.promise.catch(onrejected);
  }

  resolve(value: T): boolean {
    if (this.settled) {
      return false;
    } else {
      this.#state = State.fulfilled;
      this.#resolve(value);
      return true;
    }
  }

  reject(reason?: Error | string): boolean {
    const wasSettled = this.settled;
    // This isn't great: the wrapped Promise may be in a different state than
    // #state: but the caller wanted to reject, so even if it already was
    // resolved, let's try to respect that.
    this.#state = State.rejected;
    if (wasSettled) {
      return false;
    } else {
      this.#reject(reason);
      return true;
    }
  }

  observe(p: Promise<T>): this {
    void observe(this, p);
    return this;
  }

  observeQuietly(p: Promise<T>): Deferred<T | undefined> {
    void observeQuietly(this, p);
    return this as Deferred<T | undefined>;
  }
}

async function observe<T>(d: Deferred<T>, p: Promise<T>) {
  try {
    d.resolve(await p);
  } catch (err: unknown) {
    d.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

async function observeQuietly<T>(d: Deferred<T>, p: Promise<T>) {
  try {
    d.resolve(await p);
  } catch {
    d.resolve(undefined as T);
  }
}
