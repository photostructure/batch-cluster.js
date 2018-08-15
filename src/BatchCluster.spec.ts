import { inspect } from "util"

import {
  currentTestPids,
  expect,
  parser,
  procs,
  testProcessFactory,
  times
} from "./_chai.spec"
import { delay, until } from "./Async"
import { BatchCluster, BatchClusterOptions } from "./BatchCluster"
import { Task } from "./Task"

describe("BatchCluster", function() {
  function runTasks(bc: BatchCluster, iterations: number): Promise<string>[] {
    return times(iterations, i =>
      bc
        .enqueueTask(new Task("upcase abc " + i, parser))
        .catch(err => String(err))
    )
  }

  function assertExpectedResults(results: string[]) {
    results.forEach((result, index) => {
      if (!result.includes("Error")) {
        expect(result).to.eql("ABC " + index)
      }
    })
  }

  const events: Event[] = []
  const expectedEndEvents = [{ event: "beforeEnd" }, { event: "end" }]

  function listen(bc: BatchCluster) {
    ;["startError", "taskError", "endError", "beforeEnd", "end"].forEach(
      event => {
        bc.on(event as any, (...args: any[]) => {
          const ev: Event = { event }
          if (args.length > 0) {
            ev.args = args
          }
          events.push(ev)
        })
      }
    )
    return bc
  }

  const defaultOpts = Object.freeze({
    ...new BatchClusterOptions(),
    maxProcs: 4, // < force concurrency
    versionCommand: "version",
    pass: "PASS",
    fail: "FAIL",
    exitCommand: "exit",
    onIdleIntervalMillis: 250, // frequently to speed up tests
    maxTasksPerProcess: 5,
    spawnTimeoutMillis: 1000,
    taskTimeoutMillis: 500, // so the timeout test doesn't timeout
    maxReasonableProcessFailuresPerMinute: 2000 // this is so high because failrate is so high
  })

  afterEach(() => {
    events.length = 0
  })

  interface Event {
    event: string
    args?: any
  }

  ;["lf", "crlf"].forEach(newline =>
    [3, 1].forEach(maxProcs =>
      [true, false].forEach(ignoreExit =>
        describe(
          inspect(
            { newline, maxProcs, ignoreExit },
            { colors: true, breakLength: 100 }
          ),
          () => {
            let bc: BatchCluster
            const opts = {
              ...defaultOpts,
              maxProcs
            }

            // failrate needs to be high enough to trigger but low enough to allow
            // retries to succeed.
            let failrate: string

            beforeEach(() => {
              // Seeding the RNG deterministically gives us repeatable flakiness/successes.
              failrate = "0.1"

              bc = listen(
                new BatchCluster({
                  ...opts,
                  // seed needs to change for each process, or we'll always be
                  // lucky or unlucky
                  processFactory: () =>
                    testProcessFactory({
                      newline,
                      failrate,
                      ignoreExit: ignoreExit ? "1" : "0"
                    })
                })
              )
              procs.length = 0
            })

            afterEach(() => {
              expect(bc.internalErrorCount).to.eql(0)
              return bc.end(false)
            })

            it("calling .end() when new no-ops", async () => {
              await bc.end()
              expect((await bc.pids()).length).to.eql(0)
              expect(bc.spawnedProcs).to.eql(0)
              expect(events).to.eql(expectedEndEvents)
              return
            })

            it("calling .end() after running shuts down child procs", async () => {
              // This just warms up bc to make child procs:
              const iterations = maxProcs
              const tasks = await Promise.all(runTasks(bc, iterations * 2))
              assertExpectedResults(tasks)
              await bc.end()
              expect(bc.spawnedProcs).to.be.within(maxProcs, maxProcs + 8) // because EUNLUCKY
              expect((await bc.pids()).length).to.eql(0)
              expect(await currentTestPids()).to.eql([])
              expect(events.filter(ea => !ea.event.includes("Error"))).to.eql([
                { event: "beforeEnd" },
                { event: "end" }
              ])
              return
            })

            it(
              "runs a given batch process roughly " +
                opts.maxTasksPerProcess +
                " before recycling",
              async () => {
                // make sure we hit an EUNLUCKY:
                const iters = opts.maxTasksPerProcess * maxProcs + 50
                await Promise.all(runTasks(bc, maxProcs))
                const pids = await bc.pids()
                const tasks = await Promise.all(runTasks(bc, iters))
                assertExpectedResults(tasks)
                // And expect some errors:
                expect(tasks.filter(ea => ea.includes("EUNLUCKY"))).to.not.eql(
                  []
                )

                // Expect a reasonable number of new pids. Worst case, we
                // errored after every start, so there may be more then iters
                // pids spawned.
                expect(procs.length).to.eql(bc.spawnedProcs)
                expect(bc.spawnedProcs).to.be.within(
                  iters / opts.maxTasksPerProcess,
                  iters
                )

                // Expect no prior pids to remain:
                expect(await bc.pids()).to.not.include.members(pids)

                expect(bc.spawnedProcs).to.be.within(maxProcs, tasks.length)
                expect(bc.meanTasksPerProc).to.be.within(
                  0.5, // because flaky
                  opts.maxTasksPerProcess
                )
                expect((await bc.pids()).length).to.be.lte(maxProcs)
                expect((await currentTestPids()).length).to.be.lte(
                  bc.spawnedProcs
                ) // because flaky
                await bc.end()
                await until(
                  () => currentTestPids().then(arr => arr.length == 0),
                  5000
                )
                expect(await bc.pids()).to.eql([])
                expect(await currentTestPids()).to.eql([])
                return
              }
            )

            it("recycles procs if the command is invalid", async () => {
              // we need to run one task to "prime the pid pump"
              await expect(
                bc
                  .enqueueTask(new Task("downcase Hello", parser))
                  .catch(err => err)
              ).to.eventually.match(/hello|UNLUCKY/)
              const pidsBefore = await bc.pids()
              const spawnedProcsBefore = bc.spawnedProcs
              expect((await bc.pids()).length).to.be.within(1, 3) // we may have spun up another proc due to EUNLUCKY
              for (let i = 0; i < maxProcs * 2; i++) {
                await expect(
                  bc.enqueueTask(new Task("invalid", parser))
                ).to.eventually.be.rejectedWith(/invalid|EUNLUCKY/)
              }
              const newSpawnedProcs = bc.spawnedProcs - spawnedProcsBefore
              expect(newSpawnedProcs).to.be.within(1, maxProcs * 4) // < because EUNLUCKY
              expect(await bc.pids()).to.not.eql(pidsBefore) // at least one pid should be shut down now
              const lastEvent = events[events.length - 1]
              expect(lastEvent.event).to.eql(
                "taskError",
                JSON.stringify(events)
              )
              const err = String(lastEvent.args[0])
              if (!err.startsWith("Error: stderr.data: EUNLUCKY")) {
                expect(err).to.eql(
                  "Error: stderr.data: COMMAND MISSING for input invalid",
                  JSON.stringify(events)
                )
              }
              expect(bc.internalErrorCount).to.eql(0)
              return
            })

            it("times out slow requests", async () => {
              const task = new Task(
                "sleep " + (opts.taskTimeoutMillis + 250), // < make sure it times out
                parser
              )
              await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
                /timeout|EUNLUCKY/
              )
              return
            })

            it("rejects a command that emits to stderr", async () => {
              const task = new Task("stderr omg this should fail", parser)
              await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
                /omg this should fail|UNLUCKY/
              )
              return
            })
          }
        )
      )
    )
  )

  describe("flaky results", () => {
    const bc = new BatchCluster({
      ...defaultOpts,
      processFactory: testProcessFactory
    })

    after(() => {
      return bc.end(false)
    })

    it("retries a flaky task", async function() {
      const iters = 100
      const completedTasks: Task<string>[] = []
      const failedTasks: Task<string>[] = []
      const results: string[] = []
      const errs: Error[] = []

      const tasks = times(iters, i => new Task("flaky .5 " + i, parser))
      // Enqueue all tasks simultaneously (to maximize thrash)
      const promises = tasks.map(task =>
        bc
          .enqueueTask(task)
          .then((result: string) => {
            completedTasks.push(task)
            results.push(result)
          })
          .catch((err: Error) => {
            failedTasks.push(task)
            errs.push(err)
          })
      )
      await until(() => !tasks.some(task => task.pending), 5000)
      // console.dir( {
      //   spawnedProcs: bc.spawnedProcs,
      //   pendingTasks: tasks.filter(ea => ea.pending).map(ea => ea.command)
      // })
      await Promise.all(promises)
      expect(results).to.not.eql([])
      results.forEach(ea => expect(ea).to.include("flaky response"))
      expect(errs).to.not.eql([])
      errs.forEach(ea => expect(String(ea)).to.match(/FAIL|Error/i))
      expect(bc.spawnedProcs).to.be.within(2, iters)
      expect(bc.internalErrorCount).to.eql(0)
      return
    })
  })

  describe("maxProcAgeMillis", () => {
    const opts = {
      ...defaultOpts,
      maxProcs: 4,
      maxTasksPerProcess: 100,
      maxProcAgeMillis: 1000
    }

    let bc: BatchCluster

    beforeEach(() =>
      (bc = new BatchCluster({
        ...opts,
        processFactory: testProcessFactory
      })))

    afterEach(() => {
      expect(bc.internalErrorCount).to.eql(0)
      bc.end(false)
    })

    it("culls old child procs", async () => {
      assertExpectedResults(
        await Promise.all(runTasks(bc, opts.maxProcs + 100))
      )
      expect((await bc.pids()).length).to.be.within(1, opts.maxProcs)
      await delay(opts.maxProcAgeMillis)
      // Calling .pids calls .procs(), which culls old procs
      expect((await bc.pids()).length).to.be.within(0, opts.maxProcs)
      // Wait for the procs to shut down:
      if ((await bc.pids()).length > 0) {
        await delay(500)
      }
      expect(await bc.pids()).to.be.empty
      return
    })
  })

  describe("opts parsing", () => {
    function errToArr(err: any) {
      return err
        .toString()
        .split(/[:,]/)
        .map((ea: string) => ea.trim())
    }

    it("requires maxProcAgeMillis to be > spawnTimeoutMillis", () => {
      const spawnTimeoutMillis = defaultOpts.taskTimeoutMillis + 1
      try {
        new BatchCluster({
          processFactory: testProcessFactory,
          ...defaultOpts,
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
      const taskTimeoutMillis = defaultOpts.spawnTimeoutMillis + 1
      try {
        new BatchCluster({
          processFactory: testProcessFactory,
          ...defaultOpts,
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
        new BatchCluster({
          processFactory: testProcessFactory,
          versionCommand: "",
          pass: "",
          fail: "",

          spawnTimeoutMillis: 50,
          taskTimeoutMillis: 5,
          maxTasksPerProcess: 0,

          maxProcs: -1,
          maxProcAgeMillis: -1,
          onIdleIntervalMillis: -1,
          endGracefulWaitTimeMillis: -1
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
          "endGracefulWaitTimeMillis must be greater than or equal to 0"
        ])
      }
    })
  })
})
