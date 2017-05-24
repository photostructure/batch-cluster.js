import { expect } from "./spec"
import * as _cp from "child_process"
import * as _p from "process"
import { join } from "path"

export const procs: _cp.ChildProcess[] = []

export function spawnedPids(): number[] {
  return procs.map(proc => proc.pid)
}

export function runningSpawnedPids(): number[] {
  return procs.filter(proc => proc.kill(0 as any as string)).map(proc => proc.pid)
}

export function processFactory(env: any = {}): _cp.ChildProcess {
  const proc = _cp.spawn(_p.execPath, [join(__dirname, "test.js")], {
    env
  })
  procs.push(proc)
  return proc
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

  it("sleeps serially", (done) => {
    const child = processFactory()
    child.on("error", (err: any) => { throw err })
    const start = Date.now()
    child.stdout.on("data", (buff: any) => {
      expect(buff.toString().trim()).to.eql("PASS")
    })
    child.stdout.on("end", () => {
      expect(Date.now() - start).to.be.gte(750)
      done()
    })
    child.stdin.end("sleep 250\nsleep 250\nsleep 250\nexit\n")
  })
})
