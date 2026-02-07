import { expect } from "./_chai.spec";
import { findStreamFlushMillis, findWaitForStderrMillis } from "./BatchCluster";
import {
  expectFailParser,
  expectPassParser,
  testProcessFactory,
} from "./FlushThresholdTestHelpers";
import { Task } from "./Task";

// Small tuning to keep tests fast
const fastTuning = {
  lo: 0,
  hi: 5,
  maxProcs: 2,
  coarseTasks: 3,
  validationTasks: 3,
  validationTrials: 1,
  validationRadius: 1,
  confirmationTrials: 2,
  confirmationTasks: 3,
  safetyMargin: 2,
};

const commonOpts = {
  processFactory: testProcessFactory,
  versionCommand: "version",
  pass: "PASS",
  fail: "FAIL",
  exitCommand: "exit",
  ...fastTuning,
};

describe("FindFlushThresholds", function () {
  // These tests spawn real child processes and run multi-phase searches
  this.timeout(60_000);
  this.slow(10_000);

  it("findWaitForStderrMillis returns a positive number", async () => {
    const result = await findWaitForStderrMillis({
      ...commonOpts,
      taskFactory: (i) => new Task("stderr test-data " + i, expectPassParser),
    });
    expect(result).to.be.a("number");
    expect(result).to.be.greaterThan(0);
    expect(result).to.be.at.most(fastTuning.hi * fastTuning.safetyMargin);
  });

  it("findStreamFlushMillis returns a positive number", async () => {
    const result = await findStreamFlushMillis({
      ...commonOpts,
      taskFactory: (i) =>
        new Task("stderrfail test-data " + i, expectFailParser),
    });
    expect(result).to.be.a("number");
    expect(result).to.be.greaterThan(0);
    expect(result).to.be.at.most(fastTuning.hi * fastTuning.safetyMargin);
  });
});
