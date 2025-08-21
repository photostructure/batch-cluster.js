import { filterInPlace } from "./Array";
import { expect, times } from "./_chai.spec";

describe("Array", () => {
  describe("filterInPlace()", () => {
    it("no-ops if filter returns true", () => {
      const arr = times(10, (i) => i);
      const exp = times(10, (i) => i);
      expect(filterInPlace(arr, () => true)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
    it("clears array if filter returns false", () => {
      const arr = times(10, (i) => i);
      const exp: number[] = [];
      expect(filterInPlace(arr, () => false)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
    it("removes entries for < 5 filter", () => {
      const arr = times(10, (i) => i);
      const exp = [0, 1, 2, 3, 4];
      expect(filterInPlace(arr, (i) => i < 5)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
    it("removes entries for > 5 filter", () => {
      const arr = times(10, (i) => i);
      const exp = [5, 6, 7, 8, 9];
      expect(filterInPlace(arr, (i) => i >= 5)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
    it("removes entries for even filter", () => {
      const arr = times(10, (i) => i);
      const exp = [0, 2, 4, 6, 8];
      expect(filterInPlace(arr, (i) => i % 2 === 0)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
    it("removes entries for odd filter", () => {
      const arr = times(10, (i) => i);
      const exp = [1, 3, 5, 7, 9];
      expect(filterInPlace(arr, (i) => i % 2 === 1)).to.eql(exp);
      expect(arr).to.eql(exp);
    });
  });
});
