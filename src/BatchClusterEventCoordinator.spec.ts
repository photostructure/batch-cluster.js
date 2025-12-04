import events from "node:events";
import { expect } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import {
  BatchClusterEventCoordinator,
  EventCoordinatorOptions,
} from "./BatchClusterEventCoordinator";
import { BatchProcess } from "./BatchProcess";
import { logger } from "./Logger";
import { Task } from "./Task";

describe("BatchClusterEventCoordinator", function () {
  let eventCoordinator: BatchClusterEventCoordinator;
  let emitter: BatchClusterEmitter;
  let onIdleCalledCount = 0;

  const options: EventCoordinatorOptions = {
    streamFlushMillis: 100,
    logger,
  };

  const onIdleLater = () => {
    onIdleCalledCount++;
  };

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter;
    eventCoordinator = new BatchClusterEventCoordinator(
      emitter,
      options,
      onIdleLater,
    );
    onIdleCalledCount = 0;
  });

  describe("initial state", function () {
    it("should start with clean statistics", function () {
      expect(eventCoordinator.meanTasksPerProc).to.eql(0);
      expect(eventCoordinator.internalErrorCount).to.eql(0);
      expect(eventCoordinator.countEndedChildProcs("ended")).to.eql(0);
      expect(eventCoordinator.childEndCounts).to.eql({});
    });

    it("should provide clean event statistics", function () {
      const stats = eventCoordinator.getEventStats();
      expect(stats.meanTasksPerProc).to.eql(0);
      expect(stats.internalErrorCount).to.eql(0);
      expect(stats.totalChildEndEvents).to.eql(0);
      expect(stats.childEndReasons).to.eql([]);
    });
  });

  describe("childEnd event handling", function () {
    it("should handle childEnd events and update statistics", function () {
      const mockProcess = {
        taskCount: 5,
        pid: 12345,
      } as BatchProcess;

      // Emit childEnd event
      emitter.emit("childEnd", mockProcess, "worn");

      expect(eventCoordinator.meanTasksPerProc).to.eql(5);
      expect(eventCoordinator.countEndedChildProcs("worn")).to.eql(1);
      expect(eventCoordinator.childEndCounts.worn).to.eql(1);
      expect(onIdleCalledCount).to.eql(1);
    });

    it("should track multiple childEnd events", function () {
      const mockProcess1 = { taskCount: 3 } as BatchProcess;
      const mockProcess2 = { taskCount: 7 } as BatchProcess;
      const mockProcess3 = { taskCount: 5 } as BatchProcess;

      emitter.emit("childEnd", mockProcess1, "worn");
      emitter.emit("childEnd", mockProcess2, "old");
      emitter.emit("childEnd", mockProcess3, "worn");

      expect(eventCoordinator.meanTasksPerProc).to.eql(5); // (3+7+5)/3
      expect(eventCoordinator.countEndedChildProcs("worn")).to.eql(2);
      expect(eventCoordinator.countEndedChildProcs("old")).to.eql(1);
      expect(eventCoordinator.childEndCounts.worn).to.eql(2);
      expect(eventCoordinator.childEndCounts.old).to.eql(1);
      expect(onIdleCalledCount).to.eql(3);
    });
  });

  describe("internalError event handling", function () {
    it("should handle internalError events and increment counter", function () {
      const error = new Error("Internal error occurred");

      emitter.emit("internalError", error);

      expect(eventCoordinator.internalErrorCount).to.eql(1);
    });

    it("should handle multiple internalError events", function () {
      emitter.emit("internalError", new Error("Error 1"));
      emitter.emit("internalError", new Error("Error 2"));
      emitter.emit("internalError", new Error("Error 3"));

      expect(eventCoordinator.internalErrorCount).to.eql(3);
    });
  });

  describe("noTaskData event handling", function () {
    it("should handle noTaskData events and increment internal error count", function () {
      const mockProcess = { pid: 12345 } as BatchProcess;

      emitter.emit("noTaskData", "some stdout", "some stderr", mockProcess);

      expect(eventCoordinator.internalErrorCount).to.eql(1);
    });

    it("should handle noTaskData with null data", function () {
      const mockProcess = { pid: 12345 } as BatchProcess;

      emitter.emit("noTaskData", null, null, mockProcess);

      expect(eventCoordinator.internalErrorCount).to.eql(1);
    });

    it("should handle noTaskData with buffer data", function () {
      const mockProcess = { pid: 12345 } as BatchProcess;
      const bufferData = Buffer.from("test data");

      emitter.emit("noTaskData", bufferData, null, mockProcess);

      expect(eventCoordinator.internalErrorCount).to.eql(1);
    });
  });

  describe("startError event handling", function () {
    it("should handle startError events and call onIdleLater", function () {
      const error = new Error("Start error");

      emitter.emit("startError", error);

      // Should call onIdleLater to trigger spawning replacement process
      expect(onIdleCalledCount).to.eql(1);
    });
  });

  describe("event access", function () {
    it("should provide access to the underlying emitter", function () {
      expect(eventCoordinator.events).to.equal(emitter);
    });

    it("should allow direct event emission through events property", function () {
      let eventReceived = false;
      let receivedData: any;

      emitter.on("taskData", (data, task, proc) => {
        eventReceived = true;
        receivedData = { data, task, proc };
      });

      const mockTask = {} as Task<unknown>;
      const mockProcess = {} as BatchProcess;
      const testData = "test data";

      const result = eventCoordinator.events.emit(
        "taskData",
        testData,
        mockTask,
        mockProcess,
      );

      expect(result).to.be.true;
      expect(eventReceived).to.be.true;
      expect(receivedData.data).to.eql(testData);
      expect(receivedData.task).to.eql(mockTask);
      expect(receivedData.proc).to.eql(mockProcess);
    });

    it("should allow direct event listener management through events property", function () {
      let eventReceived = false;

      const listener = () => {
        eventReceived = true;
      };

      eventCoordinator.events.on("beforeEnd", listener);
      emitter.emit("beforeEnd");
      expect(eventReceived).to.be.true;

      eventReceived = false;
      eventCoordinator.events.off("beforeEnd", listener);
      emitter.emit("beforeEnd");
      expect(eventReceived).to.be.false;
    });
  });

  describe("statistics and monitoring", function () {
    beforeEach(function () {
      // Set up some test data
      const mockProcess1 = { taskCount: 10 } as BatchProcess;
      const mockProcess2 = { taskCount: 20 } as BatchProcess;

      emitter.emit("childEnd", mockProcess1, "worn");
      emitter.emit("childEnd", mockProcess2, "old");
      emitter.emit("internalError", new Error("Test error"));
      emitter.emit("startError", new Error("Start error"));
    });

    it("should provide comprehensive event statistics", function () {
      const stats = eventCoordinator.getEventStats();

      expect(stats.meanTasksPerProc).to.eql(15); // (10+20)/2
      expect(stats.internalErrorCount).to.eql(1);
      expect(stats.totalChildEndEvents).to.eql(2);
      expect(stats.childEndReasons).to.include("worn");
      expect(stats.childEndReasons).to.include("old");
    });

    it("should reset statistics correctly", function () {
      // Verify we have some data
      expect(eventCoordinator.meanTasksPerProc).to.eql(15);
      expect(eventCoordinator.internalErrorCount).to.eql(1);

      eventCoordinator.resetStats();

      // Verify everything is reset
      expect(eventCoordinator.meanTasksPerProc).to.eql(0);
      expect(eventCoordinator.internalErrorCount).to.eql(0);
      expect(eventCoordinator.childEndCounts).to.eql({});

      const stats = eventCoordinator.getEventStats();
      expect(stats.totalChildEndEvents).to.eql(0);
      expect(stats.childEndReasons).to.eql([]);
    });

    it("should track child end counts accurately", function () {
      // Add more events of different types
      const mockProcess3 = { taskCount: 5 } as BatchProcess;
      const mockProcess4 = { taskCount: 8 } as BatchProcess;

      emitter.emit("childEnd", mockProcess3, "worn"); // Second worn
      emitter.emit("childEnd", mockProcess4, "broken"); // New type

      expect(eventCoordinator.countEndedChildProcs("worn")).to.eql(2);
      expect(eventCoordinator.countEndedChildProcs("old")).to.eql(1);
      expect(eventCoordinator.countEndedChildProcs("broken")).to.eql(1);
      expect(eventCoordinator.countEndedChildProcs("timeout")).to.eql(0);

      const childEndCounts = eventCoordinator.childEndCounts;
      expect(childEndCounts.worn).to.eql(2);
      expect(childEndCounts.old).to.eql(1);
      expect(childEndCounts.broken).to.eql(1);
    });
  });

  describe("callback integration", function () {
    it("should call onIdleLater for appropriate events", function () {
      const initialCount = onIdleCalledCount;

      // Events that should trigger onIdleLater
      emitter.emit("childEnd", { taskCount: 5 } as BatchProcess, "worn");
      emitter.emit("startError", new Error("Start error"));

      expect(onIdleCalledCount).to.eql(initialCount + 2);
    });
  });
});
