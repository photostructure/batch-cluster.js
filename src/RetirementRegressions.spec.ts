import { expect, parser, processFactory, setFailRatePct } from "./_chai.spec";
import { until } from "./Async";
import { BatchCluster } from "./BatchCluster";
import { BatchProcess } from "./BatchProcess";
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import { Deferred } from "./Deferred";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";
import { thenOrTimeout } from "./Timeout";

describe("retirement regressions", function () {
  let bc: BatchCluster | undefined;
  let worker: BatchProcess;

  function cluster(overrides: Partial<CombinedBatchProcessOptions> = {}) {
    bc = new BatchCluster({
      ...DefaultTestOptions,
      processFactory,
      maxProcs: 1,
      maxTasksPerProcess: 100,
      maxProcAgeMillis: 0,
      maxIdleMsPerProcess: 0,
      onIdleIntervalMillis: 0,
      taskTimeoutMillis: 5000,
      minDelayBetweenSpawnMillis: 0,
      isRetirementRequest: () => false,
      ...overrides,
    });
    bc.on("childStart", (proc) => {
      worker = proc;
    });
    return bc;
  }

  beforeEach(() => {
    setFailRatePct(0);
    bc = undefined;
  });
  afterEach(async () => {
    await bc?.end();
  });

  for (const streamFlushMillis of [0, 30]) {
    for (const mode of ["default", "retirement", "stderr-filter"] as const) {
      it(`R572-A: rejects buffered FAIL followed by PASS (${mode}, ${streamFlushMillis} ms)`, async function () {
        const outcomes: boolean[] = [];
        const clusterInstance = cluster({
          streamFlushMillis,
          isRetirementRequest: mode === "retirement" ? () => false : undefined,
          shouldIgnoreStderrLine:
            mode === "stderr-filter" ? () => false : undefined,
          processFactory: () => {
            const proc = processFactory();
            let received = "";
            let acknowledged = false;
            proc.stderr?.on("data", (data: Buffer) => {
              received += data.toString();
              if (!acknowledged && received === "FAIL") {
                acknowledged = true;
                proc.stdin?.write("complete-failure\n");
              }
            });
            return proc;
          },
        });
        const task = new Task("buffered-failure", (stdout, stderr, passed) => {
          outcomes.push(passed);
          return SimpleParser(stdout, stderr, passed);
        });
        await expect(clusterInstance.enqueueTask(task)).to.be.rejectedWith(
          "task failed",
        );
        expect(outcomes).to.eql([false]);
      });
    }

    for (const stream of ["stdout", "stderr"] as const) {
      for (const whileParsing of [false, true]) {
        it(`R683-A: replaces a worker after an orphan ${stream} fragment (${streamFlushMillis} ms, parsing=${whileParsing})`, async function () {
          const clusterInstance = cluster({ streamFlushMillis });
          const parsing = new Deferred<void>();
          const releaseParser = new Deferred<void>();
          const first = clusterInstance.enqueueTask(
            new Task("upcase ok", async (stdout, stderr, passed) => {
              parsing.resolve();
              if (whileParsing) await releaseParser.promise;
              return parser(stdout, stderr, passed);
            }),
          );
          await parsing.promise;
          if (!whileParsing) {
            await first;
            expect(await until(() => worker.idle, 5000)).to.eql(true);
          }
          const oldWorker = worker;
          const oldStream = oldWorker.proc[stream]!;
          const received = new Promise<void>((resolve) =>
            oldStream.once("data", () => resolve()),
          );
          const stray: string[] = [];
          clusterInstance.on("noTaskData", (stdout, stderr) =>
            stray.push(String(stdout ?? stderr)),
          );
          // Trigger a fragment only after the prior task is idle or parsing.
          // This handshake avoids assuming a 50 ms delay establishes idleness.
          oldWorker.proc.stdin!.write(`idle-fragment ${stream}\n`);
          await received;
          expect(oldWorker.ready).to.eql(false);
          const next = clusterInstance.enqueueTask(
            new Task("upcase next", parser),
          );
          releaseParser.resolve();
          expect(await first).to.eql("OK");
          expect(await thenOrTimeout(next, 5000)).to.eql("NEXT");
          expect(worker.pid).to.not.eql(oldWorker.pid);
          expect(stray).to.eql(["progress: 50%"]);
          expect(oldWorker.retirementRequested).to.eql(false);
        });
      }
    }
  }
});
