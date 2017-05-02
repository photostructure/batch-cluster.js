import { processFactory } from "./test.spec"
import { BatchCluster } from "./BatchCluster"
// import { expect } from "./spec"
// import * as _cp from "child_process"

describe("BatchCluster", () => {
  [0, 1].forEach(taskRetries => {
    describe("taskRetries: " + taskRetries, () => {
      [1, 2, 3].forEach(maxProcs => {
        describe("maxProcs: " + maxProcs, () => {
          new BatchCluster({
            processFactory,
            taskRetries,
            maxProcs,
            maxTasksPerProcess: 5,
            versionCommand: "version",
            passString: "PASS",
            failString: "FAIL",
            taskTimeoutMillis: 500
          })

          it("runs > maxProcs tasks in parallel")
          it("calling .end() shuts down child procs")
          it("no internal errors are raised in stress testing")
          it("")
          it("")
        })
      })
    })
  })
})
