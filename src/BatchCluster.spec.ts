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
      bc.enqueueTask(new Task("upcase abc " + i, parser)).then(ea => {
        console.log("Got task result: " + ea)
        return ea
      })
    )
  }

  function expectedResults(iterations: number): string[] {
    return times(iterations, i => "ABC " + i)
  }

  [/*"cr", "crlf", */"lf"].forEach(newline => {
    describe("newline:" + newline, () => {
      [/*0, */1].forEach(taskRetries => {
        describe("taskRetries:" + taskRetries, () => {
          [/*1,*/ 2].forEach(maxProcs => {
            const maxTasksPerProcess = 5
            describe("maxProcs:" + maxProcs, () => {
              let bc: BatchCluster
              beforeEach(() => {
                const failrate = taskRetries === 0 ? 0 : .3
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
                  taskTimeoutMillis: 200,
                  onIdleIntervalMillis: 0
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

              it.only("calling .end() after running shuts down child procs", async () => {
                // This just warms up bc to make child procs:
                const iterations = maxProcs
                expect(await Promise.all(runTasks(bc, iterations))).to.eql(expectedResults(iterations))
                console.log("!!!!! ok, ending !!!!!")
                await bc.end()
                console.log("!!!!! done waiting !!!!!")
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
                await expect(bc.enqueueTask(new Task("invalid", parser))).to.eventually.be.rejectedWith(/invalid/)
                expect(bc.pids).to.not.include.members(pids)
              })

              it("times out slow requests", async () => {
                const task = new Task("sleep " + (bc["opts"].taskTimeoutMillis + 20), parser)
                return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/timeout/)
              })

              it("rejects a command that emits to stderr", async () => {
                const task = new Task("stderr omg this should fail", parser)
                return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/omg this should fail/)
              })
            })
          })
        })
      })
    })
  })

  describe("maxProcAgeMillis", () => {
    const maxProcs = 4
    const maxProcAgeMillis = 200
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
      expect(await Promise.all(runTasks(bc, maxProcs))).to.eql(expectedResults(maxProcs))
      const pids = bc.pids
      expect(pids.length).to.eql(maxProcs)
      await delay(maxProcAgeMillis)
      expect(bc.pids).to.be.empty
      return
    })
  })
})
