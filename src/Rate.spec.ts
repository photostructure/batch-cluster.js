import FakeTimers from "@sinonjs/fake-timers";
import { minuteMs } from "./BatchClusterOptions";
import { Rate } from "./Rate";
import { expect, times } from "./_chai.spec";

describe("Rate", () => {
  const now = Date.now();
  let r: Rate;
  let clock: FakeTimers.InstalledClock;

  beforeEach(() => {
    clock = FakeTimers.install({ now: now });
    // Create Rate after fake timers are installed so the timer is controlled
    r = new Rate();
  });

  afterEach(() => {
    r[Symbol.dispose]();
    clock.uninstall();
  });

  function expectRate(rate: Rate, epm: number, tol = 0.1) {
    expect(rate.eventsPerMs).to.be.withinToleranceOf(epm, tol);
    expect(rate.eventsPerSecond).to.be.withinToleranceOf(epm * 1000, tol);
    expect(rate.eventsPerMinute).to.be.withinToleranceOf(epm * 60 * 1000, tol);
  }

  it("is born with a rate of 0", () => {
    expectRate(r, 0);
  });

  it("maintains a rate of 0 after time with no events", () => {
    clock.tick(minuteMs);
    expectRate(r, 0);
  });

  describe("two-bucket sliding window", () => {
    for (const cnt of [1, 2, 3, 4]) {
      it(`holds ${cnt} event(s) in currentCount during first period, then decays in second period`, () => {
        // t=0: record events
        times(cnt, () => r.onEvent());

        // During warmup, rate is 0
        expectRate(r, 0);
        clock.tick(100);
        expectRate(r, 0);

        // After warmup (t=1001), rate reflects events / elapsed time
        clock.tick(r.warmupMs - 100 + 1);
        expectRate(r, cnt / (r.warmupMs + 1), 0.1);

        // t=periodMs: timer fires, prevCount = cnt, currentCount = 0
        clock.tick(r.periodMs - r.warmupMs - 1);

        // Just after timer fires (t=periodMs + 1)
        clock.tick(1);
        // eventsInWindow ≈ cnt (prevCount fully overlaps, elapsed=1ms)
        // denominator = min(periodMs, elapsed) = periodMs
        expectRate(r, cnt / r.periodMs, 0.1);

        // Halfway through second period (t = 1.5 * periodMs)
        clock.tick(r.periodMs / 2 - 1);
        // elapsed = periodMs/2, overlapWithPrev = 0.5
        // eventsInWindow = cnt * 0.5
        expectRate(r, (cnt * 0.5) / r.periodMs, 0.2);

        // End of second period (t = 2 * periodMs): timer fires again
        // prevCount = 0, currentCount = 0
        clock.tick(r.periodMs / 2);

        // Just after second rotation (t = 2 * periodMs + 1)
        clock.tick(1);
        expectRate(r, 0);

        // msSinceLastEvent: events at t=0, now at t = 2*periodMs + 1
        expect(r.msSinceLastEvent).to.be.closeTo(2 * r.periodMs + 1, 5);
      });
    }

    for (const events of [4, 32, 256, 1024]) {
      it(`calculates rate for ${events} events spread across period, then decays`, () => {
        const period = r.periodMs;

        // Spread events evenly across 90% of the period to avoid timer edge case
        // (if last event lands exactly at periodMs, timer fires mid-iteration)
        const spreadMs = period * 0.9;
        const intervalMs = spreadMs / events;

        times(events, () => {
          clock.tick(intervalMs);
          r.onEvent();
        });
        // Now at t ≈ 0.9 * periodMs, all events in currentCount

        // Rate should be approximately events/elapsed
        const elapsed = spreadMs;
        expectRate(r, events / elapsed, 0.3);

        // Advance to periodMs to trigger rotation
        clock.tick(period - spreadMs);
        // Timer fires: prevCount = events, currentCount = 0

        // Just after rotation
        clock.tick(1);
        // eventsInWindow ≈ events (prevCount fully overlaps)
        expectRate(r, events / period, 0.3);

        // Decay through second period
        const tickMs = period / 4;

        clock.tick(tickMs);
        // overlapWithPrev = 0.75
        expectRate(r, (0.75 * events) / period, 0.3);

        clock.tick(tickMs);
        // overlapWithPrev = 0.5
        expectRate(r, (0.5 * events) / period, 0.3);

        clock.tick(tickMs);
        // overlapWithPrev = 0.25
        expectRate(r, (0.25 * events) / period, 0.5);

        clock.tick(tickMs);
        // t = 2 * periodMs, timer fires: prevCount = 0

        clock.tick(1);
        // eventsInWindow = 0
        expectRate(r, 0);
      });
    }
  });

  it("tracks eventCount as a lifetime counter", () => {
    expect(r.eventCount).to.equal(0);
    times(5, () => r.onEvent());
    expect(r.eventCount).to.equal(5);
    // eventCount persists even after events decay from the window
    clock.tick(r.periodMs * 2 + 1);
    expect(r.eventCount).to.equal(5);
    // more events increment the count
    times(3, () => r.onEvent());
    expect(r.eventCount).to.equal(8);
  });

  it("resets all state on clear()", () => {
    times(10, () => r.onEvent());
    clock.tick(r.warmupMs + 1);
    expect(r.eventCount).to.equal(10);
    expect(r.eventsPerMs).to.be.greaterThan(0);
    expect(r.msSinceLastEvent).to.not.be.null;

    r.clear();

    expect(r.eventCount).to.equal(0);
    expect(r.eventsPerMs).to.equal(0);
    expect(r.msSinceLastEvent).to.be.null;
    expectRate(r, 0);
  });

  it("returns 0 from eventsPerMs during warmup period", () => {
    // Before any events, rate is 0
    expect(r.eventsPerMs).to.equal(0);

    // After events but still in warmup, rate is still 0
    times(5, () => r.onEvent());
    clock.tick(r.warmupMs - 1);
    expect(r.eventsPerMs).to.equal(0);

    // After warmup ends, rate is computed
    clock.tick(2);
    expect(r.eventsPerMs).to.be.greaterThan(0);
    expect(r.eventsPerMs).to.be.closeTo(5 / (r.warmupMs + 1), 0.001);
  });

  it("dispose() stops the internal timer", () => {
    times(5, () => r.onEvent());
    clock.tick(r.warmupMs + 1);

    // Verify rate is working
    expect(r.eventsPerMinute).to.be.greaterThan(0);

    r[Symbol.dispose]();

    // Timer no longer fires, but current state remains readable
    clock.tick(r.periodMs * 3);
    // Without timer rotation, events stay in currentCount forever
    expect(r.eventCount).to.equal(5);
  });
});
