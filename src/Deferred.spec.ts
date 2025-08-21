import { Deferred } from "./Deferred";
import { expect } from "./_chai.spec";

describe("Deferred", () => {
  it("is born pending", () => {
    const d = new Deferred();
    expect(d.pending).to.eql(true);
    expect(d.fulfilled).to.eql(false);
    expect(d.rejected).to.eql(false);
  });

  it("resolves out of pending", () => {
    const d = new Deferred<string>();
    const expected = "result";
    d.resolve(expected);
    expect(d.pending).to.eql(false);
    expect(d.fulfilled).to.eql(true);
    expect(d.rejected).to.eql(false);
    return expect(d).to.become(expected);
  });

  it("rejects out of pending", () => {
    const d = new Deferred();
    expect(d.reject("boom")).to.eql(true);
    expect(d.pending).to.eql(false);
    expect(d.fulfilled).to.eql(false);
    expect(d.rejected).to.eql(true);
    return expect(d).to.eventually.be.rejectedWith(/boom/);
  });

  it("resolved ignores subsequent resolutions", () => {
    const d = new Deferred<number>();
    expect(d.resolve(123)).to.eql(true);
    expect(d.resolve(456)).to.eql(false);
    expect(d.pending).to.eql(false);
    expect(d.fulfilled).to.eql(true);
    expect(d.rejected).to.eql(false);
    return expect(d).to.become(123);
  });

  it("resolved respects subsequent rejections", () => {
    const d = new Deferred<number>();
    expect(d.resolve(123)).to.eql(true);
    expect(d.reject("boom")).to.eql(false);
    expect(d.pending).to.eql(false);
    // CAUTION: THIS IS WEIRD. The promise is resolved, but something later
    // wanted to reject, so we assume the rejected state, even though we can't
    // reach back in the promise chain and un-resolve the promise.
    expect(d.fulfilled).to.eql(false);
    expect(d.rejected).to.eql(true);
    return expect(d).to.become(123);
  });

  it("rejected ignores subsequent resolutions", () => {
    const d = new Deferred<number>();
    expect(d.reject("first boom")).to.eql(true);
    expect(d.resolve(456)).to.eql(false);
    return expect(d).to.eventually.be.rejectedWith(/first boom/);
  });

  it("rejected ignores subsequent rejections", () => {
    const d = new Deferred<number>();
    expect(d.reject("first boom")).to.eql(true);
    expect(d.reject("second boom")).to.eql(false);
    return expect(d).to.eventually.be.rejectedWith(/first boom/);
  });
});
