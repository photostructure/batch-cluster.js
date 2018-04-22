import { env } from "process"

import { setLogger } from "./Logger"

const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))
_chai.use(require("chai-withintoleranceof"))

export { expect } from "chai"

require("source-map-support").install()

const noop = () => undefined
function log(level: string, ...args: any[]) {
  console.log(
    new Date().toISOString() + ": " + level + ": " + args[0],
    ...args.slice(1)
  )
}

// Tests should be quiet unless LOG is set
if (!!env.LOG) {
  setLogger({
    trace: (...args: any[]) => log("trace", ...args),
    debug: (...args: any[]) => log("debug", ...args),
    info: (...args: any[]) => log("info ", ...args),
    warn: (...args: any[]) => log("warn ", ...args),
    error: (...args: any[]) => log("error", ...args)
  })
} else {
  setLogger({
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: (...args: any[]) => log("error", ...args)
  })
}

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
