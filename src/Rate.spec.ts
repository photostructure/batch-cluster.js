import { minuteMs, secondMs } from "./BatchClusterOptions"
import { Rate } from "./Rate"
import { expect, times } from "./_chai.spec"

const tk = require("timekeeper")

describe("Rate", () => {
  const now = Date.now()
  let r: Rate

  beforeEach(() => {
    tk.freeze(now)
    r = new Rate()
  })

  after(() => tk.reset())

  function expectRate(rate: Rate, epm: number, tol = 0.5) {
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

  it("maintains a rate of 0 after time with only 1 event", () => {
    expectRate(r, 0)
    r.onEvent()
    expectRate(r, 0)
    tk.freeze(now + minuteMs)
    expectRate(r, 0)
  })

  it("decays the rate as time elapses", () => {
    expectRate(r, 0)
    r.onEvent()
    expectRate(r, 0)
    tk.freeze(now + 10)
    r.onEvent()
    expectRate(r, 1 / 10)
    tk.freeze(now + secondMs)
    expectRate(r, 2 / secondMs)
    tk.freeze(now + 2 * secondMs)
    expectRate(r, 1 / secondMs)
    tk.freeze(now + minuteMs)
    expectRate(r, 2 / minuteMs)
  })

  it("counts events from the same millisecond", () => {
    r.onEvent()
    r.onEvent()
    tk.freeze(now + 10)
    expectRate(r, 2 / 10) // 1, not 2, because it will be averaged with 0s
    tk.freeze(now + minuteMs)
    expectRate(r, 2 / minuteMs)
  })

  for (const events of [10, 100, 1000]) {
    it("calculates average rate for " + events + " events", () => {
      const period = minuteMs
      times(events, (i) => {
        tk.freeze(now + (period * i) / events)
        r.onEvent()
      })
      expectRate(r, events / period, 0.25)
    })
  }
})
