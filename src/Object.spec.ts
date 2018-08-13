import { expect } from "./chai.spec"
import { map } from "./Object"

describe("Object", () => {
  describe("map()", () => {
    it("skips if target is null", () => {
      expect(
        map(null, () => {
          throw new Error("unexpected")
        })
      ).to.be.undefined
    })
    it("skips if target is undefined", () => {
      expect(
        map(undefined, () => {
          throw new Error("unexpected")
        })
      ).to.be.undefined
    })
    it("passes defined target to f", () => {
      expect(map(123, ea => String(ea))).to.eql("123")
    })
  })
})
