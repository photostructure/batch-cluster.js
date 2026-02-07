import { expect } from "./_chai.spec";
import { findStreamFlushMillis } from "./BatchCluster";
import {
  expectFailParser,
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

  it("findStreamFlushMillis returns a non-negative number", async () => {
    // With ExifTool-like stream ordering (stderr before stdout token),
    // the minimum reliable value is typically 0 — stderr is already
    // buffered when the completion token arrives on stdout.
    const result = await findStreamFlushMillis({
      ...commonOpts,
      taskFactory: (i) =>
        new Task("stderrfail test-data " + i, expectFailParser),
    });
    expect(result).to.be.a("number");
    expect(result).to.be.greaterThanOrEqual(0);
    expect(result).to.be.at.most(fastTuning.hi);
  });
});
