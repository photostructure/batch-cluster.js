import { expect } from "chai"
import { describe, it } from "mocha"
import { ProcpsMissingError, validateProcpsAvailable } from "./ProcpsChecker"

describe("ProcpsChecker", () => {
  describe("validateProcpsAvailable()", () => {
    it("should not throw on systems with procps installed", () => {
      // Since we're running tests, procps should be available
      expect(() => validateProcpsAvailable()).to.not.throw()
    })

    it("should create appropriate error message for platform", () => {
      const error = new ProcpsMissingError()
      expect(error.name).to.equal("ProcpsMissingError")
      expect(error.message).to.include("command not available")

      // Message should be specific to platform
      if (process.platform === "win32") {
        expect(error.message).to.include("tasklist")
      } else {
        expect(error.message).to.include("ps")
        expect(error.message).to.include("procps")
      }
    })

    it("should preserve original error", () => {
      const originalError = new Error("Command failed")
      const procpsError = new ProcpsMissingError(originalError)

      expect(procpsError.originalError).to.equal(originalError)
    })
  })
})
