import { until } from "./Delay"
import { kill, running } from "./BatchProcess"
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
  class Harness {
    readonly child: ChildProcess
    public output: string = ""
    constructor(env: any = {}) {
      this.child = processFactory({ rngseed: "hello", ...env })
      this.child.on("error", (err: any) => {
        throw err
      })
      this.child.stdout.on("data", (buff: any) => {
        this.output += buff.toString()
      })
    }
    async untilOutput(minLength: number = 0): Promise<void> {
      await until(() => this.output.length > minLength, 1000)
      return
    }
    async end(): Promise<void> {
      this.child.stdin.end(null)
      await until(() => !this.running, 1000)
      if (this.running) {
        console.error("Ack, I had to kill child pid " + this.child.pid)
        kill(this.child.pid)
      }
      return
    }
    get running(): boolean {
      return running(this.child.pid)
    }
    assertStdout(expectedOutput: string, done: () => void) {
      expect(running(this.child.pid)).to.be.true
      this.child.on("exit", async () => {
        expect(this.output.trim()).to.eql(expectedOutput)
        expect(this.running).to.be.false
        done()
      })
    }
  }

  it("results in expected output", done => {
    const h = new Harness()
    h.assertStdout("HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS", done)
    h.child.stdin.end("upcase Hello\ndowncase World\ninvalid input\nversion\n")
    return
  })

  it("exits properly if ignoreExit is not set", async () => {
    const h = new Harness()
    h.child.stdin.write("upcase fuzzy\nexit\n")
    await h.untilOutput(9)
    expect(h.output).to.eql("FUZZY\nPASS\n")
    await until(() => !h.running, 500)
    expect(h.running).to.be.false
    return
  })

  it("kill(!force) with ignoreExit set doesn't cause the process to end", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, false)
    await until(() => !h.running, 500)
    expect(h.running).to.be.true
    return h.end()
  })

  it("kill(!force) with ignoreExit unset causes the process to end", async () => {
    const h = new Harness({ ignoreExit: "0" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => !h.running, 500)
    expect(h.running).to.be.false
    return
  })

  it("kill(force) even with ignoreExit set causes the process to end", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => !h.running, 500)
    expect(h.running).to.be.false
    return
  })

  it("doesn't exit if ignoreExit is set", async () => {
    const h = new Harness({ ignoreExit: "1" })
    h.child.stdin.write("upcase Boink\nexit\n")
    await h.untilOutput("BOINK\nPASS\nignore".length)
    expect(h.output).to.eql("BOINK\nPASS\nignoreExit is set\n")
    expect(h.running).to.be.true
    await h.end()
    expect(h.running).to.be.false
    return
  })

  it("returns a valid pid", async () => {
    const h = new Harness()
    expect(running(h.child.pid)).to.be.true
    await h.end()
    return
  })

  it("sleeps serially", done => {
    const h = new Harness()
    const start = Date.now()
    h.assertStdout("slept 200\nPASS\nslept 201\nPASS\nslept 202\nPASS", () => {
      expect(Date.now() - start).to.be.gte(603)
      done()
    })
    h.child.stdin.end("sleep 200\nsleep 201\nsleep 202\nexit\n")
  })

  it("flakes out the first N responses", done => {
    const h = new Harness()
    // These random numbers are consistent because we have a consistent rngseed:
    h.assertStdout(
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
    h.child.stdin.end("flaky .5\nflaky 0\nflaky 1\nexit\n")
  })
})
