import { notBlank } from "./String";

/**
 * Parser implementations convert stdout and stderr from the underlying child
 * process to a more useable format. This can be a no-op passthrough if no
 * parsing is necessary.
 */
/**
 * Invoked once per task.
 *
 * @param stdout the concatenated stream from `stdin`, stripped of the `PASS`
 * or `FAIL` tokens from `BatchProcessOptions`.
 *
 * @param stderr if defined, includes all text emitted to stderr.
 *
 * @param passed `true` iff the `PASS` pattern was found in stdout.
 *
 * @throws an error if the Parser implementation wants to reject the task. It
 * is valid to raise Errors if stderr is undefined.
 *
 * @see BatchProcessOptions
 */
export type Parser<T> = (
  stdout: string,
  stderr: string | undefined,
  passed: boolean,
) => T | Promise<T>;

export const SimpleParser: Parser<string> = (
  stdout: string,
  stderr: string | undefined,
  passed: boolean,
) => {
  if (!passed) throw new Error("task failed");
  if (notBlank(stderr)) throw new Error(stderr);
  return stdout;
};
