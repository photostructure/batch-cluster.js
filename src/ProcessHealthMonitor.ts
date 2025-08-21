import { BatchClusterEmitter } from "./BatchClusterEmitter";
import {
  CompositeHealthCheckStrategy,
  HealthCheckStrategy,
} from "./HealthCheckStrategy";
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
import { SimpleParser } from "./Parser";
import { blank } from "./String";
import { Task } from "./Task";
import { WhyNotHealthy, WhyNotReady } from "./WhyNotHealthy";

/**
 * Interface for objects that can be health checked
 */
export interface HealthCheckable {
  readonly pid: number;
  readonly start: number;
  readonly taskCount: number;
  readonly failedTaskCount: number;
  readonly idleMs: number;
  readonly idle: boolean;
  readonly ending: boolean;
  readonly ended: boolean;
  readonly proc: {
    stdin?: { destroyed?: boolean } | null;
  };
  readonly currentTask?: Task<unknown> | null | undefined;
}

/**
 * Manages health checking logic for processes.
 * Provides centralized health assessment and monitoring capabilities.
 */
export class ProcessHealthMonitor {
  readonly #healthCheckStates = new Map<
    number,
    {
      lastHealthCheck: number;
      healthCheckFailures: number;
      lastJobFailed: boolean;
    }
  >();

  private readonly healthStrategy: HealthCheckStrategy;

  constructor(
    private readonly options: InternalBatchProcessOptions,
    private readonly emitter: BatchClusterEmitter,
    healthStrategy?: HealthCheckStrategy,
  ) {
    this.healthStrategy = healthStrategy ?? new CompositeHealthCheckStrategy();
  }

  /**
   * Initialize health monitoring for a process
   */
  initializeProcess(pid: number): void {
    this.#healthCheckStates.set(pid, {
      lastHealthCheck: Date.now(),
      healthCheckFailures: 0,
      lastJobFailed: false,
    });
  }

  /**
   * Clean up health monitoring for a process
   */
  cleanupProcess(pid: number): void {
    this.#healthCheckStates.delete(pid);
  }

  /**
   * Record that a job failed for a process
   */
  recordJobFailure(pid: number): void {
    const state = this.#healthCheckStates.get(pid);
    if (state != null) {
      state.lastJobFailed = true;
    }
  }

  /**
   * Record that a job succeeded for a process
   */
  recordJobSuccess(pid: number): void {
    const state = this.#healthCheckStates.get(pid);
    if (state != null) {
      state.lastJobFailed = false;
    }
  }

  /**
   * Assess the health of a process and return why it's not healthy, or null if healthy
   */
  assessHealth(
    process: HealthCheckable,
    overrideReason?: WhyNotHealthy,
  ): WhyNotHealthy | null {
    if (overrideReason != null) return overrideReason;

    const state = this.#healthCheckStates.get(process.pid);
    if (state != null && state.healthCheckFailures > 0) {
      return "unhealthy";
    }

    return this.healthStrategy.assess(process, this.options);
  }

  /**
   * Check if a process is healthy
   */
  isHealthy(process: HealthCheckable, overrideReason?: WhyNotHealthy): boolean {
    return this.assessHealth(process, overrideReason) == null;
  }

  /**
   * Assess why a process is not ready (combines health and business)
   */
  assessReadiness(
    process: HealthCheckable,
    overrideReason?: WhyNotHealthy,
  ): WhyNotReady | null {
    return !process.idle ? "busy" : this.assessHealth(process, overrideReason);
  }

  /**
   * Check if a process is ready to handle tasks
   */
  isReady(process: HealthCheckable, overrideReason?: WhyNotHealthy): boolean {
    return this.assessReadiness(process, overrideReason) == null;
  }

  /**
   * Run a health check on a process if needed
   */
  maybeRunHealthcheck(
    process: HealthCheckable & { execTask: (task: Task<unknown>) => boolean },
  ): Task<unknown> | undefined {
    const hcc = this.options.healthCheckCommand;
    // if there's no health check command, no-op.
    if (hcc == null || blank(hcc)) return;

    // if the prior health check failed, .ready will be false
    if (!this.isReady(process)) return;

    const state = this.#healthCheckStates.get(process.pid);
    if (state == null) return;

    if (
      state.lastJobFailed ||
      (this.options.healthCheckIntervalMillis > 0 &&
        Date.now() - state.lastHealthCheck >
          this.options.healthCheckIntervalMillis)
    ) {
      state.lastHealthCheck = Date.now();
      const t = new Task(hcc, SimpleParser);
      t.promise
        .catch((err) => {
          this.emitter.emit(
            "healthCheckError",
            err instanceof Error ? err : new Error(String(err)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
            process as any, // Type assertion for event emission
          );
          state.healthCheckFailures++;
          // BatchCluster will see we're unhealthy and reap us later
        })
        .finally(() => {
          state.lastHealthCheck = Date.now();
        });

      // Execute the health check task on the process
      if (process.execTask(t as Task<unknown>)) {
        return t as Task<unknown>;
      }
    }
    return;
  }

  /**
   * Get health statistics for monitoring
   */
  getHealthStats(): {
    monitoredProcesses: number;
    totalHealthCheckFailures: number;
    processesWithFailures: number;
  } {
    let totalFailures = 0;
    let processesWithFailures = 0;

    for (const state of this.#healthCheckStates.values()) {
      totalFailures += state.healthCheckFailures;
      if (state.healthCheckFailures > 0) {
        processesWithFailures++;
      }
    }

    return {
      monitoredProcesses: this.#healthCheckStates.size,
      totalHealthCheckFailures: totalFailures,
      processesWithFailures,
    };
  }

  /**
   * Reset health check failures for a process (useful for recovery scenarios)
   */
  resetHealthCheckFailures(pid: number): void {
    const state = this.#healthCheckStates.get(pid);
    if (state != null) {
      state.healthCheckFailures = 0;
    }
  }

  /**
   * Get health check state for a specific process
   */
  getProcessHealthState(pid: number) {
    return this.#healthCheckStates.get(pid);
  }
}
