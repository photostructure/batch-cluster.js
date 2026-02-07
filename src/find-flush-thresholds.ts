import {
  SearchParameter,
  findStreamFlushMillis,
  findWaitForStderrMillis,
} from "./FindFlushThresholds";
import {
  expectFailParser,
  expectPassParser,
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
  parameters: SearchParameter[];
  lo: number;
  hi: number;
}

const allParameters: SearchParameter[] = [
  "waitForStderrMillis",
  "streamFlushMillis",
];

function printUsage() {
  console.log(`Usage: node FindFlushThresholds.js [options]

Options:
  --parameter <name>   waitForStderrMillis or streamFlushMillis (default: both)
  --lo <ms>            Lower bound (default: 0)
  --hi <ms>            Upper bound (default: 500)
  --help               Show this help`);
}

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const config: CliConfig = { parameters: [], lo: 0, hi: 500 };

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
      case "--parameter": {
        const p = next();
        if (p !== "waitForStderrMillis" && p !== "streamFlushMillis") {
          console.error(
            `Invalid parameter: ${p} (must be waitForStderrMillis or streamFlushMillis)`,
          );
          process.exit(1);
        }
        config.parameters.push(p);
        break;
      }
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

  if (config.parameters.length === 0) {
    config.parameters = allParameters;
  }

  return config;
}

async function main() {
  const config = parseArgs();

  console.log(
    `Finding flush thresholds on ${platformName} (node ${process.version})`,
  );

  const results: { parameter: string; min: number; recommended: number }[] = [];

  for (const parameter of config.parameters) {
    const taskFactory =
      parameter === "waitForStderrMillis"
        ? (i: number) => new Task("stderr test-data " + i, expectPassParser)
        : (i: number) =>
            new Task("stderrfail test-data " + i, expectFailParser);

    const recommended =
      parameter === "waitForStderrMillis"
        ? await findWaitForStderrMillis({
            processFactory: testProcessFactory,
            versionCommand: "version",
            pass: "PASS",
            fail: "FAIL",
            exitCommand: "exit",
            taskFactory,
            lo: config.lo,
            hi: config.hi,
            logger: () => cliLogger,
          })
        : await findStreamFlushMillis({
            processFactory: testProcessFactory,
            versionCommand: "version",
            pass: "PASS",
            fail: "FAIL",
            exitCommand: "exit",
            taskFactory,
            lo: config.lo,
            hi: config.hi,
            logger: () => cliLogger,
          });

    const min = Math.ceil(recommended / 2); // reverse the 2x safety margin
    results.push({ parameter, min, recommended });

    console.log("\n" + "=".repeat(60));
    console.log(`${parameter} on ${platformName} (${process.version}):`);
    console.log(`  Minimum reliable: ${min}ms`);
    console.log(`  Recommended (2x): ${recommended}ms`);
    console.log("=".repeat(60));
  }

  if (results.length > 1) {
    console.log("\n" + "=".repeat(60));
    console.log("Summary:");
    for (const r of results) {
      console.log(
        `  ${r.parameter}: min=${r.min}ms, recommended=${r.recommended}ms`,
      );
    }
    console.log("=".repeat(60));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
