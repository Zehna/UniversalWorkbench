import { ExecutionEngineError } from "./errors.js";

export interface ExecutionBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxOutputBytes: number;
}

export interface ExecutionUsage {
  attempts: number;
  inputBytes: number;
  outputBytes: number;
}

export function validateBudget(budget: ExecutionBudget): ExecutionBudget {
  if (
    !Number.isSafeInteger(budget.maxSteps) ||
    budget.maxSteps < 1 ||
    budget.maxSteps > 10_000 ||
    !Number.isSafeInteger(budget.maxDurationMs) ||
    budget.maxDurationMs < 1 ||
    budget.maxDurationMs > 3_600_000 ||
    !Number.isSafeInteger(budget.maxOutputBytes) ||
    budget.maxOutputBytes < 1 ||
    budget.maxOutputBytes > 104_857_600
  ) {
    throw new ExecutionEngineError(
      "INVALID_BUDGET",
      "Execution budget is invalid",
    );
  }
  return { ...budget };
}

export function outputSize(outputs: readonly unknown[]): number {
  let bytes: string | undefined;
  try {
    bytes = JSON.stringify(outputs);
  } catch {
    throw new ExecutionEngineError(
      "INVALID_OUTPUT",
      "Tool output is not serializable",
    );
  }
  if (bytes === undefined) {
    throw new ExecutionEngineError(
      "INVALID_OUTPUT",
      "Tool output is not serializable",
    );
  }
  return new TextEncoder().encode(bytes).byteLength;
}

export function requireBudget(
  budget: ExecutionBudget,
  usage: ExecutionUsage,
  startedAt: Date,
  now: Date,
  next: "attempt" | "output" = "attempt",
): void {
  if (now.getTime() - startedAt.getTime() >= budget.maxDurationMs) {
    throw new ExecutionEngineError(
      "BUDGET_DURATION",
      "Workflow duration budget exceeded",
    );
  }
  if (usage.outputBytes > budget.maxOutputBytes) {
    throw new ExecutionEngineError(
      "BUDGET_OUTPUT",
      "Workflow output byte budget exceeded",
    );
  }
  if (next === "attempt" && usage.attempts >= budget.maxSteps) {
    throw new ExecutionEngineError(
      "BUDGET_STEPS",
      "Workflow step budget exceeded",
    );
  }
}
