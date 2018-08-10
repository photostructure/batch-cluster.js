import { inspect } from "util"

import { BatchCluster, BatchClusterOptions } from "./BatchCluster"
import {
  currentTestPids,
  expect,
  parser,
  procs,
  testProcessFactory,
  times
} from "./chai.spec"
import { delay, until } from "./Delay"
import { running } from "./Procs"
import { Task } from "./Task"

describe("BatchCluster", function() {
  function runTasks(
    bc: BatchCluster,
    iterations: number
  ): Array<Promise<string>> {
    return times(iterations, i =>
      bc.enqueueTask(new Task("upcase abc " + i, parser))
    )
  }

  function expectedResults(iterations: number): string[] {
    return times(iterations, i => "ABC " + i)
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

  function specsWithOptions(
    newline: string,
    maxProcs: number,
    ignoreExit: boolean
  ) {
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
          return bc.end(false)
        })

        it("calling .end() when new no-ops", async () => {
          await bc.end()
          expect((await bc.pids()).length).to.eql(0)
          expect(bc.spawnedProcs).to.eql(0)
          expect(events).to.eql(expectedEndEvents)
          return
        })

        xit("calling .end() after running shuts down child procs", async () => {
          // This just warms up bc to make child procs:
          const iterations = maxProcs
          expect(await Promise.all(runTasks(bc, iterations))).to.eql(
            expectedResults(iterations)
          )
          await bc.end()
          expect(bc.spawnedProcs).to.be.within(maxProcs, maxProcs + 8) // because EUNLUCKY
          expect((await bc.pids()).length).to.eql(0)
          expect(await currentTestPids()).to.eql([])
          const startErrorEvent = events.find(ea => ea.event === "startError")
          if (startErrorEvent != null) {
            expect(String(startErrorEvent.args[0])).to.startWith(
              "Error: stderr.data: EUNLUCKY",
              JSON.stringify(events)
            )
          }
          expect(events.slice(-2)).to.eql(
            expectedEndEvents,
            JSON.stringify(events)
          )
          return
        })

        xit(
          "runs a given batch process roughly " +
            opts.maxTasksPerProcess +
            " before recycling",
          async () => {
            await Promise.all(runTasks(bc, maxProcs))
            const pids = await bc.pids()
            const tasks = await Promise.all(
              runTasks(bc, opts.maxTasksPerProcess * maxProcs)
            )
            expect(tasks).to.eql(
              expectedResults(opts.maxTasksPerProcess * maxProcs)
            )
            expect(await bc.pids()).to.not.include.members(pids)
            const upperBoundSpawnedProcs = maxProcs * 2 // because fail rate
            expect(bc.spawnedProcs).to.be.within(
              maxProcs,
              upperBoundSpawnedProcs
            )
            expect(bc.meanTasksPerProc).to.be.within(
              0.5, // because flaky
              opts.maxTasksPerProcess
            )
            expect((await currentTestPids()).length).to.be.lte(maxProcs)
            return
          }
        )

        xit("recycles procs if the command is invalid", async () => {
          // we need to run one task to "prime the pid pump"
          expect(
            await bc.enqueueTask(new Task("downcase Hello", parser))
          ).to.eql("hello")
          const pidsBefore = await bc.pids()
          const spawnedProcsBefore = bc.spawnedProcs
          expect((await bc.pids()).length).to.be.within(1, 3) // we may have spun up another proc due to EUNLUCKY
          const task = new Task("invalid", parser)
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /invalid|EUNLUCKY/
          )
          const newSpawnedProcs = bc.spawnedProcs - spawnedProcsBefore
          expect(newSpawnedProcs).to.be.within(1, 5) // < because EUNLUCKY
          expect(await bc.pids()).to.not.eql(pidsBefore) // at least one pid should be shut down now
          const lastEvent = events[events.length - 1]
          expect(lastEvent.event).to.eql("taskError", JSON.stringify(events))
          const err = String(lastEvent.args[0])
          if (!err.startsWith("Error: stderr.data: EUNLUCKY")) {
            expect(err).to.eql(
              "Error: stderr.data: COMMAND MISSING for input invalid",
              JSON.stringify(events)
            )
          }
          return
        })

        xit("times out slow requests", async () => {
          const task = new Task(
            "sleep " + (opts.taskTimeoutMillis + 250), // < make sure it times out
            parser
          )
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /timeout|EUNLUCKY/
          )
          return
        })

        xit("rejects a command that emits to stderr", async () => {
          const task = new Task("stderr omg this should fail", parser)
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /omg this should fail|UNLUCKY/
          )
          return
        })
      }
    )
  }

  // specsWithOptions("lf", 5, 2, true, true)
  ;["lf", "crlf"].forEach(newline => {
    ;[3, 1].forEach(maxProcs => {
      ;[true, false].forEach(ignoreExit => {
        specsWithOptions(newline, maxProcs, ignoreExit)
      })
    })
  })

  describe("flaky results", () => {
    const bc = new BatchCluster({
      ...defaultOpts,
      processFactory: testProcessFactory
    })

    after(() => {
      return bc.end(false)
    })

    it("retries a flaky task", async function() {
      const iters = 20
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
      errs.forEach(ea => expect(String(ea)).to.match(/FAIL|write after end/i))
      expect(bc.spawnedProcs).to.be.within(2, iters)
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

    const bc = new BatchCluster({
      ...opts,
      processFactory: testProcessFactory
    })

    it("culls old child procs", async () => {
      expect(await Promise.all(runTasks(bc, 2 * opts.maxProcs))).to.eql(
        expectedResults(2 * opts.maxProcs)
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
      // expect(events).to.eql({})
      return
    })
  })

  describe("BatchProcess", () => {
    const bc = new BatchCluster({
      ...defaultOpts,
      taskTimeoutMillis: 500,
      processFactory: () => testProcessFactory({ failrate: "0" })
    })

    it("correctly reports that child procs are running", async () => {
      const task = new Task("sleep 250", parser) // long enough to
      const result = bc.enqueueTask(task)
      expect(task.pending).to.be.true
      // Wait for onIdle() to run:
      await delay(10)
      const pids = bc.pids()
      expect(pids).to.not.eql([])
      expect(await running(pids[0])).to.be.true
      await result
      await bc.end()
      expect(await running(pids[0])).to.be.false
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
