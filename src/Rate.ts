export class Rate {
  private readonly _start = Date.now()
  /** current rate */
  private _eventsPerMillisecond: number = 0
  /** prior millis */
  private t: number
  /** events per timeslice */
  private e: number
  /** total events */
  private _events = 0

  constructor(readonly warmupMillis: number = 1000) {}

  onEvent() {
    this._events++
    const now = Date.now()
    if (this.t === now) {
      this.e++
    } else {
      if (this.t != null) {
        const millis = now - this.t
        this._eventsPerMillisecond = ((this.e / millis) + this._eventsPerMillisecond) / 2
      }
      this.t = now
      this.e = 1
    }
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

  /**
   * @return an age-penalized rate
   */
  get weightedEventsPerMillisecond(): number {
    return this.squelched(this._eventsPerMillisecond)
  }

  get eventsPerSecond(): number {
    return this.squelched(this.eventsPerMillisecond * 1000)
  }

  get eventsPerMinute(): number {
    return this.squelched(this.eventsPerSecond * 60)
  }

  private squelched(value: number): number {
    return (this.durationMilliseconds > this.warmupMillis) ? value : 0
  }
}
