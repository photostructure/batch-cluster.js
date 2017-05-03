import { expect } from "./spec"
import * as _cp from "child_process"
import * as _p from "process"
import { join } from "path"

export function processFactory(env: any = {}): _cp.ChildProcess {
  return _cp.spawn(_p.execPath, [join(__dirname, "test.js")], {
    env
  })
}

describe("test.js", () => {
  it("results in expected output", (done) => {
    const child = processFactory()
    child.on("error", (err: any) => { throw err })
    let output = ""
    child.stdout.on("data", (buff: any) => {
      output += buff.toString()
    })
    child.stdout.on("end", () => {
      expect(output.trim()).to.eql("HELLO PASS world PASS FAIL v1.2.3 PASS".split(" ").join("\n"))
      done()
    })
    child.stdin.end("upcase Hello\ndowncase World\ninvalid input\nversion\nexit\n")
  })
})
