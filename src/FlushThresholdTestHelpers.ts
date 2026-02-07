/**
 * Shared helpers for flush-threshold discovery tests and the CLI tool.
 *
 * Provides a zero-failure-rate test process factory and parsers for the
 * "stderr" and "stderrfail" commands in test.ts.
 *
 * @module
 */

import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import type { Parser } from "./Parser";
import type { TestEnv } from "./TestEnv";

/**
 * Spawns test.js with zero failure rate and deterministic settings.
 * Used by flush-threshold discovery to measure timing without flakiness.
 */
export function testProcessFactory(): child_process.ChildProcess {
  const env: Required<TestEnv> = {
    RNG_SEED: String(Date.now()),
    FAIL_RATE: "0",
    NEWLINE: "lf",
    IGNORE_EXIT: "0",
    UNLUCKY_FAIL: "0",
  };
  return child_process.spawn(
    process.execPath,
    [path.join(__dirname, "test.js")],
    { env: env as unknown as NodeJS.ProcessEnv },
  );
}

/**
 * Parser for the "stderr" test command.
 *
 * Flow: PASS token arrives on stdout first, then stderr data follows after a
 * short delay. The task is expected to pass (`passed=true`).
 *
 * Used with {@link findWaitForStderrMillis} to find how long to wait for
 * stderr after the PASS token is seen on stdout.
 */
export const expectPassParser: Parser<string> = (stdout, _stderr, passed) => {
  if (!passed) throw new Error("task unexpectedly failed");
  return stdout.trim();
};

/**
 * Parser for the "stderrfail" test command.
 *
 * Flow: FAIL token arrives on stderr first, then stdout data follows after a
 * short delay. The task is expected to fail (`passed=false`).
 *
 * Used with {@link findStreamFlushMillis} to find how long to wait for
 * stdout after the FAIL token is seen on stderr.
 */
export const expectFailParser: Parser<string> = (stdout, _stderr, passed) => {
  if (passed) throw new Error("task unexpectedly passed");
  return stdout.trim();
};
