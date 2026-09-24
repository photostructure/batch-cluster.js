import { delay } from "./Async";
import { Deferred } from "./Deferred";
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
import { Parser } from "./Parser";
import { blank } from "./String";

export type TaskOptions = Pick<
  InternalBatchProcessOptions,
  "streamFlushMillis" | "observer" | "passRE" | "failRE" | "logger"
>;

let _taskId = 1;

/**
 * Tasks embody individual jobs given to the underlying child processes. Each
 * instance has a promise that will be resolved or rejected based on the
 * result of the task.
 */
export class Task<T = unknown> {
  readonly taskId = _taskId++;
  #opts?: TaskOptions;
  #startedAt?: number;
  #lastTimeoutResetAt?: number;
  #resetTimeout: (() => boolean) | undefined;
  #parsing = false;
  #sawFailureToken = false;
  #settledAt?: number;
  readonly #d = new Deferred<T>();
  #stdout = "";
  #stderr = "";
  #beforeParse: (() => void) | undefined;

  /**
   * @param {string} command is the value written to stdin to perform the given
   * task.
   * @param {Parser<T>} parser is used to parse resulting data from the
   * underlying process to a typed object.
   */
  constructor(
    readonly command: string,
    readonly parser: Parser<T>,
  ) {
    // We can't use .finally here, because that creates a promise chain that, if
    // rejected, results in an uncaught rejection.
    this.#d.promise.then(
      () => this.#onSettle(),
      () => this.#onSettle(),
    );
  }

  /**
   * @return the resolution or rejection of this task.
   */
  get promise(): Promise<T> {
    return this.#d.promise;
  }

  get pending(): boolean {
    return this.#d.pending;
  }

  get state(): string {
    return this.#d.pending
      ? "pending"
      : this.#d.rejected
        ? "rejected"
        : "resolved";
  }

  /**
   * Called by BatchProcess when this task starts. Overrides must pass every
   * argument to `super.onStart()`, or {@link Task.resetTimeout} stops working.
   */
  onStart(
    opts: TaskOptions,
    beforeParse?: () => void,
    resetTimeout?: () => boolean,
  ) {
    this.#opts = opts;
    this.#beforeParse = beforeParse;
    this.#startedAt = Date.now();
    this.#resetTimeout = resetTimeout;
  }

  /**
   * Restart this task's timeout. Call this only after verifying that the task
   * made progress: output alone is not progress.
   *
   * @return false if the task isn't running or has no timeout, and for
   * startup and health-check tasks.
   */
  resetTimeout(): boolean {
    if (!this.pending || this.#resetTimeout?.() !== true) return false;
    this.#lastTimeoutResetAt = Date.now();
    return true;
  }

  /** Time since this task started, or since its last timeout reset. */
  get timeoutElapsedMs(): number | undefined {
    const since = this.#lastTimeoutResetAt ?? this.#startedAt;
    return since == null ? undefined : (this.#settledAt ?? Date.now()) - since;
  }

  get runtimeMs() {
    return this.#startedAt == null
      ? undefined
      : (this.#settledAt ?? Date.now()) - this.#startedAt;
  }

  toString(): string {
    return (
      this.constructor.name +
      "(" +
      this.command.replace(/\s+/gm, " ").slice(0, 80).trim() +
      ")#" +
      this.taskId
    );
  }

  onStdout(buf: string | Buffer): void {
    this.#stdout += buf.toString();
    const passRE = this.#opts?.passRE;
    if (passRE != null && passRE.exec(this.#stdout) != null) {
      // remove the pass token from stdout:
      this.#stdout = this.#stdout.replace(passRE, "");
      void this.#resolve(true);
    } else {
      const failRE = this.#opts?.failRE;
      if (failRE != null && failRE.exec(this.#stdout) != null) {
        // remove the fail token from stdout:
        this.#stdout = this.#stdout.replace(failRE, "");
        void this.#resolve(false);
      }
    }
  }

  /**
   * Called with this task's stderr. Non-blank stderr is logged at warn, so a
   * subclass that removes lines it understands before calling
   * `super.onStderr()` keeps those lines out of the log.
   */
  onStderr(buf: string | Buffer): void {
    const s = buf.toString();
    if (!blank(s)) {
      this.#opts?.logger().warn(this.toString() + ".onStderr(): " + s);
    }
    this.#stderr += s;
    const failRE = this.#opts?.failRE;
    if (failRE != null && failRE.exec(this.#stderr) != null) {
      // remove the fail token from stderr:
      this.#stderr = this.#stderr.replace(failRE, "");
      void this.#resolve(false);
    }
  }

  #onSettle() {
    this.#settledAt ??= Date.now();
    this.#resetTimeout = undefined;
  }

  /**
   * @return true if the wrapped promise was rejected
   */
  reject(error: Error): boolean {
    return this.#d.reject(error);
  }

  async #resolve(passed: boolean) {
    // Record failures even when another resolution owns parsing. The
    // beforeParse flush can deliver a failure token through a reentrant call.
    this.#sawFailureToken ||= !passed;

    // Wait for the *other* stream to flush.
    const flushMs = this.#opts?.streamFlushMillis ?? 0;
    if (flushMs > 0) {
      await delay(flushMs);
    }

    // we're expecting this method may be called concurrently (if there are both
    // pass and fail tokens found in stderr and stdout), but we only want to run
    // this once, so
    if (!this.pending || this.#parsing) return;

    // this.#opts
    // ?.logger()
    // .trace("Task.#resolve()", { command: this.command, state: this.state })

    // Prevent concurrent parsing:
    this.#parsing = true;

    try {
      this.#beforeParse?.();
      if (!this.pending) return;
      const parseResult = await this.parser(
        this.#stdout,
        this.#stderr,
        passed && !this.#sawFailureToken,
      );
      // Deferred.resolve() returns false if already settled (e.g., external
      // reject during parsing). This is expected behavior, not an error.
      this.#d.resolve(parseResult);
    } catch (error: unknown) {
      this.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
