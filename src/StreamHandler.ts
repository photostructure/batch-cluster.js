import child_process from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { BatchClusterEmitter } from "./BatchClusterEmitter";
import { BatchProcessOptions } from "./BatchProcessOptions";
import { Logger } from "./Logger";
import { map } from "./Object";
import { blank } from "./String";
import { Task } from "./Task";

const MaxBufferedLineLength = 64 * 1024;

interface LineOwner {
  readonly task: Task<unknown> | undefined;
}

/**
 * Configuration for stream handling behavior
 */
export interface StreamHandlerOptions {
  readonly logger: () => Logger;
  readonly shouldIgnoreStderrLine?: ((line: string) => boolean) | undefined;
  readonly isRetirementRequest?: BatchProcessOptions["isRetirementRequest"];
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
  end: (gracefully: boolean, reason: string) => void | Promise<void>;
  onIdle: () => void;
  requestRetirement: () => void;
}

/**
 * Handles stdout/stderr stream processing for child processes.
 * Manages stream event listeners, data routing, and error handling.
 */
export class StreamHandler {
  readonly #logger: () => Logger;
  readonly #shouldIgnoreStderrLine: ((line: string) => boolean) | undefined;
  readonly #isRetirementRequest: BatchProcessOptions["isRetirementRequest"];
  readonly #streamFlushMillis: number;
  readonly #stdoutDecoder = new StringDecoder("utf8");
  #stdoutLineBuffer = "";
  #stdoutLineOwner: LineOwner | undefined;
  #passingLongStdoutLine = false;
  #stdoutRetirementLineFlushed = false;
  #stdoutLineFlushTimer: NodeJS.Timeout | undefined;
  #stdoutEnded = false;
  readonly #stderrDecoder = new StringDecoder("utf8");
  #stderrLineBuffer = "";
  #stderrLineOwner: LineOwner | undefined;
  #passingLongStderrLine = false;
  #stderrRetirementLineFlushed = false;
  #stderrLineFlushTimer: NodeJS.Timeout | undefined;
  #stderrEnded = false;

  constructor(
    options: StreamHandlerOptions,
    private readonly emitter: BatchClusterEmitter,
  ) {
    this.#logger = options.logger;
    this.#shouldIgnoreStderrLine = options.shouldIgnoreStderrLine;
    this.#isRetirementRequest = options.isRetirementRequest;
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
    stdout.on("end", () => this.#endStdout(context));
    stdout.on("close", () => this.#endStdout(context));

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
    if (this.#isRetirementRequest == null || this.#stdoutEnded) {
      this.#routeStdout(data, context);
      return;
    }

    const hadIncompleteLine = this.hasIncompleteOutputLine;
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (buf.length > 0) this.#captureStdoutLineOwner(context);
    this.#consumeStdout(this.#stdoutDecoder.write(buf), context);
    // The decoder may retain the first bytes of a code point immediately
    // after a newline, leaving no decoded fragment for #consumeStdout to own.
    if (buf.length > 0 && buf[buf.length - 1] !== 10) {
      this.#captureStdoutLineOwner(context);
    }
    this.#scheduleStdoutLineFlush(context);
    this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
  }

  #captureStdoutLineOwner(context: StreamContext): void {
    if (this.#stdoutLineOwner != null) return;
    const task = context.getCurrentTask();
    this.#stdoutLineOwner = {
      task: task?.pending === true ? task : undefined,
    };
  }

  #consumeStdout(data: string, context: StreamContext): void {
    let remaining = data;
    while (remaining.length > 0) {
      this.#captureStdoutLineOwner(context);
      const newlineIndex = remaining.indexOf("\n");
      const segment =
        newlineIndex < 0 ? remaining : remaining.slice(0, newlineIndex + 1);
      remaining = newlineIndex < 0 ? "" : remaining.slice(newlineIndex + 1);

      const owner = this.#stdoutLineOwner;
      if (this.#passingLongStdoutLine) {
        if (newlineIndex >= 0) this.#finishStdoutLine();
        this.#routeStdout(segment, context, owner);
        continue;
      }

      this.#stdoutLineBuffer += segment;
      if (this.#stdoutLineBuffer.length > MaxBufferedLineLength) {
        const rawLine = this.#stdoutLineBuffer;
        this.#stdoutLineBuffer = "";
        if (newlineIndex >= 0) {
          this.#finishStdoutLine();
        } else {
          this.#passingLongStdoutLine = true;
        }
        this.#routeStdout(rawLine, context, owner);
      } else if (newlineIndex >= 0) {
        const rawLine = this.#stdoutLineBuffer;
        const alreadyFlushed = this.#stdoutRetirementLineFlushed;
        this.#stdoutLineBuffer = "";
        this.#finishStdoutLine();
        if (
          alreadyFlushed ||
          !this.#consumeRetirementRequest(rawLine, "stdout", context)
        ) {
          this.#routeStdout(rawLine, context, owner);
        }
      }
    }
  }

