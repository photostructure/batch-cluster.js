#!/usr/bin/env node
// @ts-check
"use strict";

const { randomInt } = require("node:crypto");
const process = require("node:process");
const timers = require("node:timers");

/**
 * This is a script written to behave similarly to ExifTool's stay_open
 * batch-command mode. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 *
 * Plain JavaScript so `node test.js` works without tsx or compilation.
 */

/** @param {number} ms */
function delay(ms) {
  return ms === 0
    ? Promise.resolve()
    : new Promise((resolve) => timers.setTimeout(resolve, ms));
}

const env = {
  RNG_SEED: process.env.RNG_SEED,
  FAIL_RATE: process.env.FAIL_RATE,
  NEWLINE: process.env.NEWLINE,
  IGNORE_EXIT: process.env.IGNORE_EXIT,
  UNLUCKY_FAIL: process.env.UNLUCKY_FAIL,
};

const newline = env.NEWLINE === "crlf" ? "\r\n" : "\n";

/** @param {string} s */
async function write(s) {
  return /** @type {Promise<void>} */ (
    new Promise((res, rej) =>
      process.stdout.write(s + newline, (err) =>
        err == null ? res() : rej(err),
      ),
    )
  );
}

const ignoreExit = env.IGNORE_EXIT === "1";

if (ignoreExit) {
  process.addListener("SIGINT", () => {
    write("ignoring SIGINT");
  });
  process.addListener("SIGTERM", () => {
    write("ignoring SIGTERM");
  });
}

/** @param {string | undefined} s */
function toF(s) {
  if (s == null) return;
  const f = parseFloat(s);
  return isNaN(f) ? undefined : f;
}

const failRate = toF(env.FAIL_RATE) ?? 0;
const rng =
  env.RNG_SEED != null ? require("seedrandom")(env.RNG_SEED) : Math.random;

/** @param {string} line */
async function onLine(line) {
  const r = rng();
  if (r < failRate) {
    // stderr isn't buffered, so this should be flushed immediately:
    console.error(
      "EUNLUCKY: r: " +
        r.toFixed(2) +
        ", fail rate: " +
        failRate.toFixed(2) +
        ", seed: " +
        env.RNG_SEED,
    );
    if (env.UNLUCKY_FAIL === "1") {
      // Wait for a bit to ensure streams get merged thanks to streamFlushMillis.
      // Use a random delay to avoid tests passing due to a magic timing value:
      await delay(randomInt(5, 20));
      await write("FAIL");
    }
    return;
  }
  line = line.trim();
  const tokens = line.split(/\s+/);
  const firstToken = tokens.shift();

  // support multi-line outputs:
  const postToken = tokens.join(" ").split("<br>").join(newline);

  try {
    switch (firstToken) {
      case "flaky": {
        const flakeRate = toF(tokens.shift()) ?? failRate;
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
        );
        if (r < flakeRate) {
          write("FAIL");
        } else {
          write("PASS");
        }
        break;
      }

      case "upcase": {
        write(postToken.toUpperCase());
        write("PASS");
        break;
      }
      case "downcase": {
        write(postToken.toLowerCase());
        write("PASS");
        break;
      }
      case "sleep": {
        const millis = parseInt(tokens[0] ?? "100");
        if (millis > 0) await delay(millis);
        write(JSON.stringify({ slept: millis, pid: process.pid }));
        write("PASS");
        break;
      }

      case "version": {
        write("v1.2.3");
        write("PASS");
        break;
      }

      case "exit": {
        if (ignoreExit) {
          write("IGNORE_EXIT is set");
        } else {
          const exitCode = parseInt(tokens[0] ?? "0");
          if (isNaN(exitCode) || exitCode < 0 || exitCode > 255) {
            write(`Invalid exit code: ${tokens[0]}`);
            break;
          }
          process.exit(exitCode);
        }
        break;
      }
      case "kill": {
        // Send a signal to ourselves for testing signal capture
        if (ignoreExit) {
          write("IGNORE_EXIT is set");
        } else {
          const signal = tokens[0] ?? "SIGTERM";
          // Validate signal name
          const validSignals = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"];
          if (!validSignals.includes(signal)) {
            write(`Invalid signal: ${signal}`);
            break;
          }
          process.kill(process.pid, signal);
        }
        break;
      }
      case "stderr": {
        // Emit stderr before the pass token on stdout, like ExifTool
        // (which always flushes stderr before emitting {ready}):
        console.error("Error: " + postToken);
        // note that we're not flushing or waiting here -- the test is that the
        // stderr content should be emitted before the PASS token, but that OS
        // buffering doesn't cause them to be emitted in the wrong order.
        write("PASS");
        break;
      }
      case "stderrfail": {
        // Emit stderr error content before the fail token on stdout, like
        // ExifTool (which always emits {ready} on stdout, never stderr):
        console.error("Error: " + postToken);
        write("FAIL");
        break;
      }
      default: {
        console.error("invalid or missing command for input", line);
        write("FAIL");
      }
    }
  } catch (err) {
    console.error("Error: " + err);
    write("FAIL");
  }
  return;
}

// Simple serial queue: process lines one at a time.
let pending = Promise.resolve();
process.stdin.pipe(require("split2")()).on("data", (line) => {
  pending = pending.then(() => onLine(line));
});
