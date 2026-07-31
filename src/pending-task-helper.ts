/**
 * Subprocess helper for the "pending work keeps the event loop alive" tests in
 * BatchCluster.spec.ts.
 *
 * This cannot be an in-process mocha test: mocha's own per-test timeout timer
 * is ref'd, so it holds the event loop open and masks the defect entirely.
 *
 * batch-cluster deliberately holds no ref'd handles of its own -- the child
 * process, its streams, the idle interval, and the respawn timer are all
 * unref'd, so an idle cluster never stops a script from exiting. The bug was
 * that outstanding *work* had nothing holding the loop open either: node would
 * drain, `beforeExit` would fire, and the task the caller was awaiting was
 * abandoned (queued) or rejected (assigned).
 *
 * Modes:
 *   --queued    maxTasksPerProcess forces a recycle mid-run, so the last task
 *               sits in the queue while the respawn waits behind an unref'd
 *               timer. Before the fix: promise never settles, exit 0.
 *   --assigned  a single slow task with taskTimeoutMillis: 0 (the default), so
 *               no per-task timer exists. Before the fix: "Process terminated
 *               before task completed".
 *
 * Prints one RESULT line per task, then DONE. The parent asserts on those.
 */
import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import { BatchCluster } from "./BatchCluster";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";
import type { TestEnv } from "./TestEnv";

const env: Required<TestEnv> = {
  FAIL_RATE: "0",
  RNG_SEED: "pending-task-helper",
  NEWLINE: "lf",
  IGNORE_EXIT: "0",
  UNLUCKY_FAIL: "0",
};

const queued = process.argv.includes("--queued");

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
  ...(queued
    ? {
        // Recycle after every 3rd task, so the 4th has to wait for a respawn.
        maxTasksPerProcess: 3,
        // A ref'd per-task timer, so *assigned* work is protected and the loop
        // only drains once a task is sitting in the queue -- which is the hole
        // this mode covers.
        taskTimeoutMillis: 5000,
      }
    : {
        // The documented default. Without it there is no ref'd per-task timer,
        // which used to be the only thing holding the loop open for assigned
        // work.
        taskTimeoutMillis: 0,
      }),
  spawnTimeoutMillis: 10_000,
});

async function main() {
  const commands = queued
    ? ["upcase a", "upcase b", "upcase c", "upcase d", "upcase e"]
    : ["sleep 3000"];

  for (const command of commands) {
    try {
      const result = await bc.enqueueTask(new Task(command, SimpleParser));
      process.stdout.write(`RESULT ok ${command} ${String(result).trim()}\n`);
    } catch (err) {
      process.stdout.write(
        `RESULT err ${command} ${String(err).split("\n")[0]}\n`,
      );
    }
  }
  process.stdout.write("DONE\n");
  await bc.end();
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