  #finishStdoutLine(): void {
    if (this.#stdoutLineFlushTimer != null) {
      clearTimeout(this.#stdoutLineFlushTimer);
      this.#stdoutLineFlushTimer = undefined;
    }
    this.#stdoutLineOwner = undefined;
    this.#passingLongStdoutLine = false;
    this.#stdoutRetirementLineFlushed = false;
  }

  #scheduleStdoutLineFlush(context: StreamContext): void {
    if (
      this.#stdoutLineOwner == null ||
      this.#stdoutLineOwner.task?.pending === true ||
      context.isEnding()
    )
      return;
    if (this.#stdoutLineFlushTimer != null)
      clearTimeout(this.#stdoutLineFlushTimer);
    this.#stdoutLineFlushTimer = setTimeout(() => {
      this.#stdoutLineFlushTimer = undefined;
      const hadIncompleteLine = this.hasIncompleteOutputLine;
      this.#flushStdoutLine(context);
      this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
    }, this.#streamFlushMillis);
    this.#stdoutLineFlushTimer.unref();
  }

  #endStdout(context: StreamContext): void {
    if (this.#isRetirementRequest == null || this.#stdoutEnded) return;
    const hadIncompleteLine = this.hasIncompleteOutputLine;
    this.#stdoutEnded = true;
    this.#consumeStdout(this.#stdoutDecoder.end(), context);
    this.#flushStdoutLine(context);
    this.#notifyIdleAfterLineCompletion(hadIncompleteLine, context);
  }

  #flushStdoutLine(context: StreamContext): void {
    if (this.#stdoutLineOwner == null) return;
    this.#stdoutLineBuffer += this.#stdoutDecoder.end();
    const fragment = this.#stdoutLineBuffer;
    const owner = this.#stdoutLineOwner;
    this.#stdoutLineBuffer = "";
    this.#finishStdoutLine();
    this.#stdoutRetirementLineFlushed = true;
    // Flushed fragments are output, not newline-terminated control messages.
    if (fragment.length > 0) this.#routeStdout(fragment, context, owner);
  }

