import events from "node:events"
import { expect, parser } from "./_chai.spec"
import { BatchClusterEmitter } from "./BatchClusterEmitter"
import { BatchProcess } from "./BatchProcess"
import { logger } from "./Logger"
import { Task } from "./Task"
import { TaskQueueManager } from "./TaskQueueManager"

describe("TaskQueueManager", function () {
  let queueManager: TaskQueueManager
  let emitter: BatchClusterEmitter
  let mockProcess: BatchProcess

  beforeEach(function () {
    emitter = new events.EventEmitter() as BatchClusterEmitter
    queueManager = new TaskQueueManager(logger, emitter)

    // Create a mock process that can execute tasks
    mockProcess = {
      ready: true,
      idle: true,
      pid: 12345,
      execTask: () => true, // Always succeed
    } as unknown as BatchProcess
  })

  describe("initial state", function () {
    it("should start with empty queue", function () {
      expect(queueManager.pendingTaskCount).to.eql(0)
      expect(queueManager.isEmpty).to.be.true
      expect(queueManager.pendingTasks).to.eql([])
    })

    it("should return empty queue stats", function () {
      const stats = queueManager.getQueueStats()
      expect(stats.pendingTaskCount).to.eql(0)
      expect(stats.isEmpty).to.be.true
    })
  })

  describe("task enqueuing", function () {
    it("should enqueue tasks when not ended", function () {
      const task = new Task("test command", parser)
      const promise = queueManager.enqueueTask(task, false)

      expect(queueManager.pendingTaskCount).to.eql(1)
      expect(queueManager.isEmpty).to.be.false
      expect(queueManager.pendingTasks).to.have.length(1)
      expect(queueManager.pendingTasks[0]).to.eql(task)
      expect(promise).to.equal(task.promise)
    })

    it("should reject tasks when ended", function () {
      const task = new Task("test command", parser)
      const promise = queueManager.enqueueTask(task, true)

      expect(queueManager.pendingTaskCount).to.eql(0)
      expect(queueManager.isEmpty).to.be.true
      expect(promise).to.equal(task.promise)
      expect(task.pending).to.be.false
    })

    it("should handle multiple tasks", function () {
      const task1 = new Task("command 1", parser)
      const task2 = new Task("command 2", parser)
      const task3 = new Task("command 3", parser)

      queueManager.enqueueTask(task1, false)
      queueManager.enqueueTask(task2, false)
      queueManager.enqueueTask(task3, false)

      expect(queueManager.pendingTaskCount).to.eql(3)
      expect(queueManager.pendingTasks).to.have.length(3)
    })
  })

  describe("task assignment", function () {
    let task: Task<string>

    beforeEach(function () {
      task = new Task("test command", parser)
      queueManager.enqueueTask(task, false)
    })

    it("should assign task to ready process", function () {
      const result = queueManager.tryAssignNextTask(mockProcess)

      expect(result).to.be.true
      expect(queueManager.pendingTaskCount).to.eql(0)
      expect(queueManager.isEmpty).to.be.true
    })

    it("should not assign task when no ready process", function () {
      const result = queueManager.tryAssignNextTask(undefined)

      expect(result).to.be.false
      expect(queueManager.pendingTaskCount).to.eql(1)
      expect(queueManager.isEmpty).to.be.false
    })

    it("should retry when process cannot execute task", function () {
      const failingProcess = {
        ...mockProcess,
        execTask: () => false, // Always fail
      } as unknown as BatchProcess

      const result = queueManager.tryAssignNextTask(failingProcess)

      expect(result).to.be.false
      expect(queueManager.pendingTaskCount).to.eql(1) // Task should be re-queued
    })

    it("should stop retrying after max retries", function () {
      const failingProcess = {
        ...mockProcess,
        execTask: () => false,
      } as unknown as BatchProcess

      const result = queueManager.tryAssignNextTask(failingProcess, 0)

      expect(result).to.be.false
      expect(queueManager.pendingTaskCount).to.eql(1) // Task remains when retries exhausted
    })

    it("should handle empty queue gracefully", function () {
      // Clear the queue first
      queueManager.clearAllTasks()

      const result = queueManager.tryAssignNextTask(mockProcess)

      expect(result).to.be.false
      expect(queueManager.pendingTaskCount).to.eql(0)
    })
  })

  describe("queue processing", function () {
    beforeEach(function () {
      // Add multiple tasks
      for (let i = 0; i < 5; i++) {
        const task = new Task(`command ${i}`, parser)
        queueManager.enqueueTask(task, false)
      }
    })

    it("should process all tasks when process is always ready", function () {
      const findReadyProcess = () => mockProcess
      const assignedCount = queueManager.processQueue(findReadyProcess)

      expect(assignedCount).to.eql(5)
      expect(queueManager.pendingTaskCount).to.eql(0)
      expect(queueManager.isEmpty).to.be.true
    })

    it("should stop processing when no ready process available", function () {
      const findReadyProcess = () => undefined
      const assignedCount = queueManager.processQueue(findReadyProcess)

      expect(assignedCount).to.eql(0)
      expect(queueManager.pendingTaskCount).to.eql(5)
      expect(queueManager.isEmpty).to.be.false
    })

    it("should partially process queue when process becomes unavailable", function () {
      let callCount = 0
      const findReadyProcess = () => {
        callCount++
        return callCount <= 3 ? mockProcess : undefined
      }

      const assignedCount = queueManager.processQueue(findReadyProcess)

      expect(assignedCount).to.eql(3)
      expect(queueManager.pendingTaskCount).to.eql(2)
    })

    it("should handle process that fails to execute tasks", function () {
      const failingProcess = {
        ...mockProcess,
        execTask: () => false,
      } as unknown as BatchProcess

      const findReadyProcess = () => failingProcess
      const assignedCount = queueManager.processQueue(findReadyProcess)

      expect(assignedCount).to.eql(0)
      expect(queueManager.pendingTaskCount).to.be.greaterThan(0) // Tasks remain queued
    })
  })

  describe("queue management", function () {
    beforeEach(function () {
      // Add some tasks
      for (let i = 0; i < 3; i++) {
        const task = new Task(`command ${i}`, parser)
        queueManager.enqueueTask(task, false)
      }
    })

    it("should clear all tasks", function () {
      expect(queueManager.pendingTaskCount).to.eql(3)

      queueManager.clearAllTasks()

      expect(queueManager.pendingTaskCount).to.eql(0)
      expect(queueManager.isEmpty).to.be.true
      expect(queueManager.pendingTasks).to.eql([])
    })

    it("should provide accurate queue statistics", function () {
      const stats = queueManager.getQueueStats()

      expect(stats.pendingTaskCount).to.eql(3)
      expect(stats.isEmpty).to.be.false
    })
  })

  describe("error handling", function () {
    it("should handle concurrent access gracefully", function () {
      // Add a task
      const task = new Task("test", parser)
      queueManager.enqueueTask(task, false)

      // First process gets the task
      const result1 = queueManager.tryAssignNextTask(mockProcess)
      expect(result1).to.be.true

      // Second attempt on empty queue should return false
      const result2 = queueManager.tryAssignNextTask(mockProcess)
      expect(result2).to.be.false
      expect(queueManager.pendingTaskCount).to.eql(0)
    })
  })

  describe("FIFO ordering", function () {
    it("should process tasks in first-in-first-out order", function () {
      const executedTasks: Task[] = []
      const trackingProcess = {
        ...mockProcess,
        execTask: (task: Task) => {
          executedTasks.push(task)
          return true
        },
      } as unknown as BatchProcess

      // Enqueue tasks with identifiable commands
      const task1 = new Task("first", parser)
      const task2 = new Task("second", parser)
      const task3 = new Task("third", parser)

      queueManager.enqueueTask(task1, false)
      queueManager.enqueueTask(task2, false)
      queueManager.enqueueTask(task3, false)

      // Process all tasks
      queueManager.processQueue(() => trackingProcess)

      expect(executedTasks).to.have.length(3)
      expect(executedTasks[0]?.command).to.eql("first")
      expect(executedTasks[1]?.command).to.eql("second")
      expect(executedTasks[2]?.command).to.eql("third")
    })
  })
})
