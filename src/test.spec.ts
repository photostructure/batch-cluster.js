import { running } from "./BatchProcess"
import { expect } from "./spec"
import { ChildProcess, spawn } from "child_process"
import { join } from "path"
import * as _p from "process"

export const procs: ChildProcess[] = []

export function spawnedPids(): number[] {
  return procs.map(proc => proc.pid)
}

export function runningSpawnedPids(): number[] {
  return procs.filter(proc => running(proc.pid)).map(proc => proc.pid)
}

export function processFactory(env: any = {}): ChildProcess {
  const proc = spawn(_p.execPath, [join(__dirname, "test.js")], { env })
  procs.push(proc)
  return proc
}

describe("test.js", () => {
  let child: ChildProcess
  let output: string

  beforeEach(() => {
    output = ""
    child = processFactory({ rngseed: "hello" })
    child.on("error", (err: any) => {
      throw err
    })
    child.stdout.on("data", (buff: any) => {
      output += buff.toString()
    })
  })

  function assertStdout(expectedOutput: string, done: () => void) {
    expect(running(child.pid)).to.be.true
    child.on("exit", async () => {
      expect(output.trim()).to.eql(expectedOutput)
      expect(running(child.pid)).to.be.false
      done()
    })
  }

  it("results in expected output", done => {
    assertStdout("HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS", done)
    child.stdin.end(
      "upcase Hello\ndowncase World\ninvalid input\nversion\nexit\n"
    )
  })

  it("returns a valid pid", () => {
    expect(running(child.pid)).to.be.true
  })

  it("sleeps serially", done => {
    const start = Date.now()
    assertStdout("slept 200\nPASS\nslept 201\nPASS\nslept 202\nPASS", () => {
      expect(Date.now() - start).to.be.gte(603)
      done()
    })
    child.stdin.end("sleep 200\nsleep 201\nsleep 202\nexit\n")
  })

  it("flakes out the first N responses", done => {
    // These random numbers are consistent because we have a consistent rngseed:
    assertStdout(
      [
        "flaky response (r: 0.55, flakeRate: 0.50)",
        "PASS",
        "flaky response (r: 0.44, flakeRate: 0.00)",
        "PASS",
        "flaky response (r: 0.55, flakeRate: 1.00)",
        "FAIL"
      ].join("\n"),
      done
    )
    child.stdin.end("flaky .5\nflaky 0\nflaky 1\nexit\n")
  })
})
