import * as _cp from "child_process"
import { platform } from "os"
import * as _p from "process"

export const isWin = platform().startsWith("win")

/**
 * @export
 * @param {number} pid process id. Required.
 * @returns {boolean} true if the given process id is in the local process
 * table.
 */
export function running(pid: number): Promise<boolean> {
  return isWin ? runningWin(pid) : runningPosix(pid)
}

/*
>tasklist /FI "PID eq 8204"

Image Name                     PID Session Name        Session#    Mem Usage
========================= ======== ================ =========== ============
bash.exe                      8204 Console                    1     10,260 K

>tasklist /FI "PID eq 8204"
INFO: No tasks are running which match the specified criteria.
*/

function int(i: any) {
  return String(parseInt(i))
}

function lines(s: string) {
  return String(s)
    .trim()
    .split("\n").length
}

export function runningWin(pid: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    _cp.execFile(
      "tasklist",
      ["/FI", "PID eq " + int(pid)], // < sanitize pid
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error)
        const l = lines(stdout)
        console.log("runningWin", { error, stdout, stderr, l })
        resolve(l > 2)
      }
    )
  })
}

export function runningPosix(pid: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    _cp.execFile(
      "ps",
      ["-p", int(pid)], // < sanitize pid
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error)
        const l = lines(stdout)
        console.log("runningPosix", { error, stdout, stderr, l })
        // TODO: It'd be more reliable to use the exit code, which is 0 if the
        // pid is running, and 1 if missing.
        resolve(l > 1)
      }
    )
  })
}

/**
 * Send a signal to the given process id.
 *
 * @export
 * @param {number} pid the process id. Required.
 * @param {boolean} [force=false] if true, and the current user has
 * permissions to send the signal, the pid will be forced to shut down.
 */
export function kill(pid: number, force: boolean = false): void {
  if (isWin) {
    const args = ["/PID", pid.toString(), "/T"]
    if (force) {
      args.push("/F")
    }
    _cp.execFile("taskkill", args)
  } else {
    _p.kill(pid, force ? "SIGKILL" : "SIGTERM")
  }
}
