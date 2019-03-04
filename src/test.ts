#!/usr/bin/env node
import * as _p from "process"

import { delay, serial } from "./Async"

/**
 * This is a script written to behave similarly to ExifTool or
 * GraphicsMagick's batch-command modes. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 */

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
const rng =
  _p.env.rngseed != null
    ? require("seedrandom")(_p.env.rngseed)
    : // tslint:disable-next-line: no-unbound-method
      Math.random

async function onLine(line: string): Promise<void> {
  // write(`# ${_p.pid} onLine(${line.trim()})`)
  const r = rng()
  if (r < failrate) {
    if (_p.env.unluckyfail === "1") {
      // Make sure streams get debounced:
      write("FAIL")
      await delay(1)
    }
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
        // force stdout to be emitted before stderr, and exercise stream
        // debouncing:
        write("PASS")
        await delay(1)
        console.error("Error: " + tokens.join(" "))
        break

      default:
        console.error("invalid or missing command for input", line)
        write("FAIL")
    }
  } catch (err) {
    console.error("Error: " + err)
    write("FAIL")
  }
  return
}

const onLineSerial = serial<void>()

process.stdin
  .pipe(require("split2")())
  .on("data", (ea: string) => onLineSerial(() => onLine(ea)))
