#!/usr/bin/env node
import * as _p from "process"
import { createInterface } from "readline"

import { delay } from "./Async"

/**
 * This is a script written to behave similarly to ExifTool or
 * GraphicsMagick's batch-command modes. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 */

const rl = createInterface({
  input: process.stdin
})

const newline = _p.env.newline === "crlf" ? "\r\n" : "\n"

function write(s: string): void {
  // Don't use console.log so we can test different newlines:
  _p.stdout.write(s + newline)
}

const ignoreExit = _p.env.ignoreExit === "1"

if (ignoreExit) {
  _p.on("SIGINT", () => {
    write("ignoring SIGINT")
  })
  _p.on("SIGTERM", () => {
    write("ignoring SIGTERM")
  })
}

const failrate = _p.env.failrate == null ? 0 : parseFloat(_p.env.failrate!)
const rng = _p.env.rngseed ? require("seedrandom")(_p.env.rngseed) : Math.random

async function onLine(line: string): Promise<void> {
  const r = rng()
  if (r < failrate) {
    console.error(
      "EUNLUCKY: r: " +
        r.toFixed(2) +
        ", failrate: " +
        failrate.toFixed(2) +
        ", seed: " +
        _p.env.rngseed
    )
    return
  }
  line = line.trim()
  const tokens = line.split(/\s+/)

  switch (tokens[0]) {
    case "flaky":
      const flakeRate = parseFloat(tokens[1])
      write(
        "flaky response (" +
          (r < flakeRate ? "FAIL" : "PASS") +
          ", r: " +
          r.toFixed(2) +
          ", flakeRate: " +
          flakeRate.toFixed(2) +
          // Extra information is used for context:
          (tokens.length > 2 ? ", " + tokens.slice(2).join(" ") : "") +
          ")"
      )
      if (r < flakeRate) {
        write("FAIL")
      } else {
        write("PASS")
      }
      break

    case "upcase":
      write(
        tokens
          .slice(1)
          .join(" ")
          .toUpperCase()
      )
      write("PASS")
      break

    case "downcase":
      write(
        tokens
          .slice(1)
          .join(" ")
          .toLowerCase()
      )
      write("PASS")
      break

    case "sleep":
      const millis = parseInt(tokens[1])
      await delay(millis)
      write("slept " + millis)
      write("PASS")
      break

    case "version":
      write("v1.2.3")
      write("PASS")
      break

    case "exit":
      if (ignoreExit) {
        write("ignoreExit is set")
      } else {
        process.exit(0)
      }
      break

    case "stderr":
      console.error("Error: " + tokens.slice(1).join(" "))
      write("PASS")
      break

    default:
      console.error("COMMAND MISSING for input", line)
      write("FAIL")
  }
  return
}

let prior = Promise.resolve()

// Quick and dirty request serializer, but leaks Promises (as all prior promises
// are held):
rl.on("line", line => (prior = prior.then(() => onLine(line))))
