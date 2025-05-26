import child_process from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { isWin } from "./Platform"

/**
 * Error thrown when procps is missing on non-Windows systems
 */
export class ProcpsMissingError extends Error {
  readonly originalError?: Error

  constructor(originalError?: Error) {
    const message = isWin
      ? "tasklist command not available"
      : "ps command not available. Please install procps package (e.g., 'apt-get install procps' on Ubuntu/Debian)"

    super(message)
    this.name = "ProcpsMissingError"

    if (originalError != null) {
      this.originalError = originalError
    }
  }
}

/**
 * Check if the required process listing command is available
 * @throws {ProcpsMissingError} if the command is not available
 */
export function validateProcpsAvailable(): void {
  // on POSIX systems with a working /proc we can skip ps entirely
  if (!isWin && existsSync("/proc")) {
    const entries = readdirSync("/proc")
    // if we see at least one numeric directory, assume /proc is usable
    if (entries.some((d) => /^\d+$/.test(d))) {
      return
    }
    // fall through to check `ps` if /proc is empty or unusable
  }

  try {
    const command = isWin ? "tasklist" : "ps"
    const args = isWin ? ["/NH", "/FO", "CSV", "/FI", "PID eq 1"] : ["-p", "1"]
    const timeout = isWin ? 15_000 : 5_000 // 15s for Windows, 5s elsewhere

    child_process.execFileSync(command, args, {
      stdio: "pipe",
      timeout,
    })
  } catch (err) {
    throw new ProcpsMissingError(err instanceof Error ? err : undefined)
  }
}
