/* eslint-disable @typescript-eslint/no-require-imports */
try {
  require("source-map-support").install();
} catch {
  //
}

import { expect, use } from "chai";
import child_process from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { BatchClusterOptions } from "./BatchCluster";
import { DefaultTestOptions } from "./DefaultTestOptions.spec";
import {
  findStreamFlushMillis,
  findWaitForStderrMillis,
} from "./FindFlushThresholds";
import {
  expectFailParser,
  expectPassParser,
  testProcessFactory,
} from "./FlushThresholdTestHelpers";
import { Log, logger, setLogger } from "./Logger";
import type { Parser } from "./Parser";
import { pidExists } from "./Pids";
import { notBlank } from "./String";
import { Task } from "./Task";
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

// ---------------------------------------------------------------------------
// Flush threshold discovery & caching
// ---------------------------------------------------------------------------

interface FlushThresholdCache {
  streamFlushMillis: number;
  waitForStderrMillis: number;
  nodeVersion: string;
  timestamp: string;
}

const CACHE_DIR = path.join(__dirname, "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, process.platform + ".json");

function readCache(): FlushThresholdCache | undefined {
  try {
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as FlushThresholdCache;
    if (
      data.nodeVersion === process.version &&
      typeof data.streamFlushMillis === "number" &&
      typeof data.waitForStderrMillis === "number" &&
      data.streamFlushMillis > 0 &&
      data.waitForStderrMillis > 0
    ) {
      return data;
    }
  } catch {
    // Cache missing or corrupt — will re-discover
  }
  return undefined;
}

function writeCache(result: {
  streamFlushMillis: number;
  waitForStderrMillis: number;
}): void {
  const data: FlushThresholdCache = {
    ...result,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
  };
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch {
    // Non-fatal: discovery still works, just won't be cached
  }
}

// Quick but slightly more robust than FindFlushThresholds.spec.ts's fastTuning
const quickTuning = {
  lo: 0,
  hi: 20,
  maxProcs: 2,
  coarseTasks: 5,
  validationTasks: 5,
  validationTrials: 2,
  validationRadius: 2,
  confirmationTrials: 4,
  confirmationTasks: 7,
  safetyMargin: 2,
};

/**
 * Discover (or read from cache) the optimal flush threshold values for the
 * current machine. Returns `{ streamFlushMillis, waitForStderrMillis }`.
 */
export async function batchClusterTestOptions(): Promise<{
  streamFlushMillis: number;
  waitForStderrMillis: number;
}> {
  const cached = readCache();
  if (cached != null) {
    return {
      streamFlushMillis: cached.streamFlushMillis,
      waitForStderrMillis: cached.waitForStderrMillis,
    };
  }

  const commonOpts = {
    processFactory: testProcessFactory,
    versionCommand: "version",
    pass: "PASS",
    fail: "FAIL",
    exitCommand: "exit",
    ...quickTuning,
  };

  const [waitForStderrMillis, streamFlushMillis] = await Promise.all([
    findWaitForStderrMillis({
      ...commonOpts,
      taskFactory: (i: number) =>
        new Task("stderr test-data " + i, expectPassParser),
    }),
    findStreamFlushMillis({
      ...commonOpts,
      taskFactory: (i: number) =>
        new Task("stderrfail test-data " + i, expectFailParser),
    }),
  ]);

  const result = {
    streamFlushMillis,
    waitForStderrMillis,
  } satisfies Pick<
    BatchClusterOptions,
    "streamFlushMillis" | "waitForStderrMillis"
  >;
  writeCache(result);
  return result;
}

// Root-level before() hook: runs once before all test suites.
// Discovers flush thresholds and injects them into DefaultTestOptions.
before(async function () {
  this.timeout(60_000);
  const thresholds = await batchClusterTestOptions();
  Object.assign(DefaultTestOptions, thresholds);
  console.log("Flush thresholds:", thresholds);
});
