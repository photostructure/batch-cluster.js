import events from "node:events";
import { expect } from "./_chai.spec";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { logger, NoLogger } from "./Logger";
import { SimpleParser } from "./Parser";
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
  describe("stderr logging", () => {
    let warnings: string[];
    beforeEach(() => (warnings = []));
    const opts = () =>
      mkOpts({
        logger: () => ({ ...NoLogger, warn: (s) => warnings.push(s) }),
      });

    it("logs stderr at warn, and skips blank stderr", () => {
      const task = new Task("test", SimpleParser);
      task.onStart(opts());
      task.onStderr("real error\n");
      task.onStderr(" \n");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("real error");
    });

    it("logs only the stderr a subclass passes to super.onStderr()", () => {
      // exiftool-vendored removes ExifTool's progress lines this way:
      class FilteringTask extends Task<string> {
        override onStderr(buf: string | Buffer): void {
          super.onStderr(buf.toString().replace(/^\{progress:\d+\}\n/gm, ""));
        }
      }
      const task = new FilteringTask("test", SimpleParser);
      task.onStart(opts());
      task.onStderr("{progress:10}\n");
      task.onStderr("{progress:20}\nreal error\n");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("real error");
      expect(warnings[0]).to.not.include("progress");
    });
  });

  describe("failure precedence", () => {
    for (const streamFlushMillis of [0, 30]) {
      it(`retains a failure discovered by beforeParse (${streamFlushMillis} ms)`, async () => {
        // R572-A: buffered FAIL must reach the parser as passed=false, even
        // when PASS has already entered the guarded beforeParse flush.
        const outcomes: boolean[] = [];
        const task = new Task("test", (stdout, stderr, passed) => {
          outcomes.push(passed);
          return SimpleParser(stdout, stderr, passed);
        });
        task.onStart(mkOpts({ streamFlushMillis }), () =>
          task.onStderr("FAIL"),
        );
        task.onStdout("PASS\n");
        await expect(task.promise).to.be.rejectedWith("task failed");
        expect(outcomes).to.eql([false]);
      });
    }
  });

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
