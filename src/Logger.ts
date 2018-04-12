import { debuglog } from "util"

export type Log = (message: string, ...optionalParams: any[]) => void

/**
 * Simple interface for logging.
 */
export interface Logger {
  debug: Log
  info: Log
  warn: Log
  error: Log
}

const _debuglog = debuglog("batch-cluster")

/**
 * Default `Logger` implementation.  `debug` and `info` go to
 * util.debuglog("batch-cluster")`. `warn` and `error` go to `console`.
 */
export const ConsoleLogger: Logger = Object.freeze({
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
const noop = () => {}

/**
 * `Logger` that disables all logging.
 */
export const NoLogger: Logger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop
})

let _logger: Logger = ConsoleLogger

export function setLogger(l: Logger) {
  if ([l.debug, l.info, l.warn, l.error].some(f => typeof f !== "function")) {
    throw new Error("invalid logger")
  }
  _logger = l
}

export function logger() {
  return _logger
}
