import events from "node:events";
import { expect } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { logger } from "./Logger";
import { Task, TaskOptions } from "./Task";

function mkOpts(overrides: Partial<TaskOptions> = {}): TaskOptions {
  return {
    streamFlushMillis: 200,
    observer: new events.EventEmitter() as BatchClusterEmitter,
    passRE: /PASS/,
    failRE: /FAIL/,
    logger,
    ...overrides,
  };
}

describe("Task", () => {
  describe("stream flush delays", () => {
    it("uses streamFlushMillis when token detected on stdout", async () => {
      const task = new Task("test", (stdout) => stdout);
      task.onStart(mkOpts({ streamFlushMillis: 100 }));

      const start = Date.now();
      task.onStdout("hello\nPASS\n");
      await task.promise;
      const elapsed = Date.now() - start;

      // Should use streamFlushMillis (100ms)
      expect(elapsed).to.be.greaterThanOrEqual(90);
    });

    it("uses streamFlushMillis when token detected on stderr", async () => {
      const task = new Task("test", (_stdout, _stderr, passed) => {
        if (!passed) throw new Error("failed");
        return "ok";
      });
      task.onStart(mkOpts({ streamFlushMillis: 100 }));

      const start = Date.now();
      task.onStderr("error\nFAIL\n");
      await expect(task.promise).to.be.rejected;
      const elapsed = Date.now() - start;

      // Should use the same streamFlushMillis (100ms) for both directions
      expect(elapsed).to.be.greaterThanOrEqual(90);
    });

    it("uses 0 delay when streamFlushMillis is 0", async () => {
      const task = new Task("test", (stdout) => stdout);
      task.onStart(mkOpts({ streamFlushMillis: 0 }));

      const start = Date.now();
      task.onStdout("hello\nPASS\n");
      await task.promise;
      const elapsed = Date.now() - start;

      expect(elapsed).to.be.lessThan(50);
    });

    it("fail token on stdout uses streamFlushMillis", async () => {
      const task = new Task("test", (_stdout, _stderr, passed) => {
        if (!passed) throw new Error("failed");
        return "ok";
      });
      task.onStart(mkOpts({ streamFlushMillis: 100 }));

      const start = Date.now();
      task.onStdout("error output\nFAIL\n");
      await expect(task.promise).to.be.rejected;
      const elapsed = Date.now() - start;

      // Fail token on stdout → same streamFlushMillis
      expect(elapsed).to.be.greaterThanOrEqual(90);
    });
  });
});
