#!/usr/bin/env node
import { randomInt } from "node:crypto";
import process from "node:process";
import { delay } from "./Async";
import { Mutex } from "./Mutex";
import { TestEnv } from "./TestEnv";

/**
 * This is a script written to behave similarly to ExifTool or
 * GraphicsMagick's batch-command modes. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 */

const env: TestEnv = {
  RNG_SEED: process.env.RNG_SEED,
  FAIL_RATE: process.env.FAIL_RATE,
  NEWLINE: process.env.NEWLINE,
  IGNORE_EXIT: process.env.IGNORE_EXIT,
  UNLUCKY_FAIL: process.env.UNLUCKY_FAIL,
};

const newline = env.NEWLINE === "crlf" ? "\r\n" : "\n";

async function write(s: string) {
  return new Promise<void>((res, rej) =>
    process.stdout.write(s + newline, (err) =>
      err == null ? res() : rej(err),
    ),
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

function toF(s: string | undefined) {
  if (s == null) return;
  const f = parseFloat(s);
  return isNaN(f) ? undefined : f;
}

const failRate = toF(env.FAIL_RATE) ?? 0;
const rng =
  env.RNG_SEED != null
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("seedrandom")(env.RNG_SEED)
    : Math.random;

async function onLine(line: string): Promise<void> {
  // write(`# ${_p.pid} onLine(${line.trim()}) (newline = ${env.NEWLINE})`);
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
        await delay(millis);
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
          process.exit(0);
        }
        break;
      }
      case "stderr": {
        // force stdout to be emitted before stderr, and exercise stream
        // debouncing:
        write("PASS");
        await delay(1);
        console.error("Error: " + postToken);
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

const m = new Mutex();

process.stdin
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  .pipe(require("split2")())
  .on("data", (ea: string) => m.serial(() => onLine(ea)));
