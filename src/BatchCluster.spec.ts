import { BatchCluster } from "./BatchCluster"
import { delay } from "./Delay"
import { expect, parser, times } from "./spec"
import { Task } from "./Task"
import { processFactory } from "./test.spec"


describe("BatchCluster", function () {

  function runTasks(bc: BatchCluster, iterations: number): Promise<string>[] {
    return times(iterations, i =>
      bc.enqueueTask(new Task("upcase abc " + i, parser))
    )
  }

  function expectedResults(iterations: number): string[] {
    return times(iterations, i => "ABC " + i)
  }

  let callcount = 0
  const onIdleIntervalMillis = 100;

  ["cr", "crlf", "lf"].forEach(newline => {
    describe("newline:" + newline, () => {
      [0, 5].forEach(taskRetries => {
        describe("taskRetries:" + taskRetries, () => {
          [1, 2].forEach(maxProcs => {
            const maxTasksPerProcess = 5
            describe("maxProcs:" + maxProcs, () => {
              let bc: BatchCluster
              beforeEach(() => {
                // failrate needs to be high enough to trigger but low enough to
                // allow retries to succeed.

                // Seeding the RNG deterministically gives us repeatable test
                // successes.
                const failrate = taskRetries === 0 ? "0" : "0.1"
                bc = new BatchCluster({
                  // seed needs to change for each process, or we'll always be
                  // lucky or unlucky
                  processFactory: () => processFactory({ newline, failrate, rngseed: "SEED" + (callcount++) }),
                  taskRetries,
                  maxProcs,
                  maxTasksPerProcess,
                  versionCommand: "version",
                  pass: "PASS",
                  fail: "FAIL",
                  exitCommand: "exit",
                  spawnTimeoutMillis: 5000,
                  taskTimeoutMillis: 500,
                  onIdleIntervalMillis,
                  maxReasonableProcessFailuresPerMinute: 200 // this is so high because failrate is so high
                })
              })

              afterEach(() => bc.end())

              it("runs maxProcs tasks in parallel", async () => {
                const iterations = maxProcs + 2
                expect(await Promise.all(runTasks(bc, iterations))).to.eql(expectedResults(iterations))
                expect(bc.pids.length).to.be.within(1, maxProcs)
              })

              it("calling .end() when new no-ops", async () => {
                await bc.end()
                expect(bc.pids.length).to.eql(0)
              })

              it("calling .end() after running shuts down child procs", async () => {
                // This just warms up bc to make child procs:
                const iterations = maxProcs
                expect(await Promise.all(runTasks(bc, iterations))).to.eql(expectedResults(iterations))
                await bc.end()
                expect(bc.pids.length).to.eql(0)
              })

              it("runs a given batch process at most " + maxTasksPerProcess + " before recycling", async () => {
                await Promise.all(runTasks(bc, maxProcs))
                const pids = bc.pids
                expect(await Promise.all(runTasks(bc, maxTasksPerProcess * maxProcs))).to.eql(expectedResults(maxTasksPerProcess * maxProcs))
                expect(bc.pids).to.not.include.members(pids)
              })

              it("restarts a given batch process if an error is raised", async () => {
                expect(await bc.enqueueTask(new Task("downcase Hello", parser))).to.eql("hello")
                const pids = bc.pids
                expect(bc.pids.length).to.be.within(1, maxProcs) // we may have spun up another proc due to UNLUCKY
                const task = new Task("invalid", parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/invalid|UNLUCKY/)
                await delay(onIdleIntervalMillis * 2) // wait for pids to not include closed procs
                expect(bc.pids).to.not.eql(pids) // at least one pid should be shut down now
                expect(task.retries).to.eql(taskRetries)
              })

              it("times out slow requests", async () => {
                const task = new Task("sleep " + (bc["opts"].taskTimeoutMillis + 20), parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/timeout|UNLUCKY/)
                expect(task.retries).to.eql(taskRetries)
              })

              it("rejects a command that emits to stderr", async () => {
                const task = new Task("stderr omg this should fail", parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/omg this should fail|UNLUCKY/)
                expect(task.retries).to.eql(taskRetries)
              })
            })
          })
        })
      })
    })
  })

  describe("maxProcAgeMillis", () => {
    const maxProcs = 4
    const maxProcAgeMillis = 500
    const bc = new BatchCluster({
      processFactory,
      taskRetries: 0,
      maxProcs,
      maxTasksPerProcess: 100,
      maxProcAgeMillis,
      versionCommand: "version",
      pass: "PASS",
      fail: "FAIL",
      exitCommand: "exit",
      spawnTimeoutMillis: 5000,
      taskTimeoutMillis: 200,
      onIdleIntervalMillis
    })
    it("culls old child procs", async () => {
      expect(await Promise.all(runTasks(bc, 2 * maxProcs))).to.eql(expectedResults(2 * maxProcs))
      expect(bc.pids.length).to.be.within(1, maxProcs)
      await delay(maxProcAgeMillis)
      // Calling .pids calls .procs(), which culls old procs
      expect(bc.pids.length).to.be.within(0, maxProcs)
      // Wait for the procs to shut down:
      if (bc.pids.length > 0) {
        await delay(500)
      }
      expect(bc.pids).to.be.empty
    })
  })

  describe("opts parsing", () => {
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
        const e = err.toString()
        expect(e).to.eql([
          "Error: BatchCluster was given invalid options:",
          "versionCommand must not be blank,",
          "pass must not be blank,",
          "fail must not be blank,",
          "spawnTimeoutMillis must be greater than or equal to 100,",
          "taskTimeoutMillis must be greater than or equal to 10,",
          "maxTasksPerProcess must be greater than or equal to 1,",
          "maxProcs must be greater than or equal to 1,",
          "maxProcAgeMillis must be greater than or equal to 0,",
          "onIdleIntervalMillis must be greater than or equal to 0,",
          "endGracefulWaitTimeMillis must be greater than or equal to 0,",
          "taskRetries must be greater than or equal to 0"
        ].join(" "))
      }
    })
  })
})
