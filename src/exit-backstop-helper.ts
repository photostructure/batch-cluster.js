/**
 * Subprocess helper for the exit-backstop TDD test in BatchCluster.spec.ts.
 *
 * Flow:
 *  1. Spawn a BatchCluster with one child process (test.js with IGNORE_EXIT=1).
 *  2. Run `upcase hello` to confirm the process is healthy.
 *  3. Run `keepalive 60000` — test.js starts a 60-second ref'd timer then
 *     immediately responds with PASS.  By awaiting this task we know the timer
 *     is running, so the child process will survive even after stdin closes
 *     (which happens when the helper exits and the OS closes the pipe).
 *  4. Print the live PID to stdout for the parent test to collect.
 *  5. Call bc.end(true) fire-and-forget, then process.exit(0) immediately —
 *     before the async cleanup chain can run.
 *
 * The child process stays alive (kept by the 60-second timer) unless something
 * explicitly SIGKILLs it.  That "something" is the exit backstop in BatchCluster.
 *
 *   Without fix → PID survives (orphaned): parent test FAILS
 *   With fix    → SIGKILL from backstop kills PID: parent test PASSES
 */
import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import { BatchCluster } from "./BatchCluster";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";
import type { TestEnv } from "./TestEnv";

// IGNORE_EXIT: "1" so test.js ignores the "exit" command and SIGTERM.
// Only SIGKILL (from the backstop fix) can terminate it.
const env: Required<TestEnv> = {
  FAIL_RATE: "0",
  RNG_SEED: "backstop-helper",
  NEWLINE: "lf",
  IGNORE_EXIT: "1",
  UNLUCKY_FAIL: "0",
};

const bc = new BatchCluster({
  processFactory: () =>
    child_process.spawn(process.execPath, [path.join(__dirname, "test.js")], {
      env,
    }),
  versionCommand: "version",
  pass: "PASS",
  fail: "FAIL",
  exitCommand: "exit",
  maxProcs: 1,
  cleanupChildProcsOnExit: true,
  spawnTimeoutMillis: 10_000,
  taskTimeoutMillis: 10_000,
});

async function main() {
  // Confirm the process is healthy.
  await bc.enqueueTask(new Task("upcase hello", SimpleParser));

  // "keepalive 60000" starts a 60-second ref'd timer in test.js then responds
  // immediately with PASS.  Awaiting here guarantees the timer is running
  // before we continue — so the process outlives the stdin-EOF that happens
  // when this helper process exits.
  await bc.enqueueTask(new Task("keepalive 60000", SimpleParser));

  const pids = bc.pids();
  if (pids.length === 0) {
    process.stderr.write("ERROR: no live PIDs after keepalive task\n");
    process.exit(1);
  }

  // Write live PIDs so the parent test can read them.
  for (const pid of pids) process.stdout.write(pid + "\n");
  process.stdout.write("PIDS_DONE\n");

  // Fire-and-forget: async cleanup won't run before process.exit(0).
  void bc.end(true);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
