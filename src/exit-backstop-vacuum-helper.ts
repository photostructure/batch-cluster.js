/**
 * Subprocess helper for the vacuum-window exit-backstop test in
 * BatchCluster.spec.ts. Companion to exit-backstop-helper.ts, which covers the
 * end() path; this one covers recycling.
 *
 * Flow:
 *  1. Spawn a BatchCluster with one child process (test.js with IGNORE_EXIT=1).
 *  2. Run `keepalive 60000` so the child survives the stdin EOF that happens
 *     when this helper exits.
 *  3. Print the live PID for the parent test to collect.
 *  4. setMaxProcs(0) then fire vacuumProcs() WITHOUT awaiting it: vacuumProcs
 *     removes the process from the pool synchronously and then terminates it
 *     asynchronously, so at this instant the child is alive but is no longer a
 *     member of #procs.
 *  5. process.exit(0) inside that window.
 *
 * The child ignores the exit command and SIGTERM, so only a SIGKILL from
 * BatchCluster's exit backstop can stop it.
 *
 *   Backstop reading pids():         PID survives (orphaned) -> test FAILS
 *   Backstop reading unexitedPids(): SIGKILL kills PID       -> test PASSES
 */
import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import { until } from "./Async";
import { BatchCluster } from "./BatchCluster";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";
import type { TestEnv } from "./TestEnv";

const env: Required<TestEnv> = {
  FAIL_RATE: "0",
  RNG_SEED: "backstop-vacuum-helper",
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
  await bc.enqueueTask(new Task("upcase hello", SimpleParser));

  // Starts a 60-second ref'd timer in test.js, then responds immediately, so
  // the child outlives this helper's exit.
  await bc.enqueueTask(new Task("keepalive 60000", SimpleParser));

  const pids = bc.pids();
  if (pids.length === 0) {
    process.stderr.write("ERROR: no live PIDs after keepalive task\n");
    process.exit(1);
  }
  for (const pid of pids) process.stdout.write(pid + "\n");
  process.stdout.write("PIDS_DONE\n");

  // vacuumProcs() only recycles idle processes, and BatchProcess clears its
  // current task in a `.then` registered after ours, so the process is still
  // "busy" when the await above resumes.
  if (!(await until(() => bc.isIdle, 5_000))) {
    process.stderr.write("ERROR: cluster never went idle\n");
    process.exit(1);
  }

  // Recycle the (idle, healthy) child by shrinking the pool to zero. This
  // empties #procs while termination is still in flight.
  bc.setMaxProcs(0);
  void bc.vacuumProcs();

  // With --await-end, exercise the documented shutdown sequence instead of an
  // abrupt exit: end() must not resolve until the mid-recycle child is dead,
  // or this orphans it just the same.
  if (process.argv.includes("--await-end")) {
    await bc.end(true).promise;
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
