import child_process from "node:child_process";
import process from "node:process";
import { expect } from "./_chai.spec";
import { until } from "./Async";
import { kill, killerFor, killGroup, killGroupOnly, pidExists } from "./Pids";
import { isWin } from "./Platform";
import { thenOrTimeout, Timeout } from "./Timeout";

describe("Pids", function () {
  describe("pidExists", function () {
    it("should return true for current process", function () {
      expect(pidExists(process.pid)).to.be.true;
    });

    it("should return false for invalid PIDs", function () {
      expect(pidExists(0)).to.be.false;
      expect(pidExists(-1)).to.be.false;
      expect(pidExists(-999)).to.be.false;
    });

    it("should return false for null and undefined", function () {
      expect(pidExists(null as any)).to.be.false;
      expect(pidExists(undefined)).to.be.false;
    });

    it("should return false for non-finite numbers", function () {
      expect(pidExists(NaN)).to.be.false;
      expect(pidExists(Infinity)).to.be.false;
      expect(pidExists(-Infinity)).to.be.false;
    });

    it("should return false for very large non-existent PID", function () {
      // Use a PID that's extremely unlikely to exist
      expect(pidExists(999999999)).to.be.false;
    });

    it("should handle child process PIDs correctly", function () {
      const child = child_process.spawn("node", [
        "-e",
        "setTimeout(() => {}, 100)",
      ]);

      if (child.pid != null) {
        expect(pidExists(child.pid)).to.be.true;

        child.kill();

        // Give process time to terminate
        return new Promise<void>((resolve) => {
          child.on("exit", () => {
            // Process should no longer exist after termination
            setTimeout(() => {
              expect(pidExists(child.pid!)).to.be.false;
              resolve();
            }, 50);
          });
        });
      } else {
        // If no PID, skip this test
        return Promise.resolve();
      }
    });

    if (isWin) {
      it("should handle Windows-specific error codes", function () {
        // Create a process that terminates quickly to potentially trigger Windows-specific errors
        const child = child_process.spawn("cmd", ["/c", "echo test"]);

        if (child.pid != null) {
          const originalPid = child.pid;

          return new Promise<void>((resolve) => {
            child.on("exit", () => {
              // On Windows, attempting to check a recently terminated process
              // may throw EINVAL or EACCES instead of ESRCH
              setTimeout(() => {
                // This should return false regardless of the specific error code
                expect(pidExists(originalPid)).to.be.false;
                resolve();
              }, 100);
            });
          });
        } else {
          // If no PID, skip this test
          return Promise.resolve();
        }
      });
    }

    it("should handle error conditions gracefully", function () {
      // Test EPERM error (should return true - process exists but no permission)
      const mockKillEPERM = () => {
        const err = new Error(
          "Operation not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      };
      expect(pidExists(12345, mockKillEPERM)).to.be.true;

      // Test ESRCH error (should return false - no such process)
      const mockKillESRCH = () => {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      };
      expect(pidExists(12345, mockKillESRCH)).to.be.false;

      if (isWin) {
        // Test Windows-specific EINVAL error (should return false)
        const mockKillEINVAL = () => {
          const err = new Error("Invalid argument") as NodeJS.ErrnoException;
          err.code = "EINVAL";
          throw err;
        };
        expect(pidExists(12345, mockKillEINVAL)).to.be.false;

        // Test Windows-specific EACCES error (should return false)
        const mockKillEACCES = () => {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        };
        expect(pidExists(12345, mockKillEACCES)).to.be.false;
      }

      // Test unknown error code (should return false)
      const mockKillUnknown = () => {
        const err = new Error("Unknown error") as NodeJS.ErrnoException;
        err.code = "EUNKNOWN";
        throw err;
      };
      expect(pidExists(12345, mockKillUnknown)).to.be.false;
    });
  });

  describe("kill", function () {
    it("should return false for invalid PIDs", function () {
      expect(kill(0)).to.be.false;
      expect(kill(-1)).to.be.false;
      expect(kill(null as any)).to.be.false;
      expect(kill(undefined)).to.be.false;
      expect(kill(NaN)).to.be.false;
      expect(kill(Infinity)).to.be.false;
    });

    it("should return false for non-existent PID", function () {
      expect(kill(999999999)).to.be.false;
    });

    it("should return false on ESRCH: the pid is already gone", function () {
      const mockKill = () => {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      };
      expect(kill(12345, false, mockKill)).to.be.false;
    });

    it("should return false on EPERM: the pid isn't ours to signal", function () {
      // Callers signal several pids in a loop (see BatchCluster's exit
      // listener): throwing here would strand every pid after this one.
      const mockKill = () => {
        const err = new Error(
          "Operation not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      };
      expect(kill(12345, true, mockKill)).to.be.false;
    });

    it("should re-throw unexpected errors", function () {
      const mockKill = () => {
        const err = new Error("Unexpected") as NodeJS.ErrnoException;
        err.code = "EUNKNOWN";
        throw err;
      };
      expect(() => kill(12345, false, mockKill)).to.throw("Unexpected");
    });

    it("should use SIGKILL when force is true", function () {
      let capturedSignal: string | number | undefined;

      const mockKill = (_pid: number, signal?: string | number): true => {
        capturedSignal = signal;
        return true;
      };

      kill(12345, true, mockKill);
      expect(capturedSignal).to.equal("SIGKILL");

      kill(12345, false, mockKill);
      expect(capturedSignal).to.be.undefined;
    });
  });

  describe("killGroup", function () {
    it("should refuse invalid PIDs rather than signalling a group", function () {
      // A negated pid here would signal an arbitrary group -- and killGroup(-1)
      // would ask the OS to signal *every* process we're allowed to signal.
      expect(killGroup(0)).to.be.false;
      expect(killGroup(-1)).to.be.false;
      expect(killGroup(undefined)).to.be.false;
      expect(killGroup(NaN)).to.be.false;
    });

    it("should signal the negated pid", function () {
      let capturedPid: number | undefined;
      const mockKill = (pid: number): true => {
        capturedPid = pid;
        return true;
      };
      killGroup(12345, true, mockKill);
      // Windows has no POSIX process groups, so we signal the pid itself:
      expect(capturedPid).to.eql(isWin ? 12345 : -12345);
    });

    it("can signal only a surviving group without falling back to its dead leader", function () {
      const capturedPids: number[] = [];
      const mockKill = (pid: number): false => {
        capturedPids.push(pid);
        return false;
      };

      expect(killGroupOnly(12345, true, mockKill)).to.be.false;
      expect(capturedPids).to.eql(isWin ? [] : [-12345]);
    });

    it("should stop a detached child's grandchildren", async function () {
      if (isWin) return this.skip();
      this.timeout(15_000);

      // detached: true makes the child its own process group leader, so its
      // grandchild shares that group. Killing only proc.pid would orphan it.
      const proc = child_process.spawn(
        process.execPath,
        [
          "-e",
          "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);" +
            "process.stdout.write(c.pid + '\\n');" +
            "setInterval(() => {}, 1000)",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );

      // The try must start here, not after the pid handshake: a spawn error,
      // an early exit, or a failed assertion below would otherwise leave a
      // detached child *and* its grandchild running on the developer's machine.
      let grandchildPid: number | undefined;
      try {
        const handshake = await thenOrTimeout(
          new Promise<number>((resolve, reject) => {
            proc.stdout.on("data", (chunk: Buffer) =>
              resolve(Number(chunk.toString().trim())),
            );
            proc.on("error", reject);
            proc.on("exit", () =>
              reject(new Error("child exited before reporting its grandchild")),
            );
          }),
          5_000,
        );
        if (handshake === Timeout) {
          throw new Error("child did not report its grandchild within 5000ms");
        }
        grandchildPid = handshake;
        expect(pidExists(grandchildPid)).to.be.true;

        expect(killGroup(proc.pid, true)).to.be.true;

        expect(await until(() => !pidExists(proc.pid), 5_000)).to.eql(
          true,
          "detached child should be dead",
        );
        expect(await until(() => !pidExists(grandchildPid), 5_000)).to.eql(
          true,
          "grandchild should be dead too",
        );
      } finally {
        // The group kill covers the grandchild too, but it may have been
        // reparented if the child died first; kill(undefined) is a no-op.
        killGroup(proc.pid, true);
        kill(grandchildPid, true);
      }
    });

    it("still kills a child that leads no process group", async function () {
      if (isWin) return this.skip();
      this.timeout(15_000);

      // NOT detached, so `-pid` names no group and the group signal fails with
      // ESRCH. Without the fallback this would silently no-op, and enabling
      // killProcessGroup would turn every force-kill into a leak.
      const proc = child_process.spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      try {
        expect(killGroup(proc.pid, true)).to.eql(
          true,
          "should have fallen back to signalling the pid",
        );
        expect(await until(() => !pidExists(proc.pid), 5_000)).to.eql(
          true,
          "non-detached child should be dead",
        );
      } finally {
        kill(proc.pid, true);
      }
    });

    it("killerFor selects the group killer only when opted in", function () {
      expect(killerFor({ killProcessGroup: false })).to.eql(kill);
      expect(killerFor({ killProcessGroup: true })).to.eql(killGroup);
    });
  });
});
