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
