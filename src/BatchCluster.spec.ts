import { BatchCluster, BatchClusterOptions } from "./BatchCluster"
import { BatchProcess } from "./BatchProcess"
import { delay } from "./Delay"
import { expect, parser, times } from "./spec"
import { Task } from "./Task"
import { processFactory, procs, runningSpawnedPids } from "./test.spec"
import { inspect } from "util"

const defaultOpts = Object.freeze({
  ...new BatchClusterOptions(),
  versionCommand: "version",
  pass: "PASS",
  fail: "FAIL",
  exitCommand: "exit",
  onIdleIntervalMillis: 250, // frequently to speed up tests
  maxTasksPerProcess: 5,
  spawnTimeoutMillis: 1000,
  taskTimeoutMillis: 250, // so the timeout test doesn't timeout. 250 on windows is too short.
  maxReasonableProcessFailuresPerMinute: 1000 // this is so high because failrate is so high
})

describe("BatchCluster", () => {
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

  // used to seed the failure RNG, to make tests deterministic:
  let callcount = 0

  function specsWithOptions(
    newline: string,
    taskRetries: number,
    maxProcs: number,
    retryTasksAfterTimeout: boolean,
    ignoreExit: boolean
  ) {
    describe(
      inspect(
        { newline, taskRetries, maxProcs, retryTasksAfterTimeout, ignoreExit },
        { colors: true, breakLength: 100 }
      ),
      () => {
        let bc: BatchCluster
        const opts = {
          ...defaultOpts,
          taskRetries,
          maxProcs,
          retryTasksAfterTimeout
        }

        // failrate needs to be high enough to trigger but low enough to allow
        // retries to succeed.

        let failrate: string

        beforeEach(() => {
          // Seeding the RNG deterministically gives us repeatable test successes.
          failrate = taskRetries === 0 ? "0" : "0.1"

          bc = new BatchCluster({
            ...opts,
            // seed needs to change for each process, or we'll always be
            // lucky or unlucky
            processFactory: () =>
              processFactory({
                newline,
                failrate,
                rngseed: "SEED" + callcount++,
                ignoreExit: ignoreExit ? "1" : "0"
              })
          })
          procs.length = 0
        })

        afterEach(() => {
          return bc.end(false)
        })

        it("calling .end() when new no-ops", async () => {
          await bc.end()
          expect(bc.pids.length).to.eql(0)
          expect(bc.spawnedProcs).to.eql(0)
          return
        })

        it("calling .end() after running shuts down child procs", async () => {
          // This just warms up bc to make child procs:
          const iterations = maxProcs
          expect(await Promise.all(runTasks(bc, iterations))).to.eql(
            expectedResults(iterations)
          )
          await bc.end()
          expect(bc.spawnedProcs).to.be.within(maxProcs, maxProcs + 4) // because EUNLUCKY
          expect(bc.pids.length).to.eql(0)
          expect(runningSpawnedPids()).to.eql([])
          return
        })

        it(
          "runs a given batch process roughly " +
            opts.maxTasksPerProcess +
            " before recycling",
          async () => {
            await Promise.all(runTasks(bc, maxProcs))
            const pids = bc.pids
            const tasks = await Promise.all(
              runTasks(bc, opts.maxTasksPerProcess * maxProcs)
            )
            expect(tasks).to.eql(
              expectedResults(opts.maxTasksPerProcess * maxProcs)
            )
            expect(bc.pids).to.not.include.members(pids)
            const upperBoundSpawnedProcs =
              maxProcs * (taskRetries === 0 ? 2 : 6) // because fail rate
            expect(bc.spawnedProcs).to.be.within(
              maxProcs,
              upperBoundSpawnedProcs
            )
            const lowerBoundMeanTasksPerProc =
              opts.maxTasksPerProcess * (taskRetries === 0 ? 0.9 : 0.25) // because fail rate
            expect(bc.meanTasksPerProc).to.be.within(
              lowerBoundMeanTasksPerProc,
              opts.maxTasksPerProcess
            )
            await bc.pendingMaintenance
            expect(runningSpawnedPids().length).to.lte(maxProcs)
            return
          }
        )

        it("recycles procs if the command is invalid", async () => {
          // we need to run one task to "prime the pid pump"
          expect(
            await bc.enqueueTask(new Task("downcase Hello", parser))
          ).to.eql("hello")
          const pidsBefore = bc.pids
          const spawnedProcsBefore = bc.spawnedProcs
          expect(bc.pids.length).to.be.within(1, 3) // we may have spun up another proc due to EUNLUCKY
          const task = new Task("invalid", parser)
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /invalid|EUNLUCKY/
          )
          const newSpawnedProcs = bc.spawnedProcs - spawnedProcsBefore
          expect(newSpawnedProcs).to.be.within(
            opts.taskRetries,
            opts.taskRetries + 5
          ) // because EUNLUCKY
          expect(bc.pids).to.not.eql(pidsBefore) // at least one pid should be shut down now
          expect(task.retries).to.eql(opts.taskRetries)
          return
        })

        if (opts.taskRetries > 0) {
          it("retries a flaky task", async () => {
            callcount = 2 // for a consistent rngseed
            const task = new Task("flaky .5", parser)
            expect(await bc.enqueueTask(task)).to.startWith("flaky response")
            expect(task.retries).to.be.within(2, opts.taskRetries)
            return
          })
        }

        it("times out slow requests", async () => {
          const task = new Task(
            "sleep " + (opts.taskTimeoutMillis + 20),
            parser
          )
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /timeout|EUNLUCKY/
          )
          if (retryTasksAfterTimeout) {
            expect(task.retries).to.eql(taskRetries)
          } else {
            expect(task.retries).to.be.within(0, 1) // because UNLUCKY
          }
          return
        })

        it("rejects a command that emits to stderr", async () => {
          const task = new Task("stderr omg this should fail", parser)
          await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(
            /omg this should fail|UNLUCKY/
          )
          expect(task.retries).to.eql(taskRetries)
          return
        })
      }
    )
  }

  ;["lf", "crlf"].forEach(newline => {
    ;[5, 0].forEach(taskRetries => {
      ;[4, 1].forEach(maxProcs => {
        ;[true, false].forEach(retryTasksAfterTimeout => {
          ;[true, false].forEach(ignoreExit => {
            specsWithOptions(
              newline,
              taskRetries,
              maxProcs,
              retryTasksAfterTimeout,
              ignoreExit
            )
          })
        })
      })
    })
  })

  describe("maxProcAgeMillis", () => {
    const opts = {
      ...defaultOpts,
      taskRetries: 0,
      maxProcs: 4,
      maxTasksPerProcess: 100,
      maxProcAgeMillis: 1000
    }

    const bc = new BatchCluster({
      ...opts,
      processFactory
    })

    it("culls old child procs", async () => {
      expect(await Promise.all(runTasks(bc, 2 * opts.maxProcs))).to.eql(
        expectedResults(2 * opts.maxProcs)
      )
      expect(bc.pids.length).to.be.within(1, opts.maxProcs)
      await delay(opts.maxProcAgeMillis)
      // Calling .pids calls .procs(), which culls old procs
      expect(bc.pids.length).to.be.within(0, opts.maxProcs)
      // Wait for the procs to shut down:
      if (bc.pids.length > 0) {
        await delay(500)
      }
      expect(bc.pids).to.be.empty
      return
    })
  })

  describe("BatchProcess", () => {
    const bc = new BatchCluster({
      ...defaultOpts,
      taskTimeoutMillis: 500,
      processFactory: () => processFactory({ failrate: "0" })
    })

    it("correctly reports that child procs are running", async () => {
      const task = new Task("sleep 250", parser) // long enough to
      const result = bc.enqueueTask(task)
      const processes = bc["_procs"] as BatchProcess[]
      expect(task.pending).to.be.true
      expect(processes.length).to.eql(1)
      const proc = processes[0]!
      expect(proc.running).to.be.true
      expect(proc.ended).to.be.false
      await result
      const end = bc.end()
      expect(proc.ended).to.be.true
      await end
      expect(proc.running).to.be.false
      expect(proc.ended).to.be.true
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
          processFactory,
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
          processFactory,
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
          taskRetries: -1
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
          "taskRetries must be greater than or equal to 0"
        ])
      }
    })
  })
})
