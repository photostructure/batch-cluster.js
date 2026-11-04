import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect } from "./_chai.spec";
import { until } from "./Async";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcess } from "./BatchProcess";
import { verifyOptions } from "./OptionsVerifier";
import { TaskTimeoutError } from "./TaskTimeoutError";

// Each startup failure is reported once: by startError when the startup task
// fails, or by childEnd when the child exits first.
describe("startup task failures", function () {
  this.timeout(10000);
  let bp: BatchProcess;
  let startErrors: Error[];
  let childEnds: string[];

  function launch(script: string): void {
    const observer = new EventEmitter() as BatchClusterEmitter;
    startErrors = [];
    childEnds = [];
    observer.on("startError", (err) => startErrors.push(err));
    observer.on("childEnd", (_bp, why) => childEnds.push(why));
    const proc = spawn(process.execPath, ["-e", script]);
    bp = new BatchProcess(
      proc,
      verifyOptions({
        observer,
        processFactory: () => proc,
        versionCommand: "version",
        pass: "PASS",
        fail: "FAIL",
        streamFlushMillis: 10,
        spawnTimeoutMillis: 300,
        taskTimeoutMillis: 300,
        maxProcAgeMillis: 0,
      }),
      () => undefined,
    );
  }

  afterEach(async function () {
    bp.proc.kill("SIGKILL");
    await bp.end(false, "ending").catch(() => undefined);
    expect(await until(() => bp.exited, 5000, 5)).to.eql(true);
  });

  it("emits one startError when the startup task times out", async function () {
    launch("process.stdin.resume()");
    const error = await bp.currentTask!.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).to.be.instanceOf(TaskTimeoutError);
    expect(await until(() => childEnds.length > 0, 5000, 5)).to.eql(true);
    expect(startErrors.map(String)).to.eql([String(error)]);
  });

  it("rejects the startup task of a child that exits before replying", async function () {
    launch("setTimeout(() => process.exit(3), 100)");
    const error = await bp.currentTask!.promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).to.be.instanceOf(Error);
    expect(error).to.not.be.instanceOf(TaskTimeoutError);
    expect(await until(() => childEnds.length > 0, 5000, 5)).to.eql(true);
    expect(startErrors).to.eql([]);
  });
});
