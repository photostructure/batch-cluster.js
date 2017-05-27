import { expect } from "./spec"
import { spawn, ChildProcess } from "child_process"
import * as _p from "process"
import { join } from "path"

export const procs: ChildProcess[] = []

export function spawnedPids(): number[] {
  return procs.map(proc => proc.pid)
}

export function runningSpawnedPids(): number[] {
  return procs.filter(proc => proc.kill(0 as any as string)).map(proc => proc.pid)
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
    child = processFactory()
    child.on("error", (err: any) => { throw err })
    child.stdout.on("data", (buff: any) => {
      output += buff.toString()
    })
  })

  function assertStdout(expectedOutput: string, done: Function) {
    child.stdout.on("end", () => {
      expect(output.trim()).to.eql(expectedOutput)
      done()
    })
  }

  it("results in expected output", (done) => {
    assertStdout("HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS", done)
    child.stdin.end("upcase Hello\ndowncase World\ninvalid input\nversion\nexit\n")
  })

  it("sleeps serially", (done) => {
    const start = Date.now()
    assertStdout("slept 200\nPASS\nslept 201\nPASS\nslept 202\nPASS", () => {
      expect(Date.now() - start).to.be.gte(603)
      done()
    })
    child.stdin.end("sleep 200\nsleep 201\nsleep 202\nexit\n")
  })

  it("flakes out the first N responses", (done) => {
    assertStdout("flaky response 1 of 3\nFAIL\nflaky response 2 of 3\nFAIL\nflaky response 3 of 3\nPASS", done)
    child.stdin.end("flaky 3\nflaky 3\nflaky 3\nexit\n")
  })
})
