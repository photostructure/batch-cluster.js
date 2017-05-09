import { Rate } from "./Rate"
import { expect, times } from "./spec"

const tk = require("timekeeper")

describe("Rate", () => {

  after(() => tk.reset())

  function expectRate(r: Rate, epm: number = 0) {
    expect(r.eventsPerMillisecond).to.be.closeTo(epm, epm / 1000)
    expect(r.eventsPerSecond).to.be.closeTo(epm * 1000, epm)
    expect(r.eventsPerMinute).to.be.closeTo(epm * 60 * 1000, epm * 60)
  }

  it("is born with a rate of 0", () => {
    const r = new Rate()
    expectRate(r, 0)
  })

  it("calculates average rate before warmup", () => {
    const now = Date.now()
    tk.freeze(now)
    const r = new Rate(100)
    r.onEvent()
    expectRate(r, 0)
    tk.freeze(now + r.warmupMillis - 1)
    expectRate(r, 0)
  });

  [1, 10, 100, 1000].forEach(events => {
    it("calculates average rate for " + events + " events after warmup", () => {
      const now = Date.now()
      tk.freeze(now)
      const r = new Rate(100)
      times(events, () => r.onEvent())
      tk.freeze(now + r.warmupMillis)
      expectRate(r, events / r.warmupMillis)
    })
  })
})
