import type { ExecutionBudget } from "@uw/contracts";
import { ExecutionFailure } from "./errors.js";

export const DEFAULT_EXECUTION_BUDGET: ExecutionBudget = {
  maxWallClockMs: 60_000,
  maxSteps: 50,
  maxAttemptsPerStep: 3,
  maxTotalAttempts: 100,
  maxOutputBytes: 10 * 1024 * 1024,
  maxHttpRequests: 20,
};

export interface ExecutionBudgetUsage {
  elapsedMs: number;
  steps: number;
  totalAttempts: number;
  outputBytes: number;
  httpRequests: number;
}

export function assertExecutionBudget(
  budget: ExecutionBudget,
): ExecutionBudget {
  if (
    budget.maxAttemptsPerStep > 3 ||
    budget.maxTotalAttempts < budget.maxSteps
  ) {
    throw new Error("Invalid execution budget");
  }
  return budget;
}

export function assertExecutionUsageWithinBudget(
  budget: ExecutionBudget,
  usage: ExecutionBudgetUsage,
): void {
  const checks: Array<{
    dimension: keyof ExecutionBudgetUsage;
    actual: number;
    limit: number;
  }> = [
    {
      dimension: "elapsedMs",
      actual: usage.elapsedMs,
      limit: budget.maxWallClockMs,
    },
    { dimension: "steps", actual: usage.steps, limit: budget.maxSteps },
    {
      dimension: "totalAttempts",
      actual: usage.totalAttempts,
      limit: budget.maxTotalAttempts,
    },
    {
      dimension: "outputBytes",
      actual: usage.outputBytes,
      limit: budget.maxOutputBytes,
    },
    {
      dimension: "httpRequests",
      actual: usage.httpRequests,
      limit: budget.maxHttpRequests,
    },
  ];

  const violation = checks.find((check) => check.actual > check.limit);
  if (!violation) return;

  throw new ExecutionFailure({
    code: "BUDGET_EXCEEDED",
    message: `Execution budget exceeded: ${violation.dimension}`,
    details: {
      dimension: violation.dimension,
      actual: violation.actual,
      limit: violation.limit,
    },
  });
}
