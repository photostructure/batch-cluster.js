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
