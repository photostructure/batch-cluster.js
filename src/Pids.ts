import { isWin } from "./Platform";

/**
 * @param {number} pid process id. Required.
 * @param {Function} killFn optional kill function, defaults to process.kill
 * @returns boolean true if the given process id is in the local process
 * table. The PID may be paused or a zombie, though.
 */
export function pidExists(
  pid: number | undefined,
  killFn?: (pid: number, signal?: string | number) => boolean,
): boolean {
  if (pid == null || !isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 can be used to test for the existence of a process
    // see https://nodejs.org/dist/latest-v18.x/docs/api/process.html#processkillpid-signal
    return (killFn ?? process.kill)(pid, 0);
  } catch (err: unknown) {
    const errorCode = (err as NodeJS.ErrnoException)?.code;

    // EPERM means we don't have permission to signal the process, but it exists
    if (errorCode === "EPERM") return true;

    // ESRCH means "no such process" - the process doesn't exist or has terminated
    if (errorCode === "ESRCH") return false;

    // On Windows, additional error codes can indicate process termination issues
    if (isWin) {
      // EINVAL: Invalid signal argument (process may be terminating)
      // EACCES: Access denied (process may be in terminating state)
      if (errorCode === "EINVAL" || errorCode === "EACCES") {
        return false;
      }
    }

    // For any other error, assume the pid is gone
    return false;
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
  if (pid == null || !isFinite(pid) || pid <= 0) return false;
  try {
    return process.kill(pid, force ? "SIGKILL" : undefined);
  } catch (err) {
    if (!String(err).includes("ESRCH")) throw err;
    return false;
    // failed to get priority--assume the pid is gone.
  }
}
