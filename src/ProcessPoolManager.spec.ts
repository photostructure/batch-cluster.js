import child_process from "node:child_process";
import events from "node:events";
import path from "node:path";
import {
  childProcs,
  currentTestPids,
  expect,
  parser,
  processFactory,
  setFailRatePct,
  setIgnoreExit,
} from "./_chai.spec";
import { delay, until } from "./Async";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import type { BatchClusterOptions } from "./BatchClusterOptions";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { verifyOptions } from "./OptionsVerifier";
import { kill, pidExists } from "./Pids";
import { ProcessPoolManager } from "./ProcessPoolManager";
import { Task } from "./Task";
import { thenOrTimeout, Timeout } from "./Timeout";

describe("ProcessPoolManager", function () {
  let poolManager: ProcessPoolManager;
  let emitter: BatchClusterEmitter;

  const onIdle = () => {
    // callback for when pool manager needs to signal idle state
  };

  /**
   * A pool whose children come from `processFactory` instead of the default.
   * Registered on `childProcs` by the caller so the suite reaps them even when
   * an assertion fails.
   */
  function poolWith(
    processFactory: () =>
      child_process.ChildProcess | Promise<child_process.ChildProcess>,
    overrides: Partial<BatchClusterOptions> = {},
  ): ProcessPoolManager {
    return new ProcessPoolManager(
      verifyOptions({
        ...DefaultTestOptions,
        ...overrides,
        processFactory,
        observer: emitter,
      }),
      emitter,
      onIdle,
    );
  }

  /**
   * A child that ignores stdin EOF, so it can only be stopped by a signal.
   * `stdio[0]` is caller-provided: "ignore" makes `proc.stdin` null, which is
   * what makes BatchProcess construction throw.
   */
  function spawnStubbornChild(
    stdin: "ignore" | "pipe",
  ): child_process.ChildProcess {
    const proc = child_process.spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: [stdin, "pipe", "pipe"] },
    );
    childProcs.push(proc);
    return proc;
  }

  /** Protocol-aware child that survives until SIGKILL. */
  function spawnProtocolStubbornChild(): child_process.ChildProcess {
    const proc = child_process.spawn(process.execPath, [
      path.join(__dirname, "stubborn-child-helper.js"),
    ]);
    childProcs.push(proc);
    return proc;
  }

  beforeEach(function () {
    setFailRatePct(0); // no failures for pool manager tests
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
    // Several tests here spawn children directly, and a failing assertion can
    // leave one running (these children ignore everything short of SIGKILL).
    // Don't leak them onto the developer's machine.
    for (const proc of childProcs) kill(proc.pid, true);
    childProcs.length = 0;
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
      await poolManager.maybeSpawnProcs(pendingTaskCount);

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
      await poolManager.maybeSpawnProcs(5);

      expect(poolManager.procCount).to.be.at.most(maxProcs);
    });

    it("should not spawn processes when ended", async function () {
      await poolManager.end(false);
      expect(poolManager.ended).to.be.true;

      await poolManager.maybeSpawnProcs(2);

      expect(poolManager.procCount).to.eql(0);
      expect(poolManager.spawnedProcCount).to.eql(0);
    });

    it("should spawn multiple processes for multiple pending tasks", async function () {
      const pendingTaskCount = 3;
      poolManager.setMaxProcs(4);

      await poolManager.maybeSpawnProcs(pendingTaskCount);

      // Should spawn up to the number of pending tasks or maxProcs
      expect(poolManager.procCount).to.be.at.least(1);
      expect(poolManager.procCount).to.be.at.most(
        Math.min(pendingTaskCount, 4),
      );
    });
  });

  describe("adoption failures", function () {
    it("kills the child when BatchProcess construction throws", async function () {
      // The factory hands us a live child, but StreamHandler rejects it for
      // having no stdin. The pool owns that child until a BatchProcess takes
      // over, so it must not be left running.
      const pool = poolWith(() => spawnStubbornChild("ignore"));
      const startErrors: Error[] = [];
      emitter.on("startError", (err) => startErrors.push(err));

      await pool.maybeSpawnProcs(1);

      expect(startErrors.map((ea) => ea.message).join("\n")).to.include(
        "stdin",
      );
      expect(pool.procCount).to.eql(0);

      const pid = childProcs[childProcs.length - 1]?.pid;
      expect(pid).to.not.be.undefined;
      expect(await until(() => !pidExists(pid), 2000)).to.eql(
        true,
        "unadoptable child should have been killed",
      );
    });

    it("does not claim cleanup is disabled when an exited child cannot be signalled", async function () {
      const proc = child_process.spawn(process.execPath, ["-e", ""], {
        stdio: "ignore",
      });
      childProcs.push(proc);
      await events.once(proc, "close");

      const warnings: string[] = [];
      const pool = poolWith(() => proc, {
        cleanupChildProcs: true,
        logger: () => ({
          trace: () => undefined,
          debug: () => undefined,
          info: () => undefined,
          error: () => undefined,
          warn: (message) => warnings.push(message),
        }),
      });

      await pool.maybeSpawnProcs(1);

      expect(warnings.join("\n")).not.to.include(
        "cleanupChildProcs is disabled",
      );
    });
  });

  describe("spawning while ending", function () {
    it("end() blocks until a child spawned during shutdown is terminated", async function () {
      // A factory can spawn its child and only *resolve* later, while it
      // validates. end() has to be a barrier: if it resolves first, the
      // idiomatic `await end(); process.exit(0)` orphans this child, and
      // asserting after a delay would hide that.
      let pid: number | undefined;
      const pool = poolWith(
        async () => {
          const proc = spawnStubbornChild("pipe");
          pid = proc.pid;
          await delay(200);
          return proc;
        },
        {
          // Explicit end() is a true barrier even when the factory outlives
          // the normal spawn budget.
          spawnTimeoutMillis: 50,
        },
      );
      const endedPids: number[] = [];
      emitter.on("childEnd", (proc) => endedPids.push(proc.pid));

      void pool.maybeSpawnProcs(1);
      // The child now exists, but the factory hasn't handed it over yet:
      expect(await until(() => pid != null, 2000)).to.be.true;
      expect(pool.procCount).to.eql(0);

      await pool.end(true);

      expect(endedPids).to.include(
        pid,
        "end() resolved before terminating the late-arriving child",
      );
    });

    it("reports termination errors from a child that arrives during shutdown", async function () {
      let pid: number | undefined;
      const pool = poolWith(async () => {
        const proc = spawnStubbornChild("pipe");
        pid = proc.pid;
        await delay(50);
        return proc;
      });
      emitter.on("childEnd", () => {
        throw new Error("late childEnd boom");
      });
      const endErrors: Error[] = [];
      emitter.on("endError", (err) => endErrors.push(err));

      void pool.maybeSpawnProcs(1);
      expect(await until(() => pid != null, 2000)).to.be.true;

      await pool.end(false);

      expect(endErrors.map((ea) => ea.message)).to.include(
        "late childEnd boom",
      );
    });

    it("still terminates a child that arrives after automatic cleanup's deadline", async function () {
      // The automatic beforeExit path uses a bounded wait so a stuck factory
      // cannot hang process exit, but an eventual child must not be left alive
      // in an already-ended pool while the host remains running.
      let pid: number | undefined;
      const pool = poolWith(async () => {
        const proc = spawnStubbornChild("pipe");
        pid = proc.pid;
        await delay(200);
        return proc;
      });
      const endedPids: number[] = [];
      emitter.on("childEnd", (proc) => endedPids.push(proc.pid));

      void pool.maybeSpawnProcs(1);
      expect(await until(() => pid != null, 2000)).to.be.true;

      await pool.end(true, 50);
      expect(await until(() => endedPids.includes(pid as number), 2000)).to.eql(
        true,
        "a child arriving after the barrier deadline was never terminated",
      );
      expect(pool.procCount).to.eql(0);
    });

    it("bounds automatic cleanup when a process factory never settles", async function () {
      const pool = poolWith(
        () => new Promise<child_process.ChildProcess>(() => undefined),
      );

      void pool.maybeSpawnProcs(1);
      expect(await until(() => pool.spawnedProcCount === 1, 2000)).to.be.true;

      expect(await thenOrTimeout(pool.end(false, 50), 500)).to.not.eql(
        Timeout,
        "automatic cleanup must not hang forever on a stuck process factory",
      );
    });
  });

  describe("vacuumProcs error handling", function () {
    it("emits endError rather than rejecting when a child's end() throws", async function () {
      await poolManager.maybeSpawnProcs(1);
      expect(await until(() => poolManager.findReadyProcess() != null, 2000)).to
        .be.true;

      // A throwing consumer listener propagates out of BatchProcess.#end().
      // In production vacuumProcs() is called as `void vacuumProcs()`, so an
      // uncaught rejection here takes down the host process -- and orphans
      // every child that was mid-recycle.
      emitter.on("childEnd", () => {
        throw new Error("boom from childEnd");
      });
      const endErrors: Error[] = [];
      emitter.on("endError", (err) => endErrors.push(err));

      poolManager.setMaxProcs(0);
      await poolManager.vacuumProcs();

      expect(endErrors.map((ea) => ea.message).join("\n")).to.include(
        "boom from childEnd",
      );
    });
  });

  describe("ending while recycling", function () {
    it("end() blocks until a child vacuumProcs() is recycling has terminated", async function () {
      // IGNORE_EXIT: the child ignores both the exit command and SIGTERM, so
      // its graceful-shutdown window stays open long enough to observe.
      setIgnoreExit(true);
      await poolManager.maybeSpawnProcs(1);
      expect(await until(() => poolManager.findReadyProcess() != null, 2000)).to
        .be.true;
      const pid = poolManager.pids()[0];

      const endedPids: number[] = [];
      emitter.on("childEnd", (proc) => endedPids.push(proc.pid));

      poolManager.setMaxProcs(0);
      void poolManager.vacuumProcs();
      expect(poolManager.pids()).to.eql([], "recycling empties the pool now");
      expect(endedPids).to.eql([], "...but termination is still in flight");

      await poolManager.end(true);

      expect(endedPids).to.include(
        pid,
        "end() resolved while the pool was still recycling a child",
      );
    });
  });

  describe("shutdown deadline", function () {
    /** Ignores SIGTERM silently, so only a SIGKILL stops it. */
    function spawnSigtermProofChild(): child_process.ChildProcess {
      const proc = child_process.spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ]);
      childProcs.push(proc);
      return proc;
    }

    it("force-kills children that outlast the bounded wait", async function () {
      // Use a protocol-aware fixture that silently ignores exit, SIGTERM, and
      // broken pipes. test.js can instead die from EPIPE and false-green this
      // assertion.
      const pool = poolWith(spawnProtocolStubbornChild, {
        spawnTimeoutMillis: 5000,
        endGracefulWaitTimeMillis: 5000,
      });
      await pool.maybeSpawnProcs(1);
      expect(await until(() => pool.findReadyProcess() != null, 5000)).to.be
        .true;
      const pid = pool.pids()[0];
      expect(pid).to.not.be.undefined;

      // Start a ~5s graceful recycle; the process leaves #procs immediately:
      pool.setMaxProcs(0);
      void pool.vacuumProcs();
      expect(pool.pids()).to.eql([]);

      const startedAt = Date.now();
      await pool.end(true, 500);
      expect(Date.now() - startedAt).to.be.lessThan(
        2000,
        "end() should have honored its bounded wait",
      );

      // Well inside endGracefulWaitTimeMillis: without the force-kill this
      // child stays alive until the graceful window ends, seconds after end()
      // resolved and the exit backstop was dropped.
      expect(await until(() => !pidExists(pid), 2000)).to.eql(
        true,
        "child outliving the deadline should have been force-killed",
      );
    });

    it("bounds the initial drain, not just the mop-up afterwards", async function () {
      // The commonest case of all: one healthy pooled child that ignores the
      // exit command. Its graceful shutdown runs the full
      // endGracefulWaitTimeMillis, so if the deadline is taken *after* the
      // first drain, the advertised bound doesn't cover it at all.
      const pool = poolWith(spawnSigtermProofChild, {
        spawnTimeoutMillis: 5000,
        endGracefulWaitTimeMillis: 5000,
      });
      await pool.maybeSpawnProcs(1);
      expect(pool.procCount).to.eql(1);

      const startedAt = Date.now();
      await pool.end(true, 500);

      expect(Date.now() - startedAt).to.be.lessThan(
        2000,
        "end() should have bounded the initial drain too",
      );
    });

    it("settles a task whose process is still terminating at the deadline", async function () {
      // ProcessTerminator gives a running task up to 2s to finish. A bounded
      // shutdown may give up sooner -- and must not leave the caller awaiting
      // a promise that nothing will ever settle.
      const pool = poolWith(processFactory, {
        spawnTimeoutMillis: 5000,
        endGracefulWaitTimeMillis: 5000,
      });
      await pool.maybeSpawnProcs(1);
      expect(await until(() => pool.findReadyProcess() != null, 5000)).to.be
        .true;

      const task = new Task("sleep 3000", parser);
      const settled = task.promise.then(
        () => "resolved",
        () => "rejected",
      );
      expect(pool.findReadyProcess()?.execTask(task)).to.eql(true);
      await delay(100); // the task is now running on the child

      // A concurrent close moves the busy process out of the pool and into
      // termination, with its task waiting inside the terminator:
      void pool.closeChildProcesses(true);
      await delay(10);

      await pool.end(true, 500);

      expect(task.pending).to.eql(
        false,
        "end() resolved while the caller's task was still pending",
      );
      expect(await settled).to.eql("rejected");
    });

    it("does not signal children when cleanupChildProcs is disabled", async function () {
      // "Only disable this if you have another means of PID cleanup" -- so our
      // last-resort kills must stay out of the way, even when we'd rather not.
      emitter.on("endError", () => undefined);
      emitter.on("childEnd", () => {
        // forces the tracked termination to reject, which triggers the
        // force-kill fallback:
        throw new Error("childEnd boom");
      });
      const pool = poolWith(spawnSigtermProofChild, {
        cleanupChildProcs: false,
        endGracefulWaitTimeMillis: 100,
      });
      await pool.maybeSpawnProcs(1);
      const pid = childProcs[childProcs.length - 1]?.pid;

      await pool.end(true);
      await delay(200);

      expect(pidExists(pid)).to.eql(
        true,
        "the caller opted out of PID cleanup; we must not have signalled it",
      );
    });

    it("kills the child even when termination itself rejects", async function () {
      // `logger` is consumer-supplied. ProcessTerminator used to log before
      // force-killing, so a logger that throws skipped the kill -- and the
      // tracked termination reported success anyway.
      const endErrors: Error[] = [];
      emitter.on("endError", (err) => endErrors.push(err));
      const pool = poolWith(spawnSigtermProofChild, {
        endGracefulWaitTimeMillis: 0,
        logger: () => ({
          trace: () => undefined,
          debug: () => undefined,
          info: () => undefined,
          error: () => undefined,
          warn: () => {
            throw new Error("logger boom");
          },
        }),
      });
      await pool.maybeSpawnProcs(1);
      const pid = childProcs[childProcs.length - 1]?.pid;

      await pool.end(true);

      expect(endErrors.map((ea) => ea.message).join("\n")).to.include(
        "logger boom",
        "the consumer should still hear about their broken logger",
      );
      expect(await until(() => !pidExists(pid), 5000)).to.eql(
        true,
        "a rejecting termination must not leave the child running",
      );
    });
  });

  describe("unexitedPids", function () {
    it("still owes a kill for children that have left the pool", async function () {
      const pool = poolWith(() => spawnStubbornChild("pipe"));
      await pool.maybeSpawnProcs(1);
      const pid = childProcs[childProcs.length - 1]?.pid;
      expect(pool.unexitedPids()).to.eql([pid]);

      // #procs is drained synchronously, but the child is still very much
      // alive: asserting in this same tick makes the window deterministic.
      const closing = pool.closeChildProcesses(false);
      expect(pool.pids()).to.eql([], "pool drops it immediately");
      expect(pool.unexitedPids()).to.eql([pid], "but we still owe it a kill");

      await closing;
      expect(await until(() => pool.unexitedPids().length === 0, 5000)).to.eql(
        true,
        "ledger should drain when the child exits",
      );
    });
  });

  describe("process management", function () {
    beforeEach(async function () {
      // Spawn some processes for testing
      await poolManager.maybeSpawnProcs(2);
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
      await poolManager.maybeSpawnProcs(3);
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
      await poolManager.maybeSpawnProcs(2);
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
      await poolManager.maybeSpawnProcs(2);
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
      const spawnPromise = poolManager.maybeSpawnProcs(2);

      // Poll for the "starting" state — with fast flush thresholds the
      // window can be very short, so we poll every 1ms to catch it.
      const sawStarting = await until(
        () => poolManager.startingProcCount > 0,
        2000,
        1,
      );
      expect(sawStarting).to.eql(true, "should observe startingProcCount > 0");

      await spawnPromise;

      // Wait for processes to be ready
      await until(() => poolManager.startingProcCount === 0, 2000);
      expect(poolManager.startingProcCount).to.eql(0);
    });

    it("should track busy vs idle processes", async function () {
      await poolManager.maybeSpawnProcs(1);
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

      await poolManager.maybeSpawnProcs(1);
      await until(() => childStartEvents.length >= 1, 2000);

      expect(childStartEvents.length).to.be.greaterThan(0);

      await poolManager.closeChildProcesses(true);
      await until(() => childEndEvents.length >= 1, 2000);

      expect(childEndEvents.length).to.be.greaterThan(0);
      expect(childEndEvents[0].reason).to.eql("ending");
    });
  });
});
