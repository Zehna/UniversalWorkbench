import type {
  ContextEnvelope,
  Execution,
  ExecutionReceipt,
  ExecutionStatus,
  ExecutionUsage,
  SanitizedExecutionError,
  StepExecutionStatus,
} from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import {
  ToolExecutionError,
  type ToolRegistry,
  type ToolRunResult,
} from "@uw/tools";
import {
  assertExecutionUsageWithinBudget,
  type ExecutionBudgetUsage,
} from "./budget.js";
import {
  ExecutionFailure,
  ExecutionWorkerInterruptedError,
  sanitizeExecutionError,
} from "./errors.js";
import { isTerminalExecutionStatus } from "./model.js";
import type { ExecutionQueue, QueueJob } from "./queue.js";
import type { ExecutionReceiptRepository } from "./receipt.js";
import {
  persistStepOutputsBeforeSuccess,
  type ExecutionOutputRepository,
} from "./output.js";
import type {
  ExecutionRepository,
  ExecutionStepRecord,
  ExecutionStepRepository,
} from "./repository.js";
import {
  classifyToolFailure,
  computeRetryDelay,
} from "./retry.js";

export interface ExecutionStepRuntime {
  config: unknown;
  inputs: Record<string, ContextEnvelope>;
}

export interface ExecutionStepRuntimeLoader {
  load(
    execution: Execution,
    step: ExecutionStepRecord,
  ): Promise<ExecutionStepRuntime>;
}

export interface ExecutionStepLifecycle {
  onTerminalStep(input: {
    execution: Execution;
    step: ExecutionStepRecord;
  }): Promise<string[]>;
}

export interface ExecutionEngine {
  runClaimedJob(
    job: QueueJob,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface ExecutionEngineDependencies {
  executions: ExecutionRepository;
  steps: ExecutionStepRepository;
  receipts: ExecutionReceiptRepository;
  outputs: ExecutionOutputRepository;
  queue: ExecutionQueue;
  tools: ToolRegistry;
  runtime: ExecutionStepRuntimeLoader;
  clock: Clock;
  idGenerator: IdGenerator;
  retryRandom?: () => number;
  cancellationPollMs?: number;
  lifecycle?: ExecutionStepLifecycle;
}

const terminalStepStatuses = new Set<StepExecutionStatus>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "timed_out",
]);

function nowIso(clock: Clock): string {
  return clock.now().toISOString();
}

function elapsedMs(execution: Execution, clock: Clock): number {
  const start = new Date(execution.startedAt ?? execution.queuedAt).getTime();
  return Math.max(0, clock.now().getTime() - start);
}

function resultUsage(result: ToolRunResult): ExecutionUsage {
  return {
    outputBytes: result.usage.outputBytes,
    httpRequests: result.usage.httpRequests,
  };
}

async function buildBudgetUsage(
  execution: Execution,
  currentUsage: ExecutionUsage,
  steps: ExecutionStepRepository,
  clock: Clock,
): Promise<ExecutionBudgetUsage> {
  const executionSteps = await steps.listByExecution(execution.id);
  const persisted = executionSteps.reduce(
    (total, step) => ({
      attempts: total.attempts + step.attempt,
      outputBytes: total.outputBytes + step.usage.outputBytes,
      httpRequests: total.httpRequests + step.usage.httpRequests,
    }),
    { attempts: 0, outputBytes: 0, httpRequests: 0 },
  );

  return {
    elapsedMs: elapsedMs(execution, clock),
    steps: executionSteps.length,
    totalAttempts: persisted.attempts,
    outputBytes: persisted.outputBytes + currentUsage.outputBytes,
    httpRequests: persisted.httpRequests + currentUsage.httpRequests,
  };
}

function timeoutFailure(): ExecutionFailure {
  return new ExecutionFailure({
    code: "TIMEOUT",
    message: "Tool execution timed out",
    retrySafe: false,
  });
}

