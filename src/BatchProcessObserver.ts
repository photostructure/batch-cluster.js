import { Task } from "./Task"

/**
 * This interface decouples BatchProcess from BatchCluster.
 */
export interface BatchProcessObserver {
  onIdle(): void
  onTaskData(data: Buffer | string, task: Task<any> | undefined): void
  onTaskError(error: Error, task: Task<any>): void
  onStartError(error: Error): void
  onInternalError(error: Error): void
}
