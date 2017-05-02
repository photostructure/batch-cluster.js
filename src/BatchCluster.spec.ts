import { Task } from "./Task"
import { processFactory } from "./test.spec"
import { BatchCluster } from "./BatchCluster"
import { expect } from "./spec"
// import * as _cp from "child_process"

const parser = (ea: string) => ea.trim()

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: ((idx: number) => T)): T[] {
  return Array(n).fill(undefined).map((_, i) => f(i))
}

describe("BatchCluster", function () {
  [0, 1].forEach(taskRetries => {
    describe("taskRetries:" + taskRetries, () => {
      [1, 2].forEach(maxProcs => {
        const maxTasksPerProcess = 4
        describe("maxProcs:" + maxProcs, () => {
          const bc = new BatchCluster({
            processFactory,
            taskRetries,
            maxProcs,
            maxTasksPerProcess,
            versionCommand: "version",
            passString: "PASS",
            failString: "FAIL",
            exitCommand: "exit",
            spawnTimeoutMillis: 5000,
            taskTimeoutMillis: 100
          })

          function runTasks(iterations: number): Promise<string>[] {
            return times(iterations, i =>
              bc.enqueueTask(new Task("upcase abc " + i, parser))
            )
          }

          function expectedResults(iterations: number): string[] {
            return times(iterations, i => "ABC " + i)
          }

          after(() => bc.end())

          it("runs > maxProcs tasks in parallel", async () => {
            const iterations = maxProcs
            expect(await Promise.all(runTasks(iterations))).to.eql(expectedResults(iterations))
            expect(bc["procs"]().length).to.eql(maxProcs)
          })

          it("calling .end() when new no-ops", async () => {
            await bc.end()
            expect(bc.pids.length).to.eql(0)
          })

          it("calling .end() after running shuts down child procs", async () => {
            // This just warms up bc to make child procs:
            const iterations = maxProcs
            expect(await Promise.all(runTasks(iterations))).to.eql(expectedResults(iterations))
            await bc.end()
            expect(bc.pids.length).to.eql(0)
          })

          it("runs a given batch process at most " + maxTasksPerProcess + " before recycling", async () => {
            await Promise.all(runTasks(maxProcs))
            const pids = bc.pids
            expect(await Promise.all(runTasks(maxTasksPerProcess * maxProcs))).to.eql(expectedResults(maxTasksPerProcess * maxProcs))
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
            const task = new Task("sleep " + bc["opts"].taskTimeoutMillis + 20, parser)
            return expect(bc.enqueueTask(task)).to.eventually.be.rejectedWith(/timeout/)
          })
        })
      })
    })
  })
})