function cancellationFailure(): ExecutionFailure {
  return new ExecutionFailure({
    code: "CANCELLED",
    message: "Tool execution was cancelled",
    retrySafe: false,
  });
}

async function runWithGuards(
  run: (signal: AbortSignal) => Promise<ToolRunResult>,
  timeoutMs: number,
  executionId: string,
  executions: ExecutionRepository,
  externalSignal: AbortSignal | undefined,
  cancellationPollMs: number,
): Promise<ToolRunResult> {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let workerInterrupted = false;

  const abortFromExternal = () => {
    workerInterrupted = true;
    controller.abort(
      externalSignal?.reason ??
        new DOMException("worker interrupted", "AbortError"),
    );
  };
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  if (externalSignal?.aborted) abortFromExternal();

  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("timeout", "TimeoutError"));
  }, timeoutMs);

  const cancellationPoll = globalThis.setInterval(() => {
    void executions
      .getByIdForWorker(executionId)
      .then((current) => {
        if (current?.cancellationRequestedAt) {
          cancelled = true;
          controller.abort(new DOMException("cancelled", "AbortError"));
        }
      })
      .catch(() => undefined);
  }, cancellationPollMs);

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new DOMException("aborted")),
      { once: true },
    );
  });

  try {
    return await Promise.race([run(controller.signal), aborted]);
  } catch (error) {
    if (timedOut) throw timeoutFailure();
    if (workerInterrupted || externalSignal?.aborted) {
      throw new ExecutionWorkerInterruptedError();
    }
    if (cancelled) throw cancellationFailure();
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    globalThis.clearInterval(cancellationPoll);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function terminalExecutionStatusFor(
  code: SanitizedExecutionError["code"] | null,
): Extract<ExecutionStatus, "succeeded" | "failed" | "cancelled" | "timed_out"> {
  if (code === null) return "succeeded";
  if (code === "CANCELLED") return "cancelled";
  if (code === "TIMEOUT") return "timed_out";
  return "failed";
}

function terminalStepStatusFor(
  code: SanitizedExecutionError["code"] | null,
): Extract<
  StepExecutionStatus,
  "succeeded" | "failed" | "cancelled" | "timed_out"
> {
  return terminalExecutionStatusFor(code);
}

export function createExecutionEngine(
  dependencies: ExecutionEngineDependencies,
): ExecutionEngine {
  const {
    executions,
    steps,
    receipts,
    outputs,
    queue,
    tools,
    runtime,
    clock,
    idGenerator,
    retryRandom = Math.random,
    cancellationPollMs = 250,
    lifecycle = {
      async onTerminalStep() {
        return [];
      },
    },
  } = dependencies;

  async function ensureReceipt(input: {
    execution: Execution;
    step: ExecutionStepRecord;
    status: "succeeded" | "failed" | "cancelled" | "timed_out";
    error: SanitizedExecutionError | null;
    usage: ExecutionUsage;
    outputContextIds: string[];
    capabilities: ExecutionReceipt["capabilities"];
    finishedAt: string;
    provenanceEdgeIds: string[];
  }): Promise<ExecutionReceipt> {
    const existing = await receipts.getByStep(input.step.id);
    if (existing) return existing;

    const receipt: ExecutionReceipt = {
      id: idGenerator.next(),
      executionId: input.execution.id,
      stepExecutionId: input.step.id,
      workflowRevisionId: input.execution.workflowRevisionId ?? null,
      tool: {
        id: input.step.toolId,
        version: input.step.toolVersion,
      },
      inputContextIds: [...input.step.inputContextIds],
      outputContextIds: [...input.outputContextIds],
      capabilities: [...input.capabilities],
      attemptCount: Math.max(1, input.step.attempt),
      startedAt: input.step.startedAt ?? input.finishedAt,
      finishedAt: input.finishedAt,
      status: input.status,
      error: input.error,
      usage: structuredClone(input.usage),
      provenanceEdgeIds: [...input.provenanceEdgeIds],
    };
    return receipts.append(receipt);
  }

  async function transitionExecutionTerminal(
    execution: Execution,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    error: SanitizedExecutionError | null,
    finishedAt: string,
  ): Promise<Execution> {
    if (isTerminalExecutionStatus(execution.status)) return execution;
    const from = execution.status;
    const updated = await executions.transition({
      ownerId: execution.ownerId,
      executionId: execution.id,
      from,
      to: status,
      now: finishedAt,
      error,
    });
    return updated ?? execution;
  }

  async function finishStep(input: {
    execution: Execution;
    step: ExecutionStepRecord;
    job: QueueJob;
    workerId: string;
    error: SanitizedExecutionError | null;
    usage: ExecutionUsage;
    outputContextIds: string[];
    capabilities: ExecutionReceipt["capabilities"];
  }): Promise<void> {
    const finishedAt = nowIso(clock);
    const stepStatus = terminalStepStatusFor(input.error?.code ?? null);
    const transitionedStep = await steps.transition({
      stepExecutionId: input.step.id,
      from: input.step.status,
      to: stepStatus,
      now: finishedAt,
      attempt: input.step.attempt,
      outputContextIds: input.outputContextIds,
      error: input.error,
      usage: input.usage,
    });
    const terminalStep = transitionedStep ?? {
      ...input.step,
      status: stepStatus,
      finishedAt,
      error: input.error,
      usage: input.usage,
      outputContextIds: [...input.outputContextIds],
    };

    let terminalExecution = input.execution;
    if (input.execution.kind === "tool") {
      terminalExecution = await transitionExecutionTerminal(
        input.execution,
        terminalExecutionStatusFor(input.error?.code ?? null),
        input.error,
        finishedAt,
      );
    }

    const provenanceEdgeIds = await lifecycle.onTerminalStep({
      execution: terminalExecution,
      step: terminalStep,
    });

    await ensureReceipt({
      execution: input.execution,
      step: terminalStep,
      status: terminalExecutionStatusFor(input.error?.code ?? null),
      error: input.error,
      usage: input.usage,
      outputContextIds: input.outputContextIds,
      capabilities: input.capabilities,
      finishedAt,
      provenanceEdgeIds,
    });
    await queue.complete(input.job.id, input.workerId);
  }

  return {
    async runClaimedJob(job, workerId, signal) {
      if (signal?.aborted) {
        throw new ExecutionWorkerInterruptedError();
      }

      if (job.leaseOwner && job.leaseOwner !== workerId) {
        throw new Error("Queue job is leased by another worker");
      }
      if (job.queueType !== "step" || !job.stepExecutionId) {
        throw new Error("Execution engine currently requires a step queue job");
      }

      let execution = await executions.getByIdForWorker(job.executionId);
      if (!execution) throw new Error("Execution was not found");

      let step = await steps.getById(job.stepExecutionId);
      if (!step) throw new Error("Execution step was not found");

      const registered = tools.resolve(step.toolId, step.toolVersion);

      if (terminalStepStatuses.has(step.status)) {
        const provenanceEdgeIds = await lifecycle.onTerminalStep({
          execution,
          step,
        });
        if (step.status !== "skipped") {
          await ensureReceipt({
            execution,
            step,
            status: step.status as Exclude<
              StepExecutionStatus,
              "pending" | "queued" | "running" | "skipped"
            >,
            error: step.error,
            usage: step.usage,
            outputContextIds: step.outputContextIds,
            capabilities: registered.definition.requiredCapabilities,
            finishedAt: step.finishedAt ?? nowIso(clock),
            provenanceEdgeIds,
          });
        }
        await queue.complete(job.id, workerId);
        return;
      }

      const zeroUsage: ExecutionUsage = { outputBytes: 0, httpRequests: 0 };

      if (step.status === "running") {
        const persistedOutputs = await outputs.listByStep(step.id);
        if (persistedOutputs.length > 0) {
          await finishStep({
            execution,
            step,
            job,
            workerId,
            error: null,
            usage: step.usage,
            outputContextIds: persistedOutputs.map((output) => output.contextId),
            capabilities: registered.definition.requiredCapabilities,
          });
          return;
        }

        await finishStep({
          execution,
          step,
          job,
          workerId,
          error: {
            code: "NETWORK_TRANSIENT",
            message:
              "Worker lease expired while the step outcome was ambiguous; automatic replay was blocked",
            details: {
              reason: "AMBIGUOUS_WORKER_RECLAIM",
            },
          },
          usage: step.usage,
          outputContextIds: [],
          capabilities: registered.definition.requiredCapabilities,
        });
        return;
      }

      if (execution.cancellationRequestedAt) {
        const at = nowIso(clock);

        if (execution.kind === "workflow" && execution.status === "queued") {
          const running = await executions.transition({
            ownerId: execution.ownerId,
            executionId: execution.id,
            from: "queued",
            to: "running",
            now: at,
            error: null,
          });
          execution =
            running ??
            (await executions.getByIdForWorker(execution.id)) ??
            execution;
        }

        const cancelledStep = await steps.transition({
          stepExecutionId: step.id,
          from: step.status,
          to: "cancelled",
          now: at,
          error: cancellationFailure().sanitized(),
          usage: zeroUsage,
        });
        if (cancelledStep) step = cancelledStep;

        if (execution.kind === "tool") {
          execution = await transitionExecutionTerminal(
            execution,
            "cancelled",
            cancellationFailure().sanitized(),
            at,
          );
        }

        const provenanceEdgeIds = await lifecycle.onTerminalStep({
          execution,
          step,
        });
        await ensureReceipt({
          execution,
          step,
          status: "cancelled",
          error: cancellationFailure().sanitized(),
          usage: zeroUsage,
          outputContextIds: [],
          capabilities: registered.definition.requiredCapabilities,
          finishedAt: at,
          provenanceEdgeIds,
        });
        await queue.complete(job.id, workerId);
        return;
      }

      if (execution.status === "queued") {
        const running = await executions.transition({
          ownerId: execution.ownerId,
          executionId: execution.id,
          from: "queued",
          to: "running",
          now: nowIso(clock),
          error: null,
        });
        if (running) execution = running;
      }
      if (isTerminalExecutionStatus(execution.status)) {
        await queue.complete(job.id, workerId);
        return;
      }

      const attempt = Math.max(job.attempt, step.attempt) + 1;
      const runningStep = await steps.transition({
        stepExecutionId: step.id,
        from: step.status,
        to: "running",
        now: nowIso(clock),
        attempt,
        error: null,
      });
      if (!runningStep) {
        const current = await steps.getById(step.id);
        if (current && terminalStepStatuses.has(current.status)) {
          await queue.complete(job.id, workerId);
          return;
        }
        throw new Error("Execution step could not transition to running");
      }
      step = runningStep;

      try {
        const usageBeforeRun = await buildBudgetUsage(
          execution,
          zeroUsage,
          steps,
          clock,
        );
        assertExecutionUsageWithinBudget(execution.budget, usageBeforeRun);
        if (attempt > execution.budget.maxAttemptsPerStep) {
          throw new ExecutionFailure({
            code: "BUDGET_EXCEEDED",
            message: "Execution budget exceeded: maxAttemptsPerStep",
            details: {
              dimension: "maxAttemptsPerStep",
              actual: attempt,
              limit: execution.budget.maxAttemptsPerStep,
            },
          });
        }

        const loaded = await runtime.load(execution, step);
        const result = await runWithGuards(
          (runSignal) =>
            registered.runner.run({
              ownerId: execution.ownerId,
              projectId: execution.projectId,
              executionId: execution.id,
              stepExecutionId: step.id,
              traceId: execution.traceId,
              config: loaded.config,
              inputs: loaded.inputs,
              signal: runSignal,
            }),
          Math.min(
            registered.definition.defaults.timeoutMs,
            execution.budget.maxWallClockMs,
          ),
          execution.id,
          executions,
          signal,
          cancellationPollMs,
        );

        const usage = resultUsage(result);
        const usageAfterRun = await buildBudgetUsage(
          execution,
          usage,
          steps,
          clock,
        );
        assertExecutionUsageWithinBudget(execution.budget, usageAfterRun);

        const checkpointedStep = await steps.transition({
          stepExecutionId: step.id,
          from: "running",
          to: "running",
          now: nowIso(clock),
          attempt,
          error: null,
          usage,
        });
        if (!checkpointedStep) {
          throw new Error("Execution step usage checkpoint failed");
        }
        step = checkpointedStep;

        const refreshed = await executions.getByIdForWorker(execution.id);
        if (refreshed?.cancellationRequestedAt) {
          throw cancellationFailure();
        }

        const outputContextIds = Object.values(result.outputs).map(
          (context) => context.id,
        );
        await persistStepOutputsBeforeSuccess({
          outputs,
          contexts: result.outputs,
          executionId: execution.id,
          stepExecutionId: step.id,
          idGenerator,
          clock,
          markSucceeded: async () =>
            finishStep({
              execution,
              step,
              job,
              workerId,
              error: null,
              usage,
              outputContextIds,
              capabilities: registered.definition.requiredCapabilities,
            }),
        });
      } catch (error) {
        if (error instanceof ExecutionWorkerInterruptedError) {
          throw error;
        }

        const sanitized = sanitizeExecutionError(error);
        const executionFailure =
          error instanceof ExecutionFailure
            ? error
            : error instanceof ToolExecutionError
              ? new ExecutionFailure({
                  code: error.code,
                  message: error.message,
                  ...(error.details === undefined
                    ? {}
                    : { details: error.details }),
                  ...(error.retryAfterMs === undefined
                    ? {}
                    : { retryAfterMs: error.retryAfterMs }),
                  ...(error.method === undefined
                    ? {}
                    : { method: error.method }),
                  ambiguous: error.ambiguous,
                  retrySafe: error.retrySafe,
                })
              : new ExecutionFailure({
                  code: sanitized.code,
                  message: sanitized.message,
                  ...(sanitized.details === undefined
                    ? {}
                    : { details: sanitized.details }),
                  retrySafe: false,
                });

        const maxAttempts = Math.min(
          3,
          execution.budget.maxAttemptsPerStep,
          registered.definition.defaults.maxAttempts,
        );
        const decision = classifyToolFailure({
          code: executionFailure.code,
          attempt,
          maxAttempts,
          retrySafe: executionFailure.retrySafe,
          ...(executionFailure.method
            ? { method: executionFailure.method }
            : {}),
          ambiguous: executionFailure.ambiguous,
          ...(executionFailure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: executionFailure.retryAfterMs }),
        });

        const cumulativeUsage = await buildBudgetUsage(
          execution,
          zeroUsage,
          steps,
          clock,
        );
        if (
          decision.retryable &&
          cumulativeUsage.totalAttempts < execution.budget.maxTotalAttempts &&
          !execution.cancellationRequestedAt
        ) {
          const queuedStep = await steps.transition({
            stepExecutionId: step.id,
            from: "running",
            to: "queued",
            now: nowIso(clock),
            attempt,
            error: sanitized,
            usage: zeroUsage,
          });
          if (!queuedStep) {
            throw new Error("Execution step could not return to queued state");
          }
          const delayMs = computeRetryDelay(
            attempt,
            executionFailure.retryAfterMs,
            retryRandom,
          );
          const availableAt = new Date(
            clock.now().getTime() + delayMs,
          ).toISOString();
          await queue.releaseForRetry(
            job.id,
            workerId,
            availableAt,
            attempt,
          );
          return;
        }

        await finishStep({
          execution,
          step,
          job,
          workerId,
          error: sanitized,
          usage: zeroUsage,
          outputContextIds: [],
          capabilities: registered.definition.requiredCapabilities,
        });
      }
    },
  };
}
