import { expect } from "chai"
import { describe, it } from "mocha"
import { BatchCluster, ProcpsMissingError } from "./BatchCluster"
import { DefaultTestOptions } from "./DefaultTestOptions.spec"
import { processFactory } from "./_chai.spec"

describe("BatchCluster procps validation", () => {
  it("should validate procps availability during construction", () => {
    // This test verifies that BatchCluster calls validateProcpsAvailable()
    // On systems where procps is available (like our test environment),
    // construction should succeed
    expect(() => {
      new BatchCluster({ ...DefaultTestOptions, processFactory })
    }).to.not.throw()
  })

  it("should export ProcpsMissingError for user handling", () => {
    expect(ProcpsMissingError).to.be.a("function")
    expect(new ProcpsMissingError().name).to.equal("ProcpsMissingError")
  })
})
