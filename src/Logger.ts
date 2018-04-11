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
 * util.debuglog("batch-cluster")`, and `warn` and `error` go to `console`.
 */
export namespace ConsoleLogger {
  /**
   * Delegates to `util.debuglog("batch-cluster")`:
   * <https://nodejs.org/api/util.html#util_util_debuglog_section>
   */
  export const debug = _debuglog
  /**
   * Delegates to `util.debuglog("batch-cluster")`:
   * <https://nodejs.org/api/util.html#util_util_debuglog_section>
   */
  export const info = _debuglog
  /**
   * Delegates to `console.warn`
   */
  export const warn = console.warn
  /**
   * Delegates to `console.error`
   */
  export const error = console.error
}

/**
 * `Logger` that disables all logging.
 */
export namespace NoLogger {
  const noop = () => {}
  export const debug = noop
  export const info = noop
  export const warn = noop
  export const error = noop
}

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
