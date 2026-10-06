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
  describe("stdout token precedence", () => {
    const readyRE = /\{ready\}/;
    for (const { name, passRE, failRE, output, passed } of [
      {
        name: "fails when FAIL is earlier than PASS",
        passRE: /PASS/,
        failRE: /FAIL/,
        output: "FAIL\nPASS\n",
        passed: false,
      },
      {
        name: "passes when PASS is earlier than FAIL",
        passRE: /PASS/,
        failRE: /FAIL/,
        output: "PASS\nFAIL\n",
        passed: true,
      },
      {
        name: "passes when both tokens match at the same position",
        passRE: readyRE,
        failRE: readyRE,
        output: "x\n{ready}\n",
        passed: true,
      },
      {
        name: "fails when NOT OK starts earlier than its overlapping OK token",
        passRE: /OK/,
        failRE: /NOT OK/,
        output: "NOT OK\n",
        passed: false,
      },
    ]) {
      it(name, async () => {
        const task = new Task("test", (_stdout, _stderr, passed) => passed);
        task.onStart(mkOpts({ streamFlushMillis: 0, passRE, failRE }));
        task.onStdout(output);
        expect(await task.promise).to.eql(passed);
      });
    }

    // A FAIL that arrives after PASS during the flush delay must not change the
    // result, or the outcome would depend on how the output was split.
    for (const chunks of [["PASS\nFAIL\n"], ["PASS\n", "FAIL\n"]]) {
      it(`preserves the first stdout completion during the flush delay (chunk count: ${chunks.length})`, async () => {
        const task = new Task("test", (stdout, _stderr, passed) => ({
          stdout,
          passed,
        }));
        task.onStart(
          mkOpts({ streamFlushMillis: 30, passRE: /PASS\n/, failRE: /FAIL\n/ }),
        );
        for (const chunk of chunks) task.onStdout(chunk);
        expect(await task.promise).to.eql({ stdout: "FAIL\n", passed: true });
      });
    }

    for (const { firstOutput, nextOutput, expected } of [
      {
        firstOutput: "PASS\nFAIL\n",
        nextOutput: "FAIL\n",
        expected: [true, false],
      },
      {
        firstOutput: "FAIL\nPASS\n",
        nextOutput: "PASS\n",
        expected: [false, true],
      },
    ]) {
      it(`does not carry a losing global token match into the next task (${expected[0]})`, async () => {
        const opts = mkOpts({
          streamFlushMillis: 0,
          passRE: /PASS/g,
          failRE: /FAIL/g,
        });
        const outcomes: boolean[] = [];
        const parser = (
          _stdout: string,
          _stderr: string | undefined,
          passed: boolean,
        ) => {
          outcomes.push(passed);
          return passed;
        };
        const first = new Task("first", parser);
        first.onStart(opts);
        first.onStdout(firstOutput);
        await first.promise;
        const next = new Task("next", parser);
        next.onStart(opts);
        next.onStdout(nextOutput);
        // Assert before awaiting so a missed completion fails immediately.
        expect(outcomes).to.eql(expected);
        await next.promise;
      });
    }
  });

  it("does not carry a sticky stdout token match into the next task's stderr", async () => {
    // Removing a stdout token must not move a shared /y regex's lastIndex, or
    // the next task's stderr FAIL is missed.
    const opts = mkOpts({ streamFlushMillis: 0, failRE: /FAIL/y });
    const outcomes: boolean[] = [];
    const parser = (
      _out: string,
      _err: string | undefined,
      passed: boolean,
    ) => {
      outcomes.push(passed);
      return passed;
    };
    const first = new Task("first", parser);
    first.onStart(opts);
    first.onStdout("FAIL");
    await first.promise;
    const next = new Task("next", parser);
    next.onStart(opts);
    next.onStderr("FAIL");
    expect(outcomes).to.eql([false, false]);
    await next.promise;
  });

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
      it(`retains a beforeParse failure after a losing global fail match (${streamFlushMillis} ms)`, async () => {
        // A losing stdout probe must not move a shared /g regex's lastIndex, or
        // the beforeParse stderr FAIL is missed.
        const task = new Task("test", (_stdout, _stderr, passed) => passed);
        task.onStart(mkOpts({ streamFlushMillis, failRE: /FAIL/g }), () =>
          task.onStderr("FAIL"),
        );
        task.onStdout("PASS\nFAIL\n");
        expect(await task.promise).to.eql(false);
      });

      it(`retains a failure discovered by beforeParse (${streamFlushMillis} ms)`, async () => {
        // Buffered FAIL must reach the parser as passed=false, even
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
