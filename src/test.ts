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

function write(s: string): boolean {
  return _p.stdout.write(s + newline)
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
  const firstToken = tokens.shift()

  try {
    switch (firstToken) {
      case "flaky":
        const flakeRate = parseFloat(tokens.shift()!)
        write(
          "flaky response (" +
            (r < flakeRate ? "FAIL" : "PASS") +
            ", r: " +
            r.toFixed(2) +
            ", flakeRate: " +
            flakeRate.toFixed(2) +
            // Extra information is used for context:
            (tokens.length > 0 ? ", " + tokens.join(" ") : "") +
            ")"
        )
        if (r < flakeRate) {
          write("FAIL")
        } else {
          write("PASS")
        }
        break

      case "upcase":
        write(tokens.join(" ").toUpperCase())
        write("PASS")
        break

      case "downcase":
        write(tokens.join(" ").toLowerCase())
        write("PASS")
        break

      case "sleep":
        const millis = parseInt(tokens[0])
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
        console.error("Error: " + tokens.join(" "))
        // Make sure the error is received before the PASS:
        await delay(50)
        write("PASS")
        break

      default:
        console.error("invalid/missing command for input", line)
        // Make sure the error is received before the FAIL:
        await delay(50)
        write("FAIL")
    }
  } catch (err) {
    console.error("Error: " + err)
    write("FAIL")
  }
  return
}

let prior = Promise.resolve()

// Quick and dirty request serializer, but leaks Promises (as all prior promises
// are held):
rl.on("line", line => (prior = prior.then(() => onLine(line))))
