require("source-map-support").install()

import { ChildProcess, spawn } from "child_process"
import { join } from "path"
import * as _p from "process"

import { until } from "./Async"
import { BatchCluster } from "./BatchCluster"
import { Logger, setLogger } from "./Logger"
import { pids } from "./Pids"

const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))
_chai.use(require("chai-withintoleranceof"))

export { expect } from "chai"

// Tests should be quiet unless LOG is set
setLogger(
  Logger.withLevels(
    Logger.withTimestamps(
      Logger.filterLevels(
        {
          trace: console.log,
          debug: console.log,
          info: console.log,
          warn: console.warn,
          error: console.error
        },
        (_p.env.LOG as any) || "error"
      )
    )
  )
)

export const parserErrors: string[] = []

beforeEach(() => (parserErrors.length = 0))

export const parser = (result: string, stderr?: string) => {
  if (stderr != null && stderr.length > 0) {
    parserErrors.push(stderr)
    throw new Error(stderr)
  }
  return result.trim()
}

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: (idx: number) => T): T[] {
  return Array(n)
    .fill(undefined)
    .map((_, i) => f(i))
}

// because @types/chai-withintoleranceof isn't a thing (yet)

type WithinTolerance = (
  expected: number,
  tol: number | number[],
  message?: string
) => Chai.Assertion

declare namespace Chai {
  interface Assertion {
    withinToleranceOf: WithinTolerance
    withinTolOf: WithinTolerance
  }
}

export const procs: ChildProcess[] = []

export function testPids(): number[] {
  return procs.map(proc => proc.pid)
}

export async function currentTestPids(): Promise<number[]> {
  const alivePids = new Set(await pids())
  return procs.map(ea => ea.pid).filter(ea => alivePids.has(ea))
}

export async function shutdown(
  bc: BatchCluster,
  timeoutMs = 10000
): Promise<boolean> {
  await bc.end(true)
  return until(
    async () =>
      (await bc.pids()).length == 0 && (await currentTestPids()).length == 0,
    timeoutMs
  )
}

// Seeding the RNG deterministically _should_ give us repeatable
// flakiness/successes.

// We want a rngseed that is stable for consecutive tests, but changes sometimes
// to make sure different error pathways are exercised. YYYY-MM-$callcount
// should do it.

const rngseedPrefix = new Date().toISOString().substr(0, 7) + "."
let rngseedCounter = 0
let rngseed_override: string | undefined

export function setRngseed(seed: string | undefined = undefined) {
  rngseed_override = seed
}

function rngseed() {
  // We need a new rngseed for every execution, or all runs will either pass or
  // fail:
  return rngseed_override || rngseedPrefix + rngseedCounter++
}

let failrate = "0.1" // 10%

export function setFailrate(percent: number = 0) {
  failrate = (percent / 100).toFixed(2)
}

afterEach(() => setFailrate(10))

let newline = "lf"

export function setNewline(eol: "lf" | "crlf" = "lf") {
  newline = eol
}

let ignoreExit: "1" | "0" = "0"

export function setIgnoreExit(ignore: boolean = false) {
  ignoreExit = ignore ? "1" : "0"
}

afterEach(() => {
  setFailrate()
  setNewline()
  setIgnoreExit()
  setRngseed()
})

export const processFactory = () => {
  const proc = spawn(_p.execPath, [join(__dirname, "test.js")], {
    env: {
      rngseed: rngseed(),
      failrate,
      newline,
      ignoreExit
    }
  })
  procs.push(proc)
  return proc
}
