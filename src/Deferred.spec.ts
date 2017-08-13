import { Deferred } from "./Deferred"
import { expect } from "./spec"

describe("Deferred", () => {
  it("is born pending", () => {
    const d = new Deferred()
    expect(d.pending).to.be.true
    expect(d.fulfilled).to.be.false
    expect(d.rejected).to.be.false
  })

  it("resolves out of pending", () => {
    const d = new Deferred<string>()
    const expected = "result"
    d.resolve(expected)
    expect(d.pending).to.be.false
    expect(d.fulfilled).to.be.true
    expect(d.rejected).to.be.false
    return expect(d.promise).to.become(expected)
  })

  it("rejects out of pending", () => {
    const d = new Deferred()
    expect(d.reject("boom")).to.be.true
    expect(d.pending).to.be.false
    expect(d.fulfilled).to.be.false
    expect(d.rejected).to.be.true
    return expect(d.promise).to.eventually.be.rejectedWith(/boom/)
  })

  it("resolved ignores subsequent resolutions", () => {
    const d = new Deferred<number>()
    expect(d.resolve(123)).to.be.true
    expect(d.resolve(456)).to.be.false
    expect(d.pending).to.be.false
    expect(d.fulfilled).to.be.true
    expect(d.rejected).to.be.false
    return expect(d.promise).to.become(123)
  })

  it("resolved ignores subsequent rejections", () => {
    const d = new Deferred<number>()
    expect(d.resolve(123)).to.be.true
    expect(d.reject("boom")).to.be.false
    expect(d.pending).to.be.false
    expect(d.fulfilled).to.be.true
    expect(d.rejected).to.be.false
    return expect(d.promise).to.become(123)
  })

  it("rejected ignores subsequent resolutions", () => {
    const d = new Deferred<number>()
    expect(d.reject("first boom")).to.be.true
    expect(d.resolve(456)).to.be.false
    return expect(d.promise).to.eventually.be.rejectedWith(/first boom/)
  })

  it("rejected ignores subsequent rejections", () => {
    const d = new Deferred<number>()
    expect(d.reject("first boom")).to.be.true
    expect(d.reject("second boom")).to.be.false
    return expect(d.promise).to.eventually.be.rejectedWith(/first boom/)
  })
})
