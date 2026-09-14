import { expect, parser, processFactory, setFailRatePct } from "./_chai.spec";
import { until } from "./Async";
import { BatchCluster } from "./BatchCluster";
import { BatchProcess } from "./BatchProcess";
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";

describe("worker retirement", function () {
  const marker = "{photostructure:retire}";
  let bc: BatchCluster;
  let ended: { proc: BatchProcess; reason: string }[];
  let strayOutput: unknown[];
  let taskData: string[];

  function cluster(overrides: Partial<CombinedBatchProcessOptions> = {}) {
    bc = new BatchCluster({
      ...DefaultTestOptions,
      processFactory,
      maxProcs: 1,
      maxTasksPerProcess: 100,
      taskTimeoutMillis: 5000,
      streamFlushMillis: 0,
      minDelayBetweenSpawnMillis: 0,
      onIdleIntervalMillis: 0,
      isRetirementRequest: (line, stream) =>
        stream === "stdout" && line === marker,
      ...overrides,
    });
    bc.on("childEnd", (proc, reason) => ended.push({ proc, reason }));
    bc.on("noTaskData", (...args) => strayOutput.push(args));
    bc.on("taskData", (data) => taskData.push(String(data)));
    return bc;
  }

  beforeEach(function () {
    setFailRatePct(0);
    ended = [];
    strayOutput = [];
    taskData = [];
  });

  afterEach(async function () {
    if (bc != null) await bc.end();
    expect(strayOutput).to.eql([]);
  });

  for (const mode of ["together", "split", "early"]) {
    it(`finishes the current task and replaces its worker (${mode})`, async function () {
      cluster();
      const pids: number[] = [];
      const retiredReady: boolean[] = [];
      let reentrantTask: Promise<string> | undefined;
      bc.on("taskResolved", (task, proc) => {
        pids.push(proc.pid);
        if (task.command.startsWith("retire")) {
          retiredReady.push(proc.ready);
          expect(proc.retirementRequested).to.eql(true);
          expect(proc.execTask(new Task("upcase must not run", parser))).to.eql(
            false,
          );
          expect(proc.maybeRunHealthCheck()).to.eql(undefined);
          proc.requestRetirement();
          proc.requestRetirement();
          reentrantTask = bc.enqueueTask(
            new Task("upcase from callback", parser),
          );
        }
      });
      const first = bc.enqueueTask(new Task("retire " + mode, parser));
      const second = bc.enqueueTask(new Task("upcase next", parser));
      const firstResult = await first;
      expect(await second).to.eql("NEXT");
      expect(firstResult).to.eql(String(pids[0]));
      expect(await reentrantTask).to.eql("FROM CALLBACK");
      expect(retiredReady).to.eql([false]);
      expect(await until(() => pids.length === 3, 5000)).to.eql(true);
      expect(pids[1]).to.not.eql(pids[0]);
      expect(pids[2]).to.eql(pids[1]);
      expect(await until(() => ended.length === 1, 5000)).to.eql(true);
      expect(ended[0]?.reason).to.eql("retired");
      expect(ended[0]?.proc.unexpectedExit).to.eql(false);
      expect(bc.childEndCounts.retired).to.eql(1);
      expect(taskData.join("")).to.not.include(marker);
    });
  }

  it("recycles a worker that requests retirement while idle", async function () {
    cluster();
    const oldPid = await bc.enqueueTask(new Task("retire idle", parser));
    expect(await until(() => ended.length === 1, 5000)).to.eql(true);
    expect(ended[0]?.reason).to.eql("retired");
    expect(String(ended[0]?.proc.pid)).to.eql(oldPid);
    expect(await bc.enqueueTask(new Task("upcase replacement", parser))).to.eql(
      "REPLACEMENT",
    );
    expect(bc.pids()).to.not.include(Number(oldPid));
  });

  it("can retire during startup without assigning user work to that worker", async function () {
    let startupResponses = 0;
    const startupFailures: Error[] = [];
    cluster({
      isRetirementRequest: (line) =>
        line === "v1.2.3" && startupResponses++ === 0,
    });
    bc.on("startError", (error) => startupFailures.push(error));
    expect(await bc.enqueueTask(new Task("upcase ready", parser))).to.eql(
      "READY",
    );
    expect(startupResponses).to.eql(2);
    expect(await until(() => ended.length === 1, 5000)).to.eql(true);
    expect(ended[0]?.reason).to.eql("retired");
    expect(startupFailures).to.eql([]);
  });

  it("retains a task failure after a retirement request", async function () {
    cluster();
    const errors: Error[] = [];
    bc.on("taskError", (error) => errors.push(error));
    await expect(
      bc.enqueueTask(new Task("retire fail", SimpleParser)),
    ).to.be.rejectedWith("task failed");
    expect(await bc.enqueueTask(new Task("upcase next", parser))).to.eql(
      "NEXT",
    );
    expect(errors).to.have.length(1);
    expect(await until(() => ended.length === 1, 5000)).to.eql(true);
    expect(ended[0]?.reason).to.eql("retired");
    expect(ended[0]?.proc.failedTaskCount).to.eql(1);
  });

  it("preserves the normal timeout and reports it instead of successful retirement", async function () {
    cluster({ taskTimeoutMillis: 200 });
    await expect(
      bc.enqueueTask(new Task("retire timeout", parser)),
    ).to.be.rejectedWith("timeout");
    expect(await bc.enqueueTask(new Task("upcase next", parser))).to.eql(
      "NEXT",
    );
    expect(await until(() => ended.length === 1, 5000)).to.eql(true);
    expect(ended[0]?.reason).to.eql("timeout");
    expect(ended[0]?.proc.retirementRequested).to.eql(true);
    expect(ended[0]?.proc.unexpectedExit).to.eql(true);
  });

  it("contains recognizer errors and replaces the affected worker", async function () {
    cluster({
      isRetirementRequest: (line) => {
        if (line === marker) throw new Error("recognizer failed");
        return false;
      },
    });
    await expect(
      bc.enqueueTask(new Task("retire together", parser)),
    ).to.be.rejectedWith("recognizer failed");
    expect(await bc.enqueueTask(new Task("upcase next", parser))).to.eql(
      "NEXT",
    );
    expect(await until(() => ended.length === 1, 5000)).to.eql(true);
    expect(ended[0]?.reason).to.eql("stdout.error");
    expect(ended[0]?.proc.unexpectedExit).to.eql(true);
  });
});
