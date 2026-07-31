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

export type KillFn = (pid: number, signal?: string | number) => boolean;

function validPid(pid: number | undefined): pid is number {
  return pid != null && isFinite(pid) && pid > 0;
}

function signal(pid: number, force: boolean, killFn?: KillFn): boolean {
  try {
    return (killFn ?? process.kill)(pid, force ? "SIGKILL" : undefined);
  } catch (err: unknown) {
    const errorCode = (err as NodeJS.ErrnoException)?.code;

    // ESRCH means the pid is already gone.
    if (errorCode === "ESRCH") return false;

    // EPERM means the pid exists but isn't ours to signal (a setuid child, or
    // a recycled pid). Rethrowing wouldn't kill it, and callers signal several
    // pids in a loop: one throw would strand the rest.
    if (errorCode === "EPERM") return false;

    throw err;
  }
}

/**
 * Send a signal to the given process id.
 *
 * @param pid the process id. Required.
 * @param force if true, and the current user has
 * permissions to send the signal, the pid will be forced to shut down. Defaults to false.
 * @param killFn optional kill function, defaults to process.kill
 * @returns true if the signal was delivered.
 */
export function kill(
  pid: number | undefined,
  force = false,
  killFn?: KillFn,
): boolean {
  if (!validPid(pid)) return false;
  return signal(pid, force, killFn);
}

/**
 * Send a signal to the process group led by the given process id, falling back
 * to the process itself.
 *
 * This is for children spawned with `detached: true`, which makes each child
 * the leader of its own process group: signalling the group also stops any
 * grandchildren the child spawned.
 *
 * It is safe for non-detached children too. A process group's id is its
 * leader's pid, so `-pid` names a group only when this child leads one; for a
 * non-detached child no such group exists and the OS reports ESRCH. (It cannot
 * signal *this* process's group by accident: that group is named by its own
 * leader's pid, which is alive and so can't have been reassigned to a child.)
 * Since a silent no-op here would leak the child we were asked to kill, we then
 * signal the pid directly -- and if the child is simply already gone, that's
 * another harmless ESRCH.
 *
 * Windows has no POSIX process groups, so there this behaves like {@link kill}.
 *
 * @param pid the process group leader's id (a positive pid). Required.
 * @param force if true, SIGKILL rather than SIGTERM. Defaults to false.
 * @param killFn optional kill function, defaults to process.kill
 */
export function killGroup(
  pid: number | undefined,
  force = false,
  killFn?: KillFn,
): boolean {
  if (!validPid(pid)) return false;
  if (isWin) return signal(pid, force, killFn);
  return signal(-pid, force, killFn) || signal(pid, force, killFn);
}

/**
 * Signal only the POSIX process group led by `pid`.
 *
 * Unlike {@link killGroup}, this never falls back to the direct pid. It is
 * used after a detached group leader has exited: the group can still contain
 * grandchildren, but falling back to the now-dead leader pid could signal an
 * unrelated process if that pid were reused. Windows has no equivalent
 * process-group signal, so this returns false there.
 */
export function killGroupOnly(
  pid: number | undefined,
  force = false,
  killFn?: KillFn,
): boolean {
  if (!validPid(pid) || isWin) return false;
  return signal(-pid, force, killFn);
}

/**
 * @return the kill function implied by the given options: signalling the whole
 * process group is opt-in, and only valid for `detached` children.
 */
export function killerFor(opts: { killProcessGroup: boolean }): typeof kill {
  return opts.killProcessGroup ? killGroup : kill;
}
