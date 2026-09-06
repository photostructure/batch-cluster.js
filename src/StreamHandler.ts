import child_process from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { Logger } from "./Logger";
import { map } from "./Object";
import { blank } from "./String";
import { Task } from "./Task";

const MaxBufferedStderrLineLength = 64 * 1024;

interface StderrLineOwner {
  readonly task: Task<unknown> | undefined;
}

/**
 * Configuration for stream handling behavior
 */
export interface StreamHandlerOptions {
  readonly logger: () => Logger;
  readonly shouldIgnoreStderrLine?: ((line: string) => boolean) | undefined;
  readonly streamFlushMillis?: number | undefined;
}

/**
 * Interface for objects that can provide stream context
 */
export interface StreamContext {
  readonly name: string;
  isEnding(): boolean;
  getCurrentTask(): Task<unknown> | undefined;
  onError: (reason: string, error: Error) => void;
  end: (gracefully: boolean, reason: string) => void;
  onIdle: () => void;
}

/**
 * Handles stdout/stderr stream processing for child processes.
 * Manages stream event listeners, data routing, and error handling.
 */
export class StreamHandler {
  readonly #logger: () => Logger;
  readonly #shouldIgnoreStderrLine: ((line: string) => boolean) | undefined;
  readonly #streamFlushMillis: number;
  readonly #stderrDecoder = new StringDecoder("utf8");
  #stderrLineBuffer = "";
  #stderrLineOwner: StderrLineOwner | undefined;
  #passingLongStderrLine = false;
  #stderrLineFlushTimer: NodeJS.Timeout | undefined;
  #stderrEnded = false;

  constructor(
    options: StreamHandlerOptions,
    private readonly emitter: BatchClusterEmitter,
  ) {
    this.#logger = options.logger;
    this.#shouldIgnoreStderrLine = options.shouldIgnoreStderrLine;
    this.#streamFlushMillis = options.streamFlushMillis ?? 0;
  }

  /**
   * Set up stream event listeners for a child process
   */
  setupStreamListeners(
    proc: child_process.ChildProcess,
    context: StreamContext,
  ): void {
    const stdin = proc.stdin;
    if (stdin == null) throw new Error("Given proc had no stdin");
    stdin.on("error", (err) => context.onError("stdin.error", err));

    const stdout = proc.stdout;
    if (stdout == null) throw new Error("Given proc had no stdout");
    stdout.on("error", (err) => context.onError("stdout.error", err));
    stdout.on("data", (data: string | Buffer) => this.#onStdout(data, context));

    map(proc.stderr, (stderr) => {
      stderr.on("error", (err) => context.onError("stderr.error", err));
      stderr.on("data", (data: string | Buffer) =>
        this.#onStderr(data, context),
      );
      stderr.on("end", () => this.#endStderr(context));
      stderr.on("close", () => this.#endStderr(context));
    });
  }

  /**
   * Handle stdout data from a child process
   */
  #onStdout(data: string | Buffer, context: StreamContext): void {
    if (data == null) return;

    const task = context.getCurrentTask();
    if (task != null && task.pending) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("taskData", data, task, context as any);
      task.onStdout(data);
    } else if (context.isEnding()) {
      // don't care if we're already being shut down.
    } else if (!blank(data)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("noTaskData", data, null, context as any);
      context.end(false, "stdout.error");
    }
  }

  /**
   * Handle stderr data from a child process
   */
  #onStderr(data: string | Buffer, context: StreamContext): void {
    if (this.#shouldIgnoreStderrLine == null) {
      this.#routeStderr(data, context);
      return;
    }

    if (this.#stderrEnded) {
      this.#routeStderr(data, context);
      return;
    }

    const hadIncompleteLine = this.hasIncompleteStderrLine;
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (buf.length > 0) this.#captureStderrLineOwner(context);
    this.#consumeStderr(this.#stderrDecoder.write(buf), context);
    this.#scheduleStderrLineFlush(context);
    this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
  }

