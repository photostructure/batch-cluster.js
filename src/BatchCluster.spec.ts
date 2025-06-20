import FakeTimers from "@sinonjs/fake-timers"
import process from "node:process"
import {
  currentTestPids,
  expect,
  flatten,
  parser,
  parserErrors,
  processFactory,
  procs,
  setFailratePct,
  setIgnoreExit,
  setNewline,
  testPids,
  times,
  unhandledRejections,
} from "./_chai.spec"
import { filterInPlace } from "./Array"
import { delay, until } from "./Async"
import { BatchCluster } from "./BatchCluster"
import { secondMs } from "./BatchClusterOptions"
import { DefaultTestOptions } from "./DefaultTestOptions.spec"
import { map, omit } from "./Object"
import { isWin } from "./Platform"
import { toS } from "./String"
import { Task } from "./Task"
import { thenOrTimeout } from "./Timeout"

const isCI = process.env.CI === "1"

function arrayEqualish<T>(a: T[], b: T[], maxAcceptableDiffs: number) {
  const common = a.filter((ea) => b.includes(ea))
  const minLength = Math.min(a.length, b.length)
  if (common.length < minLength - maxAcceptableDiffs) {
    expect(a).to.eql(
      b,
      "too many diffs: " +
        JSON.stringify({
          actualDiffs: minLength - maxAcceptableDiffs,
          maxAcceptableDiffs,
          minLength,
          common_length: common.length,
        }),
    )
  }
}

