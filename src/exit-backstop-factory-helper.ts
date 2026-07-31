/**
 * Subprocess helper for the explicit-end async-factory barrier test.
 *
 * The factory spawns a child immediately, then delays before returning it.
 * `await bc.end(); process.exit(0)` must wait past the normal spawn budget
 * until that child becomes observable and has been terminated.
 */
import child_process from "node:child_process";
import path from "node:path";
import process from "node:process";
import { delay, until } from "./Async";
import { BatchCluster } from "./BatchCluster";
import { SimpleParser } from "./Parser";
import { Task } from "./Task";

let childPid: number | undefined;

const bc = new BatchCluster({
  processFactory: async () => {
    const proc = child_process.spawn(process.execPath, [
      path.join(__dirname, "stubborn-child-helper.js"),
    ]);
    childPid = proc.pid;
    await delay(500);
    return proc;
  },
  versionCommand: "version",
  pass: "PASS",
  fail: "FAIL",
  exitCommand: "exit",
  maxProcs: 1,
  spawnTimeoutMillis: 100,
  taskTimeoutMillis: 0,
});

async function main() {
  void bc
    .enqueueTask(new Task("never assigned", SimpleParser))
    .catch(() => undefined);
  if (!(await until(() => childPid != null, 2_000))) {
    throw new Error("factory did not spawn its child");
  }

  process.stdout.write(String(childPid) + "\n");
  process.stdout.write("PIDS_DONE\n");

  await bc.end(false).promise;
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
