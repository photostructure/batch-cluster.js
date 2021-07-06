import { ChildProcess } from "child_process"
import { EventEmitter } from "events"
import { Task } from "./Task"

export class BatchClusterEmitter {
  readonly emitter = new EventEmitter()

  /**
   * Emitted when a child process has started
   */
  on(event: "childStart", listener: (childProcess: ChildProcess) => void): void

  /**
   * Emitted when a child process has exitted
   */
  on(event: "childExit", listener: (childProcess: ChildProcess) => void): void

  /**
   * Emitted when a child process has an error when spawning
   */
  on(event: "startError", listener: (err: Error) => void): void

  /**
   * Emitted when an internal consistency check fails
   */
  on(event: "internalError", listener: (err: Error) => void): void

  /**
   * Emitted when tasks receive data, which may be partial chunks from the task
   * stream.
   */
  on(
    event: "taskData",
    listener: (data: Buffer | string, task: Task | undefined) => void
  ): void

  /**
   * Emitted when a task has an error
   */
  on(event: "taskError", listener: (err: Error, task: Task) => void): void

  /**
   * Emitted when a child process has an error during shutdown
   */
  on(event: "endError", listener: (err: Error) => void): void

  /**
   * Emitted when this instance is in the process of ending.
   */
  on(event: "beforeEnd", listener: () => void): void

  /**
   * Emitted when this instance has ended. No child processes should remain at
   * this point.
   */
  on(event: "end", listener: () => void): void

  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener)
  }
}