  #routeStdout(
    data: string | Buffer,
    context: StreamContext,
    owner?: LineOwner,
  ): void {
    const task = owner == null ? context.getCurrentTask() : owner.task;
    if (task != null && task.pending) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("taskData", data, task, context as any);
      task.onStdout(data);
    } else if (context.isEnding()) {
      // don't care if we're already being shut down.
    } else if (!blank(data)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      this.emitter.emit("noTaskData", data, null, context as any);
      void context.end(false, "stdout.error");
    }
  }

  /**
   * Handle stderr data from a child process
   */
  #onStderr(data: string | Buffer, context: StreamContext): void {
    if (
      this.#shouldIgnoreStderrLine == null &&
      this.#isRetirementRequest == null
    ) {
      this.#routeStderr(data, context);
      return;
    }

    if (this.#stderrEnded) {
      this.#routeStderr(data, context);
      return;
    }

    const hadIncompleteLine = this.hasIncompleteOutputLine;
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    if (buf.length > 0) this.#captureStderrLineOwner(context);
    this.#consumeStderr(this.#stderrDecoder.write(buf), context);
    if (buf.length > 0 && buf[buf.length - 1] !== 10) {
      this.#captureStderrLineOwner(context);
    }
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
        if (newlineIndex >= 0) {
          this.#finishStderrLine();
          this.#stderrRetirementLineFlushed = false;
        }
        continue;
      }

      this.#stderrLineBuffer += segment;
      if (this.#stderrLineBuffer.length > MaxBufferedLineLength) {
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
          this.#stderrRetirementLineFlushed = false;
        }
      } else if (newlineIndex >= 0) {
        const rawLine = this.#stderrLineBuffer;
        const owner = this.#stderrLineOwner;
        this.#stderrLineBuffer = "";
        this.#finishStderrLine();
        this.#processStderrLine(rawLine, owner, context);
        this.#stderrRetirementLineFlushed = false;
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
    // Keep split retirement markers intact while their task is pending.
    // Orphan fragments must still reach ordinary stray-output handling.
    if (
      this.#isRetirementRequest != null &&
      (this.#stderrLineOwner?.task?.pending === true || context.isEnding())
    )
      return;
    if (!this.hasIncompleteStderrLine) return;
    if (this.#stderrLineFlushTimer != null) {
      clearTimeout(this.#stderrLineFlushTimer);
    }
    this.#stderrLineFlushTimer = setTimeout(() => {
      this.#stderrLineFlushTimer = undefined;
      const hadIncompleteLine = this.hasIncompleteOutputLine;
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
    // Flushing a fragment for task parsing doesn't create a physical newline.
    // Its later suffix cannot independently become a retirement control line.
    if (this.#isRetirementRequest != null)
      this.#stderrRetirementLineFlushed = true;
  }

  #processStderrLine(
    rawLine: string,
    owner: LineOwner | undefined,
    context: StreamContext,
  ): void {
    if (
      !this.#stderrRetirementLineFlushed &&
      this.#consumeRetirementRequest(rawLine, "stderr", context)
    )
      return;
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
    if (
      (this.#shouldIgnoreStderrLine == null &&
        this.#isRetirementRequest == null) ||
      this.#stderrEnded
    )
      return;

    const hadIncompleteLine = this.hasIncompleteOutputLine;
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
      !this.hasIncompleteOutputLine &&
      context.getCurrentTask() == null &&
      !context.isEnding()
    ) {
      context.onIdle();
    }
  }

  #routeStderr(
    data: string | Buffer,
    context: StreamContext,
    owner?: LineOwner,
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
      void context.end(false, "stderr");
    }
  }

  /** Consume recognized control lines before any ordinary output handling. */
  #consumeRetirementRequest(
    rawLine: string,
    stream: "stdout" | "stderr",
    context: StreamContext,
  ): boolean {
    if (this.#isRetirementRequest == null || !rawLine.endsWith("\n"))
      return false;
    let line = rawLine.slice(0, -1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    let retire: boolean;
    try {
      retire = this.#isRetirementRequest(line, stream);
    } catch (error: unknown) {
      // Report the error before routing any completion token: a broken
      // recognizer must not accidentally resolve the task or release a worker.
      context.onError(
        `${stream}.error`,
        new Error(
          "isRetirementRequest threw: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
      return true;
    }
    if (retire === true) {
      context.requestRetirement();
      return true;
    }
    return false;
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

  /** Flush stdout at stream end (also available for tests). */
  endStdout(context: StreamContext): void {
    this.#endStdout(context);
  }

  /** Flush received fragments owned by this task before invoking its parser. */
  flushOutputForTask(task: Task<unknown>, context: StreamContext): void {
    if (this.#stdoutLineOwner?.task === task) this.#flushStdoutLine(context);
    this.flushStderrForTask(task, context);
  }

  /** Start bounded flushing for fragments left behind by a settled task. */
  onTaskSettled(context: StreamContext): void {
    if (this.#isRetirementRequest == null) return;
    this.#scheduleStdoutLineFlush(context);
    this.#scheduleStderrLineFlush(context);
  }

  /**
   * Resolve a partial stderr line owned by `task` before its parser runs.
   */
  flushStderrForTask(task: Task<unknown>, context: StreamContext): void {
    if (this.#stderrLineOwner?.task === task) {
      const hadIncompleteLine = this.hasIncompleteOutputLine;
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

  /** Partial output must not be attributed to a subsequently assigned task. */
  get hasIncompleteOutputLine(): boolean {
    return this.#stdoutLineOwner != null || this.hasIncompleteStderrLine;
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
