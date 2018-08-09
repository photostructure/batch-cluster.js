import { ChildProcess, spawn } from "child_process"
import { join } from "path"
import { env, execPath } from "process"

import { Logger, setLogger } from "./Logger"
import { running } from "./Procs"

const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))
_chai.use(require("chai-withintoleranceof"))

export { expect } from "chai"

require("source-map-support").install()

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
        (env.LOG as any) || "error"
      )
    )
  )
)

export const parser = (ea: string) => ea.trim()

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: ((idx: number) => T)): T[] {
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

export function currentTestPids(): Promise<number[]> {
  return Promise.all(
    procs.map(async ea => ({ pid: ea.pid, alive: await running(ea.pid) }))
  ).then(arr => arr.filter(ea => ea.alive).map(ea => ea.pid))
}

export const testProcessFactory = (env: any = {}) => {
  const proc = spawn(execPath, [join(__dirname, "test.js")], { env })
  procs.push(proc)
  return proc
}
