import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions";
import { HealthCheckable } from "./ProcessHealthMonitor";
import { WhyNotHealthy } from "./WhyNotHealthy";

/**
 * Strategy interface for different health check approaches
 */
export interface HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null;
}

/**
 * Checks if process has ended or is ending
 */
export class LifecycleHealthCheck implements HealthCheckStrategy {
  assess(process: HealthCheckable): WhyNotHealthy | null {
    if (process.ended) {
      return "ended";
    } else if (process.ending) {
      return "ending";
    }
    return null;
  }
}

/**
 * Checks if process stdin is available
 */
export class StreamHealthCheck implements HealthCheckStrategy {
  assess(process: HealthCheckable): WhyNotHealthy | null {
    if (process.proc.stdin == null || process.proc.stdin.destroyed) {
      return "closed";
    }
    return null;
  }
}

/**
 * Checks if process has exceeded task limits
 */
export class TaskLimitHealthCheck implements HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    if (
      options.maxTasksPerProcess > 0 &&
      process.taskCount >= options.maxTasksPerProcess
    ) {
      return "worn";
    }
    return null;
  }
}

/**
 * Checks if process has been idle too long
 */
export class IdleTimeHealthCheck implements HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    if (
      options.maxIdleMsPerProcess > 0 &&
      process.idleMs > options.maxIdleMsPerProcess
    ) {
      return "idle";
    }
    return null;
  }
}

/**
 * Checks if process has too many failed tasks
 */
export class FailureCountHealthCheck implements HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    if (
      options.maxFailedTasksPerProcess > 0 &&
      process.failedTaskCount >= options.maxFailedTasksPerProcess
    ) {
      return "broken";
    }
    return null;
  }
}

/**
 * Checks if process is too old
 */
export class AgeHealthCheck implements HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    if (
      options.maxProcAgeMillis > 0 &&
      process.start + options.maxProcAgeMillis < Date.now()
    ) {
      return "old";
    }
    return null;
  }
}

/**
 * Checks if current task has timed out
 */
export class TaskTimeoutHealthCheck implements HealthCheckStrategy {
  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    if (
      options.taskTimeoutMillis > 0 &&
      (process.currentTask?.runtimeMs ?? 0) > options.taskTimeoutMillis
    ) {
      return "timeout";
    }
    return null;
  }
}

/**
 * Composite strategy that runs all health checks in order of priority
 */
export class CompositeHealthCheckStrategy implements HealthCheckStrategy {
  private readonly strategies: HealthCheckStrategy[] = [
    new LifecycleHealthCheck(),
    new StreamHealthCheck(),
    new TaskLimitHealthCheck(),
    new IdleTimeHealthCheck(),
    new FailureCountHealthCheck(),
    new AgeHealthCheck(),
    new TaskTimeoutHealthCheck(),
  ];

  assess(
    process: HealthCheckable,
    options: InternalBatchProcessOptions,
  ): WhyNotHealthy | null {
    for (const strategy of this.strategies) {
      const result = strategy.assess(process, options);
      if (result != null) {
        return result;
      }
    }
    return null;
  }
}
