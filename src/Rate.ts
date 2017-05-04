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

  get eventsPerMillisecond(): number {
    return this._eventsPerMillisecond
  }

  get eventsPerSecond(): number {
    return this.eventsPerMillisecond * 1000
  }

  get eventsPerMinute(): number {
    return this.eventsPerSecond * 60
  }
}
