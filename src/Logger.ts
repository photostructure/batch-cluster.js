import util from "node:util";
import { map } from "./Object";
import { notBlank } from "./String";

export type LoggerFunction = (
  message: string,
  ...optionalParams: unknown[]
) => void;

/**
 * Simple interface for logging.
 */
export interface Logger {
  trace: LoggerFunction;
  debug: LoggerFunction;
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
}

export const LogLevels: (keyof Logger)[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
];

const _debuglog = util.debuglog("batch-cluster");

const noop = () => undefined;

/**
 * Default `Logger` implementation.
 *
 * - `debug` and `info` go to `util.debuglog("batch-cluster")`.
 *
 * - `warn` and `error` go to `console.warn` and `console.error`.
 *
 * @see https://nodejs.org/api/util.html#util_util_debuglog_section
 * @see https://nodejs.org/api/console.html
 */
export const ConsoleLogger: Logger = Object.freeze({
  /**
   * No-ops by default, as this is very low-level information.
   */
  trace: noop,

  /**
   * Delegates to `util.debuglog("batch-cluster")`:
   * <https://nodejs.org/api/util.html#util_util_debuglog_section>
   */
  debug: _debuglog,
  /**
   * Delegates to `util.debuglog("batch-cluster")`:
   * <https://nodejs.org/api/util.html#util_util_debuglog_section>
   */
  info: _debuglog,
  /**
   * Delegates to `console.warn`
   */
  warn: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.warn(...args);
  },
  /**
   * Delegates to `console.error`
   */
  error: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.error(...args);
  },
});

/**
 * `Logger` that disables all logging.
 */
export const NoLogger: Logger = Object.freeze({
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
});

let _logger: Logger = _debuglog.enabled ? ConsoleLogger : NoLogger;

export function setLogger(l: Logger): void {
  if (LogLevels.some((ea) => typeof l[ea] !== "function")) {
    throw new Error("invalid logger, must implement " + LogLevels.join(", "));
  }
  _logger = l;
}

export function logger(): Logger {
  return _logger;
}

export const Log = {
  withLevels: (delegate: Logger): Logger => {
    const timestamped: Logger = {} as Logger;
    LogLevels.forEach((ea) => {
      const prefix = (ea + " ").substring(0, 5) + " | ";
      timestamped[ea] = (message?: unknown, ...optionalParams: unknown[]) => {
        if (notBlank(String(message))) {
          delegate[ea](prefix + String(message), ...optionalParams);
        }
      };
    });
    return timestamped;
  },

  withTimestamps: (delegate: Logger) => {
    const timestamped: Logger = {} as Logger;
    LogLevels.forEach(
      (level) =>
        (timestamped[level] = (
          message?: unknown,
          ...optionalParams: unknown[]
        ) =>
          map(message, (ea) =>
            delegate[level](
              new Date().toISOString() + " | " + String(ea),
              ...optionalParams,
            ),
          )),
    );
    return timestamped;
  },

  filterLevels: (l: Logger, minLogLevel: keyof Logger) => {
    const minLogLevelIndex = LogLevels.indexOf(minLogLevel);
    const filtered: Logger = {} as Logger;
    LogLevels.forEach(
      (ea, idx) =>
        (filtered[ea] = idx < minLogLevelIndex ? noop : l[ea].bind(l)),
    );
    return filtered;
  },
};
