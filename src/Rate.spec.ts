import { minuteMs } from "./BatchClusterOptions"
import { Rate } from "./Rate"
import { expect, times } from "./_chai.spec"

const tk = require("timekeeper")

describe("Rate", () => {
  const now = Date.now()
  const r = new Rate()

  beforeEach(() => {
    tk.freeze(now)
    // clear() must be called _after_ freezing time
    r.clear()
  })

  after(() => tk.reset())

  function expectRate(rate: Rate, epm: number, tol = 0.1) {
    expect(rate.eventsPerMs).to.be.withinToleranceOf(epm, tol)
    expect(rate.eventsPerSecond).to.be.withinToleranceOf(epm * 1000, tol)
    expect(rate.eventsPerMinute).to.be.withinToleranceOf(epm * 60 * 1000, tol)
  }

  it("is born with a rate of 0", () => {
    expectRate(r, 0)
  })

  it("maintains a rate of 0 after time with no events", () => {
    tk.freeze(now + minuteMs)
    expectRate(r, 0)
  })

  for (const cnt of [1, 2, 3, 4]) {
    it(
      "decays the rate from " + cnt + " simultaneous event(s) as time elapses",
      () => {
        times(cnt, () => r.onEvent())
        expectRate(r, 0)
        tk.freeze(now + 100)
        expectRate(r, 0)
        tk.freeze(now + r.warmupMs + 1)
        expectRate(r, cnt / r.warmupMs)
        tk.freeze(now + 2 * r.warmupMs)
        expectRate(r, cnt / (2 * r.warmupMs))
        tk.freeze(now + 3 * r.warmupMs)
        expectRate(r, cnt / (3 * r.warmupMs))
        tk.freeze(now + r.periodMs)
        expectRate(r, 0)
        expect(r.msSinceLastEvent).to.eql(minuteMs)
      },
    )
  }

  for (const events of [5, 10, 100, 1000]) {
    it(
      "calculates average rate for " + events + " events, and then decays",
      () => {
        const period = r.periodMs
        times(events, (i) => {
          tk.freeze(now + (period * i) / events)
          r.onEvent()
        })
        expectRate(r, events / period, 0.3)
        tk.freeze(now + 1.25 * r.periodMs)
        expectRate(r, 0.75 * (events / period), 0.3)
        tk.freeze(now + 1.5 * r.periodMs)
        expectRate(r, 0.5 * (events / period), 0.3)
        tk.freeze(now + 1.75 * r.periodMs)
        expectRate(r, 0.25 * (events / period), 0.3)
        tk.freeze(now + 2 * r.periodMs)
        expectRate(r, 0)
      },
    )
  }
})
