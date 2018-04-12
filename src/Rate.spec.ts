import { expect, times } from "./chai.spec"
import { Rate } from "./Rate"

const tk = require("timekeeper")

describe("Rate", () => {
  const now = Date.now()
  let r: Rate

  beforeEach(() => {
    tk.freeze(now)
    r = new Rate()
  })

  after(() => tk.reset())

  function expectRate(rate: Rate, epm: number, tol: number = 0.5) {
    expect(rate.eventsPerMs).to.be.withinToleranceOf(epm, tol)
    expect(rate.eventsPerSecond).to.be.withinToleranceOf(epm * 1000, tol)
    expect(rate.eventsPerMinute).to.be.withinToleranceOf(epm * 60 * 1000, tol)
  }

  it("is born with a rate of 0", () => {
    expectRate(r, 0)
  })

  it("maintains a rate of 0 after time", () => {
    tk.freeze(now + r.ttlMs)
    expectRate(r, 0)
  })

  it("decays the rate as time elapses", () => {
    r.onEvent()
    expectRate(r, 1)
    tk.freeze(now + 10)
    expectRate(r, 0.1)
    tk.freeze(now + r.ttlMs)
    expectRate(r, 0)
  })

  it("counts events from the same millisecond", () => {
    r.onEvent()
    expectRate(r, 1)
    r.onEvent()
    expectRate(r, 2)
    tk.freeze(now + 10)
    expectRate(r, 2 / 10) // 1, not 2, because it will be averaged with 0s
    tk.freeze(now + r.ttlMs)
    expectRate(r, 0)
  })

  for (const events of [10, 100, 1000]) {
    it("calculates average rate for " + events + " events", () => {
      const period = r.ttlMs
      times(events, i => {
        tk.freeze(now + period * i / events)
        r.onEvent()
      })
      expectRate(r, events / period, 0.25)
    })
  }
})
