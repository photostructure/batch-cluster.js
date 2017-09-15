import { Rate } from "./Rate"
import { expect, times } from "./spec"

const tk = require("timekeeper")

describe("Rate", () => {
  const now = Date.now()
  let r: Rate

  beforeEach(() => {
    tk.freeze(now)
    r = new Rate()
  })

  after(() => tk.reset())

  function expectRate(rate: Rate, epm: number, tol: number = 0.25) {
    expect(rate.eventsPerMillisecond).to.be.withinToleranceOf(epm, tol)
    expect(rate.eventsPerSecond).to.be.withinToleranceOf(epm * 1000, tol)
    expect(rate.eventsPerMinute).to.be.withinToleranceOf(epm * 60 * 1000, tol)
  }

  it("is born with a rate of 0", () => {
    expectRate(r, 0)
  })

  it("maintains a rate of 0 after time", () => {
    tk.freeze(now + r.windowMillis)
    expectRate(r, 0)
  })

  it("decays the rate as time elapses", () => {
    r.onEvent()
    expectRate(r, 0)
    tk.freeze(now + r.windowMillis)
    expectRate(r, 0.5 / r.windowMillis) // .5, not 1, because it will be averaged with 0s
    tk.freeze(now + 1.25 * r.windowMillis * r.windows)
    expectRate(r, 0)
  })

  it("counts events from the same millisecond", () => {
    r.onEvent()
    r.onEvent()
    tk.freeze(now + r.windowMillis)
    expectRate(r, 1 / r.windowMillis) // 1, not 2, because it will be averaged with 0s
  })
  ;[10, 100, 1000].forEach(events => {
    it("calculates average rate for " + events + " events", () => {
      const period = r.windowMillis * r.windows
      times(events, i => {
        tk.freeze(now + period * i / events)
        r.onEvent()
      })
      expectRate(r, events / period, 0.1)
    })
  })
})
