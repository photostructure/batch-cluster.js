/**
 * Three-phase search for optimal streamFlushMillis / waitForStderrMillis
 * values.
 *
 * Phase 1 (Coarse): Binary search with few tasks per step to quickly find the
 * approximate threshold where noTaskData events start appearing.
 *
 * Phase 2 (Validate): Run many trials with more tasks around the coarse
 * threshold to confirm the exact minimum reliable value.
 *
 * Phase 3 (Confirm): Hammer the found minimum with many more trials to ensure
 * stability.
 *
 * The exported functions apply a configurable safety margin (default 2x) and
 * return the recommended value as a plain number.
 *
 * @module
 */

import type child_process from "node:child_process";
import { BatchCluster } from "./BatchCluster";
import type { Logger } from "./Logger";
import { NoLogger } from "./Logger";
import type { Task } from "./Task";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for {@link findWaitForStderrMillis} and
 * {@link findStreamFlushMillis}.
 *
 * @typeParam T - The resolved type of the tasks produced by
 *   {@link taskFactory}. The search ignores task results (only
 *   `noTaskData` events matter), so this can be anything.
 */
export interface FindFlushMillisOptions<T = unknown> {
  // --- Process lifecycle (same fields as BatchCluster) ---

  /** Factory that spawns child processes. */
  processFactory: () =>
    | child_process.ChildProcess
    | Promise<child_process.ChildProcess>;

  /** Low-overhead startup command to verify the child process started. */
  versionCommand: string;

  /** Pattern indicating a task passed. */
  pass: string | RegExp;

  /** Pattern indicating a task failed. */
  fail: string | RegExp;

  /** Command to gracefully shut down a child process. */
  exitCommand?: string;

  // --- Trial task factory ---

  /**
   * Creates a fresh {@link Task} for each trial iteration. Called with a
   * 0-based index. Callers should vary commands across calls to exercise
   * different code paths (clean successes, stderr-emitting commands,
   * writes, etc.).
   */
  taskFactory: (taskIndex: number) => Task<T>;

  // --- Search bounds ---

  /**
   * Lower bound of the search range in milliseconds.
   * @default 0
   */
  lo?: number;

  /**
   * Upper bound of the search range in milliseconds.
   * @default 500
   */
  hi?: number;

  // --- Tuning (all optional with good defaults) ---

  /**
   * Maximum concurrent child processes during trials.
   * @default 4
   */
  maxProcs?: number;

  /**
   * Tasks per binary-search step in the coarse phase.
   * @default 10
   */
  coarseTasks?: number;

  /**
   * Tasks per trial in the validation phase.
   * @default 50
   */
  validationTasks?: number;

  /**
   * Number of trials at each candidate value during validation.
   * @default 5
   */
  validationTrials?: number;

  /**
   * How many ms above/below the coarse result to validate.
   * @default 3
   */
  validationRadius?: number;

  /**
   * Number of trials at the found minimum during confirmation.
   * @default 20
   */
  confirmationTrials?: number;

  /**
   * Tasks per trial in the confirmation phase.
   * @default 50
   */
  confirmationTasks?: number;

  /**
   * Multiplier applied to the minimum reliable value to produce the
   * recommended result.
   * @default 2
   */
  safetyMargin?: number;

  // --- Logging ---

  /**
   * Logger for progress messages. Progress goes to `info`, failures to
   * `warn`. When not provided, all output is silently discarded.
   */
  logger?: () => Logger;
}

// ---------------------------------------------------------------------------
// Internal types & defaults
// ---------------------------------------------------------------------------

export type SearchParameter = "waitForStderrMillis" | "streamFlushMillis";

