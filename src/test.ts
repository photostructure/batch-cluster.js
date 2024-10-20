#!/usr/bin/env node
import process from "node:process"
import { delay } from "./Async"
import { Mutex } from "./Mutex"

/**
 * This is a script written to behave similarly to ExifTool or
 * GraphicsMagick's batch-command modes. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 */

const newline = process.env.newline === "crlf" ? "\r\n" : "\n"

async function write(s: string) {
  return new Promise<void>((res, rej) =>
    process.stdout.write(s + newline, (err) =>
      err == null ? res() : rej(err),
    ),
  )
}

const ignoreExit = process.env.ignoreExit === "1"

if (ignoreExit) {
  process.addListener("SIGINT", () => {
    write("ignoring SIGINT")
  })
  process.addListener("SIGTERM", () => {
    write("ignoring SIGTERM")
  })
}

function toF(s: string | undefined) {
  if (s == null) return
  const f = parseFloat(s)
  return isNaN(f) ? undefined : f
}

const failrate = toF(process.env.failrate) ?? 0
const rng =
  process.env.rngseed != null
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("seedrandom")(process.env.rngseed)
    : Math.random

async function onLine(line: string): Promise<void> {
  // write(`# ${_p.pid} onLine(${line.trim()}) (newline = ${process.env.newline})`)
  const r = rng()
  if (r < failrate) {
    // stderr isn't buffered, so this should be flushed immediately:
    console.error(
      "EUNLUCKY: r: " +
        r.toFixed(2) +
        ", failrate: " +
        failrate.toFixed(2) +
        ", seed: " +
        process.env.rngseed,
    )
    if (process.env.unluckyfail === "1") {
      // Wait for a bit to ensure streams get merged thanks to streamFlushMillis:
      await delay(5)
      await write("FAIL")
    }
    return
  }
  line = line.trim()
  const tokens = line.split(/\s+/)
  const firstToken = tokens.shift()

  // support multi-line outputs:
  const postToken = tokens.join(" ").split("<br>").join(newline)

  try {
    switch (firstToken) {
      case "flaky": {
        const flakeRate = toF(tokens.shift()) ?? failrate
        write(
          "flaky response (" +
            (r < flakeRate ? "FAIL" : "PASS") +
            ", r: " +
            r.toFixed(2) +
            ", flakeRate: " +
            flakeRate.toFixed(2) +
            // Extra information is used for context:
            (tokens.length > 0 ? ", " + tokens.join(" ") : "") +
            ")",
        )
        if (r < flakeRate) {
          write("FAIL")
        } else {
          write("PASS")
        }
        break
      }

      case "upcase": {
        write(postToken.toUpperCase())
        write("PASS")
        break
      }
      case "downcase": {
        write(postToken.toLowerCase())
        write("PASS")
        break
      }
      case "sleep": {
        const millis = parseInt(tokens[0] ?? "100")
        await delay(millis)
        write(JSON.stringify({ slept: millis, pid: process.pid }))
        write("PASS")
        break
      }

      case "version": {
        write("v1.2.3")
        write("PASS")
        break
      }

      case "exit": {
        if (ignoreExit) {
          write("ignoreExit is set")
        } else {
          process.exit(0)
        }
        break
      }
      case "stderr": {
        // force stdout to be emitted before stderr, and exercise stream
        // debouncing:
        write("PASS")
        await delay(1)
        console.error("Error: " + postToken)
        break
      }
      default: {
        console.error("invalid or missing command for input", line)
        write("FAIL")
      }
    }
  } catch (err) {
    console.error("Error: " + err)
    write("FAIL")
  }
  return
}

const m = new Mutex()

process.stdin
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  .pipe(require("split2")())
  .on("data", (ea: string) => m.serial(() => onLine(ea)))
