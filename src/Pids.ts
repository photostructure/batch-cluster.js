import * as _cp from "child_process"
import * as _os from "os"
import * as _p from "process"

const isWin = _os.platform().startsWith("win")

/**
 * Sanitizes `n`
 */
function sanitize(n: number) {
  return String(parseInt(n + ""))
}

/*

Windows 10:

>tasklist /NH /FO "CSV" /FI "PID eq 15524"
INFO: No tasks are running which match the specified criteria.

>tasklist /NH /FO "CSV" /FI "PID eq 11968" 
"bash.exe","11968","Console","1","5,340 K"

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
 * process table. The PID may be paused or a zombie, though.
 */
export function pidExists(pid: number): Promise<boolean> {
  const needle = sanitize(pid)
  const cmd = isWin ? "tasklist" : "ps"
  const args = isWin
    ? // NoHeader, FOrmat CSV, FIlter on pid:
      ["/NH", "/FO", "CSV", "/FI", "PID eq " + needle]
    : // linux has "quick" mode (-q) but mac doesn't. We add the ",1" to avoid ps
      // returning exit code 1, which generates an extraneous Error.
      ["-p", needle + ",1"]
  return new Promise(resolve => {
    _cp.execFile(cmd, args, (error: Error | null, stdout: string) => {
      const result =
        error == null &&
        new RegExp(
          isWin ? '"' + needle + '"' : "^\\s*" + needle + "\\b",
          // The posix regex pattern needs multiline support:
          "m"
        ).exec(String(stdout).trim()) != null
      resolve(result)
    })
  })
}

const winRe = /^".+?","(\d+)"/
const posixRe = /^\s*(\d+)/

/**
 * @export
 * @returns {Promise<number[]>} all the Process IDs in the process table.
 */
export function pids(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    _cp.execFile(
      isWin ? "tasklist" : "ps",
      isWin ? ["/NH", "/FO", "CSV"] : ["-e"],
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error)
        } else if (("" + stderr).trim().length > 0) {
          reject(new Error(stderr))
        } else
          resolve(
            ("" + stdout)
              .trim()
              .split(/[\n\r]+/)
              .map(ea => ea.match(isWin ? winRe : posixRe))
              .filter(m => m != null)
              .map(m => parseInt(m![1]))
          )
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
    try {
      _p.kill(pid, force ? "SIGKILL" : "SIGTERM")
    } catch (err) {
      if (!String(err).includes("ESRCH")) throw err
    }
  }
}
