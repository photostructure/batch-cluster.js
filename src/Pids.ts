import child_process from "node:child_process"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { asError } from "./Error"
import { isWin } from "./Platform"

/**
 * @param {number} pid process id. Required.
 * @returns boolean true if the given process id is in the local process
 * table. The PID may be paused or a zombie, though.
 */
export function pidExists(pid: number | undefined): boolean {
  if (pid == null || !isFinite(pid) || pid <= 0) return false
  try {
    // signal 0 can be used to test for the existence of a process
    // see https://nodejs.org/dist/latest-v18.x/docs/api/process.html#processkillpid-signal
    return process.kill(pid, 0)
  } catch (err: unknown) {
    // We're expecting err.code to be either "EPERM" (if we don't have
    // permission to send `pid` and message), or "ESRCH" if that pid doesn't
    // exist. EPERM means it _does_ exist!
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true

    // failed to get priority--assume the pid is gone.
    return false
  }
}

/**
 * Send a signal to the given process id.
 *
 * @param pid the process id. Required.
 * @param force if true, and the current user has
 * permissions to send the signal, the pid will be forced to shut down. Defaults to false.
 */
export function kill(pid: number | undefined, force = false): boolean {
  if (pid == null || !isFinite(pid) || pid <= 0) return false
  try {
    return process.kill(pid, force ? "SIGKILL" : undefined)
  } catch (err) {
    if (!String(err).includes("ESRCH")) throw err
    return false
    // failed to get priority--assume the pid is gone.
  }
}

/**
 * Only used by tests
 *
 * @returns {Promise<number[]>} all the Process IDs in the process table.
 */
export async function pids(): Promise<number[]> {
  // Linux‐style: read /proc
  if (!isWin && existsSync("/proc")) {
    const names = await readdir("/proc")
    return names.filter((d) => /^\d+$/.test(d)).map((d) => parseInt(d, 10))
  }

  // fallback: ps or tasklist
  const cmd = isWin ? "tasklist" : "ps"
  const args = isWin ? ["/NH", "/FO", "CSV"] : ["-e", "-o", "pid="]

  return new Promise<number[]>((resolve, reject) => {
    child_process.execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(asError(err))
      if (stderr.trim()) return reject(new Error(stderr))

      const pids = stdout
        .trim()
        .split(/[\r\n]+/)
        .map((line) => {
          if (isWin) {
            // "Image","PID",…
            // split on "," and strip outer quotes:
            const cols = line.split('","')
            const pidStr = cols[1]?.replace(/"/g, "")
            return Number(pidStr)
          }
          // ps -o pid= gives you just the number
          return Number(line.trim())
        })
        .filter((n) => Number.isFinite(n) && n > 0)

      resolve(pids)
    })
  })
}
