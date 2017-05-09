const _chai = require("chai")
_chai.use(require("chai-string"))
_chai.use(require("chai-as-promised"))

export { expect } from "chai"

require("source-map-support").install()

export const parser = (ea: string) => ea.trim()

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack || reason)
})

export function times<T>(n: number, f: ((idx: number) => T)): T[] {
  return Array(n).fill(undefined).map((_, i) => f(i))
}