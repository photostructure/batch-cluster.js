require("source-map-support").install()

import { ChildProcess, spawn } from "child_process"
import { join } from "path"
import { env, execPath } from "process"

import { Logger, setLogger } from "./Logger"
import { runningPids } from "./Procs"

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

export async function currentTestPids(): Promise<number[]> {
  const alivePids = new Set(await runningPids())
  return procs.map(ea => ea.pid).filter(ea => alivePids.has(ea))
}

export const testProcessFactory = (env: any = {}) => {
  const proc = spawn(execPath, [join(__dirname, "test.js")], { env })
  procs.push(proc)
  return proc
}
