import { minuteMs, secondMs } from "./BatchClusterOptions";

/**
 * Measures event rate using a two-bucket sliding window approximation.
 *
 * Instead of storing every timestamp (O(n) memory), this uses two counters:
 * - currentCount: events in the current period
 * - prevCount: events in the previous period
 *
 * An interval rotates buckets every periodMs. The sliding window is
 * approximated by interpolating between buckets based on how much of
 * the window overlaps with each.
 *
 * The warmup period prevents spurious high rates from small samples.
 * During warmup, all rate getters return 0.
 */
export class Rate {
  #start = Date.now();
  #periodStart = Date.now();
  #currentCount = 0;
  #prevCount = 0;
  #eventCount = 0;
  #lastEventTs: number | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param periodMs the length of the sliding window for rate computation.
   * @param warmupMs return 0 from rate getters if less than `warmupMs` has
   * elapsed since construction or {@link Rate#clear}. This prevents unstable
   * rates from small sample sizes.
   */
  constructor(
    readonly periodMs = minuteMs,
    readonly warmupMs = secondMs,
  ) {
    this.#startTimer();
  }

  #startTimer(): void {
    this.#stopTimer();
    this.#timer = setInterval(() => this.#rotate(), this.periodMs);
    this.#timer.unref();
  }

  #stopTimer(): void {
    if (this.#timer != null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #rotate(): void {
    this.#prevCount = this.#currentCount;
    this.#currentCount = 0;
    this.#periodStart = Date.now();
  }

  onEvent(): void {
    this.#eventCount++;
    this.#currentCount++;
    this.#lastEventTs = Date.now();
  }

  get eventCount(): number {
    return this.#eventCount;
  }

  get msSinceLastEvent(): number | null {
    return this.#lastEventTs == null ? null : Date.now() - this.#lastEventTs;
  }

  /**
   * Whether enough time has passed and events have occurred to compute a rate.
   */
  #canComputeRate(): boolean {
    return (
      this.#lastEventTs != null && Date.now() - this.#start >= this.warmupMs
    );
  }

  /**
   * The effective time window for rate calculation, capped at periodMs.
   */
  #effectivePeriodMs(): number {
    return Math.min(this.periodMs, Date.now() - this.#start);
  }

  /**
   * Approximate events in the sliding window using two-bucket interpolation.
   *
   * The sliding window overlaps with:
   * - (periodMs - elapsed) ms of the previous period
   * - elapsed ms of the current period
   *
   * We weight prevCount by what fraction of the previous period is still
   * within our window.
   */
  #eventsInWindow(): number {
    const elapsed = Date.now() - this.#periodStart;
    const overlapWithPrev =
      Math.max(0, this.periodMs - elapsed) / this.periodMs;
    return this.#prevCount * overlapWithPrev + this.#currentCount;
  }

  get eventsPerMs(): number {
    if (!this.#canComputeRate()) return 0;
    const events = this.#eventsInWindow();
    return events === 0 ? 0 : events / this.#effectivePeriodMs();
  }

  get eventsPerSecond(): number {
    return this.eventsPerMs * secondMs;
  }

  get eventsPerMinute(): number {
    return this.eventsPerMs * minuteMs;
  }

  clear(): this {
    this.#start = Date.now();
    this.#periodStart = Date.now();
    this.#currentCount = 0;
    this.#prevCount = 0;
    this.#lastEventTs = null;
    this.#eventCount = 0;
    this.#startTimer(); // Restart timer aligned with new periodStart
    return this;
  }

  /**
   * Implements the Disposable interface for use with `using` declarations.
   * @example
   * ```typescript
   * using rate = new Rate();
   * rate.onEvent();
   * // timer automatically stopped when rate goes out of scope
   * ```
   */
  [Symbol.dispose](): void {
    this.#stopTimer();
  }
}
