export class Rate {
  private readonly _start = Date.now()
  private _events = 0

  constructor(readonly warmupMillis: number = 1000) {}

  onEvent() {
    this._events++
  }

  get durationMilliseconds(): number {
    return Date.now() - this._start
  }

  get events(): number {
    return this._events
  }

  /**
   * @return `(events / ageInMillis)`
   */
  get eventsPerMillisecond(): number {
    return this.squelched(this._events / this.durationMilliseconds)
  }

  get eventsPerSecond(): number {
    return this.squelched(this.eventsPerMillisecond * 1000)
  }

  get eventsPerMinute(): number {
    return this.squelched(this.eventsPerSecond * 60)
  }

  private squelched(value: number): number {
    return (this.durationMilliseconds >= this.warmupMillis) ? value : 0
  }
}
