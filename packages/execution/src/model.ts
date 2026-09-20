import type { ExecutionStatus, StepExecutionStatus } from "@uw/contracts";

const terminalExecutionStatuses = new Set<ExecutionStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

const executionTransitions: Record<
  ExecutionStatus,
  ReadonlySet<ExecutionStatus>
> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set([
    "queued",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

const stepTransitions: Record<
  StepExecutionStatus,
  ReadonlySet<StepExecutionStatus>
> = {
  pending: new Set(["queued", "skipped", "cancelled"]),
  queued: new Set(["running", "cancelled"]),
  running: new Set([
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  succeeded: new Set(),
  failed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return terminalExecutionStatuses.has(status);
}

export function canTransitionExecution(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  return executionTransitions[from].has(to);
}

export function canTransitionStep(
  from: StepExecutionStatus,
  to: StepExecutionStatus,
): boolean {
  return stepTransitions[from].has(to);
}
