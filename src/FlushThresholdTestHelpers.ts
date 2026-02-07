/**
 * Shared helpers for flush-threshold discovery tests and the CLI tool.
 *
 * Provides a zero-failure-rate test process factory and a parser for the
 * "stderrfail" command in test.ts.
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
 * Parser for the "stderrfail" test command.
 *
 * Flow: stderr error content arrives first, then FAIL token on stdout after a
 * short delay (mirroring ExifTool's stream ordering). The task is expected to
 * fail (`passed=false`).
 *
 * Used with {@link findStreamFlushMillis} to find how long to wait for
 * stderr data that was sent before the stdout completion token.
 */
export const expectFailParser: Parser<string> = (stdout, _stderr, passed) => {
  if (passed) throw new Error("task unexpectedly passed");
  return stdout.trim();
};
