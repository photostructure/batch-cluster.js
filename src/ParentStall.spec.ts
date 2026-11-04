import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import timers from "node:timers";
import { expect } from "./_chai.spec";
import { until } from "./Async";
import { TaskTimeoutError } from "./BatchCluster";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { BatchProcessOptions } from "./BatchProcessOptions";
import { verifyOptions } from "./OptionsVerifier";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";

// A synchronous block in the parent that outlasts taskTimeoutMillis must not
// time out a task whose child replied during the block. Each case below
// follows a different event-loop path from "the reply is in the pipe" to "the
// overdue task timer fires".
const fixture = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'version') console.log('ready\\nPASS');
  else if (line === 'line-then-pass') {
    console.log('first');
    setTimeout(() => console.log('PASS'), 200);
  } else if (line === 'late-reply') {
    setTimeout(() => console.log('late\\nPASS'), 200);
  } else if (line === 'progress') {
    console.log('first');
    setTimeout(() => console.log('step'), 200);
    setTimeout(() => console.log('done\\nPASS'), 1750);
  } else if (line === 'exit') {
    console.log('first');
    setTimeout(() => process.exit(3), 200);
  } else if (line === 'big-reply') {
    setTimeout(() => console.log('x'.repeat(400000) + '\\nPASS'), 200);
  } else if (line === 'stderr-fail') {
    setTimeout(() => process.stderr.write('FAIL'), 200);
  } else if (line === 'steady-progress') {
    const steps = setInterval(() => console.log('step'), 100);
    setTimeout(() => {
      clearInterval(steps);
      console.log('done\\nPASS');
    }, 4500);
  } else if (line === 'version-then-exit') {
    console.log('starting');
    setTimeout(() => process.exit(3), 200);
  } else if (line === 'partial-hang') {
    setTimeout(() => process.stdout.write('partial'), 100);
  } else if (line === 'one-line') {
    console.log('first');
  } else if (line === 'chatter') {
    setInterval(() => console.log('step'), 5);
  }
  // 'hang' never replies.
});
`;

const taskTimeoutMillis = 500;
const blockMillis = 1500;

function block(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait, like a long synchronous call in the parent
  }
}

describe("parent event-loop stall", function () {
  this.timeout(15000);
  let bp: BatchProcess;
  let observer: BatchClusterEmitter;

  // Spawns the fixture without waiting for its startup task. Listeners added
  // by beforeStart see the startup task's events.
  function launch({
    versionCommand = "version",
    shouldIgnoreStderrLine,
    isRetirementRequest,
    streamFlushMillis = 10,
    beforeStart,
  }: {
    versionCommand?: string;
    isRetirementRequest?: BatchProcessOptions["isRetirementRequest"];
    streamFlushMillis?: number | undefined;
    shouldIgnoreStderrLine?: ((line: string) => boolean) | undefined;
    beforeStart?: () => void;
  } = {}): void {
    observer = new EventEmitter() as BatchClusterEmitter;
    beforeStart?.();
    const proc = spawn(process.execPath, ["-e", fixture]);
    const opts = verifyOptions({
      observer,
      processFactory: () => proc,
      versionCommand,
      pass: "PASS",
      fail: "FAIL",
      streamFlushMillis,
      taskTimeoutMillis,
      spawnTimeoutMillis: taskTimeoutMillis,
      maxProcAgeMillis: 0,
      shouldIgnoreStderrLine,
      isRetirementRequest,
    });
    bp = new BatchProcess(proc, opts, () => undefined);
  }

  async function start(
    shouldIgnoreStderrLine?: (line: string) => boolean,
    streamFlushMillis?: number,
  ): Promise<void> {
    launch({ shouldIgnoreStderrLine, streamFlushMillis });
    await bp.currentTask!.promise;
  }

  async function stop(): Promise<void> {
    bp.proc.kill("SIGKILL");
    await bp.end(false, "ending").catch(() => undefined);
    expect(await until(() => bp.exited, 5000, 5)).to.eql(true);
  }

  beforeEach(() => start());
  afterEach(() => stop());

  // Blocks the parent 20 ms after the command is sent, before the child
  // replies, so the reply waits in the pipe until the block ends.
  function blockSoon(): void {
    timers.setTimeout(() => block(blockMillis), 20);
  }

  async function settle<T>(task: Task<T>): Promise<unknown> {
    return task.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
  }

  it("resolves when the reply arrives while an I/O callback blocks", async function () {
    // After a block in an I/O callback, the timers phase runs before the next
    // poll reads the reply.
    const chunks: string[] = [];
    class BlockingTask extends Task<string> {
      override onStdout(buf: string | Buffer): void {
        chunks.push(buf.toString());
        if (chunks.length === 1) block(blockMillis);
        super.onStdout(buf);
      }
    }
    const task = new BlockingTask("line-then-pass", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    expect((await task.promise).trim()).to.eql("first");
    // Otherwise the reply never waited behind the block:
    expect(chunks[0]).to.not.include("PASS");
  });

  it("resolves when the reply is read right after a timer callback blocks", async function () {
    // After a block in a timer callback, the poll phase reads the reply first,
    // so the task's streamFlushMillis timer is armed after the overdue task
    // timer.
    const stdoutBeforeBlock: string[] = [];
    let blocking = false;
    class RecordingTask extends Task<string> {
      override onStdout(buf: string | Buffer): void {
        if (!blocking) stdoutBeforeBlock.push(buf.toString());
        super.onStdout(buf);
      }
    }
    const task = new RecordingTask("late-reply", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    timers.setTimeout(() => {
      blocking = true;
      block(blockMillis);
    }, 20);
    expect((await task.promise).trim()).to.eql("late");
    // Otherwise the reply never waited behind the block:
    expect(stdoutBeforeBlock).to.eql([]);
  });

  it("honors a timeout reset made after the deadline passed during a block", async function () {
    // The child reports progress during the block. The task credits it after
    // its timer already fired, so the reset must re-arm that timer.
    const chunks: string[] = [];
    let reset: boolean | undefined;
    class ProgressTask extends Task<string> {
      override onStdout(buf: string | Buffer): void {
        const chunk = buf.toString();
        chunks.push(chunk);
        if (chunks.length === 1) block(blockMillis);
        if (chunk.includes("step")) reset = this.resetTimeout();
        super.onStdout(buf);
      }
    }
    const task = new ProgressTask("progress", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    expect((await task.promise).trim().split(/\s+/)).to.eql([
      "first",
      "step",
      "done",
    ]);
    expect(reset).to.eql(true);
    // Otherwise the completion token, not the reset, kept the task alive:
    expect(chunks.find((ea) => ea.includes("step"))).to.not.include("PASS");
  });

  it("doesn't report a timeout for a child that exited during a block", async function () {
    // The child exits during the block. Its stdout ends after the overdue
    // timer runs, so the task waits, and the child's exit ends the process.
    // end() then settles the task, so a taskTimeout event would describe a
    // task it never rejected.
    const timeouts: string[] = [];
    observer.on("taskTimeout", (_ms, task) => timeouts.push(task.state));
    const chunks: string[] = [];
    class BlockingTask extends Task<string> {
      override onStdout(buf: string | Buffer): void {
        chunks.push(buf.toString());
        if (chunks.length === 1) block(blockMillis);
        super.onStdout(buf);
      }
    }
    const task = new BlockingTask("exit", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const error = await task.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).to.be.instanceOf(Error);
    expect(error).to.not.be.instanceOf(TaskTimeoutError);
    expect(timeouts).to.eql([]);
  });

  it("resolves a reply too large to fit in the pipe during a block", async function () {
    // The child can only write the rest of its reply once the parent reads
    // again, so the completion token arrives several reads after the block.
    const task = new Task("big-reply", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    blockSoon();
    expect((await task.promise).trim().length).to.eql(400000);
  });

  it("delivers an unterminated stderr failure token written during a block", async function () {
    // With shouldIgnoreStderrLine set, the stream handler holds a stderr
    // fragment until its flush timer runs, which is after the poll phase that
    // read it.
    await stop();
    await start(() => false);
    const timeouts: number[] = [];
    observer.on("taskTimeout", (ms) => timeouts.push(ms));
    const task = new Task("stderr-fail", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    blockSoon();
    const error = await settle(task);
    expect(error).to.be.instanceOf(Error);
    expect(error).to.not.be.instanceOf(TaskTimeoutError);
    expect(timeouts).to.eql([]);
  });

  it("waits for a task that read its failure token after the block", async function () {
    // Handling the stderr fragment blocks the parent for 30 ms, as a loaded
    // parent might, so the Task's own streamFlushMillis wait ends after the
    // next drain check. That check must see the task settling, not idle.
    await stop();
    await start(() => false);
    const timeouts: number[] = [];
    observer.on("taskTimeout", (ms) => timeouts.push(ms));
    class SlowStderrTask extends Task<string> {
      #blocked = false;
      override onStderr(buf: string | Buffer): void {
        if (!this.#blocked) {
          this.#blocked = true;
          block(30);
        }
        super.onStderr(buf);
      }
    }
    const task = new SlowStderrTask("stderr-fail", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    blockSoon();
    const error = await settle(task);
    expect(error).to.be.instanceOf(Error);
    expect(error).to.not.be.instanceOf(TaskTimeoutError);
    expect(timeouts).to.eql([]);
  });

  it("rejects the startup task when the child exits during a block", async function () {
    // The overdue spawn timer starts reading output, the next poll phase reads
    // the child's exit, and end() stops that reading before its first check.
    // Termination doesn't wait for a startup task, but it must still settle
    // it. childEnd reports the exit, so no startError is emitted.
    await stop();
    const startErrors: Error[] = [];
    let blocked = false;
    launch({
      versionCommand: "version-then-exit",
      beforeStart: () => {
        observer.on("startError", (err) => startErrors.push(err));
        observer.on("taskData", () => {
          if (blocked) return;
          blocked = true;
          block(blockMillis);
        });
      },
    });
    const error = await settle(bp.currentTask!);
    expect(blocked).to.eql(true);
    expect(error).to.be.instanceOf(Error);
    expect(startErrors).to.eql([]);
  });

  it("survives a second stall when the task reported progress in between", async function () {
    // resetTimeout() sets a new deadline, and a later block past that deadline
    // gets its own catch-up reading. The parent blocks in the first stdout
    // callback, and again in the first one after 2.5 s, while the child keeps
    // reporting progress. The chunk that triggers a block isn't credited, so
    // the overdue timer runs before the next progress line resets it.
    const started = Date.now();
    let stalls = 0;
    class SteadyTask extends Task<string> {
      override onStdout(buf: string | Buffer): void {
        if (stalls === 0 || (stalls === 1 && Date.now() - started > 2500)) {
          stalls++;
          block(blockMillis);
        } else if (buf.toString().includes("step")) {
          this.resetTimeout();
        }
        super.onStdout(buf);
      }
    }
    const task = new SteadyTask("steady-progress", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    expect((await task.promise).trim().split(/\s+/).at(-1)).to.eql("done");
    expect(stalls).to.eql(2);
  });

  it("times out a child that never replies as soon as the block ends", async function () {
    // The read after the block finds nothing new, so there is nothing to wait
    // for. The block ends about 20 + 1500 = 1520 ms after the command.
    const task = new Task("hang", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    blockSoon();
    const error = await settle(task);
    expect(error).to.be.instanceOf(TaskTimeoutError);
    // Waiting another task timeout would reject at about 2030 ms:
    expect(Date.now() - started).to.be.lessThan(20 + blockMillis + 300);
  });

  it("stops reading a child that keeps writing once the block's overrun is spent", async function () {
    // The child writes every 5 ms, but Windows timers fire about every 15.6 ms,
    // so a 10 ms streamFlushMillis can see no new output between two checks.
    // With 50 ms, the timer is due at 500 + 50 = 550 ms and runs when the
    // block ends at about 1520 ms, about 970 ms late. Reading output after the
    // deadline is capped at that lateness, so the task times out at about
    // 2490 ms.
    await stop();
    await start(undefined, 50);
    const task = new Task("chatter", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    blockSoon();
    const error = await settle(task);
    const elapsed = Date.now() - started;
    expect(error).to.be.instanceOf(TaskTimeoutError);
    // Capping at one more task timeout would reject at about 2070 ms:
    expect(elapsed).to.be.greaterThanOrEqual(2400);
    expect(elapsed).to.be.lessThan(2900);
  });

  it("stops reading at the block's overrun when that is shorter than streamFlushMillis", async function () {
    // With streamFlushMillis 200 the timer is due at 700 ms. The block ends at
    // about 760 ms, 60 ms late, so reading output must stop at about 820 ms,
    // not after a full wait between checks (about 960 ms before this fix).
    await stop();
    await start(undefined, 200);
    const task = new Task("chatter", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    timers.setTimeout(() => block(740), 20);
    const error = await settle(task);
    expect(error).to.be.instanceOf(TaskTimeoutError);
    expect(Date.now() - started).to.be.lessThan(900);
  });

  it("times out a child that hung after a partial line when retirement requests are enabled", async function () {
    // With isRetirementRequest set, StreamHandler holds a pending task's
    // partial line without scheduling a flush, so that line will never be
    // handled and must not keep the task waiting out the block's overrun
    // (about 2530 ms). The block ends about 1520 ms after the command.
    await stop();
    launch({ isRetirementRequest: () => false });
    await bp.currentTask!.promise;
    const task = new Task("partial-hang", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    blockSoon();
    const error = await settle(task);
    expect(error).to.be.instanceOf(TaskTimeoutError);
    expect(Date.now() - started).to.be.lessThan(20 + blockMillis + 300);
  });

  it("doesn't count output read before the deadline as still arriving", async function () {
    // The child writes one line at once and nothing more. Handling that line
    // blocks the parent past the 700 ms deadline, so the task times out as
    // soon as the block ends, at about 1500 ms. Timestamping the line after
    // its handler returned made it look new, which kept the task waiting two
    // more 200 ms checks.
    await stop();
    await start(undefined, 200);
    class BlockingTask extends Task<string> {
      #blocked = false;
      override onStdout(buf: string | Buffer): void {
        if (!this.#blocked) {
          this.#blocked = true;
          block(blockMillis);
        }
        super.onStdout(buf);
      }
    }
    const task = new BlockingTask("one-line", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    const error = await settle(task);
    expect(error).to.be.instanceOf(TaskTimeoutError);
    expect(Date.now() - started).to.be.lessThan(blockMillis + 150);
  });

  it("times out a child that keeps writing at its deadline without a block", async function () {
    // Without a block the timer is at most a few milliseconds late, so output
    // after the deadline buys the task no more than that.
    const task = new Task("chatter", SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    const started = Date.now();
    const error = await settle(task);
    expect(error).to.be.instanceOf(TaskTimeoutError);
    expect(Date.now() - started).to.be.lessThan(taskTimeoutMillis + 10 + 150);
  });
});
