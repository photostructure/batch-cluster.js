import FakeTimers from "@sinonjs/fake-timers";
import { minuteMs } from "./BatchClusterOptions";
import { Rate } from "./Rate";
import { expect, times } from "./_chai.spec";

describe("Rate", () => {
  const now = Date.now();
  const r = new Rate();
  let clock: FakeTimers.InstalledClock;

  beforeEach(() => {
    clock = FakeTimers.install({ now: now });
    // clear() must be called _after_ setting up fake timers
    r.clear();
  });

  afterEach(() => {
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

  for (const cnt of [1, 2, 3, 4]) {
    it(
      "decays the rate from " + cnt + " simultaneous event(s) as time elapses",
      () => {
        times(cnt, () => r.onEvent());
        expectRate(r, 0);
        clock.tick(100);
        expectRate(r, 0);
        clock.tick(r.warmupMs - 100 + 1);
        expectRate(r, cnt / r.warmupMs);
        clock.tick(r.warmupMs);
        expectRate(r, cnt / (2 * r.warmupMs));
        clock.tick(r.warmupMs);
        expectRate(r, cnt / (3 * r.warmupMs));
        clock.tick(r.periodMs - 3 * r.warmupMs);
        expectRate(r, 0);
        expect(r.msSinceLastEvent).to.be.closeTo(r.periodMs, 5);
      },
    );
  }

  for (const events of [4, 32, 256, 1024]) {
    it(
      "calculates average rate for " + events + " events, and then decays",
      () => {
        const period = r.periodMs;
        times(events, () => {
          clock.tick(r.periodMs / events);
          r.onEvent();
        });
        const tickMs = r.periodMs / 4;
        expectRate(r, events / period, 0.3);
        clock.tick(tickMs);
        expectRate(r, 0.75 * (events / period), 0.3);
        clock.tick(tickMs);
        expectRate(r, 0.5 * (events / period), 0.3);
        clock.tick(tickMs);
        expectRate(r, 0.25 * (events / period), 0.5);
        clock.tick(tickMs);
        expectRate(r, 0);
      },
    );
  }
});
