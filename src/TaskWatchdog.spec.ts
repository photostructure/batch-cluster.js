import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { expect } from "./_chai.spec";
import { until } from "./Async";
import { BatchCluster, TaskTimeoutError } from "./BatchCluster";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { Deferred } from "./Deferred";
import { verifyOptions } from "./OptionsVerifier";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";
import { TaskQueueManager } from "./TaskQueueManager";

// Real child, with IPC only for test coordination. stdout remains the actual
// batch-cluster protocol under test. Keeping the event loop alive after stdin
// closes makes forced termination and failed cleanup observable.
const fixture = `
const readline = require('node:readline');
let count = 0;
let tick;
let finished = false;
setInterval(() => undefined, 1000);
process.on('message', message => {
  if (message === 'finish' && !finished) { finished = true; clearInterval(tick); console.log('done\\nPASS'); }
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'version') console.log('ready\\nPASS');
  else if (line === 'count') console.log(++count + '\\nPASS');
  else if (line === 'gate') console.log('started');
  else if (line === 'ticks') {
    let n = 0;
    console.log('started');
    tick = setInterval(() => console.log('step ' + ++n), 30);
  }
});
`;

const spawnFixture = () =>
  spawn(process.execPath, ["-e", fixture], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });

describe("request watchdog", function () {
  this.timeout(15000);
  let bp: BatchProcess;
  let observer: BatchClusterEmitter;
  const windowMs = 300;

  async function setup(
    taskTimeoutMillis = windowMs,
    cleanupChildProcs = true,
    versionCommand = "version",
    spawnTimeoutMillis = 5000,
  ) {
    observer = new EventEmitter() as BatchClusterEmitter;
    const proc = spawnFixture();
    const opts = verifyOptions({
      observer,
      processFactory: () => proc,
      versionCommand,
      pass: "PASS",
      fail: "FAIL",
      streamFlushMillis: 0,
      taskTimeoutMillis,
      spawnTimeoutMillis,
      maxProcAgeMillis: 0,
      cleanupChildProcs,
    });
    bp = new BatchProcess(proc, opts, () => undefined);
    await bp.currentTask!.promise;
  }

  afterEach(async function () {
    if (bp != null) {
      // Even the failed-cleanup case must not leave a fixture alive.
      bp.proc.kill("SIGKILL");
      await bp.end(false, "ending").catch(() => undefined);
      expect(await until(() => bp.exited, 5000, 5)).to.eql(true);
    }
  });

  function submit(command: string) {
    const task = new Task(command, SimpleParser);
    expect(bp.execTask(task)).to.eql(true);
    return task;
  }

  it("does not execute a rejected queued command", async function () {
    await setup();
    const queue = new TaskQueueManager(bp.opts.logger);
    const cancelled = new Task("count", SimpleParser);
    const next = new Task("count", SimpleParser);
    queue.enqueue(cancelled);
    queue.enqueue(next);
    cancelled.reject(new Error("admission expired"));
    expect(queue.tryAssignNextTask(bp)).to.eql(true);
    expect(bp.currentTask).to.equal(next);
    expect((await next.promise).trim()).to.eql("1");
  });

  it("refuses direct assignment of an already settled task", async function () {
    await setup();
    const cancelled = new Task("count", SimpleParser);
    cancelled.reject(new Error("cancelled"));
    expect(bp.execTask(cancelled)).to.eql(false);
    expect((await submit("count").promise).trim()).to.eql("1");
  });

  it("returns a termination promise from taskData and confirms exit", async function () {
    await setup();
    const ended = new Deferred<Promise<void>>();
    observer.on("taskData", (_data, task, context) => {
      if (task?.command === "gate") ended.resolve(context.end(false, "ending"));
    });
    const task = submit("gate");
    await ended.promise;
    expect(bp.exited).to.eql(true);
    await expect(task.promise).to.be.rejected;
  });

  it("forced end resolves only after exit was observed", async function () {
    await setup();
    await bp.end(false, "timeout");
    expect(bp.exited).to.eql(true);
    expect(bp.ready).to.eql(false);
  });

  it("end() resolves for a child that exited before adoption", async function () {
    // An async processFactory can return a child whose exit already fired.
    const proc = spawn(process.execPath, ["-e", ""]);
    await once(proc, "close");
    const exited = new BatchProcess(
      proc,
      verifyOptions({
        observer: new EventEmitter() as BatchClusterEmitter,
        processFactory: () => proc,
        versionCommand: "version",
        pass: "PASS",
        fail: "FAIL",
        cleanupChildProcs: false,
      }),
      () => undefined,
    );
    await exited.end(false, "ending");
    expect(exited.exited).to.eql(true);
  });

  it("reports bounded failed recovery when a real child cannot be reclaimed", async function () {
    await setup(windowMs, false);
    const reasons: string[] = [];
    observer.on("childEnd", (_proc, reason) => reasons.push(reason));
    await expect(bp.end(false, "timeout")).to.be.rejectedWith(
      "exit was not confirmed",
    );
    expect(bp.exited).to.eql(false);
    expect(bp.ready).to.eql(false);
    // Failed recovery must still record why the child was terminated.
    expect(reasons).to.eql(["timeout"]);
  });

  it("explicit progress survives multiple windows while preserving runtime", async function () {
    await setup();
    const task = new Task("ticks", SimpleParser);
    const credit = () => task.resetTimeout();
    const health: (string | null)[] = [];
    observer.on("taskData", (data, current) => {
      if (current === task && String(data).includes("step")) {
        credit();
        health.push(bp.whyNotHealthy);
        if ((task.runtimeMs ?? 0) > windowMs * 3) bp.proc.send?.("finish");
      }
    });
    expect(bp.execTask(task)).to.eql(true);
    expect(await task.promise).to.contain("done");
    expect(task.runtimeMs).to.be.greaterThan(windowMs * 3);
    expect(health.every((value) => value == null)).to.eql(true);
  });

  it("stopped credit times out after the last credited progress", async function () {
    await setup();
    const task = new Task("ticks", SimpleParser);
    let lastCreditAt = 0;
    observer.on("taskData", (_data, current) => {
      if (
        current === task &&
        (task.runtimeMs ?? 0) < windowMs * 2 &&
        task.resetTimeout()
      ) {
        lastCreditAt = Date.now();
      }
    });
    expect(task.resetTimeout()).to.eql(false);
    expect(bp.execTask(task)).to.eql(true);
    await expect(task.promise).to.be.rejectedWith("timeout");
    expect(lastCreditAt).to.be.greaterThan(0);
    expect(Date.now() - lastCreditAt).to.be.at.least(windowMs - 1);
    expect(task.resetTimeout()).to.eql(false);
    await bp.end(false, "timeout");
    expect(bp.exited).to.eql(true);
  });

  it("a settled task cannot credit the next task", async function () {
    await setup();
    const old = submit("count");
    await old.promise;
    const credits: boolean[] = [];
    observer.on("taskData", () => credits.push(old.resetTimeout()));
    await expect(submit("ticks").promise).to.be.rejectedWith("timeout");
    expect(credits.length).to.be.greaterThan(0);
    expect(credits.every((credit) => !credit)).to.eql(true);
  });

  it("queue time consumes none of the next execution window", async function () {
    await setup();
    const queue = new TaskQueueManager(bp.opts.logger);
    const next = new Task("count", SimpleParser);
    queue.enqueue(next);
    const first = new Task("ticks", SimpleParser);
    observer.on("taskData", (_data, current) => {
      if (current === first) {
        first.resetTimeout();
        if ((first.runtimeMs ?? 0) > windowMs * 3) bp.proc.send?.("finish");
      }
    });
    expect(bp.execTask(first)).to.eql(true);
    await first.promise;
    expect(next.runtimeMs).to.eql(undefined);
    expect(next.resetTimeout()).to.eql(false);
    expect(queue.tryAssignNextTask(bp)).to.eql(true);
    expect((await next.promise).trim()).to.eql("1");
  });

  it("zero disables the execution timeout", async function () {
    await setup(0);
    const task = new Task("ticks", SimpleParser);
    observer.on("taskData", (_data, current) => {
      if (current === task && (task.runtimeMs ?? 0) > windowMs * 3)
        bp.proc.send?.("finish");
    });
    expect(bp.execTask(task)).to.eql(true);
    expect(task.resetTimeout()).to.eql(false);
    expect(await task.promise).to.contain("done");
  });

  it("startup retains its fixed timeout", async function () {
    await expect(setup(0, true, "gate", windowMs)).to.be.rejectedWith(
      "timeout",
    );
    await bp.end(false, "timeout");
    expect(bp.exited).to.eql(true);
  });

  it("health checks retain their fixed timeout", async function () {
    await setup();
    bp.opts.healthCheckCommand = "gate";
    bp.opts.healthCheckIntervalMillis = 1;
    let health: Task | undefined;
    const credits: boolean[] = [];
    observer.on("taskData", (_data, current) => {
      if (current != null && current === health)
        credits.push(current.resetTimeout());
    });
    expect(
      await until(() => (health = bp.maybeRunHealthCheck()) != null, 5000, 5),
    ).to.eql(true);
    await expect(health!.promise).to.be.rejectedWith("timeout");
    expect(credits.length).to.be.greaterThan(0);
    expect(credits.every((credit) => !credit)).to.eql(true);
    await bp.end(false, "timeout");
    expect(bp.exited).to.eql(true);
  });

  it("drops cancelled queued work while process startup is unavailable", async function () {
    const factory = new Deferred<ReturnType<typeof spawn>>();
    const cluster = new BatchCluster({
      processFactory: () => factory.promise,
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      spawnTimeoutMillis: 0,
      minDelayBetweenSpawnMillis: 0,
      onIdleIntervalMillis: 0,
      maxProcs: 1,
    });
    const task = new Task("count", SimpleParser);
    try {
      const result = cluster.enqueueTask(task);
      expect(await until(() => cluster.spawnedProcCount === 1, 5000, 5)).to.eql(
        true,
      );

      task.reject(new Error("admission expired"));
      await expect(result).to.be.rejectedWith("admission expired");
      expect(
        await until(
          () => cluster.pendingTaskCount === 0 && cluster.isIdle,
          5000,
          5,
        ),
      ).to.eql(true);
      expect(cluster.spawnedProcCount).to.eql(1);
    } finally {
      factory.resolve(spawnFixture());
      await cluster.end(false);
    }
  });

  it("enqueueing does not rescan queued tasks", async function () {
    let pendingReads = 0;
    class CountingTask extends Task<string> {
      override get pending(): boolean {
        pendingReads++;
        return super.pending;
      }
    }
    const cluster = new BatchCluster({
      processFactory: spawnFixture,
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
    });
    const n = 1000;
    const results: Promise<unknown>[] = [];
    for (let i = 0; i < n; i++) {
      const task = new CountingTask("count", SimpleParser);
      results.push(cluster.enqueueTask(task).catch(() => undefined));
    }
    // A per-enqueue scan costs n^2 / 2 reads, which is quadratic time for
    // callers that enqueue a large batch at once.
    expect(pendingReads).to.be.lessThan(n);
    await cluster.end(false);
    await Promise.all(results);
  });

  it("a processFactory that never settles does not block later spawns", async function () {
    // 19.2.0 retries after spawnTimeoutMillis; a stuck factory must not hold
    // a maxProcs slot forever.
    const stuck = new Deferred<ReturnType<typeof spawn>>();
    let calls = 0;
    const cluster = new BatchCluster({
      processFactory: () => (++calls === 1 ? stuck.promise : spawnFixture()),
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      spawnTimeoutMillis: windowMs,
      minDelayBetweenSpawnMillis: 0,
      maxProcs: 1,
    });
    const task = new Task("count", SimpleParser);
    // end() rejects the task if the assertions below fail:
    void cluster.enqueueTask(task).catch(() => undefined);
    try {
      expect(await until(() => calls === 2, 5000, 5)).to.eql(true);
      expect((await task.promise).trim()).to.eql("1");
    } finally {
      stuck.resolve(spawnFixture());
      await cluster.end(false);
    }
  });

  it("end() rejects while a child it could not terminate is still running", async function () {
    const children: ReturnType<typeof spawn>[] = [];
    const cluster = new BatchCluster({
      processFactory: () => {
        const child = spawnFixture();
        children.push(child);
        return child;
      },
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      maxProcs: 1,
      // The fixture ignores stdin EOF, so nothing reclaims it:
      cleanupChildProcs: false,
    });
    let ended = false;
    cluster.on("end", () => (ended = true));
    try {
      expect(
        (await cluster.enqueueTask(new Task("count", SimpleParser))).trim(),
      ).to.eql("1");
      await expect(cluster.end(false).promise).to.be.rejectedWith(
        "still running",
      );
      expect(ended).to.eql(false);
    } finally {
      for (const child of children) child.kill("SIGKILL");
    }
  });

  it("the pool recovers after timeout and runs subsequent work", async function () {
    const cluster = new BatchCluster({
      processFactory: spawnFixture,
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      taskTimeoutMillis: windowMs,
      streamFlushMillis: 0,
      minDelayBetweenSpawnMillis: 0,
      maxProcs: 1,
    });
    let failedProcess: BatchProcess | undefined;
    cluster.on("taskTimeout", (_ms, _task, proc) => {
      failedProcess = proc;
    });
    try {
      await expect(
        cluster.enqueueTask(new Task("gate", SimpleParser)),
      ).to.be.rejectedWith("timeout");
      await failedProcess!.end(false, "timeout");
      expect(failedProcess!.exited).to.eql(true);
      expect(
        (await cluster.enqueueTask(new Task("count", SimpleParser))).trim(),
      ).to.eql("1");
    } finally {
      await cluster.end(false);
    }
  });

  it("execution timeout errors can be identified without message matching", async function () {
    await setup();
    const result = await submit("gate").promise.catch(
      (error) => error as Error,
    );
    expect(result).to.be.instanceOf(Error);
    expect(result).to.be.instanceOf(TaskTimeoutError);
    expect((result as TaskTimeoutError).timeoutMillis).to.eql(windowMs);
  });

  it("retains capacity until an unreclaimed worker actually exits", async function () {
    // A rejected task or end() promise must not free a live child's slot.
    // Disabling cleanup simulates unavailable reclamation with real children.
    const children: ReturnType<typeof spawn>[] = [];
    const cluster = new BatchCluster({
      processFactory: () => {
        const child = spawnFixture();
        children.push(child);
        return child;
      },
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      taskTimeoutMillis: windowMs,
      streamFlushMillis: 0,
      minDelayBetweenSpawnMillis: 0,
      maxProcs: 1,
      onIdleIntervalMillis: 0,
      cleanupChildProcs: false,
    });
    let failedProcess: BatchProcess | undefined;
    cluster.on("taskTimeout", (_ms, _task, proc) => {
      failedProcess = proc;
    });
    const next = new Task("count", SimpleParser);
    try {
      const failing = cluster.enqueueTask(new Task("gate", SimpleParser));
      const result = cluster.enqueueTask(next);
      await expect(failing).to.be.rejectedWith("timeout");
      await expect(failedProcess!.end(false, "timeout")).to.be.rejectedWith(
        "exit was not confirmed",
      );
      expect(failedProcess!.exited).to.eql(false);
      expect(next.pending).to.eql(true);
      expect(children.length).to.eql(1);
      failedProcess!.proc.kill("SIGKILL");
      expect((await result).trim()).to.eql("1");
      expect(failedProcess!.exited).to.eql(true);
      expect(children.length).to.eql(2);
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await cluster.end(false);
    }
  });

  for (const command of ["gate", "ticks"]) {
    it(`times out ${command} without explicit credit and reclaims its child`, async function () {
      await setup();
      await expect(submit(command).promise).to.be.rejectedWith("timeout");
      await bp.end(false, "timeout");
      expect(bp.exited).to.eql(true);
    });
  }
});
