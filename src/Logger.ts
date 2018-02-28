import { debuglog } from "util"

export type Log = (message: string, ...optionalParams: any[]) => void

/**
 * Simple interface for logging. 
 *
 * Note that the default implementation delegates `debug` and `info` to
 * `util.debuglog("batch-cluster")`:
 * <https://nodejs.org/api/util.html#util_util_debuglog_section>. 
 *
 * `warn` and `error` default to `console.warn` and `console.error`,
 * respectively.
 */
export interface Logger {
  debug: Log
  info: Log
  warn: Log
  error: Log
}

const _debuglog = debuglog("batch-cluster")

namespace ConsoleLogger {
  export const debug = _debuglog
  export const info = _debuglog
  export const warn = console.warn
  export const error = console.error
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
