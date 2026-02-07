import { findStreamFlushMillis } from "./FindFlushThresholds";
import {
  expectFailParser,
  testProcessFactory,
} from "./FlushThresholdTestHelpers";
import { isMac, isWin } from "./Platform";
import { Task } from "./Task";

// ---------------------------------------------------------------------------
// CLI (internal testing tool — only runs when executed directly)
// ---------------------------------------------------------------------------

/* eslint-disable no-console */

const platformName = isWin ? "windows" : isMac ? "macos" : "linux";

const cliLogger = {
  trace: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
  debug: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
  info: console.log as (...args: unknown[]) => void,
  warn: console.warn as (...args: unknown[]) => void,
  error: console.error as (...args: unknown[]) => void,
};

interface CliConfig {
  lo: number;
  hi: number;
}

function printUsage() {
  console.log(`Usage: node find-flush-thresholds.js [options]

Options:
  --lo <ms>            Lower bound (default: 0)
  --hi <ms>            Upper bound (default: 500)
  --help               Show this help`);
}

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const config: CliConfig = { lo: 0, hi: 500 };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const v = args[++i];
      if (v == null) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      return v;
    };

    switch (arg) {
      case "--lo":
        config.lo = parseInt(next(), 10);
        break;
      case "--hi":
        config.hi = parseInt(next(), 10);
        break;
      case "--help":
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();

  console.log(
    `Finding streamFlushMillis threshold on ${platformName} (node ${process.version})`,
  );

  const recommended = await findStreamFlushMillis({
    processFactory: testProcessFactory,
    versionCommand: "version",
    pass: "PASS",
    fail: "FAIL",
    exitCommand: "exit",
    taskFactory: (i: number) =>
      new Task("stderrfail test-data " + i, expectFailParser),
    lo: config.lo,
    hi: config.hi,
    logger: () => cliLogger,
  });

  console.log("\n" + "=".repeat(60));
  console.log(`streamFlushMillis on ${platformName} (${process.version}):`);
  console.log(`  Minimum reliable: ${recommended}ms`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
