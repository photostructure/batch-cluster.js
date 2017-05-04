import { BatchCluster } from "./BatchCluster"
import { delay } from "./Delay"
import { expect } from "./spec"
import { Task } from "./Task"
import { processFactory } from "./test.spec"

const parser = (ea: string) => ea.trim()

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: ((idx: number) => T)): T[] {
  return Array(n).fill(undefined).map((_, i) => f(i))
}

describe("BatchCluster", function () {

  function runTasks(bc: BatchCluster, iterations: number): Promise<string>[] {
    return times(iterations, i =>
      bc.enqueueTask(new Task("upcase abc " + i, parser))
    )
  }

  function expectedResults(iterations: number): string[] {
    return times(iterations, i => "ABC " + i)
  }

  ["cr", "crlf", "lf"].forEach(newline => {
    describe("newline:" + newline, () => {
      [0, 5].forEach(taskRetries => {
        describe("taskRetries:" + taskRetries, () => {
          [1, 2].forEach(maxProcs => {
            const maxTasksPerProcess = 5
            describe("maxProcs:" + maxProcs, () => {
              let bc: BatchCluster
              beforeEach(() => {
                const failrate = taskRetries === 0 ? "0" : "0.05"
                bc = new BatchCluster({
                  processFactory: () => processFactory({ newline, failrate }),
                  taskRetries,
                  maxProcs,
                  maxTasksPerProcess,
                  versionCommand: "version",
                  pass: "PASS",
                  fail: "FAIL",
                  exitCommand: "exit",
                  spawnTimeoutMillis: 5000,
                  taskTimeoutMillis: 200
                })
              })

              afterEach(() => bc.end())

              it("runs > maxProcs tasks in parallel", async () => {
                const iterations = maxProcs
                expect(await Promise.all(runTasks(bc, iterations))).to.eql(expectedResults(iterations))
                expect(bc.pids.length).to.eql(maxProcs)
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
                expect(pids.length).to.eql(1)
                const task = new Task("invalid", parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/invalid/)
                expect(bc.pids).to.not.include.members(pids)
                expect(task.retries).to.eql(taskRetries)
              })

              it("times out slow requests", async () => {
                const task = new Task("sleep " + (bc["opts"].taskTimeoutMillis + 20), parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/timeout/)
                expect(task.retries).to.eql(taskRetries)
              })

              it("rejects a command that emits to stderr", async () => {
                const task = new Task("stderr omg this should fail", parser)
                await expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/omg this should fail/)
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
      taskTimeoutMillis: 200
    })
    it("culls old child procs", async () => {
      expect(await Promise.all(runTasks(bc, 2 * maxProcs))).to.eql(expectedResults(2 * maxProcs))
      const pids = bc.pids
      console.dir({ pids })
      expect(pids.length).to.be.gte(1)
      expect(pids.length).to.be.lte(maxProcs)
      await delay(maxProcAgeMillis + 50)
      expect(bc.pids).to.be.empty
      return
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
