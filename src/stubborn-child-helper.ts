/**
 * Minimal protocol child for shutdown tests.
 *
 * It answers the startup command, then deliberately survives stdin EOF, the
 * configured exit command, SIGTERM, and broken output pipes. Only SIGKILL
 * should stop it.
 */
import process from "node:process";
import readline from "node:readline";
import timers from "node:timers";

for (const stream of [process.stdin, process.stdout, process.stderr]) {
  stream.on("error", () => undefined);
}

process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);

// Keep the child alive after the parent destroys its stdio.
timers.setInterval(() => undefined, 1_000);

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = line.trim().split(/\s+/, 1)[0];
  if (command === "version") {
    process.stdout.write("v1.2.3\nPASS\n", () => undefined);
  }
  // Ignore every other command, including the configured exit command.
});
