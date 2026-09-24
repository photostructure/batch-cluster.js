import FakeTimers from "@sinonjs/fake-timers";
import child_process from "node:child_process";
import events from "node:events";
import { expect, processFactory } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { logger, Logger, NoLogger } from "./Logger";
import { SimpleParser } from "./Parser";
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
  let retirementRequests = 0;

  const options: StreamHandlerOptions = {
    logger,
  };

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter;
    streamHandler = new StreamHandler(options, emitter);

    onErrorCalls = [];
    endCalls = [];
    onIdleCalls = 0;
    retirementRequests = 0;

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
      requestRetirement: () => {
        retirementRequests++;
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

    it("logs stderr for a pending task once, through the task", function () {
      const warnings: string[] = [];
      const testLogger = () => ({
        ...NoLogger,
        warn: (s: string) => warnings.push(s),
      });
      streamHandler = new StreamHandler({ logger: testLogger }, emitter);
      const task = new Task<unknown>("test", SimpleParser);
      task.onStart({
        streamFlushMillis: 0,
        logger: testLogger,
        observer: emitter,
        passRE: /PASS\n/,
        failRE: /FAIL\n/,
      });
      mockContext.getCurrentTask = () => task;

      streamHandler.processStderr("real error\n", mockContext);

      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("real error");
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
      // The task logs the stderr it keeps (see Task.onStderr):
      expect(warnings).to.eql([]);
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

  describe("isRetirementRequest", function () {
    const marker = "{photostructure:retire}";
    let seen: { line: string; stream: string }[];
    let stdout: string;
    let stderr: string;
    let warnings: string[];
    let taskData: string[];
    let noTaskData: unknown[];

    beforeEach(function () {
      seen = [];
      stdout = "";
      stderr = "";
      warnings = [];
      taskData = [];
      noTaskData = [];
      streamHandler = new StreamHandler(
        {
          logger: () => ({ ...NoLogger, warn: (s) => warnings.push(s) }),
          streamFlushMillis: 0,
          isRetirementRequest: (line, stream) => {
            seen.push({ line, stream });
            return line === marker;
          },
        },
        emitter,
      );
      const task = {
        pending: true,
        onStdout: (data: string | Buffer) => {
          stdout += String(data);
        },
        onStderr: (data: string | Buffer) => {
          stderr += String(data);
        },
      } as unknown as Task<unknown>;
      mockContext.getCurrentTask = () => task;
      emitter.on("taskData", (data) => taskData.push(String(data)));
      emitter.on("noTaskData", (...args) => noTaskData.push(args));
    });

    for (const stream of ["stdout", "stderr"] as const) {
      const write = (
        handler: StreamHandler,
        data: string | Buffer,
        context: StreamContext,
      ) =>
        stream === "stdout"
          ? handler.processStdout(data, context)
          : handler.processStderr(data, context);

      it(`consumes ${stream} markers and preserves surrounding output`, function () {
        write(streamHandler, `before\r\n${marker}\r\nafter\n`, mockContext);
        expect(retirementRequests).to.eql(1);
        expect(stream === "stdout" ? stdout : stderr).to.eql(
          "before\r\nafter\n",
        );
        expect(taskData.join("")).to.not.include(marker);
        expect(warnings.join("")).to.not.include(marker);
        expect(noTaskData).to.eql([]);
        expect(seen).to.eql([
          { line: "before", stream },
          { line: marker, stream },
          { line: "after", stream },
        ]);
      });

      it(`assembles ${stream} markers across delayed chunks`, function () {
        const clock = FakeTimers.install();
        try {
          write(streamHandler, marker.slice(0, 9), mockContext);
          clock.tick(1000);
          expect(retirementRequests).to.eql(0);
          expect(stdout + stderr).to.eql("");
          expect(streamHandler.hasIncompleteOutputLine).to.eql(true);
          write(streamHandler, marker.slice(9) + "\r", mockContext);
          clock.tick(1000);
          write(streamHandler, "\n", mockContext);
          expect(retirementRequests).to.eql(1);
          expect(streamHandler.hasIncompleteOutputLine).to.eql(false);
          expect(stdout + stderr).to.eql("");
        } finally {
          clock.uninstall();
        }
      });

      it(`decodes split UTF-8 ${stream} lines`, function () {
        for (const byte of Buffer.from("ordinary 🌻 output\n")) {
          write(streamHandler, Buffer.from([byte]), mockContext);
        }
        expect(seen).to.eql([{ line: "ordinary 🌻 output", stream }]);
        expect(stdout + stderr).to.eql("ordinary 🌻 output\n");
      });

      it(`keeps ${stream} ownership when a chunk ends with an undecoded code point after a newline`, function () {
        const bytes = Buffer.from("first\n🌻 second\n");
        write(streamHandler, bytes.subarray(0, 7), mockContext);
        expect(streamHandler.hasIncompleteOutputLine).to.eql(true);
        write(streamHandler, bytes.subarray(7), mockContext);
        expect(streamHandler.hasIncompleteOutputLine).to.eql(false);
        expect(stdout + stderr).to.eql("first\n🌻 second\n");
      });

      it(`consumes idle ${stream} requests without treating them as stray output`, function () {
        mockContext.getCurrentTask = () => undefined;
        write(streamHandler, marker + "\n", mockContext);
        expect(retirementRequests).to.eql(1);
        expect(noTaskData).to.eql([]);
        expect(warnings).to.eql([]);
        expect(endCalls).to.eql([]);
      });

      it(`releases an idle ${stream} fragment after the flush interval`, function () {
        // A taskless fragment must reach normal stray-output handling
        // without relying on EOF, worker age, or another task starting.
        const clock = FakeTimers.install();
        try {
          mockContext.getCurrentTask = () => undefined;
          write(streamHandler, "progress: 50%", mockContext);
          expect(streamHandler.hasIncompleteOutputLine).to.eql(true);
          clock.tick(1);
          expect(streamHandler.hasIncompleteOutputLine).to.eql(false);
          expect(noTaskData).to.have.length(1);
          expect(endCalls).to.eql([
            {
              gracefully: false,
              reason: stream === "stdout" ? "stdout.error" : "stderr",
            },
          ]);
          expect(retirementRequests).to.eql(0);
        } finally {
          clock.uninstall();
        }
      });

      it(`cancels the idle ${stream} timer when a split retirement line completes`, function () {
        const clock = FakeTimers.install();
        try {
          mockContext.getCurrentTask = () => undefined;
          write(streamHandler, marker.slice(0, 9), mockContext);
          write(streamHandler, marker.slice(9) + "\n", mockContext);
          clock.tick(100);
          expect(retirementRequests).to.eql(1);
          expect(noTaskData).to.eql([]);
          expect(streamHandler.hasIncompleteOutputLine).to.eql(false);
          expect(clock.countTimers()).to.eql(0);
        } finally {
          clock.uninstall();
        }
      });

      it(`does not recognize an idle ${stream} marker across a timer flush`, function () {
        const clock = FakeTimers.install();
        try {
          mockContext.getCurrentTask = () => undefined;
          write(streamHandler, "prefix ", mockContext);
          clock.tick(1);
          write(streamHandler, marker + "\n", mockContext);
          expect(retirementRequests).to.eql(0);
          expect(noTaskData).to.have.length(2);
          write(streamHandler, marker + "\n", mockContext);
          expect(retirementRequests).to.eql(1);
        } finally {
          clock.uninstall();
        }
      });

      it(`bypasses recognition for oversized ${stream} lines, including their tails`, function () {
        const prefix = "x".repeat(64 * 1024 + 1);
        write(streamHandler, prefix, mockContext);
        expect(stdout + stderr).to.eql(prefix);
        write(streamHandler, marker + "\n" + marker + "\n", mockContext);
        expect(seen).to.eql([{ line: marker, stream }]);
        expect(retirementRequests).to.eql(1);
        expect(stdout + stderr).to.eql(prefix + marker + "\n");
      });

      it(`retains unterminated ${stream} markers at EOF`, function () {
        write(streamHandler, marker, mockContext);
        if (stream === "stdout") {
          streamHandler.endStdout(mockContext);
          streamHandler.endStdout(mockContext);
        } else {
          streamHandler.endStderr(mockContext);
          streamHandler.endStderr(mockContext);
        }
        expect(retirementRequests).to.eql(0);
        expect(seen).to.eql([]);
        expect(stdout + stderr).to.eql(marker);
        expect(streamHandler.hasIncompleteOutputLine).to.eql(false);
      });

      it(`contains exceptions from the ${stream} predicate before task completion`, async function () {
        let parserCalls = 0;
        const task = new Task<unknown>("test", () => {
          parserCalls++;
        });
        task.onStart({
          streamFlushMillis: 0,
          logger,
          observer: emitter,
          passRE: /PASS/,
          failRE: /FAIL/,
        });
        mockContext.getCurrentTask = () => task;
        const originalOnError = mockContext.onError;
        mockContext.onError = (reason, error) => {
          originalOnError(reason, error);
          task.reject(error);
          mockContext.isEnding = () => true;
        };
        streamHandler = new StreamHandler(
          {
            logger,
            isRetirementRequest: () => {
              throw new Error("bad recognizer");
            },
          },
          emitter,
        );
        write(streamHandler, "PASS\n", mockContext);
        await expect(task.promise).to.be.rejectedWith(
          "isRetirementRequest threw: bad recognizer",
        );
        expect(parserCalls).to.eql(0);
        expect(onErrorCalls[0]?.reason).to.eql(`${stream}.error`);
        expect(retirementRequests).to.eql(0);
      });
    }

    it("recognizes retirement before parsing a completion token in the same chunk", async function () {
      const task = new Task<unknown>("test", (out, err, passed) => {
        expect(retirementRequests).to.eql(1);
        expect(passed).to.eql(true);
        expect(err).to.eql("");
        return out;
      });
      task.onStart({
        streamFlushMillis: 0,
        logger,
        observer: emitter,
        passRE: /PASS\n/,
        failRE: /FAIL\n/,
      });
      mockContext.getCurrentTask = () => task;
      streamHandler.processStdout(`result\n${marker}\nPASS\n`, mockContext);
      expect(await task.promise).to.eql("result\n");
    });

    it("recognizes retirement before stderr filtering and retains real errors", function () {
      const ignored: string[] = [];
      streamHandler = new StreamHandler(
        {
          logger: () => ({ ...NoLogger, warn: (s) => warnings.push(s) }),
          isRetirementRequest: (line) => line === marker,
          shouldIgnoreStderrLine: (line) => {
            ignored.push(line);
            return line === "advisory";
          },
        },
        emitter,
      );
      streamHandler.processStderr(
        `${marker}\nadvisory\nreal error\n`,
        mockContext,
      );
      expect(retirementRequests).to.eql(1);
      expect(ignored).to.eql(["advisory", "real error"]);
      expect(stderr).to.eql("real error\n");
      // The task logs the stderr it keeps (see Task.onStderr):
      expect(warnings).to.eql([]);
    });

    it("flushes ordinary unterminated stderr before parsing", async function () {
      const task = new Task<unknown>("test", (_out, err) => err);
      task.onStart(
        {
          streamFlushMillis: 0,
          logger,
          observer: emitter,
          passRE: /PASS\n/,
          failRE: /FAIL\n/,
        },
        () => streamHandler.flushStderrForTask(task, mockContext),
      );
      mockContext.getCurrentTask = () => task;
      streamHandler.processStderr("real error", mockContext);
      streamHandler.processStdout("PASS\n", mockContext);
      expect(await task.promise).to.eql("real error");
      expect(retirementRequests).to.eql(0);
    });

    it("does not recognize the suffix of stderr already flushed for task parsing", function () {
      streamHandler.processStderr("prefix ", mockContext);
      streamHandler.flushStderrForTask(
        mockContext.getCurrentTask()!,
        mockContext,
      );
      streamHandler.processStderr(marker + "\n", mockContext);
      expect(retirementRequests).to.eql(0);
      expect(stderr).to.eql("prefix " + marker + "\n");
      streamHandler.processStderr(marker + "\n", mockContext);
      expect(retirementRequests).to.eql(1);
    });

    it("preserves partial stdout when stderr completes the task", async function () {
      const task = new Task<unknown>("test", (out, err, passed) => ({
        out,
        err,
        passed,
      }));
      task.onStart(
        {
          streamFlushMillis: 0,
          logger,
          observer: emitter,
          passRE: /PASS\n/,
          failRE: /FAIL\n/,
        },
        () => streamHandler.flushOutputForTask(task, mockContext),
      );
      mockContext.getCurrentTask = () => task;
      streamHandler.processStdout("partial diagnostic", mockContext);
      streamHandler.processStderr("FAIL\n", mockContext);
      expect(await task.promise).to.eql({
        out: "partial diagnostic",
        err: "",
        passed: false,
      });
    });

    it("does not recognize the suffix of stdout already flushed for task parsing", function () {
      streamHandler.processStdout("prefix ", mockContext);
      streamHandler.flushOutputForTask(
        mockContext.getCurrentTask()!,
        mockContext,
      );
      streamHandler.processStdout(marker + "\n", mockContext);
      expect(retirementRequests).to.eql(0);
      expect(stdout).to.eql("prefix " + marker + "\n");
      streamHandler.processStdout(marker + "\n", mockContext);
      expect(retirementRequests).to.eql(1);
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
