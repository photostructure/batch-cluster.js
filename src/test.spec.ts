import child_process from "node:child_process"
import { until } from "./Async"
import { Deferred } from "./Deferred"
import { kill, pidExists } from "./Pids"
import {
  expect,
  processFactory,
  setFailratePct,
  setIgnoreExit,
  setRngseed,
} from "./_chai.spec"

describe("test.js", () => {
  class Harness {
    readonly child: child_process.ChildProcess
    public output = ""
    constructor() {
      setFailratePct(0)
      this.child = processFactory()
      this.child.on("error", (err: any) => {
        throw err
      })
      this.child.stdout!.on("data", (buff: any) => {
        this.output += buff.toString()
      })
    }
    async untilOutput(minLength = 0): Promise<void> {
      await until(() => this.output.length > minLength, 1000)
      return
    }
    async end(): Promise<void> {
      this.child.stdin!.end(null)
      await until(() => this.notRunning(), 1000)
      if (await this.running()) {
        console.error("Ack, I had to kill child pid " + this.child.pid)
        kill(this.child.pid)
      }
      return
    }
    running(): boolean {
      return pidExists(this.child.pid)
    }
    notRunning(): boolean {
      return !this.running()
    }
    async assertStdout(f: (output: string) => void) {
      // The OS may take a bit before the PID shows up in the process table:
      const alive = await until(() => pidExists(this.child.pid), 2000)
      expect(alive).to.eql(true)
      const d = new Deferred()
      this.child.on("exit", async () => {
        try {
          f(this.output.trim())
          expect(await this.running()).to.eql(false)
          d.resolve("on exit")
        } catch (err: any) {
          d.reject(err)
        }
      })
      return d
    }
  }

  it("results in expected output", async () => {
    const h = new Harness()
    const a = h.assertStdout((ea) =>
      expect(ea).to.eql("HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS"),
    )
    h.child.stdin!.end("upcase Hello\ndowncase World\ninvalid input\nversion\n")
    return a
  })

  it("exits properly if ignoreExit is not set", async () => {
    const h = new Harness()
    h.child.stdin!.write("upcase fuzzy\nexit\n")
    await h.untilOutput(9)
    expect(h.output).to.eql("FUZZY\nPASS\n")
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.eql(false)
    return
  })

  it("kill(!force) with ignoreExit unset causes the process to end", async () => {
    setIgnoreExit(false)
    const h = new Harness()
    h.child.stdin!.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.eql(false)
    return
  })

  it("kill(force) even with ignoreExit set causes the process to end", async () => {
    setIgnoreExit(true)
    const h = new Harness()
    h.child.stdin!.write("upcase fuzzy\n")
    await h.untilOutput()
    kill(h.child.pid, true)
    await until(() => h.notRunning(), 500)
    expect(await h.running()).to.eql(false)
    return
  })

  it("doesn't exit if ignoreExit is set", async () => {
    setIgnoreExit(true)
    const h = new Harness()
    h.child.stdin!.write("upcase Boink\nexit\n")
    await h.untilOutput("BOINK\nPASS\nignore".length)
    expect(h.output).to.eql("BOINK\nPASS\nignoreExit is set\n")
    expect(await h.running()).to.eql(true)
    await h.end()
    expect(await h.running()).to.eql(false)
    return
  })

  it("returns a valid pid", async () => {
    const h = new Harness()
    expect(pidExists(h.child.pid)).to.eql(true)
    await h.end()
    return
  })

  it("sleeps serially", () => {
    const h = new Harness()
    const start = Date.now()
    const times = [200, 201, 202]
    const a = h
      .assertStdout((output) => {
        const actualTimes: number[] = []
        const pids = new Set()
        output.split(/[\r\n]/).forEach((line) => {
          if (line.startsWith("{") && line.endsWith("}")) {
            const json = JSON.parse(line)
            actualTimes.push(json.slept)
            pids.add(json.pid)
          } else {
            expect(line).to.eql("PASS")
          }
        })
        expect(pids.size).to.eql(1, "only one pid should have been used")
        expect(actualTimes).to.eql(times)
      })
      .then(() => expect(Date.now() - start).to.be.gte(603))
    h.child.stdin!.end(times.map((ea) => "sleep " + ea).join("\n") + "\nexit\n")
    return a
  })

  it("flakes out the first N responses", () => {
    setFailratePct(0)
    setRngseed("hello")
    const h = new Harness()
    // These random numbers are consistent because we have a consistent rngseed:
    const a = h.assertStdout((ea) =>
      expect(ea).to.eql(
        [
          "flaky response (PASS, r: 0.55, flakeRate: 0.50)",
          "PASS",
          "flaky response (PASS, r: 0.44, flakeRate: 0.00)",
          "PASS",
          "flaky response (FAIL, r: 0.55, flakeRate: 1.00)",
          "FAIL",
        ].join("\n"),
      ),
    )
    h.child.stdin!.end("flaky .5\nflaky 0\nflaky 1\nexit\n")
    return a
  })
})
