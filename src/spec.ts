const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))
_chai.use(require("chai-withintoleranceof"))
import { platform } from "os"

export { expect } from "chai"

require("source-map-support").install()

export const parser = (ea: string) => ea.trim()

export const isWin = platform().startsWith("win")

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: ((idx: number) => T)): T[] {
  return Array(n).fill(undefined).map((_, i) => f(i))
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
