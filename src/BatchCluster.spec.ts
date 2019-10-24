import { inspect } from "util"

import {
  currentTestPids,
  expect,
  parser,
  parserErrors,
  processFactory,
  procs,
  setFailrate,
  setIgnoreExit,
  setNewline,
  testPids,
  times
} from "./_chai.spec"
import { flatten, sortNumeric } from "./Array"
import { delay, until } from "./Async"
import { BatchCluster } from "./BatchCluster"
import { BatchClusterOptions } from "./BatchClusterOptions"
import { logger } from "./Logger"
import { map, orElse } from "./Object"
import { toS } from "./String"
import { Task } from "./Task"

const tk = require("timekeeper")

describe("BatchCluster", function() {
  this.retries(3)
  const ErrorPrefix = "ERROR: "

  const DefaultOpts = {
    ...new BatchClusterOptions(),
    maxProcs: 4, // < force concurrency
    versionCommand: "version",
    pass: "PASS",
    fail: "FAIL",
    exitCommand: "exit",
    onIdleIntervalMillis: 250, // frequently to speed up tests
    maxTasksPerProcess: 5, // force process churn
    spawnTimeoutMillis: 2000,
    taskTimeoutMillis: 200, // so the timeout test doesn't timeout
    maxReasonableProcessFailuresPerMinute: 2000, // this is so high because failrate is so high
    minDelayBetweenSpawnMillis: 0,
    streamFlushMillis: 100 // ci is slow
  }

  function runTasks(
    bc: BatchCluster,
    iterations: number,
    start = 0
  ): Promise<string>[] {
    return times(iterations, i =>
      bc
        .enqueueTask(new Task("upcase abc " + (i + start), parser))
        .catch(err => ErrorPrefix + err)
    )
  }

  function assertExpectedResults(results: string[]) {
    const dataResults = flatten(
      events.taskData.map(ea => ea.data.split(/[\n\r]+/))
    )

    results.forEach((result, index) => {
      if (!result.startsWith(ErrorPrefix)) {
        expect(result).to.eql("ABC " + index)
        expect(dataResults).to.include(result)
      }
    })
  }

  class Events {
    readonly taskData: { cmd?: string; data: string }[] = []
    readonly events: { event: string }[] = []
    readonly startedPids: number[] = []
    readonly exittedPids: number[] = []
    readonly startErrors: Error[] = []
    readonly endErrors: Error[] = []
    readonly internalErrors: Error[] = []
    readonly taskErrors: Error[] = []
  }

  let events = new Events()

  beforeEach(() => {
    events = new Events()
  })

  afterEach(() => {
    expect(events.internalErrors).to.eql([], "internal errors")
  })

  const expectedEndEvents = [{ event: "beforeEnd" }, { event: "end" }]

  async function shutdown(bc: BatchCluster) {
    const endPromise = bc.end(true)
    expect(bc.ended).to.eql(true)
    // 10 seconds is a damn long time for a process to exit.
    expect(await until(() => !endPromise.pending, 20_000, 500)).to.eql(true)
    const done = await until(
      async count => {
        const idle = bc.isIdle
        const pidCount = (await bc.pids()).length
        const livingPids = await currentTestPids()
        console.log("shutdown(): waiting for end", {
          count,
          idle,
          pidCount,
          livingPids
        })
        return idle && pidCount === 0 && livingPids.length === 0
      },
      20_000,
      500 // <  don't hammer tasklist too hard
    )
    expect(done).to.eql(true)
    expect(bc.internalErrorCount).to.eql(0)
    return
  }

  function listen(bc: BatchCluster) {
    // This is a typings verification, too:
    bc.on("childStart", cp => events.startedPids.push(cp.pid))
    bc.on("childExit", cp => events.exittedPids.push(cp.pid))
    bc.on("startError", err => events.startErrors.push(err))
    bc.on("endError", err => events.endErrors.push(err))
    bc.on("internalError", err => {
      logger().warn("BatchCluster.spec listen(): internal error: " + err)
      events.internalErrors.push(err)
    })
    bc.on("taskData", (data, task) =>
      events.taskData.push({
        cmd: map(task, ea => ea.command),
        data: toS(data)
      })
    )
    bc.on("taskError", err => events.taskErrors.push(err))

    const emptyEvents = ["beforeEnd", "end"]
    emptyEvents.forEach(event =>
      bc.on("beforeEnd", () => events.events.push({ event }))
    )
    return bc
  }

  ;["lf", "crlf"].forEach(newline =>
    [1, 4].forEach(maxProcs =>
      [false, true].forEach(ignoreExit =>
        describe(
          inspect(
            { newline, maxProcs, ignoreExit },
            { colors: true, breakLength: 100 }
          ),
          function() {
            let bc: BatchCluster
            const opts = {
              ...DefaultOpts,
              maxProcs
            }

            // failrate needs to be high enough to trigger but low enough to allow
            // retries to succeed.

            beforeEach(() => {
              setNewline(newline as any)
              setIgnoreExit(ignoreExit)
              bc = listen(new BatchCluster({ ...opts, processFactory }))
              procs.length = 0
            })

            afterEach(async () => {
              // tslint:disable-next-line: no-floating-promises
              await shutdown(bc)
              expect(bc.internalErrorCount).to.eql(0)
              return
            })

            it("calling .end() when new no-ops", async () => {
              await bc.end()
              expect(bc.ended).to.eql(true)
              expect(bc.isIdle).to.eql(true)
              expect((await bc.pids()).length).to.eql(0)
              expect(bc.spawnedProcs).to.eql(0)
              expect(events.events).to.eql(expectedEndEvents)
              expect(testPids()).to.eql([])
              expect(events.startedPids).to.eql([])
              expect(events.exittedPids).to.eql([])
              return
            })

            it("calling .end() after running shuts down child procs", async () => {
              // This just warms up bc to make child procs:
              const iterations = maxProcs * 2
              setFailrate(25) // 25%

              const tasks = await Promise.all(runTasks(bc, iterations))
              assertExpectedResults(tasks)
              await shutdown(bc)
              expect(bc.spawnedProcs).to.be.within(maxProcs, iterations + 1)
              const pids = sortNumeric(testPids())
              expect(pids.length).to.be.gte(maxProcs)
              expect(sortNumeric(events.startedPids)).to.eql(pids)
              expect(sortNumeric(events.exittedPids)).to.eql(pids)
              expect(events.events).to.eql(expectedEndEvents)
              return
            })

            it(
              "runs a given batch process roughly " +
                opts.maxTasksPerProcess +
                " before recycling",
              async () => {
                // make sure we hit an EUNLUCKY:
                setFailrate(50) // 50%
                let expectedResultCount = 0
                const results = await Promise.all(runTasks(bc, maxProcs))
                expectedResultCount += maxProcs
                const pids = await bc.pids()
                const iters = Math.floor(
                  maxProcs * opts.maxTasksPerProcess * 1.5
                )
                results.push(
                  ...(await Promise.all(
                    runTasks(bc, iters, expectedResultCount)
                  ))
                )
                expectedResultCount += iters
                assertExpectedResults(results)
                expect(results.length).to.eql(expectedResultCount)
                // And expect some errors:
                const errorResults = results.filter(ea =>
                  ea.startsWith(ErrorPrefix)
                )
                expect(errorResults).to.not.eql([])

                // Expect a reasonable number of new pids. Worst case, we
                // errored after every start, so there may be more then iters
                // pids spawned.
                expect(procs.length).to.eql(bc.spawnedProcs)
                expect(bc.spawnedProcs).to.be.within(
                  results.length / opts.maxTasksPerProcess,
                  results.length
                )

                // Expect no prior pids to remain, as long as there were before-pids:
                if (pids.length > 0)
                  expect(await bc.pids()).to.not.include.members(pids)

                expect(bc.spawnedProcs).to.be.within(maxProcs, results.length)
                expect(bc.meanTasksPerProc).to.be.within(
                  0.5, // because flaky
                  opts.maxTasksPerProcess
                )
                expect((await bc.pids()).length).to.be.lte(maxProcs)
                expect((await currentTestPids()).length).to.be.lte(
                  bc.spawnedProcs
                ) // because flaky
                await shutdown(bc)
                return
              }
            )

            it("recovers from invalid commands", async () => {
              assertExpectedResults(
                await Promise.all(runTasks(bc, maxProcs * 4))
              )
              const errorResults = await Promise.all(
                times(maxProcs * 2, () =>
                  bc.enqueueTask(new Task("nonsense", parser)).catch(err => err)
                )
              )
              expect(
                errorResults.some(ea => String(ea).includes("nonsense"))
              ).to.eql(true, JSON.stringify(errorResults))
              expect(parserErrors.some(ea => ea.includes("nonsense"))).to.eql(
                true,
                JSON.stringify(parserErrors)
              )
              parserErrors.length = 0
              // BC should recover:
              assertExpectedResults(
                await Promise.all(runTasks(bc, maxProcs * 4))
              )
              return
            })

            it("times out slow requests", async () => {
              const task = new Task(
                "sleep " + (opts.taskTimeoutMillis + 250), // < make sure it times out
                parser
              )
              return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
                /timeout|EUNLUCKY/
              )
            })

            it("accepts single and multi-line responses", async () => {
              setFailrate(0)
              const expected: string[] = []
              const results = await Promise.all(
                times(15, idx => {
                  // Make a distribution of single, double, and triple line outputs:
                  const worlds = times(idx % 3, ea => "world " + ea)
                  expected.push(
                    [idx + " HELLO", ...worlds].join("\n").toUpperCase()
                  )
                  const cmd = ["upcase " + idx + " hello", ...worlds].join(
                    "<br>"
                  )
                  return bc.enqueueTask(new Task(cmd, parser))
                })
              )
              expect(results).to.eql(expected)
              return
            })

            it("rejects a command that results in FAIL", async function() {
              const task = new Task("invalid command", parser)
              let error: Error | undefined
              let result: string = ""
              try {
                result = await bc.enqueueTask(task)
              } catch (err) {
                error = err
              }
              expect(String(error)).to.match(/invalid command|UNLUCKY/, result)
              return
            })

            it("rejects a command that emits to stderr", async function() {
              const task = new Task("stderr omg this should fail", parser)
              let error: Error | undefined
              let result: string = ""
              try {
                result = await bc.enqueueTask(task)
              } catch (err) {
                error = err
              }
              expect(String(error)).to.match(
                /omg this should fail|UNLUCKY/,
                result
              )
              return
            })
          }
        )
      )
    )
  )

  describe("maxProcs", function() {
    const iters = 50
    const maxProcs = 10
    const sleepTimeMs = 250
    let bc: BatchCluster
    afterEach(() => bc.end())
    ;[
      {
        minDelayBetweenSpawnMillis: 0,
        expectTaskMin: 3,
        expectedTaskMax: 7,
        expectedProcsMin: maxProcs,
        expectedProcsMax: maxProcs + 2
      },
      {
        minDelayBetweenSpawnMillis: 500,
        expectTaskMin: 1,
        expectedTaskMax: 13,
        expectedProcsMin: 6,
        expectedProcsMax: 10
      }
    ].forEach(
      ({
        minDelayBetweenSpawnMillis,
        expectTaskMin,
        expectedTaskMax,
        expectedProcsMin,
        expectedProcsMax
      }) => {
        it(
          inspect(
            { minDelayBetweenSpawnMillis },
            { colors: false, breakLength: 100 }
          ),
          async function() {
            setFailrate(0)
            const opts = {
              ...DefaultOpts,
              taskTimeoutMillis: sleepTimeMs * 4, // < don't test timeouts here
              maxProcs,
              maxTasksPerProcess: expectedTaskMax + 5, // < don't recycle procs for this test
              minDelayBetweenSpawnMillis,
              processFactory
            }
            bc = listen(new BatchCluster(opts))
            expect(bc.isIdle).to.eql(true)
            const tasks = await Promise.all(
              times(iters, async i => {
                const start = Date.now()
                const task = new Task("sleep " + sleepTimeMs, parser)
                const resultP = bc.enqueueTask(task)
                expect(bc.isIdle).to.eql(false)
                const result = JSON.parse(await resultP)
                const end = Date.now()
                return { i, start, end, ...result }
              })
            )
            const pid2count = new Map<number, number>()
            tasks.forEach(ea => {
              const pid = ea.pid
              const count = orElse(pid2count.get(pid), 0)
              pid2count.set(pid, count + 1)
            })
            expect(bc.isIdle).to.eql(true)
            console.log({
              expectTaskMin,
              expectedTaskMax,
              maxProcs,
              uniqPids: pid2count.size,
              pid2count,
              bc_pids: await bc.pids()
            })
            for (const [, count] of pid2count.entries()) {
              expect(count).to.be.within(expectTaskMin, expectedTaskMax)
            }
            expect(pid2count.size).to.be.within(
              expectedProcsMin,
              expectedProcsMax
            )
          }
        )
      }
    )
  })

  describe("maxProcAgeMillis", function() {
    const opts = {
      ...DefaultOpts,
      maxProcs: 4,
      maxTasksPerProcess: 100,
      spawnTimeoutMillis: 1000, // maxProcAge must be >= this
      maxProcAgeMillis: 1000
    }

    let bc: BatchCluster

    beforeEach(
      () =>
        (bc = listen(
          new BatchCluster({
            ...opts,
            processFactory
          })
        ))
    )

    afterEach(async () => {
      await shutdown(bc)
      return
    })

    it("culls old child procs", async () => {
      assertExpectedResults(
        await Promise.all(runTasks(bc, opts.maxProcs + 100))
      )
      expect((await bc.pids()).length).to.be.within(1, opts.maxProcs)
      await delay(opts.maxProcAgeMillis)
      // Calling .pids calls .procs(), which culls old procs
      expect((await bc.pids()).length).to.be.within(0, opts.maxProcs)
      return
    })
  })

  describe("maxProcAgeMillis", () => {
    let bc: BatchCluster

    afterEach(() => {
      tk.reset()
      map(bc, ea => ea.end())
    })
    ;[
      {
        maxProcAgeMillis: 0,
        ctx: "procs should not be recycled due to old age",
        exp: (pidsBefore: number[], pidsAfter: number[]) =>
          expect(pidsBefore).to.eql(pidsAfter)
      },
      {
        maxProcAgeMillis: 5000,
        ctx: "procs should be recycled due to old age",
        exp: (pidsBefore: number[], pidsAfter: number[]) =>
          expect(pidsBefore).to.not.have.members(pidsAfter)
      }
    ].forEach(({ maxProcAgeMillis, ctx, exp }) =>
      it("(" + maxProcAgeMillis + "): " + ctx, async () => {
        const now = Date.now()
        tk.freeze(now)
        setFailrate(0)

        bc = listen(
          new BatchCluster({
            ...DefaultOpts,
            maxProcs: 1,
            maxProcAgeMillis,
            processFactory
          })
        )
        assertExpectedResults(await Promise.all(runTasks(bc, 2)))
        const pidsBefore = await bc.pids()
        tk.freeze(now + 7000)
        assertExpectedResults(await Promise.all(runTasks(bc, 2)))
        const pidsAfter = await bc.pids()
        console.dir({ maxProcAgeMillis, pidsBefore, pidsAfter })
        exp(pidsBefore, pidsAfter)
        return
      })
    )
  })

  describe("opts parsing", () => {
    function errToArr(err: any) {
      return err
        .toString()
        .split(/[:,]/)
        .map((ea: string) => ea.trim())
    }

    it("requires maxProcAgeMillis to be > spawnTimeoutMillis", () => {
      const spawnTimeoutMillis = DefaultOpts.taskTimeoutMillis + 1
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          ...DefaultOpts,
          spawnTimeoutMillis,
          maxProcAgeMillis: spawnTimeoutMillis - 1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            spawnTimeoutMillis
        ])
      }
    })

    it("requires maxProcAgeMillis to be > taskTimeoutMillis", () => {
      const taskTimeoutMillis = DefaultOpts.spawnTimeoutMillis + 1
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          ...DefaultOpts,
          taskTimeoutMillis,
          maxProcAgeMillis: taskTimeoutMillis - 1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "maxProcAgeMillis must be greater than or equal to " +
            taskTimeoutMillis
        ])
      }
    })

    it("reports on invalid opts", () => {
      try {
        // tslint:disable-next-line: no-unused-expression
        new BatchCluster({
          processFactory,
          versionCommand: "",
          pass: "",
          fail: "",

          spawnTimeoutMillis: 50,
          taskTimeoutMillis: 5,
          maxTasksPerProcess: 0,

          maxProcs: -1,
          maxProcAgeMillis: -1,
          onIdleIntervalMillis: -1,
          endGracefulWaitTimeMillis: -1,
          streamFlushMillis: -1
        })
        throw new Error("expected an error due to invalid opts")
      } catch (err) {
        expect(errToArr(err)).to.eql([
          "Error",
          "BatchCluster was given invalid options",
          "versionCommand must not be blank",
          "pass must not be blank",
          "fail must not be blank",
          "spawnTimeoutMillis must be greater than or equal to 100",
          "taskTimeoutMillis must be greater than or equal to 10",
          "maxTasksPerProcess must be greater than or equal to 1",
          "maxProcs must be greater than or equal to 1",
          "maxProcAgeMillis must be greater than or equal to 50",
          "onIdleIntervalMillis must be greater than or equal to 0",
          "endGracefulWaitTimeMillis must be greater than or equal to 0",
          "streamFlushMillis must be greater than or equal to 0"
        ])
      }
    })
  })
})
