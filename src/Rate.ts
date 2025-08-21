import { minuteMs, secondMs } from "./BatchClusterOptions";

// Implementation notes:

// The prior implementation relied on a weighted average of milliseconds between
// events, which didn't behave well when a series of events happend in the same
// millisecond, and didn't correctly recover if events ceased completely (which
// would be expected if this was an error or timeout rate).

// Keeping each event time in an array makes these calculations more precise,
// but suffers from more memory consumption when measuring high rates and using
// a large periodMs.

export class Rate {
  #start = Date.now();
  readonly #priorEventTimestamps: number[] = [];
  #lastEventTs: number | null = null;
  #eventCount = 0;

  /**
   * @param periodMs the length of time to retain event timestamps for computing
   * rate. Events older than this value will be discarded.
   * @param warmupMs return `null` from {@link Rate#msPerEvent} if it's been less
   * than `warmupMs` since construction or {@link Rate#clear}.
   */
  constructor(
    readonly periodMs = minuteMs,
    readonly warmupMs = secondMs,
  ) {}

  onEvent(): void {
    this.#eventCount++;
    const now = Date.now();
    this.#priorEventTimestamps.push(now);
    this.#lastEventTs = now;
  }

  #vacuum() {
    const expired = Date.now() - this.periodMs;
    const firstValidIndex = this.#priorEventTimestamps.findIndex(
      (ea) => ea > expired,
    );
    if (firstValidIndex === -1) this.#priorEventTimestamps.length = 0;
    else if (firstValidIndex > 0) {
      this.#priorEventTimestamps.splice(0, firstValidIndex);
    }
  }

  get eventCount(): number {
    return this.#eventCount;
  }

  get msSinceLastEvent(): number | null {
    return this.#lastEventTs == null ? null : Date.now() - this.#lastEventTs;
  }

  get msPerEvent(): number | null {
    const msSinceStart = Date.now() - this.#start;
    if (this.#lastEventTs == null || msSinceStart < this.warmupMs) return null;
    this.#vacuum();
    const events = this.#priorEventTimestamps.length;
    return events === 0 ? null : Math.min(this.periodMs, msSinceStart) / events;
  }

  get eventsPerMs(): number {
    const mpe = this.msPerEvent;
    return mpe == null ? 0 : mpe < 1 ? 1 : 1 / mpe;
  }

  get eventsPerSecond(): number {
    return this.eventsPerMs * secondMs;
  }

  get eventsPerMinute(): number {
    return this.eventsPerMs * minuteMs;
  }

  clear(): this {
    this.#start = Date.now();
    this.#priorEventTimestamps.length = 0;
    this.#lastEventTs = null;
    this.#eventCount = 0;
    return this;
  }
}
