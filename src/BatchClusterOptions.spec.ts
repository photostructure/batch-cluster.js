import { BatchCluster } from "./BatchCluster";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { omit } from "./Object";
import { verifyOptions } from "./OptionsVerifier";
import { expect, processFactory } from "./_chai.spec";

describe("BatchClusterOptions", () => {
  let bc: BatchCluster;
  afterEach(() => bc?.end(false));
  describe("verifyOptions()", () => {
    function errToArr(err: unknown): string[] {
      return String(err).split(/\s*[:;]\s*/);
    }

    it("allows 0 maxProcAgeMillis", () => {
      const opts = {
        ...DefaultTestOptions,
        maxProcAgeMillis: 0,
      };
      expect(verifyOptions(opts as any)).to.containSubset(opts);
    });

    it("requires maxProcAgeMillis to be > spawnTimeoutMillis", () => {
      const spawnTimeoutMillis = DefaultTestOptions.taskTimeoutMillis + 1;
      try {
        bc = new BatchCluster({
          processFactory,
          ...DefaultTestOptions,
          spawnTimeoutMillis,
          maxProcAgeMillis: spawnTimeoutMillis - 1,
        });
        throw new Error("expected an error due to invalid opts");
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            spawnTimeoutMillis,
          `the max value of spawnTimeoutMillis (${spawnTimeoutMillis}) and taskTimeoutMillis (${DefaultTestOptions.taskTimeoutMillis})`,
        ]);
      }
    });

    it("requires maxProcAgeMillis to be > taskTimeoutMillis", () => {
      const taskTimeoutMillis = DefaultTestOptions.spawnTimeoutMillis + 1;
      try {
        bc = new BatchCluster({
          processFactory,
          ...DefaultTestOptions,
          taskTimeoutMillis,
          maxProcAgeMillis: taskTimeoutMillis - 1,
        });
        throw new Error("expected an error due to invalid opts");
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            taskTimeoutMillis,
          `the max value of spawnTimeoutMillis (${DefaultTestOptions.spawnTimeoutMillis}) and taskTimeoutMillis (${taskTimeoutMillis})`,
        ]);
      }
    });

    it("allows maxProcAgeMillis to be 0", () => {
      const taskTimeoutMillis = DefaultTestOptions.spawnTimeoutMillis + 1;
      bc = new BatchCluster({
        processFactory,
        ...DefaultTestOptions,
        taskTimeoutMillis,
        maxProcAgeMillis: 0,
      });

      expect(bc.options.maxProcAgeMillis).to.equal(0);
    });

    it("reports on invalid opts", () => {
      try {
        bc = new BatchCluster({
          processFactory,
          versionCommand: "",
          pass: "",
          fail: "",

          maxTasksPerProcess: 0,
          minDelayBetweenSpawnMillis: -1,
          // must be non-zero to trigger maxProcAgeMillis validation
          taskTimeoutMillis: 10000,

          maxProcs: -1,
          maxProcAgeMillis: 10,
          onIdleIntervalMillis: -1,
          endGracefulWaitTimeMillis: -1,
          streamFlushMillis: -1,
        });
        throw new Error("expected an error due to invalid opts");
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "versionCommand must not be blank",
          "pass must not be blank",
          "fail must not be blank",
          "maxTasksPerProcess must be greater than or equal to 1",
          "maxProcs must be greater than or equal to 1",
          "maxProcAgeMillis must be greater than or equal to 15000",
          // DON'T PANIC: this is just a continuation of the previous error message.
          "the max value of spawnTimeoutMillis (15000) and taskTimeoutMillis (10000)",
          "minDelayBetweenSpawnMillis must be greater than or equal to 0",
          "onIdleIntervalMillis must be greater than or equal to 0",
          "endGracefulWaitTimeMillis must be greater than or equal to 0",
          "streamFlushMillis must be greater than or equal to 0",
        ]);
      }
    });

    it("rejects negative waitForStderrMillis", () => {
      try {
        bc = new BatchCluster({
          processFactory,
          ...DefaultTestOptions,
          waitForStderrMillis: -1,
        });
        throw new Error("expected an error due to invalid opts");
      } catch (err) {
        expect(String(err)).to.include(
          "waitForStderrMillis must be greater than or equal to 0",
        );
      }
    });

    it("allows undefined waitForStderrMillis (defaults to streamFlushMillis)", () => {
      bc = new BatchCluster({
        processFactory,
        ...omit(DefaultTestOptions, "waitForStderrMillis"),
      });
      expect(bc.options.waitForStderrMillis).to.equal(undefined);
    });

    it("allows explicit waitForStderrMillis", () => {
      bc = new BatchCluster({
        processFactory,
        ...DefaultTestOptions,
        waitForStderrMillis: 5,
      });
      expect(bc.options.waitForStderrMillis).to.equal(5);
    });
  });
});
