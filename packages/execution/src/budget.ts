import { ExecutionEngineError } from "./errors.js";

export const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

export interface ExecutionBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxOutputBytes: number;
  maxTotalTokens?: number;
}

export interface ExecutionUsage {
  attempts: number;
  inputBytes: number;
  outputBytes: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface NormalizedExecutionUsage {
  attempts: number;
  inputBytes: number;
  outputBytes: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export function normalizeUsage(
  usage: ExecutionUsage,
): NormalizedExecutionUsage {
  return {
    attempts: usage.attempts,
    inputBytes: usage.inputBytes,
    outputBytes: usage.outputBytes,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

export function validateBudget(budget: ExecutionBudget): ExecutionBudget {
  const maxTotalTokens = budget.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  if (
    !Number.isSafeInteger(budget.maxSteps) ||
    budget.maxSteps < 1 ||
    budget.maxSteps > 10_000 ||
    !Number.isSafeInteger(budget.maxDurationMs) ||
    budget.maxDurationMs < 1 ||
    budget.maxDurationMs > 3_600_000 ||
    !Number.isSafeInteger(budget.maxOutputBytes) ||
    budget.maxOutputBytes < 1 ||
    budget.maxOutputBytes > 104_857_600 ||
    !Number.isSafeInteger(maxTotalTokens) ||
    maxTotalTokens < 1
  ) {
    throw new ExecutionEngineError(
      "INVALID_BUDGET",
      "Execution budget is invalid",
    );
  }
  return { ...budget, maxTotalTokens };
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
  const maxTotalTokens = budget.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const totalTokens = usage.totalTokens ?? 0;
  if (totalTokens >= maxTotalTokens || totalTokens < 0) {
    throw new ExecutionEngineError(
      "BUDGET_EXCEEDED",
      "Workflow token budget exceeded",
    );
  }
}
