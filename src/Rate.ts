export class Rate {
  private _eventCount = 0
  private readonly start = Date.now()
  private readonly store: number[] = []

  constructor(readonly ttlMs: number = 60000) {}

  onEvent(): void {
    this._eventCount++
    this.store.push(Date.now())
    this.vacuum()
  }

  get eventCount(): number {
    return this._eventCount
  }

  get period(): number {
    return Date.now() - this.start
  }

  get eventsPerMs(): number {
    this.vacuum()
    const elapsed = Math.max(1, Date.now() - this.start)
    if (elapsed > this.ttlMs) {
      return this.store.length / this.ttlMs
    } else {
      return this.store.length / elapsed
    }
  }

  get eventsPerSecond(): number {
    return this.eventsPerMs * 1000
  }

  get eventsPerMinute(): number {
    return this.eventsPerSecond * 60
  }

  clear(): this {
    this.store.length = 0
    return this
  }

  private vacuum() {
    const minTime = Date.now() - this.ttlMs
    // If nothing's expired, findIndex should return index 0, so this should
    // normally be quite cheap:
    const firstGoodIndex = this.store.findIndex((ea) => ea > minTime)
    if (firstGoodIndex === -1) {
      this.clear()
    } else if (firstGoodIndex > 0) {
      this.store.splice(0, firstGoodIndex)
    }
  }
}