interface TrialResult {
  noTaskDataEvents: number;
  taskErrors: number;
  tasksCompleted: number;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_MAX_PROCS = 4;
const DEFAULT_COARSE_TASKS = 10;
const DEFAULT_VALIDATION_TASKS = 50;
const DEFAULT_VALIDATION_TRIALS = 5;
const DEFAULT_VALIDATION_RADIUS = 3;
const DEFAULT_CONFIRMATION_TRIALS = 20;
const DEFAULT_CONFIRMATION_TASKS = 50;
const DEFAULT_SAFETY_MARGIN = 2;

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

async function runTrial<T>(
  parameter: SearchParameter,
  opts: FindFlushMillisOptions<T>,
  candidateMs: number,
  taskCount: number,
  timeoutMs: number,
): Promise<TrialResult> {
  let noTaskDataCount = 0;

  // Pin the *other* parameter to a known-good value so we only measure one
  // dimension at a time.
  const clusterOpts =
    parameter === "waitForStderrMillis"
      ? { streamFlushMillis: 500, waitForStderrMillis: candidateMs }
      : { streamFlushMillis: candidateMs };

  const maxProcs = opts.maxProcs ?? DEFAULT_MAX_PROCS;

  const bc = new BatchCluster({
    ...clusterOpts,
    maxProcs,
    minDelayBetweenSpawnMillis: 0,
    versionCommand: opts.versionCommand,
    pass: opts.pass,
    fail: opts.fail,
    exitCommand: opts.exitCommand,
    maxTasksPerProcess: taskCount + 10,
    taskTimeoutMillis: 5000,
    spawnTimeoutMillis: 15000,
    cleanupChildProcsOnExit: false,
    processFactory: opts.processFactory,
  });

  // Resolve on first noTaskData — we short-circuit immediately.
  let resolveNoTaskData: () => void;
  const noTaskDataSignal = new Promise<"noTaskData">((resolve) => {
    resolveNoTaskData = () => resolve("noTaskData");
  });

  bc.on("noTaskData", () => {
    noTaskDataCount++;
    if (noTaskDataCount === 1) resolveNoTaskData();
  });

  const start = Date.now();
  let tasksCompleted = 0;
  let taskErrors = 0;
  let timedOut = false;

  // Keep the event loop alive (BatchCluster's intervals are unref'd).
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const keepalive = setInterval(() => {}, 1000);

  try {
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < taskCount; i++) {
      promises.push(bc.enqueueTask(opts.taskFactory(i)));
    }

    const timeout = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), timeoutMs);
      t.unref();
    });

    const raceResult = await Promise.race([
      Promise.allSettled(promises),
      timeout,
      noTaskDataSignal,
    ]);

    if (raceResult === "timeout") {
      timedOut = true;
    } else if (raceResult !== "noTaskData") {
      for (const r of raceResult) {
        if (r.status === "fulfilled") tasksCompleted++;
        else taskErrors++;
      }
    }
  } finally {
    // Snapshot count before cleanup — shutdown can emit spurious noTaskData.
    const finalCount = noTaskDataCount;
    await bc.end(true);
    clearInterval(keepalive);
    noTaskDataCount = finalCount;
  }

  return {
    noTaskDataEvents: noTaskDataCount,
    taskErrors,
    tasksCompleted,
    durationMs: Date.now() - start,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Coarse binary search
// ---------------------------------------------------------------------------

async function coarseSearch<T>(
  parameter: SearchParameter,
  opts: FindFlushMillisOptions<T>,
  lo: number,
  hi: number,
): Promise<number> {
  const log = opts.logger?.() ?? NoLogger;
  const coarseTasks = opts.coarseTasks ?? DEFAULT_COARSE_TASKS;
  const maxProcs = opts.maxProcs ?? DEFAULT_MAX_PROCS;

  log.info(
    `Phase 1: Coarse binary search for ${parameter} in [${lo}, ${hi}]` +
      ` (${coarseTasks} tasks/step, ${maxProcs} procs)`,
  );

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await runTrial(parameter, opts, mid, coarseTasks, 15_000);
    const label = `${mid}ms`.padEnd(6);
    const range = `[${lo}, ${hi}]`;

    if (result.timedOut) {
      log.info(`  ${label} ${range} -> TIMEOUT (${result.durationMs}ms)`);
      lo = mid + 1;
    } else if (result.noTaskDataEvents > 0) {
      log.info(
        `  ${label} ${range} -> FAIL (noTaskData, ${result.durationMs}ms)`,
      );
      lo = mid + 1;
    } else {
      log.info(
        `  ${label} ${range} -> PASS` +
          ` (${result.tasksCompleted} ok, ${result.taskErrors} err, ${result.durationMs}ms)`,
      );
      hi = mid;
    }
  }

  log.info(`  Coarse threshold: ${lo}ms`);
  return lo;
}

// ---------------------------------------------------------------------------
// Phase 2: Validate around the threshold
// ---------------------------------------------------------------------------

async function validateThreshold<T>(
  parameter: SearchParameter,
  opts: FindFlushMillisOptions<T>,
  coarseThreshold: number,
  searchHi: number,
): Promise<number> {
  const log = opts.logger?.() ?? NoLogger;
  const validationTasks = opts.validationTasks ?? DEFAULT_VALIDATION_TASKS;
  const validationTrials = opts.validationTrials ?? DEFAULT_VALIDATION_TRIALS;
  const validationRadius = opts.validationRadius ?? DEFAULT_VALIDATION_RADIUS;

  const from = Math.max(0, coarseThreshold - validationRadius);
  const to = Math.min(searchHi, coarseThreshold + validationRadius);

  log.info(
    `Phase 2: Validating ${parameter} in [${from}, ${to}]` +
      ` (${validationTrials} trials x ${validationTasks} tasks)`,
  );

  let minimumReliable: number | undefined;

  for (let ms = from; ms <= to; ms++) {
    let passedAll = true;

    for (let t = 0; t < validationTrials; t++) {
      const result = await runTrial(
        parameter,
        opts,
        ms,
        validationTasks,
        30_000,
      );

      if (result.noTaskDataEvents > 0 || result.timedOut) {
        const reason = result.timedOut ? "timeout" : "noTaskData";
        log.info(
          `  ${ms}ms: FAIL trial ${t + 1}/${validationTrials}` +
            ` (${reason}, ${result.durationMs}ms)`,
        );
        passedAll = false;
        break;
      }
    }

    if (passedAll) {
      log.info(
        `  ${ms}ms: PASS (${validationTrials}/${validationTrials} trials)`,
      );
      minimumReliable ??= ms;
    }
  }

  if (minimumReliable == null) {
    log.warn(
      `  WARNING: no value in [${from}, ${to}] passed all trials — using ${to}ms`,
    );
    minimumReliable = to;
  }

  return minimumReliable;
}

