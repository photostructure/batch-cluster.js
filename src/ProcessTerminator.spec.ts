import events from "node:events"
import stream from "node:stream"
import { expect } from "./_chai.spec"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"
import { logger } from "./Logger"
import { ProcessTerminator } from "./ProcessTerminator"
import { SimpleParser } from "./Parser"
import { Task } from "./Task"

describe("ProcessTerminator", function () {
  let terminator: ProcessTerminator
  let mockProcess: MockChildProcess
  let emitter: BatchClusterEmitter
  let options: InternalBatchProcessOptions
  let isRunningResult: boolean
  let childEndEvents: { process: any; reason: string }[]

  // Mock child process class
  class MockChildProcess extends events.EventEmitter {
    pid = 12345
    stdin = new MockWritableStream()
    stdout = new MockReadableStream()
    stderr = new MockReadableStream()
    killed = false
    disconnected = false

    kill() {
      this.killed = true
      return true
    }

    disconnect() {
      this.disconnected = true
    }

    unref() {
      // no-op for tests
    }
  }

  class MockWritableStream extends stream.Writable {
    override destroyed = false
    override writable = true
    data: string[] = []

    override _write(chunk: any, _encoding: any, callback: any) {
      this.data.push(chunk.toString())
      callback()
    }

    override end(data?: any): this {
      if (data != null) {
        this.data.push(data.toString())
      }
      this.writable = false
      super.end()
      return this
    }

    override destroy(): this {
      this.destroyed = true
      super.destroy()
      return this
    }
  }

  class MockReadableStream extends stream.Readable {
    override destroyed = false

    override _read() {
      // no-op for tests
    }

    override destroy(): this {
      this.destroyed = true
      super.destroy()
      return this
    }
  }

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter
    childEndEvents = []
    
    // Track childEnd events
    emitter.on("childEnd", (process: any, reason: string) => {
      childEndEvents.push({ process, reason })
    })

    options = {
      logger,
      observer: emitter,
      cleanupChildProcs: true,
      endGracefulWaitTimeMillis: 1000,
      exitCommand: "exit",
      spawnTimeoutMillis: 5000,
      taskTimeoutMillis: 30000,
      streamFlushMillis: 100,
      versionCommand: "version",
      healthCheckCommand: "healthcheck",
      healthCheckIntervalMillis: 60000,
      maxTasksPerProcess: 100,
      maxIdleMsPerProcess: 300000,
      maxFailedTasksPerProcess: 3,
      maxProcAgeMillis: 600000,
      pass: "PASS",
      fail: "FAIL",
      passRE: /PASS/,
      failRE: /FAIL/,
      maxProcs: 4,
      onIdleIntervalMillis: 10,
      maxReasonableProcessFailuresPerMinute: 10,
      minDelayBetweenSpawnMillis: 100,
      pidCheckIntervalMillis: 150,
    }

    terminator = new ProcessTerminator(options)
    mockProcess = new MockChildProcess()
    isRunningResult = true
  })

  function createMockTask(taskId = 1, command = "test", pending = true): Task<unknown> {
    const task = new Task(command, SimpleParser)
    if (!pending) {
      // Simulate task completion by calling onStdout with PASS token
      task.onStart(options)
      task.onStdout("PASS")
    }
    // Override taskId for testing
    Object.defineProperty(task, "taskId", { value: taskId, writable: true })
    return task as Task<unknown>
  }

  function mockIsRunning(): boolean {
    return isRunningResult
  }

  describe("basic termination", function () {
    it("should terminate process without current task", async function () {
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined, // no current task
        999, // startup task id
        true, // graceful
        false, // not exited
        mockIsRunning,
      )

      // Should send exit command
      expect(mockProcess.stdin.data).to.include("exit\n")
      
      // Should destroy streams
      expect(mockProcess.stdin.destroyed).to.be.true
      expect(mockProcess.stdout.destroyed).to.be.true
      expect(mockProcess.stderr.destroyed).to.be.true
      
      // Should disconnect
      expect(mockProcess.disconnected).to.be.true
    })

    it("should terminate process forcefully when not graceful", async function () {
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        false, // not graceful
        false,
        mockIsRunning,
      )

      expect(mockProcess.stdin.data).to.include("exit\n")
      expect(mockProcess.disconnected).to.be.true
    })

    it("should handle process that is already exited", async function () {
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        true, // already exited
        mockIsRunning,
      )

      expect(mockProcess.stdin.data).to.include("exit\n")
      expect(mockProcess.disconnected).to.be.true
    })
  })

  describe("task completion handling", function () {
    it("should wait for non-startup task to complete gracefully", async function () {
      const task = createMockTask(1, "test command", true)
      let taskCompleted = false

      // Simulate task completion after a delay
      setTimeout(() => {
        taskCompleted = true
        task.onStart(options)
        task.onStdout("PASS") // Complete the task
      }, 50)

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        task,
        999, // different from task ID
        true, // graceful
        false,
        mockIsRunning,
      )

      expect(taskCompleted).to.be.true
      expect(task.state !== "pending").to.be.true
    })

    it("should reject pending task if termination timeout occurs", async function () {
      const task = createMockTask(1, "slow task", true)
      let taskRejected = false
      let rejectionReason = ""

      task.promise.catch((err) => {
        taskRejected = true
        rejectionReason = err.message
      })

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        task,
        999,
        false, // not graceful - shorter timeout
        false,
        mockIsRunning,
      )

      expect(taskRejected).to.be.true
      expect(rejectionReason).to.include("Process terminated before task completed")
    })

    it("should skip task completion wait for startup task", async function () {
      const startupTask = createMockTask(999, "version", true)

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        startupTask,
        999, // same as task ID - is startup task
        true,
        false,
        mockIsRunning,
      )

      // Should not wait for or reject startup task
      expect(startupTask.pending).to.be.true
    })

    it("should skip task completion wait when no current task", async function () {
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined, // no current task
        999,
        true,
        false,
        mockIsRunning,
      )

      // Should complete without errors
      expect(mockProcess.disconnected).to.be.true
    })
  })

  describe("stream handling", function () {
    it("should remove error listeners from all streams", async function () {
      // Add some error listeners
      const errorHandler = () => {
        // no-op for test
      }
      mockProcess.on("error", errorHandler)
      mockProcess.stdin.on("error", errorHandler)
      mockProcess.stdout.on("error", errorHandler)
      mockProcess.stderr.on("error", errorHandler)

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      // Error listeners should be removed
      expect(mockProcess.listenerCount("error")).to.equal(0)
      expect(mockProcess.stdin.listenerCount("error")).to.equal(0)
      expect(mockProcess.stdout.listenerCount("error")).to.equal(0)
      expect(mockProcess.stderr.listenerCount("error")).to.equal(0)
    })

    it("should send exit command if stdin is writable", async function () {
      mockProcess.stdin.writable = true

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.stdin.data).to.include("exit\n")
    })

    it("should skip exit command if stdin is not writable", async function () {
      mockProcess.stdin.writable = false

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.stdin.data).to.be.empty
    })

    it("should handle missing exit command gracefully", async function () {
      const optionsNoExit = { ...options, exitCommand: undefined }
      const terminatorNoExit = new ProcessTerminator(optionsNoExit)

      await terminatorNoExit.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      // Should complete without sending exit command
      expect(mockProcess.stdin.data).to.be.empty
      expect(mockProcess.disconnected).to.be.true
    })

    it("should destroy all streams", async function () {
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.stdin.destroyed).to.be.true
      expect(mockProcess.stdout.destroyed).to.be.true
      expect(mockProcess.stderr.destroyed).to.be.true
    })
  })

  describe("graceful shutdown", function () {
    it("should wait for process to exit gracefully", async function () {
      let killCalled = false
      mockProcess.kill = () => {
        killCalled = true
        return true
      }

      // Simulate process still running initially, then stopping
      let callCount = 0
      const mockIsRunningGraceful = () => {
        callCount++
        if (callCount <= 2) {
          return true // Still running for first few checks
        }
        return false // Then stops running
      }

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true, // graceful
        false, // not already exited
        mockIsRunningGraceful,
      )

      expect(killCalled).to.be.false // Should not need to kill
    })

    it("should send SIGTERM if process doesn't exit gracefully", async function () {
      let killCalled = false
      mockProcess.kill = () => {
        killCalled = true
        isRunningResult = false // Process stops after kill signal
        return true
      }

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true, // graceful
        false, // not already exited
        mockIsRunning, // Always returns true until killed
      )

      expect(killCalled).to.be.true
    })

    it("should skip graceful shutdown when cleanup disabled", async function () {
      const optionsNoCleanup = { ...options, cleanupChildProcs: false }
      const terminatorNoCleanup = new ProcessTerminator(optionsNoCleanup)
      
      let killCalled = false
      mockProcess.kill = () => {
        killCalled = true
        return true
      }

      await terminatorNoCleanup.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(killCalled).to.be.false
    })

    it("should skip graceful shutdown when wait time is 0", async function () {
      const optionsNoWait = { ...options, endGracefulWaitTimeMillis: 0 }
      const terminatorNoWait = new ProcessTerminator(optionsNoWait)
      
      let killCalled = false
      mockProcess.kill = () => {
        killCalled = true
        return true
      }

      await terminatorNoWait.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(killCalled).to.be.false
    })
  })

  describe("force killing", function () {
    it("should complete termination even with stubborn process", async function () {
      // Process keeps running even after signals
      const mockIsRunningStubborn = () => true

      // Should complete without throwing
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunningStubborn,
      )

      // Should still disconnect and destroy streams
      expect(mockProcess.disconnected).to.be.true
      expect(mockProcess.stdin.destroyed).to.be.true
    })

    it("should complete termination when cleanup disabled", async function () {
      const optionsNoCleanup = { ...options, cleanupChildProcs: false }
      const terminatorNoCleanup = new ProcessTerminator(optionsNoCleanup)

      await terminatorNoCleanup.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        () => true, // Always running
      )

      // Should still complete basic cleanup
      expect(mockProcess.disconnected).to.be.true
      expect(mockProcess.stdin.destroyed).to.be.true
    })

    it("should handle process with no PID gracefully", async function () {
      ;(mockProcess as any).pid = undefined

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        () => true,
      )

      // Should complete without issues
      expect(mockProcess.disconnected).to.be.true
      expect(mockProcess.stdin.destroyed).to.be.true
    })
  })

  describe("error handling", function () {
    it("should handle stdin.end() errors gracefully", async function () {
      mockProcess.stdin.end = () => {
        throw new Error("EPIPE")
      }

      // Should not throw
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.disconnected).to.be.true
    })

    it("should handle stream destruction errors gracefully", async function () {
      mockProcess.stdout.destroy = () => {
        throw new Error("Stream error")
      }

      // Should not throw
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.disconnected).to.be.true
    })

    it("should handle disconnect errors gracefully", async function () {
      mockProcess.disconnect = () => {
        throw new Error("Disconnect error")
      }

      // Should not throw
      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )
    })
  })

  describe("edge cases", function () {
    it("should handle null stderr stream", async function () {
      ;(mockProcess as any).stderr = null

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.disconnected).to.be.true
    })

    it("should handle already completed task", async function () {
      const completedTask = createMockTask(1, "completed", false)

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        completedTask,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(completedTask.state !== "pending").to.be.true
      expect(mockProcess.disconnected).to.be.true
    })

    it("should handle process with undefined PID", async function () {
      ;(mockProcess as any).pid = undefined

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        undefined,
        999,
        true,
        false,
        mockIsRunning,
      )

      expect(mockProcess.disconnected).to.be.true
    })
  })

  describe("timing and timeouts", function () {
    it("should respect graceful task timeout", async function () {
      const slowTask = createMockTask(1, "slow", true)
      const startTime = Date.now()

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        slowTask,
        999,
        true, // graceful - should wait up to 2000ms for task
        false,
        mockIsRunning,
      )

      const elapsed = Date.now() - startTime
      // Should have waited some time but not too long
      expect(elapsed).to.be.greaterThan(50)
      expect(elapsed).to.be.lessThan(4000)
      expect(slowTask.pending).to.be.false // Should be rejected
    })

    it("should respect non-graceful task timeout", async function () {
      const slowTask = createMockTask(1, "slow", true)
      const startTime = Date.now()

      await terminator.terminate(
        mockProcess as any,
        "TestProcess(12345)",
        slowTask,
        999,
        false, // not graceful - should wait only 250ms for task
        false,
        mockIsRunning,
      )

      const elapsed = Date.now() - startTime
      // Should have waited less time
      expect(elapsed).to.be.lessThan(1000)
      expect(slowTask.pending).to.be.false // Should be rejected
    })
  })
})