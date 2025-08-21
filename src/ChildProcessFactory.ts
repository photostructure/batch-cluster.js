import child_process from "node:child_process";

/**
 * These are required parameters for a given BatchCluster.
 */

export interface ChildProcessFactory {
  /**
   * Expected to be a simple call to execFile. Platform-specific code is the
   * responsibility of this thunk. Error handlers will be registered as
   * appropriate.
   *
   * If this function throws an error or rejects the promise _after_ you've
   * spawned a child process, **the child process may continue to run** and leak
   * system resources.
   */
  readonly processFactory: () =>
    | child_process.ChildProcess
    | Promise<child_process.ChildProcess>;
}