// ---------------------------------------------------------------------------
// Phase 3: Confirm the minimum with many trials
// ---------------------------------------------------------------------------

async function confirmMinimum<T>(
  parameter: SearchParameter,
  opts: FindFlushMillisOptions<T>,
  startMs: number,
  searchHi: number,
): Promise<number> {
  const log = opts.logger?.() ?? NoLogger;
  const confirmationTrials =
    opts.confirmationTrials ?? DEFAULT_CONFIRMATION_TRIALS;
  const confirmationTasks =
    opts.confirmationTasks ?? DEFAULT_CONFIRMATION_TASKS;

  log.info(
    `Phase 3: Confirming ${parameter} minimum` +
      ` (${confirmationTrials} trials x ${confirmationTasks} tasks)`,
  );

  for (let ms = startMs; ms <= searchHi; ms++) {
    let failed = false;

    for (let t = 0; t < confirmationTrials; t++) {
      const result = await runTrial(
        parameter,
        opts,
        ms,
        confirmationTasks,
        30_000,
      );

      if (result.noTaskDataEvents > 0 || result.timedOut) {
        const reason = result.timedOut ? "timeout" : "noTaskData";
        log.info(
          `  ${ms}ms: FAIL trial ${t + 1}/${confirmationTrials}` +
            ` (${reason}, ${result.durationMs}ms)`,
        );
        failed = true;
        break;
      }
    }

    if (!failed) {
      log.info(
        `  ${ms}ms: PASS (${confirmationTrials}/${confirmationTrials} trials)`,
      );
      return ms;
    }
  }

  log.warn(`  WARNING: no value up to ${searchHi}ms passed all trials`);
  return searchHi;
}

// ---------------------------------------------------------------------------
// Shared implementation
// ---------------------------------------------------------------------------

async function findThreshold<T>(
  parameter: SearchParameter,
  opts: FindFlushMillisOptions<T>,
): Promise<number> {
  const lo = opts.lo ?? 0;
  const hi = opts.hi ?? 500;
  const safetyMargin = opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN;

  const coarse = await coarseSearch(parameter, opts, lo, hi);
  const validated = await validateThreshold(parameter, opts, coarse, hi);
  const min = await confirmMinimum(parameter, opts, validated, hi);

  return Math.max(1, min * safetyMargin);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the minimum reliable `waitForStderrMillis` value for the given child
 * process on the current hardware.
 *
 * `waitForStderrMillis` controls how long to wait for stderr to flush after a
 * pass/fail token is detected on stdout. The returned value includes a safety
 * margin (default 2x).
 *
 * The search detects `noTaskData` events (orphaned stream data arriving after
 * a task has already resolved) as the signal that the flush timing is too
 * short.
 *
 * @example
 * ```typescript
 * import { findWaitForStderrMillis, Task } from "batch-cluster";
 *
 * const waitForStderrMillis = await findWaitForStderrMillis({
 *   processFactory: () => spawn("perl", [exiftoolPath, "-stay_open", "True", "-@", "-"]),
 *   versionCommand: "-ver\n-execute\n",
 *   pass: "{ready}",
 *   fail: "{ready}",
 *   exitCommand: "-stay_open\nFalse\n",
 *   taskFactory: (i) => {
 *     const cmds = ["-json\n/clean.jpg\n-execute\n", "-validate\n/warn.jpg\n-execute\n"];
 *     return new Task(cmds[i % cmds.length], (stdout) => stdout);
 *   },
 * });
 * ```
 */
export function findWaitForStderrMillis<T>(
  options: FindFlushMillisOptions<T>,
): Promise<number> {
  return findThreshold("waitForStderrMillis", options);
}

/**
 * Find the minimum reliable `streamFlushMillis` value for the given child
 * process on the current hardware.
 *
 * `streamFlushMillis` controls how long to wait for stdout to flush after a
 * pass/fail token is detected on stderr. The returned value includes a safety
 * margin (default 2x).
 *
 * This is only relevant for child processes whose pass/fail token appears on
 * stderr. If your process always emits the token on stdout, use
 * {@link findWaitForStderrMillis} instead.
 */
export function findStreamFlushMillis<T>(
  options: FindFlushMillisOptions<T>,
): Promise<number> {
  return findThreshold("streamFlushMillis", options);
}
