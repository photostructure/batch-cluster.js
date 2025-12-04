/* eslint-disable @typescript-eslint/no-require-imports */
try {
  require("source-map-support").install();
} catch {
  //
}

import { expect, use } from "chai";
import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import { Log, logger, setLogger } from "./Logger";
import { Parser } from "./Parser";
import { pidExists } from "./Pids";
import { notBlank } from "./String";
import { TestEnv } from "./TestEnv";

use(require("chai-as-promised"));
use(require("chai-string"));
use(require("chai-subset"));
use(require("chai-withintoleranceof"));

export { expect } from "chai";

// Tests should be quiet unless LOG is set to "trace" or "debug" or "info" or...
setLogger(
  Log.withLevels(
    Log.withTimestamps(
      Log.filterLevels(
        {
          trace: console.log,
          debug: console.log,
          info: console.log,
          warn: console.warn,
          error: console.error,
        },
        (process.env.LOG as any) ?? "error",
      ),
    ),
  ),
);

export const parserErrors: string[] = [];

export const unhandledRejections: Error[] = [];

beforeEach(() => (parserErrors.length = 0));

process.on("unhandledRejection", (reason: any) => {
  console.error("unhandledRejection:", reason.stack ?? reason);
  unhandledRejections.push(reason);
});

afterEach(() => expect(unhandledRejections).to.eql([]));

export const parser: Parser<string> = (
  stdout: string,
  stderr: string | undefined,
  passed: boolean,
) => {
  if (stderr != null) {
    parserErrors.push(stderr);
  }
  if (!passed || notBlank(stderr)) {
    logger().debug("test parser: rejecting task", {
      stdout,
      stderr,
      passed,
    });
    // process.stdout.write("!")
    throw new Error(stderr);
  } else {
    const str = stdout
      .split(/(\r?\n)+/)
      .filter((ea) => notBlank(ea) && !ea.startsWith("# "))
      .join("\n")
      .trim();
    logger().debug("test parser: resolving task", str);
    // process.stdout.write(".")
    return str;
  }
};

export function times<T>(n: number, f: (idx: number) => T): T[] {
  return Array(n)
    .fill(undefined)
    .map((_, i) => f(i));
}

// because @types/chai-withintoleranceof isn't a thing (yet)

type WithinTolerance = (
  expected: number,
  tol: number | number[],
  message?: string,
) => Chai.Assertion;

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Chai {
  interface Assertion {
    withinToleranceOf: WithinTolerance;
    withinTolOf: WithinTolerance;
  }
}

export const childProcs: child_process.ChildProcess[] = [];

export function testPids(): number[] {
  return childProcs
    .map((proc) => proc.pid)
    .filter((ea) => ea != null) as number[];
}

export function currentTestPids(): number[] {
  return testPids().filter((pid) => pidExists(pid));
}

export function sortNumeric(arr: number[]): number[] {
  return arr.sort((a, b) => a - b);
}

export function flatten<T>(arr: (T | T[])[], result: T[] = []): T[] {
  arr.forEach((ea) =>
    Array.isArray(ea) ? result.push(...ea) : result.push(ea),
  );
  return result;
}

// Seeding the RNG deterministically _should_ give us repeatable
// flakiness/successes.

// We want a rngseed that is stable for consecutive tests, but changes sometimes
// to make sure different error pathways are exercised. YYYY-MM-$callcount
// should do it.

const rngSeedPrefix = new Date().toISOString().slice(0, 7) + ".";
let rngSeedCounter = 0;
let rngSeedOverride: string | undefined;

export function setRngSeed(seed?: string) {
  rngSeedOverride = seed;
}

function rngSeed() {
  // We need a new rngseed for every execution, or all runs will either pass or
  // fail:
  return rngSeedOverride ?? rngSeedPrefix + rngSeedCounter++;
}

let failRate: string;

export function setFailRatePct(percent: number) {
  failRate = (percent / 100).toFixed(2);
}

let unluckyFail: "1" | "0";

/**
 * Should EUNLUCKY be handled properly by the test script, and emit a "FAIL", or
 * require batch-cluster to timeout the job?
 *
 * Basically setting unluckyfail to true is worst-case behavior for a script,
 * where all flaky errors require a timeout to recover.
 */
export function setUnluckyFail(b: boolean) {
  unluckyFail = b ? "1" : "0";
}

let newline: "lf" | "crlf";

export function setNewline(eol: "lf" | "crlf") {
  newline = eol;
}

let ignoreExit: "1" | "0";

export function setIgnoreExit(ignore: boolean) {
  ignoreExit = ignore ? "1" : "0";
}

beforeEach(() => {
  setFailRatePct(10);
  setUnluckyFail(true);
  setNewline("lf");
  setIgnoreExit(false);
  setRngSeed();
});

export const processFactory = () => {
  const e: Required<TestEnv> = {
    RNG_SEED: rngSeed(),
    FAIL_RATE: failRate,
    NEWLINE: newline,
    IGNORE_EXIT: ignoreExit,
    UNLUCKY_FAIL: unluckyFail,
  };
  const proc = child_process.spawn(
    process.execPath,
    [path.join(__dirname, "test.js")],
    { env: e },
  );
  childProcs.push(proc);
  return proc;
};
