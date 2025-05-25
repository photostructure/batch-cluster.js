import { filterInPlace } from "./Array"
import { Deferred } from "./Deferred"

/**
 * Aggregate promises efficiently
 */
export class Mutex {
  private _pushCount = 0
  private readonly _arr: Deferred<unknown>[] = []

  private get arr() {
    filterInPlace(this._arr, (ea) => ea.pending)
    return this._arr
  }

  get pushCount(): number {
    return this._pushCount
  }

  push<T>(f: () => Promise<T>): Promise<T> {
    this._pushCount++
    const p = f()
    // Don't cause awaitAll to die if a task rejects:
    this.arr.push(new Deferred().observeQuietly(p))
    return p
  }

  /**
   * Run f() after all prior-enqueued promises have resolved.
   */
  serial<T>(f: () => Promise<T>): Promise<T> {
    return this.push(() => this.awaitAll().then(() => f()))
  }

  /**
   * Only run f() if all prior have finished, otherwise, no-op and wait until
   * all pending have resolved.
   */
  runIfIdle<T>(f: () => Promise<T>): undefined | Promise<T> {
    return this.pending ? undefined : this.serial(f)
  }

  get pendingCount(): number {
    // Don't need vacuuming, so we can use this._arr:
    return this._arr.reduce((sum, ea) => sum + (ea.pending ? 1 : 0), 0)
  }

  get pending(): boolean {
    return this.pendingCount > 0
  }

  get settled(): boolean {
    // this.arr is a getter that does vacuuming
    return this.arr.length === 0
  }

  /**
   * @return a promise that will be resolved when all previously-pushed Promises
   * are resolved. Any promise rejection will throw the whole chain.
   */
  awaitAll(): Promise<undefined> {
    return this.arr.length === 0
      ? Promise.resolve(undefined)
      : Promise.all(this.arr.map((ea) => ea.promise)).then(() => undefined)
  }
}
