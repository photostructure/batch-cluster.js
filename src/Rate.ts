export class Rate {
  private _events: number = 0
  private start = Date.now()
  private e = new Map<number, number>()

  constructor(
    readonly windowMillis: number = 250,
    readonly windows: number = 5
  ) {}

  onEvent() {
    this._events++
    const t = this.asKey(Date.now())
    this.e.set(t, (this.e.get(t) || 0) + 1)
    this.vacuum()
  }

  get events(): number {
    return this._events
  }

  get period(): number {
    return Date.now() - this.start
  }

  get eventsPerMillisecond(): number {
    let mean: number | undefined
    const now = Date.now()
    const key = this.asKey(now - this.windows * this.windowMillis)
    // ignore the most recent window, which represents less than windowMillis
    for (let window = 0; window < this.windows; window++) {
      const events = this.e.get(key + window) || 0
      const epms = events / this.windowMillis
      mean = mean == null ? epms : (mean + epms) / 2
    }
    return mean || 0
  }

  get eventsPerSecond(): number {
    return this.eventsPerMillisecond * 1000
  }

  get eventsPerMinute(): number {
    return this.eventsPerSecond * 60
  }

  private asKey(time: number): number {
    return Math.floor(time / this.windowMillis)
  }

  private vacuum() {
    const least = this.asKey(Date.now() - this.windowMillis * this.windows)
    this.e.forEach((_, k) => {
      if (k < least) {
        this.e.delete(k)
      }
    })
  }
}
