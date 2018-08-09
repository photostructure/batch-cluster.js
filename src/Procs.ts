import * as _cp from "child_process"
import { platform } from "os"
import * as _p from "process"

export const isWin = platform().startsWith("win")
export const isMac = platform() === "darwin"

/**
 * Sanitizes `n`
 */
function sanitize(n: number) {
  return String(parseInt(n + ""))
}

/*

>tasklist /FI "PID eq 8204"

Image Name                     PID Session Name        Session#    Mem Usage
========================= ======== ================ =========== ============
bash.exe                      8204 Console                    1     10,260 K

>tasklist /FI "PID eq 8204"
INFO: No tasks are running which match the specified criteria.

Linux:

$ ps -p 20242 
  PID TTY          TIME CMD
20242 pts/3    00:00:00 bash

Mac: 

$ ps -p 32183
  PID TTY           TIME CMD
32183 ttys001    0:00.10 /bin/bash -l

*/

/**
 * @export
 * @param {number} pid process id. Required.
 * @returns {Promise<boolean>} true if the given process id is in the local
 * process table.
 */
export function running(pid: number): Promise<boolean> {
  const needle = sanitize(pid)
  return new Promise(resolve => {
    _cp.execFile(
      isWin ? "tasklist" : "ps",
      isWin ? ["/FI", "PID eq " + needle] : [isMac ? "-p" : "-q", needle],
      (error: Error | null, stdout: string) => {
        const result =
          error == null &&
          new RegExp("\\b" + needle + "\\b", "m").exec(stdout) != null
        resolve(result)
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
    const args = ["/PID", sanitize(pid), "/T"]
    if (force) {
      args.push("/F")
    }
    _cp.execFile("taskkill", args)
  } else {
    _p.kill(pid, force ? "SIGKILL" : "SIGTERM")
  }
}
