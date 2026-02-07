#!/usr/bin/env npx tsx
/**
 * Quick-and-dirty flush threshold discovery using actual ExifTool.
 * Assumes `exiftool` is in PATH.
 *
 * Usage: npx tsx src/find-flush-thresholds-exiftool.ts
 */
import child_process from "node:child_process";
import {
  findStreamFlushMillis,
  findWaitForStderrMillis,
} from "./FindFlushThresholds";
import { Task } from "./Task";

/* eslint-disable no-console */

const simpleParser = (stdout: string) => stdout.trim();

let i = 0;
function exiftoolTaskFactory(): Task<string> {
  // Even: stdout only. Odd: triggers stderr ("Error: File not found").
  return i++ % 2 === 0
    ? new Task("-ver\n-execute\n", simpleParser)
    : new Task("-json\n/nonexistent_flush_probe\n-execute\n", simpleParser);
}

const processFactory = () =>
  child_process.spawn("exiftool", ["-stay_open", "True", "-@", "-"], {
    stdio: "pipe",
    shell: false,
  });

const cliLogger = {
  trace: () => {
    //
  },
  debug: () => {
    //
  },
  info: console.log as (...args: unknown[]) => void,
  warn: console.warn as (...args: unknown[]) => void,
  error: console.error as (...args: unknown[]) => void,
};

async function main() {
  const commonOpts = {
    processFactory,
    versionCommand: "-ver\n-execute\n",
    pass: "{ready}",
    fail: "{ready}",
    exitCommand: "-stay_open\nFalse\n",
    logger: () => cliLogger,
  };

  const [waitForStderrMillis, streamFlushMillis] = await Promise.all([
    findWaitForStderrMillis({
      ...commonOpts,
      taskFactory: exiftoolTaskFactory,
    }),
    findStreamFlushMillis({
      ...commonOpts,
      taskFactory: exiftoolTaskFactory,
    }),
  ]);

  console.log("\n" + "=".repeat(60));
  console.log("ExifTool flush thresholds:");
  console.log(`  waitForStderrMillis: ${waitForStderrMillis}ms`);
  console.log(`  streamFlushMillis:   ${streamFlushMillis}ms`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
