import FakeTimers from "@sinonjs/fake-timers";
import child_process from "node:child_process";
import events from "node:events";
import { expect, processFactory } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { logger, Logger, NoLogger } from "./Logger";
import {
  StreamContext,
  StreamHandler,
  StreamHandlerOptions,
} from "./StreamHandler";
import { Task } from "./Task";

describe("StreamHandler", function () {
  let streamHandler: StreamHandler;
  let emitter: BatchClusterEmitter;
  let mockContext: StreamContext;
  let onErrorCalls: { reason: string; error: Error }[] = [];
  let endCalls: { gracefully: boolean; reason: string }[] = [];
  let onIdleCalls = 0;

  const options: StreamHandlerOptions = {
    logger,
  };

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter;
    streamHandler = new StreamHandler(options, emitter);

    onErrorCalls = [];
    endCalls = [];
    onIdleCalls = 0;

    // Create a mock context that simulates BatchProcess behavior
    mockContext = {
      name: "TestProcess(12345)",
      isEnding: () => false,
      getCurrentTask: () => undefined,
      onError: (reason: string, error: Error) => {
        onErrorCalls.push({ reason, error });
      },
      end: (gracefully: boolean, reason: string) => {
        endCalls.push({ gracefully, reason });
      },
      onIdle: () => {
        onIdleCalls++;
      },
    };
  });

  describe("initial state", function () {
    it("should initialize correctly", function () {
      expect(streamHandler).to.not.be.undefined;

      const stats = streamHandler.getStats();
      expect(stats.handlerActive).to.be.true;
      expect(stats.emitterConnected).to.be.true;
    });
  });

  describe("stream setup", function () {
    let mockProcess: child_process.ChildProcess;

    beforeEach(async function () {
      // Create a real process for testing stream setup
      mockProcess = await processFactory();
    });

    afterEach(function () {
      if (mockProcess && !mockProcess.killed) {
        mockProcess.kill();
      }
    });

    it("should set up stream listeners on a child process", function () {
      expect(() => {
        streamHandler.setupStreamListeners(mockProcess, mockContext);
      }).to.not.throw();

      // Verify streams exist
      expect(mockProcess.stdin).to.not.be.null;
      expect(mockProcess.stdout).to.not.be.null;
      expect(mockProcess.stderr).to.not.be.null;
    });

    it("should throw error if stdin is missing", function () {
      const invalidProcess = { stdin: null } as child_process.ChildProcess;

      expect(() => {
        streamHandler.setupStreamListeners(invalidProcess, mockContext);
      }).to.throw("Given proc had no stdin");
    });

    it("should throw error if stdout is missing", function () {
      const invalidProcess = {
        stdin: {
          on: () => {
            /* mock implementation */
          },
        }, // Mock stdin with on method
        stdout: null,
      } as any as child_process.ChildProcess;

      expect(() => {
        streamHandler.setupStreamListeners(invalidProcess, mockContext);
      }).to.throw("Given proc had no stdout");
    });
  });

  describe("stdout processing", function () {
    let mockTask: Task<unknown>;
    let taskDataEvents: { data: any; task: any; context: any }[] = [];
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = [];

    beforeEach(function () {
      taskDataEvents = [];
      noTaskDataEvents = [];

      // Set up event listeners
      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context });
      });

      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context });
      });

      // Create a mock task
      mockTask = {
        pending: true,
        onStdout: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;
    });

    it("should process stdout data with active task", function () {
      mockContext.getCurrentTask = () => mockTask;
      const testData = "test output";

      streamHandler.processStdout(testData, mockContext);

      expect(taskDataEvents).to.have.length(1);
      expect(taskDataEvents[0]?.data).to.eql(testData);
      expect(taskDataEvents[0]?.task).to.eql(mockTask);
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should ignore stdout data when process is ending", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => true;
      const testData = "test output";

      streamHandler.processStdout(testData, mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should emit noTaskData and end process for stdout without task", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => false;
      const testData = "unexpected output";

      streamHandler.processStdout(testData, mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(1);
      expect(noTaskDataEvents[0]?.stdout).to.eql(testData);
      expect(noTaskDataEvents[0]?.stderr).to.be.null;
      expect(endCalls).to.have.length(1);
      expect(endCalls[0]?.gracefully).to.be.false;
      expect(endCalls[0]?.reason).to.eql("stdout.error");
    });

    it("should ignore blank stdout data", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => false;

      streamHandler.processStdout("", mockContext);
      streamHandler.processStdout("   ", mockContext);
      streamHandler.processStdout("\n", mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should handle null stdout data", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => false;

      streamHandler.processStdout(null as any, mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should not process stdout when task is not pending", function () {
      const nonPendingTask = {
        pending: false,
        onStdout: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;

      mockContext.getCurrentTask = () => nonPendingTask;
      mockContext.isEnding = () => false;
      const testData = "test output";

      streamHandler.processStdout(testData, mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(1);
      expect(endCalls).to.have.length(1);
      expect(endCalls[0]?.reason).to.eql("stdout.error");
    });
  });

  describe("stderr processing", function () {
    let mockTask: Task<unknown>;
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = [];

    beforeEach(function () {
      noTaskDataEvents = [];

      // Set up event listeners
      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context });
      });

      // Create a mock task
      mockTask = {
        pending: true,
        onStderr: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;
    });

    it("should process stderr data with active task", function () {
      mockContext.getCurrentTask = () => mockTask;
      const testData = "error output";

      streamHandler.processStderr(testData, mockContext);

      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should ignore stderr data when process is ending", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => true;
      const testData = "error output";

      streamHandler.processStderr(testData, mockContext);

      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should emit noTaskData and end process for stderr without task", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => false;
      const testData = "unexpected error";

      streamHandler.processStderr(testData, mockContext);

      expect(noTaskDataEvents).to.have.length(1);
      expect(noTaskDataEvents[0]?.stdout).to.be.null;
      expect(noTaskDataEvents[0]?.stderr).to.eql(testData);
      expect(endCalls).to.have.length(1);
      expect(endCalls[0]?.gracefully).to.be.false;
      expect(endCalls[0]?.reason).to.eql("stderr");
    });

    it("should ignore blank stderr data", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => false;

      streamHandler.processStderr("", mockContext);
      streamHandler.processStderr("   ", mockContext);
      streamHandler.processStderr("\n", mockContext);

      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should not process stderr when task is not pending", function () {
      const nonPendingTask = {
        pending: false,
        onStderr: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;

      mockContext.getCurrentTask = () => nonPendingTask;
      mockContext.isEnding = () => false;
      const testData = "error output";

      streamHandler.processStderr(testData, mockContext);

      expect(noTaskDataEvents).to.have.length(1);
      expect(endCalls).to.have.length(1);
      expect(endCalls[0]?.reason).to.eql("stderr");
    });
  });

  describe("shouldIgnoreStderrLine", function () {
    const sharpWarningLines = [
      "[SharpElectronLinux] Warning: Binaries provided by Electron for use on Linux may be",
      "incompatible with sharp - see https://sharp.pixelplumbing.com/install#electron-and-linux",
    ];
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[];
    let warnings: string[];

    function ignoringHandler(
      shouldIgnoreStderrLine: (line: string) => boolean,
      streamFlushMillis = 30,
    ): StreamHandler {
      const testLogger: Logger = {
        ...NoLogger,
        warn: (message) => warnings.push(message),
      };
      const handlerOptions = {
        logger: () => testLogger,
        shouldIgnoreStderrLine,
        streamFlushMillis,
      };
      return new StreamHandler(handlerOptions, emitter);
    }

    beforeEach(function () {
      noTaskDataEvents = [];
      warnings = [];
      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context });
      });
    });

    it("assembles ignored lines across arbitrary chunks", function () {
      const seenLines: string[] = [];
      streamHandler = ignoringHandler((line) => {
        seenLines.push(line);
        return sharpWarningLines.includes(line);
      });
      const warning = sharpWarningLines[0] as string;

      streamHandler.processStderr(warning.slice(0, 24), mockContext);
      streamHandler.processStderr(warning.slice(24) + "\r", mockContext);
      streamHandler.processStderr("\n", mockContext);

      expect(seenLines).to.eql([warning]);
      expect(warnings).to.eql([]);
      expect(noTaskDataEvents).to.eql([]);
      expect(endCalls).to.eql([]);
    });

    it("retains errors alongside ignored lines", function () {
      streamHandler = ignoringHandler((line) =>
        sharpWarningLines.includes(line),
      );

      streamHandler.processStderr(
        sharpWarningLines[0] +
          "\nreal worker error\n" +
          sharpWarningLines[1] +
          "\n",
        mockContext,
      );

      expect(noTaskDataEvents).to.have.length(1);
      expect(noTaskDataEvents[0]?.stderr).to.eql("real worker error\n");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("real worker error");
      expect(warnings[0]).to.not.include("SharpElectronLinux");
      expect(endCalls).to.eql([{ gracefully: false, reason: "stderr" }]);
    });

    it("passes retained lines to the current task", function () {
      let taskStderr = "";
      const mockTask = {
        pending: true,
        onStderr: (data: string | Buffer) => {
          taskStderr += String(data);
        },
      } as unknown as Task<unknown>;
      mockContext.getCurrentTask = () => mockTask;
      streamHandler = ignoringHandler((line) => line === "benign warning");

      streamHandler.processStderr(
        "benign warning\nreal task error\n",
        mockContext,
      );

      expect(taskStderr).to.eql("real task error\n");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("real task error");
      expect(warnings[0]).to.not.include("benign warning");
    });

    it("evaluates an unterminated final line when stderr ends", function () {
      streamHandler = ignoringHandler((line) => line === "benign warning");

      streamHandler.processStderr("benign warning", mockContext);
      streamHandler.endStderr(mockContext);

      expect(warnings).to.eql([]);
      expect(noTaskDataEvents).to.eql([]);
      expect(endCalls).to.eql([]);
    });

    it("flushes taskless unterminated stderr after a quiet period", function () {
      const clock = FakeTimers.install();
      try {
        streamHandler = ignoringHandler(() => false, 30);

        streamHandler.processStderr("real worker error", mockContext);
        expect(noTaskDataEvents).to.eql([]);

        clock.tick(30);

        expect(noTaskDataEvents[0]?.stderr).to.eql("real worker error");
        expect(endCalls).to.eql([{ gracefully: false, reason: "stderr" }]);
      } finally {
        clock.uninstall();
      }
    });

    it("retains taskless ownership when a task starts mid-line", function () {
      let taskStderr = "";
      let currentTask: Task<unknown> | undefined = undefined;
      mockContext.getCurrentTask = () => currentTask;
      streamHandler = ignoringHandler(() => false);

      streamHandler.processStderr("real worker error", mockContext);
      currentTask = {
        pending: true,
        onStderr: (data: string | Buffer) => {
          taskStderr += String(data);
        },
      } as unknown as Task<unknown>;
      streamHandler.processStderr("\n", mockContext);

      expect(taskStderr).to.eql("");
      expect(noTaskDataEvents[0]?.stderr).to.eql("real worker error\n");
      expect(endCalls).to.eql([{ gracefully: false, reason: "stderr" }]);
    });

    it("wakes scheduling after an ignored partial line completes", function () {
      streamHandler = ignoringHandler((line) => line === "benign warning");

      streamHandler.processStderr("benign", mockContext);
      expect(streamHandler.hasIncompleteStderrLine).to.eql(true);
      streamHandler.processStderr(" warning\n", mockContext);

      expect(streamHandler.hasIncompleteStderrLine).to.eql(false);
      expect(onIdleCalls).to.eql(1);
      expect(noTaskDataEvents).to.eql([]);
      expect(endCalls).to.eql([]);
    });

    it("fails closed when an unterminated line exceeds 64 KiB", function () {
      let predicateCalls = 0;
      streamHandler = ignoringHandler(() => {
        predicateCalls++;
        return true;
      });

      streamHandler.processStderr("x".repeat(64 * 1024 + 1), mockContext);

      expect(predicateCalls).to.eql(0);
      expect(noTaskDataEvents).to.have.length(1);
      expect(noTaskDataEvents[0]?.stderr).to.have.length(64 * 1024 + 1);
      expect(endCalls).to.eql([{ gracefully: false, reason: "stderr" }]);
    });

    it("preserves UTF-8 code points split across Buffer chunks", function () {
      const warning = "benign ⚠️ warning";
      const bytes = Buffer.from(warning + "\n");
      const splitAt = bytes.indexOf(Buffer.from("⚠️")) + 1;
      const seenLines: string[] = [];
      streamHandler = ignoringHandler((line) => {
        seenLines.push(line);
        return line === warning;
      });

      streamHandler.processStderr(bytes.subarray(0, splitAt), mockContext);
      streamHandler.processStderr(bytes.subarray(splitAt), mockContext);

      expect(seenLines).to.eql([warning]);
      expect(noTaskDataEvents).to.eql([]);
      expect(endCalls).to.eql([]);
    });

    it("fails closed when the predicate throws", function () {
      streamHandler = ignoringHandler(() => {
        throw new Error("predicate failure");
      });

      streamHandler.processStderr("worker output\n", mockContext);

      expect(noTaskDataEvents[0]?.stderr).to.eql("worker output\n");
      expect(warnings[0]).to.include("worker output");
      expect(onErrorCalls).to.have.length(1);
      expect(onErrorCalls[0]?.reason).to.eql("stderr.error");
      expect(onErrorCalls[0]?.error.message).to.include("predicate failure");
    });
  });

  describe("utility methods", function () {
    it("should correctly identify blank data", function () {
      expect(streamHandler.isBlankData("")).to.be.true;
      expect(streamHandler.isBlankData("   ")).to.be.true;
      expect(streamHandler.isBlankData("\n")).to.be.true;
      expect(streamHandler.isBlankData("\t")).to.be.true;
      expect(streamHandler.isBlankData(null)).to.be.true;
      expect(streamHandler.isBlankData(undefined)).to.be.true;

      expect(streamHandler.isBlankData("text")).to.be.false;
      expect(streamHandler.isBlankData("  text  ")).to.be.false;
      expect(streamHandler.isBlankData(Buffer.from("data"))).to.be.false;
    });

    it("should provide handler statistics", function () {
      const stats = streamHandler.getStats();

      expect(stats).to.have.property("handlerActive");
      expect(stats).to.have.property("emitterConnected");
      expect(stats.handlerActive).to.be.true;
      expect(stats.emitterConnected).to.be.true;
    });
  });

  describe("buffer handling", function () {
    let mockTask: Task<unknown>;
    let taskDataEvents: { data: any; task: any; context: any }[] = [];

    beforeEach(function () {
      taskDataEvents = [];

      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context });
      });

      mockTask = {
        pending: true,
        onStdout: () => {
          /* mock implementation */
        },
        onStderr: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;
    });

    it("should handle Buffer data in stdout", function () {
      mockContext.getCurrentTask = () => mockTask;
      const bufferData = Buffer.from("test buffer data");

      streamHandler.processStdout(bufferData, mockContext);

      expect(taskDataEvents).to.have.length(1);
      expect(taskDataEvents[0]?.data).to.eql(bufferData);
    });

    it("should handle Buffer data in stderr", function () {
      mockContext.getCurrentTask = () => mockTask;
      const bufferData = Buffer.from("error buffer data");

      // Should not throw and should process normally
      expect(() => {
        streamHandler.processStderr(bufferData, mockContext);
      }).to.not.throw();
    });
  });

  describe("integration scenarios", function () {
    let mockTask: Task<unknown>;
    let taskDataEvents: { data: any; task: any; context: any }[] = [];
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = [];

    beforeEach(function () {
      taskDataEvents = [];
      noTaskDataEvents = [];

      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context });
      });

      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context });
      });

      mockTask = {
        pending: true,
        onStdout: () => {
          /* mock implementation */
        },
        onStderr: () => {
          /* mock implementation */
        },
      } as unknown as Task<unknown>;
    });

    it("should handle mixed stdout and stderr with active task", function () {
      mockContext.getCurrentTask = () => mockTask;

      streamHandler.processStdout("stdout data", mockContext);
      streamHandler.processStderr("stderr data", mockContext);

      expect(taskDataEvents).to.have.length(1);
      expect(taskDataEvents[0]?.data).to.eql("stdout data");
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });

    it("should handle task completion scenario", function () {
      // Start with active task
      mockContext.getCurrentTask = () => mockTask;
      streamHandler.processStdout("initial output", mockContext);

      expect(taskDataEvents).to.have.length(1);

      // Task completes, no current task
      mockContext.getCurrentTask = () => undefined;
      streamHandler.processStdout("stray output", mockContext);

      expect(noTaskDataEvents).to.have.length(1);
      expect(endCalls).to.have.length(1);
      expect(endCalls[0]?.reason).to.eql("stdout.error");
    });

    it("should handle process ending scenario", function () {
      mockContext.getCurrentTask = () => undefined;
      mockContext.isEnding = () => true;

      streamHandler.processStdout("final output", mockContext);
      streamHandler.processStderr("final error", mockContext);

      expect(taskDataEvents).to.have.length(0);
      expect(noTaskDataEvents).to.have.length(0);
      expect(endCalls).to.have.length(0);
    });
  });
});
