import child_process from "node:child_process"
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
  try {
    const command = isWin ? "tasklist" : "ps"
    const args = isWin ? ["/NH", "/FO", "CSV", "/FI", "PID eq 1"] : ["-p", "1"]

    // Synchronous check during startup - we want to fail fast
    child_process.execFileSync(command, args, {
      stdio: "pipe",
      timeout: 5000, // 5 second timeout
    })
  } catch (error) {
    throw new ProcpsMissingError(error instanceof Error ? error : undefined)
  }
}
