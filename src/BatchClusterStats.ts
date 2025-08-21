import { ChildEndReason } from "./BatchClusterEmitter";

export interface BatchClusterStats {
  pendingTaskCount: number;
  currentProcCount: number;
  readyProcCount: number;
  maxProcCount: number;
  internalErrorCount: number;
  startErrorRatePerMinute: number;
  msBeforeNextSpawn: number;
  spawnedProcCount: number;
  childEndCounts: Record<NonNullable<ChildEndReason>, number>;
  ending: boolean;
  ended: boolean;
  [key: string]: unknown;
}
