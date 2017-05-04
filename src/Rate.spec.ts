import { delay } from "./BatchCluster"
import { expect } from "./spec"
import { Rate } from "./Rate"

describe("Rate", () => {
  it("is born with a rate of 0", () => {
    const r = new Rate()
    expect(r.eventsPerMillisecond).to.eql(0)
    expect(r.eventsPerSecond).to.eql(0)
    expect(r.eventsPerMinute).to.eql(0)
  })

  it("has a rate of 0 after only 1 event", () => {
    const r = new Rate()
    r.onEvent()
    expect(r.eventsPerMillisecond).to.eql(0)
    expect(r.eventsPerSecond).to.eql(0)
    expect(r.eventsPerMinute).to.eql(0)
  })

  const warmupMillis = 10

  function assertRate(r: Rate) {
    const expectedRate = r.events / r.durationMilliseconds
    const expectedSlop = .5
    // const actualDelta = Math.abs(r.eventsPerMillisecond - expectedRate)
    // const actualSlop = actualDelta / expectedRate
    const maxDelta = expectedRate * expectedSlop
    // console.dir({ actualRate: r.eventsPerMillisecond, expectedRate, actualDelta, actualSlop, maxDelta })
    if (r.durationMilliseconds > warmupMillis) {
      expect(r.eventsPerMillisecond).to.be.closeTo(expectedRate, maxDelta)
    } else {
      expect(r.eventsPerMillisecond).to.eql(0)
    }
    expect(r.eventsPerSecond).to.eql(r.eventsPerMillisecond * 1000)
    expect(r.eventsPerMinute).to.eql(r.eventsPerMillisecond * 1000 * 60)
  }

  [1e3, 1e4, 1e5, 1e6].forEach(iterations => {
    it("measures " + iterations + " with no delay", () => {
      const r = new Rate(warmupMillis)
      for (let i = 0; i < iterations; i++) {
        r.onEvent()
      }
      expect(r.events).to.eql(iterations)
      assertRate(r)
    })
  });

  [1, 10, 50].forEach(delayMs => {
    it("measures rate with " + delayMs + "ms delay between events", async () => {
      const duration = 250
      const r = new Rate(warmupMillis)
      while (r.durationMilliseconds < duration) {
        r.onEvent()
        await delay(delayMs)
      }
      assertRate(r)
    })
  })
})
