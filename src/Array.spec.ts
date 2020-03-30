import { expect, times } from "./_chai.spec"
import { filterInPlace, rrFind } from "./Array"

describe("Array", () => {
  describe("filterInPlace()", () => {
    it("no-ops if filter returns true", () => {
      const arr = times(10, (i) => i)
      const exp = times(10, (i) => i)
      expect(filterInPlace(arr, () => true)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
    it("clears array if filter returns false", () => {
      const arr = times(10, (i) => i)
      const exp: number[] = []
      expect(filterInPlace(arr, () => false)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
    it("removes entries for < 5 filter", () => {
      const arr = times(10, (i) => i)
      const exp = [0, 1, 2, 3, 4]
      expect(filterInPlace(arr, (i) => i < 5)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
    it("removes entries for > 5 filter", () => {
      const arr = times(10, (i) => i)
      const exp = [5, 6, 7, 8, 9]
      expect(filterInPlace(arr, (i) => i >= 5)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
    it("removes entries for even filter", () => {
      const arr = times(10, (i) => i)
      const exp = [0, 2, 4, 6, 8]
      expect(filterInPlace(arr, (i) => i % 2 === 0)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
    it("removes entries for odd filter", () => {
      const arr = times(10, (i) => i)
      const exp = [1, 3, 5, 7, 9]
      expect(filterInPlace(arr, (i) => i % 2 === 1)).to.eql(exp)
      expect(arr).to.eql(exp)
    })
  })

  describe("find()", () => {
    it("no-ops empty array", () => {
      expect(rrFind([], 0, () => false)).to.eql(undefined)
      expect(rrFind([], 0, () => true)).to.eql(undefined)
    })
    it("returns undefined for always-false", () => {
      expect(rrFind([1], 0, () => false)).to.eql(undefined)
    })
    it("returns idx for always-true", () => {
      const arr = [1, 2, 3]
      expect(rrFind(arr, 0, () => true)).to.eql(1)
      expect(rrFind(arr, 1, () => true)).to.eql(2)
      expect(rrFind(arr, 2, () => true)).to.eql(3)
      expect(rrFind(arr, 3, () => true)).to.eql(1)
      expect(rrFind(arr, 4, () => true)).to.eql(2)
    })
    it("returns idx for evens", () => {
      const arr = [1, 2, 3, 4]
      const pred = (i: number) => i % 2 === 0
      expect(rrFind(arr, 0, pred)).to.eql(2)
      expect(rrFind(arr, 1, pred)).to.eql(2)
      expect(rrFind(arr, 2, pred)).to.eql(4)
      expect(rrFind(arr, 3, pred)).to.eql(4)
      expect(rrFind(arr, 4, pred)).to.eql(2)
    })
    it("returns the first idx when start index is invalid", () => {
      const arr = [2, 3, 5, 7, 9]
      const pred = (i: number) => i % 2 === 0
      times(arr.length + 1, (i) => expect(rrFind(arr, i, pred)).to.eql(2))
    })
  })
})
