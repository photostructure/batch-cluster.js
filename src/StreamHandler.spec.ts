import child_process from "node:child_process"
import events from "node:events"
import { expect, processFactory } from "./_chai.spec"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import { logger } from "./Logger"
import { StreamHandler, StreamHandlerOptions, StreamContext } from "./StreamHandler"
import { Task } from "./Task"

describe("StreamHandler", function () {
  let streamHandler: StreamHandler
  let emitter: BatchClusterEmitter
  let mockContext: StreamContext
  let onErrorCalls: { reason: string; error: Error }[] = []
  let endCalls: { gracefully: boolean; reason: string }[] = []

  const options: StreamHandlerOptions = {
    logger,
  }

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter
    streamHandler = new StreamHandler(options, emitter)
    
    onErrorCalls = []
    endCalls = []

    // Create a mock context that simulates BatchProcess behavior
    mockContext = {
      name: "TestProcess(12345)",
      ending: false,
      currentTask: undefined,
      onError: (reason: string, error: Error) => {
        onErrorCalls.push({ reason, error })
      },
      end: (gracefully: boolean, reason: string) => {
        endCalls.push({ gracefully, reason })
      },
    }
  })

  describe("initial state", function () {
    it("should initialize correctly", function () {
      expect(streamHandler).to.not.be.undefined
      
      const stats = streamHandler.getStats()
      expect(stats.handlerActive).to.be.true
      expect(stats.emitterConnected).to.be.true
    })
  })

  describe("stream setup", function () {
    let mockProcess: child_process.ChildProcess

    beforeEach(async function () {
      // Create a real process for testing stream setup
      mockProcess = await processFactory()
    })

    afterEach(function () {
      if (mockProcess && !mockProcess.killed) {
        mockProcess.kill()
      }
    })

    it("should set up stream listeners on a child process", function () {
      expect(() => {
        streamHandler.setupStreamListeners(mockProcess, mockContext)
      }).to.not.throw()

      // Verify streams exist
      expect(mockProcess.stdin).to.not.be.null
      expect(mockProcess.stdout).to.not.be.null
      expect(mockProcess.stderr).to.not.be.null
    })

    it("should throw error if stdin is missing", function () {
      const invalidProcess = { stdin: null } as child_process.ChildProcess
      
      expect(() => {
        streamHandler.setupStreamListeners(invalidProcess, mockContext)
      }).to.throw("Given proc had no stdin")
    })

    it("should throw error if stdout is missing", function () {
      const invalidProcess = { 
        stdin: { on: () => { /* mock implementation */ } }, // Mock stdin with on method
        stdout: null,
      } as any as child_process.ChildProcess
      
      expect(() => {
        streamHandler.setupStreamListeners(invalidProcess, mockContext)
      }).to.throw("Given proc had no stdout")
    })
  })

  describe("stdout processing", function () {
    let mockTask: Task<unknown>
    let taskDataEvents: { data: any; task: any; context: any }[] = []
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = []

    beforeEach(function () {
      taskDataEvents = []
      noTaskDataEvents = []

      // Set up event listeners
      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context })
      })

      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context })
      })

      // Create a mock task
      mockTask = {
        pending: true,
        onStdout: () => { /* mock implementation */ },
      } as unknown as Task<unknown>
    })

    it("should process stdout data with active task", function () {
      mockContext.currentTask = mockTask
      const testData = "test output"

      streamHandler.processStdout(testData, mockContext)

      expect(taskDataEvents).to.have.length(1)
      expect(taskDataEvents[0]?.data).to.eql(testData)
      expect(taskDataEvents[0]?.task).to.eql(mockTask)
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should ignore stdout data when process is ending", function () {
      mockContext.currentTask = undefined
      mockContext.ending = true
      const testData = "test output"

      streamHandler.processStdout(testData, mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should emit noTaskData and end process for stdout without task", function () {
      mockContext.currentTask = undefined
      mockContext.ending = false
      const testData = "unexpected output"

      streamHandler.processStdout(testData, mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(1)
      expect(noTaskDataEvents[0]?.stdout).to.eql(testData)
      expect(noTaskDataEvents[0]?.stderr).to.be.null
      expect(endCalls).to.have.length(1)
      expect(endCalls[0]?.gracefully).to.be.false
      expect(endCalls[0]?.reason).to.eql("stdout.error")
    })

    it("should ignore blank stdout data", function () {
      mockContext.currentTask = undefined
      mockContext.ending = false

      streamHandler.processStdout("", mockContext)
      streamHandler.processStdout("   ", mockContext)
      streamHandler.processStdout("\n", mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should handle null stdout data", function () {
      mockContext.currentTask = undefined
      mockContext.ending = false

      streamHandler.processStdout(null as any, mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should not process stdout when task is not pending", function () {
      const nonPendingTask = {
        pending: false,
        onStdout: () => { /* mock implementation */ },
      } as unknown as Task<unknown>

      mockContext.currentTask = nonPendingTask
      mockContext.ending = false
      const testData = "test output"

      streamHandler.processStdout(testData, mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(1)
      expect(endCalls).to.have.length(1)
      expect(endCalls[0]?.reason).to.eql("stdout.error")
    })
  })

  describe("stderr processing", function () {
    let mockTask: Task<unknown>
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = []

    beforeEach(function () {
      noTaskDataEvents = []

      // Set up event listeners
      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context })
      })

      // Create a mock task
      mockTask = {
        pending: true,
        onStderr: () => { /* mock implementation */ },
      } as unknown as Task<unknown>
    })

    it("should process stderr data with active task", function () {
      mockContext.currentTask = mockTask
      const testData = "error output"

      streamHandler.processStderr(testData, mockContext)

      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should ignore stderr data when process is ending", function () {
      mockContext.currentTask = undefined
      mockContext.ending = true
      const testData = "error output"

      streamHandler.processStderr(testData, mockContext)

      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should emit noTaskData and end process for stderr without task", function () {
      mockContext.currentTask = undefined
      mockContext.ending = false
      const testData = "unexpected error"

      streamHandler.processStderr(testData, mockContext)

      expect(noTaskDataEvents).to.have.length(1)
      expect(noTaskDataEvents[0]?.stdout).to.be.null
      expect(noTaskDataEvents[0]?.stderr).to.eql(testData)
      expect(endCalls).to.have.length(1)
      expect(endCalls[0]?.gracefully).to.be.false
      expect(endCalls[0]?.reason).to.eql("stderr")
    })

    it("should ignore blank stderr data", function () {
      mockContext.currentTask = undefined
      mockContext.ending = false

      streamHandler.processStderr("", mockContext)
      streamHandler.processStderr("   ", mockContext)
      streamHandler.processStderr("\n", mockContext)

      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should not process stderr when task is not pending", function () {
      const nonPendingTask = {
        pending: false,
        onStderr: () => { /* mock implementation */ },
      } as unknown as Task<unknown>

      mockContext.currentTask = nonPendingTask
      mockContext.ending = false
      const testData = "error output"

      streamHandler.processStderr(testData, mockContext)

      expect(noTaskDataEvents).to.have.length(1)
      expect(endCalls).to.have.length(1)
      expect(endCalls[0]?.reason).to.eql("stderr")
    })
  })

  describe("utility methods", function () {
    it("should correctly identify blank data", function () {
      expect(streamHandler.isBlankData("")).to.be.true
      expect(streamHandler.isBlankData("   ")).to.be.true
      expect(streamHandler.isBlankData("\n")).to.be.true
      expect(streamHandler.isBlankData("\t")).to.be.true
      expect(streamHandler.isBlankData(null)).to.be.true
      expect(streamHandler.isBlankData(undefined)).to.be.true
      
      expect(streamHandler.isBlankData("text")).to.be.false
      expect(streamHandler.isBlankData("  text  ")).to.be.false
      expect(streamHandler.isBlankData(Buffer.from("data"))).to.be.false
    })

    it("should provide handler statistics", function () {
      const stats = streamHandler.getStats()
      
      expect(stats).to.have.property("handlerActive")
      expect(stats).to.have.property("emitterConnected")
      expect(stats.handlerActive).to.be.true
      expect(stats.emitterConnected).to.be.true
    })
  })

  describe("buffer handling", function () {
    let mockTask: Task<unknown>
    let taskDataEvents: { data: any; task: any; context: any }[] = []

    beforeEach(function () {
      taskDataEvents = []

      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context })
      })

      mockTask = {
        pending: true,
        onStdout: () => { /* mock implementation */ },
        onStderr: () => { /* mock implementation */ },
      } as unknown as Task<unknown>
    })

    it("should handle Buffer data in stdout", function () {
      mockContext.currentTask = mockTask
      const bufferData = Buffer.from("test buffer data")

      streamHandler.processStdout(bufferData, mockContext)

      expect(taskDataEvents).to.have.length(1)
      expect(taskDataEvents[0]?.data).to.eql(bufferData)
    })

    it("should handle Buffer data in stderr", function () {
      mockContext.currentTask = mockTask
      const bufferData = Buffer.from("error buffer data")

      // Should not throw and should process normally
      expect(() => {
        streamHandler.processStderr(bufferData, mockContext)
      }).to.not.throw()
    })
  })

  describe("integration scenarios", function () {
    let mockTask: Task<unknown>
    let taskDataEvents: { data: any; task: any; context: any }[] = []
    let noTaskDataEvents: { stdout: any; stderr: any; context: any }[] = []

    beforeEach(function () {
      taskDataEvents = []
      noTaskDataEvents = []

      emitter.on("taskData", (data, task, context) => {
        taskDataEvents.push({ data, task, context })
      })

      emitter.on("noTaskData", (stdout, stderr, context) => {
        noTaskDataEvents.push({ stdout, stderr, context })
      })

      mockTask = {
        pending: true,
        onStdout: () => { /* mock implementation */ },
        onStderr: () => { /* mock implementation */ },
      } as unknown as Task<unknown>
    })

    it("should handle mixed stdout and stderr with active task", function () {
      mockContext.currentTask = mockTask

      streamHandler.processStdout("stdout data", mockContext)
      streamHandler.processStderr("stderr data", mockContext)

      expect(taskDataEvents).to.have.length(1)
      expect(taskDataEvents[0]?.data).to.eql("stdout data")
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })

    it("should handle task completion scenario", function () {
      // Start with active task
      mockContext.currentTask = mockTask
      streamHandler.processStdout("initial output", mockContext)
      
      expect(taskDataEvents).to.have.length(1)
      
      // Task completes, no current task
      mockContext.currentTask = undefined
      streamHandler.processStdout("stray output", mockContext)
      
      expect(noTaskDataEvents).to.have.length(1)
      expect(endCalls).to.have.length(1)
      expect(endCalls[0]?.reason).to.eql("stdout.error")
    })

    it("should handle process ending scenario", function () {
      mockContext.currentTask = undefined
      mockContext.ending = true

      streamHandler.processStdout("final output", mockContext)
      streamHandler.processStderr("final error", mockContext)

      expect(taskDataEvents).to.have.length(0)
      expect(noTaskDataEvents).to.have.length(0)
      expect(endCalls).to.have.length(0)
    })
  })
})