import { BatchClusterOptions, WithObserver } from "./BatchClusterOptions";
import { BatchProcessOptions } from "./BatchProcessOptions";
import { ChildProcessFactory } from "./ChildProcessFactory";
import { CombinedBatchProcessOptions } from "./CombinedBatchProcessOptions";
import { blank, toS } from "./String";

/**
 * Verifies and sanitizes the provided options for BatchCluster.
 *
 * It merges partial options with default BatchClusterOptions,
 * converts pass/fail strings to RegExp, and validates various constraints.
 *
 * @param opts - The partial options to verify. These are merged with default
 *   BatchClusterOptions.
 * @returns The fully verified and sanitized options.
 * @throws Error if any options are invalid.
 */
export function verifyOptions(
  opts: Partial<BatchClusterOptions> &
    BatchProcessOptions &
    ChildProcessFactory &
    WithObserver,
): CombinedBatchProcessOptions {
  const result: CombinedBatchProcessOptions = {
    ...new BatchClusterOptions(),
    ...opts,
    passRE: toRe(opts.pass),
    failRE: toRe(opts.fail),
  } as CombinedBatchProcessOptions;

  const errors: string[] = [];

  function notBlank(fieldName: keyof CombinedBatchProcessOptions) {
    const v = toS(result[fieldName]);
    if (blank(v)) {
      errors.push(fieldName + " must not be blank");
    }
  }

  function gte(
    fieldName: keyof CombinedBatchProcessOptions,
    value: number,
    why?: string,
  ) {
    const v = result[fieldName] as number;
    if (v < value) {
      const msg = `${fieldName} must be greater than or equal to ${value}${blank(why) ? "" : ": " + why}`;
      errors.push(msg);
    }
  }

  notBlank("versionCommand");
  notBlank("pass");
  notBlank("fail");

  gte("maxTasksPerProcess", 1);

  gte("maxProcs", 1);

  if (
    opts.maxProcAgeMillis != null &&
    opts.maxProcAgeMillis > 0 &&
    result.taskTimeoutMillis
  ) {
    gte(
      "maxProcAgeMillis",
      Math.max(result.spawnTimeoutMillis, result.taskTimeoutMillis),
      `the max value of spawnTimeoutMillis (${result.spawnTimeoutMillis}) and taskTimeoutMillis (${result.taskTimeoutMillis})`,
    );
  }
  // 0 disables:
  gte("minDelayBetweenSpawnMillis", 0);
  gte("onIdleIntervalMillis", 0);
  gte("endGracefulWaitTimeMillis", 0);
  gte("streamFlushMillis", 0);

  if (errors.length > 0) {
    throw new Error(
      "BatchCluster was given invalid options: " + errors.join("; "),
    );
  }

  return result;
}
function escapeRegExp(s: string) {
  return toS(s).replace(/[-.,\\^$*+?()|[\]{}]/g, "\\$&");
}
function toRe(s: string | RegExp) {
  return s instanceof RegExp
    ? s
    : blank(s)
      ? /$./
      : s.includes("*")
        ? new RegExp(
            s
              .split("*")
              .map((ea) => escapeRegExp(ea))
              .join(".*"),
          )
        : new RegExp(escapeRegExp(s));
}