describe("BatchCluster", function () {
  const ErrorPrefix = "ERROR: "

  const ShutdownTimeoutMs = 12 * secondMs

  function runTasks(
    bc: BatchCluster,
    iterations: number,
    start = 0,
  ): Promise<string>[] {
    return times(iterations, (i) =>
      bc
        .enqueueTask(new Task("upcase abc " + (i + start), parser))
        .catch((err) => ErrorPrefix + err),
    )
  }

  class Events {
    readonly taskData: { cmd: string | undefined; data: string }[] = []
    readonly events: { event: string }[] = []
    readonly startedPids: number[] = []
    readonly exitedPids: number[] = []
    readonly startErrors: Error[] = []
    readonly endErrors: Error[] = []
    readonly fatalErrors: Error[] = []
    readonly taskErrors: Error[] = []
    readonly noTaskData: any[] = []
    readonly healthCheckErrors: Error[] = []
    readonly unhealthyPids: number[] = []
    readonly runtimeMs: number[] = []
  }

  let events = new Events()
  const internalErrors: Error[] = []

  function assertExpectedResults(results: string[]) {
    const dataResults = flatten(
      events.taskData.map((ea) => ea.data.split(/[\n\r]+/)),
    )

    results.forEach((result, index) => {
      if (!result.startsWith(ErrorPrefix)) {
        expect(result).to.eql("ABC " + index)
        expect(dataResults.toString()).to.include(result)
      }
    })
  }

  beforeEach(function () {
    events = new Events()
  })

  process.on("SIGPIPE", (error) => {
    internalErrors.push(new Error("process.on(SIGPIPE): " + String(error)))
  })

  function postAssertions() {
    expect(internalErrors).to.eql([], "internal errors")

    events.runtimeMs.forEach((ea) =>
      expect(ea).to.be.within(
        0,
        5000,
        JSON.stringify({ runtimeMs: events.runtimeMs }),
      ),
    )
  }

  const expectedEndEvents = [{ event: "beforeEnd" }, { event: "end" }]

  async function shutdown(bc: BatchCluster) {
    if (bc == null) return // we skipped the spec
    const endPromise = bc.end(true)
    // "ended" should be true immediately, but it may still be waiting for child
    // processes to exit:
    expect(bc.ended).to.eql(true)

    async function checkShutdown() {
      // const isIdle = bc.isIdle
      // If bc has been told to shut down, it won't ever finish any pending commands.
      // const pendingCommands = bc.pendingTasks.map((ea) => ea.command)
      const runningCommands = bc.currentTasks.map((ea) => ea.command)
      const busyProcCount = bc.busyProcCount
      const pids = bc.pids()
      const livingPids = await currentTestPids()

      const done =
        runningCommands.length === 0 &&
        busyProcCount === 0 &&
        pids.length === 0 &&
        livingPids.length === 0

      if (!done)
        console.log("shutdown(): waiting for end", {
          runningCommands,
          busyProcCount,
          pids,
          livingPids,
        })
      return done
    }

    // Mac CI can be extremely slow to shut down:
    const endOrTimeout = await thenOrTimeout(
      endPromise.promise.then(() => true),
      ShutdownTimeoutMs,
    )
    const shutdownOrTimeout = await thenOrTimeout(
      until(checkShutdown, ShutdownTimeoutMs, 1000),
      ShutdownTimeoutMs,
    )
    expect(endOrTimeout).to.eql(true, ".end() failed")
    expect(shutdownOrTimeout).to.eql(true, ".checkShutdown() failed")

    // Calling bc.end() again should be a no-op and return the same Deferred:
    expect(bc.end(true).settled).to.eql(true)
    expect(bc.internalErrorCount).to.eql(
      0,
      JSON.stringify({
        internalErrorCount: bc.internalErrorCount,
        internalErrors,
        noTaskData: events.noTaskData,
      }),
    )
    expect(internalErrors).to.eql([], "no expected internal errors")
    expect(events.noTaskData).to.eql(
      [],
      "no expected noTaskData events, but got " +
        JSON.stringify(events.noTaskData),
    )
    return
  }

  function listen(bc: BatchCluster) {
    // This is a typings verification, too:
    bc.on("childStart", (cp) =>
      map(cp.pid, (ea) => events.startedPids.push(ea)),
    )
    bc.on("childEnd", (cp) => map(cp.pid, (ea) => events.exitedPids.push(ea)))
    bc.on("startError", (err) => events.startErrors.push(err))
    bc.on("endError", (err) => events.endErrors.push(err))
    bc.on("fatalError", (err) => events.fatalErrors.push(err))
    bc.on("noTaskData", (stdout, stderr, proc) => {
      events.noTaskData.push({
        stdout: toS(stdout),
        stderr: toS(stderr),
        proc_pid: proc?.pid,
        streamFlushMillis: bc.options.streamFlushMillis,
      })
    })
    bc.on("internalError", (err) => {
      console.error("BatchCluster.spec: internal error: " + err)
      internalErrors.push(err)
    })
    bc.on("taskData", (data, task: Task | undefined) =>
      events.taskData.push({
        cmd: task?.command,
        data: toS(data),
      }),
    )

    bc.on("taskResolved", (task: Task) => {
      const runtimeMs = task.runtimeMs
      expect(runtimeMs).to.not.eql(undefined)

      events.runtimeMs.push(runtimeMs!)
    })

    bc.on("healthCheckError", (err, proc) => {
      events.healthCheckErrors.push(err)
      events.unhealthyPids.push(proc.pid)
    })
    bc.on("taskError", (err) => events.taskErrors.push(err))

    for (const event of ["beforeEnd", "end"] as ("beforeEnd" | "end")[]) {
      bc.on(event, () => events.events.push({ event }))
    }
    return bc
  }

  const newlines = ["lf"]

  if (isWin) {
    // Don't need to test crlf except on windows:
    newlines.push("crlf")
  }

  it("supports .off()", () => {
    const emitTimes: number[] = []
    const bc = new BatchCluster({ ...DefaultTestOptions, processFactory })
    const listener = () => emitTimes.push(Date.now())
    // pick a random event that doesn't require arguments:
    const evt = "beforeEnd" as const
    bc.on(evt, listener)
    bc.emitter.emit(evt)
    expect(emitTimes.length).to.eql(1)
    emitTimes.length = 0
    bc.off(evt, listener)
    bc.emitter.emit(evt)
    expect(emitTimes).to.eql([])
    postAssertions()
  })

  for (const newline of newlines) {
    for (const maxProcs of [1, 4]) {
      for (const ignoreExit of [true, false]) {
        for (const healthcheck of [true, false]) {
          for (const minDelayBetweenSpawnMillis of [0, 100]) {
            describe(
              JSON.stringify({
                newline,
                maxProcs,
                ignoreExit,
                healthcheck,
                minDelayBetweenSpawnMillis,
              }),
              function () {
                let bc: BatchCluster
                const opts: any = {
                  ...DefaultTestOptions,
                  maxProcs,
                  minDelayBetweenSpawnMillis,
                }

                if (healthcheck) {
                  opts.healthCheckIntervalMillis = 250
                  opts.healthCheckCommand = "flaky 0.5" // fail half the time (ensure we get a proc end due to "unhealthy")
                }

                // failrate needs to be high enough to trigger but low enough to allow
                // retries to succeed.

                beforeEach(function () {
                  setNewline(newline as any)
                  setIgnoreExit(ignoreExit)
                  bc = listen(new BatchCluster({ ...opts, processFactory }))
                  procs.length = 0
                })

                afterEach(async () => {
                  await shutdown(bc)
                  expect(bc.internalErrorCount).to.eql(0)
                  return
                })

                if (maxProcs > 1) {
                  it("completes work on multiple child processes", async function () {
                    if (isCI) {
                      // don't fight timeouts on GitHub's slower-than-molasses CI boxes:
                      bc.options.taskTimeoutMillis = 1500
                    }
                    this.slow(1) // always show timing

                    const pidSet = new Set<number>()
                    const errors: Error[] = []

                    for (let i = 0; i < 20; i++) {
                      // run 4 tasks in parallel:
                      for (const p of times(maxProcs, () =>
                        bc.enqueueTask(
                          new Task(
                            // this needs to be much less than the
                            // DefaultTestOptions.taskTimeoutMillis (250), because we don't
                            // want timeouts. CI failed when this was 100.
                            "sleep 25",
                            parser,
                          ),
                        ),
                      )) {
                        try {
                          const result = await p
                          const { pid } = JSON.parse(result)
                          if (isNaN(pid)) {
                            throw new Error(
                              "invalid output: " + JSON.stringify(result),
                            )
                          } else {
                            pidSet.add(pid)
                          }
                        } catch (error) {
                          errors.push(error as Error)
                        }
                      }
                      if (pidSet.size > 2) break
                    }
                    const pids = [...pidSet.values()]
                    // console.dir({ pids, errors })

                    expect(pids.length).to.be.gt(
                      2,
                      "expected more than a couple child processes",
                    )
                    expect(pids.every((ea) => process.pid !== ea)).to.eql(
                      true,
                      "no child pids, " +
                        pids.join(", ") +
                        ", should match this process pid, " +
                        process.pid,
                    )
                    expect(
                      errors.filter((ea) => !String(ea).includes("EUNLUCKY")),
                    ).to.eql([], "Unexpected errors")
                  })
                }

                it("calling .end() when new no-ops", async () => {
                  await bc.end()
                  expect(bc.ended).to.eql(true)
                  expect(bc.isIdle).to.eql(true)
                  expect(bc.pids().length).to.eql(0)
                  expect(bc.spawnedProcCount).to.eql(0)
                  expect(events.events).to.eql(expectedEndEvents)
                  expect(testPids()).to.eql([])
                  expect(events.startedPids).to.eql([])
                  expect(events.exitedPids).to.eql([])
                  postAssertions()
                })

                it("calling .end() after running shuts down child procs", async () => {
                  // This just warms up bc to make child procs:
                  const iterations =
                    maxProcs * (bc.options.maxTasksPerProcess + 1)
                  // we're making exact pid assertions below: don't fight
                  // flakiness.
                  setFailratePct(0)

                  const tasks = await Promise.all(runTasks(bc, iterations))
                  assertExpectedResults(tasks)
                  await shutdown(bc)
                  console.log(bc.stats())
                  expect(bc.spawnedProcCount).to.be.within(
                    maxProcs,
                    (iterations + maxProcs) * 3, // because flaky
                  )
                  const pids = testPids()
                  expect(pids.length).to.be.gte(maxProcs)
                  // it's ok to miss a pid due to startup flakiness or cancelled
                  // end tasks.
                  arrayEqualish(events.startedPids, pids, 1)
                  arrayEqualish(events.exitedPids, pids, 1)
                  expect(events.events).to.eql(expectedEndEvents)
                  postAssertions()
                })

                it(
                  "runs a given batch process roughly " +
                    opts.maxTasksPerProcess +
                    " before recycling",
                  async function () {
                    if (isWin && isCI) this.timeout(45 * secondMs)
                    // make sure we hit an EUNLUCKY:
                    setFailratePct(60)
                    let expectedResultCount = 0
                    const results = await Promise.all(runTasks(bc, maxProcs))
                    expectedResultCount += maxProcs
                    const pids = bc.pids()
                    const iters = Math.floor(
                      maxProcs * opts.maxTasksPerProcess * 1.5,
                    )
                    results.push(
                      ...(await Promise.all(
                        runTasks(bc, iters, expectedResultCount),
                      )),
                    )
                    console.log(bc.stats())

                    expectedResultCount += iters
                    assertExpectedResults(results)
                    expect(results.length).to.eql(expectedResultCount)

                    // expect some errors:
                    const errorResults = results.filter((ea) =>
                      ea.startsWith(ErrorPrefix),
                    )
                    expect(errorResults).to.not.eql([])

                    // Expect a reasonable number of new pids. Worst case, we
                    // errored after every start, so there may be more then iters
                    // pids spawned.
                    expect(procs.length).to.eql(bc.spawnedProcCount)

                    expect(bc.spawnedProcCount).to.be.within(
                      results.length / opts.maxTasksPerProcess,
                      results.length * (isWin ? 10 : 5), // because flaky
                    )

                    // So, at this point, we should have at least _asked_ the
                    // initial child processes to end because they're "worn".

                    // Running vacuumProcs will return a promise that will only
                    // resolve when those procs have shut down.

                    await bc.vacuumProcs()

                    // Expect no prior pids to remain, as long as there were before-pids:
                    // NOTE: On Windows, PIDs can be reused quickly, so we only check this
                    // on non-Windows platforms to avoid flakiness
                    if (pids.length > 0 && !isWin)
                      expect(bc.pids()).to.not.include.members(pids)

                    expect(bc.meanTasksPerProc).to.be.within(
                      0.15, // because flaky (macOS on GHA resulted in 0.21)
                      opts.maxTasksPerProcess,
                    )
                    expect(bc.pids().length).to.be.lte(maxProcs)
                    expect((await currentTestPids()).length).to.be.lte(
                      bc.spawnedProcCount,
                    ) // because flaky

                    const unhealthy = bc.countEndedChildProcs("unhealthy")
                    // If it's a short spec and we don't have any worn procs, we
                    // probably don't have any unhealthy procs:
                    if (healthcheck && bc.countEndedChildProcs("worn") > 2) {
                      expect(unhealthy).to.be.gte(0)
                    }

                    if (!healthcheck) {
                      expect(unhealthy).to.eql(0)
                    }

                    await shutdown(bc)
                    // (no run count assertions)
                  },
                )

                it("recovers from invalid commands", async function () {
                  this.slow(1)
                  assertExpectedResults(
                    await Promise.all(runTasks(bc, maxProcs * 4)),
                  )
                  const errorResults = await Promise.all(
                    times(maxProcs * 2, () =>
                      bc
                        .enqueueTask(new Task("nonsense", parser))
                        .catch((err: unknown) => err),
                    ),
                  )
                  function convertErrorToString(ea: unknown): string {
                    if (ea == null) return "[unknown]"
                    if (ea instanceof Error) return ea.message
                    if (typeof ea === "string") return ea
                    if (typeof ea === "object") {
                      try {
                        return JSON.stringify(ea)
                      } catch {
                        return "[object Object]"
                      }
                    }
                    if (typeof ea === "number" || typeof ea === "boolean") {
                      return String(ea)
                    }
                    return "[unknown]"
                  }

                  filterInPlace(errorResults, (ea) => {
                    const errorStr = convertErrorToString(ea)
                    return !errorStr.includes("EUNLUCKY")
                  })
                  if (
                    maxProcs === 1 &&
                    ignoreExit === false &&
                    healthcheck === false
                  ) {
                    // We don't expect these to pass with this config:
                  } else if (maxProcs === 1 && errorResults.length === 0) {
                    console.warn("(all processes were unlucky)")
                    return this.skip()
                  } else {
                    expect(
                      errorResults.some((ea) =>
                        String(ea).includes("nonsense"),
                      ),
                    ).to.eql(true, JSON.stringify(errorResults))
                    expect(
                      parserErrors.some((ea) => ea.includes("nonsense")),
                    ).to.eql(true, JSON.stringify(parserErrors))
                  }
                  parserErrors.length = 0
                  // BC should recover:
                  assertExpectedResults(
                    await Promise.all(runTasks(bc, maxProcs * 4)),
                  )
                  // (no run count assertions)
                  return
                })

                it("times out slow requests", async () => {
                  const task = new Task(
                    "sleep " + (opts.taskTimeoutMillis + 250), // < make sure it times out
                    parser,
                  )
                  await expect(
                    bc.enqueueTask(task),
                  ).to.eventually.be.rejectedWith(/timeout|EUNLUCKY/)
                  postAssertions()
                })

                it("accepts single and multi-line responses", async () => {
                  setFailratePct(0)
                  if (isCI) {
                    // don't fight timeouts on GitHub's slower-than-molasses CI boxes:
                    bc.options.taskTimeoutMillis = 1500
                  }

                  const expected: string[] = []
                  const results = await Promise.all(
                    times(15, (idx) => {
                      // Make a distribution of single, double, and triple line outputs:
                      const worlds = times(idx % 3, (ea) => "world " + ea)
                      expected.push(
                        [idx + " HELLO", ...worlds].join("\n").toUpperCase(),
                      )
                      const cmd = ["upcase " + idx + " hello", ...worlds].join(
                        "<br>",
                      )
                      return bc.enqueueTask(new Task(cmd, parser))
                    }),
                  )
                  expect(results).to.eql(expected)

                  postAssertions()
                })

                it("rejects a command that results in FAIL", async function () {
                  const task = new Task("invalid command", parser)
                  let error: Error | undefined
                  let result = ""
                  try {
                    result = await bc.enqueueTask(task)
                  } catch (err: any) {
                    error = err
                  }
                  expect(String(error)).to.match(
                    /invalid command|UNLUCKY/,
                    result,
                  )
                  postAssertions()
                })

                it("rejects a command that emits to stderr", async function () {
                  const task = new Task("stderr omg this should fail", parser)
                  let error: Error | undefined
                  let result = ""
                  try {
                    result = await bc.enqueueTask(task)
                  } catch (err: any) {
                    error = err
                  }
                  expect(String(error)).to.match(
                    /omg this should fail|UNLUCKY/,
                    result,
                  )
                  postAssertions()
                })
              },
            )
          }
        }
      }
    }
  }

  describe("maxProcs", function () {
    const iters = 100
    const maxProcs = 10
    const sleepTimeMs = 250
    let bc: BatchCluster
    afterEach(() => shutdown(bc))
    for (const {
      minDelayBetweenSpawnMillis,
      expectTaskMin,
      expectedTaskMax,
      expectedProcsMin,
      expectedProcsMax,
    } of [
      {
        minDelayBetweenSpawnMillis: 100,
        expectTaskMin: 3, // ~5 - delta
        expectedTaskMax: 17, // ~15 + delta
        expectedProcsMin: maxProcs,
        expectedProcsMax: maxProcs + 2,
      },
      {
        minDelayBetweenSpawnMillis: 500,
        expectTaskMin: 1,
        expectedTaskMax: 22, // ~20 + delta
        expectedProcsMin: 6,
        expectedProcsMax: 10,
      },
    ]) {
      it(JSON.stringify({ minDelayBetweenSpawnMillis }), async () => {
        setFailratePct(0)
        const opts = {
          ...DefaultTestOptions,
          taskTimeoutMillis: 5_000, // < don't test timeouts here
          maxProcs,
          maxTasksPerProcess: expectedTaskMax + 5, // < don't recycle procs for this test
          minDelayBetweenSpawnMillis,
          processFactory,
        }
        bc = listen(new BatchCluster(opts))
        expect(bc.isIdle).to.eql(true)
        const tasks = await Promise.all(
          times(iters, async (i) => {
            const start = Date.now()
            const task = new Task("sleep " + sleepTimeMs, parser)
            const resultP = bc.enqueueTask(task)
            expect(bc.isIdle).to.eql(false)
            const result = JSON.parse(await resultP) as {
              pid: number
            } & Record<string, unknown>
            const end = Date.now()
            return { i, start, end, ...result }
          }),
        )
        const pid2count = new Map<number, number>()
        tasks.forEach((ea) => {
          const pid = ea.pid
          const count = pid2count.get(pid) ?? 0
          pid2count.set(pid, count + 1)
        })
        expect(bc.isIdle).to.eql(true)
        console.log({
          expectTaskMin,
          expectedTaskMax,
          maxProcs,
          uniqPids: pid2count.size,
          pid2count,
          bcPids: bc.pids(),
        })
        for (const [, count] of pid2count.entries()) {
          expect(count).to.be.within(expectTaskMin, expectedTaskMax)
        }
        expect(pid2count.size).to.be.within(expectedProcsMin, expectedProcsMax)
      })
    }
  })

  describe("setMaxProcs", function () {
    const maxProcs = 10
    const sleepTimeMs = 250
    let bc: BatchCluster
    afterEach(() => shutdown(bc))

    it("supports reducing maxProcs", async () => {
      // don't fight with flakiness here!
      setFailratePct(0)
      const opts = {
        ...DefaultTestOptions,
        minDelayBetweenSpawnMillis: 0,
        taskTimeoutMillis: 5_000, // < don't test timeouts here
        maxProcs,
        maxTasksPerProcess: 100, // < don't recycle procs for this test
        processFactory,
      }
      bc = new BatchCluster(opts)
      const firstBatchPromises: Promise<string>[] = []
      while (bc.busyProcCount < maxProcs) {
        firstBatchPromises.push(
          bc.enqueueTask(new Task("sleep " + sleepTimeMs, parser)),
        )
        await delay(25)
      }
      expect(bc.currentTasks.length).to.be.closeTo(maxProcs, 2)
      expect(bc.busyProcCount).to.be.closeTo(maxProcs, 2)
      expect(bc.procCount).to.be.closeTo(maxProcs, 2)
      const maxProcs2 = maxProcs / 2
      bc.setMaxProcs(maxProcs2)

      const secondBatchPromises = times(maxProcs, () =>
        bc.enqueueTask(new Task("sleep " + sleepTimeMs, parser)),
      )
      await Promise.all(firstBatchPromises)
      bc.vacuumProcs()

      // We should be dropping BatchProcesses at this point.
      expect(bc.busyProcCount).to.be.within(0, maxProcs2)
      expect(bc.procCount).to.be.within(0, maxProcs2)

      await Promise.all(secondBatchPromises)

      expect(bc.busyProcCount).to.eql(0) // because we're done

      // Assert that there were excess procs shut down:
      expect(bc.childEndCounts.tooMany).to.be.closeTo(maxProcs - maxProcs2, 2)

      // don't shut down until bc is idle... (otherwise we'll fail due to
      // "Error: end() called before task completed
      // ({\"gracefully\":true,\"source\":\"BatchCluster.closeChildProcesses()\"})"
      await until(() => bc.isIdle, 5000)

      postAssertions()
    })
  })

  describe(".end() cleanup", () => {
    const sleepTimeMs = 1000 // must be longer than non-graceful timeout (currently 250)
    let bc: BatchCluster
    afterEach(() => shutdown(bc))

    function stats() {
      // we don't want msBeforeNextSpawn because it'll be wiggly and we're not
      // freezing time (here)
      return omit(bc.stats(), "msBeforeNextSpawn") as Record<string, unknown>
    }

    it("shut down rejects long-running pending tasks", async () => {
      setFailratePct(0)
      const opts = {
        ...DefaultTestOptions,
        taskTimeoutMillis: sleepTimeMs * 4, // < don't test timeouts here
        processFactory,
      }
      bc = new BatchCluster(opts)
      // Wait for one job to run (so the process spins up and we're ready to go)
      await Promise.all(runTasks(bc, 1))

      expect(stats()).to.eql({
        pendingTaskCount: 0,
        currentProcCount: 1,
        readyProcCount: 1,
        maxProcCount: 4,
        internalErrorCount: 0,
        startErrorRatePerMinute: 0,
        spawnedProcCount: 1,
        childEndCounts: {},
        ending: false,
        ended: false,
      })

      const t = bc.enqueueTask(new Task("sleep " + sleepTimeMs, parser))

      expect(stats()).to.eql({
        pendingTaskCount: 1,
        currentProcCount: 1,
        readyProcCount: 1,
        maxProcCount: 4,
        internalErrorCount: 0,
        startErrorRatePerMinute: 0,
        spawnedProcCount: 1,
        childEndCounts: {},
        ending: false,
        ended: false,
      })

      t.catch((err: unknown) => (caught = err))
      await delay(2)

      expect(stats()).to.eql({
        pendingTaskCount: 0, // < yay it's getting processed
        currentProcCount: 1,
        readyProcCount: 0,
        maxProcCount: 4,
        internalErrorCount: 0,
        startErrorRatePerMinute: 0,
        spawnedProcCount: 1,
        childEndCounts: {},
        ending: false,
        ended: false,
      })

      let caught: unknown
      expect(bc.isIdle).to.eql(false)
      await bc.end(false) // not graceful just to shut down faster

      expect(stats()).to.eql({
        pendingTaskCount: 0,
        currentProcCount: 0,
        readyProcCount: 0,
        maxProcCount: 4,
        internalErrorCount: 0,
        startErrorRatePerMinute: 0,
        spawnedProcCount: 1,
        childEndCounts: { ending: 1 },
        ending: true,
        ended: true,
      })

      expect(bc.isIdle).to.eql(true)
      expect((caught as Error)?.message).to.include(
        "Process terminated before task completed",
      )
      expect(unhandledRejections).to.eql([])
    })
  })

  describe("maxProcAgeMillis (cull old children)", function () {
    const opts = {
      ...DefaultTestOptions,
      maxProcs: 4,
      maxTasksPerProcess: 100,
      spawnTimeoutMillis: 2000, // maxProcAge must be >= this
      maxProcAgeMillis: 3000,
      minDelayBetweenSpawnMillis: 0,
    }

    let bc: BatchCluster

    beforeEach(
      () =>
        (bc = listen(
          new BatchCluster({
            ...opts,
            processFactory,
          }),
        )),
    )

    afterEach(() => shutdown(bc))

    it("culls old child procs", async () => {
      assertExpectedResults(
        await Promise.all(runTasks(bc, opts.maxProcs + 100)),
      )
      // 0 because we might get unlucky.
      expect(bc.pids().length).to.be.within(0, opts.maxProcs)
      await delay(opts.maxProcAgeMillis + 100)
      await bc.vacuumProcs()
      console.log({
        childEndCounts: bc.childEndCounts,
        procCount: bc.procCount,
        maxProcs: opts.maxProcs,
      })
      expect(bc.countEndedChildProcs("idle")).to.eql(0)
      expect(bc.countEndedChildProcs("old")).to.be.gte(2)
      // Calling .pids calls .procs(), which culls old procs
      expect(bc.pids().length).to.be.within(0, opts.maxProcs)
      postAssertions()
    })
  })

  describe("maxIdleMsPerProcess", function () {
    const opts = {
      ...DefaultTestOptions,
      maxProcs: 4,
      maxIdleMsPerProcess: 1000,
      maxProcAgeMillis: 30_000,
    }

    let bc: BatchCluster

    beforeEach(
      () =>
        (bc = listen(
          new BatchCluster({
            ...opts,
            processFactory,
          }),
        )),
    )

    afterEach(() => shutdown(bc))

    it("culls idle child procs", async () => {
      assertExpectedResults(await Promise.all(runTasks(bc, opts.maxProcs + 10)))
      // 0 because we might get unlucky.
      expect(bc.pids().length).to.be.within(0, opts.maxProcs)
      // wait long enough for at least 1 process to be idle and get reaped:
      await delay(opts.maxIdleMsPerProcess + 100)
      await bc.vacuumProcs()
      console.log({
        childEndCounts: bc.childEndCounts,
        procCount: bc.procCount,
        maxProcs: opts.maxProcs,
      })
      expect(bc.countEndedChildProcs("idle")).to.be.gte(1)
      expect(bc.countEndedChildProcs("old")).to.be.lte(1)
      expect(bc.countEndedChildProcs("worn")).to.be.lte(2)
      // Calling .pids calls .procs(), which culls old procs
      if (bc.pids().length > 0) {
        await delay(1000)
      }
      expect(bc.pids().length).to.eql(0)
      postAssertions()
    })
  })

  describe("maxProcAgeMillis (recycling procs)", () => {
    let bc: BatchCluster
    let clock: FakeTimers.InstalledClock

    beforeEach(() => {
      clock = FakeTimers.install({
        shouldClearNativeTimers: true,
        shouldAdvanceTime: true,
      })
    })

    afterEach(() => {
      clock.uninstall()
      return shutdown(bc)
    })

    for (const { maxProcAgeMillis, ctx, exp } of [
      {
        maxProcAgeMillis: 0,
        ctx: "procs should not be recycled due to old age",
        exp: (pidsBefore: number[], pidsAfter: number[]) => {
          expect(pidsBefore).to.eql(pidsAfter)
          expect(bc.countEndedChildProcs("idle")).to.eql(0)
          expect(bc.countEndedChildProcs("old")).to.eql(0)
        },
      },
      {
        maxProcAgeMillis: 5000,
        ctx: "procs should be recycled due to old age",
        exp: (pidsBefore: number[], pidsAfter: number[]) => {
          expect(pidsBefore).to.not.have.members(pidsAfter)
          expect(bc.countEndedChildProcs("idle")).to.eql(0)
          expect(bc.countEndedChildProcs("old")).to.be.gte(1)
        },
      },
    ]) {
      it("(" + maxProcAgeMillis + "): " + ctx, async function () {
        // TODO: look into why this fails in CI on windows
        if (isWin && isCI) return this.skip()
        setFailratePct(0)

        bc = listen(
          new BatchCluster({
            ...DefaultTestOptions,
            maxProcs: 1,
            maxProcAgeMillis,
            spawnTimeoutMillis: Math.max(maxProcAgeMillis, 200),
            processFactory,
          }),
        )
        assertExpectedResults(await Promise.all(runTasks(bc, 2)))
        const pidsBefore = bc.pids()
        clock.tick(7000)
        assertExpectedResults(await Promise.all(runTasks(bc, 2)))
        const pidsAfter = bc.pids()
        console.dir({ maxProcAgeMillis, pidsBefore, pidsAfter })
        exp(pidsBefore, pidsAfter)
        postAssertions()
        return
      })
    }
  })
})
