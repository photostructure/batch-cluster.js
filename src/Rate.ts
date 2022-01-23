export class Rate {
  readonly #start = Date.now()
  readonly #store: number[] = []
  #eventCount = 0

  constructor(readonly ttlMs: number = 60000) {}

  onEvent(): void {
    this.#eventCount++
    this.#store.push(Date.now())
    this.#vacuum()
  }

  get eventCount(): number {
    return this.#eventCount
  }

  get period(): number {
    return Date.now() - this.#start
  }

  get eventsPerMs(): number {
    this.#vacuum()
    const elapsedMs = Date.now() - this.#start
    if (elapsedMs > this.ttlMs) {
      return this.#store.length / this.ttlMs
    } else {
      return this.#store.length / Math.max(1, elapsedMs)
    }
  }

  get eventsPerSecond(): number {
    return this.eventsPerMs * 1000
  }

  get eventsPerMinute(): number {
    return this.eventsPerSecond * 60
  }

  clear(): this {
    this.#store.length = 0
    return this
  }

  #vacuum() {
    const minTime = Date.now() - this.ttlMs
    // If nothing's expired, findIndex should return index 0, so this should
    // normally be quite cheap:
    const firstGoodIndex = this.#store.findIndex((ea) => ea > minTime)
    if (firstGoodIndex === -1) {
      this.clear()
    } else if (firstGoodIndex > 0) {
      this.#store.splice(0, firstGoodIndex)
    }
  }
}
