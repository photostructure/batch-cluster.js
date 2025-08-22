import child_process from "node:child_process";
import process from "node:process";
import { expect } from "./_chai.spec";
import { kill, pidExists } from "./Pids";
import { isWin } from "./Platform";

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

    it("should handle ESRCH error gracefully", function () {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalKill = process.kill;

      const mockKill = () => {
        const err = new Error("No such process - ESRCH");
        throw err;
      };
      process.kill = mockKill;

      expect(kill(12345)).to.be.false;

      process.kill = originalKill;
    });

    it("should re-throw non-ESRCH errors", function () {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalKill = process.kill;

      const mockKill = () => {
        const err = new Error("Operation not permitted");
        throw err;
      };
      process.kill = mockKill;

      expect(() => kill(12345)).to.throw("Operation not permitted");

      process.kill = originalKill;
    });

    it("should use SIGKILL when force is true", function () {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalKill = process.kill;
      let capturedSignal: string | number | undefined;

      const mockKill = (_pid: number, signal?: string | number): true => {
        capturedSignal = signal;
        return true;
      };
      process.kill = mockKill;

      kill(12345, true);
      expect(capturedSignal).to.equal("SIGKILL");

      kill(12345, false);
      expect(capturedSignal).to.be.undefined;

      process.kill = originalKill;
    });
  });
});
