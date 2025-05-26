import child_process from "node:child_process"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import { Logger } from "./Logger"
import { map } from "./Object"
import { blank } from "./String"
import { Task } from "./Task"

/**
 * Configuration for stream handling behavior
 */
export interface StreamHandlerOptions {
  readonly logger: () => Logger
}

/**
 * Interface for objects that can provide stream context
 */
export interface StreamContext {
  readonly name: string
  isEnding(): boolean
  getCurrentTask(): Task<unknown> | undefined
  onError: (reason: string, error: Error) => void
  end: (gracefully: boolean, reason: string) => void
}

/**
 * Handles stdout/stderr stream processing for child processes.
 * Manages stream event listeners, data routing, and error handling.
 */
export class StreamHandler {
  readonly #logger: () => Logger

  constructor(
    options: StreamHandlerOptions,
    private readonly emitter: BatchClusterEmitter,
  ) {
    this.#logger = options.logger
  }

  /**
   * Set up stream event listeners for a child process
   */
  setupStreamListeners(
    proc: child_process.ChildProcess,
    context: StreamContext,
  ): void {
    const stdin = proc.stdin
    if (stdin == null) throw new Error("Given proc had no stdin")
    stdin.on("error", (err) => context.onError("stdin.error", err))

    const stdout = proc.stdout
    if (stdout == null) throw new Error("Given proc had no stdout")
    stdout.on("error", (err) => context.onError("stdout.error", err))
    stdout.on("data", (data: string | Buffer) => this.#onStdout(data, context))

    map(proc.stderr, (stderr) => {
      stderr.on("error", (err) => context.onError("stderr.error", err))
      stderr.on("data", (data: string | Buffer) =>
        this.#onStderr(data, context),
      )
    })
  }

  /**
   * Handle stdout data from a child process
   */
  #onStdout(data: string | Buffer, context: StreamContext): void {
    if (data == null) return

    const task = context.getCurrentTask()
    if (task != null && task.pending) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("taskData", data, task, context as any)
      task.onStdout(data)
    } else if (context.isEnding()) {
      // don't care if we're already being shut down.
    } else if (!blank(data)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("noTaskData", data, null, context as any)
      context.end(false, "stdout.error")
    }
  }

  /**
   * Handle stderr data from a child process
   */
  #onStderr(data: string | Buffer, context: StreamContext): void {
    if (blank(data)) return

    this.#logger().warn(context.name + ".onStderr(): " + String(data))

    const task = context.getCurrentTask()
    if (task != null && task.pending) {
      task.onStderr(data)
    } else if (!context.isEnding()) {
      // If we're ending and there isn't a task, don't worry about it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("noTaskData", null, data, context as any)
      context.end(false, "stderr")
    }
  }

  /**
   * Process stdout data directly (for testing or manual processing)
   */
  processStdout(data: string | Buffer, context: StreamContext): void {
    this.#onStdout(data, context)
  }

  /**
   * Process stderr data directly (for testing or manual processing)
   */
  processStderr(data: string | Buffer, context: StreamContext): void {
    this.#onStderr(data, context)
  }

  /**
   * Check if data is considered blank/empty
   */
  isBlankData(data: string | Buffer | null | undefined): boolean {
    return blank(data)
  }

  /**
   * Get stream handler statistics
   */
  getStats() {
    return {
      handlerActive: true,
      emitterConnected: this.emitter != null,
    }
  }
}
