import { BatchProcess, WhyNotHealthy } from "./BatchProcess"
import { Task } from "./Task"

type Args<T> = T extends (...args: infer A) => void ? A : never

export type ChildEndReason = WhyNotHealthy | "tooMany"

// Type-safe EventEmitter! Note that this interface is not comprehensive:
// EventEmitter has a bunch of other methods, but batch-cluster doesn't use
// them, so I didn't bother to type them here.
export interface TypedEventEmitter<T> {
  once<E extends keyof T>(
    eventName: E,
    listener: (...args: Args<T[E]>) => void,
  ): this
  on<E extends keyof T>(
    eventName: E,
    listener: (...args: Args<T[E]>) => void,
  ): this
  off<E extends keyof T>(
    eventName: E,
    listener: (...args: Args<T[E]>) => void,
  ): this
  emit<E extends keyof T>(eventName: E, ...args: Args<T[E]>): boolean

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  listeners<E extends keyof T>(event: E): Function[]

  removeAllListeners(eventName?: keyof T): this
}

/**
 * This interface describes the BatchCluster's event names as fields. The type
 * of the field describes the event data payload.
 *
 * See {@link BatchClusterEmitter} for more details.
 */
export interface BatchClusterEvents {
  /**
   * Emitted when a child process has started
   */
  childStart: (childProcess: BatchProcess) => void

  /**
   * Emitted when a child process has ended
   */
  childEnd: (childProcess: BatchProcess, reason: ChildEndReason) => void

  /**
   * Emitted when a child process fails to spin up and run the {@link BatchProcessOptions.versionCommand} successfully within {@link BatchClusterOptions.spawnTimeoutMillis}.
   *
   * @param childProcess will be undefined if the error is from {@link ChildProcessFactory.processFactory}
   */
  startError: (error: Error, childProcess?: BatchProcess) => void

  /**
   * Emitted when an internal consistency check fails
   */
  internalError: (error: Error) => void

  /**
   * Emitted when `.end()` is called because the error rate has exceeded
   * {@link BatchClusterOptions.maxReasonableProcessFailuresPerMinute}
   */
  fatalError: (error: Error) => void

  /**
   * Emitted when tasks receive data, which may be partial chunks from the task
   * stream.
   */
  taskData: (
    data: Buffer | string,
    task: Task<unknown> | undefined,
    proc: BatchProcess,
  ) => void

  /**
   * Emitted when a task has been resolved
   */
  taskResolved: (task: Task<unknown>, proc: BatchProcess) => void

  /**
   * Emitted when a task times out. Note that a `taskError` event always succeeds these events.
   */
  taskTimeout: (
    timeoutMs: number,
    task: Task<unknown>,
    proc: BatchProcess,
  ) => void

  /**
   * Emitted when a task has an error
   */
  taskError: (error: Error, task: Task<unknown>, proc: BatchProcess) => void

  /**
   * Emitted when child processes write to stdout or stderr without a current
   * task
   */
  noTaskData: (
    stdoutData: string | Buffer | null,
    stderrData: string | Buffer | null,
    proc: BatchProcess,
  ) => void

  /**
   * Emitted when a process fails health checks
   */
  healthCheckError: (error: Error, proc: BatchProcess) => void

  /**
   * Emitted when a child process has an error during shutdown
   */
  endError: (error: Error, proc?: BatchProcess) => void

  /**
   * Emitted when this instance is in the process of ending.
   */
  beforeEnd: () => void

  /**
   * Emitted when this instance has ended. No child processes should remain at
   * this point.
   */
  end: () => void
}

/**
 * The BatchClusterEmitter signature is built up automatically by the
 * {@link BatchClusterEvents} interface, which ensures `.on`, `.off`, and
 * `.emit` signatures are all consistent, and include the correct data payloads
 * for all of BatchCluster's events.
 *
 * This approach has some benefits:
 *
 * - it ensures that on(), off(), and emit() signatures are all consistent,
 * - supports editor autocomplete, and
 * - offers strong typing,
 *
 * but has one drawback:
 *
 * - jsdocs don't list all signatures directly: you have to visit the event
 *   source interface.
 *
 * See {@link BatchClusterEvents} for a the list of events and their payload
 * signatures
 */
export type BatchClusterEmitter = TypedEventEmitter<BatchClusterEvents>
