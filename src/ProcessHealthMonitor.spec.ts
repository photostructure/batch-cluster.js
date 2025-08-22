import events from "node:events";
import { expect, processFactory } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { verifyOptions } from "./OptionsVerifier";
import { HealthCheckable, ProcessHealthMonitor } from "./ProcessHealthMonitor";
import { Task } from "./Task";

describe("ProcessHealthMonitor", function () {
  let healthMonitor: ProcessHealthMonitor;
  let emitter: BatchClusterEmitter;
  let mockProcess: HealthCheckable;

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter;

    const options = verifyOptions({
      ...DefaultTestOptions,
      processFactory,
      observer: emitter,
      healthCheckCommand: "healthcheck",
      healthCheckIntervalMillis: 1000,
      maxTasksPerProcess: 5,
      maxIdleMsPerProcess: 2000,
      maxFailedTasksPerProcess: 3,
      maxProcAgeMillis: 20000, // Must be > spawnTimeoutMillis
      taskTimeoutMillis: 1000,
    });

    healthMonitor = new ProcessHealthMonitor(options, emitter);

    // Create a healthy mock process
    mockProcess = {
      pid: 12345,
      start: Date.now(),
      taskCount: 0,
      failedTaskCount: 0,
      idleMs: 0,
      idle: true,
      ending: false,
      ended: false,
      proc: { stdin: { destroyed: false } },
      currentTask: null,
    };
  });

  describe("process lifecycle", function () {
    it("should initialize process health monitoring", function () {
      healthMonitor.initializeProcess(mockProcess.pid);

      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      expect(state).to.not.be.undefined;
      expect(state?.healthCheckFailures).to.eql(0);
      expect(state?.lastJobFailed).to.be.false;
    });

    it("should cleanup process health monitoring", function () {
      healthMonitor.initializeProcess(mockProcess.pid);
      expect(healthMonitor.getProcessHealthState(mockProcess.pid)).to.not.be
        .undefined;

      healthMonitor.cleanupProcess(mockProcess.pid);
      expect(healthMonitor.getProcessHealthState(mockProcess.pid)).to.be
        .undefined;
    });
  });

  describe("health assessment", function () {
    beforeEach(function () {
      healthMonitor.initializeProcess(mockProcess.pid);
    });

    it("should assess healthy process as healthy", function () {
      const healthReason = healthMonitor.assessHealth(mockProcess);
      expect(healthReason).to.be.null;
      expect(healthMonitor.isHealthy(mockProcess)).to.be.true;
    });

    it("should detect ended process", function () {
      const endedProcess = { ...mockProcess, ended: true };

      const healthReason = healthMonitor.assessHealth(endedProcess);
      expect(healthReason).to.eql("ended");
      expect(healthMonitor.isHealthy(endedProcess)).to.be.false;
    });

    it("should detect ending process", function () {
      const endingProcess = { ...mockProcess, ending: true };

      const healthReason = healthMonitor.assessHealth(endingProcess);
      expect(healthReason).to.eql("ending");
      expect(healthMonitor.isHealthy(endingProcess)).to.be.false;
    });

    it("should detect closed stdin", function () {
      const closedProcess = {
        ...mockProcess,
        proc: { stdin: { destroyed: true } },
      };

      const healthReason = healthMonitor.assessHealth(closedProcess);
      expect(healthReason).to.eql("closed");
      expect(healthMonitor.isHealthy(closedProcess)).to.be.false;
    });

    it("should detect null stdin", function () {
      const nullStdinProcess = {
        ...mockProcess,
        proc: { stdin: null },
      };

      const healthReason = healthMonitor.assessHealth(nullStdinProcess);
      expect(healthReason).to.eql("closed");
      expect(healthMonitor.isHealthy(nullStdinProcess)).to.be.false;
    });

    it("should detect worn process (too many tasks)", function () {
      const wornProcess = { ...mockProcess, taskCount: 5 };

      const healthReason = healthMonitor.assessHealth(wornProcess);
      expect(healthReason).to.eql("worn");
      expect(healthMonitor.isHealthy(wornProcess)).to.be.false;
    });

    it("should detect idle process (idle too long)", function () {
      const idleProcess = { ...mockProcess, idleMs: 3000 };

      const healthReason = healthMonitor.assessHealth(idleProcess);
      expect(healthReason).to.eql("idle");
      expect(healthMonitor.isHealthy(idleProcess)).to.be.false;
    });

    it("should detect broken process (too many failed tasks)", function () {
      const brokenProcess = { ...mockProcess, failedTaskCount: 3 };

      const healthReason = healthMonitor.assessHealth(brokenProcess);
      expect(healthReason).to.eql("broken");
      expect(healthMonitor.isHealthy(brokenProcess)).to.be.false;
    });

    it("should detect old process", function () {
      const oldProcess = {
        ...mockProcess,
        start: Date.now() - 25000, // 25 seconds ago (older than maxProcAgeMillis)
      };

      const healthReason = healthMonitor.assessHealth(oldProcess);
      expect(healthReason).to.eql("old");
      expect(healthMonitor.isHealthy(oldProcess)).to.be.false;
    });

    it("should detect timed out task", function () {
      // Create a mock task that simulates a long runtime
      const mockTask = {
        runtimeMs: 1500, // longer than 1000ms timeout
      } as Task<unknown>;

      const timedOutProcess = {
        ...mockProcess,
        currentTask: mockTask,
      };

      const healthReason = healthMonitor.assessHealth(timedOutProcess);
      expect(healthReason).to.eql("timeout");
      expect(healthMonitor.isHealthy(timedOutProcess)).to.be.false;
    });

    it("should respect override reason", function () {
      const healthReason = healthMonitor.assessHealth(
        mockProcess,
        "startError",
      );
      expect(healthReason).to.eql("startError");
      expect(healthMonitor.isHealthy(mockProcess, "startError")).to.be.false;
    });

    it("should detect unhealthy process after health check failures", function () {
      // Simulate a health check failure
      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      if (state != null) {
        state.healthCheckFailures = 1;
      }

      const healthReason = healthMonitor.assessHealth(mockProcess);
      expect(healthReason).to.eql("unhealthy");
      expect(healthMonitor.isHealthy(mockProcess)).to.be.false;
    });
  });

  describe("readiness assessment", function () {
    beforeEach(function () {
      healthMonitor.initializeProcess(mockProcess.pid);
    });

    it("should assess idle healthy process as ready", function () {
      const readinessReason = healthMonitor.assessReadiness(mockProcess);
      expect(readinessReason).to.be.null;
      expect(healthMonitor.isReady(mockProcess)).to.be.true;
    });

    it("should detect busy process", function () {
      const busyProcess = { ...mockProcess, idle: false };

      const readinessReason = healthMonitor.assessReadiness(busyProcess);
      expect(readinessReason).to.eql("busy");
      expect(healthMonitor.isReady(busyProcess)).to.be.false;
    });

    it("should detect unhealthy idle process", function () {
      const unhealthyProcess = { ...mockProcess, ended: true };

      const readinessReason = healthMonitor.assessReadiness(unhealthyProcess);
      expect(readinessReason).to.eql("ended");
      expect(healthMonitor.isReady(unhealthyProcess)).to.be.false;
    });
  });

  describe("job state tracking", function () {
    beforeEach(function () {
      healthMonitor.initializeProcess(mockProcess.pid);
    });

    it("should record job failures", function () {
      healthMonitor.recordJobFailure(mockProcess.pid);

      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      expect(state?.lastJobFailed).to.be.true;
    });

    it("should record job successes", function () {
      // First record a failure
      healthMonitor.recordJobFailure(mockProcess.pid);
      expect(
        healthMonitor.getProcessHealthState(mockProcess.pid)?.lastJobFailed,
      ).to.be.true;

      // Then record a success
      healthMonitor.recordJobSuccess(mockProcess.pid);
      expect(
        healthMonitor.getProcessHealthState(mockProcess.pid)?.lastJobFailed,
      ).to.be.false;
    });

    it("should handle recording for non-existent process gracefully", function () {
      // Should not throw when recording for unknown PID
      expect(() => {
        healthMonitor.recordJobFailure(99999);
        healthMonitor.recordJobSuccess(99999);
      }).to.not.throw();
    });
  });

  describe("health check execution", function () {
    let mockBatchProcess: HealthCheckable & {
      execTask: (task: Task<unknown>) => boolean;
    };

    beforeEach(function () {
      healthMonitor.initializeProcess(mockProcess.pid);

      mockBatchProcess = {
        ...mockProcess,
        execTask: () => true, // Mock successful task execution
      };
    });

    it("should skip health check when no command configured", function () {
      // Create monitor with no health check command
      const options = verifyOptions({
        ...DefaultTestOptions,
        processFactory,
        observer: emitter,
        healthCheckCommand: "",
      });
      const noHealthCheckMonitor = new ProcessHealthMonitor(options, emitter);

      const result = noHealthCheckMonitor.maybeRunHealthCheck(mockBatchProcess);
      expect(result).to.be.undefined;
    });

    it("should skip health check when process not ready", function () {
      const unreadyProcess = { ...mockBatchProcess, idle: false };

      const result = healthMonitor.maybeRunHealthCheck(unreadyProcess);
      expect(result).to.be.undefined;
    });

    it("should run health check after job failure", function () {
      healthMonitor.recordJobFailure(mockProcess.pid);

      const result = healthMonitor.maybeRunHealthCheck(mockBatchProcess);
      expect(result).to.not.be.undefined;
      expect(result?.command).to.eql("healthcheck");
    });

    it("should run health check after interval expires", function () {
      // Mock an old health check
      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      if (state != null) {
        state.lastHealthCheck = Date.now() - 2000; // 2 seconds ago
      }

      const result = healthMonitor.maybeRunHealthCheck(mockBatchProcess);
      expect(result).to.not.be.undefined;
      expect(result?.command).to.eql("healthcheck");
    });

    it("should not run health check when interval hasn't expired", function () {
      // Health check was just done
      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      if (state != null) {
        state.lastHealthCheck = Date.now();
      }

      const result = healthMonitor.maybeRunHealthCheck(mockBatchProcess);
      expect(result).to.be.undefined;
    });

    it("should handle failed task execution gracefully", function () {
      const failingProcess = {
        ...mockBatchProcess,
        execTask: () => false, // Mock failed task execution
      };

      healthMonitor.recordJobFailure(mockProcess.pid);

      const result = healthMonitor.maybeRunHealthCheck(failingProcess);
      expect(result).to.be.undefined;
    });
  });

  describe("health statistics", function () {
    it("should provide accurate health statistics", function () {
      // Initialize multiple processes
      healthMonitor.initializeProcess(1);
      healthMonitor.initializeProcess(2);
      healthMonitor.initializeProcess(3);

      // Add some failures
      const state1 = healthMonitor.getProcessHealthState(1);
      const state2 = healthMonitor.getProcessHealthState(2);
      if (state1 != null) state1.healthCheckFailures = 2;
      if (state2 != null) state2.healthCheckFailures = 1;

      const stats = healthMonitor.getHealthStats();
      expect(stats.monitoredProcesses).to.eql(3);
      expect(stats.totalHealthCheckFailures).to.eql(3);
      expect(stats.processesWithFailures).to.eql(2);
    });

    it("should reset health check failures", function () {
      healthMonitor.initializeProcess(mockProcess.pid);

      // Add some failures
      const state = healthMonitor.getProcessHealthState(mockProcess.pid);
      if (state != null) {
        state.healthCheckFailures = 5;
      }

      expect(healthMonitor.getHealthStats().totalHealthCheckFailures).to.eql(5);

      healthMonitor.resetHealthCheckFailures(mockProcess.pid);

      expect(healthMonitor.getHealthStats().totalHealthCheckFailures).to.eql(0);
      expect(healthMonitor.isHealthy(mockProcess)).to.be.true;
    });
  });

  describe("edge cases", function () {
    it("should handle assessment of process without initialized state", function () {
      // Don't initialize the process
      const healthReason = healthMonitor.assessHealth(mockProcess);
      expect(healthReason).to.be.null; // Should still work, just no health check state
    });

    it("should handle health check on process without state", function () {
      const mockBatchProcess = {
        ...mockProcess,
        execTask: () => true,
      };

      // Don't initialize the process
      const result = healthMonitor.maybeRunHealthCheck(mockBatchProcess);
      expect(result).to.be.undefined;
    });
  });
});
