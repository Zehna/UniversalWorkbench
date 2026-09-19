import type { ExecutionBudget } from "@uw/contracts";

export const DEFAULT_EXECUTION_BUDGET: ExecutionBudget = {
  maxWallClockMs: 60_000,
  maxSteps: 50,
  maxAttemptsPerStep: 3,
  maxTotalAttempts: 100,
  maxOutputBytes: 10 * 1024 * 1024,
  maxHttpRequests: 20,
};

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
