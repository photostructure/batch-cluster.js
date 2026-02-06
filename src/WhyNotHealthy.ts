/**
 * Reasons why a BatchProcess might not be healthy
 */
export type WhyNotHealthy =
  | "broken"
  | "closed"
  | "ending"
  | "ended"
  | "idle"
  | "old"
  | "proc.close"
  | "proc.disconnect"
  | "proc.error"
  | "proc.exit"
  | "stderr.error"
  | "stderr"
  | "stdin.error"
  | "stdout.error"
  | "timeout"
  | "tooMany" // < only sent by BatchCluster when maxProcs is reduced
  | "startError"
  | "unhealthy"
  | "worn";

export type WhyNotReady = WhyNotHealthy | "busy";

/**
 * Reasons that indicate expected/managed terminations initiated by BatchCluster
 * (as opposed to unexpected exits like crashes, errors, or timeouts).
 *
 * These correspond to proactive process lifecycle management:
 * - "ending": Cluster is shutting down
 * - "ended": Process already shut down
 * - "idle": Process was idle too long (maxIdleMsPerProcess)
 * - "old": Process ran too long (maxProcAgeMillis)
 * - "worn": Process handled too many tasks (maxTasksPerProcess)
 * - "tooMany": maxProcs was reduced
 */
export const ExpectedTerminationReasons: readonly WhyNotHealthy[] = [
  "ending",
  "ended",
  "idle",
  "old",
  "worn",
  "tooMany",
] as const;
