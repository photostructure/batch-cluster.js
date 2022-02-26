import { minuteMs, secondMs } from "./BatchClusterOptions"

export class Rate {
  #lastEventTs: number | null = null
  #weightedTotalAvg: number | null = null
  #eventCount = 0

  onEvent(): void {
    this.#eventCount++
    const priorEventTs = this.#lastEventTs
    const now = Date.now()
    this.#lastEventTs = now

    if (priorEventTs != null) {
      const diff = Math.max(now - priorEventTs, 1)
      this.#weightedTotalAvg =
        this.#weightedTotalAvg == null
          ? diff
          : Math.round((this.#weightedTotalAvg + diff) / 2)
    }
  }

  get eventCount(): number {
    return this.#eventCount
  }

  get msSinceLastEvent(): number | null {
    return this.#lastEventTs == null ? null : Date.now() - this.#lastEventTs
  }

  get msPerEvent(): number | null {
    if (this.#weightedTotalAvg == null || this.#lastEventTs == null) return null
    // If we haven't seen an event for a while, include that in the estimate:
    const lastDiff = Date.now() - this.#lastEventTs
    return lastDiff > this.#weightedTotalAvg
      ? (this.#weightedTotalAvg + lastDiff) / 2
      : this.#weightedTotalAvg
  }

  get eventsPerMs(): number {
    const mpe = this.msPerEvent
    return mpe == null ? 0 : mpe < 1 ? 1 : 1 / mpe
  }

  get eventsPerSecond(): number {
    return this.eventsPerMs * secondMs
  }

  get eventsPerMinute(): number {
    return this.eventsPerMs * minuteMs
  }

  clear(): this {
    this.#eventCount = 0
    this.#lastEventTs = null
    this.#weightedTotalAvg = null
    return this
  }
}