  #consumeStderr(data: string, context: StreamContext): void {
    let remaining = data;
    while (remaining.length > 0) {
      this.#captureStderrLineOwner(context);
      const newlineIndex = remaining.indexOf("\n");
      const segment =
        newlineIndex < 0 ? remaining : remaining.slice(0, newlineIndex + 1);
      remaining = newlineIndex < 0 ? "" : remaining.slice(newlineIndex + 1);

      if (this.#passingLongStderrLine) {
        this.#routeStderr(segment, context, this.#stderrLineOwner);
        if (newlineIndex >= 0) this.#finishStderrLine();
        continue;
      }

      this.#stderrLineBuffer += segment;
      if (this.#stderrLineBuffer.length > MaxBufferedStderrLineLength) {
        this.#routeStderr(
          this.#stderrLineBuffer,
          context,
          this.#stderrLineOwner,
        );
        this.#stderrLineBuffer = "";
        if (newlineIndex < 0) {
          this.#passingLongStderrLine = true;
        } else {
          this.#finishStderrLine();
        }
      } else if (newlineIndex >= 0) {
        const rawLine = this.#stderrLineBuffer;
        const owner = this.#stderrLineOwner;
        this.#stderrLineBuffer = "";
        this.#finishStderrLine();
        this.#processStderrLine(rawLine, owner, context);
      }
    }
  }

  #captureStderrLineOwner(context: StreamContext): void {
    if (this.#stderrLineOwner != null) return;
    const task = context.getCurrentTask();
    this.#stderrLineOwner = {
      task: task?.pending === true ? task : undefined,
    };
  }

  #finishStderrLine(): void {
    if (this.#stderrLineFlushTimer != null) {
      clearTimeout(this.#stderrLineFlushTimer);
      this.#stderrLineFlushTimer = undefined;
    }
    this.#stderrLineOwner = undefined;
    this.#passingLongStderrLine = false;
  }

  #scheduleStderrLineFlush(context: StreamContext): void {
    if (!this.hasIncompleteStderrLine) return;
    if (this.#stderrLineFlushTimer != null) {
      clearTimeout(this.#stderrLineFlushTimer);
    }
    this.#stderrLineFlushTimer = setTimeout(() => {
      this.#stderrLineFlushTimer = undefined;
      const hadIncompleteLine = this.hasIncompleteStderrLine;
      this.#flushStderrLine(context);
      this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
    }, this.#streamFlushMillis);
    this.#stderrLineFlushTimer.unref();
  }

  #flushStderrLine(context: StreamContext): void {
    if (!this.hasIncompleteStderrLine) return;

    this.#stderrLineBuffer += this.#stderrDecoder.end();
    if (this.#passingLongStderrLine) {
      this.#finishStderrLine();
    } else {
      const finalLine = this.#stderrLineBuffer;
      const owner = this.#stderrLineOwner;
      this.#stderrLineBuffer = "";
      this.#finishStderrLine();
      this.#processStderrLine(finalLine, owner, context);
    }
  }

  #processStderrLine(
    rawLine: string,
    owner: StderrLineOwner | undefined,
    context: StreamContext,
  ): void {
    let line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);

    try {
      if (this.#shouldIgnoreStderrLine?.(line) === true) return;
    } catch (error: unknown) {
      this.#routeStderr(rawLine, context, owner);
      context.onError(
        "stderr.error",
        new Error(
          "shouldIgnoreStderrLine threw: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }

    this.#routeStderr(rawLine, context, owner);
  }

  #endStderr(context: StreamContext): void {
    if (this.#shouldIgnoreStderrLine == null || this.#stderrEnded) return;

    const hadIncompleteLine = this.hasIncompleteStderrLine;
    this.#stderrEnded = true;
    this.#consumeStderr(this.#stderrDecoder.end(), context);
    this.#flushStderrLine(context);
    this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
  }

  #notifyIdleAfterLineCompletion(
    hadIncompleteLine: boolean,
    context: StreamContext,
  ): void {
    if (
      hadIncompleteLine &&
      !this.hasIncompleteStderrLine &&
      context.getCurrentTask() == null &&
      !context.isEnding()
    ) {
      context.onIdle();
    }
  }

  #routeStderr(
    data: string | Buffer,
    context: StreamContext,
    owner?: StderrLineOwner,
  ): void {
    if (blank(data)) return;

    this.#logger().warn(context.name + ".onStderr(): " + String(data));

    const task = owner == null ? context.getCurrentTask() : owner.task;
    if (task != null && task.pending) {
      task.onStderr(data);
    } else if (!context.isEnding()) {
      // If we're ending and there isn't a task, don't worry about it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("noTaskData", null, data, context as any);
      context.end(false, "stderr");
    }
  }

  /**
   * Process stdout data directly (for testing or manual processing)
   */
  processStdout(data: string | Buffer, context: StreamContext): void {
    this.#onStdout(data, context);
  }

  /**
   * Process stderr data directly (for testing or manual processing)
   */
  processStderr(data: string | Buffer, context: StreamContext): void {
    this.#onStderr(data, context);
  }

  /**
   * Process a buffered, unterminated stderr line (for testing or stream end).
   */
  endStderr(context: StreamContext): void {
    this.#endStderr(context);
  }

  /**
   * Resolve a partial stderr line owned by `task` before its parser runs.
   */
  flushStderrForTask(task: Task<unknown>, context: StreamContext): void {
    if (this.#stderrLineOwner?.task === task) {
      const hadIncompleteLine = this.hasIncompleteStderrLine;
      this.#flushStderrLine(context);
      this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
    }
  }

  /**
   * Whether stderr contains a partial line whose disposition is not yet known.
   */
  get hasIncompleteStderrLine(): boolean {
    return this.#stderrLineOwner != null;
  }

  /**
   * Check if data is considered blank/empty
   */
  isBlankData(data: string | Buffer | null | undefined): boolean {
    return blank(data);
  }

  /**
   * Get stream handler statistics
   */
  getStats() {
    return {
      handlerActive: true,
      emitterConnected: this.emitter != null,
    };
  }
}
