import { debuglog } from "util"

import { map } from "./Object"
import { notBlank } from "./String"

export type Log = (message: string, ...optionalParams: any[]) => void

/**
 * Simple interface for logging.
 */
export interface Logger {
  trace: Log
  debug: Log
  info: Log
  warn: Log
  error: Log
}

export const LogLevels: (keyof Logger)[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error"
]

const _debuglog = debuglog("batch-cluster")

const noop = () => undefined

/**
 * Default `Logger` implementation.  `debug` and `info` go to
 * util.debuglog("batch-cluster")`. `warn` and `error` go to `console.warn` and
 * `console.error`.
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
  warn: console.warn,
  /**
   * Delegates to `console.error`
   */
  error: console.error
})

/**
 * `Logger` that disables all logging.
 */
export const NoLogger: Logger = Object.freeze({
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
})

let _logger: Logger = NoLogger

export function setLogger(l: Logger) {
  if (LogLevels.some(ea => typeof l[ea] !== "function")) {
    throw new Error("invalid logger, must implement " + LogLevels)
  }
  _logger = l
}

export function logger() {
  return _logger
}

export const Logger = {
  withLevels: (delegate: Logger) => {
    const timestamped: any = {}
    LogLevels.forEach(ea => {
      const prefix = (ea + " ").substring(0, 5) + " | "
      timestamped[ea] = (message?: any, ...optionalParams: any[]) => {
        if (notBlank(message)) {
          delegate[ea](prefix + message, ...optionalParams)
        }
      }
    })
    return timestamped
  },

  withTimestamps: (delegate: Logger) => {
    const timestamped: any = {}
    LogLevels.forEach(
      level =>
        (timestamped[level] = (message?: any, ...optionalParams: any[]) =>
          map(message, ea =>
            delegate[level](
              new Date().toISOString() + " | " + ea,
              ...optionalParams
            )
          ))
    )
    return timestamped
  },

  filterLevels: (l: Logger, minLogLevel: keyof Logger) => {
    const minLogLevelIndex = LogLevels.indexOf(minLogLevel)
    const filtered: any = {}
    LogLevels.forEach(
      (ea, idx) =>
        (filtered[ea] = idx < minLogLevelIndex ? noop : l[ea].bind(l))
    )
    return filtered
  }
}
