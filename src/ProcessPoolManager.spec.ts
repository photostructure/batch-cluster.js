import events from "node:events";
import {
  currentTestPids,
  expect,
  processFactory,
  setFailratePct,
  setIgnoreExit,
} from "./_chai.spec";
import { delay, until } from "./Async";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { verifyOptions } from "./OptionsVerifier";
import { ProcessPoolManager } from "./ProcessPoolManager";

describe("ProcessPoolManager", function () {
  let poolManager: ProcessPoolManager;
  let emitter: BatchClusterEmitter;

  const onIdle = () => {
    // callback for when pool manager needs to signal idle state
  };

  beforeEach(function () {
    setFailratePct(0); // no failures for pool manager tests
    setIgnoreExit(false);
    emitter = new events.EventEmitter() as BatchClusterEmitter;

    const options = verifyOptions({
      ...DefaultTestOptions,
      processFactory,
      observer: emitter,
    });

    poolManager = new ProcessPoolManager(options, emitter, onIdle);
  });

  afterEach(async function () {
    if (poolManager != null) {
      await poolManager.closeChildProcesses(false);
      // Wait for processes to actually exit
      await until(async () => (await currentTestPids()).length === 0, 5000);
    }
  });

  describe("initial state", function () {
    it("should start with no processes", function () {
      expect(poolManager.procCount).to.eql(0);
      expect(poolManager.busyProcCount).to.eql(0);
      expect(poolManager.startingProcCount).to.eql(0);
      expect(poolManager.spawnedProcCount).to.eql(0);
      expect(poolManager.processes).to.eql([]);
      expect(poolManager.findReadyProcess()).to.be.undefined;
    });

    it("should return empty pids array", function () {
      expect(poolManager.pids()).to.eql([]);
    });
  });

  describe("process spawning", function () {
    it("should spawn processes when there are pending tasks", async function () {
      const pendingTaskCount = 2;
      await poolManager.maybeSpawnProcs(pendingTaskCount, false);

      expect(poolManager.procCount).to.be.greaterThan(0);
      expect(poolManager.spawnedProcCount).to.be.greaterThan(0);

      // Wait for processes to be ready
      await until(() => poolManager.findReadyProcess() != null, 2000);
      expect(poolManager.findReadyProcess()).to.not.be.undefined;
    });

    it("should not spawn more processes than maxProcs", async function () {
      const maxProcs = 2;
      poolManager.setMaxProcs(maxProcs);

      // Try to spawn more than maxProcs
      await poolManager.maybeSpawnProcs(5, false);

      expect(poolManager.procCount).to.be.at.most(maxProcs);
    });

    it("should not spawn processes when ended", async function () {
      await poolManager.maybeSpawnProcs(2, true); // ended = true

      expect(poolManager.procCount).to.eql(0);
      expect(poolManager.spawnedProcCount).to.eql(0);
    });

    it("should spawn multiple processes for multiple pending tasks", async function () {
      const pendingTaskCount = 3;
      poolManager.setMaxProcs(4);

      await poolManager.maybeSpawnProcs(pendingTaskCount, false);

      // Should spawn up to the number of pending tasks or maxProcs
      expect(poolManager.procCount).to.be.at.least(1);
      expect(poolManager.procCount).to.be.at.most(
        Math.min(pendingTaskCount, 4),
      );
    });
  });

  describe("process management", function () {
    beforeEach(async function () {
      // Spawn some processes for testing
      await poolManager.maybeSpawnProcs(2, false);
      await until(() => poolManager.procCount >= 1, 2000);
    });

    it("should track process PIDs", function () {
      const pids = poolManager.pids();
      expect(pids.length).to.be.greaterThan(0);
      expect(pids.every((pid) => typeof pid === "number" && pid > 0)).to.be
        .true;
    });

    it("should find ready processes", async function () {
      await until(() => poolManager.findReadyProcess() != null, 2000);
      const readyProcess = poolManager.findReadyProcess();
      expect(readyProcess).to.not.be.undefined;
      expect(readyProcess?.ready).to.be.true;
    });

    it("should vacuum unhealthy processes", async function () {
      // Wait for processes to be ready
      await until(() => poolManager.findReadyProcess() != null, 2000);

      const initialCount = poolManager.procCount;
      expect(initialCount).to.be.greaterThan(0);

      // Vacuum should not remove healthy processes
      await poolManager.vacuumProcs();
      expect(poolManager.procCount).to.eql(initialCount);
    });

    it("should reduce process count when maxProcs is lowered", async function () {
      // Ensure we have multiple processes
      poolManager.setMaxProcs(3);
      await poolManager.maybeSpawnProcs(3, false);
      await until(() => poolManager.procCount >= 2, 2000);

      const initialCount = poolManager.procCount;

      // Reduce maxProcs
      poolManager.setMaxProcs(1);
      await poolManager.vacuumProcs();

      // Should eventually reduce to 1 process (may take time for idle processes to be reaped)
      await until(() => poolManager.procCount <= 1, 3000);
      expect(poolManager.procCount).to.be.at.most(1);
      expect(poolManager.procCount).to.be.lessThanOrEqual(initialCount);
    });
  });

  describe("process lifecycle", function () {
    it("should close all processes gracefully", async function () {
      await poolManager.maybeSpawnProcs(2, false);
      await until(() => poolManager.procCount >= 1, 2000);

      const initialPids = poolManager.pids();
      expect(initialPids.length).to.be.greaterThan(0);

      await poolManager.closeChildProcesses(true);

      expect(poolManager.procCount).to.eql(0);

      // Wait for processes to actually exit
      await until(async () => {
        const remainingPids = await currentTestPids();
        return (
          remainingPids.filter((pid) => initialPids.includes(pid)).length === 0
        );
      }, 5000);
    });

    it("should close all processes forcefully", async function () {
      await poolManager.maybeSpawnProcs(2, false);
      await until(() => poolManager.procCount >= 1, 2000);

      const initialPids = poolManager.pids();
      expect(initialPids.length).to.be.greaterThan(0);

      await poolManager.closeChildProcesses(false);

      expect(poolManager.procCount).to.eql(0);

      // Wait for processes to actually exit
      await until(async () => {
        const remainingPids = await currentTestPids();
        return (
          remainingPids.filter((pid) => initialPids.includes(pid)).length === 0
        );
      }, 5000);
    });
  });

  describe("process counting", function () {
    it("should track starting processes", async function () {
      // Start spawning processes but don't wait for completion
      const spawnPromise = poolManager.maybeSpawnProcs(2, false);

      // Should show starting processes initially
      await delay(50); // Give it a moment to start
      const totalProcs = poolManager.procCount;
      const startingProcs = poolManager.startingProcCount;

      expect(totalProcs).to.be.greaterThan(0);
      expect(startingProcs).to.be.greaterThan(0);

      await spawnPromise;

      // Wait for processes to be ready
      await until(() => poolManager.startingProcCount === 0, 2000);
      expect(poolManager.startingProcCount).to.eql(0);
    });

    it("should track busy vs idle processes", async function () {
      await poolManager.maybeSpawnProcs(1, false);
      await until(() => poolManager.findReadyProcess() != null, 2000);

      // Initially all processes should be idle (not busy)
      expect(poolManager.busyProcCount).to.eql(0);

      const readyProcess = poolManager.findReadyProcess();
      expect(readyProcess).to.not.be.undefined;
      expect(readyProcess?.idle).to.be.true;
    });
  });

  describe("event integration", function () {
    it("should work with emitter for process lifecycle events", async function () {
      const childStartEvents: any[] = [];
      const childEndEvents: any[] = [];

      emitter.on("childStart", (proc) => {
        childStartEvents.push(proc);
      });

      emitter.on("childEnd", (proc, reason) => {
        childEndEvents.push({ proc, reason });
      });

      await poolManager.maybeSpawnProcs(1, false);
      await until(() => childStartEvents.length >= 1, 2000);

      expect(childStartEvents.length).to.be.greaterThan(0);

      await poolManager.closeChildProcesses(true);
      await until(() => childEndEvents.length >= 1, 2000);

      expect(childEndEvents.length).to.be.greaterThan(0);
      expect(childEndEvents[0].reason).to.eql("ending");
    });
  });
});
